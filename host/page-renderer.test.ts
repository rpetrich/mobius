import { defaultDocument, PageRenderer, PageRenderMode } from "./page-renderer";

const defaults = {
	clientState: {
		clientID: 0,
		incomingMessageId: 0,
	},
	sessionState: {
		sessionID: "test",
		localChannelCount: 0,
	},
	clientURL: "/main.js",
	clientIntegrity: "sha1-main-dummy",
	fallbackURL: "/fallback.js",
	fallbackIntegrity: "sha1-fallback-dummy",
};

describe("PageRenderer", () => {
	const renderer = new PageRenderer({
		async cssForPath() {
			throw new Error("No CSS!");
		},
		...defaultDocument(),
	});
	it("bare render", async () => {
		expect(await renderer.render({
			mode: PageRenderMode.Bare,
			...defaults,
		})).toMatchSnapshot();
	});
	it("with form", async () => {
		expect(await renderer.render({
			mode: PageRenderMode.IncludeForm,
			...defaults,
		})).toMatchSnapshot();
	});
	it("with form and strip script", async () => {
		expect(await renderer.render({
			mode: PageRenderMode.IncludeFormAndStripScript,
			...defaults,
		})).toMatchSnapshot();
	});
});
