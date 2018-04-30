import { createServerChannel, createServerPromise } from "mobius";
import { peek, redact, Redacted } from "redact";
import { BoundStatement, Credentials, Record } from "sql";
import pool from "./sql/pool";

export function sql(literal: string): Redacted<BoundStatement>;
export function sql(literals: ReadonlyArray<string>, ...values: any[]): Redacted<BoundStatement>;
export function sql(literals: ReadonlyArray<string> | string, ...values: any[]): Redacted<BoundStatement> {
	return redact({
		literals: typeof literals === "string" ? [literals] : literals,
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
		return pool(peek(credentials))(peek(statement), send!);
	}).then((value) => {
		channel.close();
		return records;
	}, (error) => {
		channel.close();
		throw error;
	});
}
