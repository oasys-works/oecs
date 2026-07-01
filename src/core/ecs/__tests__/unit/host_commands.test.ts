/**
 * Host → ECS write seam (#681) — core contract.
 *
 * Runs under vitest's `__DEV__ = true`, so the per-system access check is LIVE.
 * That makes the `exclusive` bypass load-bearing here: the apply system mutates
 * components it never declared, which a normal system cannot (the negative
 * control proves it). Asserts the properties de-risked in the write-seam prototype:
 *   - enqueue defers — nothing changes until the schedule head drains;
 *   - the full vocabulary applies (spawn / despawn / add / remove / set / dis/enable);
 *   - `onSpawned` reports the deferred id;
 *   - the PRE_STARTUP drain applies seed-time edits at `startup()`.
 * Coalescing into one reactive commit/tick is the read bridge's property
 * (`engine-extensions/reactive` ecs_sync.test.ts); the seam just funnels into the
 * same deferred flush.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import {
	installHostCommandSeam,
	spawnEntry,
	HostCommandDispatcher,
	HOST_COMMAND_PAYLOAD_BYTES,
	ringSetFieldCodec,
	ringDespawnCodec,
	type HostCommandQueue
} from "../../host_commands";
import type { ComponentDef } from "../../component";
import { createEntityId, type EntityID } from "../../entity";
import { pushCommand } from "../../../store";

type CellDef = ComponentDef<{ x: "i32"; heat: "i32" }>;

function makeWorld(): { world: ECS; Cell: CellDef; commands: HostCommandQueue } {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	// Install BEFORE startup so the apply system is head-of-phase and the
	// PRE_STARTUP drain exists.
	const commands = installHostCommandSeam(world);
	return { world, Cell, commands };
}

describe("host command seam — enqueue defers", () => {
	it("enqueue mutates nothing until the schedule head drains", () => {
		const { world, Cell, commands } = makeWorld();
		world.startup();

		commands.spawn([spawnEntry(Cell, { x: 5, heat: 0 })]);
		// Off-schedule enqueue: the world is untouched, the queue holds it.
		expect(commands.pending()).toBe(1);
		expect(world.query(Cell).count()).toBe(0);

		world.update(1 / 60);
		// Drained at PRE_UPDATE head, applied at the flush.
		expect(commands.pending()).toBe(0);
		expect(world.query(Cell).count()).toBe(1);
	});
});

describe("host command seam — the vocabulary applies", () => {
	let world: ECS;
	let Cell: CellDef;
	let commands: HostCommandQueue;

	beforeEach(() => {
		({ world, Cell, commands } = makeWorld());
		world.startup();
	});

	it("spawn carries the field values it is given", () => {
		let withVals: EntityID | undefined;
		let zeroed: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 42, heat: 7 })], (e) => (withVals = e));
		commands.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (zeroed = e));
		world.update(1 / 60);

		expect(withVals).toBeDefined();
		expect(world.getField(withVals!, Cell, "x")).toBe(42);
		expect(world.getField(withVals!, Cell, "heat")).toBe(7);
		expect(world.getField(zeroed!, Cell, "x")).toBe(0);
		expect(world.getField(zeroed!, Cell, "heat")).toBe(0);
	});

	it("set_field writes, despawn removes", () => {
		let e: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })], (id) => (e = id));
		world.update(1 / 60);

		commands.setField(e!, Cell, "x", 99);
		world.update(1 / 60);
		expect(world.getField(e!, Cell, "x")).toBe(99);

		commands.despawn(e!);
		world.update(1 / 60);
		expect(world.isAlive(e!)).toBe(false);
		expect(world.query(Cell).count()).toBe(0);
	});

	it("add_component / remove_component on an existing entity", () => {
		const Tag = world.registerComponent({ v: "i32" }) as ComponentDef<{ v: "i32" }>;
		let e: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (id) => (e = id));
		world.update(1 / 60);

		commands.addComponent(e!, Tag, { v: 3 });
		world.update(1 / 60);
		expect(world.hasComponent(e!, Tag)).toBe(true);
		expect(world.getField(e!, Tag, "v")).toBe(3);

		commands.removeComponent(e!, Tag);
		world.update(1 / 60);
		expect(world.hasComponent(e!, Tag)).toBe(false);
	});

	it("disable hides from the default query; enable restores", () => {
		let e: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (id) => (e = id));
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(1);

		commands.disable(e!);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(0);

		commands.enable(e!);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(1);
	});

	it("a frame's worth of commands all apply in one tick", () => {
		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })]);
		commands.spawn([spawnEntry(Cell, { x: 2, heat: 0 })]);
		commands.spawn([spawnEntry(Cell, { x: 3, heat: 0 })]);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(3);
	});
});

describe("host command seam — PRE_STARTUP drain", () => {
	it("seed-time commands apply at startup, before any update", () => {
		const { world, Cell, commands } = makeWorld();
		commands.spawn([spawnEntry(Cell, { x: 11, heat: 0 })]);
		expect(world.query(Cell).count()).toBe(0); // not yet

		world.startup();
		expect(world.query(Cell).count()).toBe(1); // drained at PRE_STARTUP head
	});
});

describe("host command seam — exclusive bypass is load-bearing", () => {
	it("the apply system mutates undeclared components without throwing (DEV access check live)", () => {
		// makeWorld's apply system declares NO access yet spawns/sets Cell — only
		// `exclusive: true` lets that pass. If the bypass regressed, this throws.
		const { world, Cell, commands } = makeWorld();
		world.startup();
		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })]);
		expect(() => world.update(1 / 60)).not.toThrow();
		expect(world.query(Cell).count()).toBe(1);
	});

	it("negative control: a non-exclusive system mutating an undeclared component throws", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		// An existing entity to write to (immediate facade ops, no schedule span).
		const e = world.createEntity();
		world.addComponent(e, Cell, { x: 0, heat: 0 });
		// A plain system (no exclusive, empty access) that writes Cell.x.
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				name: "rogue",
				// Declares no writes — so writing Cell.x must throw the access check.
				reads: [],
				writes: [],
				fn: (ctx) => ctx.setField(e, Cell, "x", 1)
			})
		);
		world.startup();
		expect(() => world.update(1 / 60)).toThrow();
	});
});

// ===========================================================================
// SAB command_ring transport — the second transport (#700). The typed queue
// (above) and the ring resolve to the SAME `applyHostCommand`.
// ===========================================================================

// Consumer-chosen opcodes (the engine owns no opcode numbers). `0` is the
// reserved empty-slot marker, so these start at 1.
const OP_SET = 10;
const OP_DESPAWN = 11;

/** A world whose apply system drains BOTH transports: the typed queue and the
 * SAB ring (via a dispatcher binding `setField` + `despawn` codecs). */
function makeRingWorld(): {
	world: ECS;
	Cell: CellDef;
	commands: HostCommandQueue;
} {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	const ring = new HostCommandDispatcher()
		.onCommand(OP_SET, ringSetFieldCodec(Cell, "x"))
		.onCommand(OP_DESPAWN, ringDespawnCodec());
	const commands = installHostCommandSeam(world, { ring });
	return { world, Cell, commands };
}

/** Push a host command into the world's SAB command ring with `codec` + `op`. */
function pushRing(world: ECS, op: number, payload: Uint8Array): void {
	const buffer = world.columnStore;
	pushCommand(buffer.view, buffer.header.commandRingOff, op, payload);
}

describe("host command ring codec — golden bytes (#700)", () => {
	it("ring_set_field packs id as u32 + value as f64 within the 15-byte payload", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		const codec = ringSetFieldCodec(Cell, "x");

		// eid = (gen 0x10 << 20) | index 0x20304 = 0x01020304 — chosen so the LE
		// u32 bytes are visually obvious. value 2.0 = 0x4000000000000000.
		const eid = createEntityId(0x20304, 0x10);
		const payload = codec.encode({ kind: "set_field", eid, def: Cell, field: "x", value: 2 });

		expect(payload.byteLength).toBe(HOST_COMMAND_PAYLOAD_BYTES);
		expect(payload.byteLength).toBe(15);
		// Layout: [ eid:u32 LE @0 ][ value:f64 LE @4 ][ _reserved 3 B @12 ]
		expect(Array.from(payload)).toEqual([
			0x04,
			0x03,
			0x02,
			0x01, // eid u32 LE
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x40, // value f64 LE (2.0)
			0x00,
			0x00,
			0x00 // reserved
		]);
	});

	it("round-trips id + value through encode → decode", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		const codec = ringSetFieldCodec(Cell, "x");
		const eid = createEntityId(7, 3);
		const decoded = codec.decode(
			codec.encode({ kind: "set_field", eid, def: Cell, field: "x", value: -1.25 })
		);
		expect(decoded).toEqual({ kind: "set_field", eid, def: Cell, field: "x", value: -1.25 });
	});
});

describe("host command seam — two transports, one apply dispatch (#700)", () => {
	it("a set_field via the ring and via the typed queue land identical world state", () => {
		const { world, Cell, commands } = makeRingWorld();
		world.startup();

		// Two entities seeded identically through the typed queue.
		let a: EntityID | undefined;
		let b: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 5, heat: 9 })], (e) => (a = e));
		commands.spawn([spawnEntry(Cell, { x: 5, heat: 9 })], (e) => (b = e));
		world.update(1 / 60);

		// Same logical mutation, two transports: A through the typed queue, B
		// through the SAB ring. One tick drains both.
		commands.setField(a!, Cell, "x", 42);
		pushRing(
			world,
			OP_SET,
			ringSetFieldCodec(Cell, "x").encode({
				kind: "set_field",
				eid: b!,
				def: Cell,
				field: "x",
				value: 42
			})
		);
		world.update(1 / 60);

		// Identical world state — proving both transports resolve to the same
		// `applyHostCommand`.
		expect(world.getField(a!, Cell, "x")).toBe(42);
		expect(world.getField(b!, Cell, "x")).toBe(42);
		expect(world.getField(a!, Cell, "x")).toBe(world.getField(b!, Cell, "x"));
		expect(world.getField(a!, Cell, "heat")).toBe(world.getField(b!, Cell, "heat"));
	});

	it("a ring-sourced despawn goes through the deferred flush (entity gone post-tick)", () => {
		const { world, Cell, commands } = makeRingWorld();
		world.startup();

		let e: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })], (id) => (e = id));
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(1);

		// Despawn via the ring — a structural change, which must route through the
		// same deferred buffers + phase flush a typed-queue despawn uses.
		pushRing(world, OP_DESPAWN, ringDespawnCodec().encode({ kind: "despawn", eid: e! }));
		world.update(1 / 60);

		expect(world.isAlive(e!)).toBe(false);
		expect(world.query(Cell).count()).toBe(0);
	});

	it("the dispatcher skips unbound opcodes (read head still advances)", () => {
		const { world, Cell, commands } = makeRingWorld();
		world.startup();
		let e: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 3, heat: 0 })], (id) => (e = id));
		world.update(1 / 60);

		// Opcode 99 is bound to nothing — drained and skipped, no throw, no effect.
		const payload = new Uint8Array(HOST_COMMAND_PAYLOAD_BYTES);
		pushRing(world, 99, payload);
		// A valid set behind it still applies (the skipped slot didn't stall the ring).
		pushRing(
			world,
			OP_SET,
			ringSetFieldCodec(Cell, "x").encode({
				kind: "set_field",
				eid: e!,
				def: Cell,
				field: "x",
				value: 7
			})
		);
		world.update(1 / 60);
		expect(world.getField(e!, Cell, "x")).toBe(7);
	});
});

describe("host command dispatcher — opcode validation (#700)", () => {
	it("rejects op_code 0 (reserved empty-slot marker) and out-of-u8 codes", () => {
		const d = new HostCommandDispatcher();
		expect(() => d.on(0, () => {})).toThrow();
		expect(() => d.on(256, () => {})).toThrow();
		expect(() => d.on(1.5, () => {})).toThrow();
	});
});

describe("host command seam — set_field immediate/deferred ordering guard", () => {
	it("set_field on a component added in the SAME frame throws an actionable error", () => {
		const { world, Cell, commands } = makeWorld();
		const Vel = world.registerComponent({ vx: "i32" }) as ComponentDef<{ vx: "i32" }>;
		world.startup();

		let e: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (id) => (e = id));
		world.update(1 / 60);

		// addComponent defers to the flush; setField is immediate — so setting a
		// field on the just-added (not-yet-flushed) Vel is illegal. The guard turns
		// the opaque getColumn failure into an actionable message rather than
		// letting it surface deep in the column lookup.
		commands.addComponent(e!, Vel, { vx: 0 });
		commands.setField(e!, Vel, "vx", 9);
		expect(() => world.update(1 / 60)).toThrow(/same frame/);

		// Carrying the value in addComponent (the documented path) works fine.
		const { world: w2, Cell: Cell2, commands: c2 } = makeWorld();
		const Vel2 = w2.registerComponent({ vx: "i32" }) as ComponentDef<{ vx: "i32" }>;
		w2.startup();
		let e2: EntityID | undefined;
		c2.spawn([spawnEntry(Cell2, { x: 0, heat: 0 })], (id) => (e2 = id));
		w2.update(1 / 60);
		c2.addComponent(e2!, Vel2, { vx: 9 });
		expect(() => w2.update(1 / 60)).not.toThrow();
		expect(w2.getField(e2!, Vel2, "vx")).toBe(9);
	});
});

describe("host command seam — recorder cannot drain on FIXED_UPDATE (#725)", () => {
	// A recorder logs each tick's `world.update(dt)` so `replayCommandLog` can
	// re-issue it. A FIXED_UPDATE drain receives the FIXED sub-step dt, not the
	// host's variable `update(dt)`, so recording there would replay
	// `update(fixedTimestep)` and diverge (a different fixed sub-step count plus
	// any dt-integrating system). The seam rejects this at INSTALL time rather than
	// silently logging the wrong dt.
	const recorder = { openTick: () => {}, record: () => {} };

	it("rejects installing a recorder on SCHEDULE.FIXED_UPDATE", () => {
		const world = new ECS({ deterministic: true });
		expect(() =>
			installHostCommandSeam(world, { recorder, schedules: [SCHEDULE.FIXED_UPDATE] })
		).toThrow(/FIXED_UPDATE/);
	});

	it("accepts a recorder on a variable-update phase (PRE_UPDATE)", () => {
		const world = new ECS({ deterministic: true });
		expect(() =>
			installHostCommandSeam(world, { recorder, schedules: [SCHEDULE.PRE_UPDATE] })
		).not.toThrow();
	});
});
