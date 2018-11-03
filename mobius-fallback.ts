/**
 * @license THE MIT License (MIT)
 * 
 * Copyright (c) 2017-2018 Ryan Petrich
 * Copyright (c) 2017 Dylan Piercey
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
declare function setDOM(element: Element, source: string): void;

(() => {
	document.body.className = "notranslate mobius-active";

	const queryComponents = location.search.substr(1).split(/\&/g);
	const jsNoIndex = queryComponents.indexOf("js=no");
	if (jsNoIndex != -1) {
		queryComponents.splice(jsNoIndex, 1);
		location.replace(location.pathname + "?" + queryComponents.join("&"));
		return;
	}
	const supportsNativeXHR = typeof XMLHttpRequest != "undefined";
	const supportsActiveXObject = typeof (window as any).ActiveXObject != "undefined";
	if (!supportsNativeXHR && !supportsActiveXObject) {
		return;
	}

	let isSending = 0;
	let anyChanged = false;
	let lastInputChannelId = -1;
	let queuedEvents: string[] = [];
	let flushTimerId: number | undefined;

	let currentHTMLSource = "";
	const diff = new (window as any).diff_match_patch();

	let form = document.forms["mobius-form" as any as number] as HTMLFormElement;
	if (!form) {
		form = document.createElement("form");
		const body = document.body;
		while (body.childNodes.length) {
			form.appendChild(body.childNodes[0]);
		}
		body.appendChild(form);
	}

	form.onsubmit = function() {
		return false;
	}

	function queryPairForDOMEvent(channelId: number, event: Event): string {
		const element = (event.target || event.srcElement) as HTMLInputElement;
		return `channelID${channelId}=${element ? encodeURIComponent(element.value || "") : ""}`;
	}

	function onInputEvent(channelId: number, event: Event) {
		// Coalesce similar events
		if (lastInputChannelId == channelId) {
			queuedEvents.pop();
		} else {
			lastInputChannelId = channelId;
		}
		queuedEvents.push(queryPairForDOMEvent(channelId, event));
		if (typeof flushTimerId == "undefined") {
			flushTimerId = setTimeout(send, 300);
		}
		anyChanged = true;
	}

	function onGenericEvent(channelId: number, event: Event) {
		queuedEvents.push(queryPairForDOMEvent(channelId, event));
		send();
	}

	function handlerForEventType(onType: string) {
		switch (onType) {
			case "keydown":
			case "keyup":
			case "input":
			case "change":
				return onInputEvent;
			default:
				return onGenericEvent;
		}
	}

	function checkServerChannels() {
		const hasServerChannels = form["hasServerChannels"];
		if (!hasServerChannels || hasServerChannels.value) {
			if (!isSending) {
				return send();
			}
		}
	}

	function send() {
		if (typeof flushTimerId != "undefined") {
			clearTimeout(flushTimerId);
			flushTimerId = undefined;
		}
		if (isSending <3) {
			var request: XMLHttpRequest = supportsNativeXHR ? new XMLHttpRequest() : new (window as any).ActiveXObject("MSXML2.XMLHTTP.3.0");
			request.open("POST", location.href, true);
			request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
			var body = queuedEvents;
			queuedEvents = [];
			lastInputChannelId = -1;
			body.unshift("postback=js");
			for (let i = 0; i < form.length; i++) {
				const element = form[i] as HTMLInputElement;
				if (element.type == "hidden") {
					if (element.name != "postback" && element.name != "hasServerChannels") {
						body.push(element.name + "=" + encodeURIComponent(element.value));
					}
				}
			}
			request.onreadystatechange = function() {
				if (request.readyState == 4) {
					isSending--;
					if (request.status == 200) {
						if (anyChanged) {
							// Race condition, text field changed while the request was in flight, send again
							send();
						} else {
							const responseText = request.responseText;
							if (responseText[0] == "<") {
								currentHTMLSource = responseText;
							} else {
								currentHTMLSource = diff.patch_apply(diff.patch_fromText(responseText), currentHTMLSource)[0];
							}
							setDOM(document.documentElement!, currentHTMLSource);
							// form.innerHTML = request.responseText;
							checkServerChannels();
						}
					}
				}
			}
			isSending++;
			anyChanged = false;
			request.send(body.join("&"));
			const messageID = form["messageID"];
			if (messageID) {
				messageID.value = (messageID.value | 0) + 1;
			}
		}
	}

	checkServerChannels();

	(window as any)._dispatch = function(channelId: number, event: Event) {
		handlerForEventType(event.type)(channelId, event);
	}

})()
