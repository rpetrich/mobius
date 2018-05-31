import { RawSourceMap } from "source-map";
import { ServerModuleGlobal } from "../compiler/server-compiler";
import { LocalSessionSandbox } from "../session-sandbox";

export interface ModuleMap { [modulePath: string]: string; }
export interface StaticAssets { [path: string]: { contents: string; integrity: string; }; }

import secrets from "./secrets";
import validation from "./validation";
import css from "./css";

export type VirtualModuleConstructor = (path: string, minify: boolean) => VirtualModule | void;

export interface VirtualModule {
	generateTypeDeclaration: () => string;
	generateModule: () => string;
	instantiateModule: (moduleMap: ModuleMap, staticAssets: StaticAssets) => (global: ServerModuleGlobal, sandbox: LocalSessionSandbox) => void;
	generateStyles?: (usedExports?: string[]) => { css: string; map?: RawSourceMap };
}

const modules = [secrets, validation, css];

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
	for (const module of modules) {
		const result = module(projectPath, path, minify, fileRead);
		if (result) {
			return result;
		}
	}
}
