import { createServerChannel } from "mobius";

export function observe(callback: (clientId: number, joined: boolean) => void) {
	return createServerChannel(callback);
}
