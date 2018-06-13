import { createServerChannel, _share } from "mobius";

/**
 * Allows multiple peers to join the session
 * ~~~
 * share().then(url => {
 *     console.log("Copy and paste this into a new browser: " + url);
 * });
 * ~~~
 * @returns a URL containing the URL that peers can use to join the session.
 */
export function share(): Promise<string> {
	return _share();
}

export function observe(callback: (clientId: number, joined: boolean) => void) {
	return createServerChannel(callback);
}
