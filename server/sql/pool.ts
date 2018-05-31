/** @ignore */
/** SQL Pooling */
/* mobius:shared */

import { JsonMap } from "mobius-types";
import { BoundStatement, Credentials } from "sql";

export type PoolCallback = (statement: BoundStatement, send: (record: JsonMap) => void) => Promise<void>;

const pools = new WeakMap<Credentials, PoolCallback>();

/** @ignore */
export default function(credentials: Credentials): PoolCallback {
	let pool = pools.get(credentials);
	if (!pool) {
		pool = ((require(`./${credentials.type}`) as typeof import("./mysql") & typeof import("./postgresql") & typeof import("./sqlite")).default as (credentials: Credentials) => PoolCallback)(credentials);
		pools.set(credentials, pool);
	}
	return pool;
}
