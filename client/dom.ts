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

const preactOptions = preact.options as any;
preactOptions.nodeRemoved = (node: PreactElement) => {
	const c = node.__c;
	if (c) {
		for (const name in c) {
			if (Object.hasOwnProperty.call(c, name)) {
				c[name][2].close();
				delete c[name];
			}
		}
	}
};

preactOptions.listenerUpdated = (node: PreactElement, name: string) => {
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
					try {
						const result = callback(restoreDefaults(event, defaultEventProperties), clientID);
						return result && result.then ? result.then(void 0, raiseError) : result;
					} catch (e) {
						raiseError(e);
					}
				}, (send) => {
					sender = send;
				}, undefined, name == "input", true);
				tuple = c[name] = [registeredListeners[channel.channelId] = (event: any) => {
					sender(stripDefaults(event, defaultEventProperties), clientID);
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
};

/**
 * @ignore
 */
export function _host(content: JSX.Element): void {
	const element = document.body.children[0];
	preact.render(content, element, element.children[0]);
}

export function title(newTitle: string): void {
	document.title = newTitle;
}
