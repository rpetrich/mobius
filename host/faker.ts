import { ConcurrenceChannel, ConcurrenceJsonValue } from "concurrence-types";

export interface ConcurrenceServer {
	insideCallback: boolean;
	dead: boolean;
	whenDisconnected: PromiseLike<void>;
	disconnect(): void;
	flush() : void;
	synchronize() : PromiseLike<void>;
	createClientPromise<T extends ConcurrenceJsonValue | void>(...args: any[]): Promise<T>;
	createServerPromise<T extends ConcurrenceJsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender?: boolean): Promise<T>;
	createClientChannel<T extends Function>(callback: T): ConcurrenceChannel;
	createServerChannel<T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender?: boolean): ConcurrenceChannel;
	showDeterminismWarning(deprecated: string, instead: string): void;
	coordinateValue<T extends ConcurrenceJsonValue>(generator: () => T) : T;
	shareSession() : PromiseLike<string>;
	secrets: { [key: string]: any };
}

export interface FakedGlobals {
	Math: typeof Math;
	Date: typeof Date,
	setInterval: (func: Function, interval: number) => NodeJS.Timer,
	clearInterval: (timerId: NodeJS.Timer) => void,
	setTimeout: (func: Function, delay: number) => NodeJS.Timer,
	clearTimeout: (timerId: NodeJS.Timer) => void
}

export function apply<T extends Partial<FakedGlobals>>(globals: T, concurrence: ConcurrenceServer) : T & FakedGlobals {
	// Override the Math object with one that returns a common stream of random numbers
	const newMath = globals.Math = Object.create(Math);
	newMath.random = concurrence.coordinateValue.bind(null, Math.random.bind(Math));
	// Override the Date object with one that shows determinism errors
	// see: https://stackoverflow.com/a/22402079/4007
	const now = concurrence.coordinateValue.bind(null, Date.now.bind(Date));
	const newDate = globals.Date = function(__Date) {
		// Copy that property!
		for (let i of Object.getOwnPropertyNames(__Date)) {
			if (!(i in Date)) {
				(Date as any)[i] = (__Date as any)[i];
			}
		}
		(Date as typeof __Date).parse = function() {
			if (concurrence.insideCallback) {
				concurrence.showDeterminismWarning("Date.parse(string)", "a date parsing library");
			}
			return __Date.parse.apply(this, arguments);
		}
		const proto = Object.create(__Date.prototype);
		// Format as ISO strings by default (node's default for now, but might not be later)
		proto.toString = proto.toISOString;
		Date.prototype = proto;
		return Date as typeof __Date;
		function Date(this: any) {
			let args = [...arguments];
			args.unshift(this);
			if (this instanceof __Date) {
				switch (args.length) {
					case 0:
						break;
					case 1:
						args.push(now());
						break;
					case 2:
						if (typeof args[1] != "number" && concurrence.insideCallback) {
							concurrence.showDeterminismWarning("new Date(string)", "a date parsing library");
						}
						break;
					default:
						if (concurrence.insideCallback) {
							concurrence.showDeterminismWarning("new Date(...)", "new Date(Date.UTC(...))");
						}
						break;
				}
				let result = new (Function.prototype.bind.apply(__Date, args));
				(Object as any).setPrototypeOf(result, proto);
				return result;
			} else {
				return new __Date(now()).toUTCString();
			}
		}
	}(Date);
	newDate.now = now;
	// Override timers with ones that are coordinated between client/server
	const timers: { [ id: number] : ConcurrenceChannel } = {};
	let currentTimerId = 0;

	let registeredCleanup = false;
	function registerCleanup() {
		if (!registeredCleanup) {
			registeredCleanup = true;
			concurrence.whenDisconnected.then(() => {
				for (var i in timers) {
					if (Object.hasOwnProperty.call(timers, i)) {
						timers[i].close();
					}
				}
			});
		}
	}

	const realSetInterval = setInterval;
	const realClearInterval = clearInterval;

	globals.setInterval = function(func: Function, delay: number) {
		const callback = func.bind(this, Array.prototype.slice.call(arguments, 2)) as () => void;
		if (!concurrence.insideCallback) {
			return realSetInterval(callback, delay);
		}
		registerCleanup();
		const result = --currentTimerId;
		timers[result] = concurrence.createServerChannel(callback, send => realSetInterval(send, delay), realClearInterval, false);
		return result as any as NodeJS.Timer;
	};

	globals.clearInterval = function(intervalId: NodeJS.Timer) {
		if (typeof intervalId == "number" && intervalId < 0) {
			const channel = timers[intervalId];
			if (channel) {
				delete timers[intervalId];
				channel.close();
			}
		} else {
			realClearInterval(intervalId);
		}
	};

	const realSetTimeout = setTimeout;
	const realClearTimeout = clearTimeout;

	globals.setTimeout = function(func: Function, delay: number) {
		const callback = func.bind(this, Array.prototype.slice.call(arguments, 2)) as () => void;
		if (!concurrence.insideCallback) {
			return realSetTimeout(callback, delay);
		}
		registerCleanup();
		const result = --currentTimerId;
		timers[result] = concurrence.createServerChannel(callback, send => realSetTimeout(() => {
			send();
			realClearTimeout(result as any as NodeJS.Timer);
		}, delay), realClearTimeout, false);
		return result as any as NodeJS.Timer;
	};

	globals.clearTimeout = function(timeoutId: NodeJS.Timer) {
		if (typeof timeoutId == "number" && timeoutId < 0) {
			const channel = timers[timeoutId];
			if (channel) {
				delete timers[timeoutId];
				channel.close();
			}
		} else {
			realClearTimeout(timeoutId);
		}
	};
	// Recast now that all fields have been filled
	return globals as (T & FakedGlobals);
}