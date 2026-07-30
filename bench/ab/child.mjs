/**
 * One sample: run the suite against ONE bundle of the library, and write the best
 * time of each case to stdout as JSON. `ref.mjs` and `bundles.mjs` start this
 * program.
 *
 * A separate process is necessary. Two variants in one process gave a constant
 * error of some percent, and a null test could not remove it. A null test uses
 * equal code on both sides. A different sequence of the variants did not help, and
 * separate instances of the suite module did not help. The cause is that the two
 * worlds get their memory one after the other. Therefore one world gets a better
 * position in the heap, and a change to the sequence of the operations cannot move
 * an object that already has a position.
 *
 * In this program, each variant gets a new process. Each process loads one `ECS`
 * class only. Therefore each call site in the measured loops has one shape, as it
 * has for a user of one version of the library. Each process also runs the same
 * cases in the same sequence.
 *
 *   node bench/ab/child.mjs <bundle> <filter> <warmup> <samples>
 */
import path from "node:path";
import url from "node:url";
import { makeSuite } from "../suite.mjs";

const [, , bundle, filter, warmupArg, samplesArg] = process.argv;
const warmup = Number(warmupArg);
const samples = Number(samplesArg);

// The bundle path arrives as a plain filesystem path, so it has to be converted
// rather than handed to `import()` as-is.
const lib = await import(url.pathToFileURL(path.resolve(bundle)).href);

const cases = makeSuite(lib, filter ?? "");
const out = {};

for (const c of cases) {
	const setup = c.opts?.setup;
	for (let i = 0; i < warmup; i++) {
		const state = setup ? setup() : undefined;
		c.fn(state);
	}
	let best = Infinity;
	for (let s = 0; s < samples; s++) {
		const state = setup ? setup() : undefined;
		const t0 = process.hrtime.bigint();
		c.fn(state);
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		if (ms < best) best = ms;
	}
	out[c.name] = { ms: best, iters: c.opts?.iters ?? 1 };
}

process.stdout.write(JSON.stringify(out));
