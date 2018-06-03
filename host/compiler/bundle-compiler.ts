import Concat from "concat-with-sourcemaps";
import { resolve } from "path";
import { CachedChunk, Chunk, Finaliser, OutputOptions, Plugin, SourceDescription } from "rollup";
import _rollupBabel from "rollup-plugin-babel";
import _rollupTypeScript from "rollup-plugin-typescript2";
import { RawSourceMap } from "source-map";
import * as ts from "typescript";
import { packageRelative, exists, readJSON, mkdir, writeFile } from "../fileUtils";
import { typescript } from "../lazy-modules";
import memoize from "../memoize";
import virtualModule, { ModuleMap, VirtualModule } from "../modules/index";
import { staticFileRoute, StaticFileRoute } from "../static-file-route";

export interface CompiledRoute {
	route: StaticFileRoute;
	map?: RawSourceMap;
}

export interface CompilerOutput {
	routes: { [path: string]: CompiledRoute };
	moduleMap: ModuleMap;
}

const declarationPattern = /\.d\.ts$/;
const declarationOrJavaScriptPattern = /\.(d\.ts|js)$/;

const requireOnce = memoize(require);

function lazilyLoadedBabelPlugins(pluginNames: string[]): any[] {
	const result: any[] = [];
	for (let i = 0; i < pluginNames.length; i++) {
		Object.defineProperty(result, i, {
			configurable: true,
			get() {
				const name = pluginNames[i];
				const plugin = requireOnce(name);
				const value = [plugin.default || plugin, name === "babel-plugin-transform-async-to-promises" ? { externalHelpers: true, hoist: true } : { }];
				Object.defineProperty(result, i, {
					configurable: true,
					value
				});
				return value;
			}
		});
	}
	result.length = pluginNames.length;
	return result;
}

interface VirtualModuleData {
	declaration: string;
	code: string;
	styles: boolean;
	dependencies: { path: string, modified: number }[];
}
type CacheData = CachedChunk & {
	virtualModules: { [path: string]: VirtualModuleData };
}

export async function compile(fileRead: (path: string) => void, input: string, basePath: string, publicPath: string, minify: boolean, redact: boolean): Promise<CompilerOutput> {
	// Caches
	const cachePath = resolve(basePath, redact ? ".cache/redacted.json" : ".cache/client.json");
	const cache: CacheData | undefined = await exists(cachePath) && +typescript.sys.getModifiedTime!(cachePath) > +typescript.sys.getModifiedTime!(packageRelative("dist/host/compiler/bundle-compiler.js")) ? await readJSON(cachePath) : null;
	const newCache: CacheData = { modules: [], virtualModules: {} };
	const virtualModules: { [path: string]: VirtualModule } = { };

	// Dynamically load dependencies to reduce startup time
	const rollupModule = await import("rollup");
	const rollupBabel = requireOnce("rollup-plugin-babel") as typeof _rollupBabel;
	const rollupTypeScript = requireOnce("rollup-plugin-typescript2") as typeof _rollupTypeScript;

	// Workaround to allow TypeScript to union two folders. This is definitely not right, but it works :(
	const parseJsonConfigFileContent = typescript.parseJsonConfigFileContent;
	typescript.parseJsonConfigFileContent = function(this: any, json: any, host: ts.ParseConfigHost, basePath2: string, existingOptions?: ts.CompilerOptions, configFileName?: string, resolutionStack?: ts.Path[], extraFileExtensions?: ReadonlyArray<ts.JsFileExtensionInfo>): ts.ParsedCommandLine {
		const result = parseJsonConfigFileContent.call(this, json, host, basePath2, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		const augmentedResult = parseJsonConfigFileContent.call(this, json, host, basePath, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		result.fileNames = result.fileNames.concat(augmentedResult.fileNames);
		return result;
	} as any;
	const mainPath = packageRelative("common/main.js");
	function lookupVirtualModule(path: string) {
		path = path.replace(declarationOrJavaScriptPattern, "");
		const existingEntry = Object.hasOwnProperty.call(newCache.virtualModules, path) && newCache.virtualModules[path];
		if (existingEntry) {
			return existingEntry;
		}
		const cachedEntry = cache && cache.virtualModules && Object.hasOwnProperty.call(cache.virtualModules, path) && cache.virtualModules[path];
		if (cachedEntry) {
			const stale = cachedEntry.dependencies.some(({path, modified}) => +typescript.sys.getModifiedTime!(path) > modified);
			if (!stale) {
				return newCache.virtualModules[path] = cachedEntry;
			}
			for (const { path } of cachedEntry.dependencies) {
				fileRead(path);
			}
		}
		const dependencies: { path: string, modified: number }[] = [];
		const module = virtualModule(basePath, path, !!minify, memoize((path: string) => {
			dependencies.push({ path, modified: +typescript.sys.getModifiedTime!(path) });
			fileRead(path);
		}));
		if (module) {
			virtualModules[path] = module;
			return newCache.virtualModules[path] = {
				declaration: module.generateTypeDeclaration(),
				code: module.generateModule(),
				styles: !!module.generateStyles,
				dependencies,
			};
		}
	}
	const plugins = [
		// Transform TypeScript
		rollupTypeScript({
			clean: true,
			include: [
				resolve(basePath, "**/*.+(ts|tsx|js|jsx|css)"),
				packageRelative("**/*.+(ts|tsx|js|jsx|css)"),
			] as any,
			exclude: [
				resolve(basePath, "node_modules/babel-plugin-transform-async-to-promises/*"),
				packageRelative("node_modules/babel-plugin-transform-async-to-promises/*"),
			] as any,
			tsconfig: packageRelative("tsconfig-client.json"),
			tsconfigOverride: {
				include: [
					resolve(basePath, "**/*"),
					resolve(basePath, "*"),
					packageRelative("**/*"),
					packageRelative("*"),
				] as any,
				exclude: [
					resolve(basePath, "server/**/*"),
					resolve(basePath, "server/*"),
					packageRelative("server/**/*"),
					packageRelative("server/*"),
				] as any,
				compilerOptions: {
					baseUrl: basePath,
					paths: {
						"app": [
							resolve(basePath, input),
						],
						"*": [
							packageRelative(`client/*`),
							resolve(basePath, `client/*`),
							packageRelative("common/*"),
							resolve(basePath, "common/*"),
							packageRelative("types/*"),
							resolve(basePath, "*"),
						],
						"tslib": [
							packageRelative("node_modules/tslib/tslib"),
						],
						"babel-plugin-transform-async-to-promises/helpers": [
							packageRelative("node_modules/babel-plugin-transform-async-to-promises/helpers"),
						],
						"preact": [
							packageRelative("dist/common/preact"),
						],
					},
				},
			},
			verbosity: 0,
			typescript,
			fileExistsHook(path: string) {
				return lookupVirtualModule(path) !== undefined;
			},
			readFileHook(path: string) {
				const module = lookupVirtualModule(path);
				if (module) {
					if (declarationPattern.test(path)) {
						return module.declaration;
					} else {
						return module.code;
					}
				}
			},
		}) as any as Plugin,
		// Transform the intermediary phases via babel
		rollupBabel({
			babelrc: false,
			presets: [],
			plugins: lazilyLoadedBabelPlugins(([
				"babel-plugin-syntax-dynamic-import",
				"babel-plugin-external-helpers",
				"babel-plugin-transform-async-to-promises",
				"babel-plugin-optimize-closures-in-render",
			]).concat(redact ? ["./stripRedactedArguments"] : []).concat([
				"./fixTypeScriptExtendsWarning",
				"./noImpureGetters",
				"./simplifyVoidInitializedVariables",
				"./stripUnusedArgumentCopies",
				// Replacement for babel-preset-env
				"babel-plugin-check-es2015-constants",
				"babel-plugin-syntax-trailing-function-commas",
				"babel-plugin-transform-es2015-arrow-functions",
				"babel-plugin-transform-es2015-block-scoped-functions",
				"babel-plugin-transform-es2015-block-scoping",
				"babel-plugin-transform-es2015-classes",
				"babel-plugin-transform-es2015-computed-properties",
				"babel-plugin-transform-es2015-destructuring",
				"babel-plugin-transform-es2015-duplicate-keys",
				"babel-plugin-transform-es2015-for-of",
				"babel-plugin-transform-es2015-function-name",
				"babel-plugin-transform-es2015-literals",
				"babel-plugin-transform-es2015-object-super",
				"babel-plugin-transform-es2015-parameters",
				"babel-plugin-transform-es2015-shorthand-properties",
				"babel-plugin-transform-es2015-spread",
				"babel-plugin-transform-es2015-sticky-regex",
				"babel-plugin-transform-es2015-template-literals",
				"babel-plugin-transform-es2015-typeof-symbol",
				"babel-plugin-transform-es2015-unicode-regex",
				"babel-plugin-transform-exponentiation-operator",
				"./simplifyTypeof",
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
		name: "mobius-output-collector",
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
				const virtualPath = module.id.replace(declarationOrJavaScriptPattern, "");
				const entry = lookupVirtualModule(virtualPath);
				if (entry && entry.styles) {
					const implementation = virtualModules[virtualPath] || virtualModule(basePath, virtualPath, !!minify, fileRead);
					if (implementation && implementation.generateStyles) {
						bundledCssModulePaths.push(module.id);
						const variables = module.scope.variables;
						const usedVariables: string[] = [];
						for (const key of Object.keys(variables)) {
							if (variables[key].included) {
								usedVariables.push(variables[key].name);
							}
						}
						const styles = implementation.generateStyles(variables.this.included ? undefined : usedVariables);
						if (styles.css) {
							css.add(module.id, styles.css, styles.map);
						}
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
			const deps = dependencies.map((m) => m.id).concat(cssRoute ? [cssModuleName] : []).map((id) => minify ? routeIndexes.indexOf(id).toString() : JSON.stringify(getPath(id)));
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
				function loadDataForModuleWithName(name: string): [string, string] {
					const route = routes[name.substr(1)].route;
					return [route.foreverPath, route.integrity];
				}
				// Insert imports mapping, using an array and indexes when minified
				let imports: any;
				if (minify) {
					const importsArray = routeIndexes.map(loadDataForModuleWithName);
					imports = importsArray;
				} else {
					const importsObject: { [path: string]: [string, string] } = {};
					routeIndexes.forEach((path) => importsObject[path] = loadDataForModuleWithName(path));
					imports = importsObject;
				}
				if (cssRoute) {
					magicString.append("}");
				}
				magicString.append(`)({}, ${JSON.stringify(imports)}, document)`);
			} else {
				// Generate code to inform the loader that our module's content has loaded
				magicString.prepend(`_mobius(function(${args.join(", ")}) {\n`);
				magicString.append(["", minify ? routeIndexes.indexOf(chunk.id).toString() : JSON.stringify(chunk.id)].concat(deps).join(", ") + ")");
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
		input: [mainPath],
		cache,
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
	let cacheWrite: Promise<void> | undefined;
	if ("chunks" in bundle) {
		const chunks = bundle.chunks;
		for (const chunkName of Object.keys(chunks)) {
			for (const module of chunks[chunkName].modules) {
				newCache.modules.push(module);
			}
		}
		const cacheDirPath = resolve(basePath, ".cache");
		if (!await exists(cacheDirPath)) {
			await mkdir(cacheDirPath);
		}
		cacheWrite = writeFile(cachePath, JSON.stringify(newCache));
	}
	// Cleanup some of the mess we made
	typescript.parseJsonConfigFileContent = parseJsonConfigFileContent;
	// Generate the output, using our custom finalizer for client
	await bundle.generate({
		format: customFinalizer,
		sourcemap: false,
		name: "app",
		legacy: true,
	});
	await cacheWrite;
	return {
		routes,
		moduleMap,
	};
}
