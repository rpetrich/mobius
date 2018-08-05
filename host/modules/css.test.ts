import { packageRelative } from "../fileUtils";
import css from "./css";
import { VirtualModule } from "./index";

describe("integration test", () => {

	describe("css/styles.css", () => {
		const virtualModule = css(packageRelative("tests/css"), packageRelative("tests/css/styles.css"), false, () => {}) as VirtualModule;

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

		describe("generated styles", () => {
			const styles = virtualModule.generateStyles!(["styled"]);
			it("should match expected source", () => {
				expect(styles.css).toMatchSnapshot();
			});
		});

	});

});
