import { resolve } from "path";
import { packageRelative } from "./fileUtils";
import { rollup, Plugin } from "rollup";
import { NodePath } from "babel-traverse";
import { existsSync } from "fs";
import { BlockStatement, CallExpression, ForStatement, Identifier, Node, LabeledStatement, LogicalExpression, StringLiteral, UpdateExpression, VariableDeclaration } from "babel-types";
import * as babel from "babel-core";
import * as types from "babel-types";
import { pureBabylon as pure } from "side-effects-safe";
import _rollupBabel from "rollup-plugin-babel";
import _includePaths from "rollup-plugin-includepaths";
import _rollupTypeScript from "rollup-plugin-typescript2";
import * as ts from "typescript";
import rewriteForInStatements from "./rewriteForInStatements";
import noImpureGetters from "./noImpureGetters";
import importBindingForCall from "./importBindingForCall";
import addSubresourceIntegrity from "./addSubresourceIntegrity";

// true to error on non-pure, false to evaluate anyway, undefined to ignore
type RedactedExportData = { [exportName: string]: (boolean | undefined)[] };
const redactions: { [moduleName: string]: RedactedExportData } = {
	"redact": {
		"redact": [true],
		"secret": [true, true, true, true, true, true, true],
	},
	"sql": {
		"query": [true, true, false],
		"modify": [true, true, false],
	},
	"sql-impl": {
		"execute": [true, true, false],
	},
	"fetch": {
		"fromServer": [false, false],
	},
	"broadcast": {
		"send": [false, false],
		"receive": [false]
	}
};

function isUndefined(node: Node) {
	return node.type == "Identifier" && (node as Identifier).name === "undefined";
}

function isPure(node: Node) {
	return pure(node, { pureMembers: /./ });
}

function isPureOrRedacted(path: NodePath) {
	if (isPure(path.node)) {
		return true;
	}
	if (path.isCallExpression()) {
		const binding = importBindingForCall(path as NodePath<CallExpression>);
		if (binding) {
			return binding.module === "redact" && binding.export === "redact";
		}
	}
	return false;
}

function stripRedact() {
	return {
		visitor: {
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const binding = importBindingForCall(path);
					if (binding) {
						const moduleRedactions = redactions[binding.module];
						if (moduleRedactions) {
							const methodRedactions = moduleRedactions[binding.export];
							if (methodRedactions) {
								const mappedArguments = path.node.arguments.map((arg, index) => {
									const isPure = isPureOrRedacted(path.get(`arguments.${index}`));
									switch (methodRedactions[index]) {
										case true:
											if (isPure) {
												return types.identifier("undefined");
											}
											throw path.buildCodeFrameError(`Potential side-effects in argument ${index+1} to ${binding.export} from ${binding.module} in ${path.getSource()}, where only pure expression was expected!`);
										case false:
											if (isPure) {
												return types.identifier("undefined");
											}
											return arg;
										default:
											return arg;
									}
								});
								while (mappedArguments.length && isUndefined(mappedArguments[mappedArguments.length-1])) {
									mappedArguments.pop();
								}
								path.replaceWith(types.callExpression(path.node.callee, mappedArguments));
								path.skip();
							}
						}
					}
				}
			}
		}
	};
}

function fixTypeScriptExtendsWarning() {
	return {
		visitor: {
			LogicalExpression: {
				exit(path: NodePath<LogicalExpression>) {
					const node = path.node;
					const left = node.left;
					if (node.operator == "||" && left.type == "LogicalExpression" && left.operator == "&&" && left.left.type == "ThisExpression") {
						const right = left.right;
						if (right.type == "MemberExpression" && right.object.type == "ThisExpression" && right.property.type == "Identifier" && /^__/.test(right.property.name)) {
							path.replaceWith(node.right);
						}
					}
				}
			}
		}
	};
}

function rewriteInsufficientBrowserThrow() {
	return {
		visitor: {
			LabeledStatement(path: NodePath<LabeledStatement>) {
				if (path.node.label.name === "insufficient_browser_throw" && path.get("body").isThrowStatement()) {
					path.replaceWith(types.returnStatement());
				}
			}
		}
	};
}

function stripUnusedArgumentCopies() {
	return {
		visitor: {
			ForStatement(path: NodePath<ForStatement>) {
				const init = path.get("init");
				const test = path.get("test");
				const update = path.get("update");
				const body = path.get("body");
				if (init.isVariableDeclaration() && (init.node as VariableDeclaration).declarations.every(declarator => declarator.id.type == "Identifier" && (!declarator.init || isPure(declarator.init))) &&
					isPure(test.node) &&
					update.isUpdateExpression() && update.get("argument").isIdentifier() && ((update.node as UpdateExpression).argument as Identifier).name === ((init.node as VariableDeclaration).declarations[0].id as Identifier).name &&
					body.isBlockStatement() && (body.node as BlockStatement).body.length == 1
				) {
					const bodyStatement = body.get("body.0");
					if (bodyStatement.isExpressionStatement()) {
						const expression = bodyStatement.get("expression");
						if (expression.isAssignmentExpression()) {
							const left = expression.get("left");
							const right = expression.get("right");
							if (left.isMemberExpression() && isPure(left.node) && left.get("object").isIdentifier() &&
								right.isMemberExpression() && isPure(right.node) && right.get("object").isIdentifier() && (right.get("object").node as Identifier).name == "arguments"
							) {
								const binding = left.scope.getBinding((left.get("object").node as Identifier).name);
								if (binding && binding.constant && binding.referencePaths.length == 1) {
									// Since the only reference is to the assignment variable is the compiler-generated copy loop, we can remove it entirely
									path.remove();
								}
							}
						}
					}
				}
			}
		}
	};
}

function verifyStylePaths(basePath: string) {
	return {
		visitor: {
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const args = path.node.arguments;
					if (args.length === 1 && args[0].type === "StringLiteral") {
						const binding = importBindingForCall(path);
						if (binding && binding.module === "dom" && binding.export === "style") {
							const value = (args[0] as StringLiteral).value;
							if (!/^\w+:/.test(value)) {
								if (!existsSync(resolve(basePath, value.replace(/^\/+/, "")))) {
									throw path.buildCodeFrameError(`Referenced a style path that does not exist: ${path.getSource()}`);
								}
							}
						}
					}
				}
			}
		}
	}
}

interface CompilerOutput {
	code: string;
	map: string;
}

export default async function(input: string, basePath: string, publicPath: string, minify: boolean) : Promise<CompilerOutput> {
	const includePaths = require("rollup-plugin-includepaths") as typeof _includePaths;
	const rollupBabel = require("rollup-plugin-babel") as typeof _rollupBabel;
	const rollupTypeScript = require("rollup-plugin-typescript2") as typeof _rollupTypeScript;
	const optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render");

	// Workaround to allow TypeScript to union two folders. This is definitely not right, but it works :(
	const parseJsonConfigFileContent = ts.parseJsonConfigFileContent;
	(ts as any).parseJsonConfigFileContent = function(this: any, json: any, host: ts.ParseConfigHost, basePath2: string, existingOptions?: ts.CompilerOptions, configFileName?: string, resolutionStack?: ts.Path[], extraFileExtensions?: ReadonlyArray<ts.JsFileExtensionInfo>) : ts.ParsedCommandLine {
		const result = parseJsonConfigFileContent.call(this, json, host, basePath2, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		const augmentedResult = parseJsonConfigFileContent.call(this, json, host, basePath, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		result.fileNames = result.fileNames.concat(augmentedResult.fileNames);
		return result;
	} as any;
	const plugins = [
		includePaths({
			include: {
				"preact": packageRelative("dist/common/preact")
			},
		}),
		rollupTypeScript({
			cacheRoot: resolve(basePath, ".cache"),
			include: [
				resolve(basePath, "**/*.ts+(|x)"),
				resolve(basePath, "*.ts+(|x)"),
				packageRelative("**/*.ts+(|x)"),
				packageRelative("*.ts+(|x)")
			] as any,
			tsconfig: packageRelative("tsconfig-client.json"),
			tsconfigOverride: {
				compilerOptions: {
					baseUrl: basePath,
					paths: {
						"app": [
							resolve(basePath, input)
						],
						"*": [
							packageRelative("client/*"),
							resolve(basePath, "client/*"),
							packageRelative("common/*"),
							resolve(basePath, "common/*"),
							packageRelative("types/*")
						],
						"tslib": [
							packageRelative("node_modules/tslib/tslib"),
						],
					}
				}
			},
		}) as any as Plugin,
		rollupBabel({
			babelrc: false,
			plugins: [
				optimizeClosuresInRender(babel),
				addSubresourceIntegrity(publicPath),
				stripRedact(),
				verifyStylePaths(publicPath),
				rewriteForInStatements(),
				fixTypeScriptExtendsWarning(),
				noImpureGetters(),
				rewriteInsufficientBrowserThrow(),
				stripUnusedArgumentCopies()
			]
		})
	];
	if (minify) {
		plugins.push(require("rollup-plugin-closure-compiler-js")({
			languageIn: "ES5",
			languageOut: "ES3",
			assumeFunctionWrapper: false,
			rewritePolyfills: false
		}) as Plugin);
	}
	const bundle = await rollup({
		input: packageRelative("client/main.js"),
		plugins,
		acorn: {
			allowReturnOutsideFunction: true
		}
	});
	const output = await bundle.generate({
		format: "iife",
		sourcemap: true
	});
	// Cleanup some of the mess we made
	(ts as any).parseJsonConfigFileContent = parseJsonConfigFileContent;
	return {
		code: output.code,
		map: output.map.toString(),
	};
}

