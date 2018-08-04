#!/usr/bin/env node
import { Express, Request, Response } from "express";
import { cpus } from "os";
import { resolve as resolvePath } from "path";
import * as util from "util";

import { diff_match_patch } from "diff-match-patch";
import memoize, { once } from "./host/memoize";
const diffMatchPatchNode = once(() => new (require("diff-match-patch-node") as typeof diff_match_patch)());

import { accepts, bodyParser, bundler, chokidar, commandLineUsage, compiler as compilerModule, express, expressUws, host as hostModule, init, staticFileRoute } from "./host/lazy-modules";

import { ClientMessage, deserializeMessageFromText, ReloadType, serializeMessageAsText } from "./common/internal-impl";
import { Client } from "./host/client";
import { CacheData, CompilerOutput } from "./host/compiler/bundler";
import { LoaderCacheData } from "./host/compiler/sandbox";
import * as csrf from "./host/csrf";
import { exists, mkdir, packageRelative, readFile, readJSON, rimraf, stat, symlink, unlink, writeFile } from "./host/fileUtils";
import { Host } from "./host/host";
import { PageRenderMode } from "./host/page-renderer";
import { Session } from "./host/session";
import { StaticFileRoute } from "./host/static-file-route";

import * as commandLineArgs from "command-line-args";

// Hack so that Module._findPath will find TypeScript files
const Module = require("module");
Module._extensions[".ts"] = Module._extensions[".tsx"] = Module._extensions[".jsx"] = function() {
	/* tslint:disable no-empty */
};

function delay(amount: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, amount));
}

function noCache(response: Response) {
	response.header("Cache-Control", "private, no-cache, no-store, must-revalidate, no-transform");
	response.header("Expires", new Date(0).toUTCString());
	response.header("Pragma", "no-cache");
}

function checkAndHandleETag(request: Request, response: Response, contentTag: string) {
	const ifMatch = request.get("if-none-match");
	if (ifMatch && ifMatch === contentTag) {
		response.statusCode = 304;
		response.end();
		return true;
	}
	response.set("ETag", contentTag);
	return false;
}

function sendCompressed(request: Request, response: Response, route: StaticFileRoute) {
	response.set("Vary", "Accept-Encoding");
	const encodings = accepts(request).encodings();
	if (encodings.indexOf("br") !== -1) {
		response.set("Content-Encoding", "br");
		response.send(staticFileRoute.brotliedBufferFromRoute(route));
	} else if (encodings.indexOf("gzip") !== -1) {
		response.set("Content-Encoding", "gzip");
		response.send(staticFileRoute.gzippedBufferFromRoute(route));
	} else {
		response.send(route.buffer);
	}
}

function topFrameHTML(request: Request, response: Response, html: string | Buffer | StaticFileRoute, contentTag?: string) {
	// Return HTML
	if (contentTag && checkAndHandleETag(request, response, contentTag)) {
		return;
	}
	if (contentTag) {
		response.header("Cache-Control", "max-age=0, must-revalidate, no-transform");
	} else {
		noCache(response);
	}
	response.set("Content-Type", "text/html; charset=utf-8");
	response.set("Content-Security-Policy", "frame-ancestors 'none'");
	if (typeof html === "string" || html instanceof Buffer) {
		response.send(html);
	} else {
		sendCompressed(request, response, html);
	}
}

function messageFromBody(body: { [key: string]: any }): ClientMessage {
	const message: ClientMessage = {
		sessionID: body.sessionID || "",
		messageID: (body.messageID as number) | 0,
		clientID: (body.clientID as number) | 0,
		events: body.events ? JSON.parse("[" + body.events + "]") : [],
	};
	if (body.close) {
		message.close = true;
	}
	if (body.destroy) {
		message.destroy = body.destroy == 1;
	}
	return message;
}

interface Config {
	sourcePath: string;
	publicPath: string;
	sessionsPath?: string;
	allowMultipleClientsPerSession?: boolean;
	minify?: boolean;
	debug?: boolean;
	hostname?: string;
	workers?: number;
	simulatedLatency?: number;
	generate?: boolean;
	watch?: boolean;
	compile?: boolean;
	coverage?: boolean;
}

function defaultSessionPath(sourcePath: string) {
	return resolvePath(sourcePath, ".sessions");
}

async function validateSessionsAndPrepareGracefulExit(sessionsPath: string) {
	const gracefulPath = resolvePath(sessionsPath, ".graceful");
	// Check if we can reuse existing sessions
	let lastGraceful = 0;
	try {
		lastGraceful = (await stat(gracefulPath)).mtimeMs;
	} catch (e) {
		/* tslint:disable no-empty */
	}
	// if (lastGraceful < (await stat(mainPath)).mtimeMs) {
	if (lastGraceful < 1) {
		await rimraf(sessionsPath);
		await mkdir(sessionsPath);
	} else {
		await unlink(gracefulPath);
	}
	return async () => {
		await writeFile(gracefulPath, "");
	};
}

function suppressUnhandledRejection<T>(promise: Promise<T>) {
	promise.catch(emptyFunction);
	return promise;
}

function logCompilationError(e: any) {
	if (typeof e.message == "string") {
		let message: string = e.message;
		if (e.codeFrame) {
			message += "\n" + e.codeFrame;
		}
		console.error(message);
	} else {
		console.error(e);
	}
}

export async function prepare({ sourcePath, publicPath, sessionsPath = defaultSessionPath(sourcePath), allowMultipleClientsPerSession = true, minify = false, debug, workers = cpus().length, hostname, simulatedLatency = 0, generate = false, watch = false, compile = true, coverage = false }: Config) {
	const fallbackPath = packageRelative(minify ? "dist/fallback.min.js" : "dist/fallback.js");
	const fallbackRouteAsync = suppressUnhandledRejection(readFile(fallbackPath).then((contents) => staticFileRoute.staticFileRoute("/fallback.js", contents)));
	const fallbackMapContentsAsync = debug ? suppressUnhandledRejection(readFile(fallbackPath + ".map")) : undefined;
	const gracefulExitAsync = suppressUnhandledRejection(validateSessionsAndPrepareGracefulExit(sessionsPath));
	const serverModulePaths = [packageRelative("server"), resolvePath(sourcePath, "server")];
	const modulePaths = serverModulePaths.concat([packageRelative("common"), packageRelative("dist/common"), resolvePath(sourcePath, "common")]);

	// Start compiling client
	let watchFile: (path: string) => void;
	let compiling = true;
	let compilingSupportsExistingSessions = true;
	let pendingRecompile = false;
	let host: Host;
	let mainRoute: StaticFileRoute | undefined;
	let defaultRenderedRoute: StaticFileRoute | undefined;
	let compilerOutput: CompilerOutput | undefined;
	const servers: Express[] = [];
	let fileChanged: ((path: string) => void) | undefined;
	if (watch) {
		const watcher = chokidar.watch([]);
		watchFile = memoize(async (path: string) => {
			if (await exists(path)) {
				watcher.add(path);
			}
		});
		watcher.on("change", async (path) => {
			try {
				console.log("File changed, recompiling: " + path);
				fileChanged!(path);
				compilingSupportsExistingSessions = /\.css$/.test(path);
				if (compiling) {
					pendingRecompile = true;
				} else {
					try {
						compiling = true;
						await recompile();
						console.log("Reloading existing clients...");
					} finally {
						compiling = false;
					}
				}
			} catch (e) {
				logCompilationError(e);
			}
		});
	} else {
		watchFile = emptyFunction;
	}
	const mainPath = await loadMainPath();
	let cacheProfile = "client";
	if (debug) {
		cacheProfile += "-debug";
	}
	if (minify) {
		cacheProfile += "-minify";
	}
	const compiler = new compilerModule.Compiler("client", await compilerModule.loadCache<CacheData>(mainPath, cacheProfile), mainPath, [packageRelative("common/main.ts")], minify, watchFile);
	fileChanged = compiler.fileChanged;

	async function loadMainPath() {
		try {
			const packagePath = resolvePath(sourcePath, "package.json");
			watchFile(packagePath);
			const mainPath = (await readJSON(packagePath)).main;
			if (typeof mainPath === "string") {
				return resolvePath(sourcePath, mainPath);
			}
		} catch (e) {
		}
		const result = Module._findPath("app", [sourcePath]);
		if (typeof result === "string") {
			return result;
		}
		throw new Error("Could not find app.ts or app.tsx in " + sourcePath);
	}

	async function recompile() {
		do {
			pendingRecompile = false;

			// Start compiling client
			if (compile) {
				console.log("Compiling client modules...");
			}
			let newCompilerOutput;
			let mainScript;
			const staticAssets: { [path: string]: { contents: string; integrity: string; } } = {};
			if (compile) {
				newCompilerOutput = await bundler.bundle(compiler, mainPath, publicPath, minify, !debug, watchFile);
				mainScript = newCompilerOutput.routes["main.js"];
				if (!mainScript) {
					throw new Error("Could not find main.js in compiled output!");
				}
				for (const assetPath of Object.keys(newCompilerOutput.routes)) {
					const route = newCompilerOutput.routes[assetPath].route;
					staticAssets[route.foreverPath] = {
						contents: staticFileRoute.stringFromRoute(route),
						integrity: route.integrity,
					};
				}
			}

			// Start compiling server
			if (compile) {
				console.log("Compiling server modules...");
			}
			const buildTokens = ["server"];
			if (minify) {
				buildTokens.push("minify");
			}
			if (coverage) {
				buildTokens.push("coverage");
			}
			const newHost = new hostModule.Host({
				mainPath,
				fileRead: watchFile,
				watch,
				serverModulePaths,
				modulePaths,
				sessionsPath,
				publicPath,
				allowMultipleClientsPerSession,
				workerCount: workers,
				hostname,
				moduleMap: newCompilerOutput ? newCompilerOutput.moduleMap : {},
				staticAssets,
				minify,
				suppressStacks: !debug,
				coverage,
				loaderCache: await compilerModule.loadCache<LoaderCacheData>(mainPath, buildTokens.join("-")),
			});

			// Start initial page render
			let newMainRoute;
			let newDefaultRenderedRoute;
			if (compile) {
				console.log("Rendering initial page...");
				const initialPageSession = newHost.sessionGroup.constructSession("");
				initialPageSession.updateOpenServerChannelStatus(true);
				await initialPageSession.prerenderContent();

				if (mainScript) {
					newMainRoute = mainScript.route;
				}
				const fallback = await fallbackRouteAsync;
				newDefaultRenderedRoute = staticFileRoute.staticFileRoute("/", await initialPageSession.render({
					mode: PageRenderMode.Bare,
					client: { clientID: 0, incomingMessageId: 0 },
					clientURL: newMainRoute ? newMainRoute.foreverPath : "/main.js",
					clientIntegrity: newMainRoute ? newMainRoute.integrity : "",
					fallbackURL: fallback.foreverPath,
					fallbackIntegrity: fallback.integrity,
					noScriptURL: "/?js=no",
					inlineCSS: true,
					bootstrap: watch ? true : undefined,
				}));
				await initialPageSession.destroy();
			}
			// Publish the new compiled output
			const oldHost = host;
			host = newHost;
			if (compile) {
				mainRoute = newMainRoute;
				defaultRenderedRoute = newDefaultRenderedRoute;
				compilerOutput = newCompilerOutput;
				for (const server of servers) {
					registerScriptRoutes(server);
				}
			}
			if (oldHost) {
				await oldHost.destroy();
			}
		} while (pendingRecompile);
	}

	function registerStatic(server: Express, route: StaticFileRoute, additionalHeaders: (response: Response) => void) {
		server.get(route.path, async (request: Request, response: Response) => {
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			if (!checkAndHandleETag(request, response, route.etag)) {
				response.set("Cache-Control", "max-age=0, must-revalidate, no-transform");
				additionalHeaders(response);
				sendCompressed(request, response, route);
			}
		});
		server.get(route.foreverPath, async (request: Request, response: Response) => {
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			response.set("Cache-Control", "max-age=31536000, no-transform, immutable");
			response.set("Expires", "Sun, 17 Jan 2038 19:14:07 GMT");
			additionalHeaders(response);
			sendCompressed(request, response, route);
		});
		if (generate) {
			(async () => {
				const foreverPathRelative = route.foreverPath.replace(/^\//, "");
				const pathRelative = route.path.replace(/^\//, "");
				const foreverPath = resolvePath(publicPath, foreverPathRelative);
				if (await exists(foreverPath)) {
					await unlink(foreverPath);
				}
				await writeFile(foreverPath, route.buffer);
				const path = resolvePath(publicPath, pathRelative);
				if (await exists(path)) {
					await unlink(path);
				}
				await symlink(foreverPathRelative, path);
			})();
		}
	}

	function registerScriptRoutes(server: Express) {
		const output = compilerOutput;
		if (output) {
			for (const fullPath of Object.keys(output.routes)) {
				const script = output.routes[fullPath];
				const scriptRoute = script.route;
				const contentType = /\.css$/.test(fullPath) ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
				const map = script.map;
				if (map && debug) {
					const mapRoute = staticFileRoute.staticFileRoute(`/${fullPath}.map`, JSON.stringify(map));
					registerStatic(server, scriptRoute, (response) => {
						response.set("Content-Type", contentType);
						response.set("X-Content-Type-Options", "nosniff");
						response.set("SourceMap", mapRoute.foreverPath);
					});
					registerStatic(server, mapRoute, (response) => {
						response.set("Content-Type", "application/json; charset=utf-8");
					});
				} else {
					registerStatic(server, scriptRoute, (response) => {
						response.set("Content-Type", contentType);
						response.set("X-Content-Type-Options", "nosniff");
					});
				}
			}
		}
	}

	// Compile and run the first instance of the app
	await recompile();
	compiling = false;

	// Await remaining assets
	let fallbackMapContents: Buffer | undefined;
	try {
		fallbackMapContents = await fallbackMapContentsAsync;
	} catch (e) {
	}
	const gracefulExit = await gracefulExitAsync;
	const fallbackRoute = await fallbackRouteAsync;
	return {
		install(server: Express) {
			servers.push(server);

			server.use(bodyParser.urlencoded({
				extended: true,
				type: () => true, // Accept all MIME types
			}));

			server.get("/", async (request, response) => {
				try {
					const sessionID = request.query.sessionID;
					let session: Session;
					let client: Client;
					if (sessionID) {
						// Joining existing session
						session = await host.sessionFromId(sessionID, request, false);
						client = session.client.newClient(session, request);
					} else {
						// Not prerendering or joining a session, just return the original source with the noscript added
						if (request.query.js !== "no") {
							if (simulatedLatency) {
								await delay(simulatedLatency);
							}
							if (defaultRenderedRoute) {
								return topFrameHTML(request, response, defaultRenderedRoute, defaultRenderedRoute.etag);
							}
						}
						// New session
						client = await host.newClient(request);
						session = client.session;
					}
					session.updateOpenServerChannelStatus(true);
					// Prerendering was enabled, wait for content to be ready
					client.incomingMessageId++;
					client.outgoingMessageId++;
					await session.prerenderContent();
					// Render the DOM into HTML source with bootstrap data applied
					const html = await session.render({
						mode: request.query.js === "no" ? PageRenderMode.IncludeFormAndStripScript : PageRenderMode.IncludeForm,
						client: {
							clientID: client.clientID,
							incomingMessageId: client.incomingMessageId,
							queuedLocalEvents: client.queuedLocalEvents,
						},
						clientURL: mainRoute ? mainRoute.foreverPath : "",
						clientIntegrity: mainRoute ? mainRoute.integrity : "",
						fallbackURL: fallbackRoute.foreverPath,
						fallbackIntegrity: fallbackRoute.integrity,
						bootstrap: true,
						inlineCSS: true,
					});
					// Need to update client state
					client.queuedLocalEvents = undefined;
					client.applyCookies(response);
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					return topFrameHTML(request, response, html);
				} catch (e) {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					// Internal error of some kind
					response.status(500);
					response.set("Content-Type", "text/plain");
					response.set("Content-Security-Policy", "frame-ancestors 'none'");
					response.send(util.inspect(e));
				}
			});

			server.post("/", async (request, response) => {
				try {
					csrf.validate(request, hostname);
					const body = request.body;
					const message = messageFromBody(body);
					if (message.destroy) {
						// Destroy the client's session (this is navigator.sendBeacon)
						await host.destroyClientById(message.sessionID || "", message.clientID as number | 0);
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						noCache(response);
						response.set("Content-Type", "text/plain");
						response.send("");
						return;
					}
					const postback = body.postback;
					let client: Client;
					if (!message.sessionID && postback == "js") {
						client = await host.newClient(request);
					} else {
						client = await host.clientFromMessage(message, request, !postback);
					}
					if (postback) {
						const isJavaScript = postback == "js";
						// Process the fallback message
						await client.receiveFallbackMessage(message, body);
						if (isJavaScript) {
							// Wait for events to be ready
							await client.dequeueEvents(false);
						} else {
							// Wait for content to be ready
							await client.session.prerenderContent();
						}
						// Render the DOM into HTML source
						const html = await client.session.render({
							mode: isJavaScript ? PageRenderMode.IncludeForm : PageRenderMode.IncludeFormAndStripScript,
							client: {
								clientID: client.clientID,
								incomingMessageId: client.incomingMessageId,
								queuedLocalEvents: client.queuedLocalEvents,
							},
							clientURL: mainRoute ? mainRoute.foreverPath : "",
							clientIntegrity: mainRoute ? mainRoute.integrity : "",
							fallbackURL: fallbackRoute.foreverPath,
							fallbackIntegrity: fallbackRoute.integrity,
						});
						let responseContent = html;
						if (isJavaScript) {
							if (client.lastSentFormHTML) {
								const diff = diffMatchPatchNode().patch_toText(diffMatchPatchNode().patch_make(client.lastSentFormHTML, html));
								if (diff.length < html.length && diff.length) {
									responseContent = diff;
								}
							}
							client.lastSentFormHTML = html;
						}
						client.queuedLocalEvents = undefined;
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						client.applyCookies(response);
						noCache(response);
						response.set("Content-Type", isJavaScript ? "text/plain; charset=utf-8" : "text/html; charset=utf-8");
						response.set("Content-Security-Policy", "frame-ancestors 'none'");
						response.send(responseContent);
					} else {
						client.becameActive();
						// Dispatch the events contained in the message
						await client.receiveMessage(message);
						// Wait for events to be ready
						const keepGoing = await client.dequeueEvents(watch);
						// Send the serialized response message back to the client
						const rawResponseMessage = client.produceMessage(!keepGoing);
						if (compiling) {
							rawResponseMessage.reload = compilingSupportsExistingSessions ? ReloadType.KeepSession : ReloadType.NewSession;
						}
						const responseMessage = serializeMessageAsText(rawResponseMessage);
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						client.applyCookies(response);
						noCache(response);
						response.set("Content-Type", "text/plain; charset=utf-8");
						response.send(responseMessage);
					}
				} catch (e) {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					response.status(500);
					noCache(response);
					response.set("Content-Type", "text/plain; charset=utf-8");
					response.send(util.inspect(e));
				}
			});

			expressUws(server);
			(server as any).ws("/", async (ws: any, request: Request) => {
				// WebSockets protocol implementation
				try {
					csrf.validate(request, hostname);
					let closed = false;
					ws.on("error", () => {
						ws.close();
					});
					ws.on("close", () => {
						closed = true;
					});
					// Get the startup message contained in the WebSocket URL (avoid extra round trip to send events when websocket is opened)
					const startMessage = messageFromBody(request.query);
					const client = await host.clientFromMessage(startMessage, request, true);
					client.becameActive();
					// Track what the last sent/received message IDs are so we can avoid transmitting them
					let lastIncomingMessageId = startMessage.messageID;
					let lastOutgoingMessageId = -1;
					async function processSocketMessage(message: ClientMessage) {
						if (typeof message.close == "boolean") {
							// Determine if client accepted our close instruction
							if (closed = message.close) {
								ws.close();
							}
						}
						try {
							await client.receiveMessage(message);
							await processMoreEvents();
						} catch (e) {
							ws.close();
						}
					}
					let processingEvents = false;
					async function processMoreEvents() {
						// Dequeue response messages in a loop until socket is closed
						while (!processingEvents && !closed) {
							processingEvents = true;
							const keepGoing = await client.dequeueEvents(watch);
							processingEvents = false;
							if (!closed) {
								closed = !keepGoing || !((await client.session.hasLocalChannels()) || watch);
								const message = client.produceMessage(closed);
								if (compiling) {
									message.reload = compilingSupportsExistingSessions ? ReloadType.KeepSession : ReloadType.NewSession;
								}
								if (lastOutgoingMessageId == message.messageID) {
									delete message.messageID;
								}
								lastOutgoingMessageId = client.outgoingMessageId;
								const serialized = serializeMessageAsText(message);
								if (simulatedLatency) {
									await delay(simulatedLatency);
								}
								ws.send(serialized);
							}
						}
					}
					// Process incoming messages
					ws.on("message", (msg: string) => {
						const message = deserializeMessageFromText<ClientMessage>(msg, lastIncomingMessageId + 1);
						lastIncomingMessageId = message.messageID;
						processSocketMessage(message);
					});
					if (startMessage.destroy !== false) {
						await processSocketMessage(startMessage);
					} else {
						lastIncomingMessageId--;
					}
				} catch (e) {
					console.error(e);
					ws.close();
				}
			});

			registerScriptRoutes(server);

			if (fallbackMapContents) {
				const fallbackMap = staticFileRoute.staticFileRoute("/fallback.js.map", fallbackMapContents);
				registerStatic(server, fallbackRoute, (response) => {
					response.set("Content-Type", "text/javascript; charset=utf-8");
					response.set("X-Content-Type-Options", "nosniff");
					response.set("SourceMap", fallbackMap.foreverPath);
				});
				registerStatic(server, fallbackMap, (response) => {
					response.set("Content-Type", "application/json; charset=utf-8");
				});
			} else {
				registerStatic(server, fallbackRoute, (response) => {
					response.set("Content-Type", "text/javascript; charset=utf-8");
					response.set("X-Content-Type-Options", "nosniff");
				});
			}
		},
		async replay(sessionId: string) {
			await host.sessionFromId(sessionId, undefined, false);
		},
		async stop() {
			await host.destroy();
			await gracefulExit();
		},
	};
}

export default function main() {
	const cwd = process.cwd();
	const cpuCount = cpus().length;
	let args: ReturnType<typeof commandLineArgs>;
	try {
		args = commandLineArgs([
			{ name: "port", type: Number, defaultValue: 3000 },
			{ name: "base", type: String, defaultValue: cwd },
			{ name: "minify", type: Boolean, defaultValue: false },
			{ name: "coverage", type: Boolean, defaultValue: false },
			{ name: "debug", type: Boolean, defaultValue: false },
			{ name: "workers", type: Number, defaultValue: cpuCount },
			{ name: "generate", type: Boolean, defaultValue: false },
			{ name: "watch", type: Boolean, defaultValue: false },
			{ name: "hostname", type: String },
			{ name: "simulated-latency", type: Number, defaultValue: 0 },
			{ name: "launch", type: Boolean, defaultValue: false },
			{ name: "init", type: Boolean, defaultValue: false },
			{ name: "replay", type: String },
			{ name: "generate-docs", type: Boolean },
			{ name: "help", type: Boolean },
		]);
	} catch (e) {
		if (e.name === "UNKNOWN_OPTION") {
			console.error(e.message);
			process.exit(1);
		}
		throw e;
	}
	(async () => {
		if (args.help) {
			console.log(commandLineUsage([
				{
					header: "Mobius",
					content: "Unified frontend and backend framework for building web apps",
				},
				{
					header: "Options",
					optionList: [
						{
							name: "init",
							description: "Initialize a new mobius project",
						},
						{
							name: "port",
							typeLabel: "{underline number}",
							description: "The port number to listen on",
						},
						{
							name: "base",
							typeLabel: "{underline path}",
							description: "The base path of the app to serve",
						},
						{
							name: "minify",
							description: "Minify JavaScript code served to the browser",
						},
						{
							name: "debug",
							description: "Expose source maps for debugging in supported browsers, full stack traces and redacted arguments of sensitive functions",
						},
						{
							name: "hostname",
							typeLabel: "{underline name}",
							description: "Public hostname to serve content from; used to validate CSRF if set",
						},
						{
							name: "generate",
							description: "Write generated static assets to public/",
						},
						{
							name: "workers",
							typeLabel: "{underline number}",
							description: `Number or workers to use (defaults to number of CPUs: ${cpuCount})`,
						},
						{
							name: "launch",
							description: "Open the default browser once server is ready for requests",
						},
						{
							name: "coverage",
							description: "Run with nyc-compatible code coverage instrumentation",
						},
						{
							name: "replay",
							typeLabel: "{underline session-id}",
							description: "Replays the session from start to finish",
						},
						{
							name: "help",
							description: "Prints this usage guide. Yahahah! You found me!",
						},
					],
				},
				{
					content: "Project home: {underline https://github.com/rpetrich/mobius}",
				},
			]));
			process.exit(1);
		}

		if (args.init) {
			try {
				await init.default(args.base);
			} catch (e) {
				if (e instanceof Error && e.message === "canceled") {
					process.exit(1);
				}
				throw e;
			}
			process.exit(0);
		}

		if (args["generate-docs"]) {
			await (await import("./host/documentation-generator")).run();
			return;
		}

		const basePath = resolvePath(cwd, args.base as string);

		const publicPath = resolvePath(basePath, "public");
		const replay = args.replay;
		const hasReplay = typeof replay === "string";
		const coverage = args.coverage as boolean;

		const mobius = await prepare({
			sourcePath: basePath,
			publicPath,
			minify: args.minify as boolean,
			debug: args.debug as boolean,
			hostname: args.hostname as string | undefined,
			workers: hasReplay ? 0 : args.workers as number,
			simulatedLatency: args["simulated-latency"] as number,
			generate: args.generate as boolean,
			watch: args.watch as boolean,
			compile: !hasReplay,
			coverage,
		});

		if (hasReplay) {
			await mobius.replay(replay);
			await mobius.stop();
			return;
		}

		const expressAsync = require("express") as typeof express;
		const server = expressAsync();

		server.disable("x-powered-by");
		server.disable("etag");

		mobius.install(server);

		server.use(expressAsync.static(publicPath));

		const port = args.port;
		const hostname = args.hostname;
		const acceptSocket = server.listen(port, () => {
			const publicURL = typeof hostname == "string" ? "http://" + hostname : "http://localhost:" + port;
			console.log(`Serving ${basePath} on ${publicURL}`);
			if (args.launch as boolean) {
				(require("opn") as (url: string) => void)(publicURL);
			}
		});

		// Graceful shutdown
		process.on("SIGTERM", onInterrupted);
		process.on("SIGINT", onInterrupted);
		async function onInterrupted() {
			process.removeListener("SIGTERM", onInterrupted);
			process.removeListener("SIGINT", onInterrupted);
			const acceptSocketClosed = new Promise((resolve) => {
				acceptSocket.close(resolve);
			});
			await mobius.stop();
			await acceptSocketClosed;
			if (coverage) {
				const nycPath = resolvePath(basePath, ".nyc_output");
				await rimraf(nycPath);
				await mkdir(nycPath);
				await writeFile(resolvePath(nycPath, "coverage.json"), JSON.stringify((global as any).__coverage__));
			}
			process.exit(0);
		}

	})().catch((e) => {
		logCompilationError(e);
		process.exit(1);
	});
}

if (require.main === module) {
	main();
}

function emptyFunction() {
}
