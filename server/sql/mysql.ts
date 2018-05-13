/** @ignore */
/** MySQL implementation of SQL API */

/* mobius:shared */
import { BoundStatement, RemoteCredentials, Record } from "sql";

export default function(credentials: RemoteCredentials) {
	const pool = require("mysql").createPool(credentials);
	return (statement: BoundStatement, recordRead: (record: Record) => void) => new Promise<void>((resolve, reject) => {
		const query = pool.query({
			sql: statement.literals.join("?"),
			values: statement.values,
		});
		query.on("result", (record: any) => recordRead(Object.assign({}, record)));
		query.on("end", resolve);
		query.on("error", reject);
	});
}
