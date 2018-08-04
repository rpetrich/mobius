import { NodePath } from "babel-traverse";
import { BlockStatement } from "babel-types";

export default function() {
	return {
		visitor: {
			BlockStatement(path: NodePath<BlockStatement>) {
				if (typeof (path.container as any).length == "number" && path.node.body.length) {
					path.replaceWithMultiple(path.node.body);
				}
			},
		},
	};
}
