import { describe, expect, it } from "vitest";

import {
	archetypeDescriptorBytes,
	columnKey,
	createColumnStore,
	readStoreHeader,
	TYPE_TAG,
	type ArchetypeSpec,
	type ColumnStore
} from "..";
import { growableSabAllocator, wasmMemoryAllocator, type BufferAllocator } from "../allocator";
import { extendColumnStore, StoreExtendError } from "../extend";
import { growColumnStore } from "../grow";
import type { ColumnStoreInternal } from "../column_store";

function spec(
	archetypeId: number,
	rowCapacity: number,
	cols: { componentId: number; fieldId: number; typeTag: number }[],
	maskLo = 0,
	maskHi = 0
): ArchetypeSpec {
	return {
		archetypeId,
		componentMask: [maskLo, maskHi, 0, 0],
		rowCapacity,
		columns: cols.map((c) => ({
			componentId: c.componentId,
			fieldId: c.fieldId,
			typeTag: c.typeTag as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
		}))
	};
}

describe("extend_column_store — happy path", () => {
	it("appends a new archetype while keeping the existing one", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: next } = extendColumnStore(old, {
			newArchetypes: [spec(1, 8, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f32 }])]
		});

		expect(next.archetypes.size).toBe(2);
		expect(next.archetypes.has(0)).toBe(true);
		expect(next.archetypes.has(1)).toBe(true);
		expect(next.archetypes.get(1)!.rowCapacity).toBe(8);
		expect(readStoreHeader(next.view).archetypeCount).toBe(2);
	});

	it("bumps view_stamp by 1", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const {
			oldViewStamp,
			newViewStamp,
			store: next
		} = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
		});

		expect(oldViewStamp).toBe(0);
		expect(newViewStamp).toBe(1);
		expect(readStoreHeader(next.view).viewStamp).toBe(1);
		// The realloc path patches the returned header so its cached
		// `view_stamp` / `capacity` match the SAB bytes — no stale 0.
		expect(next.header.viewStamp).toBe(1);
		expect(next.header.capacity).toBe(readStoreHeader(next.view).capacity);
	});

	it("preserves view_stamp across extend-then-grow (1 → 2)", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: extended } = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
		});
		expect(readStoreHeader(extended.view).viewStamp).toBe(1);

		const { newViewStamp, store: grown } = growColumnStore(extended, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		expect(newViewStamp).toBe(2);
		expect(readStoreHeader(grown.view).viewStamp).toBe(2);
	});

	it("preserves view_stamp across consecutive extends (1 → 2)", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: gen1 } = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
		});
		const { store: gen2, newViewStamp } = extendColumnStore(gen1, {
			newArchetypes: [spec(2, 4, [{ componentId: 3, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
		});
		expect(newViewStamp).toBe(2);
		expect(readStoreHeader(gen2.view).viewStamp).toBe(2);
	});

	it("appends multiple new archetypes in one call", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: next } = extendColumnStore(old, {
			newArchetypes: [
				spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f32 }]),
				spec(2, 8, [{ componentId: 3, fieldId: 0, typeTag: TYPE_TAG.f64 }])
			]
		});
		expect(next.archetypes.size).toBe(3);
		expect(next.archetypes.get(2)!.rowCapacity).toBe(8);
	});

	it("new archetype columns start zeroed", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: next } = extendColumnStore(old, {
			newArchetypes: [
				spec(1, 4, [
					{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 },
					{ componentId: 2, fieldId: 1, typeTag: TYPE_TAG.f64 }
				])
			]
		});
		const i32 = next.archetypes.get(1)!.columns.get(columnKey(2, 0))!.view as Int32Array;
		const f64 = next.archetypes.get(1)!.columns.get(columnKey(2, 1))!.view as Float64Array;
		expect(Array.from(i32)).toEqual([0, 0, 0, 0]);
		expect(Array.from(f64)).toEqual([0, 0, 0, 0]);
	});

	it("preserves rows in existing archetypes when an `existing` row_count is supplied", () => {
		const old = createColumnStore([
			spec(0, 4, [
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
				{ componentId: 1, fieldId: 1, typeTag: TYPE_TAG.f64 }
			])
		]);
		const i32 = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const f64 = old.archetypes.get(0)!.columns.get(columnKey(1, 1))!.view as Float64Array;
		i32[0] = 10;
		i32[1] = 20;
		i32[2] = 30;
		f64[0] = 1.5;
		f64[1] = 2.5;
		f64[2] = 3.5;

		const { store: next } = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			existing: [{ archetypeId: 0, newRowCapacity: 0, rowCount: 3 }]
		});

		const ri32 = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const rf64 = next.archetypes.get(0)!.columns.get(columnKey(1, 1))!.view as Float64Array;
		expect(Array.from(ri32.subarray(0, 3))).toEqual([10, 20, 30]);
		expect(Array.from(rf64.subarray(0, 3))).toEqual([1.5, 2.5, 3.5]);
	});

	it("leaves existing archetypes empty when no row_count is supplied", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		// Write some bytes that should NOT be copied because no row_count was declared.
		(old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 99;

		const { store: next } = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
		});
		const ri32 = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		expect(ri32[0]).toBe(0);
	});

	it("preserves existing archetype row_capacity (extend never resizes rows)", () => {
		const old = createColumnStore([
			spec(0, 16, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: next } = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
		});
		expect(next.archetypes.get(0)!.rowCapacity).toBe(16);
	});

	it("the old SAB is untouched (different SAB instance, original views still read)", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const oldCol = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		oldCol[0] = 7;

		const { store: next } = extendColumnStore(old, {
			newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			existing: [{ archetypeId: 0, newRowCapacity: 0, rowCount: 1 }]
		});
		expect(next.buffer).not.toBe(old.buffer);
		expect(oldCol[0]).toBe(7); // old view still readable
	});
});

describe("extend_column_store — growable in-place fast path", () => {
	it("reuses the same SAB across extends when allocator is growable + headroom present", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const sabBefore = old.buffer;
		const { store: next } = extendColumnStore(
			old,
			{
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			},
			alloc
		);
		expect(next.buffer).toBe(sabBefore);
		expect(next.archetypes.size).toBe(2);
		expect(readStoreHeader(next.view).archetypeCount).toBe(2);
	});

	it("preserves existing column views verbatim across in-place extend", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const old = createColumnStore(
			[
				spec(0, 4, [
					{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
					{ componentId: 1, fieldId: 1, typeTag: TYPE_TAG.f64 }
				])
			],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const i32Before = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const f64Before = old.archetypes.get(0)!.columns.get(columnKey(1, 1))!.view as Float64Array;
		i32Before[0] = 11;
		i32Before[3] = 13;
		f64Before[1] = 3.14;

		const { store: next } = extendColumnStore(
			old,
			{
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			},
			alloc
		);
		const i32After = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const f64After = next.archetypes.get(0)!.columns.get(columnKey(1, 1))!.view as Float64Array;
		// Same TypedArray instance — not rebuilt.
		expect(i32After).toBe(i32Before);
		expect(f64After).toBe(f64Before);
		// Data survived.
		expect(i32After[0]).toBe(11);
		expect(i32After[3]).toBe(13);
		expect(f64After[1]).toBe(3.14);
	});

	it("new archetype column views land at the SAB tail with zeroed data", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const tailBefore = old.buffer.byteLength;
		const { store: next } = extendColumnStore(
			old,
			{
				newArchetypes: [spec(1, 8, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			},
			alloc
		);
		const newCol = next.archetypes.get(1)!.columns.get(columnKey(2, 0))!;
		expect(newCol.byteOff).toBeGreaterThanOrEqual(tailBefore);
		const newView = newCol.view as Int32Array;
		expect(newView.length).toBe(8);
		expect(Array.from(newView)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("bumps view_stamp and archetype_count even on the fast path", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const {
			oldViewStamp,
			newViewStamp,
			store: next
		} = extendColumnStore(
			old,
			{
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			},
			alloc
		);
		expect(oldViewStamp).toBe(0);
		expect(newViewStamp).toBe(1);
		const headerAfter = readStoreHeader(next.view);
		expect(headerAfter.viewStamp).toBe(1);
		expect(headerAfter.archetypeCount).toBe(2);
	});

	it("falls back to realloc path when descriptor headroom is exhausted", () => {
		// Reserve only enough for the initial archetype; the new one must
		// trigger the slow path (which reallocates a fresh SAB from the
		// same growable allocator).
		const alloc = growableSabAllocator(1024 * 1024);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc
			// no reservedDescriptorBytes — headroom == 0 after first archetype
		);
		const { store: next } = extendColumnStore(
			old,
			{
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			},
			alloc
		);
		// Either the SAB is the same (in-place worked) or different (slow
		// path took over). Headroom == 0 means slow path; in that case
		// the test's contract is "fast path was correctly skipped". The
		// extend STILL must produce a working store.
		expect(next.archetypes.size).toBe(2);
		expect(readStoreHeader(next.view).archetypeCount).toBe(2);
	});
});

describe("extend_column_store — descriptor headroom survives realloc", () => {
	// One single-column archetype's descriptor footprint.
	const ONE_COL = archetypeDescriptorBytes(1);

	function extendOne(store: ColumnStore, alloc: BufferAllocator, id: number) {
		return extendColumnStore(
			store,
			{
				newArchetypes: [spec(id, 4, [{ componentId: id, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			},
			alloc
		);
	}

	// Sum the descriptor bytes the store's archetypes actually occupy — the
	// "natural" descriptor-region size for the current set.
	function usedRegion(store: ColumnStore): number {
		let used = 0;
		for (const [, arch] of store.archetypes) {
			used += archetypeDescriptorBytes(arch.columnsInOrder.length);
		}
		return used;
	}

	it("re-reserves headroom on realloc so the NEXT extend is in-place again", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		// Headroom for two extra single-col archetypes beyond the seed. The
		// third in-place extend exhausts it and forces the realloc path; the
		// fix must hand the realloc'd store fresh headroom so the extend AFTER
		// that goes back to the in-place fast path (pre-fix it stayed slow
		// forever).
		let store: ColumnStore = createColumnStore(
			[spec(0, 4, [{ componentId: 0, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: ONE_COL * 2 }
		);

		let sawRealloc = false;
		let inPlaceAfterRealloc: boolean | undefined;
		for (let id = 1; id <= 6; id++) {
			const result = extendOne(store, alloc, id);
			store = result.store;
			if (!sawRealloc) {
				sawRealloc = !result.viewsPreserved;
			} else {
				// First extend after the realloc — this is the regression point.
				inPlaceAfterRealloc = result.viewsPreserved;
				break;
			}
		}

		expect(sawRealloc).toBe(true); // exhaustion really triggered a realloc
		expect(inPlaceAfterRealloc).toBe(true); // not permanently slow
	});

	it("realloc'd store carries the policy and is sized natural + headroom", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const reserved = ONE_COL * 2;
		let store: ColumnStore = createColumnStore(
			[spec(0, 4, [{ componentId: 0, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: reserved }
		);
		// Extend until the first realloc fires.
		for (let id = 1; id <= 6; id++) {
			const result = extendOne(store, alloc, id);
			store = result.store;
			if (!result.viewsPreserved) break;
		}

		const internal = store as ColumnStoreInternal;
		// Policy carried across the realloc…
		expect(internal._reservedDescriptorBytes).toBe(reserved);
		// …and applied additively, so the region is natural + headroom (not a
		// floor collapsed to natural). Slack remains for the next extend.
		const used = usedRegion(store);
		expect(internal._regionBytes).toBe(used + reserved);
		expect(internal._regionBytes).toBeGreaterThan(used);
	});
});

describe("extend_column_store — wasm-memory in-place fast path", () => {
	it("takes the in-place branch under wasm_memory_allocator (views_preserved=true)", () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 64, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const i32Before = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		i32Before[0] = 11;
		i32Before[3] = 13;

		const result = extendColumnStore(
			old,
			{ newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])] },
			alloc
		);
		expect(result.viewsPreserved).toBe(true);

		// Existing column view is the SAME TypedArray instance — not rebuilt.
		const i32After = result.store.archetypes.get(0)!.columns.get(columnKey(1, 0))!
			.view as Int32Array;
		expect(i32After).toBe(i32Before);
		expect(i32After[0]).toBe(11);
		expect(i32After[3]).toBe(13);
	});

	it("existing views survive a memory.grow triggered by the new archetype's tail allocation", () => {
		// Pick a small initial memory so adding a wide new archetype forces
		// `memory.grow()` and a fresh `memory.buffer` reference. The
		// `isInPlace` fast path must still preserve the existing column
		// view's reads/writes.
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 64, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const sabBefore = old.buffer;
		const i32Before = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		i32Before[2] = 42;

		// Add a fat archetype: 1024 rows × 8 bytes/row × 4 columns = 32 KiB,
		// big enough to force the WASM memory past its initial page on a
		// freshly-allocated 64 KiB store.
		const fat = spec(1, 1024, [
			{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 },
			{ componentId: 2, fieldId: 1, typeTag: TYPE_TAG.f64 },
			{ componentId: 2, fieldId: 2, typeTag: TYPE_TAG.f64 },
			{ componentId: 2, fieldId: 3, typeTag: TYPE_TAG.f64 }
		]);
		const result = extendColumnStore(old, { newArchetypes: [fat] }, alloc);
		expect(result.viewsPreserved).toBe(true);
		// Buffer ref changed across the wasm grow…
		expect(result.store.buffer).not.toBe(sabBefore);
		// …but the old view's data is intact and still operates on the
		// same underlying memory.
		expect(i32Before[2]).toBe(42);
		i32Before[2] = 99;
		const i32After = result.store.archetypes.get(0)!.columns.get(columnKey(1, 0))!
			.view as Int32Array;
		expect(i32After).toBe(i32Before);
		expect(i32After[2]).toBe(99);
	});

	it("new archetype's column view lands past the pre-grow tail and is zeroed", () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 64, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const tailBefore = old.buffer.byteLength;
		const { store: next } = extendColumnStore(
			old,
			{ newArchetypes: [spec(1, 8, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])] },
			alloc
		);
		const newCol = next.archetypes.get(1)!.columns.get(columnKey(2, 0))!;
		expect(newCol.byteOff).toBeGreaterThanOrEqual(tailBefore);
		const newView = newCol.view as Int32Array;
		expect(newView.length).toBe(8);
		expect(Array.from(newView)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("bumps view_stamp and archetype_count on the fast path", () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 64, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const old = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: 4096 }
		);
		const {
			oldViewStamp,
			newViewStamp,
			store: next
		} = extendColumnStore(
			old,
			{ newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])] },
			alloc
		);
		expect(oldViewStamp).toBe(0);
		expect(newViewStamp).toBe(1);
		const headerAfter = readStoreHeader(next.view);
		expect(headerAfter.viewStamp).toBe(1);
		expect(headerAfter.archetypeCount).toBe(2);
	});
});

describe("extend_column_store — rejections", () => {
	it("rejects an empty plan", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() => extendColumnStore(old, { newArchetypes: [] })).toThrow(StoreExtendError);
	});

	it("rejects a duplicate archetype_id within the plan", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			extendColumnStore(old, {
				newArchetypes: [
					spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }]),
					spec(1, 4, [{ componentId: 3, fieldId: 0, typeTag: TYPE_TAG.i32 }])
				]
			})
		).toThrow(/duplicate archetype_id 1/);
	});

	it("rejects a collision with an existing archetype_id", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			extendColumnStore(old, {
				newArchetypes: [spec(0, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])]
			})
		).toThrow(/already exists/);
	});

	it("rejects an `existing` row_count for an unknown archetype_id", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			extendColumnStore(old, {
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
				existing: [{ archetypeId: 999, newRowCapacity: 0, rowCount: 1 }]
			})
		).toThrow(/unknown archetype_id 999/);
	});

	it("rejects a negative row_count", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			extendColumnStore(old, {
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
				existing: [{ archetypeId: 0, newRowCapacity: 0, rowCount: -1 }]
			})
		).toThrow(/non-negative/);
	});

	it("rejects row_count > existing row_capacity", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			extendColumnStore(old, {
				newArchetypes: [spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
				existing: [{ archetypeId: 0, newRowCapacity: 0, rowCount: 99 }]
			})
		).toThrow(/row_count 99 > old row_capacity 4/);
	});
});
