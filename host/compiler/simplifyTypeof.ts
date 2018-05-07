import { NodePath } from "babel-traverse";
import { isBinaryExpression, isCallExpression, isConditionalExpression, isIdentifier, isMemberExpression, isStringLiteral, UnaryExpression } from "babel-types";

// Rewrite Babel's typeof foo === "undefined" ? "undefined" : babelHelpers.typeof(foo) to babelHelpers.typeof(foo) when foo can be proved to be in scope
export default function() {
	return {
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
}
