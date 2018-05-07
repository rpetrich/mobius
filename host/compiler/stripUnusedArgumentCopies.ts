import { NodePath } from "babel-traverse";
import { BlockStatement, ForStatement, Identifier, UpdateExpression, VariableDeclaration, VariableDeclarator } from "babel-types";
import { isPurePath } from "./purity";

export default function() {
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
