import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, resolve as pathResolve } from "path";
import { RawSourceMap } from "source-map";
import * as vm from "vm";
import { modifiedTime } from "../fileUtils";
import memoize from "../memoize";
import { ModuleMap, StaticAssets } from "../modules/index";
import { LocalSessionSandbox } from "../session-sandbox";
import { CompiledOutput } from "./compiler";

export interface ModuleSource {
	path: string;
	sandbox: boolean;
}

export interface ServerModule {
	exports: any;
	paths: string[];
}

export interface ServerModuleGlobal {
	self: this;
	global: this | NodeJS.Global;
	require: (name: string) => any;
	module: ServerModule;
	exports: any;
	Object?: typeof Object;
	Array?: typeof Array;
}

export interface LoaderCacheData {
	modules: { [path: string]: { initializer: string, shared: boolean, modified: number } };
}

const requireOnce = memoize(require);

const innerParams = ["self", "global", "require", "document", "exports", "Math", "Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"];

function wrapSelfPlugin({ types }: any) {
	return {
		post(file: any) {
			const path = file.path;
			const lastStatement = path.node.body[path.node.body.length - 1];
			if (lastStatement && lastStatement.trailingComments) {
				lastStatement.trailingComments = lastStatement.trailingComments.filter((comment: any) => !/^\# source(Mapping)URL\=/.test(comment.value));
			}
			const filename = file.opts.filename;
			const match = filename ? basename(filename).match(/\w+/) : null;
			const name = path.scope.generateUidIdentifier(match ? match[0] : "module");
			const innerWrapper = types.functionDeclaration(name, innerParams.map((id) => types.identifier(id)), types.blockStatement(path.node.body));
			const innerCall = types.callExpression(name, [types.identifier("self")].concat(innerParams.slice(1).map((id) => types.memberExpression(types.identifier("self"), types.identifier(id)))));
			const outerWrapper = types.functionExpression(null, [types.identifier("self")], types.blockStatement([types.returnStatement(innerCall)]));
			const program = types.program([innerWrapper, types.returnStatement(outerWrapper)]);
			path.skip();
			path.replaceWith(program);
		},
	};
}

function wrapRequirePlugin({ types }: any) {
	return {
		post(file: any) {
			const path = file.path;
			const wrapper = types.functionExpression(null, [types.identifier("require")], types.blockStatement(path.node.body));
			const program = types.program([types.expressionStatement(wrapper)]);
			path.skip();
			path.replaceWith(program);
		},
	};
}

interface InitializerOutput {
	code: string;
	map: RawSourceMap;
}

function initializerForCompiledOutput(code: string, map: string | undefined, filename: string, shared: boolean, coverage: boolean): InitializerOutput {
	const babel = requireOnce("babel-core");
	// Apply babel transformation passes
	const convertToCommonJS = requireOnce("babel-plugin-transform-es2015-modules-commonjs");
	const optimizeClosuresInRender = requireOnce("babel-plugin-optimize-closures-in-render");
	const dynamicImport = requireOnce("babel-plugin-syntax-dynamic-import");
	const transformAsyncToPromises = requireOnce("babel-plugin-transform-async-to-promises");
	const noImpureGetters = requireOnce("./noImpureGetters").default;
	const rewriteDynamicImport = requireOnce("./rewriteDynamicImport").default;
	let inputSourceMap: RawSourceMap | undefined;
	if (typeof map === "string") {
		// Patch up input source map to have proper paths
		inputSourceMap = JSON.parse(map);
		inputSourceMap!.file = filename;
		inputSourceMap!.sources[0] = filename;
	}
	const additionalPlugins = coverage ? [[requireOnce("babel-plugin-istanbul").default, { filename }]] : [];
	let finalPass;
	if (shared) {
		finalPass = babel.transform(code, {
			babelrc: false,
			compact: false,
			plugins: additionalPlugins.concat([
				dynamicImport,
				rewriteDynamicImport,
				[convertToCommonJS, { noInterop: true }],
				noImpureGetters,
				[transformAsyncToPromises, { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender,
				wrapSelfPlugin,
				wrapRequirePlugin,
			]),
			parserOpts: {
				allowReturnOutsideFunction: true,
			},
			inputSourceMap,
			sourceMaps: true,
			filename,
		});
	} else {
		const firstPass = babel.transform(code, {
			ast: true,
			babelrc: false,
			compact: false,
			plugins: additionalPlugins.concat([
				dynamicImport,
				rewriteDynamicImport,
				[convertToCommonJS, { noInterop: true }],
				noImpureGetters,
				wrapSelfPlugin,
			]),
			inputSourceMap,
			sourceMaps: true,
			filename,
		});
		const hoistSharedLabels = requireOnce("./hoistSharedLabels").default;
		finalPass = babel.transformFromAst(firstPass.ast!, firstPass.code!, {
			babelrc: false,
			compact: false,
			plugins: [
				[convertToCommonJS, { noInterop: true }],
				[transformAsyncToPromises, { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender,
				hoistSharedLabels,
				wrapRequirePlugin,
			],
			parserOpts: {
				allowReturnOutsideFunction: true,
			},
			inputSourceMap: firstPass.map,
			sourceMaps: true,
			filename,
		});
	}
	return {
		code: finalPass.code!,
		map: finalPass.map!,
	};
}

export type ModuleLoader = (source: ModuleSource, module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) => void;

export function sandboxLoaderForOutput(compiled: CompiledOutput<LoaderCacheData>, moduleMap: ModuleMap, staticAssets: StaticAssets, cachePath: string | undefined, coverage: boolean): ModuleLoader {
	const loadersForPath = new Map<string, (module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) => void>();

	// Extract compiled output and source map from TypeScript
	const modules: { [path: string]: { initializer: string, shared: boolean, modified: number } } = { };
	const cache = compiled.compiler.cache.data;
	function importOutputAtPath(path: string) {
		const modified = modifiedTime(path);
		if (!isNaN(modified)) {
			if (cache &&
				cache.modules &&
				Object.hasOwnProperty.call(cache.modules, path) &&
				cache.modules[path].modified === modified
			) {
				return modules[path] = cache.modules[path];
			}
			const { code, map } = compiled.getEmitOutput(path) || { code: readFileSync(path).toString(), map: undefined };
			const shared = /\/\*\*\s*@mobius:shared\s*\*\//.test(code) || /\bbabel-plugin-transform-async-to-promises\/helpers\b/.test(path) || /\bdist\/common\/preact\b/.test(path);
			const output = initializerForCompiledOutput(code, map, path, shared, coverage);
			let initializer = output.code;
			if (cachePath) {
				if (!existsSync(cachePath)) {
					mkdirSync(cachePath);
				}
				const mapPath = pathResolve(cachePath, basename(path) + ".map");
				initializer += "\n//# sourceMappingURL=" + mapPath;
				writeFileSync(mapPath, JSON.stringify(output.map));
			}
			return modules[path] = {
				initializer,
				shared,
				modified: isNaN(modified) ? 0 : modified,
			};
		}
	}
	for (const { fileName, isDeclarationFile } of compiled.program.getSourceFiles()) {
		importOutputAtPath(isDeclarationFile ? fileName.replace(/\.d\.ts$/, ".js") : fileName);
	}

	// Should find a way of doing this cleanly that properly waits for all async module loads in initial render
	setTimeout(() => compiled.saveCache({ modules }), 200);

	function initializerForPath(path: string, staticRequire: (name: string) => any): [((global: ServerModuleGlobal, sandbox: LocalSessionSandbox) => void) | undefined, boolean] {
		// Check for virtual modules
		const module = compiled.getVirtualModule(path);
		if (module) {
			const instantiate = module.instantiateModule(moduleMap, staticAssets);
			return [instantiate, false];
		}
		// Incrementally handle files that TypeScript didn't compile, as they're discovered
		let output = modules[path];
		if (!output) {
			output = importOutputAtPath(path)!;
		}
		// Wrap in the sandbox JavaScript
		return [vm.runInThisContext(output.initializer, {
			filename: path,
			lineOffset: 0,
			displayErrors: true,
		})(staticRequire) as (global: any) => void, output.shared];
	}

	return (source: ModuleSource, module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) => {
		// Create a sandbox with exports for the provided module
		const path = source.path;
		let result = loadersForPath.get(path);
		if (!result) {
			const [initializer, isShared] = initializerForPath(path, require);
			if (initializer) {
				const constructModule = function(currentModule: ServerModule, currentGlobalProperties: any, sandbox: LocalSessionSandbox, currentRequire: (name: string) => any) {
					const moduleGlobal: ServerModuleGlobal & any = Object.create(global);
					Object.assign(moduleGlobal, currentGlobalProperties);
					moduleGlobal.self = moduleGlobal;
					moduleGlobal.global = global;
					moduleGlobal.require = currentRequire;
					moduleGlobal.module = currentModule;
					moduleGlobal.exports = currentModule.exports;
					initializer(moduleGlobal, sandbox);
					return moduleGlobal;
				};
				if (source.sandbox && !isShared) {
					result = constructModule;
				} else {
					const staticModule = constructModule(module, globalProperties, sandbox, require);
					result = () => staticModule;
				}
			} else {
				result = () => {
					throw new Error("Unable to find module: " + path);
				};
			}
			loadersForPath.set(path, result);
		}
		return result(module, globalProperties, sandbox, require);
	};
}
