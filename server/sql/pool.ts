/** @ignore */
/** SQL Pooling */
/* mobius:shared */

import { BoundStatement, Credentials } from "sql";
import { JsonMap } from "mobius-types";
import * as mysql from "./mysql";
import * as postgresql from "./postgresql";
import * as sqlite from "./sqlite";

export type PoolCallback = (statement: BoundStatement, send: (record: JsonMap) => void) => Promise<void>;

const pools = new WeakMap<Credentials, PoolCallback>();

/** @ignore */
export default function(credentials: Credentials): PoolCallback {
	let pool = pools.get(credentials);
	if (!pool) {
		pool = ((require(`./${credentials.type}`) as typeof mysql & typeof postgresql & typeof sqlite).default as (credentials: Credentials) => PoolCallback)(credentials);
		pools.set(credentials, pool);
	}
	return pool;
}
