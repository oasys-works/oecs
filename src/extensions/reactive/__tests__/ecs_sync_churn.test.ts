/**
 * ecs_sync CHURN ORACLE (#784, a torture sub-issue of epic #774) — the property
 * test the ~40 scripted single-tick gates in `ecs_sync.test.ts` can't reach.
 *
 * `ecs_sync` maintains its projection INCREMENTALLY: ADR-0013 observers drain only
 * the entities the ECS flagged dirty this tick (O(changed) publish work, the whole
 * point of #646/ADR-0021). Incremental state is where membership drift, missed
 * deletes, and staleness hide — and a scripted "set x, assert one wake" test never
 * runs the bridge long enough or randomly enough to surface them.
 *
 * So this drives a SEEDED RANDOM CHURN PROGRAM (spawn / despawn / add / remove / set
 * / disable / enable across an entity pool over many ticks) at the real bridge and,
 * after every tick, asserts the incrementally-built projection EQUALS AN ORACLE
 * RECOMPUTED FROM SCRATCH via `world.query(...)`. The bridge does it the hard way
 * (observers); the oracle does it the obvious way (a full requery). Any divergence
 * is a bridge bug. This is the gordian-knot generator's stance (`packages/gordian-
 * knot/src/generator/`: an independent oracle for a sequence that has no "rule"),
 * scoped to the projection layer and using `world.query` itself as the oracle
 * instead of a hand-written `RefWorld` — the engine's own query is the ground truth
 * for "who is a member, with what value", which is exactly what the bridge mirrors.
 *
 * Four properties, one generator:
 *   - `syncComponentToMap` (both grains) == `query(Pos)` after every churn tick.
 *   - `syncJoinToMap([Pos, Health])` == `query(Pos, Health)` after every churn tick.
 *   - `syncSingletonToStruct` == the singleton's live fields (enabled) / declared
 *     defaults (disabled) after every churn tick.
 *   - batched-tick coalescing (one flush per tick) holds under churn — with the
 *     unbatched counter-case that shows why `Engine._tick`'s `batch()` is load-bearing.
 *
 * Plus a SHRINKER (`ddmin`-style single-op fixpoint) proven against a FAULT-INJECTED
 * subject — a deliberately broken mini-bridge that drops `onRemove`/`onDisable`, so
 * a despawn/disable LEAKS a stale row. A seeded program diverges from the oracle; the
 * shrinker reduces it to a 1-minimal reproducing op sequence. This is what gives the
 * oracle teeth: it demonstrably catches the exact bug class the issue names (missed
 * deletes, membership drift) and localises it to a minimal repro.
 */
import { describe, expect, it } from "vitest";
import { effect, reactiveMap, root, type ReactiveMap } from "../../../reactive";
import {
	ECS,
	SCHEDULE,
	type ComponentDef,
	type EntityID,
	type ObserverHandle,
	type SystemContext
} from "../../../core/ecs";
import {
	batchedUpdate,
	shallow,
	syncComponentToMap,
	syncJoinToMap,
	syncSingletonToStruct
} from "../ecs_sync";

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic per seed, so every replay (and every
// shrink step) is reproducible: a failure pins to a seed, not a wall-clock roll.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
/** Uniform integer in `[0, n)`. */
const int = (rng: () => number, n: number): number => Math.floor(rng() * n);

// ---------------------------------------------------------------------------
// Op model — a flat program over BIRTH-ORDINAL handles (0, 1, 2, …), the same
// handle-not-EntityID scheme the gordian-knot generator uses so the program is
// independent of how the engine assigns ids. The applier resolves a handle to its
// live `EntityID` and NO-OPS any op on a dead/unborn handle (the engine throws on a
// dead-entity op under `__DEV__`, so the applier gates exactly as the generator
// must). `step` is the per-tick checkpoint: ops between two `step`s are one batch.
// ---------------------------------------------------------------------------
type Op =
	| { kind: "spawn"; withHealth: boolean; x: number; y: number; hp: number }
	| { kind: "despawn"; h: number }
	| { kind: "addHealth"; h: number; hp: number }
	| { kind: "removeHealth"; h: number }
	| { kind: "set"; h: number; comp: "Pos"; field: "x" | "y"; value: number }
	| { kind: "set"; h: number; comp: "Health"; field: "hp"; value: number }
	| { kind: "disable"; h: number }
	| { kind: "enable"; h: number }
	| { kind: "step" };

const VAL = 8; // small value range → frequent equal-writes (exercises the eq no-op skip)

/**
 * Generate a churn program: `ticks` ticks, each a random handful of ops then a
 * `step`. Non-spawn ops target a handle born in a PRIOR tick (`bornBefore`) — never
 * one spawned this same tick — so a freshly-spawned entity is never mutated before it
 * commits, sidestepping the deferred-attach corner (covered by the scripted gates)
 * and keeping the churn focused on cross-tick membership/value drift. `born` is
 * counted identically here and in the applier (every `spawn` op runs), so handle
 * numbering stays in lockstep across the two.
 */
function generate(seed: number, ticks: number): Op[] {
	const rng = mulberry32(seed);
	const ops: Op[] = [];
	let born = 0;
	for (let t = 0; t < ticks; t++) {
		const bornBefore = born;
		const n = 1 + int(rng, 5);
		for (let k = 0; k < n; k++) {
			// Force a spawn while the pool is empty, otherwise spawn ~30% of the time.
			if (bornBefore === 0 || rng() < 0.3) {
				ops.push({
					kind: "spawn",
					withHealth: rng() < 0.5,
					x: int(rng, VAL),
					y: int(rng, VAL),
					hp: int(rng, VAL)
				});
				born++;
				continue;
			}
			const h = int(rng, bornBefore);
			const r = rng();
			if (r < 0.18) ops.push({ kind: "despawn", h });
			else if (r < 0.36) ops.push({ kind: "addHealth", h, hp: int(rng, VAL) });
			else if (r < 0.5) ops.push({ kind: "removeHealth", h });
			else if (r < 0.62) ops.push({ kind: "disable", h });
			else if (r < 0.74) ops.push({ kind: "enable", h });
			else if (rng() < 0.5)
				ops.push({
					kind: "set",
					h,
					comp: "Pos",
					field: rng() < 0.5 ? "x" : "y",
					value: int(rng, VAL)
				});
			else ops.push({ kind: "set", h, comp: "Health", field: "hp", value: int(rng, VAL) });
		}
		ops.push({ kind: "step" });
	}
	return ops;
}

/** Split a program into per-`step` batches. Trailing ops after the last `step` are
 * dropped — never checkpointed, so they can't affect any compared state (mirrors the
 * gordian-knot driver's `splitBatches`; it is what makes a trailing `step` load-
 * bearing and so keeps the shrinker honest). */
function splitBatches<T extends { kind: string }>(ops: readonly T[]): T[][] {
	const batches: T[][] = [];
	let cur: T[] = [];
	for (const op of ops) {
		if (op.kind === "step") {
			batches.push(cur);
			cur = [];
		} else cur.push(op);
	}
	return batches;
}

// ---------------------------------------------------------------------------
// The churn engine: Pos{x,y} + Health{hp}, one generic op-applier draining a
// per-tick buffer. Holds handle↔EntityID + the live set, maintained by the applier.
// Built but NOT started — a replay attaches its subject (the bridge under test),
// then calls `start()`, so `seedExisting` and the observers see the same world.
// ---------------------------------------------------------------------------
interface ChurnEngine {
	readonly world: ECS;
	readonly Pos: ComponentDef<{ x: "f64"; y: "f64" }>;
	readonly Health: ComponentDef<{ hp: "f64" }>;
	start(): void;
	/** Apply one tick's ops as a single coalesced flush. */
	runBatch(batch: readonly Op[]): void;
}

function buildEngine(): ChurnEngine {
	const world = new ECS();
	const Pos = world.registerComponent({ x: "f64", y: "f64" });
	const Health = world.registerComponent({ hp: "f64" });

	const eidOf = new Map<number, EntityID>(); // handle → EntityID (kept for dead handles too)
	const live = new Set<number>(); // currently-live handles (immediate view)
	let born = 0; // next birth ordinal — matches the generator's counter
	let buffer: readonly Op[] = []; // the current tick's ops, drained by the applier

	const applier = world.registerSystem({
		name: "churn_applier",
		reads: [Pos, Health],
		writes: [Pos, Health],
		// `writes` already authorises addComponent(Pos/Health) + setField; `despawns`
		// authorises removeComponent(Health) + destroyEntity; `spawns` authorises the
		// createEntity + add. Declared as a superset so every generated op is legal.
		spawns: [[Pos], [Pos, Health]],
		despawns: [Pos, Health],
		transitions: [{ whenHas: [Pos], add: [Health], remove: [Health] }],
		resourceReads: [],
		resourceWrites: [],
		sparseReads: [],
		sparseWrites: [],
		relationReads: [],
		relationWrites: [],
		fn: (ctx) => {
			const ops = buffer;
			buffer = [];
			for (const op of ops) {
				switch (op.kind) {
					case "spawn": {
						const e = ctx.commands.spawn();
						ctx.commands.add(e, Pos, { x: op.x, y: op.y });
						if (op.withHealth) ctx.commands.add(e, Health, { hp: op.hp });
						eidOf.set(born, e);
						live.add(born);
						born++;
						break;
					}
					case "despawn": {
						if (!live.has(op.h)) break;
						ctx.commands.despawn(eidOf.get(op.h)!);
						live.delete(op.h);
						break;
					}
					case "addHealth": {
						if (!live.has(op.h)) break;
						const e = eidOf.get(op.h)!;
						// Re-adding a present component would be ambiguous (throw vs overwrite),
						// so settle the field via set when it's already there — the post-tick
						// query is identical either way, which is all the oracle compares.
						if (ctx.hasComponent(e, Health)) ctx.setField(e, Health, "hp", op.hp);
						else ctx.commands.add(e, Health, { hp: op.hp });
						break;
					}
					case "removeHealth": {
						if (!live.has(op.h)) break;
						const e = eidOf.get(op.h)!;
						if (ctx.hasComponent(e, Health)) ctx.commands.remove(e, Health);
						break;
					}
					case "set": {
						if (!live.has(op.h)) break;
						const e = eidOf.get(op.h)!;
						// The engine throws on setField of an absent component in __DEV__ —
						// gate on presence (a `set` on a Health the entity lacks is a no-op).
						// Branch on `comp` so the field name narrows to the component's schema.
						if (op.comp === "Pos") {
							if (ctx.hasComponent(e, Pos)) ctx.setField(e, Pos, op.field, op.value);
						} else if (ctx.hasComponent(e, Health)) ctx.setField(e, Health, op.field, op.value);
						break;
					}
					case "disable":
						if (live.has(op.h)) ctx.commands.disable(eidOf.get(op.h)!);
						break;
					case "enable":
						if (live.has(op.h)) ctx.commands.enable(eidOf.get(op.h)!);
						break;
					case "step":
						break; // batches never carry the step marker
				}
			}
		}
	});
	world.addSystems(SCHEDULE.UPDATE, applier);

	return {
		world,
		Pos,
		Health,
		start: () => world.startup(),
		runBatch: (batch) => {
			buffer = batch;
			batchedUpdate(world, 1 / 60);
			// No relations here, so a destroy never cascades — `live` is already exact.
			// Reconcile anyway as cheap insurance against any deferred-destroy surprise.
			for (const h of [...live]) if (!world.isAlive(eidOf.get(h)!)) live.delete(h);
		}
	};
}

// ---------------------------------------------------------------------------
// Oracle — recompute the projection from scratch via `world.query(...)` and compare
// it to the bridge's incrementally-built map. The channel mirrors the DEFAULT query
// (enabled members of the mask), which is the bridge's disable=soft-remove contract
// (#677 / ADR-0023), so the two agree on membership without special-casing.
//
// We recompute via `query(...).includeDisabled()` + an `isDisabled` filter rather
// than the bare default query: the two describe the SAME set (enabled members), but
// the default-query `_nonEmpty` cache filters on `enabledCount` and goes stale when
// an enabled row is added to an all-disabled archetype — the engine query bug #812
// this torture surfaced. `includeDisabled` filters on `totalCount`, so its cache is
// robust to #812; the explicit `isDisabled` filter restores default-query semantics.
// Values are read with `getField`, exactly as a default-query projection would.
// ---------------------------------------------------------------------------
type V2 = { x: number; y: number };

function queryOracle<V>(
	world: ECS,
	defs: ComponentDef[],
	project: (e: EntityID) => V
): Map<EntityID, V> {
	const out = new Map<EntityID, V>();
	world
		.query(...defs)
		.includeDisabled()
		.forEachEntity((e) => {
			if (!world.isDisabled(e)) out.set(e, project(e));
		});
	return out;
}

/** Compare a reactive map against an oracle map of the same value shape. Returns a
 * human-readable reason on divergence (key-set mismatch or a value mismatch), or
 * `null` when they agree — the `null`/reason contract the harness diffs use. */
function diffMap<V extends object>(
	label: string,
	actual: ReactiveMap<EntityID, V>,
	oracle: Map<EntityID, V>
): string | null {
	const aKeys = actual.keys().sort((p, q) => p - q);
	const oKeys = [...oracle.keys()].sort((p, q) => p - q);
	if (aKeys.length !== oKeys.length || !aKeys.every((k, i) => k === oKeys[i])) {
		return `${label}: key sets differ — bridge [${aKeys}] vs oracle [${oKeys}]`;
	}
	for (const k of oKeys) {
		const av = actual.get(k);
		const ov = oracle.get(k)!;
		if (av === undefined || !shallow(av, ov)) {
			return `${label}: value at ${k} differs — bridge ${JSON.stringify(av)} vs oracle ${JSON.stringify(ov)}`;
		}
	}
	return null;
}

/** A divergence: which 1-based tick, and why. */
interface Failure {
	readonly tick: number;
	readonly message: string;
}

/** A subject attaches its bridge(s) to the engine and answers "does the projection
 * match the query oracle right now?" after each tick. */
interface Subject {
	check(): string | null;
}
type MakeSubject = (eng: ChurnEngine) => Subject;

/** Replay a program against a fresh engine + subject, returning the first tick whose
 * projection diverged from the oracle (or `null` if every tick agreed). */
function replay(ops: readonly Op[], make: MakeSubject): Failure | null {
	const eng = buildEngine();
	const subject = make(eng); // attach BEFORE startup so seedExisting sees the world
	eng.start();
	const batches = splitBatches(ops);
	for (let s = 0; s < batches.length; s++) {
		eng.runBatch(batches[s]);
		const msg = subject.check();
		if (msg !== null) return { tick: s + 1, message: msg };
	}
	return null;
}

/** The REAL subject: the production bridges, compared to the from-scratch oracle.
 * `grain` exercises both the per-entity dirty drain and the column sweep. */
const makeReal =
	(grain: "entity" | "column"): MakeSubject =>
	(eng) => {
		const { world, Pos, Health } = eng;
		const map = syncComponentToMap(
			world,
			Pos,
			(row) => ({ x: row.field("x"), y: row.field("y") }),
			{
				grain,
				eq: shallow
			}
		);
		const join = syncJoinToMap(
			world,
			[Pos, Health],
			(row) => ({ x: row.field(Pos, "x"), hp: row.field(Health, "hp") }),
			{ eq: shallow }
		);
		return {
			check: () => {
				const oMap = queryOracle(world, [Pos], (e) => ({
					x: world.getField(e, Pos, "x"),
					y: world.getField(e, Pos, "y")
				}));
				const d1 = diffMap("map", map.map, oMap);
				if (d1 !== null) return d1;

				const oJoin = queryOracle(world, [Pos, Health], (e) => ({
					x: world.getField(e, Pos, "x"),
					hp: world.getField(e, Health, "hp")
				}));
				return diffMap("join", join.map, oJoin);
			}
		};
	};

/** The FAULT-INJECTED subject: a hand-rolled Pos→map bridge that DROPS
 * `onRemove`/`onDisable`, so a despawned or disabled entity leaks a stale row the
 * `query(Pos)` oracle no longer has. This is the bug class the issue calls out
 * (missed deletes, membership drift); it exists to prove the oracle catches it and
 * the shrinker localises it — NOT a variant of the real bridge. */
const makeFaulty: MakeSubject = (eng) => {
	const { world, Pos } = eng;
	const map = reactiveMap<EntityID, V2>(shallow);
	const publish = (eid: EntityID, ctx: SystemContext): void =>
		void map.set(eid, { x: ctx.getField(eid, Pos, "x"), y: ctx.getField(eid, Pos, "y") });
	const handle: ObserverHandle = world.observe(Pos, {
		granularity: "entity",
		onSet: publish,
		onAdd: publish,
		onEnable: publish,
		// BUG: no onRemove, no onDisable — a leaving entity is never dropped.
		access: { reads: [Pos] },
		yieldExisting: true
	});
	void handle;
	return {
		check: () => {
			const oracle = queryOracle(world, [Pos], (e) => ({
				x: world.getField(e, Pos, "x"),
				y: world.getField(e, Pos, "y")
			}));
			return diffMap("faulty-map", map, oracle);
		}
	};
};

// ---------------------------------------------------------------------------
// 1. The property — the real bridge mirrors the query oracle under random churn.
// ---------------------------------------------------------------------------
const SEEDS = 40;
const TICKS = 30;

describe("ecs_sync churn oracle — bridge == query(...) after every tick", () => {
	it.each(["entity", "column"] as const)(
		`[grain=%s] syncComponentToMap & syncJoinToMap match the oracle across ${SEEDS} seeds`,
		(grain) => {
			for (let seed = 0; seed < SEEDS; seed++) {
				const program = generate(seed, TICKS);
				const failure = replay(program, makeReal(grain));
				expect(
					failure,
					failure === null ? "" : `seed ${seed}, tick ${failure.tick}: ${failure.message}`
				).toBeNull();
			}
		}
	);
});

// ---------------------------------------------------------------------------
// 2. Singleton variant — syncSingletonToStruct mirrors the live fields (enabled)
//    or its declared defaults (disabled) under field-set + disable/enable churn.
// ---------------------------------------------------------------------------
describe("ecs_sync churn oracle — syncSingletonToStruct under field/toggle churn", () => {
	type SOp =
		| { kind: "set"; field: "a" | "b" | "c"; value: number }
		| { kind: "disable" }
		| { kind: "enable" }
		| { kind: "step" };

	function genSingleton(seed: number, ticks: number): SOp[] {
		const rng = mulberry32(seed);
		const fields = ["a", "b", "c"] as const;
		const ops: SOp[] = [];
		for (let t = 0; t < ticks; t++) {
			const n = 1 + int(rng, 4);
			for (let k = 0; k < n; k++) {
				const r = rng();
				if (r < 0.16) ops.push({ kind: "disable" });
				else if (r < 0.32) ops.push({ kind: "enable" });
				else ops.push({ kind: "set", field: fields[int(rng, 3)], value: int(rng, VAL) });
			}
			ops.push({ kind: "step" });
		}
		return ops;
	}

	it("the struct equals current fields when enabled, declared defaults when disabled", () => {
		const FIELDS = ["a", "b", "c"] as const;
		for (let seed = 0; seed < SEEDS; seed++) {
			const world = new ECS({ deterministic: false }); // the client/UI world is non-deterministic
			const Session = world.registerComponent({ a: "f64", b: "f64", c: "f64" });
			const singleton = world.spawn();
			world.addComponent(singleton, Session, { a: 1, b: 2, c: 3 });
			let buffer: readonly SOp[] = [];
			world.addSystems(
				SCHEDULE.UPDATE,
				world.registerSystem({
					name: "singleton_churn",
					reads: [Session],
					writes: [Session],
					spawns: [],
					despawns: [],
					transitions: [],
					resourceReads: [],
					resourceWrites: [],
					sparseReads: [],
					sparseWrites: [],
					relationReads: [],
					relationWrites: [],
					fn: (ctx) => {
						const ops = buffer;
						buffer = [];
						for (const op of ops) {
							if (op.kind === "set") ctx.setField(singleton, Session, op.field, op.value);
							else if (op.kind === "disable") ctx.commands.disable(singleton);
							else if (op.kind === "enable") ctx.commands.enable(singleton);
						}
					}
				})
			);
			// A fresh struct: its declared initials are zeros, so disable resets to 0.
			const sync = syncSingletonToStruct(world, Session, singleton, FIELDS);
			world.startup();

			const batches = splitBatches(genSingleton(seed, TICKS));
			for (let s = 0; s < batches.length; s++) {
				buffer = batches[s];
				batchedUpdate(world, 1 / 60);
				// Oracle: enabled → the singleton's live column values; disabled → the
				// channel's declared initials (zeros for a fresh struct). The column
				// persists while disabled, so `getField` always reads the latest write.
				const disabled = world.isDisabled(singleton);
				const oracle = disabled
					? { a: 0, b: 0, c: 0 }
					: {
							a: world.getField(singleton, Session, "a"),
							b: world.getField(singleton, Session, "b"),
							c: world.getField(singleton, Session, "c")
						};
				expect({ ...sync.struct }, `seed ${seed}, tick ${s + 1}`).toEqual(oracle);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Batched-tick coalescing under churn — one flush per tick, no matter how many
//    entities a tick touched. The single-channel "one batched tick → 1 commit"
//    gates in ecs_sync.test.ts assert this for a scripted tick; this asserts it
//    survives heavy random churn (the case where K entities change at once).
// ---------------------------------------------------------------------------
describe("ecs_sync churn — batched-tick coalescing (one flush per tick)", () => {
	it("a reader of the whole projection wakes at most once per batched churn tick", () => {
		const eng = buildEngine();
		const { world, Pos } = eng;
		const sync = syncComponentToMap(
			world,
			Pos,
			(row) => ({ x: row.field("x"), y: row.field("y") }),
			{
				eq: shallow
			}
		);
		eng.start();

		// One effect over the ENTIRE projection: structure (key set) + every key's
		// value. Under `batch()`, all of a tick's set/delete coalesce, so this wakes
		// at most once — even when the tick spawned, despawned, and mutated many rows.
		let flushes = 0;
		root(() => {
			effect(() => {
				flushes++;
				for (const k of sync.map.keys()) sync.map.get(k);
			});
		});

		const batches = splitBatches(generate(7, TICKS));
		for (const batch of batches) {
			flushes = 0; // discard the mount run before the first tick; reset each tick
			eng.runBatch(batch);
			expect(flushes).toBeLessThanOrEqual(1);
		}
	});

	it("an UNBATCHED tick wakes the reader once per changed row (why _tick batches)", () => {
		// The counter-case the batched property leans on: drive the same two writes
		// with a bare `world.update`, where each publish flushes synchronously, so a
		// reader of both rows wakes twice in one tick. This is the torn behaviour
		// `batchedUpdate`/`Engine._tick`'s `batch()` collapses.
		const eng = buildEngine();
		const { world, Pos } = eng;
		const sync = syncComponentToMap(
			world,
			Pos,
			(row) => ({ x: row.field("x"), y: row.field("y") }),
			{
				eq: shallow
			}
		);
		eng.start();
		// Spawn two rows (committed) in their own batched tick.
		eng.runBatch([
			{ kind: "spawn", withHealth: false, x: 0, y: 0, hp: 0 },
			{ kind: "spawn", withHealth: false, x: 0, y: 0, hp: 0 }
		]);

		const keys = sync.map.keys().sort((p, q) => p - q);
		let flushes = 0;
		root(() => {
			effect(() => {
				flushes++;
				for (const k of sync.map.keys()) sync.map.get(k);
			});
		});
		flushes = 0;

		// Two existing rows change in one BARE update. Host-side `setField` marks both
		// dirty between ticks; the bare `world.update` drains them at the tick tail with
		// no surrounding batch, so each onSet publish flushes synchronously and the
		// whole-projection reader wakes once per changed row.
		world.setField(keys[0], Pos, "x", 1);
		world.setField(keys[1], Pos, "x", 1);
		world.update(1 / 60);
		expect(flushes).toBeGreaterThan(1);
	});
});

// ---------------------------------------------------------------------------
// 4. The shrinker — a seeded failure (against the fault-injected subject) reduces
//    to a 1-minimal reproducing op sequence. `ddmin`-style single-op fixpoint:
//    repeatedly drop any one op whose removal still reproduces, to convergence.
//    At convergence no single op is removable while still failing — the textbook
//    1-minimality guarantee (Zeller & Hildebrandt, "Simplifying and Isolating
//    Failure-Inducing Input", IEEE TSE 28(2), 2002).
// ---------------------------------------------------------------------------
function shrink(ops: readonly Op[], fails: (ops: readonly Op[]) => boolean): Op[] {
	let cur = ops.slice();
	for (let improved = true; improved; ) {
		improved = false;
		for (let i = 0; i < cur.length; i++) {
			const candidate = cur.slice(0, i).concat(cur.slice(i + 1));
			if (fails(candidate)) {
				cur = candidate;
				improved = true;
				break; // restart the scan over the smaller program
			}
		}
	}
	return cur;
}

describe("ecs_sync churn — shrinker reduces a seeded failure to a minimal repro", () => {
	const fails = (ops: readonly Op[]): boolean => replay(ops, makeFaulty) !== null;

	it("the fault-injected bridge diverges, and shrinking yields a 1-minimal sequence", () => {
		// Find the first seed whose churn program leaks a stale row past the oracle.
		// Small programs (few ticks) keep the shrink fast and the repro tiny.
		let failing: Op[] | null = null;
		let failingSeed = -1;
		for (let seed = 0; seed < 200 && failing === null; seed++) {
			const program = generate(seed, 6);
			if (fails(program)) {
				failing = program;
				failingSeed = seed;
			}
		}
		expect(failing, "no seed produced a divergence — the fault injection is inert").not.toBeNull();

		const shrunk = shrink(failing!, fails);

		// (a) Still reproduces the failure.
		expect(fails(shrunk), `seed ${failingSeed}: shrunk sequence no longer fails`).toBe(true);
		// (b) Actually shrank.
		expect(shrunk.length).toBeLessThan(failing!.length);
		// (c) 1-minimal: removing ANY single op makes the failure disappear.
		for (let i = 0; i < shrunk.length; i++) {
			const minusOne = shrunk.slice(0, i).concat(shrunk.slice(i + 1));
			expect(fails(minusOne), `op ${i} (${shrunk[i].kind}) is removable but still fails`).toBe(
				false
			);
		}
		// (d) Tiny, and carries the missed-delete signature: a member appears (spawn)
		//     then leaves (despawn or disable) — the only way the Pos map can diverge
		//     from query(Pos) when onRemove/onDisable are dropped.
		expect(shrunk.length).toBeLessThanOrEqual(8);
		expect(shrunk.some((o) => o.kind === "spawn")).toBe(true);
		expect(shrunk.some((o) => o.kind === "despawn" || o.kind === "disable")).toBe(true);
	});
});
