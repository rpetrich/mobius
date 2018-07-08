import { readFileSync } from "fs";
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

function wrapSource(code: string) {
	return `(function(self){return(function(self,global,require,document,exports,Math,Date,setInterval,clearInterval,setTimeout,clearTimeout){${code}\n})(self,self.global,self.require,self.document,self.exports,self.Math,self.Date,self.setInterval,self.clearInterval,self.setTimeout,self.clearTimeout)})`;
}

function initializerStringForOutput(code: string, map: string | undefined, filename: string, shared: boolean, coverage: boolean): string {
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
	if (shared) {
		const singlePass = babel.transform(code, {
			babelrc: false,
			compact: false,
			plugins: additionalPlugins.concat([
				dynamicImport,
				rewriteDynamicImport,
				[convertToCommonJS, { noInterop: true }],
				noImpureGetters,
				[transformAsyncToPromises, { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender,
			]),
			inputSourceMap,
			filename,
		});
		return `(function(require){return ${wrapSource(singlePass.code!)}\n})`;
	} else {
		const firstPass = babel.transform(code, {
			babelrc: false,
			compact: false,
			plugins: additionalPlugins.concat([
				dynamicImport,
				rewriteDynamicImport,
				[convertToCommonJS, { noInterop: true }],
				noImpureGetters,
			]),
			inputSourceMap,
			filename,
		});
		const hoistSharedLabels = requireOnce("./hoistSharedLabels").default;
		const secondPass = babel.transform("return " + wrapSource(firstPass.code!), {
			babelrc: false,
			compact: false,
			plugins: [
				[convertToCommonJS, { noInterop: true }],
				[transformAsyncToPromises, { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender,
				hoistSharedLabels,
			],
			parserOpts: {
				allowReturnOutsideFunction: true,
			},
			filename,
		});
		return `(function(require){${secondPass.code!}\n})`;
	}
}

export type ModuleLoader = (source: ModuleSource, module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) => void;

export function sandboxLoaderForOutput(compiled: CompiledOutput<LoaderCacheData>, moduleMap: ModuleMap, staticAssets: StaticAssets, coverage: boolean): ModuleLoader {
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
			return modules[path] = {
				initializer: initializerStringForOutput(code, map, path, shared, coverage),
				shared,
				modified,
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
