import { createServerChannel, createServerPromise } from "mobius";

function emptyFunction() {
	/* tslint:disable no-empty */
}

// Make the session become shareable and receive the URL on which the session can be joined
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
