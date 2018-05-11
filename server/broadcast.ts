/**
 * Publish-subscribe mechanism for communication between sessions
 */

import { createServerChannel, createServerPromise } from "mobius";
import { Channel, JsonValue } from "mobius-types";
import { peek, redact, Redacted } from "redact";

import { addListener, removeListener, send as sendImplementation } from "broadcast-impl";

/**
 * Represents a topic on which messages can be sent or received
 */
export type Topic<T> = Redacted<string> & { kind: "Topic", of: T };

/**
 * Creates a topic where messages can be sent or received
 * ~~~
 * const bullhorn = topic<string>("bullhorn");
 * ~~~
 * @param name Name of the topic
 */
export function topic<T extends JsonValue>(name: string): Topic<T> {
	return redact(name) as Topic<T>;
}

/**
 * Send a message across a particular topic so it can be received by other sessions observing the same topic
 * ~~~
 * const bullhorn = topic<string>("bullhorn");
 * send(bullhorn, "bark");
 * ~~~
 * @param T Type of message to send
 * @param dest Topic on which to send messages
 * @param message Message to send to the topic
 */
export function send<T extends JsonValue>(dest: Topic<T>, message: T | Redacted<T>): Promise<void> {
	return createServerPromise<void>(() => {
		sendImplementation(peek(dest as any), peek(message));
	});
}

/**
 * Registers a channel to receive messages sent to a partiular topic name
 * ~~~
 * const bullhorn = topic<string>("bullhorn");
 * function isString(value: any): value is string {
 *     return typeof value === "string";
 * }
 * receive(bullhorn, (message: string) => console.log(`Received ${message} on the bullhorn!`), isString);
 * ~~~
 * @param T Type of message to receive
 * @param source Topic from which to receive messages
 * @param callback Called for each message received
 * @param validator Called to validate that received messages are of the proper type
 * @param onAbort Called on the client when server has disconnected
 */
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
