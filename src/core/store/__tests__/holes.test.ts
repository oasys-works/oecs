/**
 * Hole reuse on the in-place grow and extend paths (`holes.ts`).
 *
 * A grow releases the archetype's old region, and a later grow or extend
 * places columns in a hole that fits before it appends at the tail. These
 * tests pin that a hole is reused, that alignment holds, that live rows
 * survive, that a reused region reads zero past the live rows, that the last
 * archetype grows where it stands, and that a store with holes round-trips a
 * snapshot. A randomized history checks the invariants after every step.
 */
import { describe, expect, it } from "vitest";
import {
	growableSabAllocator,
	heapArrayBufferAllocator,
	wasmMemoryAllocator,
	type InPlaceBufferAllocator
} from "../allocator";
import {
	createColumnStore,
	isColumnStoreInternal,
	type ArchetypeSpec,
	type ColumnStore
} from "../column_store";
import { TYPE_TAG, TYPE_TAG_STRIDE, type TypeTagValue } from "../descriptor";
import { extendColumnStore } from "../extend";
import { growColumnStore } from "../grow";
import { STORE_HEADER_OFFSETS } from "../header";
import { deriveHoles } from "../holes";
import { columnStoreBytesView, restoreColumnStore } from "../snapshot";

const REGION_HEADROOM = 4096;

function spec(id: number, rowCapacity: number, tags: TypeTagValue[]): ArchetypeSpec {
	return {
		archetypeId: id,
		componentMask: [id, 0, 0, 0],
		rowCapacity,
		columns: tags.map((typeTag, j) => ({ componentId: id, fieldId: j, typeTag }))
	};
}

function capacityOf(store: ColumnStore): number {
	return store.view.getUint32(STORE_HEADER_OFFSETS.capacity, true);
}

function dataStart(store: ColumnStore): number {
	if (!isColumnStoreInternal(store)) throw new Error("not an internal store");
	return (
		store.view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true) + store._regionBytes
	);
}

/** A value unique to (archetype, column, row) that every type tag can hold. */
function cell(id: number, col: number, row: number): number {
	return (id * 31 + col * 7 + row) % 100;
}

function fill(store: ColumnStore, id: number, from: number, to: number): void {
	const cols = store.archetypes.get(id)!.columnsInOrder;
	for (let j = 0; j < cols.length; j++) {
		for (let r = from; r < to; r++) cols[j].view[r] = cell(id, j, r);
	}
}

function expectRows(store: ColumnStore, id: number, rows: number): void {
	const arch = store.archetypes.get(id)!;
	for (let j = 0; j < arch.columnsInOrder.length; j++) {
		const v = arch.columnsInOrder[j].view;
		for (let r = 0; r < rows; r++) {
			if (v[r] !== cell(id, j, r)) {
				throw new Error(`archetype ${id} column ${j} row ${r}: ${v[r]} != ${cell(id, j, r)}`);
			}
		}
		for (let r = rows; r < arch.rowCapacity; r++) {
			if (v[r] !== 0)
				throw new Error(`archetype ${id} column ${j} row ${r} past the live rows is ${v[r]}`);
		}
	}
}

function grow(
	store: ColumnStore,
	allocator: InPlaceBufferAllocator,
	id: number,
	newRowCapacity: number,
	rowCount: number
): ColumnStore {
	return growColumnStore(
		store,
		{ archetypes: [{ archetypeId: id, newRowCapacity, rowCount }] },
		allocator
	).store;
}

function extend(
	store: ColumnStore,
	allocator: InPlaceBufferAllocator,
	s: ArchetypeSpec
): ColumnStore {
	return extendColumnStore(store, { newArchetypes: [s] }, allocator).store;
}

describe("hole reuse", () => {
	it("an extend lands in the region a grow left, and reads zero there", () => {
		const allocator = growableSabAllocator(1 << 20);
		let store: ColumnStore = createColumnStore(
			[spec(1, 16, [TYPE_TAG.f32]), spec(2, 16, [TYPE_TAG.f32])],
			allocator,
			{ reservedDescriptorBytes: REGION_HEADROOM }
		);
		const oldOff = store.archetypes.get(1)!.columnsInOrder[0].byteOff;
		fill(store, 1, 0, 16);
		fill(store, 2, 0, 10);
		const tail = capacityOf(store);
		store = grow(store, allocator, 1, 32, 16);
		// Archetype 2 sits after 1, so 1 cannot grow where it stands: it moves to
		// the tail and leaves a 64-byte hole.
		expect(store.archetypes.get(1)!.columnsInOrder[0].byteOff).toBe(tail);
		expect(isColumnStoreInternal(store) && store._holes).toEqual([oldOff, oldOff + 64]);
		const span = capacityOf(store);

		store = extend(store, allocator, spec(3, 16, [TYPE_TAG.f32]));
		expect(store.archetypes.get(3)!.columnsInOrder[0].byteOff).toBe(oldOff);
		// The hole held archetype 1's old rows. The new archetype reads zero.
		expectRows(store, 3, 0);
		expectRows(store, 1, 16);
		expectRows(store, 2, 10);
		// No new bytes were needed.
		expect(capacityOf(store)).toBe(span);
	});

	it("a placement in a hole respects each column's alignment", () => {
		const allocator = heapArrayBufferAllocator(1 << 20);
		// A u8 column of 3 rows leaves a hole whose start is not 8-aligned once
		// archetype 1 moves.
		let store: ColumnStore = createColumnStore(
			[spec(1, 3, [TYPE_TAG.u8, TYPE_TAG.u8]), spec(2, 4, [TYPE_TAG.f64])],
			allocator,
			{ reservedDescriptorBytes: REGION_HEADROOM }
		);
		fill(store, 1, 0, 3);
		fill(store, 2, 0, 4);
		store = grow(store, allocator, 1, 64, 3);
		store = extend(store, allocator, spec(3, 1, [TYPE_TAG.u8, TYPE_TAG.f64]));
		const cols = store.archetypes.get(3)!.columnsInOrder;
		expect(cols[1].byteOff % 8).toBe(0);
		expectRows(store, 3, 0);
		expectRows(store, 1, 3);
		expectRows(store, 2, 4);
		expect(isColumnStoreInternal(store) && store._holes).toEqual(deriveHoles(store as never));
	});

	it("the last archetype grows where it stands, and its rows survive", () => {
		for (const allocator of [growableSabAllocator(1 << 20), heapArrayBufferAllocator(1 << 20)]) {
			let store: ColumnStore = createColumnStore(
				[spec(1, 8, [TYPE_TAG.f32]), spec(2, 8, [TYPE_TAG.u8, TYPE_TAG.f64, TYPE_TAG.i16])],
				allocator,
				{ reservedDescriptorBytes: REGION_HEADROOM }
			);
			fill(store, 1, 0, 8);
			fill(store, 2, 0, 8);
			const first = store.archetypes.get(2)!.columnsInOrder[0].byteOff;
			const result = growColumnStore(
				store,
				{ archetypes: [{ archetypeId: 2, newRowCapacity: 64, rowCount: 8 }] },
				allocator
			);
			store = result.store;
			expect(result.viewsPreserved).toBe(true);
			expect(result.grownArchetypeIds).toEqual([2]);
			expect(store.archetypes.get(2)!.columnsInOrder[0].byteOff).toBe(first);
			expectRows(store, 2, 8);
			expectRows(store, 1, 8);
			expect(isColumnStoreInternal(store) && store._holes).toEqual(deriveHoles(store as never));
		}
	});

	it("a grow reuses its own region with a hole before it", () => {
		const allocator = heapArrayBufferAllocator(1 << 20);
		let store: ColumnStore = createColumnStore(
			[spec(1, 4, [TYPE_TAG.f64, TYPE_TAG.f64])],
			allocator,
			{
				reservedDescriptorBytes: REGION_HEADROOM
			}
		);
		const start = dataStart(store);
		// Double one archetype many times. Each grow merges the region it stands
		// in with the free bytes before it, so the store never holds more than
		// the archetype's own extent.
		let cap = 4;
		fill(store, 1, 0, 4);
		for (let k = 0; k < 8; k++) {
			store = grow(store, allocator, 1, cap * 2, cap);
			fill(store, 1, cap, cap * 2);
			cap *= 2;
			expectRows(store, 1, cap);
			// The first f64 column starts at the data start rounded up to 8.
			expect(capacityOf(store) - (start + ((8 - (start % 8)) % 8))).toBe(2 * 8 * cap);
		}
	});

	it("a snapshot of a store with holes and reused holes restores the same layout and rows", () => {
		const allocator = growableSabAllocator(1 << 20);
		let store: ColumnStore = createColumnStore(
			[spec(1, 16, [TYPE_TAG.f32, TYPE_TAG.u16]), spec(2, 16, [TYPE_TAG.f64])],
			allocator,
			{ reservedDescriptorBytes: REGION_HEADROOM }
		);
		fill(store, 1, 0, 16);
		fill(store, 2, 0, 5);
		store = grow(store, allocator, 1, 64, 16);
		fill(store, 1, 16, 40);
		// Archetype 3 fits in the hole archetype 1 left, so the store now has
		// both a reused hole and free bytes.
		store = extend(store, allocator, spec(3, 4, [TYPE_TAG.i32]));
		fill(store, 3, 0, 3);
		expect(isColumnStoreInternal(store) && store._holes!.length).toBeGreaterThan(0);

		const bytes = new Uint8Array(columnStoreBytesView(store));
		for (const restoreWith of [heapArrayBufferAllocator(1 << 20), growableSabAllocator(1 << 20)]) {
			const restored = restoreColumnStore(bytes, restoreWith);
			for (const [id, arch] of store.archetypes) {
				const back = restored.archetypes.get(id)!;
				expect(back.columnsInOrder.map((c) => c.byteOff)).toEqual(
					arch.columnsInOrder.map((c) => c.byteOff)
				);
			}
			expectRows(restored, 1, 40);
			expectRows(restored, 2, 5);
			expectRows(restored, 3, 3);
			// A restored store is not internal, so its next grow reallocs into a
			// dense layout, and the rows still survive.
			const regrown = growColumnStore(
				restored,
				{
					archetypes: [
						{ archetypeId: 1, newRowCapacity: 64, rowCount: 40 },
						{ archetypeId: 2, newRowCapacity: 32, rowCount: 5 },
						{ archetypeId: 3, newRowCapacity: 4, rowCount: 3 }
					]
				},
				restoreWith
			).store;
			expectRows(regrown, 1, 40);
			expectRows(regrown, 2, 5);
			expectRows(regrown, 3, 3);
		}
	});
});

/** A small seeded generator, so a failure replays. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const TAGS: TypeTagValue[] = [
	TYPE_TAG.u8,
	TYPE_TAG.i8,
	TYPE_TAG.u16,
	TYPE_TAG.i16,
	TYPE_TAG.u32,
	TYPE_TAG.i32,
	TYPE_TAG.f32,
	TYPE_TAG.f64
];

/** No two live extents overlap, every column is aligned and inside the data
 * area, the cached holes equal the derived ones, and every column reads back
 * its rows and zero past them. */
function checkInvariants(store: ColumnStore, rows: Map<number, number>): void {
	const start = dataStart(store);
	const capacity = capacityOf(store);
	const extents: [number, number, string][] = [];
	for (const [id, arch] of store.archetypes) {
		for (let j = 0; j < arch.columnsInOrder.length; j++) {
			const c = arch.columnsInOrder[j];
			const end = c.byteOff + c.stride * arch.rowCapacity;
			expect(c.byteOff % TYPE_TAG_STRIDE[c.typeTag]).toBe(0);
			expect(c.byteOff).toBeGreaterThanOrEqual(start);
			expect(end).toBeLessThanOrEqual(capacity);
			if (end > c.byteOff) extents.push([c.byteOff, end, `${id}/${j}`]);
		}
		expectRows(store, id, rows.get(id) ?? 0);
	}
	extents.sort((a, b) => a[0] - b[0]);
	for (let i = 1; i < extents.length; i++) {
		if (extents[i][0] < extents[i - 1][1]) {
			throw new Error(`extents ${extents[i - 1][2]} and ${extents[i][2]} overlap`);
		}
	}
	if (!isColumnStoreInternal(store)) throw new Error("not an internal store");
	expect(store._holes).toEqual(deriveHoles(store));
}

describe("hole reuse, a randomized history", () => {
	const allocators: [string, () => InPlaceBufferAllocator][] = [
		["growable SAB", () => growableSabAllocator(64 << 20)],
		["heap", () => heapArrayBufferAllocator(64 << 20)],
		[
			"wasm memory",
			() => wasmMemoryAllocator(new WebAssembly.Memory({ initial: 1, maximum: 1024, shared: true }))
		]
	];
	for (const [name, make] of allocators) {
		for (const seed of [1, 2, 3]) {
			it(`${name}, seed ${seed}: no overlap, data survives after every step`, () => {
				const r = rng(seed * 7919);
				const allocator = make();
				// The Store's own headroom. Past it an extend reallocs the whole
				// store over the same buffer, which carries the live rows but not
				// zeroes past them, so the zero check would not hold there.
				let store: ColumnStore = createColumnStore([], allocator, {
					reservedDescriptorBytes: 64 * 1024
				});
				const rows = new Map<number, number>();
				let nextId = 1;
				for (let step = 0; step < 300; step++) {
					const ids = [...store.archetypes.keys()];
					const grown = ids.filter((id) => store.archetypes.get(id)!.rowCapacity < 2048);
					if (grown.length === 0 || r() < 0.25) {
						const ncol = Math.floor(r() * 4);
						const tags: TypeTagValue[] = [];
						for (let j = 0; j < ncol; j++) tags.push(TAGS[Math.floor(r() * TAGS.length)]);
						const id = nextId++;
						// Name the live rows, so an extend past the descriptor headroom,
						// which reallocs the whole store, carries them.
						const existing = [...rows].map(([archetypeId, rowCount]) => ({
							archetypeId,
							newRowCapacity: store.archetypes.get(archetypeId)!.rowCapacity,
							rowCount
						}));
						store = extendColumnStore(
							store,
							{ newArchetypes: [spec(id, 1 + Math.floor(r() * 24), tags)], existing },
							allocator
						).store;
						rows.set(id, 0);
					} else {
						const id = grown[Math.floor(r() * grown.length)];
						const arch = store.archetypes.get(id)!;
						const have = rows.get(id)!;
						// Fill up to capacity, then grow by a factor of one to three.
						fill(store, id, have, arch.rowCapacity);
						rows.set(id, arch.rowCapacity);
						const newCap = arch.rowCapacity * (2 + Math.floor(r() * 2)) + Math.floor(r() * 3);
						store = grow(store, allocator, id, newCap, arch.rowCapacity);
					}
					try {
						checkInvariants(store, rows);
					} catch (e) {
						throw new Error(`step ${step}: ${(e as Error).message}`);
					}
				}
			});
		}
	}
});
