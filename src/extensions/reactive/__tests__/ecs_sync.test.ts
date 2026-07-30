/**
 * ecs_sync gate — the "unlock" proof on the REAL engine, not a mock world.
 *
 * Asserts the acceptance criteria end-to-end through actual component
 * observers + change detection:
 *   - one changed entity in an N-entity world wakes exactly one row;
 *   - a quiet tick wakes nobody (publish-only-dirty);
 *   - spawn inserts a row, despawn deletes it (structural observers);
 *   - an equal-value re-publish wakes nobody (the map's content `eq`);
 *   - one tick = one coalesced flush (`batchedUpdate`).
 */
import { describe, expect, it } from "vitest";
import {
	effect,
	reactiveArray,
	reactiveStruct,
	root,
	type ReactiveArray
} from "../../../reactive";
import { ECS, SCHEDULE, type EntityID } from "../../../core/ecs";
import {
	syncComponentToMap,
	syncFieldsToMap,
	syncJoinToMap,
	syncSingletonToStruct,
	syncSingletonToArray,
	batchedUpdate,
	shallow
} from "../ecs_sync";

/** Build a world whose UPDATE system writes `Pos.x` for whatever eids the test
 * queues, and spawns/despawns whatever it queues — so the test scripts a tick. */
function makeWorld() {
	const world = new ECS();
	const Pos = world.registerComponent({ x: "f64" });
	const toWrite: { eid: EntityID; x: number }[] = [];
	const toSpawn: number[] = []; // values for newly-spawned entities
	const toDespawn: EntityID[] = [];
	const toDisable: EntityID[] = []; // entities to ctx.commands.disable this tick
	const toEnable: EntityID[] = []; // entities to ctx.commands.enable this tick
	const spawned: EntityID[] = [];

	world.addSystems(
		SCHEDULE.UPDATE,
		world.registerSystem({
			reads: [Pos],
			writes: [Pos],
			spawns: [[Pos]],
			despawns: [Pos],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			sparseReads: [],
			sparseWrites: [],
			relationReads: [],
			relationWrites: [],
			fn: (ctx) => {
				for (const { eid, x } of toWrite) ctx.setField(eid, Pos, "x", x);
				toWrite.length = 0;
				for (const x of toSpawn) {
					const e = ctx.commands.spawn();
					ctx.commands.add(e, Pos, { x });
					spawned.push(e);
				}
				toSpawn.length = 0;
				for (const eid of toDespawn) ctx.commands.despawn(eid);
				toDespawn.length = 0;
				for (const eid of toDisable) ctx.commands.disable(eid);
				toDisable.length = 0;
				for (const eid of toEnable) ctx.commands.enable(eid);
				toEnable.length = 0;
			}
		})
	);
	return { world, Pos, toWrite, toSpawn, toDespawn, toDisable, toEnable, spawned };
}

describe("syncComponentToMap — real ECS → reactiveMap", () => {
	// The publish-only-dirty guarantee must hold IDENTICALLY for both grains: the
	// "column" grain republishes the whole dirty archetype but value-eq collapses
	// it to O(changed) wakes, exactly like "entity". Run the core gate for both.
	it.each(["entity", "column"] as const)(
		"[grain=%s] one changed entity in N wakes exactly one row; a quiet tick wakes nobody",
		(grain) => {
			const N = 200;
			const { world, Pos, toWrite } = makeWorld();
			// Pre-populate (immediate setup adds), then wire the bridge: seedExisting
			// replays onAdd over current matches, so the map starts fully populated.
			const ids: EntityID[] = [];
			for (let i = 0; i < N; i++) {
				const e = world.spawn();
				world.addComponent(e, Pos, { x: 0 });
				ids.push(e);
			}
			const sync = syncComponentToMap(world, Pos, (row) => row.field("x"), { grain });
			world.startup();

			expect(sync.map.size()).toBe(N); // seeded
			const wakes = new Array(N).fill(0);
			root(() => {
				for (let i = 0; i < N; i++) {
					effect(() => {
						wakes[i]++;
						sync.map.get(ids[i]);
					});
				}
			});
			for (let i = 0; i < N; i++) wakes[i] = 0; // discard mount/priming runs

			// One entity changes this tick.
			toWrite.push({ eid: ids[7], x: 42 });
			batchedUpdate(world, 1 / 60);
			expect(sync.map.get(ids[7])).toBe(42);
			expect(wakes[7]).toBe(1);
			expect(wakes.filter((_, i) => i !== 7).every((w) => w === 0)).toBe(true);

			// A frame with no ECS writes wakes nobody.
			for (let i = 0; i < N; i++) wakes[i] = 0;
			batchedUpdate(world, 1 / 60);
			expect(wakes.every((w) => w === 0)).toBe(true);
		}
	);

	it("spawn inserts a row, despawn deletes it (structural observers)", () => {
		const { world, Pos, toSpawn, toDespawn, spawned } = makeWorld();
		const sync = syncComponentToMap(world, Pos, (row) => row.field("x"));
		world.startup();
		expect(sync.map.size()).toBe(0);

		toSpawn.push(11);
		batchedUpdate(world, 1 / 60);
		const e = spawned[0];
		expect(sync.map.size()).toBe(1);
		expect(sync.map.get(e)).toBe(11);

		toDespawn.push(e);
		batchedUpdate(world, 1 / 60);
		expect(sync.map.size()).toBe(0);
		expect(sync.map.get(e)).toBeUndefined();
	});

	it("an equal-value re-publish wakes nobody (content eq on an object projection)", () => {
		const { world, Pos, toWrite } = makeWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 5 });
		const sync = syncComponentToMap(world, Pos, (row) => ({ x: row.field("x") }), {
			eq: (a, b) => a.x === b.x
		});
		world.startup();

		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				sync.map.get(e);
			});
		});
		wakes = 0;

		// Re-write the SAME value: onSet fires (tick-dirty), but the content eq
		// means the per-key signal skips → the row wakes nobody.
		toWrite.push({ eid: e, x: 5 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(0);

		// A real change wakes once.
		toWrite.push({ eid: e, x: 6 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(1);
		expect(sync.map.get(e)).toEqual({ x: 6 });
	});

	it("dispose() stops publishing", () => {
		const { world, Pos, toWrite } = makeWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0 });
		const sync = syncComponentToMap(world, Pos, (row) => row.field("x"));
		world.startup();

		sync.dispose();
		toWrite.push({ eid: e, x: 99 });
		batchedUpdate(world, 1 / 60);
		// The map no longer tracks the change (observer unregistered).
		expect(sync.map.get(e)).toBe(0);
	});

	it("merges access.reads with the synced def (a caller's extra reads don't drop def)", () => {
		const { world, Pos, toWrite } = makeWorld();
		const Other = world.registerComponent({ z: "f64" });
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });
		// The caller declares an unrelated extra read. Pre-fix, `{ reads:[def],
		// ...access }` let `access.reads` OVERRIDE and drop `def`, so the projection's
		// `getField(Pos)` — run under the observer's access in __DEV__ — threw. The
		// merge keeps `def` in the read set, so seed + tick both succeed.
		const sync = syncComponentToMap(world, Pos, (row) => row.field("x"), {
			access: { reads: [Other] }
		});
		world.startup();
		expect(sync.map.get(e)).toBe(1); // seed read def under merged access, no throw

		toWrite.push({ eid: e, x: 9 });
		expect(() => batchedUpdate(world, 1 / 60)).not.toThrow();
		expect(sync.map.get(e)).toBe(9);
	});
});

// ---------------------------------------------------------------------------
// syncFieldsToMap — declarative field-list sugar (auto shallow eq)
// ---------------------------------------------------------------------------
describe("syncFieldsToMap", () => {
	it("projects the listed fields and auto-dedups by content (no hand-written eq)", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64", hp: "f64" });
		const toWrite: { eid: EntityID; field: "x" | "y" | "hp"; v: number }[] = [];
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				reads: [Pos],
				writes: [Pos],
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
					for (const w of toWrite) ctx.setField(w.eid, Pos, w.field, w.v);
					toWrite.length = 0;
				}
			})
		);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2, hp: 100 });
		// Project only {x, y}; hp is NOT in the field list.
		const sync = syncFieldsToMap(world, Pos, ["x", "y"]);
		world.startup();
		expect(sync.map.get(e)).toEqual({ x: 1, y: 2 });

		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				sync.map.get(e);
			});
		});
		wakes = 0;

		// Writing hp marks the entity dirty (it's the same component), so the row is
		// re-projected — but the projection {x,y} is unchanged, and the AUTO shallow
		// eq skips it. No hand-written comparator needed.
		toWrite.push({ eid: e, field: "hp", v: 50 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(0);

		// Writing a listed field changes the projection → one wake.
		toWrite.push({ eid: e, field: "x", v: 9 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(1);
		expect(sync.map.get(e)).toEqual({ x: 9, y: 2 });
	});
});

// ---------------------------------------------------------------------------
// syncJoinToMap — multi-component join (the staleness fix)
// ---------------------------------------------------------------------------
/** World with Pos{x} + Health{hp}; a system writes either component or adds/
 * removes Health on a Pos entity, so a test can script a join scenario. */
function makeJoinWorld() {
	const world = new ECS();
	const Pos = world.registerComponent({ x: "f64" });
	const Health = world.registerComponent({ hp: "f64" });
	const writePos: { eid: EntityID; x: number }[] = [];
	const writeHp: { eid: EntityID; hp: number }[] = [];
	const addHp: { eid: EntityID; hp: number }[] = [];
	const removeHp: EntityID[] = [];
	const toDisable: EntityID[] = [];
	const toEnable: EntityID[] = [];
	world.addSystems(
		SCHEDULE.UPDATE,
		world.registerSystem({
			reads: [Pos, Health],
			writes: [Pos, Health],
			spawns: [],
			despawns: [Health],
			transitions: [{ whenHas: [Pos], add: [Health], remove: [Health] }],
			resourceReads: [],
			resourceWrites: [],
			sparseReads: [],
			sparseWrites: [],
			relationReads: [],
			relationWrites: [],
			fn: (ctx) => {
				for (const w of writePos) ctx.setField(w.eid, Pos, "x", w.x);
				writePos.length = 0;
				for (const w of writeHp) ctx.setField(w.eid, Health, "hp", w.hp);
				writeHp.length = 0;
				for (const a of addHp) ctx.commands.add(a.eid, Health, { hp: a.hp });
				addHp.length = 0;
				for (const eid of removeHp) ctx.commands.remove(eid, Health);
				removeHp.length = 0;
				for (const eid of toDisable) ctx.commands.disable(eid);
				toDisable.length = 0;
				for (const eid of toEnable) ctx.commands.enable(eid);
				toEnable.length = 0;
			}
		})
	);
	return { world, Pos, Health, writePos, writeHp, addHp, removeHp, toDisable, toEnable };
}

describe("syncJoinToMap — multi-component join", () => {
	it("a write to a SECONDARY joined component republishes the row (no staleness)", () => {
		const { world, Pos, Health, writeHp } = makeJoinWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 7 });
		world.addComponent(e, Health, { hp: 100 });
		const sync = syncJoinToMap(
			world,
			[Pos, Health],
			(row) => ({ x: row.field(Pos, "x"), hp: row.field(Health, "hp") }),
			{ eq: shallow }
		);
		world.startup();
		expect(sync.map.get(e)).toEqual({ x: 7, hp: 100 });

		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				sync.map.get(e);
			});
		});
		wakes = 0;

		// Mutating ONLY Health must still republish the joined row. A single-
		// component sync on Pos + a manual Health read would have gone stale here —
		// this is the bug the join fixes.
		writeHp.push({ eid: e, hp: 80 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(1);
		expect(sync.map.get(e)).toEqual({ x: 7, hp: 80 });
	});

	it("membership tracks the full join: appears on gaining the last component, drops on losing one", () => {
		const { world, Pos, Health, addHp, removeHp } = makeJoinWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 }); // has Pos only — NOT a join member
		const sync = syncJoinToMap(world, [Pos, Health], (row) => ({
			x: row.field(Pos, "x"),
			hp: row.field(Health, "hp")
		}));
		world.startup();
		expect(sync.map.has(e)).toBe(false); // missing Health → not a member

		addHp.push({ eid: e, hp: 50 }); // now has Pos+Health → joins
		batchedUpdate(world, 1 / 60);
		expect(sync.map.get(e)).toEqual({ x: 1, hp: 50 });

		removeHp.push(e); // loses Health → leaves the join
		batchedUpdate(world, 1 / 60);
		expect(sync.map.has(e)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Entity enable/disable — disable = soft remove from the
// channel, enable = re-add. A disabled entity leaves the default-query result
// set, so it leaves the map (flecs query-monitor / Bevy default-query-filter /
// RxDB observable-query semantics). seedExisting seeds enabled members only.
// ---------------------------------------------------------------------------
describe("syncComponentToMap — enable/disable", () => {
	it.each(["entity", "column"] as const)(
		"[grain=%s] disabling deletes the row; re-enabling republishes it",
		(grain) => {
			const { world, Pos, toWrite, toDisable, toEnable } = makeWorld();
			const e = world.spawn();
			world.addComponent(e, Pos, { x: 5 });
			const sync = syncComponentToMap(world, Pos, (row) => row.field("x"), { grain });
			world.startup();
			expect(sync.map.get(e)).toBe(5); // seeded (enabled)

			// Disable → the row leaves the channel.
			toDisable.push(e);
			batchedUpdate(world, 1 / 60);
			expect(sync.map.has(e)).toBe(false);

			// A write while disabled does not resurrect it (column sweep is bounded by
			// enabled rows; entity grain's dirty list still drains but the row is gone —
			// the next enable republishes the current value).
			toWrite.push({ eid: e, x: 9 });
			batchedUpdate(world, 1 / 60);
			expect(sync.map.has(e)).toBe(false);

			// Re-enable → republished with its CURRENT value.
			toEnable.push(e);
			batchedUpdate(world, 1 / 60);
			expect(sync.map.get(e)).toBe(9);
		}
	);

	it("seedExisting seeds enabled members only — a disabled entity is absent at attach", () => {
		const { world, Pos } = makeWorld();
		const enabled = world.spawn();
		const disabled = world.spawn();
		world.addComponent(enabled, Pos, { x: 1 });
		world.addComponent(disabled, Pos, { x: 2 });
		world.disable(disabled); // immediate host-side disable before the bridge attaches
		const sync = syncComponentToMap(world, Pos, (row) => row.field("x"));
		world.startup();
		expect(sync.map.size()).toBe(1);
		expect(sync.map.get(enabled)).toBe(1);
		expect(sync.map.has(disabled)).toBe(false);
	});

	it("disabling wakes the row's reader exactly once (delete is a single change)", () => {
		const { world, Pos, toDisable } = makeWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 3 });
		const sync = syncComponentToMap(world, Pos, (row) => row.field("x"));
		world.startup();

		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				sync.map.get(e);
			});
		});
		wakes = 0;

		toDisable.push(e);
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(1);
		expect(sync.map.has(e)).toBe(false);
	});
});

describe("syncJoinToMap — enable/disable", () => {
	it("disabling a join member drops the row; re-enabling re-adds it", () => {
		const { world, Pos, Health, toDisable, toEnable } = makeJoinWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 7 });
		world.addComponent(e, Health, { hp: 100 });
		const sync = syncJoinToMap(world, [Pos, Health], (row) => ({
			x: row.field(Pos, "x"),
			hp: row.field(Health, "hp")
		}));
		world.startup();
		expect(sync.map.get(e)).toEqual({ x: 7, hp: 100 });

		// Disable fires onDisable for BOTH joined components (dropRow is idempotent).
		toDisable.push(e);
		batchedUpdate(world, 1 / 60);
		expect(sync.map.has(e)).toBe(false);

		// Enable re-evaluates membership (entity still has both components) → re-adds.
		toEnable.push(e);
		batchedUpdate(world, 1 / 60);
		expect(sync.map.get(e)).toEqual({ x: 7, hp: 100 });
	});

	it("completing the join on a DISABLED entity does not add it (on_add enabled-only)", () => {
		// The bug the churn oracle caught: a live onAdd fires for a joined
		// component ADDED to an already-disabled entity (a structural event is
		// enable-agnostic), and `publishIfMember` checked only `hasComponent` — so it
		// published a row `query(Pos, Health)` excludes. Here `e` has Pos, is disabled,
		// then gains Health (completing the join) while disabled: it must stay absent
		// until enabled, then appear on enable.
		const { world, Pos, Health, addHp, toEnable } = makeJoinWorld();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 3 });
		world.disable(e); // disabled before it is ever a join member
		const sync = syncJoinToMap(world, [Pos, Health], (row) => ({
			x: row.field(Pos, "x"),
			hp: row.field(Health, "hp")
		}));
		world.startup();
		expect(sync.map.has(e)).toBe(false); // not enabled, not a member

		// Gain Health while disabled → join is structurally complete, but the entity is
		// disabled, so the channel must NOT show it (it is absent from the default query).
		addHp.push({ eid: e, hp: 50 });
		batchedUpdate(world, 1 / 60);
		expect(sync.map.has(e)).toBe(false);

		// Enable → onEnable re-evaluates membership (has Pos + Health) → now appears.
		toEnable.push(e);
		batchedUpdate(world, 1 / 60);
		expect(sync.map.get(e)).toEqual({ x: 3, hp: 50 });
	});
});

describe("syncComponentToMap — enable/disable add path", () => {
	it.each(["entity", "column"] as const)(
		"[grain=%s] adding the synced component to a DISABLED entity does not add it (on_add enabled-only)",
		(grain) => {
			// The single-component twin of the join bug: onAdd fires for the
			// synced component added to an already-disabled entity, and `publishEntity`
			// had no enabled guard — so it published a row `query(Health)` excludes. Sync
			// HEALTH (the addable component); `e` carries Pos, is disabled, then gains
			// Health while disabled — it must stay absent until enabled.
			const { world, Pos, Health, addHp, toEnable } = makeJoinWorld();
			const e = world.spawn();
			world.addComponent(e, Pos, { x: 0 }); // a real entity (carries Pos), no Health yet
			world.disable(e);
			const sync = syncComponentToMap(world, Health, (row) => row.field("hp"), { grain });
			world.startup();
			expect(sync.map.has(e)).toBe(false);

			addHp.push({ eid: e, hp: 9 }); // gain the synced component while disabled
			batchedUpdate(world, 1 / 60);
			expect(sync.map.has(e)).toBe(false); // disabled → absent from the channel

			toEnable.push(e); // enable → onEnable publishes the current value
			batchedUpdate(world, 1 / 60);
			expect(sync.map.get(e)).toBe(9);
		}
	);
});

// ---------------------------------------------------------------------------
// syncSingletonToStruct — singleton entity → reactiveStruct.
// The singleton/resource shape: per-FIELD channels (not per-entity), keyless. The
// three load-bearing properties end-to-end through a real tick, plus seed / quiet /
// dispose / disable+enable. A struct has no delete, so disable resets to defaults.
// ---------------------------------------------------------------------------
/** A world whose UPDATE system drains a write/disable/enable queue against ONE
 * reserved singleton entity carrying a `Session` component (netStatus enum-as-i32,
 * latency/fps f64) — the heterogeneous-but-numeric shape the mechanism targets. */
function makeSingletonWorld() {
	const world = new ECS({ deterministic: false }); // the client/UI world is non-deterministic
	const Session = world.registerComponent({ netStatus: "i32", latency: "f64", fps: "f64" });
	const singleton = world.spawn();
	world.addComponent(singleton, Session, { netStatus: 2, latency: 20, fps: 60 });

	type Field = "netStatus" | "latency" | "fps";
	const writes: { field: Field; v: number }[] = [];
	const toDisable: EntityID[] = [];
	const toEnable: EntityID[] = [];
	world.addSystems(
		SCHEDULE.UPDATE,
		world.registerSystem({
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
				for (const w of writes) ctx.setField(singleton, Session, w.field, w.v);
				writes.length = 0;
				for (const e of toDisable) ctx.commands.disable(e);
				toDisable.length = 0;
				for (const e of toEnable) ctx.commands.enable(e);
				toEnable.length = 0;
			}
		})
	);
	return { world, Session, singleton, writes, toDisable, toEnable };
}

const SESSION_FIELDS = ["netStatus", "latency", "fps"] as const;

/** Attach per-field effects; returns a live wake-count record, zeroed after mount. */
function watchStruct(struct: { netStatus: number; latency: number; fps: number }): {
	netStatus: number;
	latency: number;
	fps: number;
} {
	const wakes = { netStatus: 0, latency: 0, fps: 0 };
	root(() => {
		effect(() => {
			wakes.netStatus++;
			void struct.netStatus;
		});
		effect(() => {
			wakes.latency++;
			void struct.latency;
		});
		effect(() => {
			wakes.fps++;
			void struct.fps;
		});
	});
	wakes.netStatus = wakes.latency = wakes.fps = 0;
	return wakes;
}

describe("syncSingletonToStruct — real ECS singleton → reactiveStruct", () => {
	it("seeds the struct with the singleton's current field values on attach", () => {
		const { world, Session, singleton } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		expect({ ...sync.struct }).toEqual({ netStatus: 2, latency: 20, fps: 60 });
	});

	it("`into` drives a pre-created (eager) struct — the module-scope channel seam", () => {
		const { world, Session, singleton, writes } = makeSingletonWorld();
		// An eager struct created BEFORE the world/sync — the client UI seam shape.
		const channel = reactiveStruct({ netStatus: 0, latency: 0, fps: 0 });
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS, {
			into: channel
		});
		expect(sync.struct).toBe(channel[0]); // returns the SAME proxy the consumer holds
		world.startup();
		// seed overwrote the eager zeros with the entity's current values
		expect({ ...channel[0] }).toEqual({ netStatus: 2, latency: 20, fps: 60 });

		const wakes = watchStruct(channel[0]);
		writes.push({ field: "latency", v: 33 });
		batchedUpdate(world, 1 / 60);
		expect(channel[0].latency).toBe(33);
		expect(wakes).toEqual({ netStatus: 0, latency: 1, fps: 0 });
	});

	it("1-of-N field change → 1 re-render (per-field isolation through a real tick)", () => {
		const { world, Session, singleton, writes } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		const wakes = watchStruct(sync.struct);

		writes.push({ field: "latency", v: 35 });
		batchedUpdate(world, 1 / 60);
		expect(sync.struct.latency).toBe(35);
		expect(wakes).toEqual({ netStatus: 0, latency: 1, fps: 0 }); // only latency woke
	});

	it("equal write → 0 renders (per-field eq, driven by a real onSet)", () => {
		const { world, Session, singleton, writes } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		const wakes = watchStruct(sync.struct);

		// onSet fires (the entity is dirty) but the per-field eq skips the equal value.
		writes.push({ field: "fps", v: 60 }); // same as seed
		batchedUpdate(world, 1 / 60);
		expect(wakes.fps).toBe(0);

		writes.push({ field: "fps", v: 59 }); // real change
		batchedUpdate(world, 1 / 60);
		expect(wakes.fps).toBe(1);
		expect(sync.struct.fps).toBe(59);
	});

	it("one batched tick → 1 commit (many writes in a tick coalesce per field)", () => {
		const { world, Session, singleton, writes } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		const wakes = watchStruct(sync.struct);

		writes.push({ field: "latency", v: 45 });
		writes.push({ field: "latency", v: 50 });
		writes.push({ field: "fps", v: 75 });
		batchedUpdate(world, 1 / 60);
		expect(sync.struct.latency).toBe(50); // final value of the tick
		expect(sync.struct.fps).toBe(75);
		expect(wakes).toEqual({ netStatus: 0, latency: 1, fps: 1 }); // latency's two writes → one wake
	});

	it("a quiet tick wakes nobody (publish-only-dirty)", () => {
		const { world, Session, singleton } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		const wakes = watchStruct(sync.struct);

		batchedUpdate(world, 1 / 60);
		expect(wakes).toEqual({ netStatus: 0, latency: 0, fps: 0 });
	});

	it("projects a subset of fields (channel only what the UI reads)", () => {
		const { world, Session, singleton, writes } = makeSingletonWorld();
		// Only latency; netStatus/fps are not in the field list.
		const sync = syncSingletonToStruct(world, Session, singleton, ["latency"]);
		world.startup();
		expect(Object.keys(sync.struct)).toEqual(["latency"]);
		expect(sync.struct.latency).toBe(20);

		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				void sync.struct.latency;
			});
		});
		wakes = 0;

		// Writing a non-projected field marks the entity dirty (same component), but
		// the publish only reads `latency` → no struct field changes → no wake.
		writes.push({ field: "fps", v: 1 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(0);

		writes.push({ field: "latency", v: 7 });
		batchedUpdate(world, 1 / 60);
		expect(wakes).toBe(1);
		expect(sync.struct.latency).toBe(7);
	});

	it("dispose() stops publishing", () => {
		const { world, Session, singleton, writes } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		sync.dispose();

		writes.push({ field: "latency", v: 999 });
		batchedUpdate(world, 1 / 60);
		expect(sync.struct.latency).toBe(20); // unchanged
	});

	it("disable resets the struct to defaults; enable republishes current values", () => {
		const { world, Session, singleton, writes, toDisable, toEnable } = makeSingletonWorld();
		const sync = syncSingletonToStruct(world, Session, singleton, SESSION_FIELDS);
		world.startup();
		const wakes = watchStruct(sync.struct);

		// Disable → onDisable resets fields to defaults; onSet skips the disabled entity.
		toDisable.push(singleton);
		batchedUpdate(world, 1 / 60);
		expect({ ...sync.struct }).toEqual({ netStatus: 0, latency: 0, fps: 0 });
		expect(wakes).toEqual({ netStatus: 1, latency: 1, fps: 1 }); // each nonzero field woke once

		// A write while disabled updates the column but not the struct.
		writes.push({ field: "latency", v: 77 });
		batchedUpdate(world, 1 / 60);
		expect(sync.struct.latency).toBe(0);

		// Enable → onEnable republishes the entity's CURRENT values (latency now 77).
		toEnable.push(singleton);
		batchedUpdate(world, 1 / 60);
		expect({ ...sync.struct }).toEqual({ netStatus: 2, latency: 77, fps: 60 });
	});
});

// ---------------------------------------------------------------------------
// syncSingletonToArray — singleton entity → reactiveArray. The
// ORDERED sibling of syncSingletonToStruct: positional slots (the army). Gates the
// army's real delivery path — a HOST-SIDE setField (network callbacks write the
// ArmyComposition OUTSIDE any system) drained into the channel at the next tick —
// plus seed / into / per-slot isolation / coalescing / dispose, and the reset-to-
// declared-initials behaviour (an empty slot is the channel's sentinel, not type 0).
// ---------------------------------------------------------------------------
const SLOT_FIELDS = ["s0", "s1", "s2"] as const;
const EMPTY = 255; // an "empty slot" sentinel (cf. the army's EMPTY_SLOT = 0xff)

/** A world with ONE singleton carrying a 3-slot `Army` component (u8 per slot),
 * its slots initialised to EMPTY. An UPDATE system drains an in-tick write/disable/
 * enable queue; host-side writes go straight through `world.setField` in the test. */
function makeSingletonArrayWorld() {
	const world = new ECS({ deterministic: false });
	const Army = world.registerComponent({ s0: "u8", s1: "u8", s2: "u8" });
	const singleton = world.spawn();
	world.addComponent(singleton, Army, { s0: EMPTY, s1: EMPTY, s2: EMPTY });

	type Slot = "s0" | "s1" | "s2";
	const writes: { slot: Slot; v: number }[] = [];
	const toDisable: EntityID[] = [];
	const toEnable: EntityID[] = [];
	world.addSystems(
		SCHEDULE.UPDATE,
		world.registerSystem({
			reads: [Army],
			writes: [Army],
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
				for (const w of writes) ctx.setField(singleton, Army, w.slot, w.v);
				writes.length = 0;
				for (const e of toDisable) ctx.commands.disable(e);
				toDisable.length = 0;
				for (const e of toEnable) ctx.commands.enable(e);
				toEnable.length = 0;
			}
		})
	);
	return { world, Army, singleton, writes, toDisable, toEnable };
}

/** Attach a per-slot effect; returns a live wake-count array, zeroed after mount. */
function watchArray(array: ReactiveArray<number>, n: number): number[] {
	const wakes = new Array<number>(n).fill(0);
	root(() => {
		for (let i = 0; i < n; i++) {
			effect(() => {
				wakes[i]++;
				void array.get(i);
			});
		}
	});
	for (let i = 0; i < n; i++) wakes[i] = 0;
	return wakes;
}

describe("syncSingletonToArray — real ECS singleton → reactiveArray", () => {
	it("seeds the array with the singleton's current slots on attach", () => {
		const { world, Army, singleton } = makeSingletonArrayWorld();
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS);
		world.startup();
		expect(sync.array.snapshot()).toEqual([EMPTY, EMPTY, EMPTY]);
	});

	it("`into` drives a pre-created (eager) reactiveArray — the army channel seam", () => {
		const { world, Army, singleton } = makeSingletonArrayWorld();
		const channel = reactiveArray<number>([EMPTY, EMPTY, EMPTY]);
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS, { into: channel });
		expect(sync.array).toBe(channel); // drives the SAME array the consumer holds
		world.startup();
		expect(channel.snapshot()).toEqual([EMPTY, EMPTY, EMPTY]);
	});

	it("a HOST-SIDE write (the army's network-callback path) reaches the channel next tick", () => {
		// The army is written by network callbacks via world.setField OUTSIDE any
		// system; the dirty mark drains at the next tick's onSet detection point.
		const { world, Army, singleton } = makeSingletonArrayWorld();
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS);
		world.startup();
		const wakes = watchArray(sync.array, 3);

		world.setField(singleton, Army, "s1", 1); // host-side, between ticks
		expect(sync.array.get(1)).toBe(EMPTY); // not published until the tick drains
		batchedUpdate(world, 1 / 60);
		expect(sync.array.get(1)).toBe(1);
		expect(wakes).toEqual([0, 1, 0]); // only slot 1 woke
	});

	it("per-slot isolation + equal write: 1-of-N wakes one slot, an equal write wakes none", () => {
		const { world, Army, singleton, writes } = makeSingletonArrayWorld();
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS);
		world.startup();
		const wakes = watchArray(sync.array, 3);

		writes.push({ slot: "s2", v: 2 });
		batchedUpdate(world, 1 / 60);
		expect(sync.array.get(2)).toBe(2);
		expect(wakes).toEqual([0, 0, 1]);

		writes.push({ slot: "s2", v: 2 }); // equal → no-op skip
		batchedUpdate(world, 1 / 60);
		expect(wakes).toEqual([0, 0, 1]);
	});

	it("one batched tick → 1 commit (repeated writes to a slot coalesce)", () => {
		const { world, Army, singleton, writes } = makeSingletonArrayWorld();
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS);
		world.startup();
		const wakes = watchArray(sync.array, 3);

		writes.push({ slot: "s0", v: 1 });
		writes.push({ slot: "s0", v: 2 });
		batchedUpdate(world, 1 / 60);
		expect(sync.array.get(0)).toBe(2);
		expect(wakes).toEqual([1, 0, 0]); // two writes → one wake
	});

	it("a quiet tick wakes nobody (publish-only-dirty)", () => {
		const { world, Army, singleton } = makeSingletonArrayWorld();
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS);
		world.startup();
		const wakes = watchArray(sync.array, 3);
		batchedUpdate(world, 1 / 60);
		expect(wakes).toEqual([0, 0, 0]);
	});

	it("dispose() stops publishing", () => {
		const { world, Army, singleton } = makeSingletonArrayWorld();
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS);
		world.startup();
		sync.dispose();
		world.setField(singleton, Army, "s0", 1);
		batchedUpdate(world, 1 / 60);
		expect(sync.array.get(0)).toBe(EMPTY); // unchanged
	});

	it("rejects an `into` whose length differs from fields.length", () => {
		// A mismatched `into` makes `publish` reconcile to a `fields.length` array while
		// `reset` reconciles to the `into`-sized defaults snapshot, so the array's length
		// oscillates on every enable↔disable cycle. Reject the misconfiguration at setup.
		const { world, Army, singleton } = makeSingletonArrayWorld();

		// Too SHORT: 2 slots for 3 fields.
		const tooShort = reactiveArray<number>([EMPTY, EMPTY]);
		expect(() =>
			syncSingletonToArray(world, Army, singleton, SLOT_FIELDS, { into: tooShort })
		).toThrow(/into\.length \(2\) must equal fields\.length \(3\)/);

		// Too LONG: 4 slots for 3 fields.
		const tooLong = reactiveArray<number>([EMPTY, EMPTY, EMPTY, EMPTY]);
		expect(() =>
			syncSingletonToArray(world, Army, singleton, SLOT_FIELDS, { into: tooLong })
		).toThrow(Error);
	});

	it("accepts an `into` whose length equals fields.length and syncs normally", () => {
		// The correctly-sized `into` is the supported path: no throw, and it drives the
		// SAME array, seeds it, and publishes host-side writes at the next tick.
		const { world, Army, singleton } = makeSingletonArrayWorld();
		const channel = reactiveArray<number>([EMPTY, EMPTY, EMPTY]); // length === fields.length
		let sync!: ReturnType<typeof syncSingletonToArray>;
		expect(() => {
			sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS, { into: channel });
		}).not.toThrow();
		expect(sync.array).toBe(channel);
		world.startup();
		expect(channel.snapshot()).toEqual([EMPTY, EMPTY, EMPTY]); // seeded

		world.setField(singleton, Army, "s1", 3); // host-side write
		batchedUpdate(world, 1 / 60);
		expect(channel.snapshot()).toEqual([EMPTY, 3, EMPTY]); // synced
	});

	it("disable resets to the channel's DECLARED initials (the empty sentinel, not 0)", () => {
		// The reset target is the eager channel's own defaults — for the army that's
		// EMPTY per slot. A blind 0 would read as unit type 0 (a real unit).
		const { world, Army, singleton, writes, toDisable, toEnable } = makeSingletonArrayWorld();
		const channel = reactiveArray<number>([EMPTY, EMPTY, EMPTY]);
		const sync = syncSingletonToArray(world, Army, singleton, SLOT_FIELDS, { into: channel });
		world.startup();
		writes.push({ slot: "s0", v: 1 }); // occupy a slot so the reset is observable
		batchedUpdate(world, 1 / 60);
		expect(sync.array.snapshot()).toEqual([1, EMPTY, EMPTY]);

		toDisable.push(singleton);
		batchedUpdate(world, 1 / 60);
		expect(sync.array.snapshot()).toEqual([EMPTY, EMPTY, EMPTY]); // sentinel, NOT [0,0,0]

		// Enable republishes the singleton's CURRENT slots (s0 still 1 in the column).
		toEnable.push(singleton);
		batchedUpdate(world, 1 / 60);
		expect(sync.array.snapshot()).toEqual([1, EMPTY, EMPTY]);
	});
});

// ---------------------------------------------------------------------------
describe("shallow", () => {
	it("compares own keys by Object.is", () => {
		expect(shallow({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
		expect(shallow({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
		expect(shallow({ x: 1 }, { x: 1, y: 2 })).toBe(false);
		const o = { x: 1 };
		expect(shallow(o, o)).toBe(true); // reference fast path
	});
});

// ---------------------------------------------------------------------------
// Cross-sync coalescing — the Engine._tick contract. The per-sync "one batched
// tick → 1 commit" gates above hold within ONE channel; this gates the property
// ACROSS channels: a reader depending on several syncs' channels wakes once per
// batched tick, not once per changed field. This is exactly what
// `Engine._tick`'s `batch(() => ecs.update(dt))` provides in production — the
// unbatched counter-case below is why the wrapper is load-bearing (an unbatched
// kernel write flushes synchronously, so each publish wakes readers separately).
// ---------------------------------------------------------------------------
describe("cross-sync coalescing (the batched-tick contract)", () => {
	function makeTwoChannelWorld() {
		const world = new ECS({ deterministic: false });
		const Net = world.registerComponent({ latency: "f64" });
		const Clock = world.registerComponent({ elapsed: "f64" });
		const singleton = world.spawn();
		world.addComponent(singleton, Net, { latency: 20 });
		world.addComponent(singleton, Clock, { elapsed: 0 });
		const writes: { latency?: number; elapsed?: number }[] = [];
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				reads: [Net, Clock],
				writes: [Net, Clock],
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
					for (const w of writes) {
						if (w.latency !== undefined) ctx.setField(singleton, Net, "latency", w.latency);
						if (w.elapsed !== undefined) ctx.setField(singleton, Clock, "elapsed", w.elapsed);
					}
					writes.length = 0;
				}
			})
		);
		const net = syncSingletonToStruct(world, Net, singleton, ["latency"] as const);
		const clock = syncSingletonToStruct(world, Clock, singleton, ["elapsed"] as const);
		world.startup();
		return { world, writes, net, clock };
	}

	it("a reader spanning two channels wakes ONCE per batched tick", () => {
		const { world, writes, net, clock } = makeTwoChannelWorld();
		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				void net.struct.latency;
				void clock.struct.elapsed;
			});
		});
		wakes = 0;

		writes.push({ latency: 33, elapsed: 1.5 }); // both channels change this tick
		batchedUpdate(world, 1 / 60);
		expect(net.struct.latency).toBe(33);
		expect(clock.struct.elapsed).toBe(1.5);
		expect(wakes).toBe(1); // one tick → one commit, ACROSS syncs
	});

	it("an UNBATCHED update wakes the reader once per changed channel (why _tick batches)", () => {
		const { world, writes, net, clock } = makeTwoChannelWorld();
		let wakes = 0;
		root(() => {
			effect(() => {
				wakes++;
				void net.struct.latency;
				void clock.struct.elapsed;
			});
		});
		wakes = 0;

		writes.push({ latency: 40, elapsed: 2.5 });
		world.update(1 / 60); // bare update — each publish flushes synchronously
		expect(wakes).toBe(2); // documents the torn behavior batch() removes
	});
});
