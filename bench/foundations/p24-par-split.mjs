/**
 * P24 split, one system across K workers.
 *
 * The question has two halves and the probe answers both.
 *
 * **Is it correct?** A sequential run and a K-worker run start from the same
 * seeded bytes and run the same number of frames. The probe then compares the
 * live column bytes byte for byte, and folds them. On the integer world it also
 * compares `ecs.snapshots.stateHash()`, which is the engine's own oracle.
 * `stateHash` refuses to run on a float world, so the float lane has the byte
 * compare and nothing stronger.
 *
 * **Is it faster?** Per frame, workers already started, against two sequential
 * baselines: the registered system driven by `ecs.update()`, and the same
 * kernel run straight over the query's chunks with no engine frame around it.
 *
 * One process for each variant. A 1,000,000-entity world allocates enough that
 * a second variant in the same process would be timed against the first one's
 * garbage.
 *
 * Run: `node bench/foundations/p24-par-split.mjs`. Also runs under `deno run -A`
 * and under `bun`.
 */
import { availableParallelism } from "node:os";
import { median, iqr, table, emit, variantArg, runVariant } from "./harness.mjs";
import { buildWorld, seedWorld, storeBuffer, kernelSpecs } from "./par/world.mjs";
import { bindColumnsLean, liveRowCount } from "./par/view.mjs";
import { startPool } from "./par/pool.mjs";
import { runKernel, KERNEL_A, KERNEL_B } from "./par/kernels.mjs";

const WORKER = new URL("./par/split-worker.mjs", import.meta.url);
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

	// The registered systems, one for each kernel, driven by `ecs.update()`.
	const qA = ecs.query(Pos, Vel);
	const qB = ecs.query(Pos, Vel, Target);
	const chunkViews = (cols, kernel) => {
		const p = cols.mut(Pos);
		const v = cols.mut(Vel);
		if (kernel === KERNEL_A) return [p.x, p.y, p.z, v.vx, v.vy, v.vz, null, null, null];
		const t = cols.read(Target);
		return [p.x, p.y, p.z, v.vx, v.vy, v.vz, t.tx, t.ty, t.tz];
	};
	let activeKernel = KERNEL_A;
	const sys = ecs.registerSystem({
		reads: [Target],
		writes: [Pos, Vel],
		fn: () => {
			const q = activeKernel === KERNEL_A ? qA : qB;
			q.forEachChunk((cols, count) => {
				runKernel(activeKernel, chunkViews(cols, activeKernel), 0, count, DT);
			});
		}
	});
	const { SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	ecs.addSystems(SCHEDULE.UPDATE, sys);

	/** The same kernel, run over the raw bound views with no engine frame. */
	const seqLoop = (kernel) => {
		for (let i = 0; i < bound.length; i++) {
			runKernel(kernel, bound[i].views, 0, rowCounts[i], DT);
		}
	};

	const FRAMES = entities >= 1_000_000 ? 5 : entities >= 100_000 ? 20 : 100;
	const rows = [];
	const oracle = [];

	for (const kernel of [KERNEL_A, KERNEL_B]) {
		const name = kernel === KERNEL_A ? "A pos+=vel*dt" : "B damped spring";
		activeKernel = kernel;

		// Sequential, through the engine frame.
		restore();
		const tSystem = timeIt(() => {
			for (let f = 0; f < FRAMES; f++) ecs.update(DT);
		});
		const afterSystem = liveBytes(bound, buffer);
		const hashSystem = deterministic ? ecs.snapshots.stateHash() : null;

		// Sequential, the bare loop.
		restore();
		const tLoop = timeIt(() => {
			for (let f = 0; f < FRAMES; f++) seqLoop(kernel);
		});
		const afterLoop = liveBytes(bound, buffer);
		const hashLoop = deterministic ? ecs.snapshots.stateHash() : null;

		rows.push({
			kernel: name,
			path: "sequential system (ecs.update)",
			k: "-",
			msPerFrame: tSystem.median / FRAMES,
			p25: tSystem.p25 / FRAMES,
			p75: tSystem.p75 / FRAMES,
			fold: fnv(afterSystem),
			hash: hashSystem,
			match: "baseline"
		});
		rows.push({
			kernel: name,
			path: "sequential loop (no frame)",
			k: "-",
			msPerFrame: tLoop.median / FRAMES,
			p25: tLoop.p25 / FRAMES,
			p75: tLoop.p75 / FRAMES,
			fold: fnv(afterLoop),
			hash: hashLoop,
			match: bytesEqual(afterSystem, afterLoop) ? "yes" : "NO"
		});
		oracle.push({
			kernel: name,
			what: "sequential loop vs sequential system",
			bytes: bytesEqual(afterSystem, afterLoop) ? "equal" : "DIFFER",
			hash: deterministic ? (hashSystem === hashLoop ? "equal" : "DIFFER") : "n/a (float world)"
		});

		for (const k of KS) {
			const pool = await startPool(WORKER, k, { buffer, specs, dt: DT });
			restore();
			const t = timeIt(() => {
				for (let f = 0; f < FRAMES; f++) pool.run(kernel);
			});
			const after = liveBytes(bound, buffer);
			const hashPar = deterministic ? ecs.snapshots.stateHash() : null;
			await pool.stop();
			const same = bytesEqual(afterSystem, after);
			rows.push({
				kernel: name,
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
				kernel: name,
				what: `${k} workers vs sequential system`,
				bytes: same ? "equal" : "DIFFER",
				hash: deterministic
					? hashPar === hashSystem
						? "equal"
						: "DIFFER"
					: "n/a (float world)"
			});
		}
	}

	return {
		entities,
		deterministic,
		frames: FRAMES,
		archetypes: bound.length,
		rowCounts,
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

	console.log(`\nP24 split. availableParallelism() = ${CORES}, K capped at ${Math.max(...KS)}\n`);

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
		console.log(`    ${lane}\n`);
		table(r.rows, [
			{ label: "kernel", get: (x) => x.kernel },
			{ label: "path", get: (x) => x.path },
			{ label: "ms/frame", get: (x) => x.msPerFrame.toFixed(4) },
			{ label: "p25", get: (x) => x.p25.toFixed(4) },
			{ label: "p75", get: (x) => x.p75.toFixed(4) },
			{
				label: "vs seq system",
				get: (x) => {
					const base = r.rows.find(
						(y) => y.kernel === x.kernel && y.path === "sequential system (ecs.update)"
					);
					return (base.msPerFrame / x.msPerFrame).toFixed(2) + "x";
				}
			},
			{
				label: "vs seq loop",
				get: (x) => {
					const base = r.rows.find(
						(y) => y.kernel === x.kernel && y.path === "sequential loop (no frame)"
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
