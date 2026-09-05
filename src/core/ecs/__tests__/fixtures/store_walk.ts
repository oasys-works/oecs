/**
 * The descriptor walk a module runs, written in TypeScript, for the tests that
 * compare a module against the engine.
 *
 * Every address here is `headerOff + relative`. The header carries the offset
 * of the descriptor region, and each column descriptor carries the offset of
 * its column, and both are measured from the header. A reader that treats
 * either one as an address into the buffer is right only while the header sits
 * on byte 0.
 *
 * The offsets come from the store's own ABI constants, so a field that moves
 * fails the comparison instead of moving on both sides at once. The module
 * carries the same offsets baked into its code.
 */

import {
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COLUMN_DESCRIPTOR_BYTES,
	COLUMN_DESCRIPTOR_OFFSETS,
	COMPONENT_MASK_WORDS,
	STORE_HEADER_OFFSETS
} from "../../../store";

export const FNV1A_BASIS = 0x811c9dc5;
export const FNV1A_PRIME = 16777619;

/** One column of one archetype, as the descriptor states it. */
export interface ColumnDescriptor {
	readonly componentId: number;
	readonly fieldId: number;
	readonly typeTag: number;
	/** The offset the descriptor holds, measured from the header. */
	readonly byteOff: number;
	/** Where the column starts in the buffer. */
	readonly address: number;
	readonly stride: number;
}

export interface ArchetypeDescriptor {
	readonly archetypeId: number;
	readonly mask: readonly number[];
	readonly rowCount: number;
	readonly rowCapacity: number;
	readonly enabledCount: number;
	/** Where this descriptor starts in the buffer. */
	readonly descriptorAddress: number;
	readonly columns: readonly ColumnDescriptor[];
}

export interface StoreHeader {
	readonly capacity: number;
	readonly archetypeCount: number;
	readonly viewStamp: number;
	/** The offset the header holds, measured from the header. */
	readonly layoutDescriptorOff: number;
}

export function readStoreHeader(view: DataView, headerOff: number): StoreHeader {
	return {
		capacity: view.getUint32(headerOff + STORE_HEADER_OFFSETS.capacity, true),
		archetypeCount: view.getUint32(headerOff + STORE_HEADER_OFFSETS.archetype_count, true),
		viewStamp: view.getUint32(headerOff + STORE_HEADER_OFFSETS.view_stamp, true),
		layoutDescriptorOff: view.getUint32(
			headerOff + STORE_HEADER_OFFSETS.layout_descriptor_off,
			true
		)
	};
}

/** Every archetype descriptor, in the order the region holds them. The walk is
 * sequential: each archetype's column count gives the stride to the next. */
export function readDescriptors(view: DataView, headerOff: number): ArchetypeDescriptor[] {
	const header = readStoreHeader(view, headerOff);
	let addr = headerOff + header.layoutDescriptorOff;
	const out: ArchetypeDescriptor[] = [];
	for (let a = 0; a < header.archetypeCount; a++) {
		const columnCount = view.getUint32(addr + ARCHETYPE_DESCRIPTOR_OFFSETS.column_count, true);
		const mask: number[] = [];
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			mask.push(view.getUint32(addr + ARCHETYPE_DESCRIPTOR_OFFSETS.component_mask + w * 4, true));
		}
		const columns: ColumnDescriptor[] = [];
		for (let c = 0; c < columnCount; c++) {
			const co = addr + ARCHETYPE_DESCRIPTOR_HEADER_BYTES + c * COLUMN_DESCRIPTOR_BYTES;
			const byteOff = view.getUint32(co + COLUMN_DESCRIPTOR_OFFSETS.byte_off, true);
			columns.push({
				componentId: view.getUint16(co + COLUMN_DESCRIPTOR_OFFSETS.component_id, true),
				fieldId: view.getUint16(co + COLUMN_DESCRIPTOR_OFFSETS.field_id, true),
				typeTag: view.getUint8(co + COLUMN_DESCRIPTOR_OFFSETS.type_tag),
				byteOff,
				address: headerOff + byteOff,
				stride: view.getUint16(co + COLUMN_DESCRIPTOR_OFFSETS.stride, true)
			});
		}
		out.push({
			archetypeId: view.getUint32(addr + ARCHETYPE_DESCRIPTOR_OFFSETS.archetype_id, true),
			mask,
			rowCount: view.getUint32(addr + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count, true),
			rowCapacity: view.getUint32(addr + ARCHETYPE_DESCRIPTOR_OFFSETS.row_capacity, true),
			enabledCount: view.getUint32(addr + ARCHETYPE_DESCRIPTOR_OFFSETS.enabled_count, true),
			descriptorAddress: addr,
			columns
		});
		addr += ARCHETYPE_DESCRIPTOR_HEADER_BYTES + columnCount * COLUMN_DESCRIPTOR_BYTES;
	}
	return out;
}

/** Whether a mask holds a component id. */
export function maskHas(mask: readonly number[], componentId: number): boolean {
	const word = componentId >>> 5;
	if (word >= mask.length) return false;
	return (mask[word] & (1 << (componentId & 31))) !== 0;
}

function fold(hash: number, word: number): number {
	return Math.imul((hash ^ (word >>> 0)) >>> 0, FNV1A_PRIME) >>> 0;
}

/**
 * The layout fold, field by field, in the order the module folds them: the
 * archetype count, then for each archetype its id, column count, row count,
 * enabled count and first mask word, then for each column its component id,
 * field id, type tag, stored byte offset and stride.
 *
 * It folds the stored offset and not the address, so a world at any base folds
 * to the same value.
 */
export function foldLayout(view: DataView, headerOff: number): number {
	const descriptors = readDescriptors(view, headerOff);
	let hash = FNV1A_BASIS >>> 0;
	hash = fold(hash, descriptors.length);
	for (const d of descriptors) {
		hash = fold(hash, d.archetypeId);
		hash = fold(hash, d.columns.length);
		hash = fold(hash, d.rowCount);
		hash = fold(hash, d.enabledCount);
		hash = fold(hash, d.mask[0]);
		for (const c of d.columns) {
			hash = fold(hash, c.componentId);
			hash = fold(hash, c.fieldId);
			hash = fold(hash, c.typeTag);
			hash = fold(hash, c.byteOff);
			hash = fold(hash, c.stride);
		}
	}
	return hash >>> 0;
}

/** FNV-1a over one byte range of the buffer. The store-level digest, and not
 * the state hash of the world. */
export function fnv1aBytes(buffer: ArrayBufferLike, offset: number, length: number): number {
	const bytes = new Uint8Array(buffer, offset, length);
	let hash = FNV1A_BASIS >>> 0;
	for (let i = 0; i < length; i++) hash = Math.imul((hash ^ bytes[i]) >>> 0, FNV1A_PRIME) >>> 0;
	return hash >>> 0;
}

/** The six column addresses one archetype holds for a position and a velocity
 * component, or `null` when it holds neither. Resolved by
 * `(component_id, field_id)`, the way a module resolves them. */
export function resolveXyz(
	d: ArchetypeDescriptor,
	posId: number,
	velId: number
): { pos: number[]; vel: number[] } | null {
	const at = (componentId: number, fieldId: number): number | null => {
		for (const c of d.columns) {
			if (c.componentId === componentId && c.fieldId === fieldId) return c.address;
		}
		return null;
	};
	const pos = [at(posId, 0), at(posId, 1), at(posId, 2)];
	const vel = [at(velId, 0), at(velId, 1), at(velId, 2)];
	if (pos.some((a) => a === null) || vel.some((a) => a === null)) return null;
	return { pos: pos as number[], vel: vel as number[] };
}

/**
 * `pos += vel * dt` over the enabled rows of every archetype that holds both
 * components, in f32.
 *
 * Every operation rounds to f32 with `Math.fround`, because that is what the
 * module does. An engine that folds the arithmetic to f32 by itself agrees
 * without the rounding, and that agreement is an optimisation and not a
 * contract.
 */
export function stepF32(
	buffer: ArrayBufferLike,
	headerOff: number,
	posId: number,
	velId: number,
	dt: number
): number {
	const dtf = Math.fround(dt);
	let rows = 0;
	for (const d of readDescriptors(new DataView(buffer), headerOff)) {
		const cols = resolveXyz(d, posId, velId);
		if (cols === null) continue;
		for (let axis = 0; axis < 3; axis++) {
			const pos = new Float32Array(buffer, cols.pos[axis], d.enabledCount);
			const vel = new Float32Array(buffer, cols.vel[axis], d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) {
				pos[r] = Math.fround(pos[r] + Math.fround(vel[r] * dtf));
			}
		}
		rows += d.enabledCount;
	}
	return rows;
}

/** The integer twin, for a world that refuses a float column. */
export function stepI32(
	buffer: ArrayBufferLike,
	headerOff: number,
	posId: number,
	velId: number,
	dt: number
): number {
	let rows = 0;
	for (const d of readDescriptors(new DataView(buffer), headerOff)) {
		const cols = resolveXyz(d, posId, velId);
		if (cols === null) continue;
		for (let axis = 0; axis < 3; axis++) {
			const pos = new Int32Array(buffer, cols.pos[axis], d.enabledCount);
			const vel = new Int32Array(buffer, cols.vel[axis], d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) pos[r] = (pos[r] + Math.imul(vel[r], dt)) | 0;
		}
		rows += d.enabledCount;
	}
	return rows;
}

/** Every enabled value of one component, archetype by archetype. A digest says
 * "different". This says which value is different. */
export function collectColumnValues(
	buffer: ArrayBufferLike,
	headerOff: number,
	componentId: number,
	kind: "f32" | "i32"
): number[] {
	const out: number[] = [];
	for (const d of readDescriptors(new DataView(buffer), headerOff)) {
		for (const c of d.columns) {
			if (c.componentId !== componentId) continue;
			const view =
				kind === "f32"
					? new Float32Array(buffer, c.address, d.enabledCount)
					: new Int32Array(buffer, c.address, d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) out.push(view[r]);
		}
	}
	return out;
}

/**
 * Fill every position and velocity column with a deterministic sequence that
 * uses the whole mantissa. A world where every row holds the same small integer
 * hides a rounding difference, because a small integer survives every rounding
 * mode.
 */
export function seedColumns(
	buffer: ArrayBufferLike,
	headerOff: number,
	posId: number,
	velId: number,
	kind: "f32" | "i32"
): void {
	let state = 0x2545f491;
	const next = (): number => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state;
	};
	for (const d of readDescriptors(new DataView(buffer), headerOff)) {
		for (const c of d.columns) {
			if (c.componentId !== posId && c.componentId !== velId) continue;
			const view =
				kind === "f32"
					? new Float32Array(buffer, c.address, d.enabledCount)
					: new Int32Array(buffer, c.address, d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) {
				const bits = next();
				// A value in [1, 2) carries a full f32 mantissa and never overflows,
				// so a long run of steps stays finite.
				view[r] = kind === "f32" ? 1 + (bits >>> 8) / 16777216 : (bits >>> 8) | 0;
			}
		}
	}
}
