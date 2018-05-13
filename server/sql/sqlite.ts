/** @ignore */
/** SQLite implementation of SQL API */

/* mobius:shared */
import { JsonMap } from "mobius-types";
import { BoundStatement, FileCredentials } from "sql";

export default function(credentials: FileCredentials) {
	const database = new (require("sqlite3")).Database(credentials.path);
	return (statement: BoundStatement, recordRead: (record: JsonMap) => void) => new Promise<void>((resolve, reject) => {
		database.each.apply(database, [statement.literals.join("?"), statement.values, (error: any, record: JsonMap) => {
			if (error) {
				reject(error);
			} else {
				recordRead(record);
			}
		}, (error: any) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		}]);
	});
}
