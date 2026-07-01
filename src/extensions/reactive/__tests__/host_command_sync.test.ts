/**
 * Host → ECS write seam (#681) × reactive read bridge (ADR-0022) — the loop
 * closes. The write seam funnels host commands into the SAME deferred flush and
 * observers the read bridge already drains, so a frame's worth of host writes
 * surfaces through the existing change detection as ONE coalesced commit.
 *
 * This is the end-to-end version of the write-seam prototype's claim 3, on the real
 * engine: enqueue off-schedule → drain at the schedule head → reactiveMap update
 * → one batched UI commit per tick.
 */
import { describe, expect, it } from "vitest";
import { effect, root } from "../../../core/reactive";
import {
	ECS,
	installHostCommandSeam,
	spawnEntry,
	HostCommandDispatcher,
	ringDespawnCodec,
	type ComponentDef,
	type EntityID
} from "../../../core/ecs";
import { pushCommand } from "../../../core/store";
import { batchedUpdate, shallow, syncComponentToMap } from "../ecs_sync";

type CellDef = ComponentDef<{ x: "i32"; heat: "i32" }>;

function makeWorld() {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	const commands = installHostCommandSeam(world);
	const sync = syncComponentToMap(
		world,
		Cell,
		(r) => ({ x: r.field("x"), heat: r.field("heat") }),
		{
			grain: "entity",
			eq: shallow
		}
	);
	world.startup();
	return { world, Cell, commands, sync };
}

describe("host command seam → reactive read bridge", () => {
	it("host-spawned entities surface in the reactiveMap after the tick", () => {
		const { world, Cell, commands, sync } = makeWorld();
		let id: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));

		// Off-schedule enqueue: the map is untouched until the tick drains it.
		expect(sync.map.size()).toBe(0);

		batchedUpdate(world, 1 / 60);
		expect(id).toBeDefined();
		expect(sync.map.size()).toBe(1);
		expect(sync.map.get(id!)).toEqual({ x: 10, heat: 0 });
	});

	it("a frame of host commands coalesces into ONE UI commit", () => {
		const { world, Cell, commands, sync } = makeWorld();

		// A coarse reader that re-reads the whole map — under batchedUpdate it
		// fires at most once per tick no matter how many entities changed.
		let commits = 0;
		root(() => {
			effect(() => {
				const keys = sync.map.keys();
				for (let i = 0; i < keys.length; i++) sync.map.get(keys[i]);
				commits++;
			});
		});
		commits = 0; // discard the mount run

		// Five host spawns in one frame.
		for (let i = 0; i < 5; i++) commands.spawn([spawnEntry(Cell, { x: i, heat: 0 })]);
		batchedUpdate(world, 1 / 60);

		expect(sync.map.size()).toBe(5);
		expect(commits).toBe(1); // one coalesced commit, not five
	});

	it("a quiet tick (no host commands, no writes) commits nothing", () => {
		const { world, Cell, commands, sync } = makeWorld();
		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })]);
		batchedUpdate(world, 1 / 60); // settle the spawn

		let commits = 0;
		root(() => {
			effect(() => {
				const keys = sync.map.keys();
				for (let i = 0; i < keys.length; i++) sync.map.get(keys[i]);
				commits++;
			});
		});
		commits = 0;

		batchedUpdate(world, 1 / 60); // nothing enqueued, no systems writing
		expect(commits).toBe(0);
	});
});

describe("host command SAB-ring transport → reactive read bridge (#700)", () => {
	const OP_DESPAWN = 11;

	it("a ring-sourced despawn fires the observers the bridge drains (entity leaves the map)", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
		// The apply system drains the SAB ring too; bind the despawn codec.
		const ring = new HostCommandDispatcher().onCommand(OP_DESPAWN, ringDespawnCodec());
		const commands = installHostCommandSeam(world, { ring });
		const sync = syncComponentToMap(
			world,
			Cell,
			(r) => ({ x: r.field("x"), heat: r.field("heat") }),
			{
				grain: "entity",
				eq: shallow
			}
		);
		world.startup();

		// Seed one entity through the typed transport so it's in the reactiveMap.
		let id: EntityID | undefined;
		commands.spawn([spawnEntry(Cell, { x: 1, heat: 0 })], (e) => (id = e));
		batchedUpdate(world, 1 / 60);
		expect(sync.map.size()).toBe(1);

		// Despawn it via the OTHER transport — opaque bytes on the SAB ring. The
		// structural change must route through the same deferred flush + ADR-0013
		// observers the read bridge drains, so the entity leaves the map.
		const sab = world.columnStore;
		pushCommand(
			sab.view,
			sab.header.commandRingOff,
			OP_DESPAWN,
			ringDespawnCodec().encode({ kind: "despawn", eid: id! })
		);
		batchedUpdate(world, 1 / 60);

		expect(sync.map.size()).toBe(0);
		expect(sync.map.get(id!)).toBeUndefined();
	});
});
