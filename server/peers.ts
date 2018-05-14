/**
 * Session sharing and peer inspection facilities
 */

/** @ignore */
import { createServerChannel } from "mobius";
import { addListener, getClientIds, removeListener } from "peers-impl";
export { share } from "peers-impl";

/**
 * Observe when peers join or disconnect to the shared session.
 * ~~~
 * observe((clientId, joined) => {
 *     console.log(`Client ${clientId} ${joined ? "joined" : "left"}!`));
 * }
 * ~~~
 * @param callback Called when a peer joins or leaves the session
 */
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
