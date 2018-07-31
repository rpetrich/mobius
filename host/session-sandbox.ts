import { CacheData, CompiledOutput } from "./compiler/compiler";
import { LoaderCacheData, ModuleLoader, ModuleSource, ServerModule } from "./compiler/sandbox";
import { defer, escape, escaping } from "./event-loop";
import { exists, packageRelative, readFile } from "./fileUtils";
import { compiler as compilerModule, sandbox } from "./lazy-modules";
import memoize from "./memoize";
import { ModuleMap } from "./modules/index";
import { ClientState, PageRenderer, PageRenderMode, SharedRenderState } from "./page-renderer";

import { Channel, JsonValue } from "mobius-types";

import { FakedGlobals, interceptGlobals } from "../common/determinism";
import { BootstrapData, clientOrdersAllEventsByDefault, disconnectedError, Event, eventForException, eventForValue, logOrdering, parseValueEvent, roundTrip, validationError } from "../common/internal-impl";

import * as redom from "./redom";

import { Root as CSSRoot } from "postcss";
import cssnano from "./cssnano";

import { createWriteStream } from "fs";
import { join as pathJoin, resolve as pathResolve } from "path";

export interface HostSandboxOptions {
	allowMultipleClientsPerSession: boolean;
	serverModulePaths: string[];
	modulePaths: string[];
	source: ModuleSource;
	mainPath: string;
	publicPath: string;
	sessionsPath: string;
	cachePath?: string;
	watch: boolean;
	hostname?: string;
	moduleMap: ModuleMap;
	staticAssets: { [path: string]: { contents: string; integrity: string; } };
	minify: boolean;
	coverage: boolean;
	suppressStacks: boolean;
	loaderCache: CacheData<LoaderCacheData>;
}

export function archivePathForSessionId(sessionsPath: string, sessionID: string) {
	return pathJoin(sessionsPath, encodeURIComponent(sessionID) + ".json");
}

function passthrough<T>(value: T): T {
	return value;
}

function throwArgument(arg: any): never {
	throw arg;
}

export class HostSandbox implements SharedRenderState {
	public document: ReturnType<typeof redom.newDocument>;
	public noscript: Element;
	public metaRedirect: Element;
	public compiled: CompiledOutput<LoaderCacheData>;
	public moduleLoader: ModuleLoader;
	public cssForPath: (path: string) => Promise<CSSRoot>;
	constructor(public options: HostSandboxOptions, fileRead: (path: string) => void, public broadcast: typeof import ("../server/broadcast-impl")) {
		this.options = options;
		this.document = redom.newDocument();
		this.noscript = this.document.createElement("noscript");
		const viewport = this.document.createElement("meta");
		viewport.setAttribute("name", "viewport");
		viewport.setAttribute("content", "width=device-width, initial-scale=1");
		this.document.head.appendChild(viewport);
		const dispatchScript = this.document.createElement("script");
		dispatchScript.textContent = `_mobiusEvents=[];function _dispatch(i,e){_mobiusEvents.push([i,e])}`;
		this.document.head.appendChild(dispatchScript);
		this.document.body.setAttribute("data-gramm", "false");
		this.document.body.className = "notranslate";
		this.document.body.appendChild(this.document.createElement("div"));
		this.metaRedirect = this.document.createElement("meta");
		this.metaRedirect.setAttribute("http-equiv", "refresh");
		this.noscript.appendChild(this.metaRedirect);
		fileRead = memoize(fileRead);
		const compiler = new compilerModule.Compiler("server", options.loaderCache, options.mainPath, [packageRelative("server/dom-ambient.d.ts"), packageRelative("common/main.ts")], options.minify, fileRead);
		this.compiled = compiler.compile();
		this.moduleLoader = sandbox.sandboxLoaderForOutput(this.compiled, options.moduleMap, options.staticAssets, options.cachePath, options.coverage);
		this.cssForPath = memoize(async (path: string): Promise<CSSRoot> => {
			const cssText = path in options.staticAssets ? options.staticAssets[path].contents : await readFile(pathResolve(options.publicPath, path.replace(/^\/+/, "")));
			return ((await import("postcss"))(cssnano()).process(cssText, { from: path })).root!;
		});
	}
}

export interface ClientBootstrap {
	readonly queuedLocalEvents?: Event[];
	readonly clientID: number;
}

const bakedModules: { [moduleName: string]: (sandbox: LocalSessionSandbox) => any } = {
	mobius(sandbox) {
		return {
			disconnect: () => sandbox.destroy().catch(escape),
			get dead() {
				return sandbox.dead;
			},
			createClientPromise: sandbox.createClientPromise,
			createServerPromise: sandbox.createServerPromise,
			createClientChannel: sandbox.createClientChannel,
			createServerChannel: sandbox.createServerChannel,
			coordinateValue: sandbox.coordinateValue,
			synchronize: () => sandbox.createServerPromise(emptyFunction),
			flush: async () => {
				if (sandbox.dead) {
					throw disconnectedError();
				}
				sandbox.client.scheduleSynchronize();
				return resolvedPromise;
			},
		} as typeof import ("mobius");
	},
	["cookie-impl"](sandbox) {
		return {
			set: sandbox.client.setCookie.bind(sandbox.client),
			all() {
				return sandbox.createServerPromise(async () => {
					const result: {[key: string]: string} = {};
					for (const entry of (await sandbox.client.cookieHeader()).split(/;\s*/g)) {
						const split: string[] = entry.split(/=/);
						if (split.length > 1) {
							result[decodeURIComponent(split[0])] = decodeURIComponent(split[1]);
						}
					}
					return result;
				});
			},
		} as typeof import ("../server/cookie-impl");
	},
	["dom-impl"](sandbox) {
		return {
			document: sandbox.pageRenderer.document,
			head: sandbox.pageRenderer.head,
			body: sandbox.pageRenderer.body,
		} as typeof import ("../server/dom-impl");
	},
	["broadcast-impl"](sandbox) {
		return sandbox.host.broadcast as typeof import ("../server/broadcast-impl");
	},
	["peers-impl"](sandbox) {
		return {
			getClientIds() {
				return Promise.resolve(sandbox.client.getClientIds());
			},
			addListener(listener: (clientId: number, joined: boolean) => void) {
				if (sandbox.peerCallbacks) {
					sandbox.peerCallbacks.push(listener);
				} else {
					sandbox.peerCallbacks = [listener];
				}
			},
			removeListener(listener: (clientId: number, joined: boolean) => void) {
				const peerCallbacks = sandbox.peerCallbacks;
				if (peerCallbacks) {
					const index = peerCallbacks.indexOf(listener);
					if (index !== -1) {
						peerCallbacks.splice(index, 1);
					}
				}
			},
			share: sandbox.shareSession.bind(sandbox),
		} as typeof import ("../server/peers-impl");
	},
	["redom"](sandbox) {
		return redom;
	},
};

export interface SessionSandboxClient {
	scheduleSynchronize(): void;
	sendEvent(event: Event): void | Promise<void>;
	setCookie(key: string, value: string): void;
	cookieHeader(): string | Promise<string>;
	sessionWasDestroyed(): void;
	getBaseURL(options: HostSandboxOptions): string | Promise<string>;
	sharingBecameEnabled(): void;
	getClientIds(): number[] | Promise<number[]>;
}

interface MobiusGlobalProperties {
	document: Document;
}

interface ArchivedSession {
	events: Array<Event | boolean>;
	channels: number[];
}
const enum ArchiveStatus {
	None = 0,
	Partial = 1,
	Full,
}

const resolvedPromise: Promise<void> = Promise.resolve();

export interface RenderOptions {
	mode: PageRenderMode;
	client: ClientState & ClientBootstrap;
	clientURL: string;
	clientIntegrity: string;
	fallbackURL: string;
	fallbackIntegrity: string;
	noScriptURL?: string;
	bootstrap?: true;
	connect?: true;
	inlineCSS?: true;
}

export interface SessionSandbox {
	destroy(): Promise<void>;
	destroyIfExhausted(): Promise<void>;
	archiveEvents(includeTrailer: boolean): Promise<void>;
	unarchiveEvents(): Promise<void>;
	processEvents(events: Event[], noJavaScript?: boolean): Promise<void>;
	prerenderContent(): Promise<void>;
	updateOpenServerChannelStatus(newValue: boolean): void;
	hasLocalChannels(): Promise<boolean>;
	render(options: RenderOptions): Promise<string>;
	valueForFormField(name: string): string | undefined | Promise<string | undefined>;
	becameActive(): void;
	sendPeerCallback(clientId: number, joined: boolean): void;
}

const wrappedNodeModules = new Map<string, any>();
const noPaths: string[] = [];

export class LocalSessionSandbox<C extends SessionSandboxClient = SessionSandboxClient> implements SessionSandbox {
	public dead: boolean = false;
	// Script context
	private readonly modules = new Map<string, ServerModule>();
	private hasRun: boolean = false;
	public readonly pageRenderer: PageRenderer;
	private globalProperties: MobiusGlobalProperties & FakedGlobals;
	// Local channels
	private localChannelCounter: number = 0;
	private readonly localChannels = new Map<number, (event?: Event) => void>();
	public localChannelCount: number = 0;
	private dispatchingAPIImplementation: number = 0;
	private prerenderChannelCount: number = 0;
	private prerenderCompleted: Promise<void> | undefined = undefined;
	private completePrerender: (() => void) | undefined = undefined;
	// Remote channels
	private remoteChannelCounter: number = 0;
	private readonly remoteChannels = new Map<number, (event?: Event) => void>();
	private pendingChannelCount: number = 0;
	private dispatchingEvent: number = 0;
	// Incoming Events
	private currentEvents: Array<Event | boolean> | undefined;
	private hadOpenServerChannel: boolean = false;
	private pendingServerEvents: Event[] | undefined;
	private clientOrdersAllEvents: boolean = false;
	// Archival
	private recentEvents: Array<Event | boolean> | undefined = undefined;
	private archivingEvents: Promise<void> | undefined = undefined;
	private archiveStatus: ArchiveStatus = ArchiveStatus.None;
	private bootstrappingChannels: Set<number> | undefined = undefined;
	private bootstrappingPromise: Promise<void> | undefined = undefined;
	// Session sharing
	private hasActiveClient: boolean = false;
	public peerCallbacks: Array<(clientId: number, joined: boolean) => void> | undefined = undefined;
	constructor(public readonly host: HostSandbox, public readonly client: C, public readonly sessionID: string) {
		this.pageRenderer = new PageRenderer(host);
		const globalProperties: MobiusGlobalProperties & Partial<FakedGlobals> = {
			document: this.pageRenderer.document,
		};
		this.globalProperties = interceptGlobals(globalProperties, () => this.insideCallback, this.coordinateValue, this.createServerChannel);
		if (this.host.options.allowMultipleClientsPerSession) {
			this.recentEvents = [];
		}
	}

	public loadModule(source: ModuleSource, newModule: ServerModule, allowNodeModules: boolean): any {
		return this.host.moduleLoader(source, newModule, this.globalProperties, this, (name: string) => {
			if (Object.hasOwnProperty.call(bakedModules, name)) {
				const cached = this.modules.get(name);
				if (cached) {
					return cached.exports;
				}
				const result = bakedModules[name](this);
				this.modules.set(name, { exports: result, paths: noPaths });
				return result;
			}
			const resolved = this.host.compiled.resolveModule(name, source.path);
			if (!resolved) {
				const e = new Error(`Cannot find module '${name}'`);
				(e as any).code = "MODULE_NOT_FOUND";
				throw e;
			}
			const modulePath = resolved.resolvedFileName;
			if (resolved.isExternalLibraryImport && name !== "babel-plugin-transform-async-to-promises/helpers") {
				// Node modules
				if (!allowNodeModules) {
					const e = new Error(`Cannot access module '${name}' in this context`);
					(e as any).code = "MODULE_NOT_FOUND";
					throw e;
				}
				let result = wrappedNodeModules.get(modulePath);
				if (!result) {
					// Detect non-ES modules and wrap them appropriately
					const globalModule = require(modulePath);
					if (globalModule && globalModule.__esModule) {
						result = globalModule;
					} else {
						const esModule: any = {};
						Object.defineProperty(esModule, "__esModule", { value: true });
						if (globalModule != null) {
							for (const key in globalModule) {
								if (Object.prototype.hasOwnProperty.call(globalModule, key)) { esModule[key] = globalModule[key]; }
							}
						}
						esModule.default = globalModule;
						result = esModule;
					}
					wrappedNodeModules.set(modulePath, result);
				}
				return result;
			}
			// Sandboxed per-session modules
			const existingModule = this.modules.get(modulePath);
			if (existingModule) {
				return existingModule.exports;
			}
			// Temporarily assign a dummy module so that cyclic module dependencies work (at least as well as they do in node)
			const temporaryModule: ServerModule = {
				exports: {},
				paths: newModule.paths,
			};
			this.modules.set(modulePath, temporaryModule);
			const subModule = this.loadModule({ path: modulePath, sandbox: !resolved.isExternalLibraryImport }, temporaryModule, /\/server\//.test(modulePath));
			this.modules.set(modulePath, subModule);
			return subModule.exports;
		});
	}

	// Async so that errors inside user code startup will log to console as unhandled promise rejection, but app will proceed
	public async run() {
		if (!this.hasRun) {
			this.hasRun = true;
			this.enteringCallback();
			const source = this.host.options.source;
			this.loadModule(source, {
				exports: {},
				paths: this.host.options.modulePaths,
			}, false);
		}
	}

	private sendServerEvent(event: Event) {
		this.client.sendEvent(event);
		if (this.clientOrdersAllEvents) {
			const pendingServerEvents = this.pendingServerEvents || (this.pendingServerEvents = []);
			pendingServerEvents.push(event);
		} else {
			this.dispatchServerEvent(event);
		}
	}

	private dispatchServerEvent(event: Event) {
		if (this.recentEvents) {
			this.recentEvents.push(event);
		}
		const channelId = event[0];
		const channel = this.localChannels.get(channelId);
		if (channel) {
			logOrdering("server", "message", channelId, this.sessionID);
			channel(event.slice() as Event);
		} else {
			// Server-side channel was destroyed on the server between the time it generated an event and the time server received the client's fence of the event
			// This event will be silently dropped--dispatching would cause split brain!
		}
	}

	private dispatchClientEvent(event: Event) {
		if (this.recentEvents) {
			this.recentEvents.push(event);
		}
		let channelId = event[0];
		if (channelId < 0) {
			// Server decided the ordering on "fenced" events
			this.client.sendEvent(event);
			channelId = -channelId;
		} else {
			// Record the event ordering, but don't send to client as they've already processed it
			event[0] = -channelId;
		}
		const channel = this.remoteChannels.get(channelId);
		if (channel) {
			logOrdering("client", "message", channelId, this.sessionID);
			channel(event.slice() as Event);
		} else {
			// Client-side channel was destroyed on the server between the time it generated an event and the time the server received it
			// This event will be silently dropped--dispatching would cause split brain!
		}
	}

	public updateOpenServerChannelStatus(newValue: boolean) {
		if (this.hadOpenServerChannel != newValue) {
			this.hadOpenServerChannel = newValue;
			if (this.recentEvents) {
				this.recentEvents.push(newValue);
			}
		}
	}

	public async processEvents(events: Event[], noJavaScript?: boolean): Promise<void> {
		// Read each event and dispatch the appropriate event in order
		this.updateOpenServerChannelStatus(noJavaScript ? true : (this.localChannelCount != 0));
		this.currentEvents = events;
		this.run();
		for (const event of events) {
			if (event[0] !== 0) {
				this.dispatchClientEvent(event.slice() as Event);
			} else {
				// Client decided the ordering on "fenced" events
				const pendingServerEvents = this.pendingServerEvents;
				if (pendingServerEvents) {
					const fencedEvent = pendingServerEvents.shift();
					if (fencedEvent) {
						this.dispatchServerEvent(fencedEvent);
					} else {
						throw new Error("Received a client-fenced server event, but no fenced events are in the queue!");
					}
				} else {
					throw new Error("Received a client-fenced server event, but not in a mode where server events are fenced!");
				}
			}
			await defer();
		}
		this.updateOpenServerChannelStatus(this.localChannelCount != 0);
		this.currentEvents = undefined;
	}

	public hasLocalChannels() {
		return Promise.resolve(this.localChannelCount !== 0);
	}
	public enterLocalChannel(delayPrerender: boolean = true): number {
		if (delayPrerender) {
			++this.prerenderChannelCount;
		}
		return ++this.localChannelCount;
	}
	public exitLocalChannel(resumePrerender: boolean = true): number {
		if (resumePrerender) {
			if (--this.prerenderChannelCount == 0) {
				defer().then(() => {
					if (this.completePrerender) {
						this.completePrerender();
						delete this.completePrerender;
						delete this.prerenderCompleted;
					}
				});
			}
		}
		return --this.localChannelCount;
	}
	public prerenderContent(): Promise<void> {
		if (this.prerenderCompleted) {
			return this.prerenderCompleted;
		}
		this.enterLocalChannel();
		this.run();
		defer().then(() => this.exitLocalChannel());
		return this.prerenderCompleted = new Promise<void>((resolve) => {
			this.completePrerender = resolve;
		});
	}
	public shouldImplementLocalChannel(channelId: number): boolean {
		return !this.bootstrappingChannels || this.bootstrappingChannels.has(channelId);
	}

	get insideCallback() {
		return this.dispatchingEvent != 0 && this.dispatchingAPIImplementation == 0;
	}
	private async enteringCallback() {
		this.dispatchingEvent++;
		await defer();
		this.dispatchingEvent--;
	}
	public createServerPromise = <T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender: boolean = true) => {
		if (!this.insideCallback) {
			return new Promise<T>((resolve) => resolve(ask()));
		}
		// Record and ship values/errors of server-side promises
		let channelId = ++this.localChannelCounter;
		return new Promise<T>((resolve, reject) => {
			logOrdering("server", "open", channelId, this.sessionID);
			this.enterLocalChannel(includedInPrerender);
			this.localChannels.set(channelId, (event?: Event) => {
				if (channelId > 0) {
					resolvedPromise.then(escaping(() => {
						if (channelId != -1) {
							this.localChannels.delete(channelId);
							channelId = -1;
							this.exitLocalChannel(includedInPrerender);
						}
					}));
					logOrdering("server", "close", channelId, this.sessionID);
					if (event) {
						this.enteringCallback();
						parseValueEvent(global, event, resolve as (value: JsonValue) => void, reject);
					}
				}
			});
			if (!this.shouldImplementLocalChannel(channelId)) {
				return;
			}
			this.dispatchingAPIImplementation++;
			const result = new Promise<T>((innerResolve) => innerResolve(ask()));
			this.dispatchingAPIImplementation--;
			result.then(
				(value) => {
					try {
						return eventForValue(channelId, value);
					} catch (error) {
						return eventForException(channelId, error, this.host.options.suppressStacks);
					}
				},
				(error) => eventForException(channelId, error, this.host.options.suppressStacks),
			).then(async (event) => {
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId > 0) {
					this.sendServerEvent(event);
				}
			});
		});
	}
	public createServerChannel = <TS extends any[], U>(callback: (...args: TS) => void, onOpen: (send: (...args: TS) => void) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		let state: U | undefined;
		if (!this.insideCallback) {
			// Not coordinating
			let open = true;
			try {
				const potentialState = onOpen(function() {
					if (open) {
						callback.apply(null, arguments);
					}
				});
				if (onClose) {
					state = potentialState;
				}
			} catch (e) {
				onClose = undefined;
				escape(e);
			}
			return {
				channelId: -1,
				close: () => {
					if (open) {
						open = false;
						if (onClose) {
							this.dispatchingAPIImplementation++;
							escaping(onClose)(state as U);
							this.dispatchingAPIImplementation--;
						}
					}
				},
			};
		}
		// Record and ship arguments of server-side events
		let channelId = ++this.localChannelCounter;
		logOrdering("server", "open", channelId, this.sessionID);
		this.enterLocalChannel(includedInPrerender);
		const close = () => {
			if (channelId > 0) {
				logOrdering("server", "close", channelId, this.sessionID);
				this.localChannels.delete(channelId);
				channelId = -1;
				resolvedPromise.then(escaping(() => {
					if (this.exitLocalChannel(includedInPrerender) == 0) {
						// If this was the last server channel, reevaluate queued events so the session can be potentially collected
						this.client.scheduleSynchronize();
					}
				}));
				if (onClose) {
					this.dispatchingAPIImplementation++;
					escaping(onClose)(state as U);
					this.dispatchingAPIImplementation--;
				}
			}
		};
		this.localChannels.set(channelId, (event?: Event) => {
			if (event) {
				this.enteringCallback();
				callback.apply(null, roundTrip(event.slice(1)) as TS);
			} else {
				close();
			}
		});
		if (this.shouldImplementLocalChannel(channelId)) {
			try {
				this.dispatchingAPIImplementation++;
				const potentialState = onOpen(((...args: any[]) => {
					if (channelId > 0) {
						args.unshift(channelId);
						args = roundTrip(args);
						(async () => {
							if (this.currentEvents) {
								if (this.bootstrappingPromise) {
									await this.bootstrappingPromise;
								}
								await defer();
							}
							this.sendServerEvent(args as Event);
						})();
					}
				}));
				if (onClose) {
					state = potentialState;
				}
				this.dispatchingAPIImplementation--;
			} catch (e) {
				this.dispatchingAPIImplementation--;
				onClose = undefined;
				escape(e);
			}
		} else {
			onClose = undefined;
		}
		return {
			channelId,
			close,
		};
	}

	public createRawClientChannel(callback: (event: Event | undefined) => void): Channel {
		this.pendingChannelCount++;
		let channelId = ++this.remoteChannelCounter;
		logOrdering("client", "open", channelId, this.sessionID);
		this.remoteChannels.set(channelId, callback);
		return {
			channelId,
			close: () => {
				if (channelId != -1) {
					logOrdering("client", "close", channelId, this.sessionID);
					this.remoteChannels.delete(channelId);
					channelId = -1;
					if ((--this.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						this.client.scheduleSynchronize();
					}
				}
			},
		};
	}

	public validationFailure(value: JsonValue): never {
		this.destroy();
		throw validationError(value);
	}

	public createClientPromise = <T extends JsonValue | void>(validator?: (value: unknown) => value is T, fallback?: () => Promise<T> | T) => {
		return new Promise<T>((resolve, reject) => {
			if (!this.insideCallback) {
				return reject(new Error("Unable to create client promise in this context!"));
			}
			if (this.dead) {
				if (fallback) {
					return resolve(fallback());
				}
				return reject(disconnectedError());
			}
			const channel = this.createRawClientChannel((event) => {
				this.enteringCallback();
				channel.close();
				if (event) {
					if (validator) {
						parseValueEvent(global, event, (value: any) => {
							if (validator(value)) {
								resolve(value as T);
							} else {
								this.validationFailure(value);
							}
						}, reject);
					} else {
						parseValueEvent(global, event, resolve as (value: JsonValue | void) => void, reject);
					}
				} else {
					reject(disconnectedError());
				}
			});
			if (!this.hasActiveClient && !this.bootstrappingPromise) {
				this.enterLocalChannel(true);
				this.dispatchingAPIImplementation++;
				const promise = fallback ? new Promise<T>((innerResolve) => innerResolve(fallback())) : Promise.reject(new Error("Browser does not support client-side rendering!"));
				this.dispatchingAPIImplementation--;
				promise.then(async (value) => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForValue(-channel.channelId, value));
				}).catch(async (error) => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForException(-channel.channelId, error, this.host.options.suppressStacks));
				}).then(() => this.exitLocalChannel());
			}
		});
	}
	public createClientChannel = <TS extends any[]>(callback: (...args: TS) => void, validator: (args: unknown[]) => args is TS) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		if (!this.insideCallback) {
			throw new Error("Unable to create client channel in this context!");
		}
		const channel = this.createRawClientChannel((event) => {
			if (event) {
				event.shift();
				this.enteringCallback();
				if (!validator || validator(event)) {
					resolvedPromise.then(() => callback.apply(null, event));
				} else {
					this.validationFailure(event);
				}
			} else {
				channel.close();
			}
		});
		return channel;
	}

	public findValueEvent(channelId: number): Event | undefined {
		const events = this.currentEvents;
		if (events) {
			if (this.bootstrappingChannels) {
				channelId = -channelId;
			}
			// Events are represented differently inside currentEvents depending on whether we're processing a client message or unarchiving
			// Makes more sense to handle the special case here than to transform the array just for this one case
			for (const event of events as Event[]) {
				if (event[0] == channelId) {
					return event;
				}
			}
		}
	}

	public coordinateValue = <T extends JsonValue | void>(generator: () => T, validator: (value: unknown) => value is T): T => {
		if (!this.insideCallback || this.dead) {
			return generator();
		}
		if (this.clientOrdersAllEvents || !this.hadOpenServerChannel) {
			const channelId = ++this.remoteChannelCounter;
			logOrdering("client", "open", channelId, this.sessionID);
			// Peek at incoming events to find the value generated on the client
			const event = this.findValueEvent(channelId);
			if (event) {
				logOrdering("client", "message", channelId, this.sessionID);
				logOrdering("client", "close", channelId, this.sessionID);
				return parseValueEvent(global, event, validator ? (value) => {
					if (!validator(value)) {
						this.validationFailure(value);
					}
					return value as T;
				} : passthrough as (value: JsonValue) => T, throwArgument);
			} else {
				console.log("Expected a value from the client, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
				const value = generator();
				logOrdering("client", "message", channelId, this.sessionID);
				logOrdering("client", "close", channelId, this.sessionID);
				return roundTrip(value);
			}
		} else {
			const channelId = ++this.localChannelCounter;
			logOrdering("server", "open", channelId, this.sessionID);
			if (this.bootstrappingChannels) {
				const event = this.findValueEvent(-channelId);
				if (event) {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendServerEvent(event);
					return parseValueEvent(global, event, passthrough as (value: JsonValue) => T, throwArgument);
				}
			}
			try {
				const value = generator();
				const newEvent = eventForValue(channelId, value);
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendServerEvent(newEvent);
				} catch (e) {
					escape(e);
				}
				return roundTrip(value);
			} catch (e) {
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendServerEvent(eventForException(channelId, e, this.host.options.suppressStacks));
				} catch (e) {
					escape(e);
				}
				throw e;
			}
		}
	}

	public async shareSession() {
		// Server promise so that client can confirm that sharing is enabled
		const allowMultiple = this.host.options.allowMultipleClientsPerSession;
		if (allowMultiple) {
			this.client.sharingBecameEnabled();
		}
		const result = await this.createServerPromise(async () => {
			if (!allowMultiple) {
				throw new Error("Sharing has been disabled!");
			}
			return await this.client.getBaseURL(this.host.options) + "?sessionID=" + this.sessionID;
		});
		// Dummy channel that stays open
		this.createServerChannel(emptyFunction, emptyFunction, undefined, false);
		this.clientOrdersAllEvents = false;
		return result;
	}

	public async destroy() {
		if (!this.dead) {
			this.dead = true;
			await this.archiveEvents(true);
			for (const pair of this.remoteChannels) {
				pair[1]();
			}
			this.remoteChannels.clear();
			for (const pair of this.localChannels) {
				pair[1]();
			}
			this.localChannels.clear();
			await this.client.sessionWasDestroyed();
		}
	}

	public async destroyIfExhausted() {
		// If no channels remain, the session is in a state where no more events
		// can be sent from either the client or server. Session can be destroyed
		if (this.pendingChannelCount + this.localChannelCount == 0) {
			await this.destroy();
		}
	}

	public async archiveEvents(includeTrailer: boolean): Promise<void> {
		// Can only archive if we're recording events
		if (!this.recentEvents || (!this.recentEvents.length && !includeTrailer)) {
			return;
		}
		// Only one archiver can run at a time
		while (this.archivingEvents) {
			await this.archivingEvents;
		}
		const recentEvents = this.recentEvents;
		if (recentEvents) {
			this.recentEvents = [];
		}
		// Actually archive
		await (this.archivingEvents = (async () => {
			const path = archivePathForSessionId(this.host.options.sessionsPath, this.sessionID);
			// Determine where to write and whether or not this is a fresh session
			const freshFile = this.archiveStatus != ArchiveStatus.Partial || !(await exists(path));
			// Prepare events
			let unarchivedEvents: Array<Event | boolean> | undefined;
			if (this.archiveStatus == ArchiveStatus.Full) {
				try {
					unarchivedEvents = (await LocalSessionSandbox.readArchivedSession(path)).events;
				} catch (e) {
					/* tslint:disable no-empty */
				}
			}
			const events = unarchivedEvents ? unarchivedEvents.concat(recentEvents || []) : (recentEvents || []);
			const serializedEvents = JSON.stringify(events);
			// Attempt to write as stream
			const stream = createWriteStream(path, { flags: freshFile ? "w" : "a" });
			if (freshFile) {
				stream.write("{\"events\":");
				stream.write(serializedEvents.substring(0, serializedEvents.length - 1));
			} else if (events.length) {
				stream.write(",");
				stream.write(serializedEvents.substring(1, serializedEvents.length - 1));
			}
			// Include full trailer if required
			if (includeTrailer) {
				stream.write("],\"channels\":" + JSON.stringify(Array.from(this.localChannels.keys())) + "}");
			}
			stream.end();
			return stream;
		})().then((stream) => new Promise<void>((resolve) => {
			const finished = () => {
				this.archiveStatus = includeTrailer ? ArchiveStatus.Full : ArchiveStatus.Partial;
				delete this.archivingEvents;
				resolve();
			};
			stream.on("finish", finished);
			stream.on("error", () => {
				// Failed to write, put the events back
				this.recentEvents = recentEvents.concat(this.recentEvents || []);
				finished();
			});
		})));
	}

	public static async readArchivedSession(path: string): Promise<Partial<ArchivedSession>> {
		const rawContents = (await readFile(path)).toString();
		const validJSONContents = rawContents[rawContents.length - 1] == "}" ? rawContents : rawContents + "]}";
		return JSON.parse(validJSONContents) as Partial<ArchivedSession>;
	}

	public async readAllEvents(): Promise<Array<Event | boolean> | undefined> {
		if (this.archiveStatus == ArchiveStatus.None) {
			return this.recentEvents;
		}
		const path = archivePathForSessionId(this.host.options.sessionsPath, this.sessionID);
		let archivedEvents: Array<Event | boolean> | undefined;
		do {
			if (this.archivingEvents) {
				await this.archivingEvents;
			}
			archivedEvents = (await LocalSessionSandbox.readArchivedSession(path)).events;
		} while (this.archivingEvents);
		const recentEvents = this.recentEvents;
		if (!recentEvents) {
			return undefined;
		}
		return archivedEvents ? archivedEvents.concat(recentEvents) : recentEvents;
	}

	public async unarchiveEvents(): Promise<void> {
		const path = archivePathForSessionId(this.host.options.sessionsPath, this.sessionID);
		const archive = await LocalSessionSandbox.readArchivedSession(path);
		this.bootstrappingChannels = new Set<number>(archive.channels);
		let completedBootstrapping: () => void;
		this.bootstrappingPromise = new Promise<void>((resolve) => completedBootstrapping = resolve);
		// Read each event and dispatch the appropriate event in order
		const events = archive.events!;
		this.currentEvents = events;
		const firstEvent = events[0];
		if (typeof firstEvent == "boolean") {
			await this.updateOpenServerChannelStatus(firstEvent);
		}
		this.run();
		for (const event of events) {
			if (typeof event == "boolean") {
				await this.updateOpenServerChannelStatus(event);
				continue;
			}
			const channelId = event[0];
			if (channelId < 0) {
				this.dispatchClientEvent(event);
			} else {
				this.dispatchServerEvent(event);
			}
			await defer();
		}
		this.currentEvents = undefined;
		this.recentEvents = archive.events;
		this.bootstrappingChannels = undefined;
		this.bootstrappingPromise = undefined;
		completedBootstrapping!();
	}

	private async generateBootstrapData(client: ClientBootstrap): Promise<BootstrapData> {
		const events = await this.readAllEvents() || client.queuedLocalEvents;
		const result: BootstrapData = { sessionID: this.sessionID, channels: Array.from(this.remoteChannels.keys()) };
		if (events) {
			result.events = events;
		}
		if (client.clientID) {
			result.clientID = client.clientID;
		}
		if (this.host.options.watch) {
			result.connect = true;
		}
		return result;
	}

	public async render({ mode, client, clientURL, clientIntegrity, fallbackURL, fallbackIntegrity, noScriptURL, bootstrap, inlineCSS}: RenderOptions): Promise<string> {
		return this.pageRenderer.render({
			mode,
			clientState: client,
			sessionState: this,
			clientURL,
			clientIntegrity,
			fallbackURL,
			fallbackIntegrity,
			noScriptURL,
			bootstrapData: bootstrap ? await this.generateBootstrapData(client) : undefined,
			inlineCSS,
		});
	}

	public becameActive() {
		if (!this.hasActiveClient) {
			this.hasActiveClient = true;
			this.clientOrdersAllEvents = clientOrdersAllEventsByDefault;
		}
	}

	public sendPeerCallback(clientId: number, joined: boolean) {
		if (this.peerCallbacks) {
			for (const callback of this.peerCallbacks) {
				callback(clientId, joined);
			}
		}
	}

	public valueForFormField(name: string): string | undefined {
		const element = childElementWithName(this.pageRenderer.body, name);
		if (element) {
			switch (element.nodeName) {
				case "INPUT":
					if (element.getAttribute("type") === "button") {
						return undefined;
					}
				case "TEXTAREA":
					return element.getAttribute("value") || "";
			}
		}
	}
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}

function childElementWithName(element: Element, name: string): Element | void {
	if (element.getAttribute("name") == name) {
		return element;
	}
	for (const child of element.childNodes) {
		if (isElement(child)) {
			const potentialResult = childElementWithName(child, name);
			if (potentialResult) {
				return potentialResult;
			}
		}
	}
}

function emptyFunction() {
	/* tslint:disable no-empty */
}
