import { NodePath } from "babel-traverse";
import { isLiteral, UnaryExpression, VariableDeclarator } from "babel-types";

export default function() {
	return {
		visitor: {
			VariableDeclarator(path: NodePath<VariableDeclarator>) {
				const init = path.get("init");
				if (init.node && init.isUnaryExpression()) {
					const unary = init.node as UnaryExpression;
					if (unary.operator === "void" && isLiteral(unary.argument)) {
						init.remove();
					}
				}
			},
		},
	};
}
