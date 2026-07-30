/**
 * Makes one ESM file from `src/index.ts` with esbuild.
 *
 * The build gives `__DEV__` a value, but it does not fold the result. Therefore the
 * bundle keeps each development guard as a branch, and the value of the flag
 * controls that branch at run time. The RESULT of the code is thus the result of
 * the released package, but the FORM of the code is not: `vite` folds the flag and
 * then removes the branch and its body from the artifacts.
 *
 * The correctness tools use this file. A measurement tool must not use it, because
 * the guards make each function larger, and the size of a function controls the
 * decisions of the compiler about it. A measurement uses `dist.mjs`, which makes
 * the artifacts of the package.
 *
 * One property of this bundle is necessary: the code keeps the form of `src/`.
 * `net-oracle/mutants.mjs` finds a text in the compiled code and replaces it, and a
 * fold of the code breaks each of those texts.
 *
 * `profile.mjs` also uses this file, but no property makes that necessary. The
 * artifacts keep the name of each function, and thus a profile of the artifacts is
 * possible to read. Note that NEITHER build keeps the lines of `src/`, and neither
 * build makes a source map. Therefore `readlines.mjs` gives the line of the bundle,
 * and not the line of the file that you name on the command line.
 *
 * Use this tool only for local work. It is not a part of the package.
 */
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// esbuild is an indirect dependency of vite. It is in the pnpm store, and pnpm
// does not put it in node_modules/.
//
// The search for the store goes UP from this directory, and it does not look only
// at the root of this checkout. A git worktree has no `node_modules` of its own,
// and thus the store is in a parent directory — the same rule that lets node find
// the modules from a worktree inside the checkout (`dist.mjs` gives the reason).
const esbuild = (() => {
	try {
		return require("esbuild");
	} catch {
		const fs = require("node:fs");
		for (let dir = root; ; dir = path.dirname(dir)) {
			const store = path.join(dir, "node_modules/.pnpm");
			if (fs.existsSync(store)) {
				const hit = fs.readdirSync(store).find((d) => /^esbuild@/.test(d));
				if (hit) return require(path.join(store, hit, "node_modules/esbuild"));
			}
			if (dir === path.dirname(dir)) break;
		}
		throw new Error("esbuild not found in any node_modules/.pnpm above this directory");
	}
})();

export async function buildLib(outfile, { dev = false, from = root } = {}) {
	await esbuild.build({
		entryPoints: [path.join(from, "src/index.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		outfile,
		define: { __DEV__: String(dev) },
		legalComments: "none",
		sourcemap: false,
		minify: false,
	});
	return outfile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const out = process.argv[2] ?? path.join(here, ".out/oecs.prod.mjs");
	await buildLib(out, { dev: process.argv.includes("--dev") });
	console.log("built", out);
}
