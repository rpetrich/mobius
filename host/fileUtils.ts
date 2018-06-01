import * as fs from "fs";
import { join as pathJoin } from "path";
import { promisify } from "util";
import { rimraf as rimrafLazy } from "./lazy-modules";

export const packageRelative = (relative: string) => pathJoin(__dirname, "../..", relative);

export const readFile = promisify(fs.readFile);
export async function readJSON(path: string) {
	return JSON.parse((await readFile(path)).toString());
}
export const writeFile = promisify(fs.writeFile);

export const mkdir = promisify(fs.mkdir);

export const unlink = promisify(fs.unlink);
export function rimraf(path: string) {
	return new Promise<void>((resolve, reject) => {
		rimrafLazy(path, (err) => err ? reject(err) : resolve());
	});
}

export const hardlink = promisify(fs.link);
export const symlink = promisify(fs.symlink);

export const stat = promisify(fs.stat);
export function exists(path: string) {
	return new Promise<boolean>((resolve) => fs.exists(path, resolve));
}
