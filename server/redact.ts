/* mobius:shared */
const symbol = Symbol();

export class Redacted<T> {
	/* tslint:disable variable-name */
	public __suppress_declared_never_used_error?: T;
	constructor(value: T) {
		Object.defineProperty(this, symbol, { value });
	}
}

export function peek<T>(value: T | Redacted<T>) {
	return value instanceof Redacted ? (value as any)[symbol] as T : value;
}

export function redact<T>(value: T) {
	return new Redacted<T>(value);
}
