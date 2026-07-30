import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { buildLib } from "./build.mjs";
import { report } from "./harness.mjs";
import { runSuite } from "./suite.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.join(here, ".out");
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const saveIdx = args.indexOf("--save");
const saveName = saveIdx >= 0 ? args[saveIdx + 1] : null;
const cmpIdx = args.indexOf("--cmp");
const cmpName = cmpIdx >= 0 ? args[cmpIdx + 1] : null;
const filter = args.find((a) => !a.startsWith("--") && a !== saveName && a !== cmpName) ?? "";

const stamp = String(process.hrtime.bigint());
const outfile = path.join(outDir, `oecs.${dev ? "dev" : "prod"}.${stamp}.mjs`);
await buildLib(outfile, { dev });
const lib = await import(url.pathToFileURL(outfile).href);
fs.rmSync(outfile, { force: true });

const results = runSuite(lib, filter);
report(results);

// The saved baseline records the FILTER as well as the values. `makeSuite` builds
// every world whatever the filter is, but it runs only the cases that match, and
// a case leaves the heap in a different condition from the one it found. Therefore
// a baseline from `--save x iter` and a comparison over all the cases did not
// measure the same conditions, and nothing said so. The `__meta` key holds the
// filter; a case can never collide with it, because every case name has a "/".
if (saveName) {
	const file = path.join(outDir, `${saveName}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				__meta: { filter, dev, node: process.version, cases: results.length },
				...Object.fromEntries(results.map((r) => [r.name, r.nsPerOp])),
			},
			null,
			2
		)
	);
	console.log(`\nsaved → ${file}`);
}

if (cmpName) {
	const file = path.join(outDir, `${cmpName}.json`);
	if (!fs.existsSync(file)) {
		console.error(`\nno baseline ${file}`);
	} else {
		const base = JSON.parse(fs.readFileSync(file, "utf8"));
		const meta = base.__meta;
		if (meta === undefined) {
			console.error(`\nwarning: baseline ${cmpName} has no filter record — it is from an older run`);
		} else if (meta.filter !== filter) {
			console.error(
				`\nwarning: baseline ${cmpName} used filter ${JSON.stringify(meta.filter)}, this run uses ` +
					`${JSON.stringify(filter)}. The two runs executed different cases, so they left the heap ` +
					`in different conditions. Use the same filter for both.`
			);
		} else if (meta.dev !== dev) {
			console.error(
				`\nwarning: baseline ${cmpName} is a ${meta.dev ? "dev" : "prod"} build, this run is ` +
					`${dev ? "dev" : "prod"}. The development guards are not the same on the two sides.`
			);
		}
		console.log(`\n── vs ${cmpName} ──`);
		const w = Math.max(...results.map((r) => r.name.length));
		for (const r of results) {
			const b = base[r.name];
			if (b === undefined) continue;
			const delta = ((r.nsPerOp - b) / b) * 100;
			const mark = delta < -3 ? "FASTER" : delta > 3 ? "SLOWER" : "  ~   ";
			console.log(
				`${r.name.padEnd(w)}  ${b.toFixed(1).padStart(9)} → ${r.nsPerOp
					.toFixed(1)
					.padStart(9)} ns  ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%  ${mark}`
			);
		}
	}
}
