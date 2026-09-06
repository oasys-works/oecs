/**
 * The world lives in this module worker, because a browser main thread refuses
 * `Atomics.wait` and the pool parks the host for the length of a pass.
 *
 * Four cases run here, one world each, because a world takes one pool:
 *
 *   `worker-js`     a shared world, three pool workers, a `js` kernel
 *   `worker-wasm`   a wasm world, three pool workers, a `wasm` kernel the
 *                   emitter under `bench/foundations/wasm/` writes byte by byte
 *   `bad-url`       `workers.attach` with a `workerUrl` the server answers 404
 *   `grow`          a store grow between two runs of passes
 *
 * Each lane builds the same world twice. One runs the frames with no pool, and
 * the other attaches the pool and runs the same frames. The two must leave the
 * same `snapshots.stateHash()`.
 *
 * The lane also counts the sequential `fn`. A pooled run that never calls `fn`
 * proves the pool took the pass. Without that count the equality would also
 * hold when every dispatch fell back, which is the failure this harness is for.
 *
 * The page reads `dist/`, so a run here measures the built artifact and not the
 * source.
 */

import { ECS, SCHEDULE, storeBaseAbove } from "../../../dist/index.js";
import { workers } from "../../../dist/plugins/workers.js";
import { emitKernelModule, HEAP_BASE } from "../wasm/kernel_module.mjs";
import { integrateI32 } from "../wasm/engine-kernels.mjs";
import { regionSpec, storeBuffer } from "../par/world.mjs";

const KERNELS_URL = new URL("../wasm/engine-kernels.mjs", import.meta.url).href;

/** An integer step, because a deterministic world holds no float column and
 * `snapshots.stateHash()` is the oracle every lane is judged by. */
const DT = 3;
/** Frames each run, above the dozen the matrix asks for. */
const FRAMES = 16;
const ENTITIES = 8000;
const WORKERS = 3;

/** The wasm lane holds the store inside a `WebAssembly.Memory`. The emitted
 * module declares this maximum, and an instantiation against a memory with a
 * different maximum fails. */
const MAX_PAGES = 512;
const INITIAL_PAGES = 64;

/** How long a lane waits for an answer before it calls the run a hang. A hang
 * and a fault are different results, and a driver that only times out cannot
 * tell them apart. */
const ANSWER_TIMEOUT_MS = 20_000;

function report(result) {
	self.postMessage(result);
}

/**
 * Four archetypes over `Pos` and `Vel`, three matched and one carrying the tag
 * the query excludes. A split then has to cross an archetype boundary, and the
 * excluded archetype has to keep its bytes.
 *
 * `columnCapacity` is pinned so the grow lane can spawn past it.
 */
function buildWorld({ memory, kernel }) {
	// The region is the public way to the store bytes. The grow lane reads the
	// buffer length through it, so a run that never grew is a visible failure and
	// not an assumption about the column capacity.
	const ecs = ECS.create({
		deterministic: true,
		memory,
		regions: [regionSpec()],
		plugins: [workers()]
	});
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: "i32", vy: "i32" }, { name: "Vel" });
	const TagOne = ecs.registerTag();
	const TagTwo = ecs.registerTag();
	const Frozen = ecs.registerTag();
	const parts = () => [Pos({ x: 0, y: 0 }), Vel({ vx: 0, vy: 0 })];
	const templates = [
		ecs.template(...parts()),
		ecs.template(...parts(), TagOne),
		ecs.template(...parts(), TagOne, TagTwo),
		ecs.template(...parts(), Frozen)
	];
	const query = ecs.query(Pos, Vel).not(Frozen);

	let fnRuns = 0;
	const system = ecs.registerSystem({
		name: "integrate",
		reads: [Vel],
		writes: [Pos],
		parallel: {
			kernel,
			columns: [
				[Pos, "x"],
				[Pos, "y"],
				[Vel, "vx"],
				[Vel, "vy"]
			],
			// One row is enough to release the pool, so every frame of this harness
			// takes the parallel path. A shipped world tunes this to its own kernel.
			minRows: 1,
			query
		},
		fn: (_ctx, dt) => {
			fnRuns++;
			query.forEachChunk((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				integrateI32(p.x, p.y, v.vx, v.vy, 0, count, dt);
			});
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, system);
	ecs.startup();

	let spawned = 0;
	const spawn = (count) => {
		for (let i = 0; i < count; i++) ecs.spawn(templates[spawned++ % 4]);
	};
	// Seed from the row index, through the engine's own query path. The values
	// repeat on a short cycle, so a wrong offset gives a wrong value and not a
	// plausible one.
	const seed = () => {
		let n = 0;
		ecs.query(Pos, Vel).forEachChunk((cols, count) => {
			const p = cols.mut(Pos);
			const v = cols.mut(Vel);
			for (let i = 0; i < count; i++, n++) {
				p.x[i] = n % 1000;
				p.y[i] = n % 977;
				v.vx[i] = (n % 13) - 6;
				v.vy[i] = (n % 17) - 8;
			}
		});
	};

	spawn(ENTITIES);
	seed();
	return {
		ecs,
		spawn,
		seed,
		fnRuns: () => fnRuns,
		// The handle goes stale on a realloc, so this re-fetches every time.
		storeBytes: () => storeBuffer(ecs).byteLength
	};
}

/** Run the frames, and grow the store in the middle when the lane asks for it.
 * The pooled world and the sequential world take the same calls in the same
 * order, so a difference can only come from the split. */
function runFrames(world, growBy) {
	for (let f = 0; f < FRAMES; f++) world.ecs.update(DT);
	const bytesBefore = world.storeBytes();
	if (growBy > 0) {
		world.spawn(growBy);
		world.seed();
		for (let f = 0; f < FRAMES; f++) world.ecs.update(DT);
	}
	return { hash: world.ecs.snapshots.stateHash(), bytesBefore, bytesAfter: world.storeBytes() };
}

async function lane(id, options, growBy = 0) {
	const sequential = buildWorld(options);
	const bySequence = runFrames(sequential, growBy);
	const sequentialFnRuns = sequential.fnRuns();
	sequential.ecs.dispose();

	const pooled = buildWorld(options);
	const pool = await pooled.ecs.workers.attach({ count: WORKERS });
	await pool.settled();
	const byPool = runFrames(pooled, growBy);
	const pooledFnRuns = pooled.fnRuns();
	await pool.detach();
	pooled.ecs.dispose();

	// The grow lane is decoration unless the store actually moved, so the lane
	// fails when the buffer did not get longer.
	const grew = byPool.bytesAfter > byPool.bytesBefore;
	const ok =
		byPool.hash === bySequence.hash &&
		pooledFnRuns === 0 &&
		pool.count === WORKERS &&
		(growBy === 0 || grew);
	return {
		id,
		ok,
		detail: {
			workers: pool.count,
			frames: growBy > 0 ? FRAMES * 2 : FRAMES,
			grewBy: growBy,
			sequentialHash: bySequence.hash,
			pooledHash: byPool.hash,
			sequentialFnRuns,
			pooledFnRuns,
			storeBytesBefore: byPool.bytesBefore,
			storeBytesAfter: byPool.bytesAfter
		}
	};
}

/** A wrong `workerUrl` must be a fault with a remedy, and never a park with no
 * end. The race is the whole point of the case, so a run that answers nothing
 * is reported as a hang. */
async function badUrlLane() {
	const world = buildWorld({
		memory: { backing: "shared" },
		kernel: { js: KERNELS_URL, export: "integrateI32" }
	});
	const missing = new URL("./no-such-worker-entry.js", import.meta.url).href;
	let timer = 0;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ANSWER_TIMEOUT_MS);
	});
	let detail;
	let ok = false;
	try {
		const answer = await Promise.race([
			world.ecs.workers.attach({ count: 1, workerUrl: missing }).then(() => "resolved"),
			timeout
		]);
		detail =
			answer === "timeout"
				? { outcome: `workers.attach answered nothing within ${ANSWER_TIMEOUT_MS} ms` }
				: { outcome: "workers.attach resolved, and the entry does not exist" };
	} catch (error) {
		// `ECSError` carries its code on `category`. A browser that reports the
		// worker load failure differently lands on another category, or on none.
		detail = {
			outcome: "threw",
			name: error?.name,
			category: error?.category,
			message: String(error?.message ?? error),
			namesTheUrl: String(error?.message ?? "").includes("no-such-worker-entry.js")
		};
		ok = error?.category === "WORKERS_ENTRY_UNREACHABLE" && detail.namesTheUrl;
	} finally {
		clearTimeout(timer);
	}
	world.ecs.dispose();
	return { id: "bad-url", ok, detail };
}

async function main() {
	report({
		id: "worker-env",
		ok: typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true,
		detail: {
			crossOriginIsolated: self.crossOriginIsolated,
			sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
			hardwareConcurrency: navigator?.hardwareConcurrency
		}
	});

	const cases = [
		[
			"worker-js",
			() =>
				lane("worker-js", {
					memory: { backing: "shared" },
					kernel: { js: KERNELS_URL, export: "integrateI32" }
				})
		],
		[
			"worker-wasm",
			() => {
				const module = new WebAssembly.Module(
					emitKernelModule({ minPages: 1, maxPages: MAX_PAGES })
				);
				return lane("worker-wasm", {
					// The emitted module links a shadow stack and owns every byte below
					// `HEAP_BASE`. The store starts above that, with one stack region for
					// each worker, which is the rule every linked kernel follows.
					memory: {
						backing: { wasm: { maximumPages: MAX_PAGES, initialPages: INITIAL_PAGES } },
						storeBase: storeBaseAbove({ __heap_base: HEAP_BASE }, WORKERS * 65_536)
					},
					kernel: { wasm: module, export: "integrate_i32" }
				});
			}
		],
		["bad-url", badUrlLane],
		[
			"grow",
			() =>
				lane(
					"grow",
					{
						// The column capacity is small enough that the second spawn
						// relocates every column of every archetype the query matches.
						memory: { backing: "shared", columnCapacity: 512 },
						kernel: { js: KERNELS_URL, export: "integrateI32" }
					},
					ENTITIES
				)
		]
	];

	for (const [id, run] of cases) {
		try {
			report(await run());
		} catch (error) {
			report({
				id,
				ok: false,
				detail: {
					outcome: "threw",
					name: error?.name,
					category: error?.category,
					message: String(error?.message ?? error),
					stack: String(error?.stack ?? "")
				}
			});
		}
	}
	report({ id: "worker-done", ok: true, detail: {} });
}

void main().catch((error) => {
	report({
		id: "worker-fatal",
		ok: false,
		detail: { message: String(error?.message ?? error), stack: String(error?.stack ?? "") }
	});
	report({ id: "worker-done", ok: true, detail: {} });
});
