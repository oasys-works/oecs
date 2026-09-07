/**
 * P20, is the row plane's element-kind polymorphism a real cost?
 *
 * `Archetype._bufs` is an `AnyTypedArray[]`, and the library supports eight
 * element kinds (`f32 f64 i8 i16 i32 u8 u16 u32`). Every row operation indexes
 * it: `dstBufs[i][tail] = si >= 0 ? srcBufs[si][srcRow] : 0` in `moveEntityFrom`,
 * and `this._bufs[offset + fi][row]` in the by-id read path. Those are keyed
 * accesses whose receiver can be any of the eight.
 *
 * Experiment 20 found that a generic call site reached with **one** shape is
 * free (0.94 to 1.05x), and that at two or more it falls off a **3.8 to 5.6x cliff
 * with no slope between**. If element kinds behave the same way at a keyed
 * access site, a world that mixes column types pays a step change that a
 * single-type world does not, and nothing in the library's documentation warns
 * about it.
 *
 * This was a hypothesis in a review, not a measurement, which under the study's
 * own first rule makes it an opinion. So: measure it.
 *
 * Design. Two worlds, identical in every respect that should matter:
 *   mono , 8 component fields, all `f64`
 *   mixed, 8 component fields spread across f64, f32, i32 and u8, so `_bufs` holds
 *           four distinct element kinds
 * Same field count, same archetype shape, same operation counts. `mixed` moves
 * fewer bytes than `mono` (f64 is the widest kind), so if a polymorphism cost
 * exists it has to overcome that head start to show up at all, any slowdown is
 * a lower bound on the effect, never an artifact of bandwidth.
 *
 * Two operations are measured separately, because they hit different sites:
 *   churn, add and remove a tag, which runs `moveEntityFrom`'s column copy loop
 *   byid , a cursor read, which runs the `_bufs[...][row]` read path
 */
import { emit, iqr, median, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";

const N = 200_000;
const SAMPLES = 15;
const WARMUP = 5;

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

function timeIt(fn) {
	let sink = 0;
	for (let i = 0; i < WARMUP; i++) sink += fn();
	const ts = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now();
		sink += fn();
		ts.push(performance.now() - t0);
	}
	globalThis.__sink = sink;
	return ts;
}

/** variant: `<mono|mixed>-<churn|byid>` */
async function run(name) {
	const [kind, op] = name.split("-");
	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS } = await import(DIST.href);

	const ecs = new ECS({ memory: { entities: N, columnCapacity: pow2(N) } });

	// Eight fields either way. `mono` uses one element kind. `mixed` uses four.
	const A =
		kind === "mono"
			? ecs.registerComponent({ a: "f64", b: "f64", c: "f64", d: "f64" })
			: ecs.registerComponent({ a: "f64", b: "f32", c: "i32", d: "u8" });
	const B =
		kind === "mono"
			? ecs.registerComponent({ e: "f64", f: "f64", g: "f64", h: "f64" })
			: ecs.registerComponent({ e: "f64", f: "f32", g: "i32", h: "u8" });
	const Tag = ecs.registerComponent({});

	const T = ecs.template(A({ a: 1, b: 2, c: 3, d: 4 }), B({ e: 5, f: 6, g: 7, h: 8 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);

	let times;
	if (op === "churn") {
		// Each add and each remove is one archetype transition, so one pass of
		// `moveEntityFrom`'s column copy loop per entity per direction.
		let on = false;
		times = timeIt(() => {
			on = !on;
			if (on) for (let i = 0; i < N; i++) ecs.addComponent(ids[i], Tag);
			else for (let i = 0; i < N; i++) ecs.removeComponent(ids[i], Tag);
			return N;
		});
	} else {
		const cur = ecs.cursorRead(A);
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) s += cur.at(ids[i]).a;
			return s;
		});
	}
	return { name, median: median(times), spread: iqr(times) };
}

const which = variantArg();
if (which) {
	emit(await run(which));
} else {
	console.log(`P20, element-kind polymorphism in the row plane (exp 20)`);
	console.log(`      ${N.toLocaleString()} entities, 8 component fields either way`);
	console.log(`      mono = all f64, 1 element kind. mixed = f64, f32, i32 and u8, 4 kinds`);
	console.log(`      mixed moves fewer bytes, so any slowdown is a lower bound\n`);

	console.log(`  ${"op".padEnd(7)} ${"runtime".padEnd(8)} ${"mono".padEnd(12)} ${"mixed".padEnd(12)} ${"mixed and mono".padEnd(11)} spreads overlap?`);
	console.log(`  ${"-".repeat(7)} ${"-".repeat(8)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(11)} ----------------`);
	const ratios = [];
	for (const op of ["churn", "byid"]) {
		for (const rt of RUNTIMES) {
			const mono = runVariantOn(rt, import.meta.url, `mono-${op}`);
			const mixed = runVariantOn(rt, import.meta.url, `mixed-${op}`);
			if (!mono || !mixed) continue;
			const ratio = mixed.median / mono.median;
			// A ratio is only worth reading if the two middle halves are disjoint.
			const overlap = mono.spread.p75 >= mixed.spread.p25 && mixed.spread.p75 >= mono.spread.p25;
			ratios.push({ op, rt: rt.cmd, ratio, overlap });
			console.log(
				`  ${op.padEnd(7)} ${rt.cmd.padEnd(8)} ` +
					`${(mono.median.toFixed(3) + " ms").padEnd(12)} ${(mixed.median.toFixed(3) + " ms").padEnd(12)} ` +
					`${(ratio.toFixed(2) + "x").padEnd(11)} ${overlap ? "OVERLAP (noise)" : "disjoint"}`
			);
		}
	}
	console.log("");
	const solid = ratios.filter((r) => !r.overlap);
	const worst = ratios.reduce((a, b) => (a.ratio > b.ratio ? a : b), { ratio: 0 });
	console.log(`  Experiment 20's cliff is 3.8-5.6x. Worst ratio measured here: ${worst.ratio.toFixed(2)}x.`);
	console.log(
		`  ${solid.length} of ${ratios.length} comparisons have disjoint middle halves; the rest are noise.`
	);
	console.log(
		`  A ratio near 1.00x means keyed element-kind polymorphism does NOT behave`
	);
	console.log(`  like the callback-shape cliff, and the review hypothesis is refuted.`);
}
