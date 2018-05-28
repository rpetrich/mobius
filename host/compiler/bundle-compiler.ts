import Concat from "concat-with-sourcemaps";
import { resolve } from "path";
import { Chunk, Finaliser, OutputOptions, Plugin, SourceDescription } from "rollup";
import * as _rollupModule from "rollup";
import _rollupBabel from "rollup-plugin-babel";
import _rollupTypeScript from "rollup-plugin-typescript2";
import { RawSourceMap } from "source-map";
import * as ts from "typescript";
import { packageRelative } from "../fileUtils";
import memoize from "../memoize";
import virtualModule, { ModuleMap } from "../modules/index";
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

export default async function(fileRead: (path: string) => void, input: string, basePath: string, publicPath: string, minify: boolean, redact: boolean): Promise<CompilerOutput> {
	// Dynamically load dependencies to reduce startup time
	const rollupModule = requireOnce("rollup") as typeof _rollupModule;
	const rollupBabel = requireOnce("rollup-plugin-babel") as typeof _rollupBabel;
	const rollupTypeScript = requireOnce("rollup-plugin-typescript2") as typeof _rollupTypeScript;
	const typescript = await import("typescript");

	// Workaround to allow TypeScript to union two folders. This is definitely not right, but it works :(
	const parseJsonConfigFileContent = typescript.parseJsonConfigFileContent;
	(typescript as any).parseJsonConfigFileContent = function(this: any, json: any, host: ts.ParseConfigHost, basePath2: string, existingOptions?: ts.CompilerOptions, configFileName?: string, resolutionStack?: ts.Path[], extraFileExtensions?: ReadonlyArray<ts.JsFileExtensionInfo>): ts.ParsedCommandLine {
		const result = parseJsonConfigFileContent.call(this, json, host, basePath2, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		const augmentedResult = parseJsonConfigFileContent.call(this, json, host, basePath, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		result.fileNames = result.fileNames.concat(augmentedResult.fileNames);
		return result;
	} as any;
	const mainPath = packageRelative("common/main.js");
	const memoizedVirtualModule = memoize((path: string) => virtualModule(basePath, path.replace(declarationOrJavaScriptPattern, ""), !!minify, fileRead));
	const plugins = [
		// Transform TypeScript
		rollupTypeScript({
			cacheRoot: resolve(basePath, ".cache"),
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
				const module = memoizedVirtualModule(path);
				if (module) {
					return true;
				}
				return false;
			},
			readFileHook(path: string) {
				const module = memoizedVirtualModule(path);
				if (module) {
					if (declarationPattern.test(path)) {
						return module.generateTypeDeclaration();
					} else {
						return module.generateModule();
					}
				}
			},
		}) as any as Plugin,
		// Transform the intermediary phases via babel
		rollupBabel({
			babelrc: false,
			presets: [],
			plugins: ([
				requireOnce("babel-plugin-syntax-dynamic-import"),
				requireOnce("babel-plugin-external-helpers"),
				[requireOnce("babel-plugin-transform-async-to-promises"), { externalHelpers: true, hoist: true }],
				requireOnce("babel-plugin-optimize-closures-in-render"),
			]).concat(redact ? [requireOnce("./stripRedactedArguments").default] : []).concat([
				requireOnce("./rewriteForInStatements").default,
				requireOnce("./fixTypeScriptExtendsWarning").default,
				requireOnce("./noImpureGetters").default,
				requireOnce("./simplifyVoidInitializedVariables").default,
				requireOnce("./stripUnusedArgumentCopies").default,
				// Replacement for babel-preset-env
				[requireOnce("babel-plugin-check-es2015-constants")],
				[requireOnce("babel-plugin-syntax-trailing-function-commas")],
				[requireOnce("babel-plugin-transform-es2015-arrow-functions")],
				[requireOnce("babel-plugin-transform-es2015-block-scoped-functions")],
				[requireOnce("babel-plugin-transform-es2015-block-scoping")],
				[requireOnce("babel-plugin-transform-es2015-classes")],
				[requireOnce("babel-plugin-transform-es2015-computed-properties")],
				[requireOnce("babel-plugin-transform-es2015-destructuring")],
				[requireOnce("babel-plugin-transform-es2015-duplicate-keys")],
				[requireOnce("babel-plugin-transform-es2015-for-of")],
				[requireOnce("babel-plugin-transform-es2015-function-name")],
				[requireOnce("babel-plugin-transform-es2015-literals")],
				[requireOnce("babel-plugin-transform-es2015-object-super")],
				[requireOnce("babel-plugin-transform-es2015-parameters")],
				[requireOnce("babel-plugin-transform-es2015-shorthand-properties")],
				[requireOnce("babel-plugin-transform-es2015-spread")],
				[requireOnce("babel-plugin-transform-es2015-sticky-regex")],
				[requireOnce("babel-plugin-transform-es2015-template-literals")],
				[requireOnce("babel-plugin-transform-es2015-typeof-symbol")],
				[requireOnce("babel-plugin-transform-es2015-unicode-regex")],
				[requireOnce("babel-plugin-transform-exponentiation-operator")],
				requireOnce("./simplifyTypeof").default,
			]),
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
				const implementation = memoizedVirtualModule(module.id);
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
				// Add sanity check for prerequisites, will early exit to fallback
				magicString.prepend(
					`(function(${args.join(", ")}) { ` +
					`if (!window.addEventListener || !Object.keys || typeof JSON == "undefined") ` +
						`return;`);
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
			replacer: (text: string) => {
				if (minify) {
					return routeIndexes.indexOf(JSON.parse(text)).toString();
				}
			},
		},
	};

	const bundle = await rollupModule.rollup({
		input: [mainPath],
		external: (id: string, parentId: string, isResolved: boolean) => {
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
	if ("chunks" in bundle) {
		const chunks = bundle.chunks;
		for (const chunkName of Object.keys(chunks)) {
			if (chunkName !== mainChunkId) {
				routeIndexes.push(chunkName);
			}
		}
	}
	// Generate the output, using our custom finalizer for client
	await bundle.generate({
		format: customFinalizer,
		sourcemap: true,
		name: "app",
		legacy: true,
	});
	// Cleanup some of the mess we made
	(typescript as any).parseJsonConfigFileContent = parseJsonConfigFileContent;
	return {
		routes,
		moduleMap,
	};
}
