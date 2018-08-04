import * as Ajv from "ajv";
import { transformFromAst } from "babel-core";
import { parse } from "babylon";
import * as ts from "typescript";
import { getDefaultArgs as getDefaultJsonSchemaGeneratorArgs, JsonSchemaGenerator } from "typescript-json-schema";
import mergeIfStatements from "../compiler/mergeIfStatements";
import rewriteAjv from "../compiler/rewriteAjv";
import simplifyBlockStatements from "../compiler/simplifyBlockStatements";
import { packageRelative } from "../fileUtils";
import { typescript } from "../lazy-modules";
import { once } from "../memoize";
import { VirtualModule } from "./index";

const validatorsPathPattern = /\!validators$/;
const typescriptExtensions = [".ts", ".tsx", ".d.ts"];

function existingPathForValidatorPath(path: string) {
	const strippedPath = path.replace(validatorsPathPattern, "");
	for (const ext of typescriptExtensions) {
		const newPath = strippedPath + ext;
		if (typescript.sys.fileExists(newPath)) {
			return newPath;
		}
	}
}

function buildSchemas(path: string, compilerOptions: ts.CompilerOptions) {
	const program = typescript.createProgram([path, packageRelative("dist/common/preact")], compilerOptions);
	const sourceFile = program.getSourceFile(path);
	if (!sourceFile) {
		throw new Error("Could not find types for " + path);
	}
	const localNames: string[] = [];
	const tc = program.getTypeChecker();
	const allSymbols: { [name: string]: ts.Type } = {};
	const userSymbols: { [name: string]: ts.Symbol } = {};
	const inheritingTypes: { [baseName: string]: string[] } = {};
	function visit(node: ts.Node) {
		if (node.kind === ts.SyntaxKind.InterfaceDeclaration
		 	|| node.kind === ts.SyntaxKind.EnumDeclaration
			|| node.kind === ts.SyntaxKind.TypeAliasDeclaration
		) {
			const symbol: ts.Symbol = (node as any).symbol;
			const localName = tc.getFullyQualifiedName(symbol).replace(/".*"\./, "");
			const nodeType = tc.getTypeAtLocation(node);
			allSymbols[localName] = nodeType;
			if (typescript.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) {
				localNames.push(localName);
			}
			userSymbols[localName] = symbol;
			for (const baseType of nodeType.getBaseTypes() || []) {
				const baseName = tc.typeToString(baseType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
				(inheritingTypes[baseName] || (inheritingTypes[baseName] = [])).push(localName);
			}
		} else {
			typescript.forEachChild(node, visit);
		}
	}
	visit(sourceFile);
	const generator = new JsonSchemaGenerator([], allSymbols, userSymbols, inheritingTypes, tc, Object.assign(getDefaultJsonSchemaGeneratorArgs(), {
		strictNullChecks: true,
		ref: true,
		topRef: true,
		required: true,
		rejectDateType: true,
	}));
	return localNames.map((name) => ({ name, schema: generator.getSchemaForSymbol(name) }));
}

// Ajv configured to support draft-04 JSON schemas
const ajv = new Ajv({
	meta: false,
	extendRefs: true,
	unknownFormats: "ignore",
});
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-06.json"));
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-07.json"));

export default function(projectPath: string, path: string, minify: boolean, fileRead: (path: string) => void, compilerOptions: ts.CompilerOptions): VirtualModule | void {
	if (!validatorsPathPattern.test(path)) {
		return;
	}
	const modulePath = existingPathForValidatorPath(path);
	if (typeof modulePath === "undefined") {
		return;
	}
	fileRead(modulePath);
	const schemas = once(() => buildSchemas(modulePath, compilerOptions));
	return {
		generateTypeDeclaration() {
			const entries: string[] = [];
			for (const { name } of schemas()) {
				entries.push(`import { ${name} as ${name}Type } from ${JSON.stringify(modulePath.replace(/(\.d)?\.tsx?$/, ""))};`);
				entries.push(`export function ${name}(value: unknown): value is ${name}Type;`);
			}
			return entries.join("\n");
		},
		generateModule() {
			// Compile and optimize validators for each of the types in the parent module
			const entries: string[] = [];
			for (const { name, schema } of schemas()) {
				entries.push(`export const ${name} = ${ajv.compile(schema).toString()};`);
			}
			const original = entries.join("\n");
			const ast = parse(original, { sourceType: "module" });
			return transformFromAst(ast, original, {
				plugins: [
					[rewriteAjv, {}],
					[simplifyBlockStatements, {}],
					[mergeIfStatements, {}],
				],
				compact: true,
			}).code!;
		},
		instantiateModule() {
			// Compile validators for each of the types in the parent module
			const exports: any = {};
			Object.defineProperty(exports, "__esModule", { value: true });
			for (const { name, schema } of schemas()) {
				let compiled: ReturnType<typeof ajv.compile> | undefined;
				exports[name] = (value: any) => (typeof compiled !== "undefined" ? compiled : (compiled = ajv.compile(schema)))(value);
			}
			return (global) => {
				global.exports = exports;
			};
		},
	};
}
