import { ClientMessage, Event, ServerMessage } from "../common/internal-impl";
import { defer } from "./event-loop";
import { Session } from "./session";

import { Request, Response } from "express";

export class Client {
	public session: Session;
	public request: Request;
	public clientID: number;
	public incomingMessageId: number = 0;
	public outgoingMessageId: number = 0;
	public reorderedMessages: { [messageId: number]: ClientMessage } = {};
	public queuedLocalEvents: Event[] | undefined;
	public queuedLocalEventsResolve: ((shouldContinue: true | void) => void) | undefined;
	public localResolveTimeout: ReturnType<typeof setTimeout> | undefined;
	public willSynchronizeChannels = false;
	public lastSentFormHTML?: string;
	public pendingCookies?: Array<[string, string]>;
	public clientIsActive?: true;

	constructor(session: Session, request: Request, clientID: number) {
		this.session = session;
		this.request = request;
		this.clientID = clientID;
	}

	public async destroy() {
		const wasLastClient = this.session.client.deleteClient(this.clientID);
		if (this.queuedLocalEventsResolve) {
			this.queuedLocalEventsResolve(undefined);
		}
		this.synchronizeChannels();
		// Destroy the session if we were the last client
		if (wasLastClient) {
			await this.session.destroy();
		}
	}

	public async processMessage(message: ClientMessage): Promise<void> {
		// Process messages in order
		const messageId = message.messageID;
		if (messageId > this.incomingMessageId) {
			// Message was received out of order, queue it for later
			this.reorderedMessages[messageId] = message;
			return;
		}
		if (messageId < this.incomingMessageId) {
			return;
		}
		this.incomingMessageId++;
		this.willSynchronizeChannels = true;
		if (message.events.length) {
			await this.session.processEvents(message.events, message.noJavaScript);
		}
		const reorderedMessage = this.reorderedMessages[this.incomingMessageId];
		if (reorderedMessage) {
			delete this.reorderedMessages[this.incomingMessageId];
			await this.processMessage(reorderedMessage);
		}
		this.synchronizeChannels();
		// Destroy if asked to by client
		if (message.destroy) {
			await this.destroy();
		}
	}

	public receiveMessage(message: ClientMessage): Promise<void> {
		this.session.lastMessageTime = Date.now();
		return this.processMessage(message);
	}

	public async receiveFallbackMessage(message: ClientMessage, body: { [key: string]: string}): Promise<void> {
		// JavaScript is disabled, emulate events from form POST
		const inputEvents: Event[] = [];
		const buttonEvents: Event[] = [];
		message.noJavaScript = true;
		for (const key in body) {
			if (Object.hasOwnProperty.call(body, key)) {
				const match = key.match(/^channelID(\d+)$/);
				if (match) {
					const value = await this.session.valueForFormField(key);
					if (value === undefined) {
						const event: Event = [-match[1], { }];
						buttonEvents.push(event);
					} else if (value !== body[key]) {
						const event: Event = [-match[1], { type: "input", value: body[key] }];
						inputEvents.push(event);
					}
				}
			}
		}
		message.events = message.events.concat(inputEvents.concat(buttonEvents));
		return await this.receiveMessage(message);
	}

	public produceMessage(close: boolean): Partial<ServerMessage> {
		const result: Partial<ServerMessage> = { messageID: this.outgoingMessageId++ };
		if (close) {
			result.close = true;
		}
		if (this.queuedLocalEvents) {
			result.events = this.queuedLocalEvents;
			this.queuedLocalEvents = undefined;
		}
		return result;
	}

	public async dequeueEvents(watch: boolean): Promise<true | void> {
		const hasLocalChannels = watch || await this.session.hasLocalChannels();
		return new Promise<true | void>((resolve, reject) => {
			// Wait until events are ready, a new event handler comes in, or no more local channels exist
			const oldResolve = this.queuedLocalEventsResolve;
			if (this.queuedLocalEvents) {
				if (oldResolve) {
					this.queuedLocalEventsResolve = resolve;
					oldResolve(true);
				} else {
					resolve(true);
					return;
				}
			} else if (hasLocalChannels) {
				this.queuedLocalEventsResolve = resolve;
				if (oldResolve) {
					oldResolve(undefined);
				}
			} else {
				resolve(undefined);
				return;
			}
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
			}
			this.localResolveTimeout = setTimeout(resolve, 30000);
		});
	}

	public sendEvent(event: Event) {
		// Queue an event
		const queuedLocalEvents = this.queuedLocalEvents;
		if (queuedLocalEvents) {
			queuedLocalEvents.push(event);
		} else {
			this.queuedLocalEvents = [event];
		}
		this.scheduleSynchronize();
	}

	public synchronizeChannels = () => {
		this.willSynchronizeChannels = false;
		const resolve = this.queuedLocalEventsResolve;
		if (resolve) {
			this.queuedLocalEventsResolve = undefined;
			resolve(true);
			if (this.localResolveTimeout !== undefined) {
				clearTimeout(this.localResolveTimeout);
				this.localResolveTimeout = undefined;
			}
		}
		return this.session.destroyIfExhausted();
	}

	public scheduleSynchronize() {
		if (!this.willSynchronizeChannels) {
			this.willSynchronizeChannels = true;
			defer().then(this.synchronizeChannels);
		}
	}

	public setCookie(key: string, value: string) {
		const cookies = this.pendingCookies || (this.pendingCookies = []);
		cookies.push([key, value]);
	}
	public applyCookies(response: Response) {
		const cookies = this.pendingCookies;
		if (cookies) {
			this.pendingCookies = undefined;
			for (const [ key, value ] of cookies) {
				response.cookie(key, value);
			}
		}
	}
	public becameActive() {
		if (!this.clientIsActive) {
			this.clientIsActive = true;
			this.session.becameActive();
		}
	}
}
