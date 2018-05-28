interface Node {
	readonly nodeType: number;
	readonly nodeName: string;
	readonly childNodes: ReadonlyArray<Node>;
	readonly namespace?: string;

	readonly parentNode?: Node;
	readonly nextSibling: Node | undefined;
	readonly previousSibling: Node | undefined;
	readonly firstChild: Node | undefined;
	readonly lastChild: Node | undefined;

	textContent: string;

	appendChild(child: Node): void;
	insertBefore(child: Node, ref?: Node): void;
	replaceChild(child: Node, ref: Node): void;
	removeChild(child: Node): void;
	remove(): void;

	cloneNode(deep?: boolean): this;
}

interface Text extends Node {
	readonly nodeType: 3;

	nodeValue: string;
}

interface Attribute {
	readonly ns: string | null;
	readonly name: string;
	value: string;
}

interface Element extends Node {
	readonly nodeType: 1 | 9;

	readonly children: Element[];
	readonly attributes: ReadonlyArray<Attribute>;
	className: string | undefined;
	cssText: string | undefined;
	readonly innerHTML?: string;

	setAttribute(key: string, value: string): void;
	getAttribute(key: string): string | undefined;
	removeAttribute(key: string): void;

	setAttributeNS(ns: string | null, key: string, value: string): void;
	getAttributeNS(ns: string | null, key: string): string | undefined;
	removeAttributeNS(ns: string | null, key: string): void;

	addEventListener(type: string, handler: (this: Element, event: Event) => boolean | void): void;
	removeEventListener(type: string, handler: (this: Element, event: Event) => boolean | void): void;
	dispatchEvent(event: Event): boolean;

	getElementById(id: string): Element | null;
	getElementsByTagName(tagName: string): Element[];
	getElementsByClassName(className: string): Element[];
	querySelector(selector: string): Element | null;
	querySelectorAll(selector: string): Element[];
}

interface Document extends Element {
	readonly nodeType: 9;

	readonly body: Element;
	readonly documentElement: Document;

	createElement(type: string): Element;
	createElementNS(ns: string | null, type: string): Element;
	createTextNode(text: string): Text;
}

interface Event {
	constructor(type: string, opts: { bubbles?: boolean; cancelable?: boolean; }): Event;

	readonly type: string;
	readonly bubbles: boolean;
	readonly cancelable: boolean;

	defaultPrevented?: boolean;
	currentTarget?: Node;

	stopPropagation(): void;
	stopImmediatePropagation(): void;
	preventDefault(): void;
}
