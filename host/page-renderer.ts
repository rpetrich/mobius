import { BootstrapData } from "internal-impl";
import { Root as CSSRoot } from "postcss";
import { once } from "./memoize";
import { newDocument, serialize } from "./redom";

function compatibleStringify(value: any): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/<\/script/g, "<\\/script");
}

function migrateChildren(fromNode: Node, toNode: Node) {
	let firstChild: Node | undefined;
	while (firstChild = fromNode.firstChild) {
		toNode.appendChild(firstChild);
	}
}

export const enum PageRenderMode {
	Bare = 0,
	IncludeForm = 1,
	IncludeFormAndStripScript = 2,
}

export interface SessionState {
	sessionID: string;
	localChannelCount: number;
}

export interface ClientState {
	clientID: number;
	incomingMessageId: number;
}

export interface SharedRenderState {
	readonly document: ReturnType<typeof newDocument>;
	readonly noscript: Element;
	readonly metaRedirect: Element;
	cssForPath(path: string): Promise<CSSRoot>;
}

export interface RenderOptions {
	mode: PageRenderMode;
	clientState: ClientState;
	sessionState: SessionState;
	clientURL: string;
	clientIntegrity: string;
	fallbackIntegrity: string;
	fallbackURL: string;
	noScriptURL?: string;
	bootstrapData?: BootstrapData;
	inlineCSS?: true;
}

const cssRoot = once(async () => (await import("postcss")).root);

export class PageRenderer {
	public readonly document: ReturnType<typeof newDocument>;
	public readonly body: Element;
	public readonly head: Element;
	private clientScript: Element;
	private fallbackScript: Element;
	private inlineStyles?: Element;
	private bootstrapScript?: Element;
	private formNode?: Element;
	private postbackInput?: Element;
	private sessionIdInput?: Element;
	private clientIdInput?: Element;
	private messageIdInput?: Element;
	private hasServerChannelsInput?: Element;

	constructor(private sharedState: SharedRenderState) {
		this.document = sharedState.document.cloneNode(true);
		this.body = this.document.body;
		this.head = this.document.head;
		this.body.appendChild(this.clientScript = this.document.createElement("script"));
		this.body.appendChild(this.fallbackScript = this.document.createElement("script"));
	}

	// Render document state into an HTML document containing the appropriate bootstrap data and configuration
	public async render({ mode, clientState, sessionState, clientURL, clientIntegrity, fallbackIntegrity, fallbackURL, noScriptURL, bootstrapData, inlineCSS }: RenderOptions): Promise<string> {
		const document = this.document;
		let bootstrapScript: Element | undefined;
		let textNode: Node | undefined;
		let formNode: Element | undefined;
		let postbackInput: Element | undefined;
		let sessionIdInput: Element | undefined;
		let clientIdInput: Element | undefined;
		let messageIdInput: Element | undefined;
		let hasServerChannelsInput: Element | undefined;
		let siblingNode: Node | null = null;
		let cssRoots: Array<Promise<CSSRoot>> | undefined;
		// CSS Inlining
		if (inlineCSS) {
			const linkTags = document.getElementsByTagName("link");
			for (let i = 0; i < linkTags.length; i++) {
				if (linkTags[i].getAttribute("rel") === "stylesheet") {
					const href = linkTags[i].getAttribute("href");
					if (href && !/^\w+:/.test(href)) {
						const root = this.sharedState.cssForPath(href);
						if (cssRoots) {
							cssRoots.push(root);
						} else {
							cssRoots = [root];
						}
					}
				}
			}
		}
		// Hidden form elements for fallbacks
		if (mode >= PageRenderMode.IncludeForm) {
			formNode = this.formNode;
			if (!formNode) {
				formNode = this.formNode = document.createElement("form");
				formNode.setAttribute("action", "/");
				formNode.setAttribute("method", "POST");
				formNode.setAttribute("id", "mobius-form");
			}
			postbackInput = this.postbackInput;
			if (!postbackInput) {
				postbackInput = this.postbackInput = document.createElement("input");
				postbackInput.setAttribute("name", "postback");
				postbackInput.setAttribute("type", "hidden");
				postbackInput.setAttribute("value", "form");
			}
			formNode.appendChild(postbackInput);
			sessionIdInput = this.sessionIdInput;
			if (!sessionIdInput) {
				sessionIdInput = this.sessionIdInput = document.createElement("input");
				sessionIdInput.setAttribute("name", "sessionID");
				sessionIdInput.setAttribute("type", "hidden");
				sessionIdInput.setAttribute("value", sessionState.sessionID);
			}
			formNode.appendChild(sessionIdInput);
			if (clientState.clientID != 0) {
				clientIdInput = this.clientIdInput;
				if (!clientIdInput) {
					clientIdInput = this.clientIdInput = document.createElement("input");
					clientIdInput.setAttribute("name", "clientID");
					clientIdInput.setAttribute("type", "hidden");
				}
				clientIdInput.setAttribute("value", clientState.clientID.toString());
				formNode.appendChild(clientIdInput);
			}
			messageIdInput = this.messageIdInput;
			if (!messageIdInput) {
				messageIdInput = this.messageIdInput = document.createElement("input");
				messageIdInput.setAttribute("name", "messageID");
				messageIdInput.setAttribute("type", "hidden");
			}
			messageIdInput.setAttribute("value", clientState.incomingMessageId.toString());
			formNode.appendChild(messageIdInput);
			hasServerChannelsInput = this.hasServerChannelsInput;
			if (!hasServerChannelsInput) {
				hasServerChannelsInput = this.hasServerChannelsInput = document.createElement("input");
				hasServerChannelsInput.setAttribute("name", "hasServerChannels");
				hasServerChannelsInput.setAttribute("type", "hidden");
			}
			hasServerChannelsInput.setAttribute("value", sessionState.localChannelCount ? "1" : "");
			formNode.appendChild(hasServerChannelsInput);
			migrateChildren(this.body, formNode);
			this.body.appendChild(formNode);
		}
		if (mode >= PageRenderMode.IncludeFormAndStripScript) {
			siblingNode = document.createTextNode("");
			this.clientScript.parentNode!.insertBefore(siblingNode, this.clientScript);
			this.clientScript.parentNode!.removeChild(this.clientScript);
			this.fallbackScript.parentNode!.removeChild(this.fallbackScript);
		} else if (bootstrapData) {
			bootstrapScript = this.bootstrapScript;
			if (!bootstrapScript) {
				bootstrapScript = this.bootstrapScript = document.createElement("script");
				bootstrapScript.setAttribute("type", "application/x-mobius-bootstrap");
			}
			textNode = document.createTextNode(compatibleStringify(bootstrapData));
			bootstrapScript.appendChild(textNode);
			this.clientScript.parentNode!.insertBefore(bootstrapScript, this.clientScript);
		}
		this.clientScript.setAttribute("src", clientURL);
		this.clientScript.setAttribute("integrity", clientIntegrity);
		this.fallbackScript.textContent = `window._mobius||(function(s){s.src=${JSON.stringify(fallbackURL)};s.setAttribute("integrity",${JSON.stringify(fallbackIntegrity)})})(document.head.appendChild(document.createElement("script")))`;
		if (noScriptURL) {
			this.sharedState.metaRedirect.setAttribute("content", "0; url=" + noScriptURL);
			this.head.appendChild(this.sharedState.noscript);
		}
		try {
			if (cssRoots) {
				const newRoot = (await cssRoot())();
				for (const root of await Promise.all(cssRoots)) {
					if (root.nodes) {
						for (const node of root.nodes) {
							if (node.type === "rule") {
								try {
									if (document.querySelector(node.selector) === null) {
										continue;
									}
								} catch (e) {
									continue;
								}
								newRoot.append(node.clone());
							}
						}
					}
				}
				if (newRoot.nodes && newRoot.nodes.length) {
					let inlineStyles = this.inlineStyles;
					if (!inlineStyles) {
						inlineStyles = document.createElement("style");
						inlineStyles.setAttribute("id", "mobius-inlined");
						this.head.appendChild(inlineStyles);
						this.inlineStyles = inlineStyles;
					}
					inlineStyles.textContent = newRoot.toResult().css;
				}
			}
			return "<!doctype html>" + serialize(this.document);
		} finally {
			// Put Humpty Dumpty back together again
			if (mode >= PageRenderMode.IncludeForm && formNode) {
				if (postbackInput) {
					formNode.removeChild(postbackInput);
				}
				if (sessionIdInput) {
					formNode.removeChild(sessionIdInput);
				}
				if (clientIdInput) {
					formNode.removeChild(clientIdInput);
				}
				if (messageIdInput) {
					formNode.removeChild(messageIdInput);
				}
				if (hasServerChannelsInput) {
					formNode.removeChild(hasServerChannelsInput);
				}
				migrateChildren(formNode, this.body);
				this.body.removeChild(formNode);
			}
			if (mode >= PageRenderMode.IncludeFormAndStripScript) {
				if (siblingNode) {
					siblingNode.parentNode!.insertBefore(this.fallbackScript, siblingNode);
					siblingNode.parentNode!.insertBefore(this.clientScript, siblingNode);
					siblingNode.parentNode!.removeChild(siblingNode);
				}
			}
			if (noScriptURL) {
				this.head.removeChild(this.sharedState.noscript);
			}
			if (bootstrapScript) {
				const parentElement = bootstrapScript.parentNode;
				if (parentElement) {
					parentElement.removeChild(bootstrapScript);
				}
				if (textNode) {
					bootstrapScript.removeChild(textNode);
				}
			}
		}
	}
}
