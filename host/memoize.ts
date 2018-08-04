// Memoize function calls based on the first argument
export default function memoize<T extends (input: I) => O, I = T extends (input: infer I) => void ? I : void, O = ReturnType<T>>(func: T): (input: I) => O {
	const values = new Map<I, O>();
	return (input: I) => {
		let result = values.get(input);
		if (typeof result !== "undefined" || values.has(input)) {
			return result as O;
		}
		result = func(input);
		values.set(input, result);
		return result;
	};
}

export function once<T>(func: () => T) {
	let result: any;
	let state: number = 0;
	return () => {
		if (state !== 1) {
			if (state === 2) {
				throw result;
			}
			try {
				result = func();
				state = 1;
			} catch (e) {
				state = 2;
				throw result = e;
			}
		}
		return result as T;
	};
}
