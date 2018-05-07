import { resolve } from "path";
import * as ts from "typescript";
import { VirtualModule } from "./index";

const match = /\bsecrets$/;

function extractType(value: any): string {
	switch (typeof value) {
		default:
			if (value !== "null") {
				if (value instanceof Array) {
					return "Readonly<[" + value.map(extractType).join(", ") + "]>";
				}
				return "{" + Object.keys(value).map((name) => "readonly " + extractType(name) + ": " + extractType(value[name])).join(", ") + "}";
			}
		case "boolean":
		case "number":
		case "string":
			return JSON.stringify(value);
	}
}

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void): VirtualModule | void {
	if (!match.test(path)) {
		return;
	}
	const secretsPath = resolve(projectPath, "secrets");
	if (path !== secretsPath) {
		return;
	}
	const fullSecretsPath = secretsPath + ".json";
	if (!ts.sys.fileExists(fullSecretsPath)) {
		return;
	}
	fileRead(fullSecretsPath);
	const fileContents = ts.sys.readFile(fullSecretsPath)!;
	const exports: any = JSON.parse(fileContents);
	if (!exports.__esModule) {
		Object.defineProperty(exports, "__esModule", { value: true });
	}
	return {
		generateTypeDeclaration() {
			const entries: string[] = [`import { Redacted } from "redact";\n`];
			for (const name of Object.keys(exports)) {
				entries.push(`export const ${name}: Redacted<${extractType(exports[name])}>;`);
			}
			return entries.join("\n");
		},
		generateModule() {
			// Compile and optimize validators for each of the types in the parent module
			const entries: string[] = [`import { redact } from "redact";\n`];
			for (const name of Object.keys(exports)) {
				entries.push(`export const ${name} = redact();`);
			}
			return entries.join("\n");
		},
		instantiateModule() {
			return (global) => {
				global.exports = exports;
			};
		},
	};
}
