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

export function once<T>(func: () => T) {
	let result: T | undefined;
	let hasAsked: boolean = false;
	return () => {
		if (!hasAsked) {
			result = func();
			hasAsked = true;
		}
		return result as T;
	};
}
