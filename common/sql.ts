/**
 * Queries/executes statements on relational SQL databases accessible to the server
 */

export { execute, sql } from "sql-impl";

/**
 * Represents credentials used to connect to the database. Only useful when wrapped in a Redacted
 */
export interface Credentials {
	readonly type: "mysql" | "postgresql";
	readonly host: string;
	readonly user: string;
	readonly password?: string;
}

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
