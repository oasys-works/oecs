/**
 * Inspector field-handle × the REAL reactive read bridge — the two-way
 * loop closes end-to-end.
 *
 * The handle reads `Cell.x` through `syncFieldsToMap`'s `reactiveMap` (the read
 * channel) and writes through the {@link Editor} (a `setField` host command on
 * the bus). Asserts the acceptance criteria: reading reflects the channel, `set`
 * enqueues a `SetField` (off-schedule, applied at the next tick), the channel
 * re-publishes the new value, and the edit is undoable — all on the real engine,
 * nothing mocked.
 */
import { describe, expect, it } from "vitest";
import { effect, root } from "../../../reactive";
import { ECS, installHostCommandSeam, spawnEntry } from "../../../core/ecs";
import type { ComponentDef, EntityID } from "../../../core/ecs";
import { batchedUpdate, syncFieldsToMap } from "../../reactive";
import { Editor } from "../editor";
import { fieldHandle } from "../field_handle";

type CellDef = ComponentDef<{ x: "i32"; heat: "i32" }>;

function setup() {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	const commands = installHostCommandSeam(world);
	// The REAL read channel: component observers → reactiveMap, per-entity.
	const sync = syncFieldsToMap(world, Cell, ["x", "heat"]);
	const editor = new Editor(commands, (eid, def, field) =>
		world.isAlive(eid) ? world.getField(eid, def, field) : undefined
	);
	world.startup();
	return { world, Cell, sync, editor };
}

describe("fieldHandle — two-way feel over the reactive read bridge", () => {
	it("value reflects the channel; set enqueues an undoable SetField; the loop closes", () => {
		const { world, Cell, sync, editor } = setup();

		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));
		batchedUpdate(world, 1 / 60);
		expect(id).toBeDefined();

		const handle = fieldHandle(editor, id!, Cell, "x", () => sync.map.get(id!)?.x);

		// A reader tracking the handle's value through the per-entity channel.
		const seen: (number | undefined)[] = [];
		const last = (): number | undefined => seen[seen.length - 1];
		root(() => effect(() => seen.push(handle.value)));
		expect(last()).toBe(10); // reading reflects the reactive channel

		// set() enqueues a SetField — off-schedule, so the channel is untouched
		// until the tick drains the bus. The editor shadow gives an optimistic echo.
		handle.set(25);
		expect(handle.pending).toBe(25);
		expect(sync.map.get(id!)?.x).toBe(10);

		batchedUpdate(world, 1 / 60);
		expect(last()).toBe(25); // channel re-published → handle.value tracks it

		// The edit is undoable: undo enqueues the inverse on the same bus.
		expect(editor.undo()).toBe(true);
		batchedUpdate(world, 1 / 60);
		expect(last()).toBe(10);
	});

	it("set routes through the editor undo stack, not a raw queue write", () => {
		const { world, Cell, sync, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (id = e));
		batchedUpdate(world, 1 / 60);
		expect(editor.depths().undo).toBe(1); // just the spawn

		const handle = fieldHandle(editor, id!, Cell, "x", () => sync.map.get(id!)?.x);
		handle.set(7);
		expect(editor.depths().undo).toBe(2); // + the field edit, so it is undoable
	});
});
