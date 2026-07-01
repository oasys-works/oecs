/**
 * Generic SAB region table — the de-gamed replacement for the five game-named
 * header offset fields (`terrain_off`, `spatial_grid_off`, … ) the substrate
 * used to hard-code (#623 / ADR-0018).
 *
 * The engine ships only genuinely-generic MECHANISM regions (the command /
 * event / action rings and the entity-index) as named `StoreHeader` fields. A
 * CONSUMER (a game) declares the named regions IT wants — terrain, a spatial
 * grid, whatever — as `StoreRegionSpec`s; the engine lays each out after the
 * mechanism regions, writes a `RegionTableEntry` `(region_id, byte_offset,
 * byte_length)` into a directory at `header.region_table_off`, snapshots and
 * restores it across a SAB grow/extend, and exposes a generic
 * `regionHandle(id)`. The engine NEVER interprets `region_id` — it is a
 * consumer-owned token the consumer also resolves on the read side
 * (`findRegionOffset` here, `abi.find_region` in Zig).
 *
 * The directory is self-describing: each entry carries the region's full byte
 * length, so the realloc snapshot/restore path copies a region across a grow
 * without knowing its internal shape (no per-region `readOptions` closure to
 * carry forward, unlike the mechanism registry).
 *
 * Layout (mirrors the `RegionTableEntry` extern struct in
 * `packages/sim/src/abi.zig`; offsets generated into `__generated__/abi.ts`):
 *
 *   [ entry 0: { region_id: u32, byte_offset: u32, byte_length: u32 } ]
 *   [ entry 1: ... ]
 *   ...
 */

import {
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS,
	STORE_HEADER_OFFSETS
} from "./__generated__/abi";

export { REGION_TABLE_ENTRY_BYTES, REGION_TABLE_ENTRY_OFFSETS };

/** A consumer-declared SAB region. The consumer owns `id` (a nonzero integer,
 * distinct within its region set, that it also resolves on the read side),
 * computes `bytes`, and seeds the region header + contents in `init`.
 *
 * `init` runs ONCE at first allocation. Across a SAB grow/extend the region's
 * live bytes are snapshotted and restored verbatim (the table is
 * self-describing), so `init` is not re-run — a consumer must not rely on it
 * firing per realloc. */
export interface StoreRegionSpec {
	/** Consumer-owned region id (nonzero, distinct). Written to the directory;
	 * resolved by the consumer via `findRegionOffset` / `abi.find_region`. */
	readonly id: number;
	/** Human label for diagnostics / the self-documenting directory dump. */
	readonly name: string;
	/** Byte size to allocate for this region (consumer computes from its knobs).
	 * Must be > 0. */
	readonly bytes: number;
	/** Initialise the region header + seed bytes at absolute byte offset `off`. */
	readonly init: (view: DataView, off: number) => void;
}

/** One decoded directory record. */
export interface RegionTableEntry {
	readonly regionId: number;
	readonly byteOffset: number;
	readonly byteLength: number;
}

/** A resolved handle to a consumer region, returned by `ECS.regionHandle` /
 * `Store.regionHandle`. Carries the live `buffer`/`view` plus the region's byte
 * `offset` and full `bytes`, so a consumer's region module can build a
 * TypedArray view over exactly the region's span without re-reading the
 * directory. Re-fetch after a SAB grow (the offset/view may have moved). */
export interface ColumnStoreRegionHandle {
	/** `ArrayBufferLike` — see `ColumnStore.buffer`. Consumer regions are a SAB-profile
	 * feature (WASM/worker), so in practice this is a `SharedArrayBuffer` wherever
	 * regions are declared; the type is widened only because it flows from the
	 * backing-agnostic store. */
	readonly buffer: ArrayBufferLike;
	readonly view: DataView;
	readonly offset: number;
	readonly bytes: number;
}

export class RegionRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegionRegistryError";
	}
}

/** Bytes a region-table directory of `count` entries occupies. */
export function regionTableBytes(count: number): number {
	return count * REGION_TABLE_ENTRY_BYTES;
}

/** Read `region_table_count` from the header and validate the directory fits
 * within the buffer. `isValidSab` checks only header-length + magic + ABI, so a
 * corrupt / foreign store buffer can carry a garbage count that would drive a huge
 * `new Array(count)` and out-of-bounds `getUint32` reads. Reject with a typed
 * error before any entry is touched. (#729) */
function readHeaderRegionTableCount(view: DataView, tableOff: number): number {
	const count = view.getUint32(STORE_HEADER_OFFSETS.region_table_count, true);
	if (tableOff + regionTableBytes(count) > view.byteLength) {
		throw new RegionRegistryError(
			`region table of ${count} entries at byte ${tableOff} overruns the buffer (${view.byteLength} bytes)`
		);
	}
	return count;
}

/** Validate a consumer region set before layout: ids must be nonzero (0 is the
 * "absent" sentinel `findRegionOffset` returns) and distinct, and each region
 * must request a positive byte size. Throws `RegionRegistryError` otherwise —
 * the same loud-failure stance the mechanism registry's paired-knob guards take. */
export function validateRegionSpecs(regions: readonly StoreRegionSpec[]): void {
	const seen = new Set<number>();
	for (let i = 0; i < regions.length; i++) {
		const r = regions[i];
		if (!Number.isInteger(r.id) || r.id <= 0) {
			throw new RegionRegistryError(
				`region "${r.name}" has invalid id ${r.id} — region ids must be positive integers (0 is the absent sentinel)`
			);
		}
		if (seen.has(r.id)) {
			throw new RegionRegistryError(
				`duplicate region id ${r.id} (region "${r.name}") — ids must be distinct within a consumer's region set`
			);
		}
		seen.add(r.id);
		if (!Number.isInteger(r.bytes) || r.bytes <= 0) {
			throw new RegionRegistryError(
				`region "${r.name}" (id ${r.id}) has invalid byte size ${r.bytes} — must be a positive integer`
			);
		}
	}
}

/** Write one directory record at absolute byte offset `off`. */
export function writeRegionTableEntry(view: DataView, off: number, e: RegionTableEntry): void {
	view.setUint32(off + REGION_TABLE_ENTRY_OFFSETS.region_id, e.regionId, true);
	view.setUint32(off + REGION_TABLE_ENTRY_OFFSETS.byte_offset, e.byteOffset, true);
	view.setUint32(off + REGION_TABLE_ENTRY_OFFSETS.byte_length, e.byteLength, true);
}

/** Read one directory record at absolute byte offset `off`. */
export function readRegionTableEntry(view: DataView, off: number): RegionTableEntry {
	return {
		regionId: view.getUint32(off + REGION_TABLE_ENTRY_OFFSETS.region_id, true),
		byteOffset: view.getUint32(off + REGION_TABLE_ENTRY_OFFSETS.byte_offset, true),
		byteLength: view.getUint32(off + REGION_TABLE_ENTRY_OFFSETS.byte_length, true)
	};
}

/** Write the whole directory of `entries` at `tableOff`. */
export function writeRegionTable(
	view: DataView,
	tableOff: number,
	entries: readonly RegionTableEntry[]
): void {
	for (let i = 0; i < entries.length; i++) {
		writeRegionTableEntry(view, tableOff + i * REGION_TABLE_ENTRY_BYTES, entries[i]);
	}
}

/** Read all `count` directory records starting at `tableOff`, in order. */
export function readRegionTable(
	view: DataView,
	tableOff: number,
	count: number
): RegionTableEntry[] {
	const out: RegionTableEntry[] = new Array(count);
	for (let i = 0; i < count; i++) {
		out[i] = readRegionTableEntry(view, tableOff + i * REGION_TABLE_ENTRY_BYTES);
	}
	return out;
}

/** Read the directory described by the SAB header (`region_table_off` /
 * `region_table_count`). Empty when no consumer regions were declared. */
export function readHeaderRegionTable(view: DataView): RegionTableEntry[] {
	const tableOff = view.getUint32(STORE_HEADER_OFFSETS.region_table_off, true);
	if (tableOff === 0) return [];
	const count = readHeaderRegionTableCount(view, tableOff);
	return readRegionTable(view, tableOff, count);
}

/** Resolve a consumer region's byte offset by `region_id`, or 0 when absent
 * (no directory, or no matching entry). The TS twin of Zig
 * `abi.find_region(header_addr, region_id)`; 0 is an unambiguous "absent"
 * sentinel because a real region never starts at SAB byte 0 (the header does). */
export function findRegionOffset(view: DataView, regionId: number): number {
	const tableOff = view.getUint32(STORE_HEADER_OFFSETS.region_table_off, true);
	if (tableOff === 0) return 0;
	const count = readHeaderRegionTableCount(view, tableOff);
	for (let i = 0; i < count; i++) {
		const off = tableOff + i * REGION_TABLE_ENTRY_BYTES;
		if (view.getUint32(off + REGION_TABLE_ENTRY_OFFSETS.region_id, true) === regionId) {
			return view.getUint32(off + REGION_TABLE_ENTRY_OFFSETS.byte_offset, true);
		}
	}
	return 0;
}

/** Resolve a consumer region's `(byte_offset, byte_length)` by `region_id`, or
 * `null` when absent. Use when a reader needs the region's size (e.g. to
 * materialise a TypedArray view) and not just its start. */
export function findRegionEntry(view: DataView, regionId: number): RegionTableEntry | null {
	const tableOff = view.getUint32(STORE_HEADER_OFFSETS.region_table_off, true);
	if (tableOff === 0) return null;
	const count = readHeaderRegionTableCount(view, tableOff);
	for (let i = 0; i < count; i++) {
		const entry = readRegionTableEntry(view, tableOff + i * REGION_TABLE_ENTRY_BYTES);
		if (entry.regionId === regionId) return entry;
	}
	return null;
}
