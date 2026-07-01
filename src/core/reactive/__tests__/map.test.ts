/**
 * Keyed reactive map gate: fine-grained per-key isolation (changing one entity
 * wakes only that entity's reader), structure-vs-value separation (size/keys track
 * membership, not value updates), the absent→present→deleted lifecycle, and batch
 * coalescing. The per-key isolation is what makes an O(changed) ECS→UI sync
 * possible. Ported from the workbench harness.
 */
import { describe, expect, it } from "vitest";
import { effect, batch } from "../kernel";
import { reactiveMap } from "../map";

describe("reactiveMap", () => {
	it("isolates a per-key change to that key's reader only", () => {
		const m = reactiveMap<number, number>();
		for (let i = 0; i < 5; i++) m.set(i, i * 10);
		const runs = [0, 0, 0, 0, 0];
		for (let i = 0; i < 5; i++) {
			effect(() => {
				runs[i]++;
				m.get(i);
			});
		}
		expect(runs.every((r) => r === 1)).toBe(true);
		m.set(2, 999); // only entity 2 changes
		expect(runs[2]).toBe(2);
		expect(runs.filter((_, i) => i !== 2).every((r) => r === 1)).toBe(true);
		m.set(2, 999); // equal value -> no-op skip survives the map
		expect(runs[2]).toBe(2);
	});

	it("separates structure (size/keys) from value updates", () => {
		const m = reactiveMap<string, number>();
		let sizeRuns = 0;
		let lastSize = -1;
		effect(() => {
			sizeRuns++;
			lastSize = m.size();
		});
		expect(lastSize).toBe(0);
		expect(sizeRuns).toBe(1);
		m.set("a", 1);
		expect(lastSize).toBe(1);
		expect(sizeRuns).toBe(2);
		m.set("a", 2); // value update -> structure unchanged
		expect(sizeRuns).toBe(2);
		m.set("b", 5);
		expect(lastSize).toBe(2);
		expect(sizeRuns).toBe(3);
		m.delete("a");
		expect(lastSize).toBe(1);
		expect(sizeRuns).toBe(4);
	});

	it("wakes a single key's reader across the absent->present->deleted lifecycle", () => {
		const m = reactiveMap<string, number>();
		let value: number | undefined = -1;
		let runs = 0;
		effect(() => {
			runs++;
			value = m.get("x");
		});
		expect(value).toBe(undefined);
		expect(runs).toBe(1);
		m.set("x", 42); // structure bump wakes the absent-reader
		expect(value).toBe(42);
		expect(runs).toBe(2);
		m.set("x", 43); // present-key value change via the cell
		expect(value).toBe(43);
		expect(runs).toBe(3);
		m.delete("x"); // wake with absence
		expect(value).toBe(undefined);
		expect(runs).toBe(4);
	});

	it("re-subscribes a deleted key's reader to structure, so delete->re-add wakes it", () => {
		// Regression: delete() must remove the cell before its synchronous value-clear
		// wakes the reader, or the reader re-binds to the orphaned value signal and a
		// later re-insert of the same key never wakes it (it stays stuck at undefined).
		const m = reactiveMap<string, number>();
		let value: number | undefined = -1;
		let runs = 0;
		effect(() => {
			runs++;
			value = m.get("x");
		});
		m.set("x", 42);
		expect(value).toBe(42);
		m.delete("x");
		expect(value).toBe(undefined);
		const afterDelete = runs; // 3: absent-prime, insert, delete
		m.set("x", 100); // re-add the same key
		expect(value).toBe(100); // the reader woke (was: stuck at undefined)
		expect(runs).toBe(afterDelete + 1); // exactly one wake for the re-add
	});

	it("coalesces a batched multi-entity update to one wake per reader", () => {
		const m = reactiveMap<number, number>();
		for (let i = 0; i < 3; i++) m.set(i, 0);
		const runs = [0, 0, 0];
		for (let i = 0; i < 3; i++) {
			effect(() => {
				runs[i]++;
				m.get(i);
			});
		}
		batch(() => {
			m.set(0, 1);
			m.set(0, 2); // two writes to entity 0 in the batch
			m.set(1, 1);
		});
		expect(runs[0]).toBe(2); // entity 0's two writes -> one wake
		expect(runs[1]).toBe(2);
		expect(runs[2]).toBe(1); // untouched entity never woke
	});

	it("wakes on every fresh object value under the default Object.is (the gap eq closes)", () => {
		// Without a content eq, an object-valued channel is compared by reference: a fresh
		// snapshot object every tick is never Object.is-equal, so the row wakes even when
		// its content didn't change. This pins the default so the eq fix has a contrast.
		const m = reactiveMap<number, { hp: number }>();
		m.set(0, { hp: 100 });
		let runs = 0;
		effect(() => {
			runs++;
			m.get(0);
		});
		expect(runs).toBe(1);
		m.set(0, { hp: 100 }); // equal content, fresh reference -> still wakes (no content eq)
		expect(runs).toBe(2);
	});

	it("dedups object-valued channels by content with a custom eq", () => {
		const m = reactiveMap<number, { hp: number }>((a, b) => a.hp === b.hp);
		m.set(0, { hp: 100 });
		m.set(1, { hp: 100 });
		const runs = [0, 0];
		for (let i = 0; i < 2; i++) {
			effect(() => {
				runs[i]++;
				m.get(i);
			});
		}
		expect(runs).toEqual([1, 1]);
		m.set(0, { hp: 100 }); // fresh object, equal content -> no wake
		expect(runs).toEqual([1, 1]);
		m.set(0, { hp: 40 }); // content changed -> only entity 0 wakes
		expect(runs).toEqual([2, 1]);
	});

	it("never skips a delete under a custom eq (absence is not value-equal)", () => {
		// delete writes `undefined` into the cell to wake its readers as absent; the eq
		// wrapper must treat present-vs-absent as unequal so the clear is never swallowed.
		const m = reactiveMap<string, { hp: number }>((a, b) => a.hp === b.hp);
		m.set("x", { hp: 100 });
		let value: { hp: number } | undefined = { hp: -1 };
		let runs = 0;
		effect(() => {
			runs++;
			value = m.get("x");
		});
		expect(value?.hp).toBe(100);
		m.delete("x");
		expect(value).toBeUndefined(); // the delete woke the reader despite the custom eq
		expect(runs).toBe(2);
	});
});
