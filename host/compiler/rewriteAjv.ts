import { NodePath } from "babel-traverse";
import { AssignmentExpression, binaryExpression, booleanLiteral, Expression, expressionStatement, Identifier, ifStatement, IfStatement, isBinaryExpression, isBlockStatement, isIfStatement, logicalExpression, numericLiteral, Statement, stringLiteral, unaryExpression, VariableDeclaration } from "babel-types";

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
export default function() {
	return {
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
}
