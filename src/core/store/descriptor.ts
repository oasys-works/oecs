/**
 * SAB layout descriptor, the "where is each column in memory" lookup table
 * that both the WASM sim and the TS host read from. Lives in the SAB region
 * at `header.layout_descriptor_off`.
 *
 * Layout is locked by `descriptor.test.ts`'s golden bytes the same way
 * `header.test.ts` locks the header. Any schema change is a `SIM_ABI_VERSION`
 * bump (see `header.ts`).
 *
 * Region shape:
 *
 *   [ ArchetypeDescriptor 0 ]
 *   [ ArchetypeDescriptor 1 ]
 *   ...
 *
 * Each `ArchetypeDescriptor` is variable-sized: a fixed
 * `ARCHETYPE_DESCRIPTOR_HEADER_BYTES` header + N × 16-byte
 * `ColumnDescriptor`. Walk the region sequentially using `column_count` to
 * skip to the next archetype. No offset table, `archetype_count` (in the
 * SAB header) and the per-archetype `column_count` are sufficient to scan
 * deterministically.
 *
 * All fields little-endian, same rationale as `header.ts`.
 */

// Byte-layout constants re-exported from `./vendored_abi/abi`, which owns them
// and maintains them by hand. No generator produces them. Re-exported here so
// `./descriptor` importers and the `core/buffer` barrel keep the same surface.
// Golden bytes in `__tests__/descriptor.test.ts` pin the values.
//
//   - COLUMN_DESCRIPTOR_BYTES / _OFFSETS            16-byte per-column record
//   - ARCHETYPE_DESCRIPTOR_HEADER_BYTES / _OFFSETS  fixed archetype header
//   - COMPONENT_MASK_WORDS                          u32 words in the mask, and the
//                                                   one knob the component
//                                                   limit derives from
import {
	COLUMN_DESCRIPTOR_BYTES,
	COLUMN_DESCRIPTOR_OFFSETS,
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COMPONENT_MASK_WORDS
} from "./vendored_abi/abi";

export {
	COLUMN_DESCRIPTOR_BYTES,
	COLUMN_DESCRIPTOR_OFFSETS,
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COMPONENT_MASK_WORDS
};

/** type_tag values for `ColumnDescriptor.type_tag`. The order matches the
 * TypedArrayTag union in `packages/std/type_primitives` so a tag's element
 * width is `TYPE_TAG_STRIDE[tag]`. */
export const TYPE_TAG = {
	u8: 0,
	i8: 1,
	u16: 2,
	i16: 3,
	u32: 4,
	i32: 5,
	f32: 6,
	f64: 7
} as const;

export type TypeTagValue = (typeof TYPE_TAG)[keyof typeof TYPE_TAG];

/** Element width in bytes for each `TYPE_TAG`. Indexed by tag value so a
 * `stride = TYPE_TAG_STRIDE[tag]` lookup is O(1) array access. */
export const TYPE_TAG_STRIDE: Readonly<Record<TypeTagValue, number>> = Object.freeze({
	[TYPE_TAG.u8]: 1,
	[TYPE_TAG.i8]: 1,
	[TYPE_TAG.u16]: 2,
	[TYPE_TAG.i16]: 2,
	[TYPE_TAG.u32]: 4,
	[TYPE_TAG.i32]: 4,
	[TYPE_TAG.f32]: 4,
	[TYPE_TAG.f64]: 8
});

/** String-tag → numeric-tag bridge. `TypedArrayTag` ("u8", "f32", …) is the
 * vocabulary the TS-side component registry speaks. `TypeTagValue` is the
 * numeric enum the SAB descriptors carry on the wire. Bridging happens at
 * the ECS↔SAB seam. Archetype layouts come in as strings, ColumnSpecs go
 * out as integers. */
export const TYPED_ARRAY_TAG_TO_TYPE_TAG = {
	u8: TYPE_TAG.u8,
	i8: TYPE_TAG.i8,
	u16: TYPE_TAG.u16,
	i16: TYPE_TAG.i16,
	u32: TYPE_TAG.u32,
	i32: TYPE_TAG.i32,
	f32: TYPE_TAG.f32,
	f64: TYPE_TAG.f64
} as const;

// ───────────────────────── ColumnDescriptor ─────────────────────────────
//
// 16 bytes total, matches the Zig `extern struct` in `abi.zig`. Padding is
// explicit there (`_pad` and `_pad2`), alignment-friendly layout means a Zig
// `*ColumnDescriptor` and the TS `DataView` see the same byte sequence on every
// host. `COLUMN_DESCRIPTOR_BYTES` and `COLUMN_DESCRIPTOR_OFFSETS` are generated
// (see the import block above); the pad bytes are skipped in the offset table.

export interface ColumnDescriptor {
	readonly componentId: number;
	readonly fieldId: number;
	readonly typeTag: TypeTagValue;
	/** Byte offset of the column's first row, measured from the store base.
	 * A reader adds the base it mounted the store at. */
	readonly byteOff: number;
	/** Element width in bytes. Should always equal `TYPE_TAG_STRIDE[type_tag]`. */
	readonly stride: number;
}

export function writeColumnDescriptor(view: DataView, off: number, c: ColumnDescriptor): void {
	view.setUint16(off + COLUMN_DESCRIPTOR_OFFSETS.component_id, c.componentId, true);
	view.setUint16(off + COLUMN_DESCRIPTOR_OFFSETS.field_id, c.fieldId, true);
	view.setUint8(off + COLUMN_DESCRIPTOR_OFFSETS.type_tag, c.typeTag);
	// Pad bytes [off+5..off+8) are not touched. Buffers must be zeroed at
	// allocation (SAB and ArrayBuffer both zero-initialise), so the pad
	// region stays at 0x00, matching the fixture and the Zig _pad fields.
	view.setUint32(off + COLUMN_DESCRIPTOR_OFFSETS.byte_off, c.byteOff, true);
	view.setUint16(off + COLUMN_DESCRIPTOR_OFFSETS.stride, c.stride, true);
}

export function readColumnDescriptor(view: DataView, off: number): ColumnDescriptor {
	return {
		componentId: view.getUint16(off + COLUMN_DESCRIPTOR_OFFSETS.component_id, true),
		fieldId: view.getUint16(off + COLUMN_DESCRIPTOR_OFFSETS.field_id, true),
		typeTag: view.getUint8(off + COLUMN_DESCRIPTOR_OFFSETS.type_tag) as TypeTagValue,
		byteOff: view.getUint32(off + COLUMN_DESCRIPTOR_OFFSETS.byte_off, true),
		stride: view.getUint16(off + COLUMN_DESCRIPTOR_OFFSETS.stride, true)
	};
}

// ───────────────────────── ArchetypeDescriptor ─────────────────────────────
//
// ARCHETYPE_DESCRIPTOR_HEADER_BYTES header + column_count × ColumnDescriptor
// (16 bytes). The header alone is fixed-size. The descriptor as a whole is
// variable.

// `COMPONENT_MASK_WORDS` (the single knob the whole cross-language component
// limit derives from) and `ARCHETYPE_DESCRIPTOR_HEADER_BYTES` come from the
// import block above. The heap-side `BitSet` is sized to match
// (`INITIAL_WORD_COUNT`). Bumping the word count widens the descriptor on the
// wire, a `SIM_ABI_VERSION` bump.
//
// The header ends with `entity_ids_off`, a reserved field that every writer
// sets to zero. `ArchetypeDescriptor` below does not carry it, because a
// reserved field with one legal value has nothing to round trip.

/** Number of distinct components the cross-language ECS supports:
 * `COMPONENT_MASK_WORDS × 32` bits in the SAB archetype descriptor mask. The
 * Zig side matches archetypes purely on this mask, so a component whose ID is
 * ≥ this limit would be invisible there while the heap-side `BitSet` stayed
 * correct, silently conflating archetypes that differ only in such a
 * component. `Store.registerComponent` enforces this as a hard registration
 * ceiling so the overflow fails loudly instead. The mask is sized to
 * the `BitSet`'s `INITIAL_WORD_COUNT`, so a registry within the limit never
 * grows a component mask past its initial words. */
export const STORE_DESCRIPTOR_COMPONENT_LIMIT = COMPONENT_MASK_WORDS * 32;

export interface ArchetypeDescriptor {
	readonly archetypeId: number;
	/** Component bitmask, `COMPONENT_MASK_WORDS` little-endian u32 words. Word
	 * `w` holds component IDs in `[w*32, w*32+32)`. */
	readonly componentMask: readonly number[];
	readonly rowCount: number;
	readonly rowCapacity: number;
	/** Enabled-row count `≤ row_count`. Per-row entity-scan loops in
	 * the WASM sim bound on this so disabled entities (swapped to the tail
	 * `[enabled_count, row_count)`) are not simulated. Row-indexed cross-entity
	 * reads still use `row_count`. */
	readonly enabledCount: number;
	readonly columns: readonly ColumnDescriptor[];
}

/** Total bytes a descriptor will occupy, given its column count. Useful for
 * planning the layout descriptor region size up front.
 *
 * `headerBytes` selects the header width and defaults to the current one. Pass
 * `LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES` to measure a version 0 region.
 * Never pass it when planning a region the store will write. */
export function archetypeDescriptorBytes(
	columnCount: number,
	headerBytes: number = ARCHETYPE_DESCRIPTOR_HEADER_BYTES
): number {
	return headerBytes + columnCount * COLUMN_DESCRIPTOR_BYTES;
}

export function writeArchetypeDescriptor(
	view: DataView,
	off: number,
	d: ArchetypeDescriptor
): number {
	view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.archetype_id, d.archetypeId, true);
	for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
		view.setUint32(
			off + ARCHETYPE_DESCRIPTOR_OFFSETS.component_mask + w * 4,
			d.componentMask[w] ?? 0,
			true
		);
	}
	view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count, d.rowCount, true);
	view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_capacity, d.rowCapacity, true);
	view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.column_count, d.columns.length, true);
	view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.enabled_count, d.enabledCount, true);
	// `entity_ids_off` is reserved and holds zero until the row-to-entity table
	// moves into the store. Write it rather than trust the allocation to be
	// zero, because grow and extend rewrite descriptors over a region that
	// already held a wider descriptor.
	view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.entity_ids_off, 0, true);

	let colOff = off + ARCHETYPE_DESCRIPTOR_HEADER_BYTES;
	for (let i = 0; i < d.columns.length; i++) {
		writeColumnDescriptor(view, colOff, d.columns[i]);
		colOff += COLUMN_DESCRIPTOR_BYTES;
	}
	return colOff;
}

/** Read one archetype descriptor at `off`.
 *
 * `headerBytes` says where this record's columns start and defaults to the
 * current header width. A version 0 region needs
 * `LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES`, because it holds no
 * `entity_ids_off`. Every other field sits at the same offset in both widths,
 * so nothing else here branches on the version. */
export function readArchetypeDescriptor(
	view: DataView,
	off: number,
	headerBytes: number = ARCHETYPE_DESCRIPTOR_HEADER_BYTES
): ArchetypeDescriptor {
	const columnCount = view.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.column_count, true);
	const columns: ColumnDescriptor[] = new Array(columnCount);
	let colOff = off + headerBytes;
	for (let i = 0; i < columnCount; i++) {
		columns[i] = readColumnDescriptor(view, colOff);
		colOff += COLUMN_DESCRIPTOR_BYTES;
	}
	const componentMask: number[] = new Array(COMPONENT_MASK_WORDS);
	for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
		componentMask[w] = view.getUint32(
			off + ARCHETYPE_DESCRIPTOR_OFFSETS.component_mask + w * 4,
			true
		);
	}
	return {
		archetypeId: view.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.archetype_id, true),
		componentMask,
		rowCount: view.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count, true),
		rowCapacity: view.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_capacity, true),
		enabledCount: view.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.enabled_count, true),
		columns
	};
}

// Component-mask matching (build a mask from component IDs, superset test)
// is `BitSet`'s job (`../../type_primitives`), the same structure the
// heap-side archetype signature uses. The descriptor's `component_mask` is the
// raw wire form (a `COMPONENT_MASK_WORDS`-word array mirroring the SAB bytes);
// consumers that need to match wrap it in a `BitSet` and call `.contains(...)`.

// ───────────────────────── Layout descriptor region ─────────────────────────
//
// Sequential walk over `archetype_count` ArchetypeDescriptors starting at
// `header.layout_descriptor_off`. Returned by `readLayoutDescriptorRegion`
// in order. The order is also the order they were written.

export function writeLayoutDescriptorRegion(
	view: DataView,
	regionOff: number,
	descriptors: readonly ArchetypeDescriptor[]
): number {
	let off = regionOff;
	for (let i = 0; i < descriptors.length; i++) {
		off = writeArchetypeDescriptor(view, off, descriptors[i]);
	}
	return off;
}

/** Walk `archetypeCount` descriptors from `regionOff`, in written order.
 *
 * `headerBytes` selects the archetype header width, and defaults to the current
 * one. A caller that reads a version 0 store passes
 * `LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES`, because the record stride is the
 * only thing the narrower header changes. */
export function readLayoutDescriptorRegion(
	view: DataView,
	regionOff: number,
	archetypeCount: number,
	headerBytes: number = ARCHETYPE_DESCRIPTOR_HEADER_BYTES
): readonly ArchetypeDescriptor[] {
	const out: ArchetypeDescriptor[] = new Array(archetypeCount);
	let off = regionOff;
	for (let i = 0; i < archetypeCount; i++) {
		const d = readArchetypeDescriptor(view, off, headerBytes);
		out[i] = d;
		off += archetypeDescriptorBytes(d.columns.length, headerBytes);
	}
	return out;
}

/** Total bytes needed for a layout descriptor region holding these archetypes.
 * Use to size the SAB region between header end and the first column. */
export function layoutDescriptorRegionBytes(
	descriptors: readonly ArchetypeDescriptor[]
): number {
	let total = 0;
	for (let i = 0; i < descriptors.length; i++) {
		total += archetypeDescriptorBytes(descriptors[i].columns.length);
	}
	return total;
}
