export { execute, sql } from "sql-impl";

export interface Credentials {
	readonly type: "mysql" | "postgresql";
	readonly host: string;
	readonly user: string;
	readonly password?: string;
}

export interface BoundStatement {
	readonly literals: ReadonlyArray<string>;
	readonly values: ReadonlyArray<string>;
}

export interface Record { [column: string]: any; }
