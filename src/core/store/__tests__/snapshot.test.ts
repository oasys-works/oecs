import { describe, expect, it } from "vitest";

import {
	columnKey,
	createColumnStore,
	growColumnStore,
	readStoreHeader,
	restoreColumnStore,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	STORE_MAGIC,
	StoreRestoreError,
	snapshotColumnStore,
	TYPE_TAG,
	type ArchetypeSpec
} from "..";

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

describe("snapshot_column_store", () => {
	it("returns a Uint8Array spanning the full SAB", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const snap = snapshotColumnStore(store);

		expect(snap).toBeInstanceOf(Uint8Array);
		expect(snap.byteLength).toBe(store.buffer.byteLength);
		expect(snap.buffer).toBe(store.buffer);
		expect(snap.byteOffset).toBe(0);
	});

	it("is zero-copy: SAB writes are visible through the snapshot view", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const snap = snapshotColumnStore(store);
		const col = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;

		col[0] = 0x11_22_33_44;

		// Read the same four bytes through the byte-level snapshot. Little-
		// endian: low byte first.
		expect(snap[col.byteOffset + 0]).toBe(0x44);
		expect(snap[col.byteOffset + 1]).toBe(0x33);
		expect(snap[col.byteOffset + 2]).toBe(0x22);
		expect(snap[col.byteOffset + 3]).toBe(0x11);
	});
});

describe("restore_column_store round-trip", () => {
	it("byte-for-byte preserves the SAB contents", () => {
		const store = createColumnStore([
			spec(0, 4, [
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
				{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }
			])
		]);
		const i32 = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const f64 = store.archetypes.get(0)!.columns.get(columnKey(2, 0))!.view as Float64Array;
		i32[0] = 10;
		i32[1] = 20;
		f64[0] = 1.5;
		f64[1] = 2.5;

		const snap = snapshotColumnStore(store);
		const restored = restoreColumnStore(snap);

		// Different SAB instance, same byte length.
		expect(restored.buffer).not.toBe(store.buffer);
		expect(restored.buffer.byteLength).toBe(store.buffer.byteLength);

		// memcmp over the full byte range.
		const a = new Uint8Array(store.buffer);
		const b = new Uint8Array(restored.buffer);
		expect(b).toEqual(a);
	});

	it("rebuilds views that read back the original column values", () => {
		const store = createColumnStore([
			spec(0, 4, [
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
				{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }
			])
		]);
		const i32 = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const f64 = store.archetypes.get(0)!.columns.get(columnKey(2, 0))!.view as Float64Array;
		i32[0] = 10;
		i32[1] = 20;
		i32[2] = 30;
		f64[0] = 1.5;
		f64[1] = 2.5;
		f64[2] = 3.5;

		const restored = restoreColumnStore(snapshotColumnStore(store));
		const ri32 = restored.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const rf64 = restored.archetypes.get(0)!.columns.get(columnKey(2, 0))!.view as Float64Array;

		expect(Array.from(ri32.subarray(0, 3))).toEqual([10, 20, 30]);
		expect(Array.from(rf64.subarray(0, 3))).toEqual([1.5, 2.5, 3.5]);
	});

	it("preserves the column byte_offs across restore", () => {
		const store = createColumnStore([
			spec(0, 4, [
				{ componentId: 7, fieldId: 0, typeTag: TYPE_TAG.u8 },
				{ componentId: 3, fieldId: 0, typeTag: TYPE_TAG.f32 },
				{ componentId: 7, fieldId: 1, typeTag: TYPE_TAG.i32 }
			])
		]);
		const origOffs = store.archetypes.get(0)!.columnsInOrder.map((c) => c.byteOff);

		const restored = restoreColumnStore(snapshotColumnStore(store));
		const newOffs = restored.archetypes.get(0)!.columnsInOrder.map((c) => c.byteOff);

		expect(newOffs).toEqual(origOffs);
	});

	it("preserves view_stamp across restore (including post-grow)", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: grown } = growColumnStore(store, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		expect(readStoreHeader(grown.view).viewStamp).toBe(1);

		const restored = restoreColumnStore(snapshotColumnStore(grown));
		expect(readStoreHeader(restored.view).viewStamp).toBe(1);
	});

	it("preserves component masks", () => {
		const store = createColumnStore([
			spec(
				0,
				4,
				[{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }],
				0xdead_beef,
				0xcafe_f00d
			)
		]);
		const restored = restoreColumnStore(snapshotColumnStore(store));
		const arch = restored.archetypes.get(0)!;
		expect(arch.componentMask[0]).toBe(0xdead_beef);
		expect(arch.componentMask[1]).toBe(0xcafe_f00d);
	});

	it("preserves multi-archetype layout", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }]),
			spec(1, 8, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f32 }])
		]);
		const restored = restoreColumnStore(snapshotColumnStore(store));
		expect(restored.archetypes.size).toBe(2);
		expect(restored.archetypes.get(0)!.rowCapacity).toBe(4);
		expect(restored.archetypes.get(1)!.rowCapacity).toBe(8);
	});

	it("writes to the restored SAB do NOT affect the original", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const origCol = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		origCol[0] = 42;

		const restored = restoreColumnStore(snapshotColumnStore(store));
		const rcol = restored.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		rcol[0] = 99;

		expect(origCol[0]).toBe(42);
		expect(rcol[0]).toBe(99);
	});

	it("accepts a sliced Uint8Array (non-zero byteOffset)", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const orig = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		orig[0] = 77;

		// Copy snapshot into the middle of a regular ArrayBuffer, then
		// restore from a subarray pointing at that region.
		const padded = new Uint8Array(8 + store.buffer.byteLength);
		padded.set(snapshotColumnStore(store), 8);
		const view = padded.subarray(8);

		const restored = restoreColumnStore(view);
		const rcol = restored.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		expect(rcol[0]).toBe(77);
	});
});

describe("restore_column_store rejection", () => {
	it("rejects bytes shorter than the header", () => {
		const tiny = new Uint8Array(STORE_HEADER_BYTES - 1);
		// Even with the right magic, missing the rest of the header is fatal.
		new DataView(tiny.buffer).setUint32(STORE_HEADER_OFFSETS.magic, STORE_MAGIC, true);
		expect(() => restoreColumnStore(tiny)).toThrow(StoreRestoreError);
	});

	it("rejects bytes with the wrong magic", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const snap = new Uint8Array(snapshotColumnStore(store)); // copy
		// Corrupt magic.
		new DataView(snap.buffer).setUint32(STORE_HEADER_OFFSETS.magic, 0xff_ff_ff_ff, true);
		expect(() => restoreColumnStore(snap)).toThrow(/bad magic/);
	});

	it("rejects bytes with an incompatible sim_abi_version", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const snap = new Uint8Array(snapshotColumnStore(store));
		new DataView(snap.buffer).setUint32(STORE_HEADER_OFFSETS.sim_abi_version, 999, true);
		expect(() => restoreColumnStore(snap)).toThrow(/incompatible sim_abi_version/);
	});

	// The header checks above cover length-for-header + magic + ABI, but the
	// layout-descriptor region itself was trusted: a snapshot that passes them
	// yet whose descriptor offset / column extents read past the buffer used to
	// surface a raw `RangeError`. Both paths now throw `StoreRestoreError` so a
	// caller sees one error class for every malformed input.
	it("rejects an out-of-range layout_descriptor_off", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const snap = new Uint8Array(snapshotColumnStore(store)); // copy
		// Point the descriptor region far past the end of the snapshot. Magic +
		// ABI still validate, so this exercises the new offset bound, not the
		// pre-existing header guards.
		new DataView(snap.buffer).setUint32(
			STORE_HEADER_OFFSETS.layout_descriptor_off,
			0xffff_ffff,
			true
		);
		expect(() => restoreColumnStore(snap)).toThrow(StoreRestoreError);
	});

	it("rejects a truncated snapshot whose descriptors read past the buffer", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const full = new Uint8Array(snapshotColumnStore(store)); // copy
		// Keep just enough bytes to clear the header length check, but truncate
		// the layout-descriptor region away while archetype_count stays nonzero.
		// Reading the (now-absent) descriptors runs off the end of the buffer;
		// the raw RangeError must be re-thrown as StoreRestoreError.
		expect(readStoreHeader(new DataView(full.buffer)).archetypeCount).toBeGreaterThan(0);
		const truncated = full.slice(0, STORE_HEADER_BYTES);
		expect(() => restoreColumnStore(truncated)).toThrow(StoreRestoreError);
	});
});

describe("snapshot equality / determinism", () => {
	it("two stores built from the same specs + same writes snapshot identically", () => {
		const makeStore = () => {
			const s = createColumnStore([
				spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
			]);
			const col = s.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
			col[0] = 1;
			col[1] = 2;
			col[2] = 3;
			return s;
		};

		const a = snapshotColumnStore(makeStore());
		const b = snapshotColumnStore(makeStore());
		expect(b).toEqual(a);
	});

	it("snapshot bytes differ if any column byte differs (no hidden state)", () => {
		const s1 = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const s2 = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		(s1.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 7;
		(s2.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 8;
		expect(new Uint8Array(s2.buffer)).not.toEqual(new Uint8Array(s1.buffer));
	});
});
