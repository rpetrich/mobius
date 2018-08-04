import { validate } from "./csrf";

describe("validate", () => {
	it("should allow proper origin", () => {
		expect(validate({
			headers: {
				host: "localhost",
				origin: "localhost",
			}
		}, "localhost")).toBeUndefined();
	});
	it("should allow proper referer", () => {
		expect(validate({
			headers: {
				host: "localhost",
				referer: "http://localhost/",
			}
		}, "localhost")).toBeUndefined();
	});
	it("should fail origin", () => {
		expect(() => {
			validate({
				headers: {
					host: "localhost",
					origin: "attacker",
					referer: "http://localhost/",
				}
			}, "localhost");
		}).toThrow();
	});
	it("should fail referer", () => {
		expect(() => {
			validate({
				headers: {
					host: "localhost",
					referer: "http://attacker/",
				}
			}, "localhost");
		}).toThrow();
	});
});
