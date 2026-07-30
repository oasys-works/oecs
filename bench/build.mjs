/**
 * Makes one ESM file from src/index.ts, with __DEV__ = false. The build then has
 * the semantics of the released package, because it removes all the development
 * guards as dead code. Therefore each benchmark measures the hot path of the
 * released package.
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
const esbuild = (() => {
	try {
		return require("esbuild");
	} catch {
		const fs = require("node:fs");
		const dir = path.join(root, "node_modules/.pnpm");
		const hit = fs.readdirSync(dir).find((d) => /^esbuild@/.test(d));
		if (!hit) throw new Error("esbuild not found in node_modules/.pnpm");
		return require(path.join(dir, hit, "node_modules/esbuild"));
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
