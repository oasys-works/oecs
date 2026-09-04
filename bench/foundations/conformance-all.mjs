/**
 * Run `conformance.mjs` on every JS engine present, and require that they agree.
 *
 * The README claims Node, Deno, Chrome, Firefox and Safari. Those are two engine
 * families (V8 and JavaScriptCore), and until this script existed the test suite
 * ran on one. Round 3 of the substrate study found that a second engine
 * overturned a design rule. The cost of learning that late is the reason this
 * runs in CI.
 *
 * An engine that is not installed is skipped and named in the output. A skip is
 * not a pass, the summary says which engines actually ran, so a green result
 * never implies coverage it does not have.
 *
 * Exit code 1 if any engine fails its checks, or if two engines disagree on the
 * state hash.
 *
 * Requires `pnpm build` first (the probe imports `dist/index.js`, the artifact
 * a user receives, not a bundle of `src/`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./conformance.mjs", import.meta.url));
const DIST = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

if (!existsSync(DIST)) {
	console.error(`dist/index.js is missing, run \`pnpm build\` first.`);
	process.exit(1);
}

/** `engine` is the family the runtime uses, which is what actually varies. */
const ENGINES = [
	{ cmd: "node", args: [PROBE], engine: "V8" },
	{ cmd: "deno", args: ["run", "--allow-read", PROBE], engine: "V8" },
	{ cmd: "bun", args: [PROBE], engine: "JavaScriptCore" }
];

const ran = [];
const skipped = [];
let failed = false;

for (const { cmd, args, engine } of ENGINES) {
	const probe = spawnSync(cmd, ["--version"], { stdio: "ignore" });
	if (probe.error) {
		skipped.push(`${cmd} (${engine}), not installed`);
		continue;
	}
	const run = spawnSync(cmd, args, { encoding: "utf8" });
	const out = (run.stdout ?? "").trim();
	const line = out.split("\n").find((l) => l.includes("hash=")) ?? "";
	if (run.status !== 0 || line === "") {
		failed = true;
		console.error(`FAIL ${cmd} (${engine}) exited ${run.status}`);
		if (run.stdout) console.error(run.stdout.trim());
		if (run.stderr) console.error(run.stderr.trim());
		continue;
	}
	const hash = /hash=(\d+)/.exec(line)?.[1] ?? "?";
	ran.push({ cmd, engine, hash, line });
	console.log(`  ${engine.padEnd(15)} ${line}`);
}

console.log("");
if (skipped.length > 0) {
	console.log(`skipped: ${skipped.join(", ")}`);
}

if (ran.length === 0) {
	console.error("no engine ran, nothing was verified");
	process.exit(1);
}

const hashes = new Set(ran.map((r) => r.hash));
if (hashes.size > 1) {
	console.error(`DIVERGENCE, engines disagree on stateHash:`);
	for (const r of ran) console.error(`  ${r.cmd} (${r.engine}) → ${r.hash}`);
	process.exit(1);
}

const families = [...new Set(ran.map((r) => r.engine))];
console.log(
	`agree: ${ran.length} runtime(s) across ${families.length} engine family or families ` +
		`(${families.join(", ")}) → hash ${[...hashes][0]}`
);
if (families.length < 2) {
	console.log(
		`note: only one engine family ran. This result does NOT cover the other. ` +
			`Install bun (JavaScriptCore) to widen it.`
	);
}
process.exit(failed ? 1 : 0);
