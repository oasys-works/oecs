/**
 * The four mechanism regions survive a realloc, with their capacity and their
 * live bytes.
 *
 * `store_regions.ts` collapsed four hand-mirrored enumerations into one list
 * for a reason its own header states: a missed entry silently dropped a
 * region's live state across a grow. The `sizeFromOptions` and `init` halves
 * of each entry run whenever a store is created, so every earlier test covered
 * them. The `regionBytes` and `readOptions` halves run only on the realloc
 * path, and nothing reached them.
 *
 * The test pushes distinguishable bytes into each ring, moves the entity
 * index off its initial length, then grows past the current capacity so the
 * allocator hands back a new buffer. What comes back must carry every region.
 */

import { describe, expect, it } from "vitest";
import {
	createColumnStore,
	readStoreHeader,
	TYPE_TAG,
	type ArchetypeSpec
} from "..";
import {
	actionRingCapacitySlots,
	pendingActionCount,
	popAction,
	pushAction
} from "../action_ring";
import {
	commandRingCapacitySlots,
	pendingCommandCount,
	popCommand,
	pushCommand
} from "../command_ring";
import {
	entityIndexCapacity,
	entityIndexLength,
	setEntityIndexLength
} from "../entity_index";
import { eventRingCapacitySlots, pendingEventCount, popEvent, pushEvent } from "../event_ring";
import { growColumnStore } from "../grow";

const SPEC: ArchetypeSpec = {
	archetypeId: 0,
	componentMask: [1, 0, 0, 0],
	rowCapacity: 4,
	columns: [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }]
};

const REGIONS = {
	commandRingCapacitySlots: 16,
	entityIndexCapacity: 8,
	eventRingCapacitySlots: 32,
	actionRingCapacitySlots: 64
};

/** A 15-byte payload whose first byte is `mark`, so a slot that survives the
 * realloc is distinguishable from a zero-filled one. */
function payload(mark: number): Uint8Array {
	const p = new Uint8Array(15);
	p[0] = mark;
	return p;
}

describe("the mechanism regions across a realloc", () => {
	it("carries every region's capacity and live bytes into the new buffer", () => {
		const old = createColumnStore([SPEC], undefined, REGIONS);
		const h = readStoreHeader(old.view);
		expect(h.commandRingOff).toBeGreaterThan(0);
		expect(h.entityIndexOff).toBeGreaterThan(0);
		expect(h.eventRingOff).toBeGreaterThan(0);
		expect(h.actionRingOff).toBeGreaterThan(0);

		pushCommand(old.view, h.commandRingOff, 1, payload(0xc1));
		pushEvent(old.view, h.eventRingOff, 2, payload(0xe1));
		pushAction(old.view, h.actionRingOff, payload(0xa1));
		setEntityIndexLength(old.view, h.entityIndexOff, 5);

		// Past the current row capacity, so the allocator reallocates rather
		// than extending in place. That is the path that reads each region back
		// out and writes it into the new buffer.
		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 64, rowCount: 0 }]
		});
		expect(next.buffer).not.toBe(old.buffer);

		const n = readStoreHeader(next.view);
		// Every capacity read itself back out. A dropped `readOptions` entry
		// would recreate the region at zero, or drop it entirely.
		expect(commandRingCapacitySlots(next.view, n.commandRingOff)).toBe(16);
		expect(entityIndexCapacity(next.view, n.entityIndexOff)).toBe(8);
		expect(eventRingCapacitySlots(next.view, n.eventRingOff)).toBe(32);
		expect(actionRingCapacitySlots(next.view, n.actionRingOff)).toBe(64);

		// Every live byte came across. A dropped `regionBytes` entry would copy
		// a short span, and the pending slot would read back zeroed.
		expect(entityIndexLength(next.view, n.entityIndexOff)).toBe(5);
		expect(pendingCommandCount(next.view, n.commandRingOff)).toBe(1);
		expect(pendingEventCount(next.view, n.eventRingOff)).toBe(1);
		expect(pendingActionCount(next.view, n.actionRingOff)).toBe(1);

		const out = new Uint8Array(15);
		expect(popCommand(next.view, n.commandRingOff, out)).toBe(1);
		expect(out[0]).toBe(0xc1);
		expect(popEvent(next.view, n.eventRingOff, out)).toBe(2);
		expect(out[0]).toBe(0xe1);
		expect(popAction(next.view, n.actionRingOff, out)).toBeGreaterThan(0);
		expect(out[0]).toBe(0xa1);
	});

	it("leaves an undeclared region absent after the realloc", () => {
		// Only the command ring is declared. The other three offsets are 0
		// before the grow and must stay 0 after it, rather than appearing with
		// a zero capacity and shifting every later offset.
		const old = createColumnStore([SPEC], undefined, { commandRingCapacitySlots: 16 });
		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 64, rowCount: 0 }]
		});

		const n = readStoreHeader(next.view);
		expect(n.commandRingOff).toBeGreaterThan(0);
		expect(commandRingCapacitySlots(next.view, n.commandRingOff)).toBe(16);
		expect(n.entityIndexOff).toBe(0);
		expect(n.eventRingOff).toBe(0);
		expect(n.actionRingOff).toBe(0);
	});
});
