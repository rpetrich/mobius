/** @ignore */
/** MySQL implementation of SQL API */

/* mobius:shared */
import { BoundStatement, Credentials, Record } from "sql";

/** @ignore */
export default function(credentials: Credentials) {
	const pool = new (require("pg").Pool as any)(credentials);
	return async (statement: BoundStatement, record: (record: Record) => void) => {
		let i = 0;
		const result = await pool.query(statement.literals.reduce((accumulator, currentValue) => accumulator + "$" + ++i + currentValue), statement.values);
		for (const row of result.rows) {
			record(Object.assign({}, row));
		}
	};
}
