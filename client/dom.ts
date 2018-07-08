/**
 * Virtualized access to the browser's DOM
 */

import { defaultEventProperties } from "dom-types";
import { restoreDefaults, stripDefaults } from "internal-impl";
import { clientID, createClientChannel, registeredListeners } from "mobius";
import { Channel } from "mobius-types";
import * as preact from "preact";
export { h, Component, ComponentFactory, Attributes, FunctionalComponent } from "preact";

type PreactElement = Element & {
	_component?: preact.Component<never, never>;
	_listeners?: { [ event: string ]: (event: any, clientID?: number) => void | PromiseLike<void> },
	__l?: { [ event: string ]: (event: any, clientID?: number) => void | PromiseLike<void> },
	__c?: { [ event: string ]: [(event: any, clientID?: number) => void, (event: any, clientID?: number) => void | PromiseLike<void>, Channel] },
};

/**
 * @ignore
 */
export const _rootElement = document.body.children[0];

/**
 * @ignore
 */
export const _preactOptions: preact.RenderOptions = {
	nodeRemoved(node: PreactElement) {
		const c = node.__c;
		if (c) {
			for (const name in c) {
				if (Object.hasOwnProperty.call(c, name)) {
					c[name][2].close();
					delete c[name];
				}
			}
		}
	},
	listenerUpdated(node: PreactElement, name: string) {
		const listeners = node._listeners || node.__l;
		if (listeners) {
			const c = node.__c || (node.__c = {});
			if (Object.hasOwnProperty.call(listeners, name)) {
				const listener = listeners[name];
				let tuple = c[name];
				if (tuple) {
					tuple[1] = listener;
				} else {
					let sender: any;
					const channel = createClientChannel((event: any, clientID?: number) => {
						const callback = tuple[1];
						function raiseError(e: any) {
							let element = node;
							while (element) {
								if (element._component) {
									return element._component.raiseError(e);
								}
								element = element.parentNode as PreactElement;
							}
							throw e;
						}
						defaultEventProperties.type = name;
						if (callback) {
							try {
								const result = callback(restoreDefaults(event, defaultEventProperties), clientID);
								return result && result.then ? result.then(void 0, raiseError) : result;
							} catch (e) {
								raiseError(e);
							}
						}
					}, (send) => {
						sender = send;
					}, undefined, name == "input", true);
					tuple = c[name] = [registeredListeners[channel.channelId] = (event: any) => {
						defaultEventProperties.type = name;
						const prunedEvent = stripDefaults(event, defaultEventProperties);
						// Round to the nearest tenth of a millisecond, since browsers won't resolve greater than that anyway
						prunedEvent.timeStamp = Math.round(prunedEvent.timeStamp * 10) / 10;
						sender(prunedEvent, clientID);
					}, listener, channel];
				}
				listeners[name] = tuple[0];
			} else if (Object.hasOwnProperty.call(c, name)) {
				const channel = c[name][2];
				delete registeredListeners[channel.channelId];
				delete c[name];
				channel.close();
			}
		}
	},
};

export function title(newTitle: string): void {
	document.title = newTitle;
}
