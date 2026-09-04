/**
 * P11, is sizing really independent of backing?
 *
 * `ECSMemoryOptions` is one key-discriminated union over five arms. Two
 * different questions live inside it:
 *
 *   how big     `budget: { entities, archetypes, bytesPerEntity }` or `maxBytes`
 *   what backing heap / shared / wasm / allocator
 *
 * The union lets a caller answer only one of them. The `budget` arm and the
 * `maxBytes` arm both pick `heapArraybufferAllocator` themselves, so "a budget
 * of 50,000 entities on a shared backing" cannot be said. The proposal is to
 * split the union into two independent fields.
 *
 * A proposal is a claim, and the claim is that the two axes are independent. If
 * they are, then the same sizing must give the same world on every backing, and
 * every cell of the grid must work. This probe tests that before anything
 * changes, and it uses the library as its own oracle: a `budget` world resolves
 * the derivation, and the other backings are then built from the numbers that
 * world reports. Nothing here reimplements the arithmetic.
 *
 * Three questions, in order of what they would cost us to learn late:
 *
 *   A. Does each cell construct and run? A cell that cannot exist is a cell the
 *      flattened type must still refuse, and we must know which ones.
 *   B. Does the resolved plan agree across backings for one sizing intent? A
 *      field that changes with the backing is a coupling the flattening has to
 *      remove, not a free win.
 *   C. Does the same workload give the same `stateHash` on every backing? The
 *      plan can agree while the world does not.
 *
 * This is a correctness probe, not a timing one. There are no medians here.
 */
import { emit, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";

const MiB = 1024 * 1024;

/**
 * Sizing intents. `entities` drives the budget arm. `maxBytes` is the explicit
 * arm. `both` is the combination the union forbids today and the flattened
 * shape would allow, so it is simulated here through the escape hatch.
 */
const SIZINGS = {
	tiny: { entities: 100, archetypes: 2 },
	small: { entities: 10_000, archetypes: 4 },
	mid: { entities: 200_000, archetypes: 8 },
	bytes8m: { maxBytes: 8 * MiB },
	both: { entities: 50_000, archetypes: 4, maxBytes: 64 * MiB },
	dflt: {}
};

const BACKINGS = ["heap", "shared", "fixedsab"];

/**
 * Build the options for one cell.
 *
 * Since 0.6 the sizing travels with the backing, so a cell is the sizing object
 * plus a `backing` key. Before 0.6 this function had to build a throwaway
 * budget world, read its `memoryPlan`, and hand-carry `columnCapacity` and the
 * cap to the other backings, which was the defect this probe was written to
 * measure. The whole helper is now one spread.
 *
 * The allocator backing keeps one real wrinkle: a caller-built allocator needs
 * its byte cap before a plan exists, so the sizing is resolved once to learn
 * the cap and the allocator is built at it. That is the escape hatch's true
 * ergonomic cost, and it is a cost of owning the buffer, not of the option
 * shape.
 */
async function memoryFor(backing, sizing) {
	if (backing === "heap" || backing === "shared") return { ...sizing, backing };
	if (backing === "fixedsab") {
		const INTERNAL = new URL("../../dist/internal.js", import.meta.url);
		const SHARED = new URL("../../dist/shared.js", import.meta.url);
		const { resolveECSMemory } = await import(INTERNAL.href);
		const mod = await import(SHARED.href);
		if (typeof mod.fixedSabAllocator !== "function") {
			throw new Error("dist/shared.js exports no fixedSabAllocator, build the candidate first");
		}
		const cap = resolveECSMemory(sizing).capBytes ?? 256 * MiB;
		return { ...sizing, maxBytes: cap, backing: { allocator: mod.fixedSabAllocator(cap) } };
	}
	throw new Error(`unknown backing ${backing}`);
}

/**
 * One fixed workload, run identically in every cell. It spawns, transitions
 * archetypes, despawns and reuses slots, so a backing that mishandled the tail
 * cursor or the entity index would diverge in the hash rather than merely run
 * slower.
 */
function workload(ecs, n) {
	// Integer columns on purpose: a `{ deterministic: true }` world refuses
	// floating-point fields, because f32 rounds differently across hosts and
	// would break the cross-backing `stateHash` comparison this probe rests on.
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" });
	const Vel = ecs.registerComponent({ vx: "i32", vy: "i32" });
	const Hp = ecs.registerComponent({ hp: "u32" });
	const Tag = ecs.registerTag();
	ecs.startup();

	const T = ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 3, vy: 4 }), Hp({ hp: 100 }));
	const ids = [];
	for (let i = 0; i < n; i++) ids.push(ecs.spawn(T));

	// Transition half the population into a second archetype, then move a
	// quarter of those back. Both directions run the column copy loop.
	for (let i = 0; i < n; i += 2) ecs.addComponent(ids[i], Tag);
	for (let i = 0; i < n; i += 8) ecs.removeComponent(ids[i], Tag);

	// Despawn a quarter and respawn the same count, so the entity index recycles
	// slots and bumps generations.
	for (let i = 0; i < n; i += 4) ecs.despawn(ids[i]);
	ecs.flush();
	for (let i = 0; i < n / 4; i++) ecs.spawn(T);
	ecs.flush();

	let sum = 0;
	const q = ecs.query(Pos, Hp);
	q.eachChunk((cols, count) => {
		const { x } = cols.read(Pos);
		const { hp } = cols.read(Hp);
		for (let i = 0; i < count; i++) sum += x[i] + hp[i];
	});
	return { sum: Math.round(sum), live: ecs.entityCount };
}

const WORKLOAD_N = 2000;

async function run(name) {
	const [sizingKey, backing] = name.split("+");
	const sizing = SIZINGS[sizingKey];
	if (!sizing) throw new Error(`unknown sizing ${sizingKey}`);

	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS } = await import(DIST.href);

	const memory = await memoryFor(backing, sizing);
	const ecs = new ECS({ memory, deterministic: true });
	const plan = ecs.memoryPlan;

	const out = workload(ecs, WORKLOAD_N);

	return {
		name,
		ok: true,
		capBytes: plan.capBytes,
		columnCapacity: plan.columnCapacity,
		entityIndexCapacity: plan.entityIndexCapacity,
		// What the entity count implies for the index, independent of backing.
		// Since 0.6 every backing must reach it. A gap here is a regression.
		wantIndex:
			sizing.entities !== undefined
				? Math.min(1 << 20, Math.max(1 << 12, 2 ** Math.ceil(Math.log2(sizing.entities * 2))))
				: null,
		intent: plan.intentLabel,
		stateHash: String(ecs.snapshots.stateHash()),
		sum: out.sum,
		live: out.live
	};
}

const which = variantArg();
if (which) {
	try {
		emit(await run(which));
	} catch (e) {
		emit({ name: which, ok: false, blocked: String(e && e.message ? e.message : e) });
	}
} else {
	console.log(`P11, the sizing x backing grid: are the two axes independent?`);
	console.log(`      Every cell runs the same spawn, churn and despawn workload (${WORKLOAD_N} entities).`);
	console.log(`      Sizing travels with the backing since 0.6, so a cell is one options object.\n`);

	const rows = [];
	for (const sizingKey of Object.keys(SIZINGS)) {
		for (const rt of RUNTIMES) {
			const got = {};
			for (const b of BACKINGS) got[b] = runVariantOn(rt, import.meta.url, `${sizingKey}+${b}`);
			rows.push({ sizingKey, rt, got });
		}
	}

	console.log(`  A. does the cell construct and run?\n`);
	console.log(`  ${"sizing".padEnd(9)} ${"runtime".padEnd(12)} ${BACKINGS.map((b) => b.padEnd(10)).join(" ")}`);
	console.log(`  ${"-".repeat(9)} ${"-".repeat(12)} ${BACKINGS.map(() => "-".repeat(10)).join(" ")}`);
	for (const { sizingKey, rt, got } of rows) {
		const cells = BACKINGS.map((b) => (got[b]?.ok ? "ok" : "FAIL").padEnd(10)).join(" ");
		console.log(`  ${sizingKey.padEnd(9)} ${`${rt.cmd} (${rt.engine})`.padEnd(12)} ${cells}`);
	}
	const failures = rows.flatMap(({ sizingKey, rt, got }) =>
		BACKINGS.filter((b) => !got[b]?.ok).map((b) => `${sizingKey}+${b} on ${rt.cmd}: ${got[b]?.blocked ?? "no result"}`)
	);
	if (failures.length) {
		console.log(`\n  failures:`);
		for (const f of failures) console.log(`    ${f}`);
	}

	console.log(`\n  B. does the resolved plan agree across backings for one sizing?\n`);
	console.log(
		`  ${"sizing".padEnd(9)} ${"runtime".padEnd(12)} ${"field".padEnd(20)} ${BACKINGS.map((b) => b.padEnd(12)).join(" ")} verdict`
	);
	console.log(
		`  ${"-".repeat(9)} ${"-".repeat(12)} ${"-".repeat(20)} ${BACKINGS.map(() => "-".repeat(12)).join(" ")} -------`
	);
	for (const { sizingKey, rt, got } of rows) {
		if (!BACKINGS.every((b) => got[b]?.ok)) continue;
		for (const field of ["capBytes", "columnCapacity", "entityIndexCapacity"]) {
			const vals = BACKINGS.map((b) => got[b][field]);
			const agree = new Set(vals).size === 1;
			// The `wantIndex` column only means something for a sizing that had a
			// budget. It says what the budget derived before the backing was
			// chosen, so a mismatch names a number the caller cannot reach today.
			let verdict = agree ? "agree" : "DIFFER";
			if (field === "entityIndexCapacity" && got.heap.wantIndex !== null) {
				const reached = vals.every((v) => v === got.heap.wantIndex);
				if (!reached) verdict = `LOST budget wanted ${got.heap.wantIndex}`;
			}
			console.log(
				`  ${sizingKey.padEnd(9)} ${rt.cmd.padEnd(12)} ${field.padEnd(20)} ${vals.map((v) => String(v).padEnd(12)).join(" ")} ${verdict}`
			);
		}
	}

	console.log(`\n  C. does the same workload give the same world on every backing?\n`);
	console.log(`  ${"sizing".padEnd(9)} ${"runtime".padEnd(12)} ${"stateHash".padEnd(10)} ${"sum".padEnd(10)} live`);
	console.log(`  ${"-".repeat(9)} ${"-".repeat(12)} ${"-".repeat(10)} ${"-".repeat(10)} ----`);
	for (const { sizingKey, rt, got } of rows) {
		if (!BACKINGS.every((b) => got[b]?.ok)) continue;
		const hashes = new Set(BACKINGS.map((b) => got[b].stateHash));
		const sums = new Set(BACKINGS.map((b) => got[b].sum));
		const lives = new Set(BACKINGS.map((b) => got[b].live));
		console.log(
			`  ${sizingKey.padEnd(9)} ${rt.cmd.padEnd(12)} ` +
				`${(hashes.size === 1 ? "agree" : `DIFFER ${[...hashes].join("/")}`).padEnd(10)} ` +
				`${(sums.size === 1 ? "agree" : `DIFFER ${[...sums].join("/")}`).padEnd(10)} ` +
				`${lives.size === 1 ? [...lives][0] : `DIFFER ${[...lives].join("/")}`}`
		);
	}

	console.log(`\n  A cell that fails is a combination the flattened type must still refuse.`);
	console.log(`  A field that DIFFERS is a coupling the flattening has to remove, not a free win.`);
	console.log(`  A LOST row is a number the budget derived that no other backing can reach today.`);
}
