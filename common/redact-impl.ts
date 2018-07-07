/** @mobius:shared */
/** */

/**
 * Represents a value that can only be read on the server and is hidden from connected clients
 * @param T type of value that is hidden
 */
export class Redacted<T> {
	/* tslint:disable variable-name */
	/** @ignore */
	protected __suppress_declared_never_used_error?: T;
}
