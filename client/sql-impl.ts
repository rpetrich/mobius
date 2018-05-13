import { createServerChannel, createServerPromise } from "mobius";
import { Redacted } from "redact";
import { BoundStatement, Credentials } from "sql";

export function sql(literals: ReadonlyArray<string>, ...values: any[]): Redacted<BoundStatement>;
export function sql(literal: string): Redacted<BoundStatement>;
export function sql(literals: ReadonlyArray<string> | string, ...values: any[]): Redacted<BoundStatement> {
	return new Redacted<BoundStatement>();
}

export function execute<T>(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, validator: (record: any) => record is T): Promise<T[]>;
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>): Promise<any[]>;
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, validator?: (record: any) => boolean): Promise<any[]> {
	const records: any[] = [];
	const channel = createServerChannel(validator ? (record: any) => {
		if (validator(record)) {
			records.push(record);
		}
	} : records.push.bind(records));
	return createServerPromise<void>().then((value) => {
		channel.close();
		return records;
	}, (error) => {
		channel.close();
		throw error;
	});
}
