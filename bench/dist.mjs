/**
 * Makes the artifacts of the package, and gives the path of one artifact.
 *
 * The measurement tools use this file. The correctness tools use `build.mjs`.
 * The two files are different, and the difference is important.
 *
 * `build.mjs` gives esbuild a value for `__DEV__`, but it does not give esbuild
 * permission to fold the result. Therefore the bundle keeps `if (DEV) …` at each
 * guard, and the guard is a branch that is always false. The released package does
 * not keep those branches: `vite` folds the flag and then removes the branch and
 * its body. Thus a measurement of a bundle from `build.mjs` is a measurement of
 * code that no user of the package receives. The guards make each function larger,
 * and the size of a function controls the decisions of the compiler about it.
 *
 * This file starts `scripts/build.mjs` instead, which is the build of the package.
 * Therefore each measurement loads the same file that npm gives to a user.
 *
 * The build writes to `dist/` in the checkout that it builds. This file then makes
 * a copy of `dist/` in a directory of the tool. A copy is necessary, because a
 * comparison holds two builds at the same time, and a second build in the same
 * checkout replaces the first.
 *
 * Use this tool only for local work. It is not a part of the package.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

/** The file of each variant, from the `exports` map of `package.json`. `import`
 * gives `index.js`. The `development` condition and the `/dev` subpath give
 * `index.development.js`. */
const ENTRY = { production: "index.js", development: "index.development.js" };

/**
 * Builds the package in `from`, copies the artifacts to `dest`, and gives the path
 * of the entry file. `dest` receives a new copy at each call.
 *
 * `from` can be a different checkout, and it can be a git worktree. A worktree has
 * no `node_modules` of its own. Therefore the caller must put the worktree INSIDE
 * this checkout, because node then finds `node_modules` in a parent directory. Do
 * not make a symbolic link to `node_modules`: a subsequent delete of the worktree
 * can go through the link and remove the modules of the user.
 *
 * @param {string} from  the root of the checkout to build
 * @param {string} dest  the directory that receives the copy of `dist/`
 * @param {{ dev?: boolean }} [opts]  `dev` selects the build that keeps the guards
 * @returns {string} the path of the entry file in `dest`
 */
export function buildDist(from, dest, { dev = false } = {}) {
	const source = path.resolve(from);
	const script = path.join(source, "scripts/build.mjs");
	if (!fs.existsSync(script)) {
		throw new Error(`no scripts/build.mjs in ${source}, thus this is not a checkout of the package`);
	}

	// The build writes its report to stdout. A measurement tool writes its result to
	// stdout as well, and thus the report goes to stderr with the other progress.
	execFileSync(process.execPath, [script], { cwd: source, stdio: ["ignore", "inherit", "inherit"] });

	const dist = path.join(source, "dist");
	const entry = dev ? ENTRY.development : ENTRY.production;
	if (!fs.existsSync(path.join(dist, entry))) {
		throw new Error(`the build in ${source} made no dist/${entry}`);
	}

	// The entry file imports the chunks that the build makes beside it. Therefore
	// the copy must hold the full directory, and not the entry file alone.
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(dist, dest, { recursive: true });
	return path.join(dest, entry);
}

/**
 * Makes a git worktree of `ref` inside this checkout, and gives its path. The
 * position inside the checkout is a requirement of `buildDist`.
 *
 * @param {string} ref  the git ref to check out
 * @param {string} at  the path of the worktree, inside this checkout
 */
export function addWorktree(ref, at) {
	removeWorktree(at);
	execFileSync("git", ["worktree", "add", "--detach", at, ref], { cwd: ROOT, stdio: "inherit" });
	return at;
}

/** Removes a worktree that `addWorktree` made. It is safe to call this function
 * when the worktree does not exist. */
export function removeWorktree(at) {
	if (fs.existsSync(at)) {
		try {
			execFileSync("git", ["worktree", "remove", "--force", at], { cwd: ROOT, stdio: "ignore" });
		} catch {
			// A worktree that git does not know about stays on the disk. `prune` below
			// then makes the record of git agree with the disk.
			fs.rmSync(at, { recursive: true, force: true });
		}
	}
	try {
		execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
	} catch {
		// `prune` is a repair, and a failure of a repair must not stop the tool.
	}
}
