import { RawSourceMap } from "source-map";
import { ServerModuleGlobal } from "../compiler/server-compiler";
import { once } from "../memoize";

export interface ModuleMap { [modulePath: string]: string; }
export interface StaticAssets { [path: string]: { contents: string; integrity: string; }; }

export type VirtualModuleConstructor = (path: string, minify: boolean) => VirtualModule | void;

export interface VirtualModule {
	generateTypeDeclaration: () => string;
	generateModule: () => string;
	instantiateModule: (moduleMap: ModuleMap, staticAssets: StaticAssets) => (global: ServerModuleGlobal) => void;
	generateStyles?: (usedExports?: string[]) => { css: string; map?: RawSourceMap };
}

const modules = once(() => [
	require("./secrets").default as (projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void) => VirtualModule | void,
	require("./validation").default as (projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void) => VirtualModule | void,
	require("./css").default as (projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void) => VirtualModule | void,
]);

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
	for (const module of modules()) {
		const result = module(projectPath, path, minify, fileRead);
		if (result) {
			return result;
		}
	}
}
