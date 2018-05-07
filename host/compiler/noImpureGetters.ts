import { NodePath } from "babel-traverse";
import { ClassMethod, LabeledStatement, ObjectMethod } from "babel-types";
import { pureBabylon as pure } from "side-effects-safe";

function verifyPurityOfGetters(path: NodePath<ClassMethod> | NodePath<ObjectMethod>) {
	if (path.node.kind === "get" && !pure(path.node.body, { pureMembers: /./ })) {
		let ancestor: NodePath = path;
		while (ancestor = ancestor.parentPath) {
			if (ancestor.isLabeledStatement() && (ancestor.node as LabeledStatement).label.name === "ignore_nondeterminism") {
				return;
			}
		}
		throw path.buildCodeFrameError("Impure getter methods may introduce non-determinism as a result of optimization!");
	}
}

export default function() {
	return {
		visitor: {
			ClassMethod: verifyPurityOfGetters,
			ObjectMethod: verifyPurityOfGetters,
		},
	};
}
