import { NodePath } from "babel-traverse";
import { AssignmentExpression, binaryExpression, booleanLiteral, Expression, expressionStatement, functionExpression, FunctionExpression, Identifier, ifStatement, IfStatement, isBinaryExpression, isBlockStatement, isIdentifier, isIfStatement, logicalExpression, MemberExpression, numericLiteral, returnStatement, Statement, stringLiteral, unaryExpression, VariableDeclaration } from "babel-types";

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
	if (path.isExpressionStatement()) {
		path.remove();
		return;
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
				path.replaceWith(consequent);
			} else if (alternate) {
				path.replaceWith(alternate);
			} else {
				const parentPath = path.parentPath;
				path.remove();
				simplifyExpressions(parentPath);
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

// Unsafe, but successfully strips out the extra code that tracks why a validation failed
export default function() {
	return {
		visitor: {
			VariableDeclaration(path: NodePath<VariableDeclaration>) {
				if (path.node.declarations.length === 1 && path.getFunctionParent()) {
					const identifier = path.node.declarations[0].id as Identifier;
					const name = identifier.name;
					if (name === "err" || name === "vErrors" || name === "errors" || /^valid/.test(name) || /^errs_/.test(name)) {
						path.remove();
					}
				}
			},
			UpdateExpression(path: NodePath<Identifier>) {
				const argument = path.get("argument");
				if (argument.isIdentifier() && (argument.node as Identifier).name === "errors") {
					path.replaceWith(literal(1));
					path.getStatementParent().replaceWith(returnStatement(literal(false)));
				}
			},
			Identifier(path: NodePath<Identifier>) {
				if (!path.getFunctionParent()) {
					return;
				}
				if (path.parentPath.isFunctionExpression()) {
					return;
				}
				if (path.parentPath.isMemberExpression() && !(path.parentPath.node as MemberExpression).computed && path.parentPath.get("right") === path) {
					return;
				}
				if (path.parentPath.isUpdateExpression() && path.get("left") === path) {
					return;
				}
				if (/^valid/.test(path.node.name)) {
					path.replaceWith(literal(true));
					simplifyExpressions(path);
				}
				switch (path.node.name) {
					case "dataPath":
					case "parentData":
					case "parentDataProperty":
					case "rootData":
						path.replaceWith(unaryExpression("void", literal(0)));
						simplifyExpressions(path);
						return;
					case "errors":
						path.replaceWith(literal(0));
						simplifyExpressions(path);
						return;
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
				} else if (left.isIdentifier()) {
					if ((left.node as Identifier).name === "errors") {
						path.replaceWith(path.get("right"));
					} else if (/^valid/.test((left.node as Identifier).name)) {
						// const right = path.get("right");
						// if (right.isBooleanLiteral() && (right.node as BooleanLiteral).value) {
						// 	path.remove();
						// } else {
							path.replaceWith(path.get("right"));
							simplifyExpressions(path);
						// }
					}
				}
			},
			FunctionExpression: {
				exit(path: NodePath<FunctionExpression>) {
					const node = path.node;
					if (!node.id && !node.async && !node.generator && node.params.length === 5) {
						const [first, second, third, fourth, fifth] = node.params;
						if (isIdentifier(first) && first.name === "data" &&
							isIdentifier(second) && second.name === "dataPath" &&
							isIdentifier(third) && third.name === "parentData" &&
							isIdentifier(fourth) && fourth.name === "parentDataProperty" &&
							isIdentifier(fifth) && fifth.name === "rootData"
						) {
							path.replaceWith(functionExpression(undefined, [first], path.node.body));
						}
					}
				},
			},
		},
	};
}
