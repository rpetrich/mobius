import * as Ajv from "ajv";
import * as babel from "babel-core";
import { NodePath } from "babel-traverse";
import { AssignmentExpression, binaryExpression, booleanLiteral, BlockStatement, Expression, expressionStatement, Identifier, ifStatement, IfStatement, isBinaryExpression, isBlockStatement, isIfStatement, logicalExpression, numericLiteral, Statement, stringLiteral, unaryExpression, VariableDeclaration } from "babel-types";
import { parse } from "babylon";
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

function isLiteral(value: any): boolean | number | string {
	return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function literal(value: boolean | number | string) {
	if (typeof value === "boolean") {
		return booleanLiteral(value);
	}
	if (typeof value === "number") {
		return numericLiteral(value);
	}
	return stringLiteral(value);
}

function notExpression(node: Expression) {
	if (isBinaryExpression(node)) {
		switch (node.operator) {
			case "===":
				return binaryExpression("!==", node.left, node.right);
			case "!==":
				return binaryExpression("===", node.left, node.right);
			case "==":
				return binaryExpression("!=", node.left, node.right);
			case "!=":
				return binaryExpression("==", node.left, node.right);
		}
	}
	return unaryExpression("!", node);
}

function simplifyExpressions(path: NodePath) {
	while (path.isExpression()) {
		const result = path.evaluate();
		if (result.confident && isLiteral(result.value)) {
			path.replaceWith(literal(result.value));
			path = path.parentPath;
		} else {
			return;
		}
	}
	if (path.isIfStatement()) {
		const test = path.get("test") as NodePath<Expression>;
		const consequentPath = path.get("consequent");
		let consequent = consequentPath.node;
		if (isBlockStatement(consequent) && consequent.body.length === 1) {
			consequent = consequent.body[0];
			consequentPath.replaceWith(consequent);
		}
		const alternatePath = path.get("alternate");
		let alternate = alternatePath.node as Statement | undefined;
		if (alternate && isBlockStatement(alternate)) {
			if (alternate.body.length === 1) {
				alternate = alternate.body[0];
				alternatePath.replaceWith(alternate);
			} else if (alternate.body.length === 0) {
				alternate = undefined;
				alternatePath.remove();
			}
		}
		const result = test.evaluate();
		if (result.confident) {
			if (result.value) {
				if (!alternate) {
					path.replaceWith(consequent);
				}
			} else {
				if (isBlockStatement(consequent) && consequent.body.length === 0) {
					if (alternate) {
						path.replaceWith(alternate);
					} else {
						path.remove();
					}
				}
			}
		} else if (isBlockStatement(consequent) && consequent.body.length === 0) {
			if (alternate) {
				path.replaceWith(ifStatement(notExpression(test.node), alternate));
			} else {
				path.replaceWith(expressionStatement(test.node));
			}
		} else if (!alternate && isIfStatement(consequent) && !consequent.alternate) {
			path.replaceWith(ifStatement(logicalExpression("&&", test.node, consequent.test), consequent.consequent));
		}
	}
}

function evaluateAssignment(path: NodePath) {
	if (path.isAssignmentExpression() && (path.node as AssignmentExpression).operator === "=") {
		return path.get("right").evaluate();
	}
	if (path.isVariableDeclarator()) {
		const init = path.get("init");
		if (init && init.node) {
			return init.evaluate();
		}
	}
	return { confident: false, value: undefined };
}

function isEmptyDeclarator(path: NodePath) {
	return path.isVariableDeclarator() && !path.get("init").node;
}

// Unsafe, but successfully strips out the extra code that tracks why a validation failed
const rewriteAjv = {
	visitor: {
		VariableDeclaration(path: NodePath<VariableDeclaration>) {
			if (path.node.declarations.length === 1 && path.getFunctionParent()) {
				const identifier = path.node.declarations[0].id as Identifier;
				if (identifier.name === "err" || identifier.name === "vErrors" || identifier.name === "errors") {
					path.remove();
				}
			}
		},
		Identifier(path: NodePath<Identifier>) {
			if (!path.getFunctionParent()) {
				return;
			}
			if (path.node.name === "errors") {
				path.replaceWith(numericLiteral(0));
				simplifyExpressions(path.parentPath);
			}
			const binding = path.scope.getBinding(path.node.name);
			if (binding && binding.path.node) {
				const constantViolations = binding.constantViolations.length ? binding.constantViolations.slice() : [binding.path];
				const evaluated = evaluateAssignment(constantViolations[0]).value;
				if (isLiteral(evaluated) && constantViolations.every((cv) => (evaluateAssignment(cv).value === evaluated) || isEmptyDeclarator(cv))) {
					// Copy literal constants into all of the places they're referenced
					const referencePaths = binding.referencePaths.slice();
					for (const ref of referencePaths) {
						ref.replaceWith(literal(evaluated));
					}
					referencePaths.forEach(simplifyExpressions);
					// Remove all assignments
					for (const cv of constantViolations) {
						if (cv.isAssignmentExpression()) {
							if (cv.parentPath.isExpressionStatement()) {
								cv.parentPath.remove();
							} else {
								cv.replaceWith(literal(evaluated));
								simplifyExpressions(cv.parentPath);
							}
						} else if (cv.isVariableDeclarator()) {
							cv.remove();
						}
					}
					// Remove original binding path (if any)
					if (binding.path.node) {
						binding.path.remove();
					}
				}
			}
		},
		IfStatement: {
			enter(path: NodePath<IfStatement>) {
				const test = path.get("test");
				if (test.isBinaryExpression()) {
					const left = test.get("left");
					if (left.isIdentifier() && (left.node as Identifier).name === "vErrors") {
						path.remove();
					}
				}
			},
			exit: simplifyExpressions,
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

const simplifyBlockStatements = {
	visitor: {
		BlockStatement(path: NodePath<BlockStatement>) {
			if ("length" in path.container && path.node.body.length) {
				path.replaceWithMultiple(path.node.body);
			}
		}
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
			const ast = parse(original, { sourceType: "module" });
			return babel.transformFromAst(ast, original, { plugins: [[rewriteAjv, {}], [simplifyBlockStatements, {}]], compact: true }).code!;
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
