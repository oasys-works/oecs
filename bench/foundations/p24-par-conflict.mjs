/**
 * P24 conflict, the negative control.
 *
 * The split probe reports that every configuration matched. That result is
 * worth nothing until the comparison is shown to fail on a real conflict. This
 * probe makes three conflicts on purpose and reports what the oracle says.
 *
 *   1. Two workers write the same rows of the same column. The sequential
 *      answer applies the kernel twice. The parallel answer loses updates.
 *   2. Every worker folds into one shared cell with no atomic.
 *   3. Every worker folds into its own cell, and the host folds the partials.
 *      Nothing races. The only question is whether the host's fold order is
 *      fixed or is the order the workers finished in.
 *
 * A number that repeats across runs is not proof of safety. The probe runs each
 * case several times and prints every run, so a reader sees the spread and not
 * a single lucky sample.
 *
 * Run: `node bench/foundations/p24-par-conflict.mjs`. Also runs under
 * `deno run -A` and under `bun`.
 */
import { availableParallelism } from "node:os";
import { table } from "./harness.mjs";
import { buildWorld, seedWorld, storeBuffer, kernelSpecs } from "./par/world.mjs";
import { bindColumnsLean, liveRowCount } from "./par/view.mjs";
import { startPool } from "./par/pool.mjs";

const WORKER = new URL("./par/conflict-worker.mjs", import.meta.url);
const DT = 1 / 60;
const CORES = availableParallelism();
const ENTITIES = 200_000;
const RUNS = 8;

function fnv(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function liveBytes(bound, buffer) {
	const parts = [];
	let total = 0;
	for (const b of bound) {
		const rows = liveRowCount(buffer, b.descriptorOff);
		for (const v of b.views) {
			const s = new Uint8Array(v.buffer, v.byteOffset, rows * v.BYTES_PER_ELEMENT);
			parts.push(s);
			total += s.length;
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

async function main() {
	console.log(
		`\nP24 conflict. availableParallelism() = ${CORES}, ${ENTITIES.toLocaleString()} entities\n`
	);

	const { ecs, Pos, Vel, Target } = await buildWorld({ entities: ENTITIES });
	seedWorld(ecs, Pos, Vel, Target);
	ecs.publishRowCounts();
	const buffer = storeBuffer(ecs);
	const specs = kernelSpecs(ecs, Pos, Vel, Target);
	const bound = bindColumnsLean(buffer, specs);
	const rowCounts = bound.map((b) => liveRowCount(buffer, b.descriptorOff));

	const seed = new Uint8Array(buffer.byteLength);
	seed.set(new Uint8Array(buffer));
	const restore = () => new Uint8Array(buffer).set(seed);

	// The sequential answer for case 1: the kernel applied K times in order.
	const seqTwice = (times) => {
		restore();
		for (let t = 0; t < times; t++) {
			for (let b = 0; b < bound.length; b++) {
				const px = bound[b].views[0];
				const vx = bound[b].views[3];
				for (let i = 0; i < rowCounts[b]; i++) px[i] += vx[i] * DT;
			}
		}
		return fnv(liveBytes(bound, buffer));
	};

	// --- Case 1: overlapping writes -------------------------------------
	const overlapRows = [];
	for (const k of [2, 4].filter((k) => k <= CORES)) {
		const expected = seqTwice(k);
		const scratch = new SharedArrayBuffer(8 * (k + 1));
		const order = new SharedArrayBuffer(4 * (k + 1));
		const pool = await startPool(WORKER, k, { buffer, scratch, order, specs, dt: DT });
		const seen = new Set();
		for (let r = 0; r < RUNS; r++) {
			restore();
			pool.run(0);
			const got = fnv(liveBytes(bound, buffer));
			seen.add(got);
			overlapRows.push({
				k,
				run: r,
				fold: got,
				expected,
				match: got === expected ? "equal" : "DIFFERS"
			});
		}
		await pool.stop();
		overlapRows.push({
			k,
			run: "distinct",
			fold: seen.size,
			expected: "-",
			match: seen.size === 1 ? "one value" : `${seen.size} values over ${RUNS} runs`
		});
	}

	console.log(
		"Case 1. Two or more workers write every row of Pos.x. FNV over the live column bytes.\n"
	);
	table(overlapRows, [
		{ label: "workers", get: (r) => r.k },
		{ label: "run", get: (r) => r.run },
		{ label: "fold", get: (r) => r.fold },
		{ label: "sequential K passes", get: (r) => r.expected },
		{ label: "verdict", get: (r) => r.match }
	]);

	// --- Case 2: one shared cell, no atomic -----------------------------
	restore();
	let seqSum = 0;
	for (let b = 0; b < bound.length; b++) {
		const px = bound[b].views[0];
		for (let i = 0; i < rowCounts[b]; i++) seqSum += px[i];
	}

	const cellRows = [];
	for (const k of [2, 4, 8].filter((k) => k <= CORES)) {
		const scratch = new SharedArrayBuffer(8 * (k + 1));
		const acc = new Float64Array(scratch);
		const order = new SharedArrayBuffer(4 * (k + 1));
		const pool = await startPool(WORKER, k, { buffer, scratch, order, specs, dt: DT });
		const seen = new Set();
		for (let r = 0; r < RUNS; r++) {
			restore();
			acc[0] = 0;
			pool.run(1);
			seen.add(acc[0]);
			cellRows.push({
				k,
				run: r,
				got: acc[0],
				lost: seqSum - acc[0],
				match: acc[0] === seqSum ? "equal" : "DIFFERS"
			});
		}
		await pool.stop();
		cellRows.push({
			k,
			run: "distinct",
			got: seen.size,
			lost: "-",
			match: seen.size === 1 ? "one value" : `${seen.size} values over ${RUNS} runs`
		});
	}

	console.log(
		`\nCase 2. Every worker folds Pos.x into one shared cell, no atomic. Sequential sum = ${seqSum}.\n`
	);
	table(cellRows, [
		{ label: "workers", get: (r) => r.k },
		{ label: "run", get: (r) => r.run },
		{ label: "parallel sum", get: (r) => r.got },
		{ label: "lost", get: (r) => r.lost },
		{ label: "verdict", get: (r) => r.match }
	]);

	// --- Case 3: private cells, and the host's fold order ---------------
	const foldRows = [];
	for (const job of [2, 3]) {
		for (const k of [4, 8].filter((k) => k <= CORES)) {
			const scratch = new SharedArrayBuffer(8 * (k + 1));
			const acc = new Float64Array(scratch);
			const orderBuf = new SharedArrayBuffer(4 * (k + 1));
			const order = new Int32Array(orderBuf);
			const pool = await startPool(WORKER, k, { buffer, scratch, order: orderBuf, specs, dt: DT });
			const fixedSeen = new Set();
			const arrivalSeen = new Set();
			const orders = new Set();
			for (let r = 0; r < RUNS; r++) {
				restore();
				acc.fill(0);
				order.fill(0);
				pool.run(job);
				let fixed = 0;
				for (let i = 0; i < k; i++) fixed += acc[1 + i];
				let arrival = 0;
				const seq = [];
				for (let i = 0; i < k; i++) {
					const w = order[1 + i];
					seq.push(w);
					arrival += acc[1 + w];
				}
				fixedSeen.add(fixed);
				arrivalSeen.add(arrival);
				orders.add(seq.join(""));
				foldRows.push({
					job: job === 2 ? "world values" : "spread magnitudes",
					k,
					run: r,
					fixed,
					arrival,
					same: fixed === arrival ? "same" : "DIFFERS",
					order: seq.join(" ")
				});
			}
			await pool.stop();
			foldRows.push({
				job: job === 2 ? "world values" : "spread magnitudes",
				k,
				run: "distinct",
				fixed: fixedSeen.size,
				arrival: arrivalSeen.size,
				same: `${orders.size} completion orders over ${RUNS} runs`,
				order: "-"
			});
		}
	}

	console.log(
		"\nCase 3. A private cell for each worker. Nothing races. The host folds the partials two ways.\n"
	);
	table(foldRows, [
		{ label: "partials", get: (r) => r.job },
		{ label: "workers", get: (r) => r.k },
		{ label: "run", get: (r) => r.run },
		{ label: "fold in worker order", get: (r) => String(r.fixed) },
		{ label: "fold in completion order", get: (r) => String(r.arrival) },
		{ label: "verdict", get: (r) => r.same },
		{ label: "completion order", get: (r) => r.order }
	]);

	// The reassociation the real partials do not reach. Same values, two
	// orders, and a magnitude spread wide enough that the float sum moves.
	const wide = [1e16, 1.0, -1e16, 1.0, 2.0, -3.0, 1e-8, 4.0];
	let asWritten = 0;
	for (const v of wide) asWritten += v;
	let reversed = 0;
	for (let i = wide.length - 1; i >= 0; i--) reversed += wide[i];
	console.log(
		`\n  Float sums do not commute across every input. [${wide.join(", ")}]` +
			`\n  summed forward: ${asWritten}, summed backward: ${reversed}, ${asWritten === reversed ? "equal" : "DIFFERENT"}`
	);
	console.log("");
}

await main();
