/**
 * Run every foundation probe, in order, each in its own process.
 *
 * `node bench/foundations/run.mjs`           , all probes
 * `node bench/foundations/run.mjs p09 p20`   , only the probes whose name matches
 *
 * Requires `pnpm build` first: every probe measures `dist/index.js`, the
 * artifact a user receives, not a bundle of `src/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

if (!existsSync(dist)) {
	console.error("dist/index.js is missing, run `pnpm build` first.");
	process.exit(1);
}

const filters = process.argv.slice(2);
const probes = readdirSync(here)
	.filter((f) => /^p\d+-.*\.mjs$/.test(f) || f === "conformance-all.mjs")
	.sort()
	.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));

if (probes.length === 0) {
	console.error(`no probe matched ${filters.join(" ")}`);
	process.exit(1);
}

let failed = 0;
for (const p of probes) {
	console.log(`\n${"=".repeat(78)}\n${p}\n${"=".repeat(78)}`);
	const run = spawnSync(process.execPath, [here + p], {
		stdio: "inherit",
		env: { ...process.env, NODE_OPTIONS: "" }
	});
	if (run.status !== 0) failed++;
}

console.log(`\n${"=".repeat(78)}`);
console.log(`${probes.length} probe(s) run, ${failed} non-zero exit(s).`);
console.log(`Numbers are for THIS machine, THIS build. Record positions and ratios,`);
console.log(`not absolute values, see README.md.`);
process.exit(failed > 0 ? 1 : 0);
