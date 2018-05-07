import { once } from "./memoize";

export default once(() => require("cssnano")({
	preset: "default",
	svgo: false,
}));
