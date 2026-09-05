/**
 * A version 0 dense section, built from a current one.
 *
 * A snapshot carries the descriptor bytes themselves, so a section the 0.5 line
 * wrote holds the archetype descriptor header of version 0, which is four bytes
 * narrower than the current one. No fixture of that shape is checked in, and
 * stamping the version field on a current section produces bytes no version 0
 * store ever wrote. This builder writes the narrow shape instead, from the
 * version 0 layout rule and not from a capture:
 *
 *   - each archetype descriptor header ends at `enabled_count`, with no
 *     `entity_ids_off`, so a record spans
 *     `LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES + column_count × 16`
 *   - every field version 0 carries sits at the offset version 1 gives it
 *   - the columns follow the region, each aligned to its own stride
 *   - every offset is measured from buffer byte 0, which a version 0 store
 *     always sat at, so it is also an offset from the header
 *
 * `snapshot.test.ts` and `world_resume.test.ts` restore what this returns.
 */

import {
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COLUMN_DESCRIPTOR_BYTES,
	COMPONENT_MASK_WORDS,
	LEGACY_ABSOLUTE_ABI_VERSION,
	LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	readLayoutDescriptorRegion,
	writeColumnDescriptor
} from "../index";

/** The widest column stride an f64 needs. A shift by a multiple of it leaves
 * every column aligned, because a column offset is a multiple of its own
 * stride and every stride divides this one. */
const WIDEST_COLUMN_STRIDE = 8;

/** Rewrite `dense` as the bytes a version 0 store held for the same world.
 *
 * The header, the prefix regions, the region table and the bindings block keep
 * their offsets, because the store never places them after the descriptor
 * region. The region narrows by four bytes per archetype, and the columns move
 * down by that much rounded down to the widest stride, which keeps each column
 * on its own alignment. What the rounding leaves over becomes descriptor
 * headroom, which version 0 already allowed. */
export function toLegacyDenseSection(dense: Uint8Array): Uint8Array {
	const view = new DataView(dense.buffer, dense.byteOffset, dense.byteLength);
	const regionOff = view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
	const archetypeCount = view.getUint32(STORE_HEADER_OFFSETS.archetype_count, true);
	const capacity = view.getUint32(STORE_HEADER_OFFSETS.capacity, true);
	const descriptors = readLayoutDescriptorRegion(view, regionOff, archetypeCount);

	const narrowBy =
		archetypeCount * (ARCHETYPE_DESCRIPTOR_HEADER_BYTES - LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES);
	const shrink = narrowBy - (narrowBy % WIDEST_COLUMN_STRIDE);

	const out = new Uint8Array(dense.byteLength - shrink);
	out.set(dense.subarray(0, regionOff), 0);
	out.set(dense.subarray(regionOff + shrink), regionOff);

	const outView = new DataView(out.buffer);
	let off = regionOff;
	for (let i = 0; i < descriptors.length; i++) {
		const d = descriptors[i];
		outView.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.archetype_id, d.archetypeId, true);
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			outView.setUint32(
				off + ARCHETYPE_DESCRIPTOR_OFFSETS.component_mask + w * 4,
				d.componentMask[w] ?? 0,
				true
			);
		}
		outView.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count, d.rowCount, true);
		outView.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_capacity, d.rowCapacity, true);
		outView.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.column_count, d.columns.length, true);
		outView.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.enabled_count, d.enabledCount, true);
		// The columns begin where the narrow header ends, and each one names the
		// place its bytes moved to.
		let colOff = off + LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES;
		for (let c = 0; c < d.columns.length; c++) {
			writeColumnDescriptor(outView, colOff, {
				...d.columns[c],
				byteOff: d.columns[c].byteOff - shrink
			});
			colOff += COLUMN_DESCRIPTOR_BYTES;
		}
		off = colOff;
	}

	outView.setUint32(STORE_HEADER_OFFSETS.sim_abi_version, LEGACY_ABSOLUTE_ABI_VERSION, true);
	outView.setUint32(STORE_HEADER_OFFSETS.capacity, capacity - shrink, true);
	return out;
}
