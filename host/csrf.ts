interface Request {
	headers: { [name: string]: string | string[] | undefined };
}

export function validate(request: Request, host?: string) {
	const resolvedHost = typeof host === "string" ? host : request.headers.host;
	// Check Origin
	const origin = request.headers.origin;
	if (typeof origin === "string") {
		if (origin.replace(/^\w+:\/\//, "") === resolvedHost) {
			return;
		}
	} else {
		// Fallback to checking Referer
		const referer = request.headers.referer;
		if (typeof referer === "string") {
			const match = referer.match(/^\w+:\/\/([^/]+)/);
			if (match && match[1] === resolvedHost) {
				return;
			}
		}
	}
	throw new Error("Request may be a cross-site request forgery!");
}
