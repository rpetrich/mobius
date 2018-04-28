export class Redacted<T> {
	/* tslint:disable variable-name */
	public __suppress_declared_never_used_error?: T;
}

export function redact<T>(value: T) {
	return new Redacted<T>();
}
