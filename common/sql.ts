/**
 * Queries/executes statements on relational SQL databases accessible to the server
 */

/** @ignore */
export { execute, sql } from "sql-impl";

/**
 * Represents credentials used to connect a remote database. Only useful when wrapped in a [[Redacted]], usually read from `secrets`
 */
export interface RemoteCredentials {
	/** Hostname to connect to */
	readonly host: string;
	/** Username to connect with */
	readonly user: string;
	/** Password to connect using */
	readonly password?: string;
	/** Database on the server to connect to */
	readonly database?: string;
}

/**
 * Represents credentials used to connect a local database. Only useful when wrapped in a [[Redacted]], usually read from `secrets`
 */
export interface FileCredentials {
	/** Path to open as a database */
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
	/** Static portions of the statement */
	readonly literals: ReadonlyArray<string>;
	/** Values to interleave with the static portions of the statement */
	readonly values: ReadonlyArray<string>;
}
