/** @ignore */
/** Internal machinery for serialization */
/** @mobius:shared */

import { JsonMap, JsonValue } from "mobius-types";

export const clientOrdersAllEventsByDefault = true;

export const enum ReloadType {
	NewSession = 1,
	KeepSession = 2,
}

function classNameForConstructor(constructor: any): string {
	const name = constructor.name as string | undefined;
	// Support ES5 by falling back to parsing toString
	return name || Object.toString.call(constructor).match(/.*? (\w+)/)[1];
}

function throwError(message: string) {
	throw new Error(message);
}

export function validationError(value: any) {
	return new Error("Value from network did not validate to the expected schema: " + JSON.stringify(value));
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
	for (const i in obj) {
		if (Object.hasOwnProperty.call(obj, i) && obj[i] !== (defaults as T)[i]) {
			result[i] = obj[i];
		}
	}
	return result;
}

export function restoreDefaults<T extends JsonMap, U extends JsonMap>(obj: T, defaults: U): T | U {
	const result = {} as T | U;
	for (const i in defaults) {
		if (!(i in obj) && Object.hasOwnProperty.call(defaults, i)) {
			result[i] = defaults[i];
		}
	}
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
	reload?: number;
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

export function eventForException(channelId: number, error: any, suppressStacks?: boolean): Event {
	// Convert Error types to a representation that can be reconstituted remotely
	if (error instanceof Error) {
		let serializedError: { [key: string]: JsonValue } = {};
		const errorClass: any = error.constructor;
		const type = classNameForConstructor(errorClass);
		serializedError = { message: roundTrip(error.message) };
		const anyError: any = error;
		for (const i in anyError) {
			if ((i === "stack") ? (!suppressStacks) : Object.hasOwnProperty.call(anyError, i)) {
				serializedError[i] = roundTrip(anyError[i]);
			}
		}
		return [channelId, serializedError, type];
	} else {
		return [channelId, roundTrip(error), 1];
	}
}

export function suppressStack(value: any) {
	delete value.stack;
	// stack may be on prototype, set it to null instead
	if (value.stack) {
		value.stack = null;
	}
}

export function roundTripException(global: any, error: any): any {
	// Don't bother implementing a fast path
	const event = eventForException(0, error);
	return parseError(global, event[1], event[2]);
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
	const value = event[1];
	if (event.length != 3) {
		return resolve(roundTrip(value));
	}
	return reject(parseError(global, value, event[2]));
}

function parseError(global: any, value: any, type: number | string) {
	// Convert serialized representation into the appropriate Error type
	if (typeof type === "string" && /Error$/.test(type)) {
		const ErrorType: typeof Error = (global as any)[type] || Error;
		const error: Error = new ErrorType(roundTrip(value.message));
		for (const i in value) {
			if (Object.hasOwnProperty.call(value, i) && i != "message") {
				(error as any)[i] = roundTrip(value[i]);
			}
		}
		return error;
	}
	return roundTrip(value);
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
