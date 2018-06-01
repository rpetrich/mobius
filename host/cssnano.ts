import { cssnano } from "./lazy-modules";
import { once } from "./memoize";

export default once(() => cssnano({
	preset: "default",
	svgo: false,
}));
