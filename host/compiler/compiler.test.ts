import { noCache, Compiler } from "./compiler";
import { packageRelative } from "../fileUtils";

const randomness = packageRelative("tests/randomness/app.tsx");

describe("Compiler", () => {

	describe("server", () => {
		const compiler = new Compiler("server", noCache(), randomness, [packageRelative("server/dom-ambient.d.ts"), packageRelative("common/main.ts")], false, (path: string) => {
		});
		const compiled = compiler.compile();
		it("randomness/app.tsx output", () => {
			const output = compiled.getEmitOutput(randomness) as { code: string }
			expect(output.code).toMatchSnapshot();
		});
	});

	describe("client", () => {
		const compiler = new Compiler("client", noCache(), randomness, [packageRelative("common/main.ts")], false, (path: string) => {
		});
		const compiled = compiler.compile();
		it("randomness/app.tsx output", () => {
			const output = compiled.getEmitOutput(randomness) as { code: string }
			expect(output.code).toMatchSnapshot();
		});
	});

});
