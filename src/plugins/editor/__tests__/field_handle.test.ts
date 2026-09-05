/**
 * Inspector field handle, the two-way loop closes end to end.
 *
 * The handle reads `Cell.x` through a caller-supplied channel thunk and writes
 * through the {@link Editor}, which enqueues a `setField` host command on the
 * bus. Asserts what the handle owns: the value comes from the thunk, `set`
 * enqueues off-schedule and lands at the next tick, `pending` echoes the
 * uncommitted value, and the edit is undoable. Real engine, nothing mocked.
 */
import { describe, expect, it } from "vitest";
import { ECS, installHostCommandSeam, spawnEntry } from "../../../core/ecs";
import type { ComponentDef, EntityID } from "../../../core/ecs";
import { Editor } from "../editor";
import { fieldHandle } from "../field_handle";

type CellDef = ComponentDef<{ x: "i32"; heat: "i32" }>;

function setup() {
	const world = new ECS({ deterministic: true });
	const Cell = world.registerComponent({ x: "i32", heat: "i32" }) as CellDef;
	const commands = installHostCommandSeam(world);
	const editor = new Editor(commands, (eid, def, field) =>
		world.isAlive(eid) ? world.getField(eid, def, field) : undefined
	);
	world.startup();
	return { world, Cell, editor };
}

describe("fieldHandle, two-way feel over a read channel", () => {
	it("value reflects the channel; set enqueues an undoable SetField; the loop closes", () => {
		const { world, Cell, editor } = setup();

		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 10, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);
		expect(id).toBeDefined();

		// The read channel, a thunk over committed state. The handle never
		// imports one, so a plain world read stands in for any live view.
		const channel = (): number | undefined =>
			world.isAlive(id!) ? world.getField(id!, Cell, "x") : undefined;
		const handle = fieldHandle(editor, id!, Cell, "x", channel);
		expect(handle.value).toBe(10);

		// set() enqueues a SetField, off-schedule, so the channel is untouched
		// until the tick drains the bus. The editor shadow gives an optimistic echo.
		handle.set(25);
		expect(handle.pending).toBe(25);
		expect(channel()).toBe(10);

		world.update(1 / 60);
		expect(handle.value).toBe(25);

		// The edit is undoable: undo enqueues the inverse on the same bus.
		expect(editor.undo()).toBe(true);
		world.update(1 / 60);
		expect(handle.value).toBe(10);
	});

	it("set routes through the editor undo stack, not a raw queue write", () => {
		const { world, Cell, editor } = setup();
		let id: EntityID | undefined;
		editor.spawn([spawnEntry(Cell, { x: 0, heat: 0 })], (e) => (id = e));
		world.update(1 / 60);
		expect(editor.depths().undo).toBe(1); // only the spawn

		const handle = fieldHandle(editor, id!, Cell, "x", () =>
			world.isAlive(id!) ? world.getField(id!, Cell, "x") : undefined
		);
		handle.set(7);
		expect(editor.depths().undo).toBe(2); // + the field edit, so it is undoable
	});
});
