/**
 * Abstraction over server-held secrets
 */
/* mobius:shared */
export { Redacted } from "redact-impl";
import { Redacted } from "redact-impl";

const symbol = Symbol();

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
	const result = new Redacted<T>();
	Object.defineProperty(result, symbol, { value });
	return result;
}
