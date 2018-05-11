import { createServerChannel, createServerPromise } from "mobius";

function emptyFunction() {
	/* tslint:disable no-empty */
}

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
	return createServerPromise<string>().then((value) => {
		// Dummy channel that stays open
		createServerChannel(emptyFunction);
		return value;
	});
}

export function observe(callback: (clientId: number, joined: boolean) => void) {
	return createServerChannel(callback);
}
