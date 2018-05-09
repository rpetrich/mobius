import { JsonArray, JsonMap, JsonValue } from "mobius-types";
import { peek, Redacted } from "redact";

export function send(topic: string, message: JsonValue): void;
export function addListener(topic: string, callback: (message: JsonValue) => void): void;
export function removeListener(topic: string, callback: (message: JsonValue) => void): void;
