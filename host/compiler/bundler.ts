import Concat from "concat-with-sourcemaps";
import { CachedChunk, Chunk, Finaliser, OutputOptions, Plugin, SourceDescription } from "rollup";
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

export type CacheData = CachedChunk;

type DependencyData = [string, string] & ReadonlyArray<string | number>;

export async function bundle(compiler: Compiler<CacheData>, appPath: string, publicPath: string, minify: boolean, redact: boolean, fileRead: (path: string) => void): Promise<CompilerOutput> {
	// Dynamically load dependencies to reduce startup time
	const rollupModule = await import("rollup");
	const rollupBabel = requireOnce("rollup-plugin-babel") as typeof _rollupBabel;

	const compiled = compiler.compile();
	const rollupPre: Plugin = {
		name: "mobius-pre",
		async resolveId(importee: string, importer: string | undefined) {
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
		async transform(code, id) {
			const output = compiled.getEmitOutput(id.toString());
			if (output) {
				return {
					code: output.code,
					map: typeof output.map === "string" ? JSON.parse(output.map) : undefined,
				};
			}
		},
	};
	const plugins = [
		rollupPre,
		// Transform the intermediary phases via babel
		rollupBabel({
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
		}),
	];

	// If minifying, use Closure Compiler
	if (minify) {
		plugins.push(requireOnce("rollup-plugin-closure-compiler-js")({
			languageIn: "ES5",
			languageOut: "ES3",
			assumeFunctionWrapper: false,
			rewritePolyfills: false,
		}) as Plugin);
	}

	const mainChunkId = "./main.js";
	const routes: { [path: string]: CompiledRoute } = {};
	const moduleMap: ModuleMap = {};
	const routeIndexes: string[] = [];
	plugins.push({
		name: "mobius-post",
		transform(code, id) {
			// Track input files read so the --watch option works
			fileRead(id.toString());
			return Promise.resolve();
		},
		ongenerate(options: OutputOptions, source: SourceDescription) {
			// Collect output into routes
			const path = ((options as any).bundle.name as string);
			routes[path.substr(1)] = {
				route: staticFileRoute(minify && path != mainChunkId ? "/" + routeIndexes.indexOf(path).toString(36) + ".js" : path.substr(1), source.code),
				map: source.map!,
			};
		},
	});
	const moduleDependencies: { [name: string]: Array<string | number> } = {};
	const customFinalizer: Finaliser = {
		finalise(
			chunk: Chunk,
			magicString,
			{
				exportMode,
				getPath,
				indentString,
				intro,
				outro,
				dynamicImport,
			}: {
				exportMode: string;
				indentString: string;
				getPath: (name: string) => string;
				intro: string;
				outro: string;
				dynamicImport: boolean;
			},
			options: OutputOptions,
		) {
			const isMain = chunk.id === mainChunkId;

			// Bundle any CSS provided by the modules in the chunk (only virtual modules can provide CSS)
			const cssModuleName = chunk.id.replace(/(\.js)?$/, ".css");
			const css = new Concat(true, cssModuleName, minify ? "" : "\n\n");
			const bundledCssModulePaths: string[] = [];
			for (const module of chunk.orderedModules) {
				const virtualModule = compiled.getVirtualModule(module.id);
				if (virtualModule && virtualModule.generateStyles) {
					bundledCssModulePaths.push(module.id);
					const variables = module.scope.variables;
					const usedVariables: string[] = [];
					for (const key of Object.keys(variables)) {
						if (variables[key].included) {
							usedVariables.push(variables[key].name);
						}
					}
					const styles = virtualModule.generateStyles(variables.this.included ? undefined : usedVariables);
					if (styles.css) {
						css.add(module.id, styles.css, styles.map);
					}
				}
			}

			// Register CSS route
			let cssRoute: StaticFileRoute | undefined;
			const cssString = css.content.toString();
			if (cssString) {
				const mapString = css.sourceMap;
				const cssMap = mapString ? JSON.parse(mapString) : undefined;
				cssRoute = staticFileRoute(cssModuleName.substr(1), cssString);
				if (!isMain) {
					routeIndexes.push(cssModuleName);
				}
				for (const bundledModuleName of bundledCssModulePaths) {
					moduleMap[bundledModuleName.replace(declarationOrJavaScriptPattern, "")] = cssRoute.foreverPath;
				}
				routes[cssModuleName.substr(1)] = {
					route: cssRoute,
					map: cssMap,
				};
			}

			const { dependencies, exports } = chunk.getModuleDeclarations();

			// Generate code to ask for and receive imported modules
			const mainIndex = dependencies.findIndex((m) => m.id === mainChunkId);
			let mainIdentifier: string = "__main_js";
			if (mainIndex !== -1) {
				mainIdentifier = dependencies[mainIndex].name;
				dependencies.splice(mainIndex, 1);
			}
			const deps = dependencies.map((m) => m.id).concat(cssRoute ? [cssModuleName] : []).map((id) => minify ? routeIndexes.indexOf(id) : getPath(id));
			moduleDependencies[chunk.id] = deps;
			const args = dependencies.map((m) => m.name);
			if (args.length || mainIndex !== -1) {
				args.unshift(mainIdentifier);
			}
			args.unshift("_import");

			// Generate code to write exported symbols into the exports object
			args.unshift("exports");
			const exportBlock = rollupModule.getExportBlock(exports, dependencies, exportMode);
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
					const route = routes[name.substr(1)].route;
					const result: DependencyData = [route.foreverPath, route.integrity];
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
				const argumentJSON = JSON.stringify([minify ? routeIndexes.indexOf(chunk.id) : chunk.id].concat(deps));
				magicString.append(", " + argumentJSON.substr(1, argumentJSON.length - 2) + ")");
			}

			return magicString;
		},
		dynamicImportMechanism: {
			// Replace import("path") with _import(moduleId)
			left: "_import(",
			right: ")",
			replacer(text: string) {
				if (minify) {
					return routeIndexes.indexOf(JSON.parse(text)).toString();
				}
			},
		},
	};
	const bundle = await rollupModule.rollup({
		input: [packageRelative("common/main.js")],
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
		experimentalDynamicImport: true,
		aggressivelyMergeModules: true,
		minifyInternalNames: minify,
	});
	// Extract the prepared chunks
	let cacheSave: Promise<void> | undefined;
	if ("chunks" in bundle) {
		const newCache: CacheData = { modules: [] };
		const chunks = bundle.chunks;
		for (const chunkName of Object.keys(chunks)) {
			if (chunkName !== mainChunkId) {
				routeIndexes.push(chunkName);
			}
			for (const module of chunks[chunkName].modules) {
				newCache.modules.push(module);
			}
		}
		cacheSave = compiled.saveCache(newCache);
	}
	// Generate the output, using our custom finalizer for client
	await bundle.generate({
		format: customFinalizer,
		sourcemap: true,
		name: "app",
		legacy: true,
	});
	await cacheSave;
	return {
		routes,
		moduleMap,
	};
}
