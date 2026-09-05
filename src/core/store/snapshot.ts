/**
 * SAB snapshot / restore.
 *
 * An ECS snapshot is a `Uint8Array` over the SAB region up to
 * `header.capacity`, and restore copies that buffer back. With every
 * column already living inside a single `SharedArrayBuffer`,
 * snapshot collapses to "take a view over the SAB" and restore collapses
 * to "allocate a SAB of the right size, copy bytes in, re-parse the
 * descriptors to rebuild views", no per-archetype JSON traversal.
 *
 * Properties:
 *   - **Snapshot is zero-copy.** It's a TypedArray view, not an owned
 *     copy. Use it for hashing (FNV1a) or pass it to
 *     `restoreColumnStore` immediately. If you need a stable copy that
 *     survives subsequent writes to the SAB, slice the view first
 *     (`new Uint8Array(snapshot)` copies).
 *   - **Restore validates magic + ABI.** A snapshot from a SAB built with
 *     a different `SIM_ABI_VERSION` is rejected. There's no migration
 *     story across an ABI bump. Bumping it implies a new save format.
 *   - **Restore is symmetric with create.** `restore(snapshot(s))`
 *     reproduces a ColumnStore that's byte-identical to `s` (modulo the
 *     SAB instance) and whose views land at the same byte offsets.
 */

import {
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	STORE_MAGIC,
	SIM_ABI_VERSION,
	LEGACY_ABSOLUTE_ABI_VERSION,
	readStoreHeader
} from "./header";
import { readLayoutDescriptorRegion } from "./descriptor";
import { assertStoreBase, createArchetypeViews, type ColumnStore } from "./column_store";
import { DEFAULT_SAB_ALLOCATOR, type BufferAllocator } from "./allocator";
// Declared one directory up, so the snapshot plugin's own rollup graph can
// bind to the same class this module throws instead of copying it.
import { StoreRestoreError } from "../restore_errors";

export { StoreRestoreError };

/** Options for `restoreColumnStore`. */
export interface RestoreColumnStoreOptions {
	/** Byte offset inside the fresh backing where the restored header goes.
	 * Default 0. A snapshot carries no base, so a store taken at one base
	 * restores at any other. */
	readonly storeBase?: number;
}

/** Zero-copy `Uint8Array` view over the SAB's used byte range. Length is
 * `header.capacity`, the canonical size, not `buffer.byteLength`. The two
 * coincide for `DEFAULT_SAB_ALLOCATOR` (it allocates exactly `totalBytes`),
 * but `wasmMemoryAllocator` / `growableSabAllocator` round the buffer up
 * to 64 KiB page boundaries, so `buffer.byteLength` can exceed `capacity` by up
 * to a page of trailing slack (see the allocator contract in `allocator.ts`).
 * Hashing or round-tripping that slack would make two logically-identical
 * stores with different grow trajectories (or different allocators) diverge,
 * so we size to `capacity` here.
 *
 * Capacity is read live from `store.view` rather than the cached
 * `store.header`, the in-place grow path bumps the header fields in the
 * view but leaves `store.header` a stale snapshot (see `grow.ts`).
 *
 * The span starts at `store.storeBase`, so the bytes are base free: two stores
 * with the same history at different bases give the same snapshot and the same
 * digest.
 *
 * The view shares storage with the backing. Subsequent writes to columns are
 * visible through it. Callers that need a stable snapshot should slice
 * (`new Uint8Array(view)`) before mutating the store further. */
export function columnStoreBytesView(store: ColumnStore): Uint8Array {
	const capacity = store.view.getUint32(STORE_HEADER_OFFSETS.capacity, true);
	return new Uint8Array(store.buffer, store.storeBase, capacity);
}

/** Allocate a fresh backing buffer of `bytes.byteLength`, copy the snapshot
 * bytes in, validate the header, and reconstruct the `ColumnStore` (header cache +
 * DataView + per-archetype `ArchetypeViews`).
 *
 * `allocator` selects the backing: the default `DEFAULT_SAB_ALLOCATOR`
 * (`SharedArrayBuffer`) keeps existing callers' behaviour. Pass
 * `heapArrayBufferAllocator()` to round-trip a snapshot into a pure-TS heap
 * world (no SAB required). Either way only one allocation happens, restore
 * never grows, so a non-in-place allocator is fine here.
 *
 * The input can be any `Uint8Array`, a view from `columnStoreBytesView`,
 * a sliced copy, or bytes read off disk / postMessage. The function
 * honours `bytes.byteOffset` and `bytes.byteLength`, so passing a
 * subarray that doesn't start at offset 0 of its backing buffer is
 * supported.
 *
 * `options.storeBase` places the restored header at that byte offset in the
 * fresh backing, default 0. The snapshot itself carries no base, so a store
 * taken at one base restores at any other and both digests agree.
 *
 * Throws `StoreRestoreError` if the bytes are too short for the header,
 * have the wrong magic, or carry an incompatible `sim_abi_version`. */
export function restoreColumnStore(
	bytes: Uint8Array,
	allocator: BufferAllocator = DEFAULT_SAB_ALLOCATOR,
	options: RestoreColumnStoreOptions = {}
): ColumnStore {
	const storeBase = options.storeBase ?? 0;
	assertStoreBase(storeBase);
	// Validate via a DataView over the input. We do this before allocating
	// so a malformed input doesn't waste a SAB allocation.
	const inputView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	if (bytes.byteLength < STORE_HEADER_BYTES) {
		throw new StoreRestoreError(
			`snapshot too small: ${bytes.byteLength} bytes (header alone needs ${STORE_HEADER_BYTES})`
		);
	}

	const magic = inputView.getUint32(STORE_HEADER_OFFSETS.magic, true);
	if (magic !== STORE_MAGIC) {
		throw new StoreRestoreError(
			`bad magic: 0x${magic.toString(16).padStart(8, "0")} (expected 0x${STORE_MAGIC.toString(16).padStart(8, "0")})`
		);
	}

	const abi = inputView.getUint32(STORE_HEADER_OFFSETS.sim_abi_version, true);
	// Version 0 is accepted as version 1. A version 0 store always sat at buffer
	// byte 0, so every offset it wrote is also an offset from its header, which
	// is what version 1 means. The published 0.5 line wrote version 0 with this
	// header shape, and its snapshots stay restorable. The restored header is
	// stamped with the current version below.
	if (abi !== SIM_ABI_VERSION && abi !== LEGACY_ABSOLUTE_ABI_VERSION) {
		throw new StoreRestoreError(
			`incompatible sim_abi_version: snapshot=, build=`
		);
	}

	// Allocate the new backing at exactly the snapshot's byte length and copy
	// the snapshot into it. `Uint8Array.set` is the same memcpy the spec gives
	// us, bytes are bytes, shared or not.
	const buffer = allocator(storeBase + bytes.byteLength);
	new Uint8Array(buffer, storeBase, bytes.byteLength).set(bytes);

	const view = new DataView(buffer, storeBase);
	view.setUint32(STORE_HEADER_OFFSETS.sim_abi_version, SIM_ABI_VERSION, true);
	const header = readStoreHeader(view);

	// Bound the descriptor-region start, then reconstruct under a guard. The header
	// checks above cover only length-for-header + magic + ABI. The layout region
	// itself is still trusted. `readLayoutDescriptorRegion` walks
	// `archetype_count` descriptors reading an unbounded per-archetype `column_count`
	// from the buffer, and `createArchetypeViews` then builds a TypedArray per
	// column at the descriptor's `byte_off` and `row_capacity`, on a truncated and corrupt
	// snapshot both run past the buffer end and throw a raw `RangeError`. Surface a
	// typed `StoreRestoreError` instead so callers see one error class for all
	// malformed input.
	if (header.layoutDescriptorOff < 0 || header.layoutDescriptorOff > bytes.byteLength) {
		throw new StoreRestoreError(
			`layout_descriptor_off ${header.layoutDescriptorOff} is outside the snapshot (${bytes.byteLength} bytes)`
		);
	}
	try {
		const descriptors = readLayoutDescriptorRegion(
			view,
			header.layoutDescriptorOff,
			header.archetypeCount
		);
		const archetypes = createArchetypeViews(buffer, storeBase, descriptors);
		return { buffer, view, header, storeBase, archetypes };
	} catch (e) {
		if (e instanceof RangeError) {
			throw new StoreRestoreError(
				`snapshot layout is corrupt or truncated: a descriptor offset or column ` +
					`extent reads past the ${bytes.byteLength}-byte span (${e.message})`
			);
		}
		throw e;
	}
}
