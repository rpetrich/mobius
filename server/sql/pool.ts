/** @ignore */
/** SQL Pooling */
/* mobius:shared */

import { BoundStatement, Credentials, Record } from "sql";
import * as mysql from "./mysql";
import * as postgresql from "./postgresql";
import * as sqlite from "./sqlite";

export type PoolCallback = (statement: BoundStatement, send: (record: Record) => void) => Promise<void>;

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
