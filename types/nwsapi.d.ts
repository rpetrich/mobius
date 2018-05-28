declare module "nwsapi" {

	function nwsapi(global: { document: Document }): {
		ancestor(selector: string, context: Element, callback?: (element: Element) => void): Element | null;
		first(selector: string, context: Element, callback?: (element: Element) => void): Element | null;
		match(selector: string, context: Element, callback?: (element: Element) => void): boolean;
		select(selector: string, context: Element, callback?: (element: Element) => void): Element[];

		byId(id: string, from: Element): Element | null;
		byTag(tag: string, from: Element): Element[];
		byClass(tag: string, from: Element): Element[];

		configure(options: { BUGFIX_ID?: boolean; SIMPLENOT?: boolean; USE_HTML5?: boolean; VERBOSITY?: boolean; LOGERRORS?: boolean; }): void;
	}

	export = nwsapi;
}
