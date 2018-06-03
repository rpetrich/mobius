export const typescript: typeof import ("typescript") = undefined as any;
export const cssnano = undefined as any;
export const chokidar: typeof import ("chokidar") = undefined as any;
export const rimraf: typeof import ("rimraf") = undefined as any;
export const initPackageJson: (path: string, initName: string, callback: (err: any, result?: { main: string }) => void) => void = undefined as any;
export const express: typeof import ("express") = undefined as any;
export const expressUws: any = undefined as any;
export const bodyParser: typeof import ("body-parser") = undefined as any;
export const accepts: typeof import ("accepts") = undefined as any;
export const commandLineUsage: typeof import ("command-line-usage") = undefined as any;
export const init: typeof import ("./init") = undefined as any;
export const bundleCompiler: typeof import ("./compiler/bundle-compiler") = undefined as any;
export const serverCompiler: typeof import ("./compiler/server-compiler") = undefined as any;
export const virtualModule: typeof import ("./modules/index") = undefined as any;
export const staticFileRoute: typeof import ("./static-file-route") = undefined as any;
export const host: typeof import ("./host") = undefined as any;

setupModules({
	typescript: "typescript",
	cssnano: "cssnano",
	chokidar: "chokidar",
	rimraf: "rimraf",
	initPackageJson: "init-package-json",
	express: "express",
	expressUws: "express-uws",
	bodyParser: "body-parser",
	accepts: "accepts",
	commandLineUsage: "command-line-usage",
	init: "./init",
	bundleCompiler: "./compiler/bundle-compiler",
	serverCompiler: "./compiler/server-compiler",
	virtualModule: "./modules/index",
	staticFileRoute: "./static-file-route",
	host: "./host",
});

function setupModules(modulePaths: { readonly [P in keyof typeof import ("./lazy-modules")]: string }) {
	for (const property of Object.keys(modulePaths)) {
		const path = (modulePaths as { [key: string]: string })[property];
		Object.defineProperty(exports, property, {
			configurable: true,
			get() {
				const value = require(path);
				Object.defineProperty(exports, property, {
					configurable: true,
					value
				});
				return value;
			},
		});
	}
}
