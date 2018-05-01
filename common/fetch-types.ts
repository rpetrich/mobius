/* mobius:shared */
import { JsonMap } from "mobius-types";

export interface FetchOptions {
	method?: string;
	headers?: { [name: string]: string };
	body?: string;
	redirect?: "follow" | "error" | "manual";
}

export interface FetchResponse extends JsonMap {
	type: "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
	url: string;
	status: number;
	ok: boolean;
	statusText: string;
	text: string;
	headers: { [name: string]: string };
}

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
