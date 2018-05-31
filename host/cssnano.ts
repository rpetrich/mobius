import { once } from "./memoize";
import { cssnano } from "./lazy-modules";

export default once(() => cssnano({
	preset: "default",
	svgo: false,
}));
