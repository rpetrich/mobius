/**
 * Abstraction over server-held secrets
 */
/* mobius:shared */

const symbol = Symbol();

/**
 * Represents a value that can only be read on the server
 * @param T type of value that is hidden
 */
export class Redacted<T> {
	/* tslint:disable variable-name */
	/** @ignore */
	protected __suppress_declared_never_used_error?: T;
	/** @ignore */
	constructor(value: T) {
		Object.defineProperty(this, symbol, { value });
	}
}

/**
 * Unwrap a redacted value. Only available on the server in modules inside `server/` paths
 * ~~~
 * // In any module
 * const redacted = redact<string>("This string hidden from client!");
 * // Inside a server-side module
 * console.log(peek(redacted));
 * ~~~
 * @param T Type of data contained in the [[Redacted]]
 * @param value The redacted value to unwrap
 */
export function peek<T>(value: T | Redacted<T>) {
	return value instanceof Redacted ? (value as any)[symbol] as T : value;
}

/**
 * Redacts a value so that it's only accessible on the server.
 * ~~~
 * const redacted = redact<string>("This string hidden from client!");
 * ~~~
 * @param T Type of data contained in the [[Redacted]]
 * @param value The value to redact. Required to be pure or will cause compilation to fail. Will be stripped in generated client-side code
 */
export function redact<T>(value: T) {
	return new Redacted<T>(value);
}
