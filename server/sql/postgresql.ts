/** @ignore */
/** MySQL implementation of SQL API */

/* mobius:shared */
import { JsonMap } from "mobius-types";
import { BoundStatement, RemoteCredentials } from "sql";

/** @ignore */
export default function(credentials: RemoteCredentials) {
	const pool = new (require("pg").Pool as any)(credentials);
	return async (statement: BoundStatement, record: (record: JsonMap) => void) => {
		let i = 0;
		const result = await pool.query(statement.literals.reduce((accumulator, currentValue) => accumulator + "$" + ++i + currentValue), statement.values);
		for (const row of result.rows) {
			record(Object.assign({}, row));
		}
	};
}
