// Memoize function calls based on the first argument
export default function memoize<T extends (input: I) => O, I = T extends (input: infer I) => void ? I : void, O = ReturnType<T>>(func: T): (input: I) => O {
	const values = new Map<I, O>();
	return function(input: I) {
		if (values.has(input)) {
			return values.get(input) as O;
		}
		const result = func(input);
		values.set(input, result);
		return result;
	};
}

export function once<T, S = void>(func: (this: S) => T) {
	let result: any;
	let state: number = 0;
	return function(this: S) {
		if (state !== 1) {
			if (state === 2) {
				throw result;
			}
			try {
				result = func.call(this);
				state = 1;
			} catch (e) {
				state = 2;
				throw result = e;
			}
		}
		return result as T;
	};
}
