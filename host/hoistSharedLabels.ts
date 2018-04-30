import { NodePath } from "babel-traverse";
import { LabeledStatement } from "babel-types";

export default function() {
	return {
		visitor: {
			LabeledStatement(path: NodePath<LabeledStatement>) {
				if (path.node.label.name === "shared") {
					const body = path.node.body;
					path.remove();
					const functionParent = path.scope.getFunctionParent().path;
					const sibling = functionParent.isStatement() ? functionParent : functionParent.getStatementParent();
					sibling.insertBefore(body);
				}
			}
		},
	};
}
