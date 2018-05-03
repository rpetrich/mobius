import * as babel from "babel-core";
import { NodePath } from "babel-traverse";
import * as types from "babel-types";
import { BlockStatement, CallExpression, Expression, ForStatement, Identifier, isBinaryExpression, isCallExpression, isConditionalExpression, isIdentifier, isMemberExpression, isStringLiteral, LogicalExpression, Node, UnaryExpression, UpdateExpression, VariableDeclaration, VariableDeclarator } from "babel-types";
import Concat from "concat-with-sourcemaps";
import { resolve } from "path";
import { Chunk, Finaliser, getExportBlock, OutputOptions, Plugin, rollup, SourceDescription } from "rollup";
import _rollupBabel from "rollup-plugin-babel";
import _rollupTypeScript from "rollup-plugin-typescript2";
import { RawSourceMap } from "source-map";
import * as ts from "typescript";
import { packageRelative } from "./fileUtils";
import importBindingForCall from "./importBindingForCall";
import memoize from "./memoize";
import virtualModule, { ModuleMap } from "./modules/index";
import noImpureGetters from "./noImpureGetters";
import { isPurePath } from "./purity";
import rewriteForInStatements from "./rewriteForInStatements";
import { staticFileRoute, StaticFileRoute } from "./static-file-route";

// true to error on non-pure, false to evaluate anyway, undefined to ignore
interface RedactedExportData { [exportName: string]: Array<boolean | undefined>; }
const redactions: { [moduleName: string]: RedactedExportData } = {
	"redact": {
		redact: [true],
	},
	"sql": {
		execute: [true, true, false],
		sql: [true, true, true, true, true, true, true, true, true, true, true, true, true],
	},
	"sql-impl": {
		execute: [true, true, false],
	},
	"fetch": {
		fromServer: [false, false],
	},
	"broadcast": {
		send: [false, false],
		receive: [false],
		topic: [false],
	},
};

function isUndefined(node: Node) {
	return node.type == "Identifier" && (node as Identifier).name === "undefined";
}

function stripRedact() {
	// Remove calls to redact(...). This is critical to avoid leaking SQL queries and other secrets that shouldn't be distributed to client
	return {
		visitor: {
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const binding = importBindingForCall(path.node, path.scope);
					if (binding) {
						// console.log("binding", binding);
						const moduleRedactions = redactions[binding.module];
						if (moduleRedactions) {
							const methodRedactions = moduleRedactions[binding.export];
							if (methodRedactions) {
								const mappedArguments = (path.get("arguments") as any as Array<NodePath<Expression>>).map((arg, index) => {
									const policy = methodRedactions[index];
									if (typeof policy !== "undefined") {
										if (isPurePath(arg)) {
											if (arg.isIdentifier()) {
												const binding = path.scope.getBinding((arg.node as Identifier).name);
												if (binding && binding.references <= 1) {
													const init = binding.path.get("init");
													if (isPurePath(init)) {
														init.remove();
													}
												}
											}
											return types.identifier("undefined");
										}
										if (policy) {
											throw path.buildCodeFrameError(`Potential side-effects in argument ${index + 1} to ${binding.export} from ${binding.module} in ${path.getSource()}, where only pure expression was expected!`);
										}
									}
									return arg.node;
								});
								while (mappedArguments.length && isUndefined(mappedArguments[mappedArguments.length - 1])) {
									mappedArguments.pop();
								}
								path.replaceWith(types.callExpression(path.node.callee, mappedArguments));
								path.skip();
							}
						}
					}
				},
			},
		},
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
				},
			},
		},
	};
}

function stripUnusedArgumentCopies() {
	// Strip unnecessary desugaring of variable arguments when the variable arguments are unused (common on client for server-provided APIs and vice-versa)
	return {
		visitor: {
			ForStatement(path: NodePath<ForStatement>) {
				const init = path.get("init");
				const test = path.get("test");
				const update = path.get("update");
				const body = path.get("body");
				if (init.isVariableDeclaration() && (init.get("declarations") as any as Array<NodePath<VariableDeclarator>>).every((declarator) => declarator.isIdentifier() && isPurePath(declarator.get("init"))) &&
					isPurePath(test) &&
					update.isUpdateExpression() && update.get("argument").isIdentifier() &&
					body.isBlockStatement() && (body.node as BlockStatement).body.length == 1
				) {
					const bodyStatement = body.get("body.0");
					if (bodyStatement.isExpressionStatement()) {
						const expression = bodyStatement.get("expression");
						if (expression.isAssignmentExpression()) {
							const left = expression.get("left");
							const right = expression.get("right");
							const declarations = (init.node as VariableDeclaration).declarations;
							const updateName = ((update.node as UpdateExpression).argument as Identifier).name;
							if (updateName == (declarations[0].id as Identifier).name || // TypeScript's copy loop
								(declarations.length == 3 && updateName == (declarations[2].id as Identifier).name) // Babel's copy loop
							) {
								// TypeScripts trailing arguments copy loop
								if (left.isMemberExpression() && isPurePath(left) && left.get("object").isIdentifier() &&
									right.isMemberExpression() && isPurePath(right) && right.get("object").isIdentifier() && (right.get("object").node as Identifier).name == "arguments"
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
			},
		},
	};
}

function simplifyVoidInitializedVariables() {
	return {
		visitor: {
			VariableDeclarator(path: NodePath<VariableDeclaration>) {
				const init = path.get("init");
				if (init.node && init.isUnaryExpression()) {
					const unary = init.node as UnaryExpression;
					if (unary.operator === "void" && types.isLiteral(unary.argument)) {
						init.remove();
					}
				}
			},
		},
	};
}

// Rewrite Babel's typeof foo === "undefined" ? "undefined" : babelHelpers.typeof(foo) to babelHelpers.typeof(foo) when foo can be proved to be in scope
const simplifyTypeofVisitor = {
	visitor: {
		UnaryExpression(path: NodePath<UnaryExpression>) {
			if (path.node.operator === "typeof" && isIdentifier(path.node.argument) && path.scope.getBinding(path.node.argument.name)) {
				const parent = path.parentPath;
				if (isBinaryExpression(parent.node) && parent.node.operator === "===") {
					const opposite = path.getOpposite().node;
					if (isStringLiteral(opposite) && opposite.value === "undefined") {
						const grandparent = parent.parentPath;
						if (isConditionalExpression(grandparent.node) && grandparent.get("test") === parent) {
							const consequent = grandparent.get("consequent");
							const alternate = grandparent.get("alternate");
							if (isStringLiteral(consequent.node) && consequent.node.value === "undefined" && isCallExpression(alternate.node) && alternate.node.arguments.length === 1) {
								const argument = alternate.node.arguments[0];
								const callee = alternate.node.callee;
								if (isIdentifier(argument) && argument.name === path.node.argument.name && isMemberExpression(callee) && !callee.computed && isIdentifier(callee.object) && callee.object.name === "babelHelpers" && isIdentifier(callee.property) && callee.property.name === "typeof") {
									grandparent.replaceWith(alternate.node);
								}
							}
						}
					}
				}
			}
		},
	},
};

export interface CompiledRoute {
	route: StaticFileRoute;
	map?: RawSourceMap;
}

export interface CompilerOutput {
	routes: { [path: string]: CompiledRoute };
	moduleMap: ModuleMap;
}

const declarationPattern = /\.d\.ts$/;
const declarationOrJavaScriptPattern = /\.(d\.ts|js)$/;

export default async function(fileRead: (path: string) => void, input: string, basePath: string, publicPath: string, minify?: boolean): Promise<CompilerOutput> {
	// Dynamically load dependencies to reduce startup time
	const rollupBabel = require("rollup-plugin-babel") as typeof _rollupBabel;
	const rollupTypeScript = require("rollup-plugin-typescript2") as typeof _rollupTypeScript;
	const optimizeClosuresInRender = require("babel-plugin-optimize-closures-in-render");
	const transformAsyncToPromises = require("babel-plugin-transform-async-to-promises");
	const externalHelpers = require("babel-plugin-external-helpers");
	const syntaxDynamicImport = require("babel-plugin-syntax-dynamic-import");

	// Workaround to allow TypeScript to union two folders. This is definitely not right, but it works :(
	const parseJsonConfigFileContent = ts.parseJsonConfigFileContent;
	(ts as any).parseJsonConfigFileContent = function(this: any, json: any, host: ts.ParseConfigHost, basePath2: string, existingOptions?: ts.CompilerOptions, configFileName?: string, resolutionStack?: ts.Path[], extraFileExtensions?: ReadonlyArray<ts.JsFileExtensionInfo>): ts.ParsedCommandLine {
		const result = parseJsonConfigFileContent.call(this, json, host, basePath2, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		const augmentedResult = parseJsonConfigFileContent.call(this, json, host, basePath, existingOptions, configFileName, resolutionStack, extraFileExtensions);
		result.fileNames = result.fileNames.concat(augmentedResult.fileNames);
		return result;
	} as any;
	const mainPath = packageRelative("common/main.js");
	const memoizedVirtualModule = memoize((path: string) => virtualModule(basePath, path.replace(declarationOrJavaScriptPattern, ""), !!minify, fileRead));
	const plugins = [
		// Transform TypeScript
		rollupTypeScript({
			cacheRoot: resolve(basePath, ".cache"),
			include: [
				resolve(basePath, "**/*.+(ts|tsx|js|jsx|css)"),
				packageRelative("**/*.+(ts|tsx|js|jsx|css)"),
			] as any,
			exclude: [
				resolve(basePath, "node_modules/babel-plugin-transform-async-to-promises/*"),
				packageRelative("node_modules/babel-plugin-transform-async-to-promises/*"),
			] as any,
			tsconfig: packageRelative(`tsconfig-client.json`),
			tsconfigOverride: {
				include: [
					resolve(basePath, "**/*"),
					resolve(basePath, "*"),
					packageRelative("**/*"),
					packageRelative("*"),
				] as any,
				exclude: [] as any,
				compilerOptions: {
					baseUrl: basePath,
					paths: {
						"app": [
							resolve(basePath, input),
						],
						"*": [
							packageRelative(`client/*`),
							resolve(basePath, `client/*`),
							packageRelative("common/*"),
							resolve(basePath, "common/*"),
							packageRelative("types/*"),
							resolve(basePath, "*"),
						],
						"tslib": [
							packageRelative("node_modules/tslib/tslib"),
						],
						"babel-plugin-transform-async-to-promises/helpers": [
							packageRelative("node_modules/babel-plugin-transform-async-to-promises/helpers"),
						],
						"preact": [
							packageRelative("dist/common/preact"),
						],
					},
				},
			},
			verbosity: 0,
			typescript: require("typescript"),
			fileExistsHook(path: string) {
				const module = memoizedVirtualModule(path);
				if (module) {
					return true;
				}
				return false;
			},
			readFileHook(path: string) {
				const module = memoizedVirtualModule(path);
				if (module) {
					if (declarationPattern.test(path)) {
						return module.generateTypeDeclaration();
					} else {
						return module.generateModule();
					}
				}
			},
		}) as any as Plugin,
		// Transform the intermediary phases via babel
		rollupBabel({
			babelrc: false,
			presets: [],
			plugins: [
				syntaxDynamicImport(),
				externalHelpers(babel),
				[transformAsyncToPromises(babel), { externalHelpers: true, hoist: true }],
				optimizeClosuresInRender(babel),
				stripRedact(),
				rewriteForInStatements(),
				fixTypeScriptExtendsWarning(),
				noImpureGetters(),
				simplifyVoidInitializedVariables(),
				stripUnusedArgumentCopies(),
				// Replacement for babel-preset-env
				[require("babel-plugin-check-es2015-constants")],
				[require("babel-plugin-syntax-trailing-function-commas")],
				[require("babel-plugin-transform-es2015-arrow-functions")],
				[require("babel-plugin-transform-es2015-block-scoped-functions")],
				[require("babel-plugin-transform-es2015-block-scoping")],
				[require("babel-plugin-transform-es2015-classes")],
				[require("babel-plugin-transform-es2015-computed-properties")],
				[require("babel-plugin-transform-es2015-destructuring")],
				[require("babel-plugin-transform-es2015-duplicate-keys")],
				[require("babel-plugin-transform-es2015-for-of")],
				[require("babel-plugin-transform-es2015-function-name")],
				[require("babel-plugin-transform-es2015-literals")],
				[require("babel-plugin-transform-es2015-object-super")],
				[require("babel-plugin-transform-es2015-parameters")],
				[require("babel-plugin-transform-es2015-shorthand-properties")],
				[require("babel-plugin-transform-es2015-spread")],
				[require("babel-plugin-transform-es2015-sticky-regex")],
				[require("babel-plugin-transform-es2015-template-literals")],
				[require("babel-plugin-transform-es2015-typeof-symbol")],
				[require("babel-plugin-transform-es2015-unicode-regex")],
				[require("babel-plugin-transform-exponentiation-operator")],
				[simplifyTypeofVisitor],
			],
		}),
	];

	// If minifying, use Closure Compiler
	if (minify) {
		plugins.push(require("rollup-plugin-closure-compiler-js")({
			languageIn: "ES5",
			languageOut: "ES3",
			assumeFunctionWrapper: false,
			rewritePolyfills: false,
		}) as Plugin);
	}

	const mainChunkId = "./main.js";
	const routes: { [path: string]: CompiledRoute } = {};
	const moduleMap: ModuleMap = {};
	const routeIndexes: string[] = [];
	plugins.push({
		name: "mobius-output-collector",
		transform(code, id) {
			// Track input files read so the --watch option works
			fileRead(id.toString());
			return Promise.resolve();
		},
		ongenerate(options: OutputOptions, source: SourceDescription) {
			// Collect output into routes
			const path = ((options as any).bundle.name as string);
			routes[path.substr(1)] = {
				route: staticFileRoute(minify && path != mainChunkId ? "/" + routeIndexes.indexOf(path).toString(36) + ".js" : path.substr(1), source.code),
				map: source.map!,
			};
		},
	});
	const customFinalizer: Finaliser = {
		finalise(
			chunk: Chunk,
			magicString,
			{
				exportMode,
				getPath,
				indentString,
				intro,
				outro,
				dynamicImport,
			}: {
				exportMode: string;
				indentString: string;
				getPath: (name: string) => string;
				intro: string;
				outro: string;
				dynamicImport: boolean;
			},
			options: OutputOptions,
		) {
			const isMain = chunk.id === mainChunkId;

			// Bundle any CSS provided by the modules in the chunk (only virtual modules can provide CSS)
			const cssModuleName = chunk.id.replace(/(\.js)?$/, ".css");
			const css = new Concat(true, cssModuleName, minify ? "" : "\n\n");
			const bundledCssModulePaths: string[] = [];
			for (const module of chunk.orderedModules) {
				const implementation = memoizedVirtualModule(module.id);
				if (implementation && implementation.generateStyles) {
					bundledCssModulePaths.push(module.id);
					const variables = module.scope.variables;
					const usedVariables: string[] = [];
					for (const key of Object.keys(variables)) {
						if (variables[key].included) {
							usedVariables.push(variables[key].name);
						}
					}
					const styles = implementation.generateStyles(variables.this.included ? undefined : usedVariables);
					if (styles.css) {
						css.add(module.id, styles.css, styles.map);
					}
				}
			}

			// Register CSS route
			let cssRoute: StaticFileRoute | undefined;
			const cssString = css.content.toString();
			if (cssString) {
				const mapString = css.sourceMap;
				const cssMap = mapString ? JSON.parse(mapString) : undefined;
				cssRoute = staticFileRoute(cssModuleName.substr(1), cssString);
				if (!isMain) {
					routeIndexes.push(cssModuleName);
				}
				for (const bundledModuleName of bundledCssModulePaths) {
					moduleMap[bundledModuleName.replace(declarationOrJavaScriptPattern, "")] = cssRoute.foreverPath;
				}
				routes[cssModuleName.substr(1)] = {
					route: cssRoute,
					map: cssMap,
				};
			}

			const { dependencies, exports } = chunk.getModuleDeclarations();

			// Generate code to ask for and receive imported modules
			const mainIndex = dependencies.findIndex((m) => m.id === mainChunkId);
			let mainIdentifier: string = "__main_js";
			if (mainIndex !== -1) {
				mainIdentifier = dependencies[mainIndex].name;
				dependencies.splice(mainIndex, 1);
			}
			const deps = dependencies.map((m) => m.id).concat(cssRoute ? [cssModuleName] : []).map((id) => minify ? routeIndexes.indexOf(id).toString() : JSON.stringify(getPath(id)));
			const args = dependencies.map((m) => m.name);
			if (args.length || mainIndex !== -1) {
				args.unshift(mainIdentifier);
			}
			args.unshift("_import");

			// Generate code to write exported symbols into the exports object
			args.unshift("exports");
			const exportBlock = getExportBlock(exports, dependencies, exportMode);
			if (exportBlock) {
				magicString.append("\n\n" + exportBlock, {});
			}
			magicString.append("\n}", {});

			if (isMain) {
				args.push("document");
				if (cssRoute) {
					// Coordinate load with the main.css so that we don't inadvertently mutate the DOM before it's ready
					magicString.prepend(
						`var i=0,` +
						`stylesheets=document.querySelectorAll("link"),` +
						`link=document.createElement("link");` +
						`link.href=${JSON.stringify(cssRoute.foreverPath)};` +
						`if("onload" in link){` +
							`for(_mobius=link.onload=loaded;i<stylesheets.length;i++)` +
								`if(stylesheets[i].href==link.href)` +
									`return stylesheets[i].sheet ? loaded() : stylesheets[i].onload=loaded;` +
						`}else ` +
							`main();` +
						`link.rel="stylesheet";` +
						`link.setAttribute("integrity",${JSON.stringify(cssRoute.integrity)});` +
						`document.head.appendChild(link);` +
						`function loaded(){` +
							`main();` +
							`if(link=document.querySelector("style#mobius-inlined"))` +
								`link.parentNode.removeChild(link)` +
						`}` +
						`function main() {\n`);
				} else {
					magicString.prepend(`\n`);
				}
				// Add JavaScript equivalent of frame-ancestors 'none'
				magicString.prepend(
					`if (top != self) {` +
						`document.open();` +
						`document.close();` +
						`return;` +
					`}`);
				// Add sanity check for prerequisites, will early exit to fallback
				magicString.prepend(
					`(function(${args.join(", ")}) { ` +
					`if (!window.addEventListener || !Object.keys || typeof JSON == "undefined") ` +
						`return;`);
				function loadDataForModuleWithName(name: string): [string, string] {
					const route = routes[name.substr(1)].route;
					return [route.foreverPath, route.integrity];
				}
				// Insert imports mapping, using an array and indexes when minified
				let imports: any;
				if (minify) {
					const importsArray = routeIndexes.map(loadDataForModuleWithName);
					imports = importsArray;
				} else {
					const importsObject: { [path: string]: [string, string] } = {};
					routeIndexes.forEach((path) => importsObject[path] = loadDataForModuleWithName(path));
					imports = importsObject;
				}
				if (cssRoute) {
					magicString.append("}");
				}
				magicString.append(`)({}, ${JSON.stringify(imports)}, document)`);
			} else {
				// Generate code to inform the loader that our module's content has loaded
				magicString.prepend(`_mobius(function(${args.join(", ")}) {\n`);
				magicString.append(["", minify ? routeIndexes.indexOf(chunk.id).toString() : JSON.stringify(chunk.id)].concat(deps).join(", ") + ")");
			}

			return magicString;
		},
		dynamicImportMechanism: {
			// Replace import("path") with _import(moduleId)
			left: "_import(",
			right: ")",
			replacer: (text: string) => {
				if (minify) {
					return routeIndexes.indexOf(JSON.parse(text)).toString();
				}
			},
		},
	};

	const bundle = await rollup({
		input: [mainPath],
		external: (id: string, parentId: string, isResolved: boolean) => {
			return false;
		},
		plugins,
		acorn: {
			allowReturnOutsideFunction: true,
		},
		// Use experimental rollup features, including the aggressive merging features our fork features
		experimentalCodeSplitting: true,
		experimentalDynamicImport: true,
		aggressivelyMergeModules: true,
		minifyInternalNames: minify,
	});
	// Extract the prepared chunks
	if ("chunks" in bundle) {
		const chunks = bundle.chunks;
		for (const chunkName of Object.keys(chunks)) {
			if (chunkName !== mainChunkId) {
				routeIndexes.push(chunkName);
			}
		}
	}
	// Generate the output, using our custom finalizer for client
	await bundle.generate({
		format: customFinalizer,
		sourcemap: true,
		name: "app",
		legacy: true,
	});
	// Cleanup some of the mess we made
	(ts as any).parseJsonConfigFileContent = parseJsonConfigFileContent;
	return {
		routes,
		moduleMap,
	};
}
