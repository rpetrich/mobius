import { JsonArray, JsonMap, JsonValue } from "mobius-types";
import { peek, Redacted } from "redact";

/** @ignore */
export function send(topic: string, message: JsonValue): void;
/** @ignore */
export function addListener(topic: string, callback: (message: JsonValue) => void): void;
/** @ignore */
export function removeListener(topic: string, callback: (message: JsonValue) => void): void;
