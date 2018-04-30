/* mobius:shared */
import { JsonMap, JsonValue } from "mobius-types";

function classNameForConstructor(constructor: any): string {
	const name = constructor.name as string | undefined;
	// Support ES5 by falling back to parsing toString
	return name || Object.toString.call(constructor).match(/.*? (\w+)/)[1];
}

function throwError(message: string) {
	throw new Error(message);
}

function roundTripValue(obj: any, cycleDetection: any[]): any {
	// Round-trip values through JSON so that the client receives exactly the same type of values as the server
	// return typeof obj == "undefined" ? obj : JSON.parse(JSON.stringify(obj)) as T;
	switch (typeof obj) {
		default:
			if (obj !== null) {
				if (cycleDetection.indexOf(obj) != -1) {
					throwError("Cycles do not round-trip!");
				}
				cycleDetection.push(obj);
				let result: any;
				const constructor = obj.constructor;
				switch (constructor) {
					case undefined:
					case Object:
						result = {};
						ignore_nondeterminism:
						for (const key in obj) {
							if (Object.hasOwnProperty.call(obj, key)) {
								result[key] = roundTripValue(obj[key], cycleDetection);
							}
						}
						break;
					case Array:
						result = [];
						for (let i = 0; i < obj.length; i++) {
							result[i] = roundTripValue(obj[i], cycleDetection);
						}
						break;
					default:
						throwError(classNameForConstructor(constructor) + " does not round-trip!");
				}
				cycleDetection.pop();
				return result;
			}
			// fallthrough
		case "boolean":
		case "string":
			return obj;
		case "number":
			switch (obj) {
				case Infinity:
				case -Infinity:
					throwError(obj + " does not round-trip!");
				case 0:
					if (1 / obj < 0) {
						throwError("-0 does not round-trip!");
					}
				case obj:
					return obj;
				default:
					throwError(obj + " does not round-trip!");
			}
		case "undefined":
			throwError(obj + " does not round-trip!");
	}
}

export function roundTrip<T extends JsonValue | void>(obj: T): T {
	return typeof obj == "undefined" ? obj : roundTripValue(obj, []) as T;
}

export function stripDefaults<T extends JsonMap>(obj: T, defaults: Partial<T>): Partial<T> {
	const result: Partial<T> = {};
	ignore_nondeterminism:
	for (const i in obj) {
		if (Object.hasOwnProperty.call(obj, i) && obj[i] !== (defaults as T)[i]) {
			result[i] = obj[i];
		}
	}
	return result;
}

export function restoreDefaults<T extends JsonMap, U extends JsonMap>(obj: T, defaults: U): T | U {
	const result = {} as T | U;
	ignore_nondeterminism:
	for (const i in defaults) {
		if (!(i in obj) && Object.hasOwnProperty.call(defaults, i)) {
			result[i] = defaults[i];
		}
	}
	ignore_nondeterminism:
	for (const j in obj) {
		if (Object.hasOwnProperty.call(obj, j)) {
			result[j] = obj[j];
		}
	}
	return result;
}

export type Event = [number] | [number, any] | [number, any, any];

export interface Message {
	events: Event[];
	messageID: number;
	close?: true;
}

export interface ServerMessage extends Message {
	reload?: true;
}

export interface ClientMessage extends Message {
	sessionID?: string;
	clientID?: number;
	destroy?: true;
	noJavaScript?: true;
}

export interface BootstrapData {
	sessionID: string;
	clientID?: number;
	events?: Array<Event | boolean>;
	channels?: number[];
	x?: number;
	y?: number;
	connect?: true;
}

export function logOrdering(from: "client" | "server", type: "open" | "close" | "message", channelId: number, sessionID?: string) {
	// const stack = (new Error().stack || "").toString().split(/\n\s*/).slice(2).map(s => s.replace(/^at\s*/, ""));
	// console.log(from + " " + type + " " + channelId + (sessionID ? " " + sessionID : ""), stack);
}

export function disconnectedError() {
	return new Error("Session has been disconnected!");
}

export function eventForValue(channelId: number, value: JsonValue | void): Event {
	return typeof value == "undefined" ? [channelId] : [channelId, roundTrip(value)];
}

export function eventForException(channelId: number, error: any): Event {
	// Convert Error types to a representation that can be reconstituted remotely
	let type: any = 1;
	let serializedError: { [key: string]: JsonValue } = {};
	if (error instanceof Error) {
		const errorClass: any = error.constructor;
		type = classNameForConstructor(errorClass);
		serializedError = { message: roundTrip(error.message) };
		const anyError: any = error;
		ignore_nondeterminism:
		for (const i in anyError) {
			if (Object.hasOwnProperty.call(anyError, i)) {
				serializedError[i] = roundTrip(anyError[i]);
			}
		}
	}
	return [channelId, serializedError, type];
}

export function passthroughValue<T>(value: T): T {
	return value;
}

export function throwValue(value: any): never {
	throw value;
}

export function parseValueEvent<T>(global: any, event: Event | undefined, resolve: (value: JsonValue) => T, reject: (error: Error | JsonValue) => T): T {
	if (!event) {
		return reject(disconnectedError());
	}
	const value = roundTrip(event[1]);
	if (event.length != 3) {
		return resolve(value);
	}
	const type = event[2];
	// Convert serialized representation into the appropriate Error type
	if (type != 1 && /Error$/.test(type)) {
		const ErrorType: typeof Error = global[type] || Error;
		const error: Error = new ErrorType(value.message);
		ignore_nondeterminism:
		for (const i in value) {
			if (Object.hasOwnProperty.call(value, i) && i != "message") {
				(error as any)[i] = roundTrip(value[i]);
			}
		}
		return reject(error);
	}
	return reject(value);
}

export function deserializeMessageFromText<T extends Message>(messageText: string, defaultMessageID: number): T {
	const result = ((messageText.length == 0 || messageText[0] == "[") ? { events: JSON.parse("[" + messageText + "]") } : JSON.parse(messageText)) as T;
	result.messageID = result.messageID | defaultMessageID;
	if (!result.events) {
		result.events = [];
	}
	return result;
}

export function serializeMessageAsText(message: Partial<ServerMessage | ClientMessage>): string {
	if ("events" in message && !("messageID" in message) && !("close" in message) && !("destroy" in message) && !("clientID" in message) && !("reload" in message)) {
		// Only send events, if that's all we have to send
		return JSON.stringify(message.events).slice(1, -1);
	}
	return JSON.stringify(message);
}
