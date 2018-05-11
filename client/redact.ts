export class Redacted<T> {
	/* tslint:disable variable-name */
	/** @ignore */
	protected __suppress_declared_never_used_error?: T;
}

export function redact<T>(value: T) {
	return new Redacted<T>();
}
