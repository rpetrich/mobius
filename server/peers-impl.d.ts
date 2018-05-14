export function share(): Promise<string>;
/** @ignore */
export function getClientIds(): Promise<number[]>;
/** @ignore */
export function addListener(callback: (clientId: number, joined: boolean) => void): void;
/** @ignore */
export function removeListener(callback: (clientId: number, joined: boolean) => void): void;
