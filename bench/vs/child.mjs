/**
 * One measurement: ONE library and ONE case, in a new process. It writes
 * `{"bestMs":…,"medianMs":…,"iters":…}` to stdout.
 *
 * A separate process is the same rule that `bench/ab/child.mjs` records. It is more
 * important here than in a comparison of one library with itself. All the ECS
 * libraries in one process give more than one shape at each measured call site: one
 * inline cache then holds a different shape of `addComponent` for each of them. No
 * library operates in that condition in a real application. One library in each
 * process keeps one shape in each hot loop, as the users of that library have.
 *
 *   node child.mjs <impl> <case> <bundlePath> <warmup> <samples>
 */
import url from "node:url";
import { IMPLS } from "./cases.mjs";

const [, , implName, caseName, bundle, warmupArg, samplesArg] = process.argv;
const warmup = Number(warmupArg);
const samples = Number(samplesArg);

const spec = IMPLS[implName];
if (spec === undefined) throw new Error(`unknown impl ${implName}`);

let lib;
if (spec.kind === "bundle") {
	lib = await import(url.pathToFileURL(bundle).href);
} else if (spec.kind === "npm") {
	lib = await import(spec.pkg);
}

// becsy's `World.create` is async, so a factory may return a promise.
const cases = await spec.make(lib);
const c = cases[caseName];
if (c === undefined) {
	process.stdout.write(JSON.stringify({ absent: true }));
	process.exit(0);
}

// becsy's `world.execute()` is async, so a case's `fn` may return a promise. It is
// awaited only when it actually is one, so every synchronous library's timed region
// stays free of a microtask boundary. For becsy the single await is amortised over
// the 100 repetitions its system runs internally.
const isThenable = (v) => v !== null && typeof v === "object" && typeof v.then === "function";

const setup = c.setup;
for (let i = 0; i < warmup; i++) {
	const state = setup ? await setup() : undefined;
	const r = c.fn(state);
	if (isThenable(r)) await r;
}
const times = [];
for (let s = 0; s < samples; s++) {
	const state = setup ? await setup() : undefined;
	const t0 = process.hrtime.bigint();
	const r = c.fn(state);
	if (isThenable(r)) await r;
	const t1 = process.hrtime.bigint();
	times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
// The checksum is taken AFTER all warmup + sample runs, so every library has
// executed `fn` exactly (warmup + samples) times against the same starting state.
// That makes the value comparable across libraries: if one of them iterated the
// wrong entity set, dropped writes to an out-of-bounds index, or no-opped
// entirely, its checksum parts company with the rest. Without this a benchmark
// can measure nothing happening very quickly.
process.stdout.write(
	JSON.stringify({
		bestMs: times[0],
		medianMs: times[(times.length / 2) | 0],
		iters: c.iters,
		checksum: c.check ? await c.check() : null,
	})
);
