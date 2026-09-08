/**
 * The rest of the write seam: the three ring codecs the other tests never
 * decode, the dispatcher's unbind, the queue's discard, and the teardown.
 *
 * `ringDisableCodec`, `ringEnableCodec` and `ringRemoveComponentCodec` are
 * exported through `@oasys/oecs/internal`, and until now the only test that
 * named them compared export lists. A codec that decoded to the wrong `kind`,
 * or read the entity id from the wrong offset, would have shipped. Each test
 * below drives one through the real SAB ring and reads the effect on the world,
 * which is the property a consumer depends on.
 *
 * `off`, `clear` and `uninstallHostCommandSeam` are the undo half of the seam.
 * Nothing exercised them either.
 */

import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../../component";
import { ECS } from "../../ecs";
import { createEntityId } from "../../entity";
import {
	HostCommandDispatcher,
	installHostCommandSeam,
	ringDespawnCodec,
	ringDisableCodec,
	ringEnableCodec,
	ringRemoveComponentCodec,
	uninstallHostCommandSeam
} from "../../host_commands";
import { SCHEDULE } from "../../phase";
import { pushCommand } from "../../../store";

type CellDef = ComponentDef<{ x: "i32" }>;

// Consumer-chosen opcodes. Zero marks an empty slot, so these start above it.
const OP_DISABLE = 20;
const OP_ENABLE = 21;
const OP_REMOVE = 22;
const OP_DESPAWN = 23;

/** Write one 15-byte payload carrying `eid` into the world's command ring. */
function pushEid(world: ECS, op: number, eid: number): void {
	const payload = new Uint8Array(15);
	new DataView(payload.buffer).setUint32(0, eid, true);
	const store = world.columnStore;
	pushCommand(store.view, store.header.commandRingOff, op, payload);
}

describe("the entity-id ring codecs", () => {
	it("disable and enable round trip through the ring and reach the world", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		const ring = new HostCommandDispatcher()
			.onCommand(OP_DISABLE, ringDisableCodec())
			.onCommand(OP_ENABLE, ringEnableCodec());
		installHostCommandSeam(world, { ring });
		const e = world.spawn();
		world.addComponent(e, Cell, { x: 1 });
		world.startup();

		pushEid(world, OP_DISABLE, Number(e));
		world.update(1 / 60);
		expect(world.isDisabled(e)).toBe(true);

		pushEid(world, OP_ENABLE, Number(e));
		world.update(1 / 60);
		expect(world.isDisabled(e)).toBe(false);
	});

	it("remove_component carries the def bound into the codec, not the payload", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		const Other = world.registerComponent({ y: "i32" });
		// The codec binds `Cell`. The 15 bytes carry the entity id alone, so the
		// component a slot removes is fixed at bind time.
		const ring = new HostCommandDispatcher().onCommand(OP_REMOVE, ringRemoveComponentCodec(Cell));
		installHostCommandSeam(world, { ring });
		const e = world.spawn();
		world.addComponent(e, Cell, { x: 1 });
		world.addComponent(e, Other, { y: 2 });
		world.startup();

		pushEid(world, OP_REMOVE, Number(e));
		world.update(1 / 60);
		expect(world.hasComponent(e, Cell)).toBe(false);
		expect(world.hasComponent(e, Other)).toBe(true);
	});

	it("packs the entity id as a u32 LE at offset zero, and zeroes the rest", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		// gen 0x10 << 20 | index 0x20304 = 0x01020304, so the LE bytes read back
		// in an order a wrong offset cannot imitate. The three codecs share one
		// `encodeEid` helper on both sides, so a round trip alone would agree
		// with itself at any offset. These bytes are the independent check.
		const eid = createEntityId(0x20304, 0x10);
		const golden = [0x04, 0x03, 0x02, 0x01, ...new Array<number>(11).fill(0)];

		expect(Array.from(ringDisableCodec().encode({ kind: "disable", eid }))).toEqual(golden);
		expect(Array.from(ringEnableCodec().encode({ kind: "enable", eid }))).toEqual(golden);
		expect(
			Array.from(
				ringRemoveComponentCodec(Cell).encode({ kind: "remove_component", eid, def: Cell })
			)
		).toEqual(golden);

		// Decode reads the same offset back. A payload built by hand, not by
		// this module's own encoder.
		const payload = new Uint8Array(golden);
		expect(ringDisableCodec().decode(payload)).toEqual({ kind: "disable", eid });
		expect(ringEnableCodec().decode(payload)).toEqual({ kind: "enable", eid });
		expect(ringRemoveComponentCodec(Cell).decode(payload)).toEqual({
			kind: "remove_component",
			eid,
			def: Cell
		});
	});

	it("each codec refuses to encode a command of another kind", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		const e = world.spawn();
		const wrong = { kind: "despawn", eid: e } as const;
		expect(() => ringDisableCodec().encode(wrong)).toThrow(/disable/);
		expect(() => ringEnableCodec().encode(wrong)).toThrow(/enable/);
		expect(() => ringRemoveComponentCodec(Cell).encode(wrong)).toThrow(/remove_component/);
	});
});

describe("HostCommandDispatcher.off", () => {
	it("unbinds an opcode, and reports whether a binding was there", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		const ring = new HostCommandDispatcher().onCommand(OP_DESPAWN, ringDespawnCodec());
		installHostCommandSeam(world, { ring });
		const kept = world.spawn();
		world.addComponent(kept, Cell, { x: 1 });
		world.startup();

		expect(ring.off(OP_DESPAWN)).toBe(true);
		expect(ring.off(OP_DESPAWN)).toBe(false); // already gone

		// An unbound opcode is skipped, and the read head still advances, so the
		// entity survives and the ring does not stall.
		pushEid(world, OP_DESPAWN, Number(kept));
		world.update(1 / 60);
		expect(world.isAlive(kept)).toBe(true);

		// Re-binding restores the effect through the same ring.
		ring.onCommand(OP_DESPAWN, ringDespawnCodec());
		pushEid(world, OP_DESPAWN, Number(kept));
		world.update(1 / 60);
		expect(world.isAlive(kept)).toBe(false);
	});
});

describe("HostCommandQueue.clear and uninstallHostCommandSeam", () => {
	it("clear drops the buffered commands and reports the count", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		const commands = installHostCommandSeam(world);
		const e = world.spawn();
		world.addComponent(e, Cell, { x: 1 });
		world.startup();

		commands.setField(e, Cell, "x", 9).despawn(e);
		expect(commands.pendingCount).toBe(2);
		expect(commands.clear()).toBe(2);
		expect(commands.pendingCount).toBe(0);
		expect(commands.clear()).toBe(0);

		world.update(1 / 60);
		expect(world.getField(e, Cell, "x")).toBe(1); // nothing was applied
		expect(world.isAlive(e)).toBe(true);
	});

	it("uninstall removes the apply systems, and refuses a queue it did not make", () => {
		const world = new ECS({ deterministic: true });
		const Cell = world.registerComponent({ x: "i32" }) as CellDef;
		const commands = installHostCommandSeam(world, { schedules: [SCHEDULE.PRE_UPDATE] });
		const e = world.spawn();
		world.addComponent(e, Cell, { x: 1 });
		world.startup();

		commands.setField(e, Cell, "x", 5);
		world.update(1 / 60);
		expect(world.getField(e, Cell, "x")).toBe(5);

		// Uninstall drops the still-buffered command as well as the systems.
		commands.setField(e, Cell, "x", 7);
		expect(uninstallHostCommandSeam(world, commands)).toBe(true);
		expect(commands.pendingCount).toBe(0);

		// The queue still buffers, but nothing drains it any more.
		commands.setField(e, Cell, "x", 8);
		world.update(1 / 60);
		expect(world.getField(e, Cell, "x")).toBe(5);
		expect(commands.pendingCount).toBe(1);

		// A second uninstall, and a queue from no seam at all, both report false.
		expect(uninstallHostCommandSeam(world, commands)).toBe(false);
	});
});
