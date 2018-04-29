import { defer, escape, escaping } from "./event-loop";
import { exists, readFile } from "./fileUtils";
import memoize from "./memoize";
import { ClientState, PageRenderer, PageRenderMode } from "./page-renderer";
import { ModuleSource, ServerCompiler, ServerModule } from "./server-compiler";
import virtualModule, { ModuleMap } from "./modules/index";

import * as mobiusModule from "mobius";
import { Channel, JsonValue } from "mobius-types";
import * as BroadcastModule from "../server/_broadcast";

import { BootstrapData, disconnectedError, Event, eventForException, eventForValue, logOrdering, parseValueEvent, roundTrip } from "../common/_internal";
import { FakedGlobals, interceptGlobals } from "../common/determinism";

import { JSDOM } from "jsdom";
import patchJSDOM from "./jsdom-patch";

import * as postcss from "postcss";
import { Root as CSSRoot } from "postcss";
import { postcssMinifyPlugin } from "./modules/css";

import { createWriteStream } from "fs";
import { join as pathJoin, resolve as pathResolve } from "path";

export interface HostSandboxOptions {
	htmlSource: string;
	allowMultipleClientsPerSession: boolean;
	serverModulePaths: string[];
	modulePaths: string[];
	source: ModuleSource;
	mainPath: string;
	publicPath: string;
	sessionsPath: string;
	watch: boolean;
	hostname?: string;
	moduleMap: ModuleMap;
	staticAssets: { [path: string]: { contents: string; integrity: string; } };
	minify: boolean;
}

export function archivePathForSessionId(sessionsPath: string, sessionID: string) {
	return pathJoin(sessionsPath, encodeURIComponent(sessionID) + ".json");
}

const cssMinifier = postcss(postcssMinifyPlugin);

function passthrough<T>(value: T): T {
	return value;
}

function throwArgument(arg: any): never {
	throw arg;
}

export class HostSandbox {
	public options: HostSandboxOptions;
	public dom: JSDOM;
	public document: Document;
	public noscript: Element;
	public metaRedirect: Element;
	public serverCompiler: ServerCompiler;
	public cssForPath: (path: string) => Promise<CSSRoot>;
	constructor(options: HostSandboxOptions, fileRead: (path: string) => void, public broadcastModule: typeof BroadcastModule) {
		this.options = options;
		this.dom = new (require("jsdom").JSDOM)(options.htmlSource) as JSDOM;
		this.document = (this.dom.window as Window).document as Document;
		patchJSDOM(this.document);
		this.noscript = this.document.createElement("noscript");
		this.metaRedirect = this.document.createElement("meta");
		this.metaRedirect.setAttribute("http-equiv", "refresh");
		this.noscript.appendChild(this.metaRedirect);
		const basePath = pathResolve(options.mainPath, "../");
		this.serverCompiler = new ServerCompiler(options.mainPath, options.moduleMap, options.staticAssets, memoize((path: string) => virtualModule(basePath, path, options.minify, fileRead)), fileRead);
		this.broadcastModule = broadcastModule;
		this.cssForPath = memoize(async (path: string): Promise<CSSRoot> => {
			const cssText = path in options.staticAssets ? options.staticAssets[path].contents : await readFile(pathResolve(options.publicPath, path.replace(/^\/+/, "")));
			return (await cssMinifier.process(cssText, { from: path })).root!;
		});
	}
}

export interface ClientBootstrap {
	queuedLocalEvents?: Event[];
	clientID: number;
}

const bakedModules: { [moduleName: string]: (sandbox: LocalSessionSandbox) => any } = {
	mobius: (sandbox: LocalSessionSandbox) => sandbox.mobius,
	setCookie: (sandbox: LocalSessionSandbox) => sandbox.client.setCookie.bind(sandbox.client),
	allCookies: (sandbox: LocalSessionSandbox) => async () => {
		const result: {[key: string]: string} = {};
		for (const entry of (await sandbox.client.cookieHeader()).split(/;\s*/g)) {
			const split: string[] = entry.split(/=/);
			if (split.length > 1) {
				result[decodeURIComponent(split[0])] = decodeURIComponent(split[1]);
			}
		}
		return result;
	},
	document: (sandbox: LocalSessionSandbox) => sandbox.globalProperties.document,
	head: (sandbox: LocalSessionSandbox) => sandbox.pageRenderer.head,
	body: (sandbox: LocalSessionSandbox) => sandbox.pageRenderer.body,
	_broadcast: (sandbox: LocalSessionSandbox) => sandbox.host.broadcastModule,
};

export interface SessionSandboxClient {
	scheduleSynchronize(): void;
	sendEvent(event: Event): void | Promise<void>;
	setCookie(key: string, value: string): void;
	cookieHeader(): string | Promise<string>;
	sessionWasDestroyed(): void;
	getBaseURL(options: HostSandboxOptions): string | Promise<string>;
	sharingBecameEnabled(): void;
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

// Hack so that Module._findPath will find TypeScript files
const Module = require("module");
Module._extensions[".ts"] = Module._extensions[".tsx"] = Module._extensions[".jsx"] = function() {
	/* tslint:disable no-empty */
};

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
}

const wrappedNodeModules = new Map<string, any>();

export class LocalSessionSandbox<C extends SessionSandboxClient = SessionSandboxClient> implements SessionSandbox {
	public host: HostSandbox;
	public client: C;
	public sessionID: string;
	public dead: boolean = false;
	// Script context
	public modules = new Map<string, ServerModule>();
	public mobius: typeof mobiusModule;
	public hasRun: boolean = false;
	public pageRenderer: PageRenderer;
	public globalProperties: MobiusGlobalProperties & FakedGlobals;
	// Local channels
	public localChannelCounter: number = 0;
	public localChannels = new Map<number, (event?: Event) => void>();
	public localChannelCount: number = 0;
	public dispatchingAPIImplementation: number = 0;
	public prerenderChannelCount: number = 0;
	public prerenderCompleted?: Promise<void>;
	public completePrerender?: () => void;
	// Remote channels
	public remoteChannelCounter: number = 0;
	public pendingChannels = new Map<number, (event?: Event) => void>();
	public pendingChannelCount: number = 0;
	public dispatchingEvent: number = 0;
	// Incoming Events
	public currentEvents: Array<Event | boolean> | undefined;
	public hadOpenServerChannel: boolean = false;
	// Archival
	public recentEvents?: Array<Event | boolean>;
	public archivingEvents?: Promise<void>;
	public archiveStatus: ArchiveStatus = ArchiveStatus.None;
	public bootstrappingChannels?: Set<number>;
	public bootstrappingPromise?: Promise<void>;
	// Session sharing
	public hasActiveClient?: true;
	constructor(host: HostSandbox, client: C, sessionID: string) {
		this.host = host;
		this.client = client;
		this.sessionID = sessionID;
		this.pageRenderer = new PageRenderer(host.dom, host.noscript, host.metaRedirect, host.cssForPath);
		// Server-side version of the API
		this.mobius = {
			disconnect: () => this.destroy().catch(escape),
			dead: false,
			createClientPromise: this.createClientPromise,
			createServerPromise: this.createServerPromise,
			createClientChannel: this.createClientChannel,
			createServerChannel: this.createServerChannel,
			coordinateValue: this.coordinateValue,
			synchronize: () => this.createServerPromise(emptyFunction),
			flush: async () => {
				if (this.dead) {
					throw disconnectedError();
				}
				this.client.scheduleSynchronize();
				return resolvedPromise;
			},
			shareSession: this.shareSession,
		};
		const globalProperties: MobiusGlobalProperties & Partial<FakedGlobals> = {
			document: this.host.document,
		};
		this.globalProperties = interceptGlobals(globalProperties, () => this.insideCallback, this.coordinateValue, this.createServerChannel);
		if (this.host.options.allowMultipleClientsPerSession) {
			this.recentEvents = [];
		}
	}

	public loadModule(source: ModuleSource, newModule: ServerModule, allowNodeModules: boolean): any {
		return this.host.serverCompiler.loadModule(source, newModule, this.globalProperties, (name: string) => {
			const bakedModule = bakedModules[name];
			if (bakedModule) {
				return bakedModule(this);
			}
			const resolvedPath = this.host.serverCompiler.resolveModule(name, source.path);
			const modulePath = resolvedPath || (name === "babel-plugin-transform-async-to-promises/helpers" && require.resolve(name));
			if (modulePath) {
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
				const subModule = this.loadModule({ from: "file", path: modulePath, sandbox: typeof resolvedPath === "string" }, temporaryModule, !!Module._findPath(name, this.host.options.serverModulePaths));
				this.modules.set(modulePath, subModule);
				return subModule.exports;
			}
			if (!allowNodeModules) {
				const e = new Error(`Cannot access module '${name}' in this context`);
				(e as any).code = "MODULE_NOT_FOUND";
				throw e;
			}
			let result = wrappedNodeModules.get(name);
			if (!result) {
				const globalModule = require(name);
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
				wrappedNodeModules.set(name, result);
			}
			return result;
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
			}, source.from === "string");
		}
	}

	public sendEvent(event: Event) {
		if (this.recentEvents) {
			this.recentEvents.push(event);
		}
		this.client.sendEvent(event);
	}

	public dispatchClientEvent(event: Event) {
		let channelId = event[0];
		if (channelId < 0) {
			// Server decided the ordering on "fenced" events
			this.sendEvent(event);
			channelId = -channelId;
		} else {
			// Record the event ordering, but don't send to client as they've already processed it
			event[0] = -channelId;
			if (this.recentEvents) {
				this.recentEvents.push(event);
			}
		}
		const channel = this.pendingChannels.get(channelId);
		if (channel) {
			logOrdering("client", "message", channelId, this.sessionID);
			channel(event.slice() as Event);
		} else {
			// Client-side event source was destroyed on the server between the time it generated an event and the time the server received it
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
			this.dispatchClientEvent(event.slice(0) as Event);
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
	public async enteringCallback() {
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
		const exit = escaping(() => {
			if (channelId != -1) {
				this.localChannels.delete(channelId);
				channelId = -1;
				this.exitLocalChannel(includedInPrerender);
			}
		});
		return new Promise<T>((resolve, reject) => {
			logOrdering("server", "open", channelId, this.sessionID);
			this.enterLocalChannel(includedInPrerender);
			this.localChannels.set(channelId, (event?: Event) => {
				if (channelId >= 0) {
					if (event) {
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						resolvedPromise.then(exit);
						this.enteringCallback();
						parseValueEvent(global, event, resolve as (value: JsonValue) => void, reject);
					} else {
						logOrdering("server", "close", channelId, this.sessionID);
						exit();
					}
				}
			});
			if (!this.shouldImplementLocalChannel(channelId)) {
				return;
			}
			this.dispatchingAPIImplementation++;
			const result = new Promise<T>((innerResolve) => innerResolve(ask()));
			this.dispatchingAPIImplementation--;
			result.then(async (value) => {
				const event = eventForValue(channelId, value);
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(event);
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					const roundtripped = roundTrip(value);
					this.enteringCallback();
					resolve(roundtripped);
				}
			}).catch(async (error) => {
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(eventForException(channelId, error));
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					this.enteringCallback();
					reject(error);
				}
			});
		});
	}
	public createServerChannel = <T extends (...args: any[]) => void, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true) => {
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
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
			} catch (e) {
				onClose = undefined;
				escape(e);
			}
			return {
				channelId: -1,
				close() {
					if (open) {
						open = false;
						if (onClose) {
							session.dispatchingAPIImplementation++;
							escaping(onClose)(state as U);
							session.dispatchingAPIImplementation--;
						}
					}
				},
			};
		}
		// Record and ship arguments of server-side events
		const session = this;
		let channelId = ++session.localChannelCounter;
		logOrdering("server", "open", channelId, this.sessionID);
		session.enterLocalChannel(includedInPrerender);
		const close = () => {
			if (channelId >= 0) {
				logOrdering("server", "close", channelId, session.sessionID);
				session.localChannels.delete(channelId);
				channelId = -1;
				resolvedPromise.then(escaping(() => {
					if (session.exitLocalChannel(includedInPrerender) == 0) {
						// If this was the last server channel, reevaluate queued events so the session can be potentially collected
						session.client.scheduleSynchronize();
					}
				}));
				if (onClose) {
					session.dispatchingAPIImplementation++;
					escaping(onClose)(state as U);
					session.dispatchingAPIImplementation--;
				}
			}
		};
		session.localChannels.set(channelId, (event?: Event) => {
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				session.enteringCallback();
				(callback as any as Function).apply(null, roundTrip(event.slice(1)));
			} else {
				close();
			}
		});
		if (this.shouldImplementLocalChannel(channelId)) {
			try {
				this.dispatchingAPIImplementation++;
				const potentialState = onOpen(function() {
					if (channelId >= 0) {
						const args = roundTrip([...arguments]);
						(async () => {
							if (session.currentEvents) {
								if (session.bootstrappingPromise) {
									await session.bootstrappingPromise;
								}
								await defer();
							}
							try {
								session.updateOpenServerChannelStatus(true);
								session.sendEvent([channelId, ...roundTrip(args)] as Event);
							} catch (e) {
								escape(e);
							}
							logOrdering("server", "message", channelId, session.sessionID);
							session.enteringCallback();
							(callback as any as Function).apply(null, args);
						})();
					}
				} as any as T);
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
		const session = this;
		session.pendingChannelCount++;
		let channelId = ++session.remoteChannelCounter;
		logOrdering("client", "open", channelId, this.sessionID);
		this.pendingChannels.set(channelId, callback);
		return {
			channelId,
			close() {
				if (channelId != -1) {
					logOrdering("client", "close", channelId, session.sessionID);
					session.pendingChannels.delete(channelId);
					channelId = -1;
					if ((--session.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						session.client.scheduleSynchronize();
					}
				}
			},
		};
	}

	public validationFailure(value: JsonValue): never {
		this.destroy();
		throw new Error("Value from client did not validate to the expected schema: " + JSON.stringify(value));
	}

	public createClientPromise = <T extends JsonValue | void>(fallback?: () => Promise<T> | T, validator?: (value: any) => boolean) => {
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
					this.dispatchClientEvent(eventForException(-channel.channelId, error));
				}).then(() => this.exitLocalChannel());
			}
		});
	}
	public createClientChannel = <T extends (...args: any[]) => void>(callback: T, validator?: (args: any[]) => boolean) => {
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

	public coordinateValue = <T extends JsonValue | void>(generator: () => T, validator: (value: any) => value is T): T => {
		if (!this.insideCallback || this.dead) {
			return generator();
		}
		if (!this.hadOpenServerChannel) {
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
					this.sendEvent(event);
					return parseValueEvent(global, event, passthrough as (value: JsonValue) => T, throwArgument);
				}
			}
			try {
				const value = generator();
				const newEvent = eventForValue(channelId, value);
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(newEvent);
				} catch (e) {
					escape(e);
				}
				return roundTrip(value);
			} catch (e) {
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(eventForException(channelId, e));
				} catch (e) {
					escape(e);
				}
				throw e;
			}
		}
	}

	public shareSession = async () => {
		// Server promise so that client can confirm that sharing is enabled
		const server = this.createServerPromise(async () => {
			if (!this.host.options.allowMultipleClientsPerSession) {
				throw new Error("Sharing has been disabled!");
			}
			await this.client.sharingBecameEnabled();
			return await this.client.getBaseURL(this.host.options) + "?sessionID=" + this.sessionID;
		});
		const result = await server;
		// Dummy channel that stays open
		this.createServerChannel(emptyFunction, emptyFunction, undefined, false);
		return result;
	}

	public async destroy() {
		if (!this.dead) {
			this.dead = true;
			this.mobius.dead = true;
			await this.archiveEvents(true);
			for (const pair of this.pendingChannels) {
				pair[1]();
			}
			this.pendingChannels.clear();
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
				if (this.recentEvents) {
					this.recentEvents.push(event);
				}
				const callback = this.localChannels.get(channelId);
				if (callback) {
					logOrdering("server", "message", channelId, this.sessionID);
					callback(event);
				}
			}
			await defer();
		}
		this.currentEvents = undefined;
		this.recentEvents = archive.events;
		this.bootstrappingChannels = undefined;
		this.bootstrappingPromise = undefined;
		completedBootstrapping!();
	}

	public async generateBootstrapData(client: ClientBootstrap): Promise<BootstrapData> {
		const queuedLocalEvents = await this.readAllEvents() || client.queuedLocalEvents;
		const result: BootstrapData = { sessionID: this.sessionID, channels: Array.from(this.pendingChannels.keys()) };
		if (queuedLocalEvents) {
			// TODO: Do this in such a way that we aren't mutating client directly
			client.queuedLocalEvents = undefined;
			result.events = queuedLocalEvents;
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
		this.hasActiveClient = true;
	}

	public valueForFormField(name: string): string | undefined {
		const element = this.pageRenderer.body.querySelector("[name=\"" + name + "\"]");
		if (element) {
			switch (element.nodeName) {
				case "INPUT":
				case "TEXTAREA":
					return (element as HTMLInputElement).value;
			}
		}
	}
}

function emptyFunction() {
}
