/**
 * P17, the composite kernel, on every engine present.
 *
 * This probe reproduces the study's single most consequential result, and it is
 * the one the library most needs to answer.
 *
 * Experiment 01 walked seven fields of arithmetic and the buffer won 1.77x. That
 * workload is memory-bound, and it flattered the premise. Experiment 17 built a
 * composite kernel instead, handle deref, tag dispatch, field update, three
 * fields touched and a branch taken, and found the fully-safe stack running at
 * **0.73 to 0.93x plain JS objects on V8**. Slower. K1 FAIL.
 *
 * The reason matters: V8 optimises monomorphic plain objects extremely hard, so
 * the buffer advantage is conditional on the workload being memory-bound. The
 * study's own conclusion was to change the claim, not the data.
 *
 * So: on a branch-heavy, few-field kernel, is `oecs` faster or slower than the
 * plain objects it exists to replace? Both variants do identical work and are
 * checksummed against each other, because experiment 08 lost a measurement to a
 * benchmark whose comparison never actually compared anything.
 *
 * Run on every runtime installed. Round 3's lesson is that a ratio measured on
 * one engine is not a property of JavaScript.
 */
import { emit, iqr, median, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";

const N = 1_000_000;
const SAMPLES = 15;
const WARMUP = 5;

const KIND_IDLE = 0;
const KIND_MOVING = 1;
const KIND_DYING = 2;
const KIND_SPAWNING = 3;

/** Seeded so every variant and every engine gets the identical entity mix. */
function kindOf(i) {
	let h = (i * 2654435761) >>> 0;
	h ^= h >>> 15;
	return h & 3;
}

// --- the kernel, written twice over the same semantics ----------------------

async function variantOecs() {
	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS, SCHEDULE } = await import(DIST.href);

	const ecs = new ECS({
		memory: { entities: N, columnCapacity: pow2(N) }
	});
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Kind = ecs.registerComponent({ k: "i32" });
	const Health = ecs.registerComponent({ hp: "i32" });

	const q = ecs.query(Pos, Kind, Health);
	const kernel = ecs.registerSystem({
		reads: [Kind],
		writes: [Pos, Health],
		fn: () => {
			q.forEachChunk((cols, count) => {
				const { x, y } = cols.mut(Pos);
				const { hp } = cols.mut(Health);
				const { k } = cols.read(Kind);
				for (let i = 0; i < count; i++) {
					// Tag dispatch, a switch on a tag, which the study measured at
					// +86% and named the right shape for a closed set.
					switch (k[i]) {
						case KIND_IDLE:
							hp[i] += 1;
							break;
						case KIND_MOVING:
							x[i] += 1.5;
							y[i] -= 0.5;
							break;
						case KIND_DYING:
							hp[i] -= 2;
							break;
						default:
							x[i] += 0.25;
							hp[i] += 3;
							break;
					}
				}
			});
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, kernel);
	ecs.startup();

	const T = ecs.template(Pos({ x: 0, y: 0 }), Kind({ k: 0 }), Health({ hp: 100 }));
	const ids = new Array(N);
	for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
	// Write the kind mix through the public by-id path.
	for (let i = 0; i < N; i++) ecs.setField(ids[i], Kind, "k", kindOf(i));

	const times = timeIt(() => ecs.update(1));
	// Checksum: read every entity back so the comparison is verified to have
	// computed something, and the two variants are verified to agree.
	let sum = 0;
	q.forEachChunk((cols, count) => {
		const { x, y } = cols.mut(Pos);
		const { hp } = cols.mut(Health);
		for (let i = 0; i < count; i++) sum = (sum + x[i] + y[i] + hp[i]) % 1e9;
	});
	return { name: "oecs", median: median(times), spread: iqr(times), checksum: Math.round(sum) };
}

function variantPlainObj() {
	const items = new Array(N);
	for (let i = 0; i < N; i++) items[i] = { x: 0, y: 0, k: kindOf(i), hp: 100 };

	const times = timeIt(() => {
		for (let i = 0; i < N; i++) {
			const o = items[i];
			switch (o.k) {
				case KIND_IDLE:
					o.hp += 1;
					break;
				case KIND_MOVING:
					o.x += 1.5;
					o.y -= 0.5;
					break;
				case KIND_DYING:
					o.hp -= 2;
					break;
				default:
					o.x += 0.25;
					o.hp += 3;
					break;
			}
		}
		return items.length;
	});
	let sum = 0;
	for (let i = 0; i < N; i++) sum = (sum + items[i].x + items[i].y + items[i].hp) % 1e9;
	return { name: "plainObj", median: median(times), spread: iqr(times), checksum: Math.round(sum) };
}

// --- plumbing ---------------------------------------------------------------

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

function timeIt(fn) {
	for (let i = 0; i < WARMUP; i++) fn();
	const ts = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now();
		fn();
		ts.push(performance.now() - t0);
	}
	return ts;
}

const VARIANTS = { oecs: variantOecs, plainObj: variantPlainObj };

const which = variantArg();
if (which) {
	emit(await VARIANTS[which]());
} else {
	console.log(`P17, composite kernel (exp 17 K1): handle deref + tag dispatch + field update`);
	console.log(`      ${N.toLocaleString()} entities, one tick, one process per (runtime, variant)`);
	console.log(`      exp 17 measured the fully-safe stack at 0.73-0.93x plain objects on V8\n`);

	const rows = [];
	const skipped = [];
	for (const rt of RUNTIMES) {
		const oecs = runVariantOn(rt, import.meta.url, "oecs");
		const plain = runVariantOn(rt, import.meta.url, "plainObj");
		if (!oecs || !plain) {
			skipped.push(rt.cmd);
			continue;
		}
		rows.push({
			runtime: rt.cmd,
			engine: rt.engine,
			oecs: oecs.median,
			plain: plain.median,
			ratio: plain.median / oecs.median,
			agree: oecs.checksum === plain.checksum,
			oecsSpread: oecs.spread,
			plainSpread: plain.spread,
			checksum: oecs.checksum
		});
	}

	if (rows.length === 0) {
		console.error("no runtime produced a result");
		process.exit(1);
	}

	console.log(
		`  ${"runtime".padEnd(8)} ${"engine".padEnd(7)} ${"oecs".padEnd(10)} ${"plainObj".padEnd(10)} ${"oecs vs plain".padEnd(14)} checksums`
	);
	console.log(`  ${"-".repeat(8)} ${"-".repeat(7)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(14)} ---------`);
	for (const r of rows) {
		console.log(
			`  ${r.runtime.padEnd(8)} ${r.engine.padEnd(7)} ` +
				`${(r.oecs.toFixed(2) + " ms").padEnd(10)} ${(r.plain.toFixed(2) + " ms").padEnd(10)} ` +
				`${(r.ratio.toFixed(2) + "x").padEnd(14)} ${r.agree ? "agree" : "DISAGREE"}`
		);
	}
	if (skipped.length) console.log(`\n  skipped (not installed): ${skipped.join(", ")}`);

	const bad = rows.filter((r) => !r.agree);
	if (bad.length) {
		console.log(`\n  !! checksums disagree, the two variants are not computing the same thing.`);
		console.log(`     Every number above is void until that is fixed.`);
		process.exit(1);
	}
	const worst = rows.reduce((a, b) => (a.ratio < b.ratio ? a : b));
	const best = rows.reduce((a, b) => (a.ratio > b.ratio ? a : b));
	console.log(
		`\n  range: ${worst.ratio.toFixed(2)}x (${worst.runtime}) .. ${best.ratio.toFixed(2)}x (${best.runtime})`
	);
	console.log(`  K1 verdict: oecs is ${worst.ratio >= 1 ? "FASTER" : "SLOWER"} than plain objects on every engine tested`);
}
