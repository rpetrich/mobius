import Concat from "concat-with-sourcemaps";
import { Finaliser, OutputOptions, Plugin, RollupCache } from "rollup";
import _rollupBabel from "rollup-plugin-babel";
import { RawSourceMap } from "source-map";
import { packageRelative } from "../fileUtils";
import memoize from "../memoize";
import { ModuleMap } from "../modules/index";
import { staticFileRoute, StaticFileRoute } from "../static-file-route";
import { Compiler } from "./compiler";

export interface CompiledRoute {
	route: StaticFileRoute;
	map?: RawSourceMap;
}

export interface CompilerOutput {
	routes: { [path: string]: CompiledRoute };
	moduleMap: ModuleMap;
}

const declarationOrJavaScriptPattern = /\.(d\.ts|js)$/;

const requireOnce = memoize(require);

type PluginReference = [string | Function, any] | [string | Function];

function lazilyLoadedBabelPlugins(references: PluginReference[]): any[] {
	const result: any[] = [];
	for (let i = 0; i < references.length; i++) {
		const ref = references[i];
		const name = ref[0];
		if (typeof name === "string") {
			Object.defineProperty(result, i, {
				configurable: true,
				get() {
					const plugin = requireOnce(name);
					const value = [plugin.default || plugin, ref[1] || {}];
					Object.defineProperty(result, i, {
						configurable: true,
						value,
					});
					return value;
				},
			});
		} else {
			result[i] = ref;
		}
	}
	result.length = references.length;
	return result;
}

export type CacheData = RollupCache;

type DependencyData = [string, string] & ReadonlyArray<string | number>;

export async function bundle(compiler: Compiler<CacheData>, appPath: string, publicPath: string, minify: boolean, redact: boolean, fileRead: (path: string) => void): Promise<CompilerOutput> {
	// Dynamically load dependencies to reduce startup time
	const rollupModule = await import("rollup");
	const rollupBabel = requireOnce("rollup-plugin-babel") as typeof _rollupBabel;

	const compiled = compiler.compile();
	const rollupPre: Plugin = {
		name: "mobius-pre",
		resolveId(importee: string, importer: string | undefined) {
			// Windows
			if (importer) {
				importer = importer.replace(/\\/g, "/");
			}
			try {
				const result = compiled.resolveModule(importee, importer !== undefined ? importer : compiler.basePath);
				if (result) {
					return result.resolvedFileName;
				}
			} catch (e) {
				if (!e || e.code !== "MODULE_NOT_FOUND") {
					throw e;
				}
			}
		},
		load(id: string) {
			const module = compiled.getVirtualModule(id);
			if (module) {
				return module.generateModule();
			}
		},
		transform(code, id) {
			const output = compiled.getEmitOutput(id.toString());
			if (output) {
				let code = output.code;
				const mappingIndex = code.lastIndexOf("//# sourceMap" + "pingURL=");
				if (mappingIndex !== -1) {
					const newlineIndex = code.indexOf("\n", mappingIndex);
					if (newlineIndex !== -1) {
						code = code.substring(0, mappingIndex) + code.substring(newlineIndex);
					} else {
						code = code.substring(0, mappingIndex);
					}
				}
				return {
					code,
					map: typeof output.map === "string" ? JSON.parse(output.map) : undefined,
				};
			}
		},
	};

	// Transform the intermediary phases via babel
	const babelPlugin = rollupBabel({
		babelrc: false,
		presets: [],
		plugins: lazilyLoadedBabelPlugins(([
			["babel-plugin-syntax-dynamic-import"],
			["babel-plugin-external-helpers"],
			["babel-plugin-transform-async-to-promises", { externalHelpers: true, hoist: true, minify: true }],
			["babel-plugin-optimize-closures-in-render"],
		] as PluginReference[]).concat(redact ? [["./stripRedactedArguments"]] as PluginReference[] : []).concat([
			["./fixTypeScriptExtendsWarning"],
			["./noImpureGetters"],
			["./simplifyVoidInitializedVariables"],
			["./stripUnusedArgumentCopies"],
			// Replacement for babel-preset-env
			["babel-plugin-check-es2015-constants"],
			["babel-plugin-syntax-trailing-function-commas"],
			["babel-plugin-transform-es2015-arrow-functions"],
			["babel-plugin-transform-es2015-block-scoped-functions"],
			["babel-plugin-transform-es2015-block-scoping"],
			["babel-plugin-transform-es2015-classes"],
			["babel-plugin-transform-es2015-computed-properties"],
			["babel-plugin-transform-es2015-destructuring"],
			["babel-plugin-transform-es2015-duplicate-keys"],
			["babel-plugin-transform-es2015-for-of"],
			["babel-plugin-transform-es2015-function-name"],
			["babel-plugin-transform-es2015-literals"],
			["babel-plugin-transform-es2015-object-super"],
			["babel-plugin-transform-es2015-parameters"],
			["babel-plugin-transform-es2015-shorthand-properties"],
			["babel-plugin-transform-es2015-spread"],
			["babel-plugin-transform-es2015-sticky-regex"],
			["babel-plugin-transform-es2015-template-literals"],
			["babel-plugin-transform-es2015-typeof-symbol"],
			["babel-plugin-transform-es2015-unicode-regex"],
			["babel-plugin-transform-exponentiation-operator"],
			["./simplifyTypeof"],
		])),
	});

	const plugins = [rollupPre, babelPlugin];
	// If minifying, use Closure Compiler
	if (minify) {
		plugins.push(requireOnce("rollup-plugin-closure-compiler-js")({
			languageIn: "ES5",
			languageOut: "ES3",
			assumeFunctionWrapper: false,
			rewritePolyfills: false,
		}) as Plugin);
	}

	let remainingOutputCount = 0;
	let resolveOutput: () => void | undefined;
	const waitForOutput = new Promise((resolve) => resolveOutput = resolve);
	plugins.push({
		name: "mobius-post",
		transform(code, id) {
			// Track input files read so the --watch option works
			fileRead(id.toString());
		},
		ongenerate(options, chunk) {
			const path = chunk.map!.file;
			routes[path] = {
				route: staticFileRoute("/" + (minify && path != mainChunkId ? routeIndexes.indexOf(path).toString(36) + ".js" : path), chunk.code),
				map: chunk.map!,
			};
			if (--remainingOutputCount === 0) {
				resolveOutput!();
			}
		},
	});

	const mainChunkId = "main.js";
	const routes: { [path: string]: CompiledRoute } = {};
	const moduleMap: ModuleMap = {};
	const routeIndexes: string[] = [];
	const moduleDependencies: { [name: string]: Array<string | number> } = {};
	const routeReferenceForId = (id: string) => {
		let index = routeIndexes.indexOf(id);
		if (index === -1) {
			index = routeIndexes.length;
			routeIndexes.push(id);
		}
		return minify ? index : id;
	};
	const customFinalizer: Finaliser = {
		name: minify ? "mobius-minified" : "mobius",
		supportsCodeSplitting: true,
		async finalise(
			magicString,
			{
				id,
				dependencies,
				modules,
				exports,
				namedExportsMode,
				generateExportBlock,
			},
			options: OutputOptions,
		) {
			dependencies = dependencies.slice();
			const isMain = id === mainChunkId;
			if (isMain) {
				// Coordinate with output of other finalizers
				await Promise.resolve();
				if (remainingOutputCount === 0) {
					resolveOutput!();
				}
				await waitForOutput;
			} else {
				if (routeIndexes.indexOf(id) === -1) {
					routeIndexes.push(id);
				}
				remainingOutputCount++;
			}

			// Bundle any CSS provided by the modules in the chunk (only virtual modules can provide CSS)
			const cssModuleName = id.replace(/(\.js)?$/, ".css");
			const css = new Concat(true, cssModuleName, minify ? "" : "\n\n");
			const bundledCssModulePaths: string[] = [];
			for (const moduleId of Object.keys(modules)) {
				const virtualModule = compiled.getVirtualModule(moduleId);
				if (virtualModule && virtualModule.generateStyles) {
					bundledCssModulePaths.push(moduleId);
					const styles = virtualModule.generateStyles(modules[moduleId].renderedExports);
					if (styles.css) {
						css.add(moduleId, styles.css, styles.map);
					}
				}
			}

			// Register CSS route
			let cssRoute: StaticFileRoute | undefined;
			const cssString = css.content.toString();
			if (cssString) {
				const mapString = css.sourceMap;
				const cssMap = mapString ? JSON.parse(mapString) : undefined;
				cssRoute = staticFileRoute("/" + cssModuleName, cssString);
				if (!isMain && routeIndexes.indexOf(cssModuleName) === -1) {
					routeIndexes.push(cssModuleName);
				}
				for (const bundledModuleName of bundledCssModulePaths) {
					moduleMap[bundledModuleName.replace(declarationOrJavaScriptPattern, "")] = cssRoute.foreverPath;
				}
				routes[cssModuleName] = {
					route: cssRoute,
					map: cssMap,
				};
			}

			// Generate code to ask for and receive imported modules
			const mainIndex = dependencies.findIndex((m) => m.id === "./" + mainChunkId);
			let mainIdentifier: string = "main";
			if (mainIndex !== -1) {
				mainIdentifier = dependencies[mainIndex].name;
				dependencies.splice(mainIndex, 1);
			}
			const deps = dependencies.map((m) => m.id.substring(2)).concat(cssRoute && !isMain ? [cssModuleName] : []).map(routeReferenceForId);
			moduleDependencies[id] = deps;
			const args = dependencies.map((m) => m.name);
			if (args.length || mainIndex !== -1) {
				args.unshift(mainIdentifier);
			}
			args.unshift("_import");

			// Generate code to write exported symbols into the exports object
			args.unshift("exports");
			const exportBlock = generateExportBlock();
			if (exportBlock) {
				magicString.append("\n\n" + exportBlock, {});
			}
			magicString.append("\n}", {});

			if (isMain) {
				args.push("document");
				if (cssRoute) {
					// Coordinate load with the main.css so that we don't inadvertently mutate the DOM before it's ready
					magicString.prepend(
						`var i=0,` +
						`stylesheets=document.querySelectorAll("link"),` +
						`link=document.createElement("link");` +
						`link.href=${JSON.stringify(cssRoute.foreverPath)};` +
						`if("onload" in link){` +
							`for(_mobius=link.onload=loaded;i<stylesheets.length;i++)` +
								`if(stylesheets[i].href==link.href)` +
									`return stylesheets[i].sheet ? loaded() : stylesheets[i].onload=loaded;` +
						`}else ` +
							`main();` +
						`link.rel="stylesheet";` +
						`link.setAttribute("integrity",${JSON.stringify(cssRoute.integrity)});` +
						`document.head.appendChild(link);` +
						`function loaded(){` +
							`main();` +
							`if(link=document.querySelector("style#mobius-inlined"))` +
								`link.parentNode.removeChild(link)` +
						`}` +
						`function main() {\n`);
				} else {
					magicString.prepend(`\n`);
				}
				// Add JavaScript equivalent of frame-ancestors 'none'
				magicString.prepend(
					`if (top != self) {` +
						`document.open();` +
						`document.close();` +
						`return;` +
					`}`);
				// Check that property iteration matches V8's behavior and that there aren't additional properties on Array or Object's prototype
				magicString.prepend(
					`var unspecifiedBehaviorCheck = [0], unspecifiedBehaviorOrder = [{ a: 0, 0: 0, length: 0 }], k;` +
					`unspecifiedBehaviorCheck["1"] = unspecifiedBehaviorCheck["a"] = 0;` +
					`for (k in unspecifiedBehaviorCheck) ` +
						`unspecifiedBehaviorOrder.push(k);` +
					`for (k in unspecifiedBehaviorOrder[0]) ` +
						`unspecifiedBehaviorOrder.push(k);` +
					`unspecifiedBehaviorOrder.push(unspecifiedBehaviorCheck.length);` +
					`if (JSON.stringify(unspecifiedBehaviorOrder) != '[{"0":0,"a":0,"length":0},"0","1","a","0","a","length",2]') ` +
						`return;`);
				// Add sanity check for prerequisites, will early exit to fallback
				magicString.prepend(
					`if (!Object.keys) ` +
						`return;`);
				// Add IIFE wrapper
				magicString.prepend(`(function(${args.join(", ")}) {`);
				function loadDataForModuleWithName(name: string): DependencyData {
					const route = routes[name].route;
					const result: DependencyData = [route.foreverPath.substr(1), route.integrity];
					if (Object.hasOwnProperty.call(moduleDependencies, name)) {
						return result.concat(moduleDependencies[name]) as DependencyData;
					}
					return result;
				}
				// Insert imports mapping, using an array and indexes when minified
				let imports: DependencyData[] | { [name: string]: DependencyData };
				if (minify) {
					imports = routeIndexes.map(loadDataForModuleWithName);
				} else {
					const importsObject: { [path: string]: string[] } = imports = {};
					routeIndexes.forEach((path) => importsObject[path] = loadDataForModuleWithName(path));
				}
				if (cssRoute) {
					magicString.append("}");
				}
				magicString.append(`)({}, ${JSON.stringify(imports)}, document)`);
			} else {
				// Generate code to inform the loader that our module's content has loaded
				magicString.prepend(`_mobius(function(${args.join(", ")}) {\n`);
				const argumentJSON = JSON.stringify([minify ? routeIndexes.indexOf(id) : id].concat(deps));
				magicString.append(", " + argumentJSON.substr(1, argumentJSON.length - 2) + ")");
			}

			return magicString;
		},
		finaliseDynamicImport(magicString, { importRange, argumentRange }) {
			magicString.overwrite(importRange.start, argumentRange.start, `_import(`);
			magicString.overwrite(argumentRange.end, importRange.end, `)`);
		},
		dynamicImportArgument(path) {
			return JSON.stringify(routeReferenceForId(path.substring(2)));
		},
		reservedIdentifiers: ["_import"],
	};
	const bundle = await rollupModule.rollup({
		input: [packageRelative("common/main.ts")],
		cache: compiler.cache.data,
		external(id: string, parentId: string, isResolved: boolean) {
			return false;
		},
		plugins,
		acorn: {
			allowReturnOutsideFunction: true,
		},
		// Use experimental rollup features, including the aggressive merging features our fork features
		experimentalCodeSplitting: true,
		experimentalPreserveModules: false,
		aggressivelyMergeIntoEntryPoint: true,
		inlineDynamicImports: false,
	});
	const cacheSave = compiled.saveCache(bundle.cache);
	// Generate the output, using our custom finalizer for client
	const output = (await bundle.generate({
		format: customFinalizer,
		sourcemap: true,
		name: "app",
		compact: minify,
	})).output;
	// Fill in source maps
	for (const id of Object.keys(output)) {
		const chunk = output[id];
		if (typeof chunk !== "string" && !(chunk instanceof Buffer)) {
			routes[id].map = chunk.map;
		}
	}
	await cacheSave;
	return {
		routes,
		moduleMap,
	};
}
