import { createServerChannel, createServerPromise } from "mobius";
import { peek, redact, Redacted } from "redact";
import { BoundStatement, Credentials, Record } from "sql";
import pool from "./sql/pool";

/**
 * Prepares a parameterized SQL statement.
 * Best used as a tagged template string
 * ~~~
 * const statement = sql`INSERT INTO foo (bar, baz) VALUES (${bar}, ${baz})`;
 * ~~~
 * @param literal SQL to parameterize
 * @param values Values to fill into the parameterized SQL string
 */
export function sql(literals: ReadonlyArray<string>, ...values: any[]): Redacted<BoundStatement>;
/**
 * Prepares a literal SQL statement.
 * ~~~
 * const statement = sql("SELECT count(*) from foo");
 * ~~~
 * @param literal SQL string
 */
export function sql(literal: string): Redacted<BoundStatement>;
export function sql(literals: ReadonlyArray<string> | string, ...values: any[]): Redacted<BoundStatement> {
	return redact({
		literals: typeof literals === "string" ? [literals] : literals,
		values,
	});
}

/**
 * Executes a SQL statement using the provided credentials
 * ~~~
 * import { db } from "secrets";
 * execute(db, sql`INSERT INTO foo (bar, baz) VALUES (${bar}, ${baz})`);
 * ~~~
 * @param credentials Credentials of the database to connect to; must be redacted to avoid inclusion in client-side code. Use either [[redact]] or `import { db } from "secrets";` to get credentials
 * @param statement SQL statement to execute. Use [[sql]] to generate a bound statement
 */
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>): Promise<Record[]>;
/**
 * Executes a SQL statement using the provided credentials
 * ~~~
 * import { db } from "secrets";
 * execute(db, sql`SELECT * FROM foo`, (record: Record) => console.log(record));
 * ~~~
 * @param credentials Credentials of the database to connect to; must be redacted to avoid inclusion in client-side code. Use either [[redact]] or `import { db } from "secrets";` to get credentials
 * @param statement SQL statement to execute. Use [[sql]] to generate a bound statement
 * @param stream Called as values are recieved from the database
 */
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
