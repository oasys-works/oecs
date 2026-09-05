/**
 * Worker-side column reader. Takes a store buffer and the byte offset of the
 * header, and gives back typed-array views over the columns. Imports nothing
 * from the package.
 *
 * A worker receives the `SharedArrayBuffer` and nothing else. The archetype
 * graph, the component registry and the query cache are main-thread objects.
 * The buffer carries the header, the layout descriptor and the columns, so a
 * worker can find a column from `(component_id, field_id)` alone. This file is
 * that walk, written once and used by every parallel probe.
 *
 * The offsets below are copied from `src/core/store/vendored_abi/abi.ts`. A
 * probe must not import `src/`, so the constants are duplicated here. The
 * bytes-view probe checks the walk against the ECS query on every run, so a
 * drift in either copy fails loudly.
 *
 * Every offset the store writes is measured from the header, so each function
 * here takes the header offset and adds it. The default of zero is the store
 * as a heap or shared world lays it out today. A worker that shares memory
 * with a module receives the base with the buffer and passes it here.
 */

export const STORE_HEADER_BYTES = 52;
export const HEADER = {
	magic: 0,
	sim_abi_version: 4,
	view_stamp: 8,
	capacity: 12,
	archetype_count: 16,
	layout_descriptor_off: 20,
	entity_index_off: 32
};

export const ARCH_HEADER_BYTES = 36;
export const ARCH = {
	archetype_id: 0,
	component_mask: 4,
	row_count: 20,
	row_capacity: 24,
	column_count: 28,
	enabled_count: 32
};

export const COL_BYTES = 16;
export const COL = { component_id: 0, field_id: 2, type_tag: 4, byte_off: 8, stride: 12 };

export const COMPONENT_MASK_WORDS = 4;
export const STORE_MAGIC = 0x314d4953;

/** Constructor for each `type_tag`, indexed by the tag value. */
export const TAG_CTOR = [
	Uint8Array,
	Int8Array,
	Uint16Array,
	Int16Array,
	Uint32Array,
	Int32Array,
	Float32Array,
	Float64Array
];

export function readHeader(buffer, base = 0) {
	const dv = new DataView(buffer, base, STORE_HEADER_BYTES);
	return {
		base,
		magic: dv.getUint32(HEADER.magic, true),
		viewStamp: dv.getUint32(HEADER.view_stamp, true),
		capacity: dv.getUint32(HEADER.capacity, true),
		archetypeCount: dv.getUint32(HEADER.archetype_count, true),
		// The stored value, measured from the header. Add `base` to address it.
		layoutDescriptorOff: dv.getUint32(HEADER.layout_descriptor_off, true),
		entityIndexOff: dv.getUint32(HEADER.entity_index_off, true)
	};
}

/**
 * Walk the layout descriptor region once and describe every archetype.
 *
 * The walk is sequential: each archetype's `column_count` gives the stride to
 * the next one. There is no offset table, so the cost is proportional to the
 * total column count and not to the buffer size. Cold path, run it on the
 * layout republish and cache the result.
 */
export function walkArchetypes(buffer, base = 0) {
	const h = readHeader(buffer, base);
	const dv = new DataView(buffer);
	const out = new Array(h.archetypeCount);
	let off = base + h.layoutDescriptorOff;
	for (let a = 0; a < h.archetypeCount; a++) {
		const columnCount = dv.getUint32(off + ARCH.column_count, true);
		const mask = new Array(COMPONENT_MASK_WORDS);
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			mask[w] = dv.getUint32(off + ARCH.component_mask + w * 4, true);
		}
		const columns = new Array(columnCount);
		for (let c = 0; c < columnCount; c++) {
			const co = off + ARCH_HEADER_BYTES + c * COL_BYTES;
			const byteOff = dv.getUint32(co + COL.byte_off, true);
			columns[c] = {
				componentId: dv.getUint16(co + COL.component_id, true),
				fieldId: dv.getUint16(co + COL.field_id, true),
				typeTag: dv.getUint8(co + COL.type_tag),
				// The stored offset, and where it lands in the buffer.
				byteOff,
				address: base + byteOff,
				stride: dv.getUint16(co + COL.stride, true)
			};
		}
		out[a] = {
			archetypeId: dv.getUint32(off + ARCH.archetype_id, true),
			mask,
			rowCount: dv.getUint32(off + ARCH.row_count, true),
			rowCapacity: dv.getUint32(off + ARCH.row_capacity, true),
			enabledCount: dv.getUint32(off + ARCH.enabled_count, true),
			descriptorOff: off,
			columns
		};
		off += ARCH_HEADER_BYTES + columnCount * COL_BYTES;
	}
	return { header: h, archetypes: out, descriptorEndOff: off };
}

function maskHas(mask, componentId) {
	const w = componentId >>> 5;
	if (w >= mask.length) return false;
	return (mask[w] & (1 << (componentId & 31))) !== 0;
}

/**
 * Build column views for one `(component_id, field_id)` list, over every
 * archetype whose mask holds every named component.
 *
 * `specs` is an array of `[componentId, fieldId]` pairs. The result keeps the
 * spec order, so a kernel indexes `views[0]`, `views[1]` and never searches.
 * The view length is the archetype's row capacity, not its row count, so the
 * caller bounds its own loop on `rowCount`.
 */
export function bindColumns(buffer, specs, walk, base = 0) {
	const w = walk ?? walkArchetypes(buffer, base);
	const wanted = new Set(specs.map((s) => s[0]));
	const out = [];
	for (const arch of w.archetypes) {
		if (arch.columns.length === 0) continue;
		let holdsAll = true;
		for (const cid of wanted) {
			if (!maskHas(arch.mask, cid)) {
				holdsAll = false;
				break;
			}
		}
		if (!holdsAll) continue;
		const views = new Array(specs.length);
		let missing = false;
		for (let i = 0; i < specs.length; i++) {
			const [cid, fid] = specs[i];
			const col = arch.columns.find((c) => c.componentId === cid && c.fieldId === fid);
			if (col === undefined) {
				missing = true;
				break;
			}
			const Ctor = TAG_CTOR[col.typeTag];
			views[i] = new Ctor(buffer, col.byteOff, arch.rowCapacity);
		}
		if (missing) continue;
		out.push({
			archetypeId: arch.archetypeId,
			rowCount: arch.rowCount,
			enabledCount: arch.enabledCount,
			rowCapacity: arch.rowCapacity,
			descriptorOff: arch.descriptorOff,
			views
		});
	}
	return { walk: w, bound: out };
}

/**
 * The same result as `walkArchetypes` plus `bindColumns`, with no intermediate
 * object for each column.
 *
 * `bindColumns` describes every column of every archetype, then throws most of
 * it away. A worker needs the byte offsets of the fields it was asked for and
 * nothing else. This form reads the descriptor bytes once and builds only the
 * views it keeps, which is what a real worker would run on a republish.
 */
export function bindColumnsLean(buffer, specs, base = 0) {
	const dv = new DataView(buffer);
	const archetypeCount = dv.getUint32(base + HEADER.archetype_count, true);
	let off = base + dv.getUint32(base + HEADER.layout_descriptor_off, true);
	const wantCount = specs.length;
	const out = [];
	for (let a = 0; a < archetypeCount; a++) {
		const columnCount = dv.getUint32(off + ARCH.column_count, true);
		if (columnCount === 0) {
			off += ARCH_HEADER_BYTES;
			continue;
		}
		const rowCapacity = dv.getUint32(off + ARCH.row_capacity, true);
		const colBase = off + ARCH_HEADER_BYTES;
		const views = new Array(wantCount);
		let found = 0;
		for (let c = 0; c < columnCount; c++) {
			const co = colBase + c * COL_BYTES;
			const cid = dv.getUint16(co + COL.component_id, true);
			const fid = dv.getUint16(co + COL.field_id, true);
			for (let s = 0; s < wantCount; s++) {
				if (views[s] === undefined && specs[s][0] === cid && specs[s][1] === fid) {
					const Ctor = TAG_CTOR[dv.getUint8(co + COL.type_tag)];
					views[s] = new Ctor(buffer, base + dv.getUint32(co + COL.byte_off, true), rowCapacity);
					found++;
					break;
				}
			}
			if (found === wantCount) break;
		}
		if (found !== wantCount) {
			off += ARCH_HEADER_BYTES + columnCount * COL_BYTES;
			continue;
		}
		out.push({
			archetypeId: dv.getUint32(off + ARCH.archetype_id, true),
			rowCount: dv.getUint32(off + ARCH.row_count, true),
			enabledCount: dv.getUint32(off + ARCH.enabled_count, true),
			rowCapacity,
			descriptorOff: off,
			views
		});
		off += ARCH_HEADER_BYTES + columnCount * COL_BYTES;
	}
	return out;
}

/** Re-read the live row count of one bound archetype without re-walking. The
 * host republishes it on every phase boundary, so a worker that caches views
 * still needs a fresh count each frame. */
export function liveRowCount(buffer, descriptorOff) {
	return new DataView(buffer).getUint32(descriptorOff + ARCH.row_count, true);
}

/** FNV-1a over the live column bytes of every bound archetype, in bind order.
 * A probe-side oracle for a world that holds float columns, where the engine's
 * own `stateHash` refuses to run. */
export function foldColumnBytes(bound) {
	let hash = 0x811c9dc5;
	for (const b of bound) {
		for (const view of b.views) {
			const bytes = new Uint8Array(
				view.buffer,
				view.byteOffset,
				b.rowCount * view.BYTES_PER_ELEMENT
			);
			for (let i = 0; i < bytes.length; i++) {
				hash ^= bytes[i];
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
		}
	}
	return hash >>> 0;
}
