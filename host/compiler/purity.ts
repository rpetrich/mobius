import { NodePath } from "babel-traverse";
import { CallExpression, Expression, Identifier, MemberExpression, Node } from "babel-types";
import { pureBabylon as pure } from "side-effects-safe";
import importBindingForCall from "./importBindingForCall";

const pureFunctions: { [moduleName: string]: { [symbolName: string]: true } } = {
	redact: {
		redact: true,
	},
	sql: {
		sql: true,
	},
	dom: {
		h: true,
	},
	broadcast: {
		topic: true,
	},
};

function isPure(node: Node) {
	return pure(node, { pureMembers: /./, pureCallees: /^Array$/ });
}

export function isPurePath(path: NodePath): boolean {
	if (!path.node) {
		return true;
	}
	if (isPure(path.node)) {
		return true;
	}
	if (path.isCallExpression()) {
		const binding = importBindingForCall(path.node as CallExpression, path.scope);
		if (binding) {
			const moduleData = pureFunctions[binding.module];
			if (moduleData && moduleData[binding.export]) {
				return (path.get("arguments") as any as Array<NodePath<Expression>>).every(isPurePath);
			}
		} else {
			const callee = path.get("callee");
			if (callee.isMemberExpression() && !(callee.node as MemberExpression).computed) {
				const object = callee.get("object");
				const property = callee.get("property");
				if (object.isIdentifier() && (object.node as Identifier).name === "babelHelpers" &&
					property.isIdentifier() && (property.node as Identifier).name === "taggedTemplateLiteral") {
					return (path.get("arguments") as any as Array<NodePath<Expression>>).every(isPurePath);
				}
			}
		}
	}
	return false;
}
