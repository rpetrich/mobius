import { VirtualModule } from "./index";
import secrets from "./secrets";
import { ServerModuleGlobal } from "../compiler/sandbox";
import { packageRelative } from "../fileUtils";

describe("integration test", () => {

	describe("secrets/secrets.json", () => {
		const virtualModule = secrets(packageRelative("tests/secrets"), packageRelative("tests/secrets/secrets"), false, () => {}) as VirtualModule;

		describe("generated type declaration", () => {
			it("should match expected source", () => {
				expect(virtualModule.generateTypeDeclaration()).toMatchSnapshot();
			});
		});

		describe("generated module", () => {
			it("should match expected source", () => {
				expect(virtualModule.generateModule()).toMatchSnapshot();
			});
		});

		describe("instantiated module", () => {
			const fakeGlobal: ServerModuleGlobal = { self: null as any as ServerModuleGlobal, global, require, module, exports: {} };
			fakeGlobal.self = fakeGlobal;
			// Second argument isn't used by secrets pseudo-module
			virtualModule.instantiateModule({}, {})(fakeGlobal, null as any);
			it("should have a foo property", () => {
				expect(fakeGlobal.exports.foo).toBe("bar");
			});
			it("should have an integer property", () => {
				expect(fakeGlobal.exports.integer).toBe(42);
			});
		});

	});

});
