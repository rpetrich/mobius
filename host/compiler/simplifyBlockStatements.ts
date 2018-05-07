import { NodePath } from "babel-traverse";
import { BlockStatement } from "babel-types";

export default function() {
	return {
		visitor: {
			BlockStatement(path: NodePath<BlockStatement>) {
				if ("length" in path.container && path.node.body.length) {
					path.replaceWithMultiple(path.node.body);
				}
			},
		},
	};
}
