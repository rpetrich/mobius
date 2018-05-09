export let dead: boolean;

export function disconnect(): void;
export function flush() : Promise<void>;
export function synchronize() : Promise<void>;
