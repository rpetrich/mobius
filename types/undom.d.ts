declare module "undom" {

	interface DefaultView {
		document: Document;
		Document: any;
		Node: any;
		Text: any;
		Element: any;
		SVGElement: any;
		Event: any;
	}

	function undom(): Document & { defaultView: DefaultView };

	export = undom;
}
