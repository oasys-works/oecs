import { describe, expect, it } from "vitest";

import {
	columnKey,
	createColumnStore,
	fnv1a32,
	FNV1A_OFFSET_BASIS,
	FNV1A_PRIME,
	growColumnStore,
	restoreColumnStore,
	columnStoreStateHash,
	columnStoreBytesView,
	TYPE_TAG,
	type ArchetypeSpec
} from "..";

function spec(
	archetypeId: number,
	rowCapacity: number,
	cols: { componentId: number; fieldId: number; typeTag: number }[]
): ArchetypeSpec {
	return {
		archetypeId,
		componentMask: [0, 0, 0, 0],
		rowCapacity,
		columns: cols.map((c) => ({
			componentId: c.componentId,
			fieldId: c.fieldId,
			typeTag: c.typeTag as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
		}))
	};
}

describe("fnv1a32, known vectors", () => {
	// Reference values from the FNV-1a (32-bit) test suite:
	//   http://www.isthe.com/chongo/tech/comp/fnv/index.html#FNV-test-vectors
	// (also reproduced in ietf draft-eastlake-fnv).
	it("empty input returns the offset basis", () => {
		expect(fnv1a32(new Uint8Array(0))).toBe(FNV1A_OFFSET_BASIS);
		expect(fnv1a32(new Uint8Array(0))).toBe(0x811c9dc5);
	});

	it('"a" hashes to 0xe40c292c', () => {
		expect(fnv1a32(new Uint8Array([0x61]))).toBe(0xe40c292c);
	});

	it('"foobar" hashes to 0xbf9cf968', () => {
		const bytes = new TextEncoder().encode("foobar");
		expect(fnv1a32(bytes)).toBe(0xbf9cf968);
	});

	it("result is always an unsigned 32-bit number", () => {
		// A single high byte forces the prime multiplication into a value that
		// would be negative under signed interpretation, must come back
		// unsigned.
		const h = fnv1a32(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(0x1_0000_0000);
		expect(Number.isInteger(h)).toBe(true);
	});

	it("matches a hand-rolled reference for a small buffer", () => {
		// Compute the same hash by inlining the algorithm to guard against
		// silent constant drift in the implementation.
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x80, 0xff]);
		let ref = FNV1A_OFFSET_BASIS;
		for (let i = 0; i < bytes.length; i++) {
			ref ^= bytes[i]!;
			ref = Math.imul(ref, FNV1A_PRIME);
		}
		expect(fnv1a32(bytes)).toBe(ref >>> 0);
	});

	it("differs when a single byte changes", () => {
		const a = fnv1a32(new Uint8Array([1, 2, 3, 4]));
		const b = fnv1a32(new Uint8Array([1, 2, 3, 5]));
		expect(a).not.toBe(b);
	});

	it("is order-sensitive", () => {
		const a = fnv1a32(new Uint8Array([1, 2, 3, 4]));
		const b = fnv1a32(new Uint8Array([4, 3, 2, 1]));
		expect(a).not.toBe(b);
	});

	it("handles subarrays with a non-zero byteOffset", () => {
		const padded = new Uint8Array([0xaa, 0xbb, 0xcc, 1, 2, 3, 4]);
		const sub = padded.subarray(3); // [1,2,3,4]
		expect(fnv1a32(sub)).toBe(fnv1a32(new Uint8Array([1, 2, 3, 4])));
	});
});

describe("columnStoreStateHash, determinism", () => {
	it("identical stores hash identically", () => {
		const make = () => {
			const s = createColumnStore([
				spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
			]);
			const col = s.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
			col[0] = 10;
			col[1] = 20;
			col[2] = 30;
			return s;
		};
		expect(columnStoreStateHash(make())).toBe(columnStoreStateHash(make()));
	});

	it("agrees with fnv1a32 over the snapshot", () => {
		const store = createColumnStore([
			spec(0, 4, [
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
				{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }
			])
		]);
		(store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 7;
		(store.archetypes.get(0)!.columns.get(columnKey(2, 0))!.view as Float64Array)[0] = 1.5;

		expect(columnStoreStateHash(store)).toBe(fnv1a32(columnStoreBytesView(store)));
	});
});

describe("columnStoreStateHash, byte sensitivity", () => {
	it("changes when a column byte changes", () => {
		const make = () =>
			createColumnStore([spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])]);

		const a = make();
		const b = make();
		(a.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 100;
		(b.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 101;

		expect(columnStoreStateHash(a)).not.toBe(columnStoreStateHash(b));
	});

	it("the hash drifts as more rows are written", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const col = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;

		const h0 = columnStoreStateHash(store);
		col[0] = 1;
		const h1 = columnStoreStateHash(store);
		col[1] = 2;
		const h2 = columnStoreStateHash(store);

		expect(h0).not.toBe(h1);
		expect(h1).not.toBe(h2);
		expect(h0).not.toBe(h2);
	});

	it("differs for stores with different archetype layouts even when no rows are written", () => {
		const a = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const b = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.f32 }])
		]);
		// Same row capacity, same column key, but different type_tag, that
		// has to show up in the snapshot bytes (descriptor region) and
		// therefore in the hash.
		expect(columnStoreStateHash(a)).not.toBe(columnStoreStateHash(b));
	});
});

describe("columnStoreStateHash, round-trip", () => {
	it("snapshot → restore preserves the hash", () => {
		const store = createColumnStore([
			spec(0, 4, [
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
				{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }
			])
		]);
		(store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 42;
		(store.archetypes.get(0)!.columns.get(columnKey(2, 0))!.view as Float64Array)[0] = 3.14;

		const restored = restoreColumnStore(columnStoreBytesView(store));
		expect(columnStoreStateHash(restored)).toBe(columnStoreStateHash(store));
	});

	it("hash changes after a grow (view_stamp bumped, capacity grew)", () => {
		const store = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const before = columnStoreStateHash(store);

		const { store: grown } = growColumnStore(store, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		const after = columnStoreStateHash(grown);

		// Header field `view_stamp` and `capacity` both changed, plus the
		// trailing padding region grew. The hash must reflect that, the
		// snapshot bytes are not the same.
		expect(after).not.toBe(before);
	});
});

describe("columnStoreStateHash, page-rounding allocators", () => {
	const PAGE = 64 * 1024;

	/** Mimics `wasmMemoryAllocator` and `growableSabAllocator`. Rounds the
	 * requested byte count up to the next 64 KiB page, so the returned
	 * `SharedArrayBuffer` is larger than `capacity`. The SAB header still
	 * records the exact `capacity`. */
	const pageRoundingAllocator = (bytes: number): SharedArrayBuffer =>
		new SharedArrayBuffer(Math.ceil(bytes / PAGE) * PAGE);

	const make = (allocator?: (bytes: number) => SharedArrayBuffer) => {
		const s = createColumnStore(
			[spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			allocator
		);
		const col = s.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		col[0] = 10;
		col[1] = 20;
		col[2] = 30;
		return s;
	};

	it("snapshot is sized to header.capacity, not the padded buffer.byteLength", () => {
		const store = make(pageRoundingAllocator);
		// The allocator handed back a full page. The canonical size is smaller.
		expect(store.buffer.byteLength).toBe(PAGE);
		expect(store.header.capacity).toBeLessThan(store.buffer.byteLength);

		expect(columnStoreBytesView(store).byteLength).toBe(store.header.capacity);
	});

	it("hashes identically to a default-allocator store of the same logical state", () => {
		// Same logical state, different allocators (default = exact size,
		// page-rounding = padded). The trailing page slack must not leak into
		// the hash, or determinism checks would false-alarm across allocators.
		expect(columnStoreStateHash(make())).toBe(columnStoreStateHash(make(pageRoundingAllocator)));
	});

	it("round-trips without growing the SAB", () => {
		const store = make(pageRoundingAllocator);
		const restored = restoreColumnStore(columnStoreBytesView(store));

		// restore allocates exactly the snapshot length. Sizing the snapshot to
		// capacity means the round-trip lands back at capacity instead of
		// silently inheriting (and re-padding) the page slack.
		expect(restored.buffer.byteLength).toBe(store.header.capacity);
		expect(columnStoreStateHash(restored)).toBe(columnStoreStateHash(store));
	});
});
