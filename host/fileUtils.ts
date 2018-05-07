import * as fs from "fs";
import { join as pathJoin } from "path";
import * as rimraf_ from "rimraf";
import * as util from "util";
import { once } from "./memoize";

export const packageRelative = (relative: string) => pathJoin(__dirname, "../..", relative);

export const readFile = util.promisify(fs.readFile);
export async function readJSON(path: string) {
	return JSON.parse((await readFile(path)).toString());
}
export const writeFile = util.promisify(fs.writeFile);

export const mkdir = util.promisify(fs.mkdir);

export const unlink = util.promisify(fs.unlink);
const rimrafLazy = once(() => util.promisify(require("rimraf") as typeof rimraf_));
export async function rimraf(path: string) {
	await rimrafLazy()(path);
}

export const hardlink = util.promisify(fs.link);
export const symlink = util.promisify(fs.symlink);

export const stat = util.promisify(fs.stat);
export function exists(path: string) {
	return new Promise<boolean>((resolve) => fs.exists(path, resolve));
}
