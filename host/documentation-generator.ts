import { Application } from "typedoc";
import * as ts from "typescript";

import { packageRelative } from "./fileUtils";
import { compilerOptions, compilerHost } from "./compiler/server-compiler";
import virtualModule from "./modules";
import memoize from "./memoize";

export async function run() {
	// Build application
	const app = new Application({
		target: "ES6",
		mode: "modules",
		includeDeclarations: true,
		excludeNotExported: true,
		excludePrivate: true,
		excludeProtected: true,
		excludeExternals: true,
		tsconfig: compilerOptions(),
		name: "mobius",
		readme: packageRelative("README.md"),
		hideGenerator: true,
		ignoreCompilerErrors: true,
	});

	// Prepare Typescript
	const serverPath = packageRelative("server/");
	const clientPath = packageRelative("client/");
	const commonPath = packageRelative("common/");
	const fileNames = app.expandInputFiles([serverPath, clientPath, commonPath]).filter(fileName => !/-impl\.d\.ts$/.test(fileName));
	const fileRead = (fileName: string) => { };
	const host = compilerHost(fileNames, memoize((path: string) => virtualModule(packageRelative("./"), path, false, fileRead)), fileRead);
	const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
	const program = languageService.getProgram();

	// Generate documentation via TypeDocs
	app.converter.renamer = (name, kind) => {
		if (kind === 1) {
			const isServer = name.startsWith(serverPath);
			const isClient = name.startsWith(clientPath);
			const isCommon = name.startsWith(commonPath);
			if (isServer || isClient || isCommon) {
				if (isServer) {
					name = name.substr(serverPath.length);
				} else if (isClient) {
					name = name.substr(clientPath.length);
				} else if (isCommon) {
					name = name.substr(commonPath.length);
				}
				name = name.replace(/(\.d)?\.tsx?$/, "");
			}
			// if (name === "internal-impl" || name === "ambients" || name === "determinism" || name === "dom-types" || /^sql\//.test(name)) {
			// 	return null;
			// }
			name = name.replace(/-(types|impl)$/, "");
		// } else if (/^_/.test(name)) {
		// 	return null;
		}
		return name;
	};
	const project = app.convert(fileNames, program);
	if (project) {
		app.generateDocs(project, packageRelative("docs"));
	} else {
		throw new Error("Could not generate documentation!");
	}
}
