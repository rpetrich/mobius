#!/usr/bin/env node
import { cpus } from "os";
import { resolve as resolvePath } from "path";
import * as util from "util";
const Module = require("module");

import * as accepts from "accepts";
import * as bodyParser from "body-parser";
import * as express from "express";

import { diff_match_patch } from "diff-match-patch";
const diffMatchPatchNode = new (require("diff-match-patch-node") as typeof diff_match_patch)();

import * as chokidar from "chokidar";

import { ClientMessage, deserializeMessageFromText, ReloadType, serializeMessageAsText } from "./common/internal-impl";
import { Client } from "./host/client";
import compileBundle, { CompilerOutput } from "./host/compiler/bundle-compiler";
import * as csrf from "./host/csrf";
import { escape } from "./host/event-loop";
import { exists, mkdir, packageRelative, readFile, readJSON, rimraf, stat, symlink, unlink, writeFile } from "./host/fileUtils";
import { Host } from "./host/host";
import { PageRenderMode } from "./host/page-renderer";
import { Session } from "./host/session";
import { brotliedBufferFromRoute, gzippedBufferFromRoute, StaticFileRoute, staticFileRoute, stringFromRoute } from "./host/static-file-route";

import * as commandLineArgs from "command-line-args";

function delay(amount: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, amount));
}

function noCache(response: express.Response) {
	response.header("Cache-Control", "private, no-cache, no-store, must-revalidate, no-transform");
	response.header("Expires", new Date(0).toUTCString());
	response.header("Pragma", "no-cache");
}

function checkAndHandleETag(request: express.Request, response: express.Response, contentTag: string) {
	const ifMatch = request.get("if-none-match");
	if (ifMatch && ifMatch === contentTag) {
		response.statusCode = 304;
		response.end();
		return true;
	}
	response.set("ETag", contentTag);
	return false;
}

function sendCompressed(request: express.Request, response: express.Response, route: StaticFileRoute) {
	response.set("Vary", "Accept-Encoding");
	const encodings = accepts(request).encodings();
	if (encodings.indexOf("br") !== -1) {
		response.set("Content-Encoding", "br");
		response.send(brotliedBufferFromRoute(route));
	} else if (encodings.indexOf("gzip") !== -1) {
		response.set("Content-Encoding", "gzip");
		response.send(gzippedBufferFromRoute(route));
	} else {
		response.send(route.buffer);
	}
}

function topFrameHTML(request: express.Request, response: express.Response, html: string | Buffer | StaticFileRoute, contentTag?: string) {
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
		message.destroy = true;
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

const htmlContents = suppressUnhandledRejection(readFile(packageRelative("public/index.html")).then((contents) => contents.toString()));

function suppressUnhandledRejection<T>(promise: Promise<T>) {
	promise.catch(emptyFunction);
	return promise;
}

export async function prepare({ sourcePath, publicPath, sessionsPath = defaultSessionPath(sourcePath), allowMultipleClientsPerSession = true, minify = false, debug, workers = cpus().length, hostname, simulatedLatency = 0, generate = false, watch = false, compile = true }: Config) {
	const fallbackPath = packageRelative(minify ? "dist/fallback.min.js" : "dist/fallback.js");
	const fallbackRouteAsync = suppressUnhandledRejection(readFile(fallbackPath).then((contents) => staticFileRoute("/fallback.js", contents)));
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
	const servers: express.Express[] = [];
	if (watch) {
		const watcher = (require("chokidar") as typeof chokidar).watch([]);
		watchFile = async (path: string) => {
			if (await exists(path)) {
				watcher.add(path);
			}
		};
		watcher.on("change", async (path) => {
			try {
				console.log("File changed, recompiling: " + path);
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
				console.error(e);
			}
		});
	} else {
		watchFile = emptyFunction;
	}

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
			const mainPath = await loadMainPath();
			let newCompilerOutput;
			let mainScript;
			const staticAssets: { [path: string]: { contents: string; integrity: string; } } = {};
			if (compile) {
				newCompilerOutput = await compileBundle(watchFile, mainPath, sourcePath, publicPath, minify, !debug);
				mainScript = newCompilerOutput.routes["/main.js"];
				if (!mainScript) {
					throw new Error("Could not find main.js in compiled output!");
				}
				for (const assetPath of Object.keys(newCompilerOutput.routes)) {
					const route = newCompilerOutput.routes[assetPath].route;
					staticAssets[route.foreverPath] = {
						contents: stringFromRoute(route),
						integrity: route.integrity,
					};
				}
			}

			// Start compiling server
			if (compile) {
				console.log("Compiling server modules...");
			}
			const newHost = new Host({
				mainPath,
				fileRead: watchFile,
				watch,
				serverModulePaths,
				modulePaths,
				sessionsPath,
				publicPath,
				htmlSource: await htmlContents,
				allowMultipleClientsPerSession,
				workerCount: workers,
				hostname,
				moduleMap: newCompilerOutput ? newCompilerOutput.moduleMap : {},
				staticAssets,
				minify,
				suppressStacks: !debug,
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
				newDefaultRenderedRoute = staticFileRoute("/", await initialPageSession.render({
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

	function registerStatic(server: express.Express, route: StaticFileRoute, additionalHeaders: (response: express.Response) => void) {
		server.get(route.path, async (request: express.Request, response: express.Response) => {
			if (simulatedLatency) {
				await delay(simulatedLatency);
			}
			if (!checkAndHandleETag(request, response, route.etag)) {
				response.set("Cache-Control", "max-age=0, must-revalidate, no-transform");
				additionalHeaders(response);
				sendCompressed(request, response, route);
			}
		});
		server.get(route.foreverPath, async (request: express.Request, response: express.Response) => {
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

	function registerScriptRoutes(server: express.Express) {
		const output = compilerOutput;
		if (output) {
			for (const fullPath of Object.keys(output.routes)) {
				const script = output.routes[fullPath];
				const scriptRoute = script.route;
				const contentType = /\.css$/.test(fullPath) ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
				const map = script.map;
				if (map && debug) {
					const mapRoute = staticFileRoute(fullPath + ".map", JSON.stringify(map));
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
		install(server: express.Express) {
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
						client.incomingMessageId++;
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
					client.outgoingMessageId++;
					await session.prerenderContent();
					// Render the DOM into HTML source with bootstrap data applied
					const html = await session.render({
						mode: PageRenderMode.IncludeForm,
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
					client.incomingMessageId++;
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
							mode: PageRenderMode.IncludeFormAndStripScript,
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
								const diff = diffMatchPatchNode.patch_toText(diffMatchPatchNode.patch_make(client.lastSentFormHTML, html));
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

			require("express-ws")(server);
			(server as any).ws("/", async (ws: any, request: express.Request) => {
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
					await processSocketMessage(startMessage);
				} catch (e) {
					console.error(e);
					ws.close();
				}
			});

			registerScriptRoutes(server);

			if (fallbackMapContents) {
				const fallbackMap = staticFileRoute("/fallback.js.map", fallbackMapContents);
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
	(async () => {
		const cwd = process.cwd();
		const cpuCount = cpus().length;
		const args = commandLineArgs([
			{ name: "port", type: Number, defaultValue: 3000 },
			{ name: "base", type: String, defaultValue: cwd },
			{ name: "minify", type: Boolean, defaultValue: false },
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
		if (args.help) {
			console.log(require("command-line-usage")([
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
				await require("./host/init").default(args.base);
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
			process.exit(0);
		}

	})().catch(escape);
}

if (require.main === module) {
	main();
}

function emptyFunction() {
}
