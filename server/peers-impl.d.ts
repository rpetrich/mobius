export function getClientIds(): Promise<number[]>;
export function addListener(callback: (clientId: number, joined: boolean) => void): void;
export function removeListener(callback: (clientId: number, joined: boolean) => void): void;
export function share(): Promise<string>;
