/**
 * Asynchronous access to query and update the browser's cookie store
 */

/** @ignore */
import * as impl from "cookie-impl";

let cache: {[key: string]: string} | undefined;

/**
 * Sets a cookie on all connected peers
 * ~~~
 * set("authToken", "1234");
 * ~~~
 * @param key Name of the cookie to set
 * @param value Value of the cookie to set
 */
export function set(key: string, value: string) {
	if (cache) {
		cache[key] = value;
	}
	return impl.set(key, value);
}

/**
 * Reads all cookies from any connected peer
 * ~~~
 * console.log(await all());
 * ~~~
 */
export async function all() {
	return cache || (cache = await impl.all());
}

/**
 * Reads a specific cookie from any connected peer
 * ~~~
 * const authTokenCookie = await get("authToken");
 * console.log(authTokenCookie);
 * ~~~
 */
export async function get(key: string): Promise<string | undefined> {
	const result = await all();
	return Object.hasOwnProperty.call(result, key) ? result[key] : undefined;
}
