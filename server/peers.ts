import { createServerChannel } from "mobius";
import { addListener, getClientIds, removeListener } from "peers-impl";
export { share } from "peers-impl";

export function observe(callback: (clientId: number, joined: boolean) => void) {
	return createServerChannel(callback, (send) => {
		getClientIds().then((clients) => {
			for (const client of clients) {
				send(client, true);
			}
		});
		addListener(send);
		return send;
	}, removeListener, false);
}
