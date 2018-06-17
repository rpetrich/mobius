import { readFileSync } from "fs";
import { resolve } from "path";
import { cwd } from "process";
import * as ts from "typescript";
import { exists, mkdir, modifiedTime, packageRelative, readJSON, writeFile } from "../fileUtils";
import { typescript } from "../lazy-modules";
import { virtualModule } from "../lazy-modules";
import { once } from "../memoize";
import { VirtualModule } from "../modules/index";

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

const compilerModifiedTime = once(() => modifiedTime(packageRelative("dist/host/compiler/compiler.js")));

interface VirtualModuleCacheEntry {
	dependencies: { [dependency: string]: number };
	declaration?: string;
	code?: string;
}

export interface CacheData<T> {
	path: string;
	data?: T;
	virtualModules: { [module: string]: VirtualModuleCacheEntry };
}

const version: number = 1;

export async function loadCache<T>(mainPath: string, cacheSlot: string): Promise<CacheData<T>> {
	const path = resolve(mainPath, `../.cache/${cacheSlot}.json`);
	if (await exists(path) && (modifiedTime(path) > compilerModifiedTime())) {
		const result = await readJSON(path);
		if (result && result.version === version) {
			return {
				path,
				data: result.data,
				virtualModules: result.virtualModules || { },
			};
		}
	}
	return {
		path,
		virtualModules: { },
	};
}

export function noCache<T>(): CacheData<T> {
	return {
		path: "",
		virtualModules: { },
	};
}

function notExternal<T extends ts.ResolvedModule | undefined>(resolvedModule: T): T {
	// Override to allow paths inside node_modules/mobius-js/ to be emitted by TypeScript
	if (resolvedModule && !/\.d\.ts$/.test(resolvedModule.resolvedFileName)) {
		resolvedModule.isExternalLibraryImport = false;
	}
	return resolvedModule;
}

export class Compiler<T> {
	public readonly basePath: string;
	public readonly compilerOptions: ts.CompilerOptions;
	private readonly paths: string[];
	private readonly host: ts.LanguageServiceHost & ts.ModuleResolutionHost;
	private readonly languageService: ts.LanguageService;
	private readonly resolutionCache: ts.ModuleResolutionCache;
	private virtualModules: { [path: string]: VirtualModule } = { };
	private virtualModuleEntries: { [module: string]: VirtualModuleCacheEntry } = { };

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
		this.resolutionCache = typescript.createModuleResolutionCache(this.basePath, (s) => s);
		this.host = {
			getScriptFileNames() {
				return rootFileNames;
			},
			getScriptVersion: (fileName) => {
				return modifiedTime(fileName).toString();
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
			resolveModuleNames: (moduleNames: string[], containingFile: string, reusedNames?: string[]) => {
				return moduleNames.map((moduleName) => notExternal(typescript.resolveModuleName(moduleName, containingFile, this.compilerOptions, this.host, this.resolutionCache).resolvedModule!));
			},
			getResolvedModuleWithFailedLookupLocationsFromCache: (moduleName: string, containingFile: string) => {
				const result = typescript.resolveModuleName(moduleName, containingFile, this.compilerOptions, this.host, this.resolutionCache);
				notExternal(result.resolvedModule);
				return result;
			},
		};
		this.languageService = typescript.createLanguageService(this.host, getDocumentRegistry());
	}

	public fileChanged = (path: string) => {
		/* tslint:disable no-empty */
	}

	private getVirtualModule = (path: string) => {
		if (declarationPattern.test(path)) {
			path = path.replace(declarationPattern, "");
			if (Object.hasOwnProperty.call(this.virtualModules, path)) {
				return this.virtualModules[path];
			}
			const entry: VirtualModuleCacheEntry = {
				dependencies: { },
			};
			const result = virtualModule.default(this.basePath, path, this.minify, (filePath: string) => {
				entry.dependencies[filePath] = modifiedTime(filePath);
				this.fileRead(path);
			}, this.compilerOptions);
			if (result) {
				this.virtualModuleEntries[path] = entry;
				if (this.cache && this.cache.virtualModules && Object.hasOwnProperty.call(this.cache.virtualModules, path)) {
					const pendingCacheEntry = this.cache.virtualModules[path];
					let stale = false;
					for (const dependency in pendingCacheEntry.dependencies) {
						if (Object.hasOwnProperty.call(pendingCacheEntry.dependencies, dependency)) {
							if (modifiedTime(dependency) !== pendingCacheEntry.dependencies[dependency]) {
								stale = true;
								break;
							}
						}
					}
					if (!stale) {
						entry.dependencies = Object.assign({}, pendingCacheEntry.dependencies);
						if (typeof pendingCacheEntry.declaration !== "undefined") {
							entry.declaration = pendingCacheEntry.declaration;
						}
						if (typeof pendingCacheEntry.code !== "undefined") {
							entry.code = pendingCacheEntry.code;
						}
					}
				}
				// Declaration is eager
				const declaration = entry.declaration || (entry.declaration = result.generateTypeDeclaration());
				return this.virtualModules[path] = {
					generateTypeDeclaration() {
						return declaration;
					},
					generateModule() {
						// Module is lazy
						return entry.code || (entry.code = result.generateModule());
					},
					instantiateModule: result.instantiateModule,
					generateStyles: result.generateStyles,
				};
			}
		}
	}

	public compile(): CompiledOutput<T> {
		this.virtualModules = { };
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
				if (tsResult && !tsResult.isExternalLibraryImport) {
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
			saveCache: async (data: T) => {
				this.cache.data = data;
				this.cache.virtualModules = this.virtualModuleEntries;
				this.virtualModuleEntries = { };
				const path = this.cache.path;
				if (path) {
					const parentPath = resolve(path, "..");
					if (!await exists(parentPath)) {
						await mkdir(parentPath);
					}
					await writeFile(path, JSON.stringify({ version, data, virtualModules: this.cache.virtualModules }));
				}
			},
		};
	}

}
