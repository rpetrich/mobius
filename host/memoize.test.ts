import memoize, { once } from "./memoize";

describe("memoize", () => {

	it("should pass input through", () => {
		const memoized = memoize((value: any) => value);
		expect(memoized(1)).toBe(1);
		expect(memoized("foo")).toBe("foo");
		const fubar = { foo: "bar" };
		expect(memoized(fubar)).toBe(fubar);
	});

	it("should evaluate", () => {
		const memoized = memoize((value: number) => value * value);
		expect(memoized(1)).toBe(1);
		expect(memoized(2)).toBe(4);
		expect(memoized(3)).toBe(9);
	});

	it("should return same obj when args are same", () => {
		const memoized = memoize((value: number) => ({ foo: "bar" }));
		const zero = memoized(0);
		expect(memoized(0)).toBe(zero);
		const one = memoized(1);
		expect(memoized(1)).toBe(one);
		expect(memoized(1)).not.toBe(zero);
	});

});

describe("once", () => {

	it("only calls implementation once", () => {
		let i = 0;
		const onlyOnce = once(() => ++i);
		expect(onlyOnce()).toBe(1);
		expect(onlyOnce()).toBe(1);
		expect(i).toBe(1);
	});

	it("always throws same exception", () => {
		const onlyOnce = once(() => {
			throw new Error("test");
		});
		try {
			onlyOnce();
		} catch (e1) {
			try {
				onlyOnce();
			} catch (e2) {
				expect(e1).toBe(e2);
			}
		}
	});
});
