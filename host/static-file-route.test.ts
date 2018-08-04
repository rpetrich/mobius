import { brotliedBufferFromRoute, gzippedBufferFromRoute, staticFileRoute, stringFromRoute } from "./static-file-route";

const html = `<html><head>Test</head><body>body</body></html>`;

describe("staticFileRoute", () => {
	it("string should match snapshot", () => {
		expect(staticFileRoute("/test.html", html)).toMatchSnapshot();
	});
	it("buffer should match snapshot", () => {
		expect(staticFileRoute("/test.html", Buffer.from(html))).toMatchSnapshot();
	});
});

describe("stringFromRoute", () => {
	it("string should match", () => {
		expect(stringFromRoute(staticFileRoute("/test.html", html))).toBe(html);
	});
	it("buffer should match", () => {
		expect(stringFromRoute(staticFileRoute("/test.html", Buffer.from(html)))).toBe(html);
	});
});

describe("gzippedBufferFromRoute", () => {
	it("buffer should match", () => {
		expect(gzippedBufferFromRoute(staticFileRoute("/test.html", html))).toMatchSnapshot();
	});
});

describe("brotliedBufferFromRoute", () => {
	it("buffer should match", () => {
		expect(brotliedBufferFromRoute(staticFileRoute("/test.html", html))).toMatchSnapshot();
	});
});
