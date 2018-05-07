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

const modules = once(() => {
	const secretsModule = require("./secrets").default;
	const validationModule = require("./validation").default;
	const cssModule = require("./css").default;
	return function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
		return secretsModule(projectPath, path, fileRead) || validationModule(path) || cssModule(path, minify);
	};
});

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
	return modules()(projectPath, path, minify, fileRead);
}
