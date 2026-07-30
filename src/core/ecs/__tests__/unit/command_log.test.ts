/**
 * Record / replay over the host command log — the final layer of the
 * host → ECS write seam. Asserts the deterministic-sim payoff:
 *   - the apply path logs the applied `HostCommand`s + per-tick `dt` + seed,
 *     behind an opt-in recorder (off by default — the un-recorded drain is
 *     unchanged);
 *   - the log round-trips through serialize → deserialize (plain JSON);
 *   - a replay driver re-applies it against a FRESH world and, under the
 *     determinism opt-in, reproduces the per-tick `stateHash`
 *     sequence bit-for-bit — including the dt-driven evolution of a system
 *     (the clock), proving `dt` is a real replayed input, not just the commands;
 *   - both transports (typed queue + `onCommand` ring) land in the one log.
 *
 * Runs under vitest's `__DEV__ = true` (the per-system access check is live).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import {
	installHostCommandSeam,
	spawnEntry,
	HostCommandDispatcher,
	ringSetFieldCodec,
	type HostCommandQueue,
	type HostCommandSink
} from "../../host_commands";
import {
	HostCommandRecorder,
	serializeCommandLog,
	deserializeCommandLog,
	replayCommandLog,
	type CommandLog
} from "../../command_log";
import { asComponentId, makeComponentDef, type ComponentDef } from "../../component";
import { ECS_ERROR, type ECSError } from "../../utils/error";
import { pushCommand } from "../../../store";
import type { EntityID } from "../../entity";

type CellDef = ComponentDef<{ x: "i32"; heat: "i32" }>;
type ClockDef = ComponentDef<{ ms: "i32" }>;

interface Built {
	world: ECS;
	Cell: CellDef;
	Clock: ClockDef;
	commands: HostCommandQueue;
}

/** The single entity matching `def` (the tests' queries hold exactly one), or
 * `undefined` if none. */
function firstEntity(world: ECS, def: ComponentDef): EntityID | undefined {
	let found: EntityID | undefined;
	world.query(def).forEach((arch) => {
		if (found === undefined && arch.entityCount > 0) found = arch.entityIds[0];
	});
	return found;
}

/**
 * A world built identically for record and for replay: a `Cell` data component, a
 * `Clock` whose `ms` a dt-driven UPDATE system advances by `round(dt*1000)` each
 * tick, the write seam, and (optionally) a recorder. Registration order is fixed
 * so branded ids line up across the two worlds — the contract replay rests on.
 */
function buildWorld(recorder?: HostCommandSink): Built {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	const Clock = world.registerComponent({ ms: "i32" }) as ClockDef;
	const commands = installHostCommandSeam(world, recorder ? { recorder } : undefined);
	// A system whose output depends on dt: if dt weren't recorded + replayed, the
	// clock would diverge even with an identical command stream.
	const clocks = world.query(Clock);
	const tickClock = world.registerSystem({
		name: "clock_tick",
		reads: [],
		writes: [Clock],
		fn: (ctx, dt) => {
			const step = Math.round(dt * 1000);
			if (step === 0) return;
			clocks.forEach((arch) => {
				const ids = arch.entityIds;
				for (let i = 0; i < arch.entityCount; i++) {
					ctx.updateField(ids[i], Clock, "ms", (v) => v + step);
				}
			});
		}
	});
	world.addSystems(SCHEDULE.UPDATE, tickClock);
	return { world, Cell, Clock, commands };
}

/** The dts each tick of the scripted session runs with — deliberately varied so
 * the clock's per-tick step (`round(dt*1000)`) differs every tick. */
const TICK_DTS = [1 / 60, 1 / 30, 1 / 60, 1 / 120, 1 / 60] as const;
const EXPECTED_CLOCK_MS = TICK_DTS.reduce((sum, dt) => sum + Math.round(dt * 1000), 0); // 92

/**
 * Run the scripted session against a freshly-built recording world, capturing
 * the per-tick `stateHash`. Exercises the full vocabulary across startup +
 * five ticks (including an empty tick where only the clock advances).
 */
function recordSession(): { recorder: HostCommandRecorder; hashes: number[] } {
	const recorder = new HostCommandRecorder(1234);
	const { world, Cell, Clock, commands } = buildWorld(recorder);

	// Seed-time edits (drain at PRE_STARTUP): a clock + a cell. The clock's id is
	// not needed (the clock system finds it by query); the cell's is, for later
	// commands that target it.
	let cellA: EntityID | undefined;
	commands.spawn([spawnEntry(Clock, { ms: 0 })]);
	commands.spawn([spawnEntry(Cell, { x: 1, heat: 1 })], (e) => (cellA = e));
	world.startup();

	const hashes: number[] = [];
	let cellB: EntityID | undefined;

	// tick 0 — set a field on the seed-time cell.
	commands.setField(cellA!, Cell, "x", 100);
	world.update(TICK_DTS[0]);
	hashes.push(world.snapshots.stateHash());

	// tick 1 — spawn a second cell.
	commands.spawn([spawnEntry(Cell, { x: 5, heat: 5 })], (e) => (cellB = e));
	world.update(TICK_DTS[1]);
	hashes.push(world.snapshots.stateHash());

	// tick 2 — mutate the new cell + disable the first.
	commands.setField(cellB!, Cell, "heat", 7);
	commands.disable(cellA!);
	world.update(TICK_DTS[2]);
	hashes.push(world.snapshots.stateHash());

	// tick 3 — NO commands: only the clock advances (proves dt drives state).
	world.update(TICK_DTS[3]);
	hashes.push(world.snapshots.stateHash());

	// tick 4 — re-enable the first, despawn the second.
	commands.enable(cellA!);
	commands.despawn(cellB!);
	world.update(TICK_DTS[4]);
	hashes.push(world.snapshots.stateHash());

	return { recorder, hashes };
}

describe("command log — recorder buckets startup vs ticks", () => {
	it("seed-time commands land in the startup bucket, frame commands in ticks", () => {
		const recorder = new HostCommandRecorder(7);
		const { world, Cell, commands } = buildWorld(recorder);

		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })]);
		world.startup();

		const afterStartup = recorder.log();
		expect(afterStartup.seed).toBe(7);
		expect(afterStartup.startup).toHaveLength(1);
		expect(afterStartup.startup[0].kind).toBe("spawn");
		expect(afterStartup.ticks).toHaveLength(0);

		commands.spawn([spawnEntry(Cell, { x: 2, heat: 0 })]);
		world.update(1 / 60);
		world.update(1 / 60); // empty tick

		const log = recorder.log();
		// Two update ticks recorded — even the second with no commands, so its dt
		// is captured for replay.
		expect(log.ticks).toHaveLength(2);
		expect(log.ticks[0].commands).toHaveLength(1);
		expect(log.ticks[1].commands).toHaveLength(0);
		expect(log.ticks[0].dt).toBeCloseTo(1 / 60);
		expect(log.ticks[0].tick).not.toBe(log.ticks[1].tick);
	});

	it("strips the non-serializable on_spawned callback at record time", () => {
		const recorder = new HostCommandRecorder();
		const { world, Cell, commands } = buildWorld(recorder);
		world.startup();

		let seen: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (seen = e));
		world.update(1 / 60);

		// onSpawned still fired on the live run...
		expect(seen).toBeDefined();
		// ...but the recorded command is plain data (no callback to serialize).
		const recorded = recorder.log().ticks[0].commands[0];
		expect(recorded.kind).toBe("spawn");
		if (recorded.kind === "spawn") {
			expect(recorded.onSpawned).toBeUndefined();
		}
	});
});

describe("command log — serialize ↔ deserialize round-trips", () => {
	it("a recorded log survives JSON serialize → deserialize unchanged", () => {
		const { recorder } = recordSession();
		const log = recorder.log();

		const restored = deserializeCommandLog(serializeCommandLog(log));

		// Lossless round-trip: re-serializing the restored log yields byte-identical
		// JSON. (Deep object-equality won't work — a `ComponentDef` is a callable, so
		// the reviver reconstructs a fresh def with the same id but a new identity;
		// the serialized form, which carries only the id, is the stable comparison.)
		expect(serializeCommandLog(restored)).toBe(serializeCommandLog(log));
		expect(restored.seed).toBe(log.seed);
		expect(restored.startup).toHaveLength(log.startup.length);
		expect(restored.ticks).toHaveLength(log.ticks.length);
		expect(restored.ticks[0].dt).toBe(log.ticks[0].dt);

		// Structural integrity the serialized-string comparison alone can't prove:
		// every def in the restored log is a real callable handle (not left as a raw
		// `{ [DEF_TAG]: id }` object), so replay can read `def.id` off it. The first
		// startup command is a `spawn`, whose entries each carry a def.
		const head = restored.startup[0];
		expect(head.kind).toBe("spawn");
		if (head.kind === "spawn") {
			for (const entry of head.components) {
				expect(typeof entry.def).toBe("function");
				expect(typeof entry.def.id).toBe("number");
			}
		}
	});

	// A serialized def is tagged in-band as `{ [DEF_TAG]: id }`. If a command's
	// *values* object owns a field whose name collides with that sentinel, the
	// reviver (which keys solely off the tag's presence) would silently rebuild the
	// values map into a `ComponentDef`, dropping the data. Field names are arbitrary
	// strings, so this is reachable — the serializer must refuse the collision
	// rather than emit a log that corrupts on parse.
	it("refuses to serialize a log whose values field name collides with the def tag", () => {
		const DEF_TAG = "__component_def";
		const Weird = makeComponentDef<{ [DEF_TAG]: "f64"; ok: "f64" }>(asComponentId(3));
		const log: CommandLog = {
			seed: 7,
			startup: [
				{
					kind: "add_component",
					eid: 1 as EntityID,
					def: Weird,
					values: { [DEF_TAG]: 42, ok: 5 }
				}
			],
			ticks: []
		};

		try {
			serializeCommandLog(log);
			expect.unreachable("serialize should have thrown on the tag collision");
		} catch (e) {
			const err = e as ECSError;
			expect(err.category).toBe(ECS_ERROR.COMMAND_LOG_TAG_COLLISION);
			expect(err.message).toContain(DEF_TAG);
		}
	});

	// The guard must not fire on a legitimate def: the `{ [DEF_TAG]: id }` objects
	// the replacer itself emits are not re-passed to it, so a normal log with defs
	// (and ordinary field names) still serializes and round-trips cleanly.
	it("still serializes a log whose values use ordinary field names", () => {
		const Pos = makeComponentDef<{ x: "f64"; y: "f64" }>(asComponentId(1));
		const log: CommandLog = {
			seed: 0,
			startup: [{ kind: "add_component", eid: 1 as EntityID, def: Pos, values: { x: 9, y: 8 } }],
			ticks: []
		};

		const restored = deserializeCommandLog(serializeCommandLog(log));
		const cmd = restored.startup[0];
		expect(cmd.kind).toBe("add_component");
		if (cmd.kind === "add_component") {
			expect(typeof cmd.def).toBe("function");
			expect(cmd.def.id).toBe(1);
			expect((cmd.values as Record<string, number>).x).toBe(9);
			expect((cmd.values as Record<string, number>).y).toBe(8);
		}
	});
});

describe("command log — replay reaches the same state", () => {
	it("replaying a deserialized log reproduces per-tick state_hash bit-for-bit", () => {
		const { recorder, hashes: original } = recordSession();

		// Persist → restore the log, then replay against a brand-new world.
		const log = deserializeCommandLog(serializeCommandLog(recorder.log()));
		const fresh = buildWorld(); // no recorder
		const result = replayCommandLog(fresh.world, fresh.commands, log);

		// Determinism opt-in: the per-tick hashes must match exactly.
		expect(result.stateHashes).toEqual(original);
		expect(result.ticks).toBe(TICK_DTS.length);
		expect(result.startupCommands).toBe(2);
	});

	it("reproduces concrete world state (clock value, surviving entities)", () => {
		const { recorder } = recordSession();
		const log = deserializeCommandLog(serializeCommandLog(recorder.log()));

		const fresh = buildWorld();
		replayCommandLog(fresh.world, fresh.commands, log);

		// The clock advanced by round(dt*1000) per tick — its final value pins that
		// every recorded dt was replayed (a wrong dt would change the sum).
		const clockId = firstEntity(fresh.world, fresh.Clock);
		expect(clockId).toBeDefined();
		expect(fresh.world.getField(clockId!, fresh.Clock, "ms")).toBe(EXPECTED_CLOCK_MS);

		// cellB was despawned in the last tick; cellA was re-enabled → one live Cell.
		expect(fresh.world.query(fresh.Cell).entityCount).toBe(1);
	});

	it("dt is a replayed input — tampering one tick's dt diverges the replay", () => {
		const { recorder, hashes: original } = recordSession();
		const log = deserializeCommandLog(serializeCommandLog(recorder.log()));

		// Double tick 0's dt: the command stream is untouched, but the clock's
		// tick-0 step doubles, so the hash from tick 0 onward must diverge.
		const tampered: CommandLog = {
			...log,
			ticks: log.ticks.map((t, i) => (i === 0 ? { ...t, dt: t.dt * 2 } : t))
		};

		const fresh = buildWorld();
		const result = replayCommandLog(fresh.world, fresh.commands, tampered);

		expect(result.stateHashes).not.toEqual(original);
		expect(result.stateHashes[0]).not.toBe(original[0]);
	});
});

describe("command log — both transports land in one log", () => {
	const OP_SET = 10;

	it("a ring-sourced command is recorded, and replays through the typed queue", () => {
		const recorder = new HostCommandRecorder(99);
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		const ring = new HostCommandDispatcher().onCommand(OP_SET, ringSetFieldCodec(Cell, "x"));
		const commands = installHostCommandSeam(world, { ring, recorder });
		world.startup();

		let cell: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (cell = e));
		world.update(1 / 60);

		// Mutate via the SAB ring (the cross-thread / wire transport).
		const buffer = world.columnStore;
		pushCommand(
			buffer.view,
			buffer.header.commandRingOff,
			OP_SET,
			ringSetFieldCodec(Cell, "x").encode({
				kind: "set_field",
				eid: cell!,
				def: Cell,
				field: "x",
				value: 55
			})
		);
		world.update(1 / 60);
		expect(world.getField(cell!, Cell, "x")).toBe(55);

		// The ring-sourced setField is in the SAME log as the typed-queue spawn.
		const log = recorder.log();
		const allTickCommands = log.ticks.flatMap((t) => t.commands);
		const ringSet = allTickCommands.find((c) => c.kind === "set_field");
		expect(ringSet?.kind).toBe("set_field");
		if (ringSet?.kind === "set_field") {
			expect(ringSet.value).toBe(55);
		}

		// Replay: ring-decoded commands re-apply through the typed queue (the log
		// holds decoded HostCommands — one vocabulary, transport-independent). A
		// replay world needs no ring.
		const replayLog = deserializeCommandLog(serializeCommandLog(log));
		const fresh = new ECS({ deterministic: true });
		const FreshCell = fresh.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		const freshQueue = installHostCommandSeam(fresh);
		const result = replayCommandLog(fresh, freshQueue, replayLog);

		const replayedCell = firstEntity(fresh, FreshCell);
		expect(replayedCell).toBeDefined();
		expect(fresh.getField(replayedCell!, FreshCell, "x")).toBe(55);
		expect(result.stateHashes).toHaveLength(2);
	});
});

describe("command log — replay without determinism", () => {
	let recorder: HostCommandRecorder;

	beforeEach(() => {
		recorder = new HostCommandRecorder();
	});

	it("reproduces state with hashing skipped when the world is non-deterministic", () => {
		// Record on a deterministic world (so we can serialize a real session)...
		const { world, Cell, commands } = buildWorld(recorder);
		world.startup();
		commands.spawn([spawnEntry(Cell, { x: 3, heat: 4 })]);
		world.update(1 / 60);
		const log = deserializeCommandLog(serializeCommandLog(recorder.log()));

		// ...but replay into a NON-deterministic world. stateHash would throw, so
		// the driver skips it (hash defaults to the world's `deterministic` flag).
		const fresh = new ECS(); // deterministic: false (default)
		const FreshCell = fresh.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		const freshQueue = installHostCommandSeam(fresh);
		const result = replayCommandLog(fresh, freshQueue, log);

		expect(result.stateHashes).toHaveLength(0);
		// State is still reproduced — replay doesn't depend on hashing.
		const cell = firstEntity(fresh, FreshCell);
		expect(fresh.getField(cell!, FreshCell, "x")).toBe(3);
		expect(fresh.getField(cell!, FreshCell, "heat")).toBe(4);
	});
});
