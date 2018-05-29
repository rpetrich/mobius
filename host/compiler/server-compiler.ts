import { readFileSync } from "fs";
import { resolve } from "path";
import { cwd } from "process";
import * as ts_ from "typescript";
import { LanguageService, LanguageServiceHost, ModuleResolutionCache, ModuleResolutionHost, Program } from "typescript";
import * as vm from "vm";
import { packageRelative } from "../fileUtils";
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

export type ModuleSource = { path: string, sandbox: boolean } & ({ from: "file" } | { from: "string", code: string });

function wrapSource(code: string) {
	return `(function(self){return(function(self,global,require,document,exports,Math,Date,setInterval,clearInterval,setTimeout,clearTimeout){${code}\n})(self,self.global,self.require,self.document,self.exports,self.Math,self.Date,self.setInterval,self.clearInterval,self.setTimeout,self.clearTimeout)})`;
}

const typescript = once(() => requireOnce("typescript") as typeof ts_);
export const compilerOptions = once(() => {
	const ts = typescript();
	const fileName = "tsconfig-server.json";
	const configFile = ts.readJsonConfigFile(packageRelative(fileName), (path: string) => readFileSync(path).toString());
	const configObject = ts.convertToObject(configFile, []);
	const result = ts.convertCompilerOptionsFromJson(configObject.compilerOptions, packageRelative("./"), fileName).options;
	const basePath = resolve("./");
	result.baseUrl = basePath;
	result.paths = {
		// "app": [
		// 	resolve(basePath, input),
		// ],
		"*": [
			packageRelative(`server/*`),
			resolve(basePath, `server/*`),
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
});

const diagnosticsHost = {
	getCurrentDirectory: cwd,
	getCanonicalFileName(fileName: string) {
		return fileName;
	},
	getNewLine() {
		return "\n";
	},
};

type ModuleLoader = (module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) => void;

const declarationPattern = /\.d\.ts$/;

export function compilerHost(fileNames: string[], virtualModule: (path: string) => VirtualModule | void, fileRead: (path: string) => void): LanguageServiceHost & ModuleResolutionHost {
	const ts = typescript();
	const readFile = (path: string, encoding?: string) => {
		if (declarationPattern.test(path)) {
			const module = virtualModule(path.replace(declarationPattern, ""));
			if (module) {
				return module.generateTypeDeclaration();
			}
		}
		fileRead(path);
		return ts.sys.readFile(path, encoding);
	};
	return {
		getScriptFileNames() {
			return fileNames;
		},
		getScriptVersion(fileName) {
			return "0";
		},
		getScriptSnapshot(fileName) {
			const contents = readFile(fileName);
			if (typeof contents !== "undefined") {
				return ts.ScriptSnapshot.fromString(contents);
			}
			return undefined;
		},
		getCurrentDirectory() {
			return ts.sys.getCurrentDirectory();
		},
		getCompilationSettings() {
			return compilerOptions();
		},
		getDefaultLibFileName(options) {
			return ts.getDefaultLibFilePath(options);
		},
		readFile,
		fileExists(path: string) {
			const result = ts.sys.fileExists(path);
			if (result) {
				return result;
			}
			if (declarationPattern.test(path) && virtualModule(path.replace(declarationPattern, ""))) {
				return true;
			}
			return false;
		},
		readDirectory: ts.sys.readDirectory,
		directoryExists(directoryName: string): boolean {
			return ts.sys.directoryExists(directoryName);
		},
		getDirectories(directoryName: string): string[] {
			return ts.sys.getDirectories(directoryName);
		},
	};
}

export class ServerCompiler {
	private loadersForPath = new Map<string, ModuleLoader>();
	private languageService: LanguageService;
	private host: LanguageServiceHost & ModuleResolutionHost;
	private program: Program;
	private resolutionCache: ModuleResolutionCache;
	private paths: string[];
	private ts: typeof ts_;

	constructor(mainFile: string, private moduleMap: ModuleMap, private staticAssets: StaticAssets, public virtualModule: (path: string) => VirtualModule | void, fileRead: (path: string) => void) {
		const ts = this.ts = typescript();
		// Hijack TypeScript's file access so that we can instrument when it reads files for watching and to inject virtual modules
		this.host = compilerHost([packageRelative("server/server-dom.d.ts"), packageRelative("common/main.js")], virtualModule, memoize(fileRead));
		this.languageService = ts.createLanguageService(this.host, ts.createDocumentRegistry());
		this.program = this.languageService.getProgram();
		const basePath = resolve(mainFile, "..");
		this.resolutionCache = ts.createModuleResolutionCache(basePath, (s) => s);
		const diagnostics = ts.getPreEmitDiagnostics(this.program);
		if (diagnostics.length) {
			console.log(ts.formatDiagnostics(diagnostics, diagnosticsHost));
		}
		this.paths = ((module.constructor as any)._nodeModulePaths(basePath) as string[]).concat(module.paths);
	}

	public resolveModule(moduleName: string, containingFile: string): { resolvedFileName: string, isExternalLibraryImport?: boolean } | void {
		const tsResult = this.ts.resolveModuleName(moduleName, containingFile, compilerOptions(), this.host, this.resolutionCache).resolvedModule;
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
	}

	public loadModule(source: ModuleSource, module: ServerModule, globalProperties: any, sandbox: LocalSessionSandbox, require: (name: string) => any) {
		// Create a sandbox with exports for the provided module
		const path = source.path;
		let result = this.loadersForPath.get(path);
		if (!result) {
			const [initializer, isShared] = source.from === "file" ? this.initializerForPath(path, require) : [vm.runInThisContext(wrapSource(source.code), {
				filename: path,
				lineOffset: 0,
				displayErrors: true,
			}) as (global: any) => void, false];
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
			this.loadersForPath.set(path, result);
		}
		return result(module, globalProperties, sandbox, require);
	}

	private initializerForPath(path: string, staticRequire: (name: string) => any): [((global: ServerModuleGlobal, sandbox: LocalSessionSandbox) => void) | undefined, boolean] {
		// Check for declarations
		if (declarationPattern.test(path)) {
			const module = this.virtualModule(path.replace(declarationPattern, ""));
			if (module) {
				const instantiate = module.instantiateModule(this.moduleMap, this.staticAssets);
				return [instantiate, false];
			}
		}
		// Extract compiled output and source map from TypeScript
		let typedInput: string;
		let scriptContents: string | undefined;
		let scriptMap: string | undefined;
		const sourceFile = this.program.getSourceFile(path);
		if (sourceFile) {
			typedInput = sourceFile.text;
			for (const { name, text } of this.languageService.getEmitOutput(path).outputFiles) {
				if (/\.js$/.test(name)) {
					scriptContents = text;
				} else if (/\.js\.map$/.test(name)) {
					scriptMap = text;
				}
			}
		} else {
			typedInput = readFileSync(path.replace(/\.d\.ts$/, ".js")).toString();
		}
		const babel = requireOnce("babel-core");
		// Apply babel transformation passes
		const convertToCommonJS = requireOnce("babel-plugin-transform-es2015-modules-commonjs");
		const optimizeClosuresInRender = requireOnce("babel-plugin-optimize-closures-in-render");
		const dynamicImport = requireOnce("babel-plugin-syntax-dynamic-import");
		const transformAsyncToPromises = requireOnce("babel-plugin-transform-async-to-promises");
		const noImpureGetters = requireOnce("./noImpureGetters").default;
		const rewriteDynamicImport = requireOnce("./rewriteDynamicImport").default;
		const input = typeof scriptContents === "string" ? scriptContents : typedInput;
		let output: string;
		const isShared = /^\/\*\s*mobius:shared\s*\*\//.test(typedInput);
		if (isShared) {
			const singlePass = babel.transform(input, {
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
			});
			output = `(function(require){return ${wrapSource(singlePass.code!)}\n})`;
		} else {
			const firstPass = babel.transform(input, {
				babelrc: false,
				compact: false,
				plugins: [
					dynamicImport,
					rewriteDynamicImport,
					[convertToCommonJS, { noInterop: true }],
					noImpureGetters,
				],
				inputSourceMap: typeof scriptMap === "string" ? JSON.parse(scriptMap) : undefined,
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
			output = `(function(require){${secondPass.code!}\n})`;
		}
		// Wrap in the sandbox JavaScript
		return [vm.runInThisContext(output, {
			filename: path,
			lineOffset: 0,
			displayErrors: true,
		})(staticRequire) as (global: any) => void, isShared];
	}
}
