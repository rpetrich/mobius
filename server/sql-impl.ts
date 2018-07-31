import { createServerChannel, createServerPromise } from "mobius";
import { peek, redact, Redacted } from "redact";
import { BoundStatement, Credentials } from "sql";
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
 * import { Foo } from "./foo";
 * import { Foo as isFoo } from "./foo!validators";
 * execute(db, sql`SELECT * FROM foo`, isFoo).then((results: Foo[]) => console.log(results));
 * ~~~
 * @param T type of record to select (usually implied by the validator parameter)
 * @param credentials Credentials of the database to connect to; must be redacted to avoid inclusion in client-side code. Use either [[redact]] or `import { db } from "secrets";` to get credentials
 * @param statement SQL statement to execute. Use [[sql]] to generate a bound statement
 * @param validator Called as values are recieved from the database to validate that they're the proper type. May be called as values are streaming from the database, if database driver supports streaming result sets.
 */
export function execute<T>(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, validator: (record: unknown) => record is T): Promise<T[]>;
/**
 * Executes a SQL statement using the provided credentials
 * ~~~
 * import { db } from "secrets";
 * execute(db, sql`INSERT INTO foo (bar, baz) VALUES (${bar}, ${baz})`);
 * ~~~
 * @param credentials Credentials of the database to connect to; must be redacted to avoid inclusion in client-side code. Use either [[redact]] or `import { db } from "secrets";` to get credentials
 * @param statement SQL statement to execute. Use [[sql]] to generate a bound statement
 */
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>): Promise<any[]>;
export function execute(credentials: Redacted<Credentials>, statement: Redacted<BoundStatement>, validator?: (record: unknown) => boolean): Promise<any> {
	let send: ((record: any) => void) | undefined;
	const records: any[] = [];
	const channel = createServerChannel(validator ? (record: unknown) => {
		if (validator(record)) {
			records.push(record);
		}
	} : records.push.bind(records), (newSend: (record: any) => void) => send = newSend);
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
