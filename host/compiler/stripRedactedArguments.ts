import { NodePath } from "babel-traverse";
import { CallExpression, callExpression, Expression, Identifier, identifier, isIdentifier, Node } from "babel-types";
import importBindingForCall from "./importBindingForCall";
import { isPurePath } from "./purity";

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
	return isIdentifier(node) && node.name === "undefined";
}

export default function() {
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
												const innerBinding = path.scope.getBinding((arg.node as Identifier).name);
												if (innerBinding && innerBinding.references <= 1) {
													const init = innerBinding.path.get("init") as any as NodePath<Expression>;
													if (isPurePath(init)) {
														init.remove();
													}
												}
											}
											return identifier("undefined");
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
								path.replaceWith(callExpression(path.node.callee, mappedArguments));
								path.skip();
							}
						}
					}
				},
			},
		},
	};
}
