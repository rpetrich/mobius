import { Scope } from "babel-traverse";
import { isIdentifier, isImportDeclaration, isMemberExpression, isStringLiteral, CallExpression, ImportDeclaration, ImportSpecifier } from "babel-types";

export default function importBindingForCall(node: CallExpression, scope: Scope): { module: string, export: string } | undefined {
	const callee = node.callee;
	if (isIdentifier(callee)) {
		const binding = scope.getBinding(callee.name);
		if (binding && binding.path.isImportSpecifier() &&
			isIdentifier((binding.path.node as ImportSpecifier).imported) &&
			isImportDeclaration(binding.path.parent) &&
			isStringLiteral((binding.path.parent as ImportDeclaration).source)) {
			return {
				module: (binding.path.parent as ImportDeclaration).source.value,
				export: (binding.path.node as ImportSpecifier).imported.name,
			};
		}
	} else if (isMemberExpression(callee) && !callee.computed && isIdentifier(callee.object) && isIdentifier(callee.property)) {
		const binding = scope.getBinding(callee.object.name);
		if (binding && binding.path.isImportNamespaceSpecifier() && isStringLiteral((binding.path.parent as ImportDeclaration).source)) {
			return {
				module: (binding.path.parent as ImportDeclaration).source.value,
				export: callee.property.name,
			};
		}
	}
}
