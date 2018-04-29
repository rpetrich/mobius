import { RawSourceMap } from "source-map";
import cssModule from "./css";
import secretsModule from "./secrets";
import { ServerModuleGlobal } from "../server-compiler";
import validationModule from "./validation";

export interface ModuleMap { [modulePath: string]: string; }
export interface StaticAssets { [path: string]: { contents: string; integrity: string; }; }

export type VirtualModuleConstructor = (path: string, minify: boolean) => VirtualModule | void;

export interface VirtualModule {
	generateTypeDeclaration: () => string;
	generateModule: () => string;
	instantiateModule: (moduleMap: ModuleMap, staticAssets: StaticAssets) => (global: ServerModuleGlobal) => void;
	generateStyles?: (usedExports?: string[]) => { css: string; map?: RawSourceMap };
}

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
	return secretsModule(projectPath, path, fileRead) || validationModule(path) || cssModule(path, minify);
}
