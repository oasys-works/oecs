/**
 * P24 engine, the shipped pool against the sequential body.
 *
 * `p24-par-split` measured a hand-rolled split: its own worker file, its own
 * barrier, its own bind. This probe measures none of that. It builds a world
 * from `dist/`, calls `ecs.workers.attach`, registers a system with a `parallel`
 * config, and drives `ecs.update()`. Everything between the frame and the rows
 * is the engine's own code: the dispatch, the plan, the control buffer, the
 * worker entry, the descriptor walk and the join stamp.
 *
 * Two questions, and the probe answers both.
 *
 * **Is it correct?** The sequential lane and each pooled lane start from the
 * same seeded bytes and run the same number of frames. The probe compares the
 * live column bytes byte for byte. On the integer world it also compares
 * `ecs.snapshots.stateHash()`, which is the engine's own oracle and refuses to
 * run on a float world.
 *
 * **Is it faster?** One frame, workers already started, against the same system
 * running its `fn` with no pool attached. The kernel and the `fn` import one
 * module, so the two lanes execute the same source.
 *
 * One process for each variant. A 1,000,000-entity world allocates enough that
 * a second variant in the same process would be timed against the first one's
 * garbage.
 *
 * Run: `node bench/foundations/p24-par-engine.mjs`. One variant runs under bun
 * and under deno, see `findings-parallel.md` for what starts there.
 */
import { availableParallelism } from "node:os";
import { median, iqr, table, emit, variantArg, runVariant } from "./harness.mjs";
import { buildWorld, seedWorld, storeBuffer, kernelSpecs, loadEcs } from "./par/world.mjs";
import { bindColumnsLean, liveRowCount } from "./par/view.mjs";
import { integrate, spring } from "./par/engine-kernels.mjs";

const KERNELS_URL = new URL("./par/engine-kernels.mjs", import.meta.url).href;
const DT = 1 / 60;
const CORES = availableParallelism();
const SIZES = [10_000, 100_000, 1_000_000];
const KS = [1, 2, 4, 8].filter((k) => k <= CORES);

function timeIt(fn, { warmup = 3, samples = 15 } = {}) {
	for (let i = 0; i < warmup; i++) fn();
	const times = [];
	for (let s = 0; s < samples; s++) {
		const t0 = performance.now();
		fn();
		times.push(performance.now() - t0);
	}
	return { median: median(times), ...iqr(times) };
}

/** Every live column byte of the bound archetypes, in bind order. The exact
 * comparison, not a digest of one. */
function liveBytes(bound, buffer) {
	const parts = [];
	let total = 0;
	for (const b of bound) {
		const rows = liveRowCount(buffer, b.descriptorOff);
		for (const v of b.views) {
			const slice = new Uint8Array(v.buffer, v.byteOffset, rows * v.BYTES_PER_ELEMENT);
			parts.push(slice);
			total += slice.length;
		}
	}
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function bytesEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function fnv(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

async function runOne({ entities, deterministic }) {
	const world = await buildWorld({ entities, deterministic });
	const { ecs, Pos, Vel, Target } = world;
	seedWorld(ecs, Pos, Vel, Target);
	ecs.publishRowCounts();
	const buffer = storeBuffer(ecs);
	const specs = kernelSpecs(ecs, Pos, Vel, Target);
	const bound = bindColumnsLean(buffer, specs);
	const rowCounts = bound.map((b) => liveRowCount(buffer, b.descriptorOff));

	// The seeded bytes, so every lane starts from the same state.
	const seed = new Uint8Array(buffer.byteLength);
	seed.set(new Uint8Array(buffer));
	const restore = () => new Uint8Array(buffer).set(seed);

	// One system for each kernel, both registered, one enabled at a time. A run
	// condition and not a removal, because a removed system's plan would leave
	// the pool holding a kernel nothing dispatches.
	let active = "integrate";
	const only = (name) => ({ name: `only_${name}`, evaluate: () => active === name });

	const qA = ecs.query(Pos, Vel);
	const sysA = ecs.registerSystem({
		name: "integrate",
		reads: [Vel],
		writes: [Pos],
		parallel: {
			kernel: { js: KERNELS_URL, export: "integrate" },
			columns: [
				[Pos, "x"],
				[Pos, "y"],
				[Pos, "z"],
				[Vel, "vx"],
				[Vel, "vy"],
				[Vel, "vz"]
			],
			minRows: 1,
			query: qA
		},
		fn: (_ctx, dt) => {
			qA.forEachChunk((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				integrate(p.x, p.y, p.z, v.vx, v.vy, v.vz, 0, count, dt);
			});
		}
	});

	const qB = ecs.query(Pos, Vel, Target);
	const sysB = ecs.registerSystem({
		name: "spring",
		reads: [Target],
		writes: [Pos, Vel],
		parallel: {
			kernel: { js: KERNELS_URL, export: "spring" },
			columns: [
				[Pos, "x"],
				[Pos, "y"],
				[Pos, "z"],
				[Vel, "vx"],
				[Vel, "vy"],
				[Vel, "vz"],
				[Target, "tx"],
				[Target, "ty"],
				[Target, "tz"]
			],
			minRows: 1,
			query: qB
		},
		fn: (_ctx, dt) => {
			qB.forEachChunk((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.mut(Vel);
				const t = cols.read(Target);
				spring(p.x, p.y, p.z, v.vx, v.vy, v.vz, t.tx, t.ty, t.tz, 0, count, dt);
			});
		}
	});

	const { SCHEDULE } = await loadEcs();
	ecs.addSystems(
		SCHEDULE.UPDATE,
		{ system: sysA, runIf: only("integrate") },
		{ system: sysB, runIf: only("spring") }
	);

	const FRAMES = entities >= 1_000_000 ? 5 : entities >= 100_000 ? 20 : 100;
	const rows = [];
	const oracle = [];
	let workerEntry = "started";

	for (const kernel of ["integrate", "spring"]) {
		const label = kernel === "integrate" ? "A pos+=vel*dt" : "B damped spring";
		active = kernel;

		// No pool attached, so the schedule runs `fn`.
		restore();
		const tSeq = timeIt(() => {
			for (let f = 0; f < FRAMES; f++) ecs.update(DT);
		});
		const afterSeq = liveBytes(bound, buffer);
		const hashSeq = deterministic ? ecs.snapshots.stateHash() : null;
		rows.push({
			kernel: label,
			path: "sequential fn (no pool)",
			k: "-",
			msPerFrame: tSeq.median / FRAMES,
			p25: tSeq.p25 / FRAMES,
			p75: tSeq.p75 / FRAMES,
			fold: fnv(afterSeq),
			hash: hashSeq,
			match: "baseline"
		});

		for (const k of KS) {
			let pool;
			try {
				pool = await ecs.workers.attach({ count: k });
			} catch (error) {
				workerEntry = `workers.attach failed: ${error.message}`;
				break;
			}
			restore();
			const t = timeIt(() => {
				for (let f = 0; f < FRAMES; f++) ecs.update(DT);
			});
			const after = liveBytes(bound, buffer);
			const hashPar = deterministic ? ecs.snapshots.stateHash() : null;
			await pool.detach();

			const same = bytesEqual(afterSeq, after);
			rows.push({
				kernel: label,
				path: `${k} worker${k === 1 ? "" : "s"}`,
				k,
				msPerFrame: t.median / FRAMES,
				p25: t.p25 / FRAMES,
				p75: t.p75 / FRAMES,
				fold: fnv(after),
				hash: hashPar,
				match: same ? "yes" : "NO"
			});
			oracle.push({
				kernel: label,
				what: `${k} workers vs sequential fn`,
				bytes: same ? "equal" : "DIFFER",
				hash: deterministic ? (hashPar === hashSeq ? "equal" : "DIFFER") : "n/a (float world)"
			});
		}
	}

	return {
		entities,
		deterministic,
		frames: FRAMES,
		archetypes: bound.length,
		rowCounts,
		workerEntry,
		rows,
		oracle
	};
}

async function main() {
	const variant = variantArg();
	if (variant) {
		const [size, mode] = variant.split(":");
		emit(await runOne({ entities: Number(size), deterministic: mode === "int" }));
		return;
	}

	console.log(`\nP24 engine. availableParallelism() = ${CORES}, K capped at ${Math.max(...KS)}\n`);

	const results = [];
	for (const n of SIZES) results.push(runVariant(import.meta.url, `${n}:float`));
	results.push(runVariant(import.meta.url, `100000:int`));

	for (const r of results) {
		const lane = r.deterministic
			? "integer columns, { deterministic: true }, stateHash available"
			: "float columns, stateHash refuses to run";
		console.log(
			`\n--- ${r.entities.toLocaleString()} entities, ${r.archetypes} archetypes ${JSON.stringify(r.rowCounts)}, ${r.frames} frames per sample`
		);
		console.log(`    ${lane}`);
		console.log(`    worker entry: ${r.workerEntry}\n`);
		table(r.rows, [
			{ label: "kernel", get: (x) => x.kernel },
			{ label: "path", get: (x) => x.path },
			{ label: "ms/frame", get: (x) => x.msPerFrame.toFixed(4) },
			{ label: "p25", get: (x) => x.p25.toFixed(4) },
			{ label: "p75", get: (x) => x.p75.toFixed(4) },
			{
				label: "vs sequential fn",
				get: (x) => {
					const base = r.rows.find(
						(y) => y.kernel === x.kernel && y.path === "sequential fn (no pool)"
					);
					return (base.msPerFrame / x.msPerFrame).toFixed(2) + "x";
				}
			},
			{ label: "byte fold", get: (x) => x.fold },
			{ label: "stateHash", get: (x) => (x.hash === null ? "-" : x.hash) },
			{ label: "bytes match", get: (x) => x.match }
		]);
	}

	console.log("\nThe oracle, every configuration.\n");
	const all = [];
	for (const r of results) {
		for (const o of r.oracle) {
			all.push({ n: r.entities, lane: r.deterministic ? "int" : "float", ...o });
		}
	}
	table(all, [
		{ label: "entities", get: (x) => x.n },
		{ label: "lane", get: (x) => x.lane },
		{ label: "kernel", get: (x) => x.kernel },
		{ label: "comparison", get: (x) => x.what },
		{ label: "column bytes", get: (x) => x.bytes },
		{ label: "stateHash", get: (x) => x.hash }
	]);
	const bad = all.filter((x) => x.bytes !== "equal" || x.hash === "DIFFER");
	console.log(
		`\n  configurations compared: ${all.length}. mismatches: ${bad.length}${bad.length ? " <-- READ THESE" : ""}`
	);
	console.log("");
}

await main();
