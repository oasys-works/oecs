/**
 * P21, garbage collection under a churning workload.
 *
 * Experiment 21 measured the arena hybrid against an all-objects equivalent and
 * found the result the philosophy leans on hardest (Part I §7): not the highest
 * speed, but the smallest surprise. Major collections went to **zero**, total
 * pause dropped 32.5x, and the longest single pause, the number a person
 * actually feels, went from **13.04 ms to 0.33 ms**. A 13 ms pause blows a
 * 16.7 ms frame; 0.33 ms does not.
 *
 * One caveat this probe cannot remove: experiment 21's hybrid included an
 * interned string table and a decode cache. `oecs` has no string columns, so
 * this measures the arena half only. An application that names its entities
 * keeps those names in JS objects on the side, and that side is not measured
 * here. The study's number does not transfer unchanged to such an app.
 *
 * Method: `--trace-gc` in a subprocess, parsing raw output. Experiment 21's
 * first attempt used an in-process `PerformanceObserver` and reported **0 GC
 * events while allocating 8 million objects**, because the observer's callback
 * is asynchronous and it was disconnected before firing. A `--trace-gc`
 * subprocess avoids both that and heap contamination from the harness.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { variantArg } from "./harness.mjs";

// Scale is an input: the point where an object world starts taking major
// collections depends on the machine's heap, so the probe must be able to walk
// up to it rather than assert a fixed size is enough.
const N = Number(process.env.P21_N ?? 200_000);
const TICKS = Number(process.env.P21_TICKS ?? 40);

// --- workloads ---------------------------------------------------------------

/** Arena-backed: components live in the ECS columns. Churn is structural,
 * entities gain and lose a tag every tick, which is the operation that moves
 * rows between archetypes. */
async function workloadOecs() {
	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS, SCHEDULE } = await import(DIST.href);

	const ecs = new ECS({ memory: { entities: N, columnCapacity: pow2(N) } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
	const Burning = ecs.registerComponent({});

	const q = ecs.query(Pos, Vel);
	ecs.addSystems(
		SCHEDULE.UPDATE,
		ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			fn: () => {
				q.forEachChunk((cols, count) => {
					const { x, y } = cols.mut(Pos);
					const { vx, vy } = cols.read(Vel);
					for (let i = 0; i < count; i++) {
						x[i] += vx[i];
						y[i] += vy[i];
					}
				});
			}
		})
	);
	ecs.startup();

	const T = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: -1 }));
	const ids = new Array(N);
	for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);

	for (let t = 0; t < TICKS; t++) {
		ecs.update(1);
		// Structural churn: a tenth of the population changes archetype each tick.
		for (let i = t % 10; i < N; i += 10) {
			const e = ids[i];
			if (ecs.hasComponent(e, Burning)) ecs.removeComponent(e, Burning);
			else ecs.addComponent(e, Burning);
		}
	}
	return ecs.entityCount;
}

/** The all-objects equivalent: identical semantics, ordinary JS. */
function workloadObjects() {
	const items = new Array(N);
	for (let i = 0; i < N; i++) items[i] = { x: 0, y: 0, vx: 1, vy: -1, burning: false };
	// A query in this world is a filtered array, rebuilt when membership changes,
	// the ordinary idiom, and the source of the allocation an arena does not make.
	for (let t = 0; t < TICKS; t++) {
		for (let i = 0; i < N; i++) {
			const o = items[i];
			o.x += o.vx;
			o.y += o.vy;
		}
		for (let i = t % 10; i < N; i += 10) {
			const o = items[i];
			// Changing shape is what an object world does instead of moving a row.
			items[i] = o.burning
				? { x: o.x, y: o.y, vx: o.vx, vy: o.vy, burning: false }
				: { x: o.x, y: o.y, vx: o.vx, vy: o.vy, burning: true, since: t };
		}
		const burning = items.filter((o) => o.burning);
		if (burning.length < 0) throw new Error("unreachable");
	}
	return items.length;
}

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

// --- trace-gc parsing --------------------------------------------------------

/** `[pid:0x...]  <ms> ms: Scavenge 12.3 (14.0) -> 8.1 (14.0) MB, 0.42 / 0.00 ms  ...`
 * The pause is the first number in the `a / b ms` pair. Both the collector name
 * and the pause are needed: experiment 21's cross-check initially contradicted
 * the fixed version because the grep pattern was wrong. */
function parseTraceGC(stderr) {
	const events = [];
	for (const line of stderr.split("\n")) {
		// Node 24 inserted a `pooled: N MB,` field between the heap figures and the
		// pause pair, so a pattern anchored on the first comma silently matches
		// nothing. Anchor on `(average mu`, which terminates the pause pair on
		// every version, and take the pair immediately before it.
		const m = /ms:\s+(Scavenge|Mark-Compact|Mark-sweep|Minor GC|Full GC|Sweep)\b.*?([\d.]+)\s*\/\s*[\d.]+\s*ms\s+\(average mu/.exec(
			line
		);
		if (!m) continue;
		const kind = m[1];
		const pause = Number(m[2]);
		const major = kind === "Mark-Compact" || kind === "Mark-sweep" || kind === "Full GC";
		events.push({ kind, pause, major });
	}
	return events;
}

function summarise(events) {
	const pauses = events.map((e) => e.pause);
	const total = pauses.reduce((a, b) => a + b, 0);
	return {
		events: events.length,
		minor: events.filter((e) => !e.major).length,
		major: events.filter((e) => e.major).length,
		totalPause: total,
		longestPause: pauses.length ? Math.max(...pauses) : 0,
		meanPause: pauses.length ? total / pauses.length : 0
	};
}

// --- driver ------------------------------------------------------------------

const WORKLOADS = { oecs: workloadOecs, objects: workloadObjects };
const which = variantArg();

if (which) {
	const out = await WORKLOADS[which]();
	console.log(`done ${out}`);
} else {
	console.log(`P21. GC under churn (exp 21 R1-R5)`);
	console.log(`      ${N.toLocaleString()} entities, ${TICKS} ticks, 10% change archetype per tick`);
	console.log(`      --trace-gc parsed from a subprocess (an in-process observer reports zero)\n`);

	const rows = [];
	for (const name of ["objects", "oecs"]) {
		const run = spawnSync(
			process.execPath,
			["--trace-gc", fileURLToPath(import.meta.url), `--variant=${name}`],
			{ encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
		);
		if (run.status !== 0) {
			console.error(`${name} failed (exit ${run.status})`);
			console.error((run.stderr ?? "").split("\n").slice(0, 8).join("\n"));
			process.exit(1);
		}
		// node writes --trace-gc to stdout
		rows.push({ name, ...summarise(parseTraceGC(`${run.stdout}\n${run.stderr}`)) });
	}

	const pad = (s, n) => String(s).padEnd(n);
	console.log(
		`  ${pad("metric", 22)} ${pad("all objects", 14)} ${pad("oecs", 14)} improvement`
	);
	console.log(`  ${"-".repeat(22)} ${"-".repeat(14)} ${"-".repeat(14)} -----------`);
	const o = rows.find((r) => r.name === "objects");
	const e = rows.find((r) => r.name === "oecs");
	const ratio = (a, b) => (b === 0 ? (a === 0 ? "none" : "∞") : `${(a / b).toFixed(1)}x`);
	console.log(`  ${pad("GC events (total)", 22)} ${pad(o.events, 14)} ${pad(e.events, 14)}`);
	console.log(`  ${pad("minor", 22)} ${pad(o.minor, 14)} ${pad(e.minor, 14)}`);
	console.log(`  ${pad("MAJOR", 22)} ${pad(o.major, 14)} ${pad(e.major, 14)} ${ratio(o.major, e.major)}`);
	console.log(
		`  ${pad("total pause", 22)} ${pad(o.totalPause.toFixed(1) + " ms", 14)} ${pad(e.totalPause.toFixed(1) + " ms", 14)} ${ratio(o.totalPause, e.totalPause)}`
	);
	console.log(
		`  ${pad("LONGEST single pause", 22)} ${pad(o.longestPause.toFixed(2) + " ms", 14)} ${pad(e.longestPause.toFixed(2) + " ms", 14)} ${ratio(o.longestPause, e.longestPause)}`
	);
	console.log(
		`  ${pad("mean pause", 22)} ${pad(o.meanPause.toFixed(3) + " ms", 14)} ${pad(e.meanPause.toFixed(3) + " ms", 14)}`
	);
	console.log("");
	console.log(`  A frame is 16.7 ms. objects worst pause = ${((o.longestPause / 16.7) * 100).toFixed(0)}% of a frame;`);
	console.log(`  oecs worst pause = ${((e.longestPause / 16.7) * 100).toFixed(0)}% of a frame.`);
	console.log(`  Event COUNT is the wrong metric, the design trades few expensive`);
	console.log(`  collections for many trivial ones. Compare the pauses, not the counts.`);
}
