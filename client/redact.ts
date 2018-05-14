export { Redacted } from "redact-impl";
import { Redacted } from "redact-impl";

export function redact<T>(value: T) {
	return new Redacted<T>();
}
