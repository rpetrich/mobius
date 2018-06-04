import { interceptGlobals } from "determinism";
import { BootstrapData, ClientMessage, deserializeMessageFromText, disconnectedError, Event, eventForException, eventForValue, logOrdering, parseValueEvent, roundTrip, roundTripException, serializeMessageAsText, ServerMessage } from "internal-impl";
import { ReloadType } from "internal-impl";
import { Channel, JsonValue } from "mobius-types";
/**
 * @license THE MIT License (MIT)
 *
 * Copyright (c) 2017-2018 Ryan Petrich
 * Copyright (c) 2017 Jason Miller
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
if (history.replaceState) {
	const queryComponents = location.search.substr(1).split(/\&/g);
	let i = queryComponents.length;
	let replace: true | undefined;
	while (i--) {
		if (/^sessionID=/.test(queryComponents[i]) || queryComponents[i] == "js=no") {
			queryComponents.splice(i, 1);
			replace = true;
		}
	}
	if (replace) {
		history.replaceState(history.state, "", queryComponents.length ? location.pathname + "?" + queryComponents.join("&") : location.pathname);
	}
}

const setTimeout = window.setTimeout;
const clearTimeout = window.clearTimeout;

type Task = () => void;
function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
	return typeof value == "object" && "then" in (value as any);
}

const microTaskQueue: Task[] = [];
const taskQueue: Task[] = [];

const { scheduleFlushTasks, setImmediate } = (() => {
	let newSetImmediate: (callback: () => void) => void = window.setImmediate;
	let newScheduleFlushTasks: (() => void) | undefined;
	// Attempt postMessage, but only if it's asynchronous
	if (!newSetImmediate && window.postMessage) {
		let isAsynchronous = true;
		const synchronousTest = () => {
			isAsynchronous = false;
		};
		window.addEventListener("message", synchronousTest, false);
		window.postMessage("__mobius_test", "*");
		window.removeEventListener("message", synchronousTest, false);
		if (isAsynchronous) {
			window.addEventListener("message", flushTasks, false);
			newScheduleFlushTasks = () => {
				window.postMessage("__mobius_flush", "*");
			};
		}
	}
	// Try a <script> tag's onreadystatechange
	if (!newSetImmediate && "onreadystatechange" in document.createElement("script")) {
		newSetImmediate = (callback) => {
			const script = document.createElement("script");
			(script as any).onreadystatechange = () => {
				document.head.removeChild(script);
				callback();
			};
			document.head.appendChild(script);
		};
	}
	// Try requestAnimationFrame
	if (!newSetImmediate) {
		const requestAnimationFrame = window.requestAnimationFrame || (window as any).webkitRequestRequestAnimationFrame || (window as any).mozRequestRequestAnimationFrame;
		if (requestAnimationFrame) {
			newSetImmediate = requestAnimationFrame;
		}
	}
	// Fallback to setTimeout(..., 0)
	if (!newSetImmediate) {
		newSetImmediate = (callback) => {
			setTimeout.call(window, callback, 0);
		};
	}
	return { scheduleFlushTasks: newScheduleFlushTasks || newSetImmediate.bind(window, flushTasks), setImmediate: newSetImmediate };
})();

function flushMicroTasks() {
	let task: Task | undefined;
	while (task = microTaskQueue.shift()) {
		task();
	}
}

function flushTasks() {
	let completed: boolean | undefined;
	try {
		flushMicroTasks();
		const task = taskQueue.shift();
		if (task) {
			task();
		}
		completed = !taskQueue.length;
	} finally {
		if (!completed) {
			scheduleFlushTasks();
		}
	}
}

// Dispatches a microtask
function submitTask(queue: Task[], task: Task) {
	queue.push(task);
	if (microTaskQueue.length + taskQueue.length == 1) {
		scheduleFlushTasks();
	}
}

// Setup bundled Promise implementation if native implementation doesn't schedule as micro-tasks or is not present
if (!(window as any).Promise || !/^Google |^Apple /.test(navigator.vendor)) {
	(window as any).Promise = bundledPromiseImplementation();
}

const resolvedPromise: Promise<void> = Promise.resolve();

function defer(): Promise<void>;
function defer<T>(value: T): Promise<T>;
function defer(value?: any): Promise<any> {
	return new Promise<any>((resolve) => submitTask(taskQueue, resolve.bind(null, value)));
}

// Dispatch error in a way that shows up in the browser's error console
function escape(e: any) {
	if (console.error) {
		console.error(e);
	} else {
		setImmediate(() => {
			throw e;
		});
	}
}

function escaping(handler: () => any | Promise<any>): () => Promise<void>;
function escaping<T, V>(handler: (value: T) => V | Promise<V>): (value: T) => Promise<V | void>;
function escaping(handler: (value?: any) => any | Promise<any>): (value?: any) => Promise<any> {
	return (value?: any) => {
		try {
			return Promise.resolve(handler(value)).catch(escape);
		} catch (e) {
			escape(e);
			return resolvedPromise;
		}
	};
}

function emptyFunction() {
	/* tslint:disable no-empty */
}

const slice = Array.prototype.slice;

function uuid(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		return (c == "x" ? r : (r & 3 | 8)).toString(16);
	});
}

// Message ordering
let outgoingMessageId = 0;
let incomingMessageId = 0;
const reorderedMessages: { [messageId: number]: ServerMessage } = {};
let willSynchronizeChannels: boolean = false;
let currentEvents: Array<Event | boolean> | undefined;
const allEvents: Array<Event | boolean> = [];
let bootstrappingChannels: number[] | undefined;
function shouldImplementLocalChannel(channelId: number) {
	return !bootstrappingChannels || (bootstrappingChannels.indexOf(channelId) != -1);
}

// Maintain whether or not inside callback
let dispatchingEvent = 1;
let dispatchingAPIImplementation: number = 0;
let insideCallback: boolean = true;
// and whether or not a module is loading
let loadingModules = 0;

function updateInsideCallback() {
	insideCallback = dispatchingEvent != 0 && dispatchingAPIImplementation == 0;
	if (!dispatchingEvent && (!loadingModules || dead)) {
		const callback = idleCallbacks.shift();
		if (callback) {
			defer().then(updateInsideCallback);
			callback();
		}
	}
}

// Entering/exiting a "user space" callback
function willEnterCallback() {
	dispatchingEvent++;
	insideCallback = true;
	defer().then(didExitCallback);
}
function didExitCallback() {
	dispatchingEvent--;
	updateInsideCallback();
}

// Wait for event queue to become idle
const idleCallbacks: Array<() => void> = [];
function idle(first?: true): Promise<void> {
	return !dispatchingEvent && (!loadingModules || dead) ? resolvedPromise : new Promise((resolve) => {
		if (first) {
			idleCallbacks.unshift(resolve);
		} else {
			idleCallbacks.push(resolve);
		}
	});
}

// Entering a "kernal space" callback
function runAPIImplementation<T>(block: () => T): T {
	dispatchingAPIImplementation++;
	insideCallback = false;
	try {
		const result = block();
		dispatchingAPIImplementation--;
		updateInsideCallback();
		return result;
	} catch (e) {
		dispatchingAPIImplementation--;
		updateInsideCallback();
		throw e;
	}
}

// Session state
const startupScripts = document.getElementsByTagName("script");
const bootstrapData = (() => {
	// Read bootstrap data
	if (!window.performance || performance.navigation.type !== 1) {
		const historyState = history.state;
		if (historyState && "sessionID" in historyState) {
			return historyState as Partial<BootstrapData>;
		}
	}
	for (let i = 0; i < startupScripts.length; i++) {
		const element = startupScripts[i];
		if (element.getAttribute("type") == "application/x-mobius-bootstrap") {
			element.parentNode!.removeChild(element);
			return JSON.parse(element.textContent || element.innerHTML) as Partial<BootstrapData>;
		}
	}
	return {} as Partial<BootstrapData>;
})();
const sessionID: string = bootstrapData.sessionID || uuid();
const alwaysConnected = bootstrapData.connect;

/**
 * Retrieves an identifier uniquely representing the client within the session.
 * Only accessible in client context.
 */
export const clientID = (bootstrapData.clientID as number) | 0;
const serverURL = location.href.match(/^[^?]*/)![0];
let activeConnectionCount = 0;
export let dead = false;

// Remote channels
let remoteChannelCounter = 0;
const pendingChannels: { [channelId: number]: (event?: Event) => void; } = {};
let pendingChannelCount = 0;
let hadOpenServerChannel = false;

// Local channels
let localChannelCounter = 0;
let queuedLocalEvents: Event[] = [];
const fencedLocalEvents: Event[] = [];
const pendingLocalChannels: { [channelId: number]: (event: Event) => void; } = {};
let totalBatched = 0;
let isBatched: { [channelId: number]: true } = {};
let pendingBatchedActions: Array<() => void> = [];

// Heartbeat
const sessionHeartbeatInterval = 4 * 60 * 1000;
let heartbeatTimeout: number = 0;

// Websocket support
const socketURL = serverURL.replace(/^http/, "ws").replace(/#.*/, "") + "?";
let WebSocketClass = (window as any).WebSocket as typeof WebSocket | undefined;
let websocket: WebSocket | undefined;

const wrapperForm = document.getElementById("mobius-form") as HTMLFormElement;
if (wrapperForm) {
	wrapperForm.onsubmit = () => false;
}

// Send pending data to the server, if any
const synchronizeChannels = escaping(() => {
	if (loadingModules) {
		idleCallbacks.push(synchronizeChannels);
		return;
	}
	willSynchronizeChannels = false;
	if (!dead) {
		const useWebSockets = pendingChannelCount != 0 || alwaysConnected;
		if ((useWebSockets && activeConnectionCount == 0) || queuedLocalEvents.length) {
			sendMessages(useWebSockets);
			restartHeartbeat();
		} else if (websocket) {
			// Disconnect WebSocket when server can't possibly send us messages
			if (websocket.readyState < 2) {
				websocket.close();
			}
			websocket = undefined;
		}
	}
});

let afterHydration: Promise<void> = defer().then(didExitCallback);
if (bootstrapData.sessionID) {
	++outgoingMessageId;
	const events = bootstrapData.events || [];
	currentEvents = events;
	bootstrappingChannels = bootstrapData.channels;
	const firstEvent = events[0];
	if (typeof firstEvent == "boolean") {
		hadOpenServerChannel = firstEvent;
	}
	willSynchronizeChannels = true;
	// Create a hidden DOM element to render into until all events are processed
	const serverRenderedHostElement = document.body.children[0];
	serverRenderedHostElement.setAttribute("style", "pointer-events:none;user-select:none");
	const clientRenderedHostElement = document.createElement("div");
	clientRenderedHostElement.style.display = "none";
	document.body.insertBefore(clientRenderedHostElement, serverRenderedHostElement);
	afterHydration = afterHydration.then(escaping(processMessage.bind(null, bootstrapData))).then(defer).then(() => {
		bootstrappingChannels = undefined;
		// Swap the prerendered DOM element out for the one with mounted components
		const childNodes = slice.call(serverRenderedHostElement.childNodes, 0);
		for (let i = 0; i < childNodes.length; i++) {
			if (childNodes[i].nodeName === "LINK") {
				document.body.appendChild(childNodes[i]);
			}
		}
		document.body.removeChild(serverRenderedHostElement);
		// Update the scroll to match what was saved in the bootstrap
		if ("x" in bootstrapData && "y" in bootstrapData) {
			window.scrollTo(bootstrapData.x, bootstrapData.y);
		}
		clientRenderedHostElement.style.display = null;
	}).then(synchronizeChannels);
} else if (alwaysConnected) {
	willSynchronizeChannels = true;
	afterHydration = afterHydration.then(synchronizeChannels);
}

/** @ignore */
export const registeredListeners: { [ eventId: number ]: (event: any) => void } = {};

afterHydration.then(() => {
	// Dispatch DOM events that occurred as the page was loading (via calls to _dispatch generated from a server side render)
	const racedEvents = (window as any)._mobiusEvents as ReadonlyArray<[number, any]>;
	if (racedEvents) {
		delete (window as any)._mobiusEvents;
		(window as any)._dispatch = emptyFunction;
		return racedEvents.reduce((promise: Promise<void>, event: [number, any]) => promise.then(() => registeredListeners[event[0]](event[1])).then(defer as () => Promise<void>), resolvedPromise);
	}
});

// Extract queued events into a message to send to the server
function produceMessage(): Partial<ClientMessage> {
	const result: Partial<ClientMessage> = { messageID: outgoingMessageId++ };
	if (queuedLocalEvents.length) {
		result.events = queuedLocalEvents;
		queuedLocalEvents = [];
	}
	if (clientID) {
		result.clientID = clientID;
	}
	return result;
}

// Kill the existing heartbeat timer
function cancelHeartbeat() {
	if (heartbeatTimeout) {
		clearTimeout(heartbeatTimeout);
		heartbeatTimeout = 0;
	}
}

// Reschedule the heartbeat timer
function restartHeartbeat() {
	cancelHeartbeat();
	heartbeatTimeout = setTimeout(sendMessages, sessionHeartbeatInterval);
}

// Tear down any communication with the server and enter the dead state
export function disconnect() {
	if (!dead) {
		dead = true;
		hadOpenServerChannel = false;
		cancelHeartbeat();
		window.removeEventListener("unload", disconnect, false);
		// Save the state to history, so that if back button is hit the app magically snaps back to where we were
		if (history.replaceState) {
			const channels: number[] = [];
			for (const i in pendingLocalChannels) {
				if (Object.hasOwnProperty.call(pendingLocalChannels, i)) {
					channels.push(((i as any) as number) | 0);
				}
			}
			const replacementBootstrap: BootstrapData = { sessionID, clientID, events: allEvents, channels, x: window.scrollX || window.pageXOffset, y: window.scrollY || window.pageYOffset };
			history.replaceState(replacementBootstrap, document.title, location.href);
		}
		// Forcefully tear down WebSocket
		if (websocket) {
			if (websocket.readyState < 2) {
				websocket.close();
			}
			websocket = undefined;
		}
		// Abandon pending channels
		for (const channelId in pendingChannels) {
			if (Object.hasOwnProperty.call(pendingChannels, channelId)) {
				pendingChannels[channelId]();
			}
		}
		// Send a "destroy" message so that the server can clean up the session
		const message = produceMessage();
		message.destroy = true;
		const body = serializeMessageAsQueryString(message);
		if (navigator.sendBeacon) {
			navigator.sendBeacon(serverURL, body);
		} else {
			const request = new XMLHttpRequest();
			request.open("POST", serverURL, false);
			request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
			request.send(body);
		}
		// Flush fenced events
		fencedLocalEvents.reduce((promise: Promise<any>, event: Event) => promise.then(() => escapingDispatchEvent(event)).then(defer), resolvedPromise as Promise<any>);
	}
}

window.addEventListener("unload", disconnect, false);

// Dispatch an event from the server (potentially either a server-side event, or a fenced/peer client-side event)
function dispatchEvent(event: Event): Promise<void> | void {
	let channelId = event[0];
	let channel: ((event: Event) => void) | undefined;
	if (channelId < 0) {
		// Fenced client-side event
		for (let i = 0; i < fencedLocalEvents.length; i++) {
			const fencedEvent = fencedLocalEvents[i];
			if (fencedEvent[0] == channelId) {
				event = fencedEvent;
				fencedLocalEvents.splice(i, 1);
				break;
			}
		}
		channelId = -channelId;
		channel = pendingLocalChannels[channelId];
		// Apply batching
		if (totalBatched && isBatched[channelId] && ((--totalBatched) == 0)) {
			const batchedActions = pendingBatchedActions;
			pendingBatchedActions = [];
			isBatched = {};
			return batchedActions.reduce((promise: Promise<any>, action) => {
				return promise.then(escaping(action)).then(defer);
			}, resolvedPromise).then(escaping(callChannelWithEvent.bind(null, channel, event)));
		}
	} else {
		// Server-side event
		channel = pendingChannels[channelId];
	}
	allEvents.push(event);
	callChannelWithEvent(channel, event);
}
const escapingDispatchEvent = escaping(dispatchEvent);

// Send an event to a channel, respecting batching
function callChannelWithEvent(channel: ((event: Event) => void) | undefined, event: Event) {
	if (channel) {
		if (totalBatched) {
			pendingBatchedActions.push(channel.bind(null, event));
		} else {
			channel(event);
		}
	}
}

// Process events from the server
function processEvents(events: Array<Event | boolean>) {
	return idle().then(() => {
		hadOpenServerChannel = pendingChannelCount != 0;
		currentEvents = events;
		return events.reduce((promise: Promise<any>, event: Event | boolean) => {
			if (typeof event == "boolean") {
				return promise.then(() => {
					allEvents.push(event);
					hadOpenServerChannel = event;
				});
			} else {
				return promise.then(escapingDispatchEvent.bind(null, event)).then(defer).then(() => idle(true));
			}
		}, resolvedPromise as Promise<any>).then(() => {
			currentEvents = undefined;
			hadOpenServerChannel = pendingChannelCount != 0;
		});
	});
}

let serverDisconnectCount = 0;
// Process message from the server
function processMessage(message: ServerMessage): Promise<void> {
	if (message.reload) {
		disconnect();
		if (message.reload === ReloadType.NewSession) {
			location.reload(true);
		} else {
			const queryComponents = location.search.substr(1).split(/\&/g);
			let i = queryComponents.length;
			while (i--) {
				if (/^sessionID=/.test(queryComponents[i])) {
					queryComponents.splice(i, 1);
				}
			}
			queryComponents.push("sessionID=" + sessionID);
			location.replace(location.pathname + "?" + queryComponents.join("&"));
		}
		return resolvedPromise;
	}
	// Process messages in order
	const messageId = message.messageID;
	if (messageId > incomingMessageId) {
		// Message was received out of order, queue it for later
		reorderedMessages[messageId] = message;
		return resolvedPromise;
	}
	if (messageId < incomingMessageId) {
		return resolvedPromise;
	}
	incomingMessageId++;
	// Read each event and dispatch the appropriate event in order
	const promise = processEvents(message.events).then(() => {
		const reorderedMessage = reorderedMessages[incomingMessageId];
		if (reorderedMessage) {
			delete reorderedMessages[incomingMessageId];
			return processMessage(reorderedMessage);
		}
	});
	if (message.close && (++serverDisconnectCount) == 2) {
		console.log("Disconnecting upon request from server!");
		willSynchronizeChannels = true;
		return promise.then(disconnect);
	} else {
		serverDisconnectCount = 0;
	}
	if (willSynchronizeChannels) {
		return promise;
	}
	willSynchronizeChannels = true;
	return promise.then(synchronizeChannels);
}

// URI-encode allowing common URL characters to go through without percent escapes
function cheesyEncodeURIComponent(text: string) {
	return encodeURIComponent(text).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",").replace(/%20/g, "+");
}

// Create a query string out of a client-to-server message
function serializeMessageAsQueryString(message: Partial<ClientMessage>): string {
	let result = "sessionID=" + sessionID;
	if (clientID) {
		result += "&clientID=" + clientID;
	}
	if ("messageID" in message) {
		result += "&messageID=" + message.messageID;
	}
	if ("events" in message) {
		result += "&events=" + cheesyEncodeURIComponent(JSON.stringify(message.events).slice(1, -1));
	}
	if (message.destroy) {
		result += "&destroy=1";
	}
	return result;
}

// Send a POST request containing a client-to-server message and process any response
function sendFormMessage(message: Partial<ClientMessage>) {
	// Form post over XMLHttpRequest is used when WebSockets are unavailable or fail
	activeConnectionCount++;
	const request = new XMLHttpRequest();
	request.open("POST", serverURL, true);
	request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
	request.onreadystatechange = () => {
		if (request.readyState == 4) {
			activeConnectionCount--;
			if (request.status == 200) {
				processMessage(deserializeMessageFromText<ServerMessage>(request.responseText, 0));
			} else {
				disconnect();
			}
		}
	};
	request.send(serializeMessageAsQueryString(message));
}

let lastWebSocketMessageId = 0;

// Send pending messages using whichever protocol is deemed best
function sendMessages(attemptWebSockets?: boolean) {
	if (dead) {
		return;
	}
	if (heartbeatTimeout) {
		restartHeartbeat();
	}
	const existingSocket = websocket;
	if (existingSocket) {
		if (!queuedLocalEvents.length) {
			return;
		}
		const message = produceMessage();
		if (lastWebSocketMessageId == message.messageID) {
			delete message.messageID;
		}
		lastWebSocketMessageId = outgoingMessageId;
		if (existingSocket.readyState == 1) {
			// Send on open socket
			existingSocket.send(serializeMessageAsText(message));
		} else {
			// Coordinate with existing WebSocket that's in the process of being opened,
			// falling back to a form POST if necessary
			const existingSocketOpened = () => {
				existingSocket.removeEventListener("open", existingSocketOpened, false);
				existingSocket.removeEventListener("error", existingSocketErrored, false);
				existingSocket.send(serializeMessageAsText(message));
			};
			const existingSocketErrored = () => {
				existingSocket.removeEventListener("open", existingSocketOpened, false);
				existingSocket.removeEventListener("error", existingSocketErrored, false);
				sendFormMessage(message);
			};
			existingSocket.addEventListener("open", existingSocketOpened, false);
			existingSocket.addEventListener("error", existingSocketErrored, false);
		}
	} else {
		// Message will be sent in query string of new connection
		const message = produceMessage();
		lastWebSocketMessageId = outgoingMessageId;
		if (attemptWebSockets && WebSocketClass) {
			try {
				const newSocket = new WebSocketClass(socketURL + serializeMessageAsQueryString(message));
				// Attempt to open a WebSocket for channels, but not heartbeats
				const newSocketOpened = () => {
					newSocket.removeEventListener("open", newSocketOpened, false);
					newSocket.removeEventListener("error", newSocketErrored, false);
				};
				const newSocketErrored = () => {
					// WebSocket failed, fallback using form POSTs
					newSocketOpened();
					WebSocketClass = undefined;
					websocket = undefined;
					sendFormMessage(message);
				};
				newSocket.addEventListener("open", newSocketOpened, false);
				newSocket.addEventListener("error", newSocketErrored, false);
				let lastIncomingMessageId = -1;
				newSocket.addEventListener("message", (event: any) => {
					const incomingSocketMessage = deserializeMessageFromText<ServerMessage>(event.data, lastIncomingMessageId + 1);
					lastIncomingMessageId = incomingSocketMessage.messageID;
					if (incomingSocketMessage.close) {
						// Disconnect with orderly shutdown from server
						websocket = undefined;
						newSocket.close();
					}
					processMessage(incomingSocketMessage);
				}, false);
				websocket = newSocket;
				return;
			} catch (e) {
				WebSocketClass = undefined;
			}
		}
		// WebSockets failed fast or were unavailable
		sendFormMessage(message);
	}
}

// Create a server channel
function createRawServerChannel(callback: (event?: Event) => void): Channel {
	if (!insideCallback) {
		throw new Error("Unable to create server channel in this context!");
	}
	// Expect that the server will run some code in parallel that provides data
	pendingChannelCount++;
	let channelId = ++remoteChannelCounter;
	logOrdering("server", "open", channelId);
	pendingChannels[channelId] = function(event?: Event) {
		logOrdering("server", "message", channelId);
		willEnterCallback();
		callback(event);
	};
	flush();
	return {
		channelId,
		close: () => {
			// Cleanup the bookkeeping
			if (pendingChannels[channelId]) {
				logOrdering("server", "close", channelId);
				pendingChannelCount--;
				delete pendingChannels[channelId];
				channelId = -1;
			}
		},
	};
}

// Send a client-side event
function sendEvent(event: Event, batched?: boolean, skipsFencing?: boolean) {
	const channelId = event[0];
	if (pendingChannelCount && !skipsFencing && !dead) {
		// Let server decide on the ordering of events since server-side channels are active
		if (batched) {
			isBatched[channelId] = true;
			++totalBatched;
		}
		event[0] = -channelId;
		fencedLocalEvents.push(event);
	} else {
		// No pending server-side channels, resolve immediately
		const eventClone = event.slice() as Event;
		eventClone[0] = -channelId;
		dispatchEvent(eventClone);
		batched = true;
	}
	// Queue an event to be sent to the server in the next flush
	queuedLocalEvents.push(event);
	if ((!batched || websocket || queuedLocalEvents.length > 9) && !dead) {
		flush();
	}
}

// Synchronize events to the server, even if they would normally be queued
export function flush(): Promise<void> {
	if (dead) {
		return Promise.reject(disconnectedError());
	}
	if (!willSynchronizeChannels) {
		willSynchronizeChannels = true;
		defer().then(synchronizeChannels);
	}
	return resolvedPromise;
}

function validationFailure(value: JsonValue): never {
	disconnect();
	throw new Error("Value from server did not validate to the expected schema: " + JSON.stringify(value));
}

/**
 * Creates a promise where data is provided by the server.
 * @param T Type of data to be fulfilled by the promise.
 * @param fallback Called when disconnected from server and a value is requested. Should be provided when a fallback is possible or a custom error is necessary.
 * @param validator Called to validate that data sent from the server is of the proper type
 */
export function createServerPromise<T extends JsonValue | void>(fallback?: () => Promise<T> | T, validator?: (value: any) => value is T) {
	return new Promise<T>((resolve, reject) => {
		if (dead) {
			if (fallback) {
				resolve(fallback());
			} else {
				reject(disconnectedError());
			}
		} else {
			const channel = createRawServerChannel((event) => {
				channel.close();
				if (event) {
					parseValueEvent(self, event, validator ? (result: JsonValue) => {
						try {
							if (!validator(result)) {
								validationFailure(result);
							}
							return resolve(result as T);
						} catch (e) {
							reject(e);
						}
					} : resolve as (value: JsonValue) => void, reject);
				} else if (fallback) {
					try {
						resolve(fallback());
					} catch (e) {
						reject(e);
					}
				} else {
					reject(disconnectedError());
				}
			});
		}
	});
}

export function synchronize() {
	return createServerPromise<void>();
}

/**
 * Opens a channel where data is provided by the server.
 * @param T Type of callback on which data should be received.
 * @param callback Called on both client and server when a value is sent across the channel.
 * @param onAbort Called when the channel is aborted because the connection to the server was lost.
 * @param onClose Called when the channel is closed
 * @param validator Called to validate that data sent from the server is of the proper type.
 */
export function createServerChannel<T extends (...args: any[]) => void>(callback: T, onAbort?: () => void, validator?: (value: any[]) => boolean): Channel {
	if (!("call" in callback)) {
		throw new TypeError("callback is not a function!");
	}
	if (dead) {
		throw disconnectedError();
	}
	const channel = createRawServerChannel((event) => {
		if (event) {
			const args = event.slice(1);
			if (validator && !validator(event)) {
				validationFailure(args);
			}
			callback.apply(null, args);
		} else {
			channel.close();
			if (onAbort) {
				onAbort();
			}
		}
	});
	return channel;
}

/**
 * Creates a promise where data is provided by the client.
 * @param T Type of data to be fulfilled by the promise.
 * @param ask Called to generate a value. Not called when the value is deserialized from an archived session.
 * @param batched Controls whether or not the value is batched with respect to other events.
 */
export function createClientPromise<T extends JsonValue | void>(ask: () => (Promise<T> | T), batched?: boolean): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (!insideCallback) {
			return runAPIImplementation(ask);
		}
		const channelId = ++localChannelCounter;
		logOrdering("client", "open", channelId);
		pendingLocalChannels[channelId] = function(event: Event) {
			if (event) {
				delete pendingLocalChannels[channelId];
				willEnterCallback();
				parseValueEvent(self, event, (value) => {
					logOrdering("client", "message", channelId);
					logOrdering("client", "close", channelId);
					resolve(value as T);
				}, (error) => {
					logOrdering("client", "message", channelId);
					logOrdering("client", "close", channelId);
					reject(error);
				});
			}
		};
		if (shouldImplementLocalChannel(channelId)) {
			// Resolve value
			idle().then(() => runAPIImplementation(ask)).then(
				escaping((value: T) => sendEvent(eventForValue(channelId, value), batched)),
			).catch(
				escaping((error: any) => sendEvent(eventForException(channelId, error), batched)),
			);
		}
	});
}

/**
 * Opens a channel where data is provided by the client.
 * @param T Type of callback on which data should be received.
 * @param U Type of temporary state. Received from `onClose` after the channel opens and passed to `onClose` when the channel closes
 * @param onOpen Called when the channel is opened and events on the channel should be produced. May not be called when a session is deserialized and the channel doesn't remain open at the end of the replayed events.
 * @param onClose Called when the channel is closed
 * @param batched Controls whether or not the value is batched with respect to other events.
 * @param shouldFlushMicroTasks Controls whether or not the microtask queue should be flushed.
 */
export function createClientChannel<T extends (...args: any[]) => void, U = void>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, batched?: boolean, shouldFlushMicroTasks?: true): Channel {
	if (!("call" in callback)) {
		throw new TypeError("callback is not a function!");
	}
	let state: U | undefined;
	if (!insideCallback) {
		let open = true;
		try {
			const potentialState = runAPIImplementation(() => onOpen(function() {
				if (open) {
					callback.apply(null, slice.call(arguments));
				}
			} as any as T));
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
					try {
						runAPIImplementation(() => onClose && onClose(state as U));
					} catch (e) {
						escape(e);
					}
				}
			},
		};
	}
	let channelId: number = ++localChannelCounter;
	pendingLocalChannels[channelId] = function(event: Event) {
		if (channelId >= 0) {
			logOrdering("client", "message", channelId);
			willEnterCallback();
			callback.apply(null, event.slice(1));
			if (shouldFlushMicroTasks) {
				flushMicroTasks();
			}
		}
	};
	try {
		if (shouldImplementLocalChannel(channelId)) {
			const potentialState = runAPIImplementation(() => onOpen(function() {
				if (channelId >= 0) {
					const message = roundTrip(slice.call(arguments));
					message.unshift(channelId);
					idle().then(escaping(sendEvent.bind(null, message, batched)));
				}
			} as any as T));
			if (onClose) {
				state = potentialState;
			}
		} else {
			onClose = undefined;
		}
	} catch (e) {
		onClose = undefined;
		escape(e);
	}
	logOrdering("client", "open", channelId);
	return {
		channelId,
		close() {
			if (channelId >= 0) {
				delete pendingLocalChannels[channelId];
				logOrdering("client", "close", channelId);
				channelId = -1;
				try {
					runAPIImplementation(() => onClose && onClose(state as U));
				} catch (e) {
					escape(e);
				}
			}
		},
	};
}

/**
 * Coordinate a value that can be generated either on the client or the server.
 * If value is not provided by another peer or deserialized from an archived session, generator will be called
 * @param T Type of data to be coordinated between client and server.
 * @param generator Called to generate a value. Not called when the value is provided by another peer or deserialized from an archived session
 * @param validator Called to validate a value. Called when the value is provided by another peer or deserialized from an archived session
 */
export function coordinateValue<T extends JsonValue | void>(generator: () => T, validator: (value: any) => value is T): T {
	if (!dispatchingEvent || dead) {
		return generator();
	}
	const events = currentEvents;
	if (hadOpenServerChannel) {
		const channelId = ++remoteChannelCounter;
		logOrdering("server", "open", channelId);
		// Peek at incoming events to find the value generated on the server
		if (events) {
			for (let i = 0; i < events.length; i++) {
				const event = events[i] as Event;
				if (event[0] == channelId) {
					pendingChannels[channelId] = emptyFunction;
					return parseValueEvent(self, event, (value) => {
						logOrdering("server", "message", channelId);
						logOrdering("server", "close", channelId);
						return value;
					}, (error) => {
						logOrdering("server", "message", channelId);
						logOrdering("server", "close", channelId);
						throw error;
					}) as T;
				}
			}
		}
		{
			console.log("Expected a value from the server, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
			const value = generator();
			logOrdering("server", "message", channelId);
			logOrdering("server", "close", channelId);
			return roundTrip(value);
		}
	} else {
		const channelId = ++localChannelCounter;
		logOrdering("client", "open", channelId);
		if (events) {
			for (let i = 0; i < events.length; i++) {
				const event = events[i] as Event;
				if (event[0] == -channelId) {
					pendingLocalChannels[channelId] = emptyFunction;
					return parseValueEvent(self, event, (value) => {
						logOrdering("client", "message", channelId);
						logOrdering("client", "close", channelId);
						if (!validator(value)) {
							validationFailure(value);
						}
						return value;
					}, (error) => {
						logOrdering("client", "message", channelId);
						logOrdering("client", "close", channelId);
						throw error;
					}) as T;
				}
			}
		}
		try {
			const value = generator();
			const event = eventForValue(channelId, value);
			try {
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				sendEvent(event, true, true);
			} catch (e) {
				escape(e);
			}
			return roundTrip(value);
		} catch (e) {
			try {
				logOrdering("client", "message", channelId);
				logOrdering("client", "close", channelId);
				sendEvent(eventForException(channelId, e), true, true);
			} catch (e) {
				escape(e);
			}
			throw roundTripException(self, e);
		}
	}
}

// Promise implementation that properly schedules as a micro-task, for use when the browser doesn't have promises or has a non-compliant implementation
function bundledPromiseImplementation() {

	const enum PromiseState {
		Pending = 0,
		Fulfilled = 1,
		Rejected = 2,
	}

	function settlePromise<T>(this: Promise<T>, state: PromiseState, value: any) {
		if (!this.__state) {
			if (value instanceof Promise) {
				if (value.__state) {
					if (state === PromiseState.Fulfilled) {
						state = value.__state;
					}
					value = value.__value;
				} else {
					(value.__observers || (value.__observers = [])).push(settlePromise.bind(this, state, value));
					return;
				}
			} else if (isPromiseLike(value)) {
				value.then(settlePromise.bind(this, state), settlePromise.bind(this, PromiseState.Rejected));
				return;
			}
			this.__state = state;
			this.__value = value;
			const observers = this.__observers;
			if (observers) {
				this.__observers = undefined;
				for (let i = 0; i < observers.length; i++) {
					submitTask(microTaskQueue, observers[i]);
				}
			}
		}
	}

	class Promise <T> {
		/* tslint:disable variable-name */
		public __state: PromiseState = PromiseState.Pending;
		/* tslint:disable variable-name */
		public __value: any;
		/* tslint:disable variable-name */
		public __observers?: Task[];
		constructor(resolver: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void) {
			if (resolver !== emptyFunction) {
				if (typeof resolver !== "function") {
					throw new TypeError(`Promise resolver ${resolver} is not a function`);
				}
				try {
					resolver(settlePromise.bind(this, PromiseState.Fulfilled), settlePromise.bind(this, PromiseState.Rejected));
				} catch (e) {
					this.__state = PromiseState.Rejected;
					this.__value = e;
				}
			}
		}
		public then<TResult1 = T, TResult2 = never>(onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2> {
			return new Promise<TResult1 | TResult2>((resolve, reject) => {
				const completed = () => {
					try {
						const value = this.__value;
						if (this.__state == PromiseState.Fulfilled) {
							resolve(onFulfilled ? onFulfilled(value) : value);
						} else if (onRejected) {
							resolve(onRejected(value));
						} else {
							reject(value);
						}
					} catch (e) {
						reject(e);
					}
				};
				if (this.__state) {
					submitTask(microTaskQueue, completed);
				} else {
					(this.__observers || (this.__observers = [])).push(completed);
				}
			});
		}
		public catch<TResult = never>(onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult> {
			return this.then(undefined, onRejected);
		}
		public finally(onFinally: () => void): Promise<T> {
			return this.then(
				(value) => Promise.resolve(onFinally()).then(() => value),
				(error) => Promise.resolve(onFinally()).then(() => {
					throw error;
				}),
			);
		}
		public static resolve<T>(value: Promise<T> | T): Promise<T>;
		public static resolve(): Promise<void>;
		public static resolve<T>(value?: Promise<T> | T): Promise<T> {
			if (isPromiseLike(value)) {
				return new Promise<T>((resolve, reject) => value.then(resolve, reject));
			}
			const result = new Promise<T>(emptyFunction);
			result.__value = value;
			result.__state = PromiseState.Fulfilled;
			return result;
		}
		public static reject<T = never>(reason: any): Promise<T> {
			const result = new Promise<T>(emptyFunction);
			result.__value = reason;
			result.__state = PromiseState.Rejected;
			return result;
		}
		public static race<T>(values: ReadonlyArray<Promise<T> | T>): Promise<T> {
			for (let i = 0; i < values.length; i++) {
				const value = values[i];
				if (!isPromiseLike(value)) {
					const result = new Promise<T>(emptyFunction);
					result.__value = value;
					result.__state = PromiseState.Fulfilled;
					return result;
				} else if (value instanceof Promise && value.__state) {
					const result = new Promise<T>(emptyFunction);
					result.__value = value.__value;
					result.__state = value.__state;
					return result;
				}
			}
			return new Promise<T>((resolve, reject) => {
				for (let i = 0; i < values.length; i++) {
					(values[i] as Promise<T>).then(resolve, reject);
				}
			});
		}
		public static all<T>(values: ReadonlyArray<Promise<T> | T>): Promise<T[]> {
			let remaining = values.length;
			if (!remaining) {
				return Promise.resolve([]);
			}
			const result = new Array(remaining);
			return new Promise<T[]>((resolve, reject) => {
				for (let i = 0; i < remaining; i++) {
					const value = values[i];
					if (isPromiseLike(value)) {
						value.then((resolvedValue) => {
							result[i] = resolvedValue;
							if ((--remaining) == 0) {
								resolve(result);
							}
						}, reject);
					} else {
						result[i] = value;
						if ((--remaining) == 0) {
							resolve(result);
						}
					}
				}
			});
		}
	}

	return Promise;
}

interceptGlobals(window, () => insideCallback && !dead, coordinateValue, <T extends (...args: any[]) => void, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean) => {
	let recovered: (() => void) | undefined;
	const channel = createServerChannel(callback, () => {
		const state = onOpen(callback);
		recovered = () => {
			if (onClose) {
				onClose(state);
			}
		};
	});
	return {
		close: () => {
			if (recovered) {
				recovered();
			} else {
				channel.close();
			}
		},
	};
});

// ES2017-compliant module loader with support for dynamic imports and CSS modules
type ImportFunction = (moduleName: string | Promise<any>) => Promise<any>;
declare global {
	let _import: ImportFunction;
	let exports: any;
}

const modules: { [name: string]: any } = {};
const moduleResolve: { [name: string]: [(value: any) => void, boolean] } = {};

const moduleMappings: { [name: string]: [string, string] } = _import as any;
_import = (moduleNameOrPromise: string | Promise<any>) => {
	if (typeof moduleNameOrPromise == "object") {
		loadingModules++;
		function finished() {
			loadingModules--;
		}
		return moduleNameOrPromise.then(finished, finished);
	}
	const moduleName = moduleNameOrPromise;
	if (Object.hasOwnProperty.call(modules, moduleName)) {
		return Promise.resolve(modules[moduleName]);
	}
	return modules[moduleName] = new Promise((resolve, reject) => {
		function onError() {
			delete moduleResolve[moduleName];
			disconnect();
			reject(new Error("Unable to load bundle!"));
		}
		const mapping = moduleMappings[moduleName];
		let integrity: string | undefined;
		let src = moduleName;
		if (mapping) {
			src = mapping[0];
			integrity = mapping[1];
		}
		let element;
		if (/\.css$/.test(src)) {
			element = document.createElement("link");
			element.rel = "stylesheet";
			element.href = src;
			if ("onload" in element) {
				const wasInsideCallback = insideCallback;
				element.onload = () => {
					if (wasInsideCallback) {
						willEnterCallback();
						loadingModules--;
					}
					resolve();
				};
			} else {
				resolve();
			}
		} else {
			element = document.createElement("script");
			element.src = src;
			moduleResolve[moduleName] = [resolve, insideCallback];
		}
		element.onerror = onError;
		if (integrity) {
			element.setAttribute("integrity", integrity);
		}
		document.head.appendChild(element);
		if (insideCallback) {
			loadingModules++;
		}
	});
};

(window as any)._mobius = function(moduleContents: (exports: { [name: string]: any }, _import: ImportFunction, mainModule: typeof exports) => void, moduleName: string, ...dependencies: string[]) {
	const resolve = moduleResolve[moduleName];
	if (resolve) {
		delete moduleResolve[moduleName];
		const promisedDependencies: Array<Promise<any>> = [];
		if (resolve[1]) {
			willEnterCallback();
		}
		for (let i = 2; i < arguments.length; i++) {
			promisedDependencies.push(_import(arguments[i]));
		}
		resolve[0](Promise.all(promisedDependencies).then((resolvedDependencies) => {
			if (resolve[1]) {
				willEnterCallback();
				loadingModules--;
			}
			const moduleExports: { [name: string]: any } = {};
			const result = moduleContents.apply(null, [moduleExports, _import, exports].concat(resolvedDependencies));
			if (typeof result !== "undefined") {
				moduleExports.default = result;
			}
			return moduleExports;
		}));
	}
};

// Update body class so that page can be styled appropriately
document.body.className = "notranslate mobius-active mobius-full";
