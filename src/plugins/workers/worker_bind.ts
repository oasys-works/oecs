/***
 * The worker's whole view of the world: a walk of the store bytes.
 *
 * A worker holds the store buffer and the store base, and nothing else. The
 * archetype graph, the component registry and the query cache are main-thread
 * objects. The header, the layout descriptor and the columns are bytes, so a
 * worker resolves a dense query and finds a column from `(component_id,
 * field_id)` alone. This file is that walk.
 *
 * Every offset the store writes is measured from the store base, so each read
 * here adds the base.
 *
 * The walk is linear in the total column count and is not free. Run it when
 * `view_stamp` moves, and cache what it gives back.
 *
 * This module imports the ABI constants and nothing else. The worker entry runs
 * outside the bundler, so every import in its chain names the file with its
 * extension.
 ***/

import {
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COLUMN_DESCRIPTOR_BYTES,
	COLUMN_DESCRIPTOR_OFFSETS,
	COMPONENT_MASK_WORDS,
	STORE_HEADER_OFFSETS
} from "../../core/store/vendored_abi/abi.ts";

type ColumnView =
	| Uint8Array
	| Int8Array
	| Uint16Array
	| Int16Array
	| Uint32Array
	| Int32Array
	| Float32Array
	| Float64Array;

/** Constructor for each `type_tag`, indexed by the tag value. The order is the
 * one `TYPE_TAG` fixes in the descriptor. */
const TAG_CTOR = [
	Uint8Array,
	Int8Array,
	Uint16Array,
	Int16Array,
	Uint32Array,
	Int32Array,
	Float32Array,
	Float64Array
] as const;

/** One matched archetype, bound for one kernel. */
export interface BoundArchetype {
	/** Where this archetype's descriptor starts, so the enabled row count can be
	 * re-read each frame without another walk. */
	readonly descriptorOff: number;
	/** A typed array over each declared column, spanning the whole archetype.
	 * Empty for a wasm kernel, which addresses bytes instead. */
	readonly views: ColumnView[];
	/** The absolute byte offset of each declared column's first row. Empty for a
	 * js kernel, which indexes a view instead. */
	readonly offsets: number[];
}

export function readViewStamp(buffer: ArrayBufferLike, storeBase: number): number {
	return new DataView(buffer).getUint32(storeBase + STORE_HEADER_OFFSETS.view_stamp, true);
}

/** The enabled row count of one bound archetype, without another walk. The host
 * republishes it before every dispatch, so a worker that caches its bind still
 * reads a fresh count each frame. */
export function readEnabledCount(buffer: ArrayBufferLike, descriptorOff: number): number {
	return new DataView(buffer).getUint32(
		descriptorOff + ARCHETYPE_DESCRIPTOR_OFFSETS.enabled_count,
		true
	);
}

/**
 * Walk the descriptor region once and bind every archetype the masks match.
 *
 * `specs` is a flat list of `(component_id, field_id)` pairs in the kernel's
 * argument order, so a kernel indexes and never searches. An archetype that
 * matches the masks but lacks one named column is skipped, which is what keeps
 * a tag-only archetype out of the list.
 *
 * `wantViews` picks the bind form. A js kernel takes typed arrays, a wasm
 * kernel takes byte offsets. Building both would cost one allocation per column
 * that no kernel reads.
 *
 * Cold path. Call it on a `view_stamp` change.
 */
export function bindArchetypes(
	buffer: ArrayBufferLike,
	storeBase: number,
	specs: Int32Array,
	include: Uint32Array,
	exclude: Uint32Array | null,
	wantViews: boolean
): BoundArchetype[] {
	const dv = new DataView(buffer);
	const archetypeCount = dv.getUint32(storeBase + STORE_HEADER_OFFSETS.archetype_count, true);
	let off =
		storeBase + dv.getUint32(storeBase + STORE_HEADER_OFFSETS.layout_descriptor_off, true);
	const wantCount = specs.length >> 1;
	const out: BoundArchetype[] = [];

	for (let a = 0; a < archetypeCount; a++) {
		const columnCount = dv.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.column_count, true);
		const next = off + ARCHETYPE_DESCRIPTOR_HEADER_BYTES + columnCount * COLUMN_DESCRIPTOR_BYTES;
		if (columnCount === 0) {
			off = next;
			continue;
		}
		let matches = true;
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			const mask = dv.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.component_mask + w * 4, true);
			if ((mask & include[w]) !== include[w]) {
				matches = false;
				break;
			}
			if (exclude !== null && (mask & exclude[w]) !== 0) {
				matches = false;
				break;
			}
		}
		if (!matches) {
			off = next;
			continue;
		}

		const rowCapacity = dv.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_capacity, true);
		const colBase = off + ARCHETYPE_DESCRIPTOR_HEADER_BYTES;
		const views: ColumnView[] = wantViews ? new Array<ColumnView>(wantCount) : [];
		const offsets: number[] = wantViews ? [] : new Array<number>(wantCount);
		let found = 0;
		for (let c = 0; c < columnCount && found < wantCount; c++) {
			const co = colBase + c * COLUMN_DESCRIPTOR_BYTES;
			const cid = dv.getUint16(co + COLUMN_DESCRIPTOR_OFFSETS.component_id, true);
			const fid = dv.getUint16(co + COLUMN_DESCRIPTOR_OFFSETS.field_id, true);
			// No break on the first hit. A `(component_id, field_id)` pair is
			// unique inside one archetype, so a column that matches two slots
			// means the kernel named the same field twice, and both slots must
			// still be filled.
			for (let s = 0; s < wantCount; s++) {
				if (specs[s * 2] !== cid || specs[s * 2 + 1] !== fid) continue;
				const address =
					storeBase + dv.getUint32(co + COLUMN_DESCRIPTOR_OFFSETS.byte_off, true);
				if (wantViews) {
					const Ctor = TAG_CTOR[dv.getUint8(co + COLUMN_DESCRIPTOR_OFFSETS.type_tag)];
					views[s] = new Ctor(buffer, address, rowCapacity);
				} else {
					offsets[s] = address;
				}
				found++;
			}
		}
		if (found === wantCount) out.push({ descriptorOff: off, views, offsets });
		off = next;
	}
	return out;
}

/**
 * The half-open row range worker `index` owns of an archetype with `rows`
 * enabled rows.
 *
 * Every worker computes this from the same inputs with the same integer
 * arithmetic, so no plan crosses the wire and no two workers can disagree about
 * who owns a row. The main thread never computes it, which is what makes the
 * split deterministic.
 */
export function rangeBegin(rows: number, index: number, count: number): number {
	return Math.floor((rows * index) / count);
}
