import { createServerChannel, createServerPromise } from "mobius";
import { Redacted } from "redact";
import { BoundStatement, Credentials, Record } from "sql";

export function sql(literals: ReadonlyArray<string>, ...values: any[]): Redacted<BoundStatement>;
export function sql(literal: string): Redacted<BoundStatement>;
export function sql(literals: ReadonlyArray<string> | string, ...values: any[]): Redacted<BoundStatement> {
	return new Redacted<BoundStatement>();
}

export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>): Promise<Record[]>;
export function execute<T>(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, stream: (record: Record) => T): Promise<T[]>;
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, stream?: (record: Record) => any): Promise<any[]> {
	const records: Record[] = [];
	const channel = createServerChannel((record: Record) => {
		records.push(stream ? stream(record) : record);
	});
	return createServerPromise<void>().then((value) => {
		channel.close();
		return records;
	}, (error) => {
		channel.close();
		throw error;
	});
}
