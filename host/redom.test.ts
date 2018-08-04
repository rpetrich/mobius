import { newDocument, serialize } from "./redom";

describe("newDocument", () => {
	it("head", () => {
		expect(newDocument().head.nodeName).toBe("HEAD");
	});
	it("body", () => {
		expect(newDocument().body.nodeName).toBe("BODY");
	});
});

describe("serialize", () => {
	it("output", () => {
		expect(serialize(newDocument())).toBe(`<html><head></head><body></body></html>`);
	});
});

describe("monkey patches", () => {
	const doc = newDocument();
	doc.head.className = "head";
	doc.body.setAttribute("id", "test");
	it("getElementById", () => {
		expect(doc.getElementById("test")).toBe(doc.body);
	});
	it("getElementsByTagName", () => {
		expect(doc.getElementsByTagName("body")[0]).toBe(doc.body);
	});
	it("getElementsByClassName", () => {
		expect(doc.getElementsByClassName("head")[0]).toBe(doc.head);
	});
	it("querySelector", () => {
		expect(doc.querySelector("body")).toBe(doc.body);
	});
	it("querySelectorAll", () => {
		expect(doc.querySelectorAll("head")[0]).toBe(doc.head);
	});
	it("cloneNode", () => {
		expect(doc.head.cloneNode(true).nodeName).toBe("HEAD");
	});
});
