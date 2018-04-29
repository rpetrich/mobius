import { createServerChannel, createServerPromise } from "mobius";
import { peek, redact, Redacted } from "redact";
import { BoundStatement, Credentials, Record } from "sql";
import mysql from "./sql/mysql";
import postgresql from "./sql/postgresql";

const implementations: { mysql: typeof mysql, postgresql: typeof postgresql } = { mysql, postgresql };

type PoolCallback = (statement: BoundStatement, send: (record: Record) => void) => Promise<void>;

declare global {
	namespace NodeJS {
		interface Global {
			sqlPools?: WeakMap<Credentials, PoolCallback>;
		}
	}
}

export function sql(literals: TemplateStringsArray, ...values: any[]): Redacted<BoundStatement> {
	return redact({
		literals,
		values,
	});
}

export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>): Promise<Record[]>;
export function execute<T>(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, stream: (record: Record) => T): Promise<T[]>;
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, stream?: (record: Record) => any): Promise<any[]> {
	const records: Record[] = [];
	let send: ((record: Record) => void) | undefined;
	const channel = createServerChannel((record: Record) => {
		records.push(stream ? stream(record) : record);
	}, (newSend: (record: Record) => void) => send = newSend);
	return createServerPromise(() => {
		const peekedCredentials = peek(credentials);
		const pools = global.sqlPools || (global.sqlPools = new WeakMap<Credentials, PoolCallback>());
		let pool = pools.get(peekedCredentials);
		if (!pool) {
			pool = implementations[peekedCredentials.type]!(peekedCredentials);
			pools.set(peekedCredentials, pool);
		}
		return pool(peek(statement), send!);
	}).then((value) => {
		channel.close();
		return records;
	}, (error) => {
		channel.close();
		throw error;
	});
}
