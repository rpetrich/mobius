import { BoundStatement, Credentials, Record } from "sql";

export default function(credentials: Credentials) {
	const pool = require("mysql").createPool(credentials);
	return (statement: BoundStatement, recordRead: (record: Record) => void) => new Promise<void>((resolve, reject) => {
		const query = pool.query({
			sql: statement.literals.join("?"),
			values: statement.values
		});
		query.on("result", (record: any) => recordRead(Object.assign({}, record)));
		query.on("end", resolve);
		query.on("error", reject);
	});
}
