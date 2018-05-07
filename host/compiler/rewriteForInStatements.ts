import { NodePath } from "babel-traverse";
import { CallExpression, ForInStatement, FunctionDeclaration, Identifier, LabeledStatement, VariableDeclarator } from "babel-types";
import * as types from "babel-types";

const helpers = {
	__enumerate_props:	`function __enumerate_props(o) {
							var result = [];
							ignore_nondeterminism:
							for (var i in o) {
								result.push(i);
							}
							return result.sort(__sort_keys);
						}`,
	__sort_keys:	`var __is_numeric = /^\\d+$/; function __sort_keys(a, b) {
						var a_numeric = __is_numeric.test(a), b_numeric = __is_numeric.test(b);
						if (a_numeric) {
							return b_numeric ? a - b : -1;
						} else if (b_numeric) {
							return 1;
						} else {
							return a < b ? -1 : a > b ? 1 : 0;
						}
					}`,
};

function installHelper(name: keyof typeof helpers, path: NodePath) {
	const file = path.scope.hub.file;
	let result = file.declarations[name];
	if (!result) {
		result = file.declarations[name] = types.identifier(name);
		const helper = helpers[name];
		const template = require("babel-template");
		file.path.unshiftContainer("body", template(helper)());
	}
	return result;
}

export default function() {
	return {
		visitor: {
			// Rewrite for (... in ...) into the equivalent source that iterates in a well-defined order
			ForInStatement: {
				exit(path: NodePath<ForInStatement>) {
					let ancestor: NodePath = path;
					while (ancestor = ancestor.parentPath) {
						if (ancestor.isLabeledStatement() && (ancestor.node as LabeledStatement).label.name === "ignore_nondeterminism") {
							return;
						}
						if (ancestor.isVariableDeclarator() && ancestor.get("id").isIdentifier() && ((ancestor.node as VariableDeclarator).id as Identifier).name == "__extends") {
							return;
						}
					}
					const functionParent = path.getFunctionParent();
					if (functionParent && (functionParent.node as FunctionDeclaration).id && (functionParent.node as FunctionDeclaration).id.name == "_interopRequireWildcard") {
						return;
					}
					const node = path.node;
					const keysIdentifier = path.scope.generateUidIdentifier("keys");
					const iIdentifier = path.scope.generateUidIdentifier("i");
					const keysSubIExpression = types.memberExpression(keysIdentifier, iIdentifier, true);
					const body = node.body.type == "BlockStatement" ? node.body.body.slice() : [node.body];
					if (node.left.type == "VariableDeclaration") {
						body.unshift(types.variableDeclaration(node.left.kind, [types.variableDeclarator(node.left.declarations[0].id, keysSubIExpression)]));
					} else {
						body.unshift(types.expressionStatement(types.assignmentExpression("=", node.left, keysSubIExpression)));
					}
					installHelper("__sort_keys", path);
					path.replaceWith(types.forStatement(
						types.variableDeclaration("var", [
							types.variableDeclarator(keysIdentifier, types.callExpression(installHelper("__enumerate_props", path), [node.right])),
							types.variableDeclarator(iIdentifier, types.numericLiteral(0)),
						]),
						types.binaryExpression("<", iIdentifier, types.memberExpression(keysIdentifier, types.identifier("length"))),
						types.unaryExpression("++", iIdentifier),
						types.blockStatement(body)),
					);
					path.addComment("leading", "Deterministic for (... in ...)");
					path.skip();
				},
			},
			// Rewrite Object.keys(...) into Object.keys(...).sort(__sort_keys)
			CallExpression: {
				exit(path: NodePath<CallExpression>) {
					const node = path.node;
					const callee = node.callee;
					if (callee.type == "MemberExpression" && callee.object.type == "Identifier" && callee.object.name == "Object") {
						if (callee.property.type == "Identifier" && callee.property.name == "keys") {
							path.replaceWith(types.callExpression(types.memberExpression(node, types.identifier("sort")), [installHelper("__sort_keys", path)]));
							path.addComment("leading", "Deterministic Object.keys(...)");
							path.skip();
						}
					}
				},
			},
		},
	};
}
