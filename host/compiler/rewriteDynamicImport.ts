import { NodePath } from "babel-traverse";
import { CallExpression } from "babel-types";
import * as types from "babel-types";

// Convert import(...) to Promise.resolve(...).then(require) to simulate ES2017 dynamic imports in CommonJS
export default {
	visitor: {
		Import(path: NodePath) {
			if (path.parentPath.isCallExpression()) {
				const call = path.parentPath as NodePath<CallExpression>;
				if (call.get("callee") === path && call.node.arguments.length === 1) {
					const promise = types.callExpression(types.memberExpression(types.identifier("Promise"), types.identifier("resolve")), call.node.arguments);
					call.replaceWith(types.callExpression(types.memberExpression(promise, types.identifier("then")), [types.identifier("require")]));
				}
			}
		},
	},
};
