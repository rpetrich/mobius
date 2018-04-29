import * as Ajv from "ajv";
import * as babel from "babel-core";
import { NodePath } from "babel-traverse";
import { AssignmentExpression, Identifier, IfStatement, VariableDeclaration } from "babel-types";
import * as babylon from "babylon";
import * as ts from "typescript";
import { getDefaultArgs, JsonSchemaGenerator } from "typescript-json-schema";
import { compilerOptions } from "../server-compiler";
import { VirtualModule } from "./index";

const validatorsPathPattern = /\!validators$/;
const typescriptExtensions = [".ts", ".tsx", ".d.ts"];

function existingPathForValidatorPath(path: string) {
	const strippedPath = path.replace(validatorsPathPattern, "");
	for (const ext of typescriptExtensions) {
		const newPath = strippedPath + ext;
		if (ts.sys.fileExists(newPath)) {
			return newPath;
		}
	}
}

function buildSchemas(path: string) {
	const program = ts.createProgram([path], compilerOptions);
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
		if (node.kind === ts.SyntaxKind.ClassDeclaration
			|| node.kind === ts.SyntaxKind.InterfaceDeclaration
		 	|| node.kind === ts.SyntaxKind.EnumDeclaration
			|| node.kind === ts.SyntaxKind.TypeAliasDeclaration
		) {
			const symbol: ts.Symbol = (node as any).symbol;
			const localName = tc.getFullyQualifiedName(symbol).replace(/".*"\./, "");
			const nodeType = tc.getTypeAtLocation(node);
   allSymbols[localName] = nodeType;
			localNames.push(localName);
   userSymbols[localName] = symbol;
			for (const baseType of nodeType.getBaseTypes() || []) {
				const baseName = tc.typeToString(baseType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
				(inheritingTypes[baseName] || (inheritingTypes[baseName] = [])).push(localName);
			}
		} else {
			ts.forEachChild(node, visit);
		}
	}
	visit(sourceFile);
	const generator = new JsonSchemaGenerator(allSymbols, userSymbols, inheritingTypes, tc, Object.assign({
		strictNullChecks: true,
		ref: true,
		topRef: true,
		required: true,
	}, getDefaultArgs()));
	return localNames.map((name) => ({ name, schema: generator.getSchemaForSymbol(name) }));
}

// Ajv configured to support draft-04 JSON schemas
const ajv = new Ajv({
	meta: false,
	extendRefs: true,
	unknownFormats: "ignore",
});
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-04.json"));

// Unsafe, but successfully strips out the assignment of validate.errors
const rewriteAjv = {
	visitor: {
		VariableDeclaration(path: NodePath<VariableDeclaration>) {
			if (path.node.declarations.length === 1) {
				const identifier = path.node.declarations[0].id as Identifier;
				if (identifier.name === "err" || identifier.name === "vErrors") {
					path.remove();
				}
			}
		},
		IfStatement(path: NodePath<IfStatement>) {
			const test = path.get("test");
			if (test.isBinaryExpression()) {
				const left = test.get("left");
				if (left.isIdentifier() && (left.node as Identifier).name === "vErrors") {
					path.remove();
				}
			}
		},
		AssignmentExpression(path: NodePath<AssignmentExpression>) {
			const left = path.get("left");
			if (left.isMemberExpression()) {
				const object = left.get("object");
				if (object.isIdentifier() && (object.node as Identifier).name === "validate") {
					path.remove();
				}
			}
		},
	},
};

export default function(path: string): VirtualModule | void {
	if (!validatorsPathPattern.test(path)) {
		return;
	}
	const modulePath = existingPathForValidatorPath(path);
	if (typeof modulePath === "undefined") {
		return;
	}
	const schemas = buildSchemas(modulePath);
	return {
		generateTypeDeclaration() {
			const entries: string[] = [];
			for (const { name } of schemas) {
				entries.push(`import { ${name} as ${name}Type } from ${JSON.stringify(modulePath.replace(/(\.d)?\.ts$/, ""))};`);
				entries.push(`export function ${name}(value: any): value is ${name}Type;`);
			}
			return entries.join("\n");
		},
		generateModule() {
			// Compile and optimize validators for each of the types in the parent module
			const entries: string[] = [];
			for (const { name, schema } of schemas) {
				entries.push(`export const ${name} = ${ajv.compile(schema).toString()};`);
			}
			const original = entries.join("\n");
			const ast = babylon.parse(original, { sourceType: "module" });
			return babel.transformFromAst(ast, original, { plugins: [[rewriteAjv, {}]], compact: true }).code!;
		},
		instantiateModule() {
			// Compile validators for each of the types in the parent module
			const exports: any = {};
			Object.defineProperty(exports, "__esModule", { value: true });
			for (const { name, schema } of schemas) {
				const compiled = ajv.compile(schema);
				exports[name] = (value: any) => !!compiled(value);
			}
			return (global) => {
				global.exports = exports;
			};
		},
	};
}
