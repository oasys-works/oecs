/**
 * Generic consumer region registry (it de-games the SAB substrate).
 *
 * The load-bearing acceptance claim: a consumer can declare an
 * ARBITRARY named region (a `region_id` the engine has never heard of) and the
 * engine lays it out, addresses it through the generic region-table directory,
 * and — crucially — snapshots and restores it across a SAB grow without knowing
 * anything about its contents. No game concept (terrain / spatial-grid / … )
 * appears anywhere in this file: the regions here are fabricated.
 */

import { describe, expect, it } from "vitest";
import {
	createColumnStore,
	extendColumnStore,
	findRegionEntry,
	findRegionOffset,
	growColumnStore,
	growableSabAllocator,
	readHeaderRegionTable,
	validateRegionSpecs,
	RegionRegistryError,
	REGION_TABLE_ENTRY_BYTES,
	STORE_HEADER_OFFSETS,
	TYPE_TAG,
	type ArchetypeSpec,
	type StoreRegionSpec
} from "..";

// Fabricated region ids — deliberately NOT any GAME_REGION_ID. The engine
// treats them as opaque tokens.
const FABRICATED_ID = 0xbeef;
const OTHER_ID = 0x1234;

/** A fabricated region whose `init` stamps `marker` as the first u32, so a test
 * can prove `init` ran and that bytes survive a realloc. */
function fabricatedRegion(id: number, bytes: number, marker: number): StoreRegionSpec {
	return {
		id,
		name: `fab-${id}`,
		bytes,
		init: (view, off) => view.setUint32(off, marker, true)
	};
}

const ARCH: ArchetypeSpec = {
	archetypeId: 1,
	componentMask: [0b1, 0, 0, 0],
	rowCapacity: 4,
	columns: [{ componentId: 0, fieldId: 0, typeTag: TYPE_TAG.u32 }]
};

describe("generic consumer region table", () => {
	it("lays out a fabricated non-game region and resolves it by id", () => {
		const store = createColumnStore([ARCH], undefined, {
			regions: [fabricatedRegion(FABRICATED_ID, 64, 0xcafe_f00d)]
		});

		const off = findRegionOffset(store.view, FABRICATED_ID);
		expect(off).toBeGreaterThan(0);
		// `init` ran: the marker is at the region's first u32.
		expect(store.view.getUint32(off, true)).toBe(0xcafe_f00d);

		// The header directory carries exactly one self-describing entry.
		const table = readHeaderRegionTable(store.view);
		expect(table).toHaveLength(1);
		expect(table[0]).toMatchObject({ regionId: FABRICATED_ID, byteOffset: off, byteLength: 64 });

		// An id the consumer never declared resolves to the absent sentinel 0.
		expect(findRegionOffset(store.view, 0x9999)).toBe(0);
		expect(findRegionEntry(store.view, 0x9999)).toBeNull();
	});

	it("has no region table when no consumer regions are declared", () => {
		const store = createColumnStore([ARCH]);
		expect(store.header.regionTableOff).toBe(0);
		expect(store.header.regionTableCount).toBe(0);
		expect(findRegionOffset(store.view, FABRICATED_ID)).toBe(0);
		expect(readHeaderRegionTable(store.view)).toHaveLength(0);
	});

	it("snapshots and restores a fabricated region's live bytes across a grow", () => {
		const store = createColumnStore([ARCH], undefined, {
			regions: [fabricatedRegion(FABRICATED_ID, 64, 0)]
		});
		const off0 = findRegionOffset(store.view, FABRICATED_ID);
		// Write live bytes AFTER init — these are the consumer's runtime state
		// that must survive a realloc (the class of data once lost for the
		// mechanism regions; here we prove it for a consumer region).
		store.view.setUint32(off0 + 8, 0xdead_beef, true);
		store.view.setUint32(off0 + 60, 0x0bad_cafe, true); // last u32 in the 64-byte region

		// Extend with a new archetype. The default allocator is not in-place, so
		// this takes the realloc-and-republish slow path — i.e. it exercises
		// `snapshotPrefixRegions` / `restorePrefixRegions` for the consumer
		// region, not just the mechanism regions.
		const result = extendColumnStore(store, {
			newArchetypes: [{ ...ARCH, archetypeId: 2 }]
		});
		expect(result.viewsPreserved).toBe(false); // confirms the slow path ran

		const off1 = findRegionOffset(result.store.view, FABRICATED_ID);
		expect(off1).toBeGreaterThan(0);
		// The live bytes survived the grow.
		expect(result.store.view.getUint32(off1 + 8, true)).toBe(0xdead_beef);
		expect(result.store.view.getUint32(off1 + 60, true)).toBe(0x0bad_cafe);
	});

	it("supports multiple fabricated regions, each independently addressable", () => {
		const store = createColumnStore([ARCH], undefined, {
			regions: [
				fabricatedRegion(FABRICATED_ID, 32, 0xaaaa_aaaa),
				fabricatedRegion(OTHER_ID, 48, 0xbbbb_bbbb)
			]
		});
		expect(store.view.getUint32(findRegionOffset(store.view, FABRICATED_ID), true)).toBe(
			0xaaaa_aaaa
		);
		expect(store.view.getUint32(findRegionOffset(store.view, OTHER_ID), true)).toBe(0xbbbb_bbbb);
		expect(findRegionEntry(store.view, OTHER_ID)).toMatchObject({
			regionId: OTHER_ID,
			byteLength: 48
		});
		// Distinct offsets — the two regions don't overlap.
		expect(findRegionOffset(store.view, FABRICATED_ID)).not.toBe(
			findRegionOffset(store.view, OTHER_ID)
		);
	});

	it("rejects invalid region sets (zero id, duplicate id, non-positive size)", () => {
		expect(() => validateRegionSpecs([fabricatedRegion(0, 16, 0)])).toThrow(RegionRegistryError);
		expect(() =>
			validateRegionSpecs([fabricatedRegion(1, 16, 0), fabricatedRegion(1, 16, 0)])
		).toThrow(RegionRegistryError);
		expect(() => validateRegionSpecs([{ id: 1, name: "x", bytes: 0, init: () => {} }])).toThrow(
			RegionRegistryError
		);
		// createColumnStore applies the same validation.
		expect(() =>
			createColumnStore([ARCH], undefined, { regions: [fabricatedRegion(0, 16, 0)] })
		).toThrow(RegionRegistryError);
	});
});

// The slow-path `extendColumnStore` round-trip above proves consumer regions
// survive a realloc. These cover the OTHER three realloc shapes the substrate
// can take, so every path that touches a consumer region is exercised:
//   - in-place `extendColumnStore` (growable allocator): the region must NOT be
//     snapshotted/restored — it sits before the descriptor tail and stays put,
//     so its bytes and offset are carried forward verbatim.
//   - realloc `growColumnStore` (default allocator): a RESIZE, not an append —
//     routes the region through `snapshotPrefixRegions` / `restorePrefixRegions`
//     exactly like the extend slow path.
//   - in-place `growColumnStore` (growable allocator): like the in-place extend,
//     the region is untouched while only the grown archetype's columns relocate.
describe("consumer regions survive every grow/extend path", () => {
	it("carries a consumer region across an IN-PLACE extend (growable allocator)", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const store = createColumnStore([ARCH], alloc, {
			reservedDescriptorBytes: 4096,
			regions: [fabricatedRegion(FABRICATED_ID, 64, 0xcafe_f00d)]
		});
		const off0 = findRegionOffset(store.view, FABRICATED_ID);
		store.view.setUint32(off0 + 8, 0xfeed_face, true); // live runtime byte

		const result = extendColumnStore(
			store,
			{ newArchetypes: [{ ...ARCH, archetypeId: 2 }] },
			alloc
		);
		expect(result.viewsPreserved).toBe(true); // confirms the in-place fast path ran

		// In-place never relocates the region (it precedes the descriptor tail),
		// so neither its offset nor its bytes change — no snapshot/restore involved.
		const off1 = findRegionOffset(result.store.view, FABRICATED_ID);
		expect(off1).toBe(off0);
		expect(result.store.view.getUint32(off1, true)).toBe(0xcafe_f00d); // init marker
		expect(result.store.view.getUint32(off1 + 8, true)).toBe(0xfeed_face); // live byte
	});

	it("snapshots and restores a consumer region across a grow_column_store realloc", () => {
		const store = createColumnStore([ARCH], undefined, {
			regions: [fabricatedRegion(FABRICATED_ID, 64, 0)]
		});
		const off0 = findRegionOffset(store.view, FABRICATED_ID);
		store.view.setUint32(off0 + 8, 0xdead_beef, true);
		store.view.setUint32(off0 + 60, 0x0bad_cafe, true); // last u32 in the region

		// Resize the existing archetype. The default allocator is not in-place, so
		// this takes the realloc path — the grow-side twin of the extend slow path.
		const result = growColumnStore(store, {
			archetypes: [{ archetypeId: 1, newRowCapacity: 16, rowCount: 0 }]
		});
		expect(result.viewsPreserved).toBe(false); // confirms the realloc path ran

		const off1 = findRegionOffset(result.store.view, FABRICATED_ID);
		expect(off1).toBeGreaterThan(0);
		expect(result.store.view.getUint32(off1 + 8, true)).toBe(0xdead_beef);
		expect(result.store.view.getUint32(off1 + 60, true)).toBe(0x0bad_cafe);
	});

	it("carries a consumer region across an IN-PLACE grow (growable allocator)", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const store = createColumnStore([ARCH], alloc, {
			reservedDescriptorBytes: 4096,
			regions: [fabricatedRegion(FABRICATED_ID, 64, 0xcafe_f00d)]
		});
		const off0 = findRegionOffset(store.view, FABRICATED_ID);
		store.view.setUint32(off0 + 8, 0xfeed_beef, true);

		const result = growColumnStore(
			store,
			{ archetypes: [{ archetypeId: 1, newRowCapacity: 16, rowCount: 0 }] },
			alloc
		);
		expect(result.viewsPreserved).toBe(true); // confirms the in-place grow fast path ran

		const off1 = findRegionOffset(result.store.view, FABRICATED_ID);
		expect(off1).toBe(off0); // region precedes the descriptor region — untouched by the grow
		expect(result.store.view.getUint32(off1, true)).toBe(0xcafe_f00d);
		expect(result.store.view.getUint32(off1 + 8, true)).toBe(0xfeed_beef);
	});
});
// The header-driven readers trust `region_table_count`, but a corrupt or
// foreign SAB (passes `isValidSab`'s length + magic + ABI check) can carry a
// garbage count. Reading it blindly drives a huge `new Array(count)` and
// out-of-bounds `getUint32` reads — surfacing a raw `RangeError` rather than a
// typed registry error. The readers now bound `tableOff + count*ENTRY_BYTES`
// against the buffer and throw `RegionRegistryError`.
describe("header region-table readers reject an overrunning count", () => {
	/** A standalone DataView with the header's `region_table_off` pointing just
	 * past the header and a `region_table_count` whose directory runs past the
	 * end of the buffer. Only the two header fields the readers consult are
	 * written; everything else is zero. */
	function corruptCountView(): DataView {
		// Small buffer: header + room for one entry. The count below claims many
		// more entries than fit, so the directory overruns.
		const tableOff = STORE_HEADER_OFFSETS.region_table_off + 64;
		const bytes = tableOff + REGION_TABLE_ENTRY_BYTES; // room for exactly one entry
		const view = new DataView(new ArrayBuffer(bytes));
		view.setUint32(STORE_HEADER_OFFSETS.region_table_off, tableOff, true);
		// 1000 entries at 12 B each = 12 KB, far past the few-hundred-byte buffer.
		view.setUint32(STORE_HEADER_OFFSETS.region_table_count, 1000, true);
		return view;
	}

	it("read_header_region_table throws RegionRegistryError, not a raw RangeError", () => {
		const view = corruptCountView();
		expect(() => readHeaderRegionTable(view)).toThrow(RegionRegistryError);
	});

	it("find_region_offset throws RegionRegistryError on an overrunning count", () => {
		const view = corruptCountView();
		expect(() => findRegionOffset(view, FABRICATED_ID)).toThrow(RegionRegistryError);
	});

	it("find_region_entry throws RegionRegistryError on an overrunning count", () => {
		const view = corruptCountView();
		expect(() => findRegionEntry(view, FABRICATED_ID)).toThrow(RegionRegistryError);
	});
});
