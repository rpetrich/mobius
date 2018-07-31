import { createServerChannel, createServerPromise } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { redact, Redacted } from "redact";

export type Topic<T> = Redacted<string> & { kind: "Topic", of: T };
export function topic<T extends JsonValue>(name: string): Topic<T> {
	return redact(name) as Topic<T>;
}

export function send<T extends JsonValue>(dest: Topic<T>, message: T | Redacted<T>): Promise<void> {
	return createServerPromise<void>();
}

export function receive<T extends JsonValue>(source: Topic<T>, callback: (message: T) => void, validator?: (message: unknown) => message is T, onAbort?: () => void): Channel {
	return createServerChannel(callback, onAbort);
}
