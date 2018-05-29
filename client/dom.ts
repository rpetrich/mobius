/**
 * Virtualized access to the browser's DOM
 */

import { defaultEventProperties } from "dom-types";
import { restoreDefaults, stripDefaults } from "internal-impl";
import { clientID, createClientChannel, registeredListeners } from "mobius";
import { Channel } from "mobius-types";
import * as preact from "preact";
export { h, Component, ComponentFactory, ComponentProps, FunctionalComponent } from "preact";

type PreactNode = Node & {
	_listeners?: { [ event: string ]: (event: any, clientID?: number) => void },
	__l?: { [ event: string ]: (event: any, clientID?: number) => void },
	__c?: { [ event: string ]: [(event: any, clientID?: number) => void, (event: any, clientID?: number) => void, Channel] },
};

const preactOptions = preact.options as any;
preactOptions.nodeRemoved = (node: PreactNode) => {
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

preactOptions.listenerUpdated = (node: PreactNode, name: string) => {
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
					callback(restoreDefaults(event, defaultEventProperties), clientID);
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

/**
 * Retrieves the DOM element associated with a component.
 * Only available on the client in modules inside `client/` paths
 * @param P Props type of the component (usually inferred)
 * @param S State type of the component (usually inferred)
 * @param component Component for which to retrieve the DOM element
 */
export function ref<P, S>(component: preact.Component<P, S>): Element | null {
	return (component as any).base as Element | null;
}
