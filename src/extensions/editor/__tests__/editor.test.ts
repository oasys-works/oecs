/**
 * Editor layer (#701) — reified undo/redo over the typed `HostCommandQueue`.
 *
 * Asserts the properties the issue's acceptance criteria name, against the REAL
 * engine (real `installHostCommandSeam`, real deferred flush):
 *   - undo/redo enqueue the inverse/forward on the SAME bus (applied at the next
 *     schedule head), never a direct mutation;
 *   - spawn → edit → edit → undo×N walks state back, then undo removes the spawn
 *     (the spawn inverse is finalized in `onSpawned`);
 *   - setField and despawn round-trip (despawn restores DATA under a new id, and
 *     redo removes the respawned entity, not the dead original);
 *   - the full vocabulary (add/remove component, disable/enable) round-trips;
 *   - a transaction groups several actions into one undo entry.
 */
import { describe, expect, it } from "vitest";
import { ECS, installHostCommandSeam, spawnEntry } from "../../../core/ecs";
import type { ComponentDef, EntityID } from "../../../core/ecs";
import { Editor, type FieldReader } from "../editor";

type CellDef = ComponentDef<{ x: "i32"; heat: "i32" }>;
type VelDef = ComponentDef<{ vx: "i32" }>;

/** Read committed state straight from the world (the stand-in for the read
 * channel in these core tests); `undefined` for a missing slot so the editor
 * falls back to `0`. */
function makeReader(world: ECS): FieldReader {
	return (eid, def, field) => (world.isAlive(eid) ? world.getField(eid, def, field) : undefined);
}

function setup(): { world: ECS; Cell: CellDef; editor: Editor } {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	const commands = installHostCommandSeam(world);
	const editor = new Editor(commands, makeReader(world));
	world.startup();
	return { world, Cell, editor };
}

/** The single live Cell's id (tests that recreate an entity lose the old id). */
function onlyCell(world: ECS, Cell: CellDef): EntityID {
	const ids: EntityID[] = [];
	world.query(Cell).forEachEntity((e) => ids.push(e));
	expect(ids.length).toBe(1);
	return ids[0];
}

describe("Editor — spawn → edit → edit → undo×N (the acceptance walk-back)", () => {
	it("undo walks state back, then removes the spawn; undo on an empty stack is a no-op", () => {
		const { world, Cell, editor } = setup();

		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));
		// Enqueue defers: nothing exists until the tick drains the bus.
		expect(world.query(Cell).count()).toBe(0);
		world.update(1 / 60);
		expect(id).toBeDefined();
		expect(world.getField(id!, Cell, "x")).toBe(10);

		editor.setField(id!, Cell, "x", 11);
		editor.setField(id!, Cell, "x", 12);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(12);
		expect(editor.depths()).toEqual({ undo: 3, redo: 0 });

		expect(editor.undo()).toBe(true); // x: 12 → 11
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(11);

		expect(editor.undo()).toBe(true); // x: 11 → 10
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(10);

		expect(world.query(Cell).count()).toBe(1);
		expect(editor.undo()).toBe(true); // undo the spawn → despawn the created id
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(0);
		expect(world.isAlive(id!)).toBe(false);

		expect(editor.undo()).toBe(false); // nothing left
		expect(editor.depths()).toEqual({ undo: 0, redo: 3 });
	});
});

describe("Editor — set_field undo/redo round-trips", () => {
	it("redo re-applies the edit, undo reverts it again", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);

		editor.setField(id!, Cell, "x", 20);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(20);

		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(10);

		expect(editor.redo()).toBe(true);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(20);

		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(10);
	});

	it("a fresh action after an undo clears the redo stack", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);

		editor.setField(id!, Cell, "x", 1);
		editor.undo();
		expect(editor.depths().redo).toBe(1);
		editor.setField(id!, Cell, "x", 2); // new branch
		expect(editor.depths().redo).toBe(0);
	});
});

describe("Editor — despawn undo/redo (data round-trips, identity does not)", () => {
	it("undo respawns the captured data; redo removes the RESPAWNED entity", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 5, heat: 3 })], (e) => (id = e));
		world.update(1 / 60);

		// Capture the entity's data, then despawn it.
		const restore = [
			spawnEntry(Cell, {
				x: world.getField(id!, Cell, "x"),
				heat: world.getField(id!, Cell, "heat")
			})
		];
		editor.despawn(id!, restore);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(0);
		expect(world.isAlive(id!)).toBe(false);

		// Undo: respawns the data (under a NEW id — identity is not preserved).
		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(1);
		const respawned = onlyCell(world, Cell);
		expect(respawned).not.toBe(id!);
		expect(world.getField(respawned, Cell, "x")).toBe(5);
		expect(world.getField(respawned, Cell, "heat")).toBe(3);

		// Redo: removes the RESPAWNED entity (the forward despawn was rewritten to
		// the new id by the respawn's onSpawned), not the dead original.
		expect(editor.redo()).toBe(true);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(0);
		expect(world.isAlive(respawned)).toBe(false);
	});
});

describe("Editor — add/remove component round-trips", () => {
	it("add_component undo removes it; redo re-adds; remove_component undo restores values", () => {
		const { world, Cell, editor } = setup();
		const Vel = world.registerComponent({ vx: "i32" }) as VelDef;
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);

		editor.addComponent(id!, Vel, { vx: 7 });
		world.update(1 / 60);
		expect(world.hasComponent(id!, Vel)).toBe(true);
		expect(world.getField(id!, Vel, "vx")).toBe(7);

		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.hasComponent(id!, Vel)).toBe(false);

		expect(editor.redo()).toBe(true);
		world.update(1 / 60);
		expect(world.hasComponent(id!, Vel)).toBe(true);
		expect(world.getField(id!, Vel, "vx")).toBe(7);

		// removeComponent carries the values to restore on undo.
		editor.removeComponent(id!, Vel, { vx: 7 });
		world.update(1 / 60);
		expect(world.hasComponent(id!, Vel)).toBe(false);

		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.hasComponent(id!, Vel)).toBe(true);
		expect(world.getField(id!, Vel, "vx")).toBe(7);
	});
});

describe("Editor — disable/enable round-trips", () => {
	it("disable undo re-enables (the entity returns to the default query)", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(1);

		editor.disable(id!);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(0);

		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(1);

		expect(editor.redo()).toBe(true);
		world.update(1 / 60);
		expect(world.query(Cell).count()).toBe(0);
	});
});

describe("Editor — transaction grouping", () => {
	it("a grouped transaction undoes as ONE entry", () => {
		const { world, Cell, editor } = setup();
		// Two entities to edit together.
		let a: EntityID | undefined;
		let b: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 1, heat: 0 })], (e) => (a = e));
		editor.spawn([spawnEntry(Cell, { x: 2, heat: 0 })], (e) => (b = e));
		world.update(1 / 60);

		editor.transaction((tx) => {
			tx.setField(a!, Cell, "x", 100);
			tx.setField(b!, Cell, "x", 200);
		});
		world.update(1 / 60);
		expect(world.getField(a!, Cell, "x")).toBe(100);
		expect(world.getField(b!, Cell, "x")).toBe(200);
		// Two spawns + one grouped edit = 3 undo entries (not 4).
		expect(editor.depths().undo).toBe(3);

		// One undo reverts BOTH field writes.
		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(world.getField(a!, Cell, "x")).toBe(1);
		expect(world.getField(b!, Cell, "x")).toBe(2);
	});
});

describe("Editor — more than one undo/redo per frame (the stale-id regression, #719)", () => {
	it("a respawn + a despawn enqueued before the same world.update do not crash and leave consistent state", () => {
		const { world, Cell, editor } = setup();

		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));
		world.update(1 / 60); // apply the spawn → `id` is the original live entity
		expect(world.isAlive(id!)).toBe(true);

		editor.undo(); // enqueue the spawn's inverse despawn (targets `id`)
		world.update(1 / 60); // apply it → `id` is dead, the cell is gone
		expect(world.query(Cell).count()).toBe(0);
		expect(world.isAlive(id!)).toBe(false);

		// Two more editor actions BEFORE the next world.update — the multi-undo/redo-
		// per-frame sequence #719 regressed on. redo re-enqueues the spawn (respawns
		// under a NEW id once it applies); the immediately-following undo re-enqueues
		// the SAME stable inverse-despawn object by reference. Pre-fix, the redo's
		// `onSpawned` REPLACED the inverse slot with a fresh object, so this already-
		// enqueued despawn still pointed at the dead original `id` → ENTITY_NOT_ALIVE
		// when the queue drained. With the stable-object fix, the respawn's `onSpawned`
		// (which runs earlier in the same drain) mutates that object's `eid` in place,
		// so the despawn resolves to the live respawned entity at apply time.
		editor.redo(); // enqueue the respawn — do NOT update
		editor.undo(); // enqueue the despawn while the respawn is still pending

		// The drain applies the respawn then the despawn, both in one tick.
		expect(() => world.update(1 / 60)).not.toThrow();

		// Net state is consistent: the respawned entity got despawned, nothing leaked,
		// and the dead original was never resurrected.
		expect(world.query(Cell).count()).toBe(0);
		expect(world.isAlive(id!)).toBe(false);
	});
});

describe("Editor — undo is just another command on the bus", () => {
	it("undo defers like any write: it mutates nothing until the next tick drains it", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 9, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);

		editor.setField(id!, Cell, "x", 42);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(42);

		editor.undo();
		// The inverse is enqueued, NOT applied — the world is untouched until the tick.
		expect(world.getField(id!, Cell, "x")).toBe(42);
		world.update(1 / 60);
		expect(world.getField(id!, Cell, "x")).toBe(9);
	});
});

describe("Editor — an empty transaction is a no-op", () => {
	it("records no undo entry and does not wipe the redo stack", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);

		// Build up some redo history: edit, then undo it.
		editor.setField(id!, Cell, "x", 5);
		editor.undo();
		expect(editor.depths()).toEqual({ undo: 1, redo: 1 }); // spawn left; the edit is redoable

		// An empty transaction touches nothing — no phantom undo entry, redo intact.
		editor.transaction(() => {});
		expect(editor.depths()).toEqual({ undo: 1, redo: 1 });
		// And there is no phantom edit to "undo".
		expect(editor.undo()).toBe(true); // undoes the spawn (the only real entry)
		expect(editor.depths().undo).toBe(0);
	});
});

describe("Editor — pending_field self-resolves once the channel catches up", () => {
	it("returns the edit before commit, then undefined after; an external write is not shadowed", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);

		editor.setField(id!, Cell, "x", 25);
		// Before the commit, the channel still reads 10, so pending echoes the edit.
		expect(editor.pendingField(id!, Cell, "x")).toBe(25);

		world.update(1 / 60); // commit lands: channel reads 25
		// Reconcile-on-read: the edit landed, so pending resolves to undefined.
		expect(editor.pendingField(id!, Cell, "x")).toBeUndefined();

		// A later external write must NOT be shadowed by a stale pending value.
		world.setField(id!, Cell, "x", 30);
		expect(editor.pendingField(id!, Cell, "x")).toBeUndefined();
	});
});

describe("Editor — onChange / canUndo / canRedo (M10)", () => {
	it("fires on commit, undo, redo, clear; unsubscribe stops it", () => {
		const { world, Cell, editor } = setup();
		let fires = 0;
		const off = editor.onChange(() => {
			fires++;
		});

		expect(editor.canUndo).toBe(false);
		expect(editor.canRedo).toBe(false);

		editor.spawn([spawnEntry(Cell, { x: 1, heat: 0 })]);
		world.update(0.016);
		expect(fires).toBe(1);
		expect(editor.canUndo).toBe(true);

		editor.undo();
		world.update(0.016);
		expect(fires).toBe(2);
		expect(editor.canRedo).toBe(true);

		editor.redo();
		world.update(0.016);
		expect(fires).toBe(3);

		editor.clear();
		expect(fires).toBe(4);
		expect(editor.canUndo).toBe(false);
		expect(editor.canRedo).toBe(false);

		off();
		editor.spawn([spawnEntry(Cell, { x: 2, heat: 0 })]);
		expect(fires).toBe(4);
	});
});
