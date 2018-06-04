import { RawSourceMap } from "source-map";
import { CompilerOptions } from "typescript";
import { ServerModuleGlobal } from "../compiler/server-compiler";
import { LocalSessionSandbox } from "../session-sandbox";

export interface ModuleMap { [modulePath: string]: string; }
export interface StaticAssets { [path: string]: { contents: string; integrity: string; }; }

import css from "./css";
import secrets from "./secrets";
import validation from "./validation";

export interface VirtualModule {
	generateTypeDeclaration(): string;
	generateModule(): string;
	instantiateModule(moduleMap: ModuleMap, staticAssets: StaticAssets): (global: ServerModuleGlobal, sandbox: LocalSessionSandbox) => void;
	generateStyles?(usedExports?: string[]): { css: string; map?: RawSourceMap };
}

const modules = [secrets, validation, css];

export default function(basePath: string, path: string, minify: boolean, fileRead: (path: string) => void, compilerOptions: CompilerOptions): VirtualModule | void {
	for (const module of modules) {
		const result = module(basePath, path, minify, fileRead, compilerOptions);
		if (result) {
			return result;
		}
	}
}
