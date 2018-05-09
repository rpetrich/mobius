import { createServerChannel, createServerPromise } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { peek, redact, Redacted } from "redact";

import { addListener, removeListener, send as sendImplementation } from "broadcast-impl";

export type Topic<T> = Redacted<string> & { messageType: T };
export const topic = redact as <T extends JsonValue>(name: string) => Topic<T>;

export function send<T extends JsonValue>(dest: Topic<T>, message: T | Redacted<T>): Promise<void> {
	return createServerPromise<void>(() => {
		sendImplementation(peek(dest as any), peek(message));
	});
}

export function receive<T extends JsonValue>(source: Topic<T>, callback: (message: T) => void, validator?: (message: any) => message is T, onAbort?: () => void): Channel {
	const peekedTopic = peek(source as any as Redacted<string>);
	return createServerChannel(callback, (sendMessage) => {
		const listener = validator ? (value: any) => {
			if (validator(value)) {
				sendMessage(value);
			}
		} : (sendMessage as (message: JsonValue) => void);
		addListener(peekedTopic, listener);
		return listener;
	}, (listener) => removeListener(peekedTopic, listener), false);
}
