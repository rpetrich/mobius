import { BootstrapData } from "_internal";
import { JSDOM } from "jsdom";
import { Root as CSSRoot } from "postcss";
import { once } from "./memoize";

function compatibleStringify(value: any): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/<\/script/g, "<\\/script");
}

function migrateChildren(fromNode: Node, toNode: Node) {
	let firstChild: Node | null;
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
	private document: Document;
	public body: Element;
	public head: Element;
	private clientScript: HTMLScriptElement;
	private fallbackScript: HTMLScriptElement;
	private inlineStyles?: HTMLStyleElement;
	private bootstrapScript?: HTMLScriptElement;
	private formNode?: HTMLFormElement;
	private postbackInput?: HTMLInputElement;
	private sessionIdInput?: HTMLInputElement;
	private clientIdInput?: HTMLInputElement;
	private messageIdInput?: HTMLInputElement;
	private hasServerChannelsInput?: HTMLInputElement;

	constructor(private dom: JSDOM, private noscript: Element, private metaRedirect: Element, private cssForPath: (path: string) => Promise<CSSRoot>) {
		// Reuse a single document to avoid unnecessary memory usage associated with all the global JSDOM objects
		this.document = (dom.window as Window).document;
		this.body = this.document.body.cloneNode(true) as Element;
		this.head = this.document.head.cloneNode(true) as Element;
		this.noscript = noscript;
		this.metaRedirect = metaRedirect;
		const clientScript = this.clientScript = this.document.createElement("script");
		this.body.appendChild(clientScript);
		const fallbackScript = this.fallbackScript = this.document.createElement("script");
		this.body.appendChild(fallbackScript);
	}

	// Render document state into an HTML document containing the appropriate bootstrap data and configuration
	public async render({ mode, clientState, sessionState, clientURL, clientIntegrity, fallbackIntegrity, fallbackURL, noScriptURL, bootstrapData, inlineCSS }: RenderOptions): Promise<string> {
		const document = this.document;
		let bootstrapScript: HTMLScriptElement | undefined;
		let textNode: Node | undefined;
		let formNode: HTMLFormElement | undefined;
		let postbackInput: HTMLInputElement | undefined;
		let sessionIdInput: HTMLInputElement | undefined;
		let clientIdInput: HTMLInputElement | undefined;
		let messageIdInput: HTMLInputElement | undefined;
		let hasServerChannelsInput: HTMLInputElement | undefined;
		let siblingNode: Node | null = null;
		let cssRoots: CSSRoot[] | undefined;
		// CSS Inlining
		if (inlineCSS) {
			const linkTags = this.body.getElementsByTagName("link");
			for (let i = 0; i < linkTags.length; i++) {
				if (linkTags[i].rel === "stylesheet") {
					const href = linkTags[i].href;
					if (href && !/^\w+:/.test(href)) {
						const root = await this.cssForPath(href);
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
				bootstrapScript.type = "application/x-mobius-bootstrap";
			}
			textNode = document.createTextNode(compatibleStringify(bootstrapData));
			bootstrapScript.appendChild(textNode);
			this.clientScript.parentNode!.insertBefore(bootstrapScript, this.clientScript);
		}
		this.clientScript.src = clientURL;
		this.clientScript.setAttribute("integrity", clientIntegrity);
		this.fallbackScript.textContent = `window._mobius||(function(s){s.src=${JSON.stringify(fallbackURL)};s.setAttribute("integrity",${JSON.stringify(fallbackIntegrity)})})(document.head.appendChild(document.createElement("script")))`;
		if (noScriptURL) {
			this.metaRedirect.setAttribute("content", "0; url=" + noScriptURL);
			this.head.appendChild(this.noscript);
		}
		try {
			const realHead = this.document.head;
			const headParent = realHead.parentElement!;
			headParent.replaceChild(this.head, realHead);
			const realBody = this.document.body;
			const bodyParent = realBody.parentElement!;
			bodyParent.replaceChild(this.body, realBody);
			try {
				if (cssRoots) {
					const newRoot = (await cssRoot())();
					for (const root of cssRoots) {
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
				return this.dom.serialize();
			} finally {
				bodyParent.replaceChild(realBody, this.body);
				headParent.replaceChild(realHead, this.head);
			}
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
				this.head.removeChild(this.noscript);
			}
			if (bootstrapScript) {
				const parentElement = bootstrapScript.parentElement;
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
