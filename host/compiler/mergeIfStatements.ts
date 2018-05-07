import { NodePath } from "babel-traverse";
import { IfStatement, isBooleanLiteral, isIfStatement, isReturnStatement, logicalExpression, Node } from "babel-types";

function isReturnFalseIfStatement(node: Node): node is IfStatement {
	return isIfStatement(node) && !node.alternate && isReturnStatement(node.consequent) && isBooleanLiteral(node.consequent.argument) && !node.consequent.argument.value;
}

export default function() {
	return {
		visitor: {
			IfStatement(path: NodePath<IfStatement>) {
				const container = path.container;
				if ("length" in container && isReturnFalseIfStatement(path.node)) {
					const index = container.indexOf(path.node);
					if (index > 0) {
						const previous = path.getSibling((index - 1) as any as string);
						if (isReturnFalseIfStatement(previous.node)) {
							previous.get("test").replaceWith(logicalExpression("||", previous.node.test, path.node.test));
							path.remove();
						}
					}
				}
			},
		},
	};
}
