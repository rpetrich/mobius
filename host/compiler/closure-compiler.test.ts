import closure from "./closure-compiler";
describe("closure", () => {
	it("should name itself", () => {
		expect(closure().name).toBe("closure-compiler");
	});
	it("should compress javascript", () => {
		expect(closure().transformBundle(`window.foo = function(bar) { return bar * bar; }`)).toMatchSnapshot();
	});
});
