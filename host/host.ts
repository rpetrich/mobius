import { escape } from "./event-loop";
import { exists, packageRelative } from "./fileUtils";
import { ModuleMap, StaticAssets } from "./modules/index";
import { createSessionGroup, SessionGroup } from "./session";
import { archivePathForSessionId, HostSandboxOptions } from "./session-sandbox";

import { ClientMessage } from "../common/internal-impl";

import { Request } from "express";

import * as uuid from "uuid/v4";

interface HostConfig {
	mainPath: string;
	fileRead: (path: string) => void;
	watch: boolean;
	serverModulePaths: string[];
	modulePaths: string[];
	sessionsPath: string;
	publicPath: string;
	allowMultipleClientsPerSession: boolean;
	workerCount: number;
	hostname: string | undefined;
	moduleMap: ModuleMap;
	staticAssets: StaticAssets;
	minify: boolean;
	suppressStacks: boolean;
}

export class Host {
	public destroying: boolean = false;
	public options: HostSandboxOptions;
	public staleSessionTimeout: any;
	public sessionGroup: SessionGroup;
	constructor({
		mainPath,
		fileRead,
		watch,
		serverModulePaths,
		modulePaths,
		sessionsPath,
		publicPath,
		allowMultipleClientsPerSession,
		workerCount,
		hostname,
		moduleMap,
		staticAssets,
		minify,
		suppressStacks,
	}: HostConfig) {
		this.destroying = false;
		this.sessionGroup = createSessionGroup(this.options = {
			allowMultipleClientsPerSession,
			serverModulePaths,
			modulePaths,
			mainPath,
			publicPath,
			sessionsPath,
			watch,
			hostname,
			source: { from: "file", path: packageRelative("common/main.js"), sandbox: true },
			moduleMap,
			staticAssets,
			minify,
			suppressStacks,
		}, fileRead, workerCount);
		// Session timeout
		this.staleSessionTimeout = setInterval(() => {
			const now = Date.now();
			for (const session of this.sessionGroup.allSessions()) {
				if (now - session.lastMessageTime > 5 * 60 * 1000) {
					session.destroy().catch(escape);
				} else {
					session.archiveEvents(false).catch(escape);
				}
			}
		}, 10 * 1000);
	}
	public async sessionFromId(sessionID: string | undefined, request: Request | undefined, allowNewSession: boolean) {
		if (!sessionID) {
			throw new Error("No session ID specified!");
		}
		let session = this.sessionGroup.getSessionById(sessionID);
		if (session) {
			return session;
		}
		if (!this.destroying) {
			if (this.options.allowMultipleClientsPerSession) {
				session = this.sessionGroup.constructSession(sessionID, request);
				if (await exists(archivePathForSessionId(this.options.sessionsPath, sessionID))) {
					await session.unarchiveEvents();
					return session;
				} else if (allowNewSession && request) {
					session.client.newClient(session, request);
					return session;
				}
			}
			if (allowNewSession && request) {
				session = this.sessionGroup.constructSession(sessionID, request);
				session.client.newClient(session, request);
				return session;
			}
		}
		throw new Error("Session ID is not valid: " + sessionID);
	}
	public async clientFromMessage(message: ClientMessage, request: Request, allowNewSession: boolean) {
		const clientID = message.clientID as number | 0;
		const session = await this.sessionFromId(message.sessionID, request, allowNewSession && message.messageID == 0 && clientID == 0);
		const client = session.client.getClient(clientID);
		if (!client) {
			throw new Error("Client ID is not valid: " + message.clientID);
		}
		client.request = request;
		return client;
	}
	public async newClient(request: Request) {
		if (this.destroying) {
			throw new Error("Cannot create new client while shutting down!");
		}
		for (;;) {
			const sessionID = uuid();
			if (!this.sessionGroup.getSessionById(sessionID) && (!this.options.allowMultipleClientsPerSession || !await exists(archivePathForSessionId(this.options.sessionsPath, sessionID)))) {
				const session = this.sessionGroup.constructSession(sessionID, request);
				return session.client.newClient(session, request);
			}
		}
	}
	public async destroyClientById(sessionID: string, clientID: number) {
		const session = this.sessionGroup.getSessionById(sessionID);
		if (session) {
			const client = session.client.getClient(clientID);
			if (client) {
				await client.destroy();
			}
		}
	}
	public async destroy() {
		this.destroying = true;
		clearInterval(this.staleSessionTimeout);
		const promises: Array<Promise<void>> = [];
		for (const session of this.sessionGroup.allSessions()) {
			promises.push(session.destroy());
		}
		await Promise.all(promises);
		await this.sessionGroup.destroy();
	}
}
