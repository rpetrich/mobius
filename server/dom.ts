import { body, document, head } from "dom-impl";
import { ignoreEvent, nodeRemovedHook, PreactElement, validatorForEventName } from "dom-shared";
import { defaultEventProperties } from "dom-types";
import { restoreDefaults, validationError } from "internal-impl";
import { createClientChannel, disconnect } from "mobius";
import * as preact from "preact";
export { h, Component, ComponentFactory, Attributes, FunctionalComponent } from "preact";

const preactOptions = preact.options as any;
preactOptions.keyAttribute = "data-key";
preactOptions.nodeRemoved = nodeRemovedHook;

preactOptions.listenerUpdated = (node: PreactElement, name: string) => {
	const listeners = node._listeners;
	if (listeners) {
		const c = node.__c || (node.__c = {});
		if (Object.hasOwnProperty.call(listeners, name)) {
			const listener = listeners[name];
			let tuple = c[name];
			if (tuple) {
				tuple[1] = listener;
			} else {
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
					const withDefaults = restoreDefaults(event, defaultEventProperties);
					if (!validatorForEventName(name)) {
						disconnect();
						throw validationError(withDefaults);
					}
					try {
						const result = callback(withDefaults, clientID);
						return result && result.then ? result.then(void 0, raiseError) : result;
					} catch (e) {
						raiseError(e);
					}
				});
				if (node.nodeName == "INPUT" || node.nodeName == "TEXTAREA") {
					switch (name) {
						case "keydown":
						case "keyup":
						case "input":
						case "change":
							node.setAttribute("name", `channelID${channel.channelId}`);
							break;
					}
				} else {
					switch (name) {
						case "click":
							node.setAttribute("name", `channelID${channel.channelId}`);
							break;
					}
				}
				node.setAttribute(`on${name}`, `_dispatch(${channel.channelId},event)`);
				tuple = c[name] = [channel, listener];
			}
			listeners[name] = ignoreEvent;
		} else if (Object.hasOwnProperty.call(c, name)) {
			const channel = c[name][0];
			if (node.getAttribute("name") == `channelID${channel.channelId}`) {
				// Only remove click channels for now, because input-related channels are merged
				if (name == "click") {
					node.removeAttribute("name");
				}
			}
			node.removeAttribute(`on${name}`);
			channel.close();
			delete c[name];
		}
	}
};

/**
 * @ignore
 */
export function _host(content: JSX.Element): void {
	const element = body.children[0];
	preact.render(content, element, element.children[0]);
}

/**
 * Updates the document's title
 * ~~~
 * title("My single page app on a string");
 * ~~~
 * @param newTitle New value for the document's title
 */
export function title(newTitle: string): void {
	const elements = head.getElementsByTagName("title");
	if (elements.length === 0) {
		const element = document.createElement("title");
		element.textContent = newTitle;
		head.appendChild(element);
	} else {
		elements[0].textContent = newTitle;
	}
}
