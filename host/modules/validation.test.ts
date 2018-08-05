import { Compiler, noCache } from "../compiler/compiler";
import { ServerModuleGlobal } from "../compiler/sandbox";
import { packageRelative } from "../fileUtils";
import { VirtualModule } from "./index";
import validation from "./validation";

const app = packageRelative("tests/validators/app.tsx");

describe("integration test", () => {

	describe("validators/point.ts!validators", () => {
		const compiler = new Compiler("client", noCache(), app, [packageRelative("common/main.ts")], false, (path: string) => {
			/* tslint:disable no-empty */
		});
		const validator = validation(packageRelative("tests/validators"), packageRelative("tests/validators/point!validators"), false, () => {
			/* tslint:disable no-empty */
		}, compiler.compilerOptions) as VirtualModule;

		describe("generated type declaration", () => {
			it("should match expected source", () => {
				expect(validator.generateTypeDeclaration()).toMatchSnapshot();
			});
		});

		describe("generated module", () => {
			it("should match expected source", () => {
				expect(validator.generateModule()).toMatchSnapshot();
			});
		});

		describe("instantiated module", () => {
			const fakeGlobal: ServerModuleGlobal = { self: null as any as ServerModuleGlobal, global, require, module, exports: {} };
			fakeGlobal.self = fakeGlobal;
			// Second argument isn't used by validator pseudo-modules
			validator.instantiateModule({}, {})(fakeGlobal, null as any);
			it("should have a Point function", () => {
				expect(typeof fakeGlobal.exports.Point).toBe("function");
			});
			it("should accept a valid Point", () => {
				expect(fakeGlobal.exports.Point({ x: 0, y: 100 })).toBe(true);
			});
			it("should reject an invalid Point", () => {
				expect(fakeGlobal.exports.Point({ x: 0, y: "text" })).toBe(false);
			});
		});

	});

});
