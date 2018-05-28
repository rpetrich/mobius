import Core from "css-modules-loader-core";
import { relative } from "path";
import { Root as CSSRoot, Rule as CSSRule } from "postcss";
import * as ts from "typescript";
import cssnano from "../cssnano";
import { ModuleMap, StaticAssets, VirtualModule } from "./index";

const cssPathPattern = /\.css$/;

function removeRule(rule: CSSRule) {
	rule.remove();
	return false;
}

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
	if (cssPathPattern.test(path) && ts.sys.fileExists(path)) {
		const fileContents = ts.sys.readFile(path)!;
		fileRead(path);
		// Generate a prefix for our local selectors
		const relativePath = relative(ts.sys.getCurrentDirectory(), path);
		const sanitisedPath = relativePath.replace(/\.[^\.\/\\]+$/, "").replace(/[\W_]+/g, "_").replace(/^_|_$/g, "");
		let deadPattern: RegExp | undefined;
		const names: { [name: string]: number; } = {};
		let i: number = 0;
		const pluginChain = [Core.values, Core.localByDefault, Core.extractImports, Core.scope({ generateScopedName }), (root: CSSRoot) => {
			// Walk stylesheet and remove unused rules
			if (typeof deadPattern !== "undefined") {
				root.walkRules(deadPattern, removeRule);
			}
		}];
		// Use cssnano to minify if necessary
		if (minify) {
			pluginChain.push(cssnano());
		}
		// Compile using the plugin chain
		const core = new Core(pluginChain);
		let result = compile();
		function compile() {
			const lazy: any = core.load(fileContents, relativePath);
			return {
				css: lazy.injectableSource as string,
				exportTokens: lazy.exportTokens as { [symbolName: string]: string },
				map: lazy.map,
			};
		}
		function generateScopedName(exportedName: string) {
			return "_" + sanitisedPath + (minify ? (typeof names[exportedName] == "undefined" ? (names[exportedName] = i++) : names[exportedName]).toString(36) : "_" + exportedName);
		}
		return {
			generateTypeDeclaration() {
				// Generate an export declaration for each class/id name
				return Object.keys(result.exportTokens).map((symbolName) => `export const ${symbolName}: string;`).join("\n");
			},
			generateModule() {
				// Generate an export for each class/id name with the value
				return Object.keys(result.exportTokens).map((symbolName) => `export const ${symbolName} = ${JSON.stringify(result.exportTokens[symbolName])};`).join("\n");
			},
			generateStyles(usedExports?: string[]) {
				if (typeof usedExports !== "undefined" && typeof deadPattern === "undefined") {
					// Recompile with unused rules removed
					const patterns = Object.keys(result.exportTokens).filter((name) => usedExports.indexOf(name) === -1).map((name) => result.exportTokens[name].replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1"));
					if (patterns.length) {
						deadPattern = new RegExp("[#.](" + patterns.join("|") + ")\\b");
						result = compile();
					}
				}
				return { css: result.css, map: result.map };
			},
			instantiateModule(moduleMap: ModuleMap, staticAssets: StaticAssets) {
				const href = moduleMap[path];
				const integrity = staticAssets[href] ? staticAssets[href].integrity : undefined;
				const exports = {};
				Object.defineProperty(exports, "__esModule", { value: true });
				Object.assign(exports, result.exportTokens);
				return (global, sandbox) => {
					global.exports = exports;
					if (typeof href !== "undefined") {
						// Inject a CSS link into the DOM so that the client will get the CSS when server-side rendering
						const link = sandbox.pageRenderer.document.createElement("link");
						link.setAttribute("rel", "stylesheet");
						link.setAttribute("href", href);
						if (integrity) {
							link.setAttribute("integrity", integrity);
						}
						const body = sandbox.pageRenderer.body;
						body.insertBefore(link, body.lastChild && body.lastChild.previousSibling);
					}
				};
			},
		};
	}
}
