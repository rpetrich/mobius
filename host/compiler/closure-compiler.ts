export default function closure() {
	return {
		name: "closure-compiler",
		transformBundle(src: string) {
			const { compile } = require("google-closure-compiler-js");
			const output = compile({
				languageIn: "ES5",
				languageOut: "ES5",
				assumeFunctionWrapper: false,
				rewritePolyfills: false,
				createSourceMap: true,
				processCommonJsModules: true,
				jsCode: [{ src }],
			});
			return {
				code: output.compiledCode,
				map: output.sourceMap,
			};
		},
	};
}
