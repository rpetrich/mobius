import { readFileSync } from "fs";
import { resolve } from "path";
import { cwd } from "process";
import * as ts from "typescript";
import * as vm from "vm";
import { exists, mkdir, packageRelative, readJSON, writeFile } from "../fileUtils";
import { typescript } from "../lazy-modules";
import { virtualModule } from "../lazy-modules";
import memoize, { once } from "../memoize";
import { ModuleMap, StaticAssets, VirtualModule } from "../modules/index";
import { LocalSessionSandbox } from "../session-sandbox";

const requireOnce = memoize(require);

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

declare global {
	namespace NodeJS {
		export interface Global {
			newModule?: (global: any) => void;
		}
	}
}

export interface ModuleSource { path: string; sandbox: boolean; }

function wrapSource(code: string) {
	return `(function(self){return(function(self,global,require,document,exports,Math,Date,setInterval,clearInterval,setTimeout,clearTimeout){${code}\n})(self,self.global,self.require,self.document,self.exports,self.Math,self.Date,self.setInterval,self.clearInterval,self.setTimeout,self.clearTimeout)})`;
}

function loadCompilerOptions(mode: "server" | "client", mainPath: string) {
	const basePath = resolve(mainPath, "..");
	const fileName = `tsconfig-${mode}.json`;
	const configFile = typescript.readJsonConfigFile(packageRelative(fileName), (path: string) => readFileSync(path).toString());
	const configObject = typescript.convertToObject(configFile, []);
	const result = typescript.convertCompilerOptionsFromJson(configObject.compilerOptions, packageRelative("./"), fileName).options;
	result.suppressOutputPathCheck = true;
	result.baseUrl = basePath;
	result.paths = {
		"app": [
			mainPath,
		],
		"*": [
			packageRelative(`${mode}/*`),
			resolve(basePath, `${mode}/*`),
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
		"redom": [
			packageRelative("host/redom"),
		],
	};
	return result;
}

const diagnosticsHost = {
	getCurrentDirectory: cwd,
	getCanonicalFileName(fileName: string) {
		return fileName;
	},
	getNewLine() {
		return "\n";
	},
};

const declarationPattern = /\.d\.ts$/;

const getDocumentRegistry = once(() => typescript.createDocumentRegistry());

export interface CompiledOutput<T> {
	program: ts.Program;
	compiler: Compiler<T>;
	resolveModule(moduleName: string, containingFile: string): { resolvedFileName: string, isExternalLibraryImport?: boolean } | void;
	getEmitOutput(path: string): { code: string, map: string | undefined } | void;
	getVirtualModule(path: string): VirtualModule | void;
	saveCache(newCache: T): Promise<void>;
}

function modifiedTime(path: string): number {
	return +typescript.sys.getModifiedTime!(path);
}

const compilerModifiedTime = once(() => modifiedTime(packageRelative("dist/host/compiler/server-compiler.js")));

export interface CacheData<T> {
	path: string;
	data?: T;
}

export async function loadCache<T>(mainPath: string, cacheSlot: string): Promise<CacheData<T>> {
	const path = resolve(mainPath, `../.cache/${cacheSlot}.json`);
	if (await exists(path) && (modifiedTime(path) > compilerModifiedTime())) {
		const data = await readJSON(path);
		if (data) {
			return { path, data };
		}
	}
	return { path };
}

export function noCache<T>(): CacheData<T> {
	return { path: "" };
}

export class Compiler<T> {
	public readonly basePath: string;
	public readonly compilerOptions: ts.CompilerOptions;
	private readonly paths: string[];
	private readonly versions: { [path: string]: number } = { };
	private readonly virtualModules: { [path: string]: VirtualModule } = { };
	private readonly virtualModuleDependencies: { [path: string]: string[] } = { };
	private readonly host: ts.LanguageServiceHost & ts.ModuleResolutionHost;
	private readonly languageService: ts.LanguageService;
	private readonly resolutionCache: ts.ModuleResolutionCache;

	constructor(mode: "server" | "client", public readonly cache: CacheData<T>, mainPath: string, rootFileNames: string[], private minify: boolean, private fileRead: (path: string) => void) {
		this.basePath = resolve(mainPath, "..");
		this.compilerOptions = loadCompilerOptions(mode, mainPath);
		this.paths = ((module.constructor as any)._nodeModulePaths(this.basePath) as string[]).concat(module.paths);
		const readFile = (path: string, encoding?: string) => {
			const module = this.getVirtualModule(path);
			if (module) {
				return module.generateTypeDeclaration();
			}
			fileRead(path);
			return typescript.sys.readFile(path, encoding);
		};
		this.host = {
			getScriptFileNames() {
				return rootFileNames;
			},
			getScriptVersion: (fileName) => {
				return Object.hasOwnProperty.call(this.versions, fileName) ? this.versions[fileName].toString() : "0";
			},
			getScriptSnapshot(fileName) {
				const contents = readFile(fileName);
				if (typeof contents !== "undefined") {
					return typescript.ScriptSnapshot.fromString(contents);
				}
				return undefined;
			},
			getCurrentDirectory() {
				return typescript.sys.getCurrentDirectory();
			},
			getCompilationSettings: () => {
				return this.compilerOptions;
			},
			getDefaultLibFileName(options) {
				return typescript.getDefaultLibFilePath(options);
			},
			readFile,
			fileExists: (path: string) => {
				const result = typescript.sys.fileExists(path);
				if (result) {
					return result;
				}
				if (this.getVirtualModule(path)) {
					return true;
				}
				return false;
			},
			readDirectory: typescript.sys.readDirectory,
			directoryExists(directoryName: string): boolean {
				return typescript.sys.directoryExists(directoryName);
			},
			getDirectories(directoryName: string): string[] {
				return typescript.sys.getDirectories(directoryName);
			},
		};
		this.languageService = typescript.createLanguageService(this.host, getDocumentRegistry());
		this.resolutionCache = typescript.createModuleResolutionCache(this.basePath, (s) => s);
	}

	private getVirtualModule = (path: string) => {
		if (declarationPattern.test(path)) {
			path = path.replace(declarationPattern, "");
			if (Object.hasOwnProperty.call(this.virtualModules, path)) {
				return this.virtualModules[path];
			}
			const result = virtualModule.default(this.basePath, path, this.minify, (path: string) => {
				const mappings = this.virtualModuleDependencies;
				const dependencies = Object.hasOwnProperty.call(mappings, path) ? mappings[path] : (mappings[path] = []);
				if (dependencies.indexOf(path) === -1) {
					dependencies.push(path);
				}
				this.fileRead(path);
			}, this.compilerOptions);
			if (result) {
				return this.virtualModules[path] = {
					generateTypeDeclaration: once(result.generateTypeDeclaration),
					generateModule: once(result.generateModule),
					instantiateModule: result.instantiateModule,
					generateStyles: result.generateStyles,
				};
			}
		}
	}

	public fileChanged = (path: string) => {
		// Update version number of file so that TypeScript can track the changes
		this.versions[path] = Object.hasOwnProperty.call(this.versions, path) ? (this.versions[path] + 1) : 1;
		// Clear any cached virtual modules that depend on the file
		if (Object.hasOwnProperty.call(this.virtualModuleDependencies, path)) {
			for (const dependency of this.virtualModuleDependencies[path]) {
				delete this.virtualModules[dependency];
			}
			delete this.virtualModuleDependencies[path];
		}
	}

	public compile(): CompiledOutput<T> {
		const program = this.languageService.getProgram();
		const diagnostics = typescript.getPreEmitDiagnostics(program);
		if (diagnostics.length) {
			console.log(typescript.formatDiagnostics(diagnostics, diagnosticsHost));
		}
		return {
			program,
			compiler: this,
			resolveModule: (moduleName: string, containingFile: string): { resolvedFileName: string, isExternalLibraryImport?: boolean } | void => {
				const tsResult = typescript.resolveModuleName(moduleName, containingFile, this.compilerOptions, this.host, this.resolutionCache).resolvedModule;
				if (tsResult) {
					if (tsResult.extension === ".d.ts") {
						const replaced = tsResult.resolvedFileName.replace(declarationPattern, ".js");
						if (this.host.fileExists(replaced)) {
							return {
								resolvedFileName: replaced,
								isExternalLibraryImport: tsResult.isExternalLibraryImport,
							};
						}
					}
					return {
						resolvedFileName: tsResult.resolvedFileName,
						isExternalLibraryImport: tsResult.isExternalLibraryImport,
					};
				}
				return {
					resolvedFileName: (module.constructor as any)._resolveFilename(moduleName, null, false, { paths: this.paths }) as string,
					isExternalLibraryImport: true,
				};
			},
			getEmitOutput: (path: string): { code: string, map: string | undefined } | void => {
				const sourceFile = program.getSourceFile(path);
				if (sourceFile) {
					let code: string | undefined;
					let map: string | undefined;
					for (const { name, text } of this.languageService.getEmitOutput(path).outputFiles) {
						if (/\.js$/.test(name)) {
							code = text;
						} else if (/\.js\.map$/.test(name)) {
							map = text;
						}
					}
					if (typeof code === "string") {
						return { code, map };
					}
				}
			},
			getVirtualModule: this.getVirtualModule,
			saveCache: async (newData: T) => {
				const path = this.cache.path;
				if (path) {
					const parentPath = resolve(path, "..");
					if (!await exists(parentPath)) {
						await mkdir(parentPath);
					}
					await writeFile(path, JSON.stringify(newData));
					this.cache.data = newData;
				}
			},
		};
	}

}

export interface LoaderCacheData {
	modules: { [path: string]: { initializer: string, shared: boolean, modified: number } };
}

function initializerStringForOutput(code: string, map: string | undefined, shared: boolean): string {
	const inputSourceMap = typeof map === "string" ? JSON.parse(map) : undefined;
	const babel = requireOnce("babel-core");
	// Apply babel transformation passes
	const convertToCommonJS = requireOnce("babel-plugin-transform-es2015-modules-commonjs");
	const optimizeClosuresInRender = requireOnce("babel-plugin-optimize-closures-in-render");
	const dynamicImport = requireOnce("babel-plugin-syntax-dynamic-import");
	const transformAsyncToPromises = requireOnce("babel-plugin-transform-async-to-promises");
	const noImpureGetters = requireOnce("./noImpureGetters").default;
	const rewriteDynamicImport = requireOnce("./rewriteDynamicImport").default;
	if (shared) {
		const singlePass = babel.transform(code, {
			babelrc: false,
			compact: false,
			plugins: [
				dynamicImport,
				rewriteDynamicImport,
				[convertToCommonJS, { noInterop: true }],
				noImpureGetters,
				[transformAsyncToPromises, { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender,
			],
			inputSourceMap,
		});
		return `(function(require){return ${wrapSource(singlePass.code!)}\n})`;
	} else {
		const firstPass = babel.transform(code, {
			babelrc: false,
			compact: false,
			plugins: [
				dynamicImport,
				rewriteDynamicImport,
				[convertToCommonJS, { noInterop: true }],
				noImpureGetters,
			],
			inputSourceMap,
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
		});
		return `(function(require){${secondPass.code!}\n})`;
	}
}

export type ModuleLoader = (source: ModuleSource, module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) => void;

export function loaderForOutput(compiled: CompiledOutput<LoaderCacheData>, moduleMap: ModuleMap, staticAssets: StaticAssets): ModuleLoader {
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
			const shared = /\/\*\s*mobius:shared\s*\*\//.test(code);
			return modules[path] = {
				initializer: initializerStringForOutput(code, map, shared),
				shared,
				modified,
			};
		}
	}
	for (const { fileName, isDeclarationFile } of compiled.program.getSourceFiles()) {
		importOutputAtPath(isDeclarationFile ? fileName.replace(/\.d\.ts$/, ".js") : fileName);
	}
	compiled.saveCache({ modules });

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
			const newOutput = importOutputAtPath(path);
			if (newOutput) {
				compiled.saveCache({ modules });
			}
			output = newOutput!;
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
