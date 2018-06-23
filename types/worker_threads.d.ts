declare module "worker_threads" {
	type EventListener = (event: Event) => void;
	type ErrorEvent = Event;

	export const isMainThread: boolean;

	interface WorkerEventMap extends AbstractWorkerEventMap {
		"message": MessageEvent;
	}

	interface MessageEvent extends Event {
		readonly data: any;
		readonly origin: string;
		readonly ports: ReadonlyArray<MessagePort>;
	}

	interface MessagePortEventMap {
		"message": MessageEvent;
	}

	interface MessagePort {
		onmessage: ((this: MessagePort, ev: MessageEvent) => any) | null;
		close(): void;
		postMessage(message?: any, transfer?: any[]): void;
		start(): void;
		addListener<K extends keyof MessagePortEventMap>(type: K, listener: (this: MessagePort, ev: MessagePortEventMap[K]) => any): void;
		addListener(type: string, listener: EventListener): void;
		removeListener<K extends keyof MessagePortEventMap>(type: K, listener: (this: MessagePort, ev: MessagePortEventMap[K]) => any): void;
		removeListener(type: string, listener: EventListener): void;
	}

	export const parentPort: MessagePort | undefined;
	export const workerData: any;

	interface AbstractWorkerEventMap {
		"error": ErrorEvent;
	}

	interface AbstractWorker {
		onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null;
		addListener<K extends keyof AbstractWorkerEventMap>(type: K, listener: (this: AbstractWorker, ev: AbstractWorkerEventMap[K]) => any): void;
		addListener(type: string, listener: EventListener): void;
		removeListener<K extends keyof AbstractWorkerEventMap>(type: K, listener: (this: AbstractWorker, ev: AbstractWorkerEventMap[K]) => any): void;
		removeListener(type: string, listener: EventListener): void;
	}

	interface WorkerEventMap extends AbstractWorkerEventMap {
		"message": MessageEvent;
	}

	export class Worker implements AbstractWorker {
		constructor(path: string, options?: { readonly workerData?: any });
		onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null;
		onmessage: ((this: Worker, ev: MessageEvent) => any) | null;
		postMessage(message: any, transfer?: any[]): void;
		terminate(callback?: () => void): void;
		addListener<K extends keyof WorkerEventMap>(type: K, listener: (this: Worker, ev: WorkerEventMap[K]) => any): void;
		addListener(type: string, listener: EventListener): void;
		removeListener<K extends keyof WorkerEventMap>(type: K, listener: (this: Worker, ev: WorkerEventMap[K]) => any): void;
		removeListener(type: string, listener: EventListener): void;
	}
}
