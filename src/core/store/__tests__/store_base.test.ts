/**
 * The store at a nonzero base.
 *
 * A WASM module owns the low addresses of its own linear memory. Its data
 * segment, its shadow stack and its heap base all land there, and a store that
 * starts at buffer byte 0 overwrites them without a signal. A safe Zig or Rust
 * build also traps on a read of address 0, so a module cannot read a header
 * placed there at all.
 *
 * The contract this file pins: the header sits at `storeBase`, every offset in
 * the bytes is relative to that base, and the store writes only inside
 * `[storeBase, storeBase + capacity)`. A snapshot carries no base, so a store
 * taken at one base restores at another and both digests agree.
 */

import { describe, expect, it } from "vitest";
import {
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	STORE_MAGIC,
	SIM_ABI_VERSION,
	TYPE_TAG,
	COMMAND_RING_SLOT_BYTES,
	columnKey,
	columnStoreBytesView,
	columnStoreStateHash,
	createColumnStore,
	extendColumnStore,
	findRegionEntry,
	growColumnStore,
	growableSabAllocator,
	heapArrayBufferAllocator,
	popCommand,
	pushCommand,
	readLayoutDescriptorRegion,
	readStoreHeader,
	restoreColumnStore,
	StoreRestoreError,
	type ArchetypeSpec,
	type ColumnStore
} from "../index";
import { alignUp, assertStoreBase, STORE_BASE_ALIGNMENT } from "../column_store";
import {
	ENTITY_INDEX_HEADER_OFFSETS,
	entityIndexCapacity,
	entityIndexGenerationsOff
} from "../entity_index";

const REGION_ID = 77;
const REGION_BYTES = 64;

const SPECS: readonly ArchetypeSpec[] = [
	{
		archetypeId: 1,
		componentMask: [0b001, 0, 0, 0],
		rowCapacity: 4,
		columns: [
			{ componentId: 10, fieldId: 0, typeTag: TYPE_TAG.u8 },
			{ componentId: 10, fieldId: 1, typeTag: TYPE_TAG.f64 }
		]
	},
	{
		archetypeId: 2,
		componentMask: [0b011, 0, 0, 0],
		rowCapacity: 8,
		columns: [{ componentId: 11, fieldId: 0, typeTag: TYPE_TAG.i32 }]
	}
];

function makeStore(storeBase: number, allocator = heapArrayBufferAllocator(4 * 1024 * 1024)) {
	return createColumnStore(SPECS, allocator, {
		storeBase,
		reservedDescriptorBytes: 256,
		commandRingCapacitySlots: 8,
		entityIndexCapacity: 32,
		eventRingCapacitySlots: 8,
		actionRingCapacitySlots: 8,
		bindingsRegionBytes: 32,
		regions: [
			{
				id: REGION_ID,
				name: "probe",
				bytes: REGION_BYTES,
				init: (view, off) => view.setUint32(off, 0xfeedface, true)
			}
		]
	});
}

describe("store base, layout", () => {
	// 65536 is the wasm default (one page). 48 is the smallest interesting
	// aligned base, and it is smaller than the header, which catches a reader
	// that mistakes an absolute offset for a relative one.
	for (const storeBase of [0, 48, 65536]) {
		it(`header, columns, entity index, rings and region table all resolve at base ${storeBase}`, () => {
			const store = makeStore(storeBase);

			// The header is at the base, read through a fresh DataView so the
			// store's own based view cannot hide a wrong placement.
			const atBase = new DataView(store.buffer, storeBase);
			expect(atBase.getUint32(STORE_HEADER_OFFSETS.magic, true)).toBe(STORE_MAGIC);
			const header = readStoreHeader(atBase);
			expect(header.simAbiVersion).toBe(SIM_ABI_VERSION);
			expect(store.storeBase).toBe(storeBase);
			expect(store.view.byteOffset).toBe(storeBase);

			// `capacity` is the span from the base, so the backing must hold the
			// base as well as the span.
			expect(store.buffer.byteLength).toBeGreaterThanOrEqual(storeBase + header.capacity);

			// Every column view starts at the base plus the descriptor's relative
			// offset. The descriptors are read back out of the bytes, not from the
			// JS record, so a writer that stored an absolute offset fails here.
			const descriptors = readLayoutDescriptorRegion(
				atBase,
				header.layoutDescriptorOff,
				header.archetypeCount
			);
			expect(descriptors.length).toBe(SPECS.length);
			for (const desc of descriptors) {
				const arch = store.archetypes.get(desc.archetypeId)!;
				for (const col of desc.columns) {
					const view = arch.columns.get(columnKey(col.componentId, col.fieldId))!;
					expect(view.byteOff).toBe(col.byteOff);
					expect(view.view.byteOffset).toBe(storeBase + col.byteOff);
					// Inside the span, and past the header.
					expect(col.byteOff).toBeGreaterThanOrEqual(STORE_HEADER_BYTES);
					expect(col.byteOff).toBeLessThan(header.capacity);
				}
			}

			// Entity index: its own header reads back at the base plus the
			// relative offset, and so do its three columns.
			expect(entityIndexCapacity(atBase, header.entityIndexOff)).toBe(32);
			const generations = new Int32Array(
				store.buffer,
				storeBase + entityIndexGenerationsOff(header.entityIndexOff),
				32
			);
			generations[5] = 9;
			expect(atBase.getInt32(entityIndexGenerationsOff(header.entityIndexOff) + 5 * 4, true)).toBe(
				9
			);

			// Rings: each present region reports a nonzero relative offset inside
			// the span, and the region table resolves the consumer region there.
			for (const off of [header.commandRingOff, header.eventRingOff, header.actionRingOff]) {
				expect(off).toBeGreaterThan(0);
				expect(off).toBeLessThan(header.capacity);
			}
			const entry = findRegionEntry(atBase, REGION_ID)!;
			expect(entry.byteLength).toBe(REGION_BYTES);
			expect(atBase.getUint32(entry.byteOffset, true)).toBe(0xfeedface);
			expect(new DataView(store.buffer).getUint32(storeBase + entry.byteOffset, true)).toBe(
				0xfeedface
			);
		});
	}

	// A ring payload is copied through a `Uint8Array` over the backing, not
	// through the based `DataView`, so it is the one place a relative offset
	// meets a buffer offset by hand.
	it("a ring round-trips a payload at a nonzero base", () => {
		const storeBase = 65536;
		const store = makeStore(storeBase);
		const payload = new Uint8Array(COMMAND_RING_SLOT_BYTES - 1);
		for (let i = 0; i < payload.length; i++) payload[i] = i + 1;
		expect(pushCommand(store.view, store.header.commandRingOff, 3, payload)).toBe(true);

		// The bytes land inside the span, not at the same offset from byte 0.
		const below = new Uint8Array(store.buffer, 0, storeBase);
		expect(below.some((b) => b !== 0)).toBe(false);

		const out = new Uint8Array(COMMAND_RING_SLOT_BYTES - 1);
		expect(popCommand(store.view, store.header.commandRingOff, out)).toBe(3);
		expect([...out]).toEqual([...payload]);
	});

	it("rejects a base that is negative, fractional or misaligned", () => {
		expect(() => assertStoreBase(-16)).toThrow(RangeError);
		expect(() => assertStoreBase(1.5)).toThrow(RangeError);
		expect(() => assertStoreBase(STORE_BASE_ALIGNMENT - 1)).toThrow(RangeError);
		expect(() => assertStoreBase(0)).not.toThrow();
		expect(() => assertStoreBase(STORE_BASE_ALIGNMENT)).not.toThrow();
	});
});

describe("store base, the bytes below it", () => {
	// A module's data segment, its shadow stack and its heap base sit at the low
	// addresses of the same memory. The store must never write there, through
	// create, through grow, or through extend.
	it("a create, a grow and an extend leave every byte below the base untouched", () => {
		const storeBase = 65536;
		const allocator = heapArrayBufferAllocator(4 * 1024 * 1024);
		// Claim the low addresses first, the way a module's data segment does.
		const claimed = new Uint8Array(allocator(storeBase), 0, storeBase);
		for (let i = 0; i < claimed.length; i++) claimed[i] = (i * 7 + 3) & 0xff;

		let store: ColumnStore = makeStore(storeBase, allocator);
		// Fill every live column so a write that escapes the span shows up.
		for (const [, arch] of store.archetypes) {
			for (const col of arch.columnsInOrder) col.view.fill(1);
		}

		const grown = growColumnStore(
			store,
			{ archetypes: [{ archetypeId: 1, newRowCapacity: 64, rowCount: 4 }] },
			allocator
		);
		store = grown.store;

		const extended = extendColumnStore(
			store,
			{
				newArchetypes: [
					{
						archetypeId: 3,
						componentMask: [0b111, 0, 0, 0],
						rowCapacity: 32,
						columns: [{ componentId: 12, fieldId: 0, typeTag: TYPE_TAG.f64 }]
					}
				]
			},
			allocator
		);
		store = extended.store;
		for (const [, arch] of store.archetypes) {
			for (const col of arch.columnsInOrder) col.view.fill(2);
		}

		const after = new Uint8Array(store.buffer, 0, storeBase);
		for (let i = 0; i < storeBase; i++) {
			// Report the first offending byte rather than a whole-array diff.
			if (after[i] !== ((i * 7 + 3) & 0xff)) {
				throw new Error(`byte ${i} below the base changed to ${after[i]}`);
			}
		}
		expect(store.storeBase).toBe(storeBase);
	});
});

describe("store base, grow", () => {
	// The growable SAB sizes its buffer to the live extent, so it is the arm
	// that pins the tail cursor: `byteLength` measures the backing and the
	// cursor measures the span, and the two differ by the base.
	it("a grow over a growable SAB sizes the backing to the base plus the span", () => {
		const storeBase = 4096;
		const allocator = growableSabAllocator(4 * 1024 * 1024);
		let store: ColumnStore = makeStore(storeBase, allocator);
		expect(store.buffer.byteLength).toBe(storeBase + store.header.capacity);

		const beforeCapacity = store.header.capacity;
		store = growColumnStore(
			store,
			{ archetypes: [{ archetypeId: 2, newRowCapacity: 64, rowCount: 0 }] },
			allocator
		).store;
		let capacity = new DataView(store.buffer, storeBase).getUint32(
			STORE_HEADER_OFFSETS.capacity,
			true
		);
		expect(store.buffer.byteLength).toBe(storeBase + capacity);
		// The relocated column lands at the old span's end, not at the backing's
		// end. A tail cursor that forgot to drop the base would leak one base per
		// grow and put the column a base too high.
		const moved = store.archetypes.get(2)!.columnsInOrder[0];
		expect(moved.byteOff).toBe(alignUp(beforeCapacity, moved.stride));

		store = extendColumnStore(
			store,
			{
				newArchetypes: [
					{
						archetypeId: 4,
						componentMask: [0b1000, 0, 0, 0],
						rowCapacity: 16,
						columns: [{ componentId: 13, fieldId: 0, typeTag: TYPE_TAG.u32 }]
					}
				]
			},
			allocator
		).store;
		capacity = new DataView(store.buffer, storeBase).getUint32(STORE_HEADER_OFFSETS.capacity, true);
		expect(store.buffer.byteLength).toBe(storeBase + capacity);
	});

	// The realloc path is the one that copies each region's live bytes across a
	// fresh backing. It runs when the caller's allocator is not the store's own.
	it("a realloc grow carries every region's live bytes across at a nonzero base", () => {
		const storeBase = 65536;
		const store = makeStore(storeBase);
		const before = store.header;
		// Stamp the entity index and the consumer region so the copy is visible.
		store.view.setUint32(before.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length, 42, true);
		const regionOff = findRegionEntry(store.view, REGION_ID)!.byteOffset;
		store.view.setUint32(regionOff + 4, 0x0badf00d, true);

		// No allocator argument, so grow takes the realloc-and-republish path.
		const grown = growColumnStore(store, {
			archetypes: [{ archetypeId: 1, newRowCapacity: 32, rowCount: 0 }]
		}).store;

		expect(grown.storeBase).toBe(storeBase);
		const view = new DataView(grown.buffer, storeBase);
		const after = readStoreHeader(view);
		expect(after.magic).toBe(STORE_MAGIC);
		expect(view.getUint32(after.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length, true)).toBe(
			42
		);
		const newRegionOff = findRegionEntry(view, REGION_ID)!.byteOffset;
		expect(view.getUint32(newRegionOff, true)).toBe(0xfeedface);
		expect(view.getUint32(newRegionOff + 4, true)).toBe(0x0badf00d);
	});

	it("a grow keeps the base and the prefix-region offsets", () => {
		const storeBase = 4096;
		const allocator = heapArrayBufferAllocator(4 * 1024 * 1024);
		const store = makeStore(storeBase, allocator);
		const before = readStoreHeader(new DataView(store.buffer, storeBase));

		const grown = growColumnStore(
			store,
			{ archetypes: [{ archetypeId: 2, newRowCapacity: 128, rowCount: 0 }] },
			allocator
		);
		expect(grown.store.storeBase).toBe(storeBase);
		const after = readStoreHeader(new DataView(grown.store.buffer, storeBase));
		expect(after.magic).toBe(STORE_MAGIC);
		expect(after.commandRingOff).toBe(before.commandRingOff);
		expect(after.entityIndexOff).toBe(before.entityIndexOff);
		expect(after.eventRingOff).toBe(before.eventRingOff);
		expect(after.actionRingOff).toBe(before.actionRingOff);
		expect(after.regionTableOff).toBe(before.regionTableOff);
		expect(after.capacity).toBeGreaterThan(before.capacity);
		// The span still fits below the backing's end.
		expect(grown.store.buffer.byteLength).toBeGreaterThanOrEqual(storeBase + after.capacity);
	});
});

describe("store base, snapshot and restore", () => {
	it("a snapshot taken at one base restores at another with the same bytes and digest", () => {
		const a = makeStore(65536);
		let seed = 1;
		for (const [, arch] of a.archetypes) {
			for (const col of arch.columnsInOrder) {
				for (let i = 0; i < col.view.length; i++) col.view[i] = seed++ % 251;
			}
		}
		const snapshot = new Uint8Array(columnStoreBytesView(a));

		const b = restoreColumnStore(snapshot, heapArrayBufferAllocator(4 * 1024 * 1024), {
			storeBase: 48
		});
		expect(b.storeBase).toBe(48);
		expect(columnStoreStateHash(b)).toBe(columnStoreStateHash(a));
		expect(columnStoreBytesView(b)).toEqual(columnStoreBytesView(a));
		// The restored store reads its own columns through the new base.
		for (const [id, arch] of a.archetypes) {
			const other = b.archetypes.get(id)!;
			for (let c = 0; c < arch.columnsInOrder.length; c++) {
				expect(other.columnsInOrder[c].view.byteOffset).toBe(48 + arch.columnsInOrder[c].byteOff);
				expect([...other.columnsInOrder[c].view]).toEqual([...arch.columnsInOrder[c].view]);
			}
		}
	});

	it("restore refuses a snapshot carrying a different ABI version", () => {
		const store = makeStore(0);
		const snapshot = new Uint8Array(columnStoreBytesView(store));
		new DataView(snapshot.buffer).setUint32(
			STORE_HEADER_OFFSETS.sim_abi_version,
			SIM_ABI_VERSION + 1,
			true
		);
		expect(() => restoreColumnStore(snapshot, heapArrayBufferAllocator(1 << 20))).toThrow(
			StoreRestoreError
		);
	});

	it("the entity-index header survives a restore at a different base", () => {
		const a = makeStore(65536);
		new DataView(a.buffer, 65536).setUint32(
			a.header.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length,
			11,
			true
		);
		const b = restoreColumnStore(
			new Uint8Array(columnStoreBytesView(a)),
			heapArrayBufferAllocator(1 << 20),
			{ storeBase: 16 }
		);
		expect(
			new DataView(b.buffer, 16).getUint32(
				b.header.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length,
				true
			)
		).toBe(11);
	});
});
