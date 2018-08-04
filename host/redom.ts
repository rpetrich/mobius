const undom = require("undom");

const baseDocument = undom();
const NodeProto = baseDocument.defaultView.Node.prototype;
Object.defineProperties(NodeProto, {
	textContent: {
		set(this: Node, newValue: string) {
			let i = this.childNodes.length;
			while (i--) {
				this.removeChild(this.childNodes[i]);
			}
			this.appendChild(baseDocument.createTextNode(newValue));
		},
		get(this: Node) {
			let result = "";
			for (const child of this.childNodes) {
				result += child.textContent;
			}
			return result;
		},
	},
});
const ElementProto = baseDocument.defaultView.Element.prototype;
Object.defineProperties(ElementProto, {
	hasAttribute: {
		value(this: Element, name: string) {
			for (const attr of this.attributes) {
				if (attr.name == name) {
					return true;
				}
			}
			return false;
		},
	},
});

// Creation
function emptyDocument(): Document {
	const document = new baseDocument.defaultView.Document();
	document.nodeName = "html";
	document.documentElement = document;
	document.createElement = baseDocument.createElement;
	document.createElementNS = baseDocument.createElementNS;
	document.createTextNode = baseDocument.createTextNode;
	return document;
}

export function newDocument(): Document & { head: Element } {
	const document: any = emptyDocument();
	document.appendChild(document.head = document.createElement("head"));
	document.appendChild(document.body = document.createElement("body"));
	return document;
}

// Type guards

function isElement(node: Node): node is Element {
	return node.nodeType === 1 || node.nodeType === 9;
}

function isText(node: Node): node is Text {
	return node.nodeType === 3;
}

// cloneNode

function copyAttributes(from: Element, to: Element) {
	for (const attr of from.attributes) {
		(to.attributes as any as Attribute[]).push({ ns: attr.ns, name: attr.name, value: attr.value });
	}
}

baseDocument.defaultView.Text.prototype.cloneNode = function(this: Text, deep?: boolean) {
	return baseDocument.createTextNode(this.nodeValue);
};
baseDocument.defaultView.Element.prototype.cloneNode = function(this: Element, deep?: boolean) {
	let result: Element;
	if (typeof this.namespace !== "undefined") {
		result = baseDocument.createElementNS(this.namespace, this.nodeName);
	} else {
		result = baseDocument.createElement(this.nodeName);
	}
	if (deep) {
		for (const child of this.childNodes) {
			result.insertBefore(child.cloneNode(deep));
		}
	}
	copyAttributes(this, result);
	return result;
};
baseDocument.defaultView.Document.prototype.cloneNode = function(this: Document, deep?: boolean) {
	const result = emptyDocument();
	result.appendChild((result as any).head = (this as any).head.cloneNode(deep));
	result.appendChild((result as any).body = (this as any).body.cloneNode(deep));
	copyAttributes(this, result);
	return result;
};

// Query engine
const nwsapi = require("nwsapi");
baseDocument.contentType = "text/html";
baseDocument.compatMode = "CSS1Compat";
NodeProto.ownerDocument = baseDocument;
NodeProto.getElementById = function(this: Element, id: string) {
	const queue: Element[] = [this];
	for (let i = 0; i < queue.length; i++) {
		if (queue[i].getAttribute("id") === id) {
			return queue[i];
		}
		for (const child of queue[i].childNodes) {
			if (isElement(child)) {
				queue.push(child);
			}
		}
	}
	return null;
};
NodeProto.getElementsByTagName = function(this: Element, tagName: string) {
	const result: Element[] = [];
	tagName = tagName.toUpperCase();
	checkAndTraverse(this);
	return result;
	function checkAndTraverse(child: Node) {
		if (isElement(child)) {
			if (child.nodeName === tagName) {
				result.push(child);
			}
			child.childNodes.forEach(checkAndTraverse);
		}
	}
};
NodeProto.getElementsByClassName = function(this: Element, className: string) {
	const result: Element[] = [];
	checkAndTraverse(this);
	return result;
	function checkAndTraverse(child: Node) {
		if (isElement(child)) {
			const childClass = (child as Element).className;
			if (typeof childClass === "string" && childClass.indexOf(className) !== -1 && childClass.split(" ").indexOf(className) !== -1) {
				result.push(child);
			}
			child.childNodes.forEach(checkAndTraverse);
		}
	}
};

const nws = nwsapi(baseDocument);
NodeProto.querySelector = function(selector: string): Element | null {
	return nws.first(selector, this);
};
NodeProto.querySelectorAll = function(selector: string): Element[] {
	return nws.select(selector, this);
};

// Serialization

const VOID_ELEMENTS = [
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
];

const ESC: { [name: string]: string } = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

const safeNameMapping: { [name: string]: string } = Object.create(null);
const normalizeName = (name: string) => {
	if (Object.hasOwnProperty.call(safeNameMapping, name)) {
		return safeNameMapping[name];
	} else {
		return safeNameMapping[name] = name.toLowerCase().replace(/[^a-zA-Z0-9\-:]/g, "");
	}
}

const enc = (s: string) => s.replace(/[&'"<>]/g, (a) => ESC[a]);
const attr = (a: Attribute) => {
	if (a.name === "class" && a.value === "") {
		return "";
	}
	return ` ${normalizeName(a.name)}${a.value === "true" || a.value === "" ? "" : `="${enc(a.value)}"`}`;
};

export function serialize(node: Node, attributeFilter?: (attr: Attribute) => boolean): string {
	if (isElement(node)) {
		const normalizedNodeName = normalizeName(node.nodeName);
		let result = `<${normalizedNodeName}${(attributeFilter ? node.attributes.filter(attributeFilter) : node.attributes).map(attr).join("")}>`;
		if (VOID_ELEMENTS.indexOf(normalizedNodeName) !== -1 && node.childNodes.length === 0) {
			return result;
		}
		if (node.innerHTML) {
			result += node.innerHTML;
		} else {
			for (const childNode of node.childNodes) {
				result += serialize(childNode, attributeFilter);
			}
		}
		result += `</${normalizedNodeName}>`;
		return result;
	} else if (isText(node)) {
		const text = node.textContent;
		if (typeof text === "string") {
			return (node.parentNode && (node.parentNode.nodeName === "SCRIPT" || node.parentNode.nodeName === "STYLE")) ? text : enc(text);
		}
	}
	return "";
}
