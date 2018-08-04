/**
 * Core for event coordination and client/server synchronization
 */

/** @ignore */
import { Channel, JsonValue } from "mobius-types";

/**
 * Represents whether or not the session has disconnected, either by calls to [[disconnect]] or if the client no longer has network connectivity to the server
 */
export let dead: boolean;
/**
 * Terminate's a sessions connectivity with the server. Any future API calls that require crossing the network boundary will fail
 * ~~~
 * disconnect();
 * ~~~
 */
export function disconnect(): void;
/**
 * Flushes any pending client-side events to the server
 * ~~~
 * flush();
 * ~~~
 */
export function flush(): Promise<void>;
/**
 * Synchronizes with the server, ensuring any values generated for [[Date]] or [[Math.random]] are provided by the server
 * ~~~
 * synchronize().then(() => {
 *     console.log("Safe random value generated from the server: " + Math.random()));
 * }
 * ~~~
 */
export function synchronize(): Promise<void>;

/**
 * Creates a promise where data is provided by the client.
 * Only accessible in server context
 * @param T Type of data to be fulfilled by the promise.
 * @param fallback Called when no client is connected and a value is requested of the client. Should be provided when a fallback is possible or a custom error is necessary.
 * @param validator Called to validate that data sent from the client is of the proper type. Since malicious clients could inject any JSON-compatible type, a proper validator function is required to ensure safety.
 * Tip: use import Foo from "foo-module!validators" to get an automatic validator for foo-module.Foo
 * @ignore
 */
export function createClientPromise<T extends JsonValue | void>(validator: (value: unknown) => value is T, fallback?: () => Promise<T> | T): Promise<T>;

/**
 * Creates a promise where data is provided by the server.
 * Only accessible in server context
 * @param T Type of data to be fulfilled by the promise.
 * @param ask Called to generate a value. Not called when the value is deserialized from an archived session.
 * @param includedInPrerender Represents whether or not to delay delivery of preloaded pages until the promise resolves
 * @ignore
 */
export function createServerPromise<T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender?: boolean): Promise<T>;

/**
 * Opens a channel where data is provided by the client.
 * Only accessible in server context
 * @param T Type of callback on which data should be received.
 * @param callback Called on both client and server when a value is sent across the channel.
 * @param validator Called to validate that data sent from the client is of the proper type. Since malicious clients could inject any JSON-compatible type, a proper validator function is required to ensure safety.
 * Tip: use import Foo from "foo-module!validators" to get an automatic validator for foo-module.Foo
 * @ignore
 */
export function createClientChannel<TS extends any[]>(callback: (...args: TS) => void, validator: (args: Array<unknown>) => args is TS): Channel;

/**
 * Opens a channel where data is provided by the server.
 * Only accessible in server context
 * @param T Type of callback on which data should be received.
 * @param U Type of temporary state. Received from `onClose` after the channel opens and passed to `onClose` when the channel closes
 * @param callback Called on both client and server when a value is sent across the channel.
 * @param onOpen Called when the channel is opened and events on the channel should be produced. May not be called when a session is deserialized and the channel doesn't remain open at the end of the replayed events.
 * @param onClose Called when the channel is closed
 * @param includedInPrerender Represents whether or not to delay delivery of preloaded pages until the channel has been closed
 * @ignore
 */
export function createServerChannel<TS extends any[], U = void>(callback: (...args: TS) => void, onOpen: (send: (...args: TS) => void) => U, onClose?: (state: U) => void, includedInPrerender?: boolean): Channel;

/**
 * Coordinate a value that can be generated either on the client or the server.
 * If value is not provided by another peer or deserialized from an archived session, generator will be called
 * @param T Type of data to be coordinated between client and server.
 * @param generator Called to generate a value. Not called when the value is provided by another peer or deserialized from an archived session
 * @param validator Called to validate a value. Called when the value is provided by another peer or deserialized from an archived session
 * @ignore
 */
export function coordinateValue<T extends JsonValue | void>(generator: () => T, validator: (value: unknown) => value is T): T;
