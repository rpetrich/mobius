/* mobius:shared */
import { JsonMap } from "mobius-types";

/**
 * Detailed options of HTTP fetch operation
 */
export interface FetchOptions {
	/** HTTP method type to fetch using */
	method?: string;
	/** Custom request headers to send with the request */
	headers?: { [name: string]: string };
	/** PUT or POST body to send with the request */
	body?: string;
	/** Redirect behaviour customization */
	redirect?: "follow" | "error" | "manual";
}

/**
 * Representation of an HTTP response
 */
export interface FetchResponse extends JsonMap {
	/** Respone type */
	type: "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
	/** Response URL after all redirects have been followed */
	url: string;
	/** HTTP status code of response */
	status: number;
	/** true iff status code >= 200 && < 300 */
	ok: boolean;
	/** HTTP status text */
	statusText: string;
	/** Textual content of response body */
	text: string;
	/** Response headers */
	headers: { [name: string]: string };
}

/**
 * Parses successful responses as JSON, validating via a user-defined or generated validator function
 * ~~~
 * // In ipapi.ts
 * export type IPData {
 *     ip: string;
 *     city: string | null;
 *     region: string | null;
 *     country_name: string | null;
 *     latitude: number | null;
 *     longitude: number | null;
 * }
 * // Elsewhere
 * import { IPData as isIPData } from "./ipapi!validators";
 * async function getIP() {
 *     const data = parse(await fromClient("https://ipapi.co/json/"), isIPData);
 *     return data.ip;
 * }
 * ~~~
 * @param T Type of data to deserialize from the response (usually implied by the validator parameter)
 * @param response Response to interpret as JSON
 * @param validator Validation function that ensures response is a valid T.
 * Tip: use import Foo from "foo-module!validators" to get an automatic validator for foo-module.Foo
 * @returns Returns the parsed value as a T if the response is HTTP 2xx JSON that passes validation.
 */
export function parse<T>(response: FetchResponse, validator: (value: any) => value is T): T {
	if (!response.ok) {
		throw new TypeError(`Response not ok, received HTTP status ${response.status} ${response.statusText}`);
	}
	const parsed = JSON.parse(response.text);
	if (validator(parsed)) {
		return parsed;
	}
	throw new TypeError("Response returned ok, but did not validate successfully");
}
