/**
 * Queries/executes statements on relational SQL databases accessible to the server
 */

export { execute, sql } from "sql-impl";

/**
 * Represents credentials used to connect a remote database. Only useful when wrapped in a [[Redacted]], usually read from `secrets`
 */
export interface RemoteCredentials {
	readonly host: string;
	readonly user: string;
	readonly password?: string;
	readonly database?: string;
}

/**
 * Represents credentials used to connect a local database. Only useful when wrapped in a [[Redacted]], usually read from `secrets`
 */
export interface FileCredentials {
	readonly path: string;
}

/**
 * Represents credentials used to connect to a database. Only useful when wrapped in a [[Redacted]], usually read from `secrets`
 */
export type Credentials = ({ readonly type: "mysql" | "postgresql" } & RemoteCredentials) | ({ readonly type: "sqlite" } & FileCredentials);

/**
 * Represents a bound statement with parameters filled via sql
 */
export interface BoundStatement {
	readonly literals: ReadonlyArray<string>;
	readonly values: ReadonlyArray<string>;
}

/**
 * Represents a single record in the response from the database
 */
export interface Record { [column: string]: any; }
