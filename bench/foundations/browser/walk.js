/**
 * The descriptor walk `store_reader.wasm` runs, written in JavaScript, so a
 * browser can compare the module against the engine.
 *
 * `src/core/ecs/__tests__/fixtures/store_walk.ts` is the same walk for the
 * vitest suite. That file imports the store's ABI constants from `src/`, and a
 * probe must not import `src/`, so the constants come from `par/view.mjs`
 * instead. `p24-par-bytes-view.mjs` checks that copy against the engine's own
 * query on every run, so a drift in either copy fails loudly.
 *
 * Every address here is `headerOff + relative`. The header carries the offset
 * of the descriptor region, and each column descriptor carries the offset of
 * its column, and both are measured from the header. The wasm backing puts the
 * header above address 0, so a reader that treats either offset as an address
 * reads the wrong bytes.
 */

import { ARCH, ARCH_HEADER_BYTES, COL, COL_BYTES, COMPONENT_MASK_WORDS, HEADER } from "../par/view.mjs";

export const FNV1A_BASIS = 0x811c9dc5;
export const FNV1A_PRIME = 16777619;

export function readStoreHeader(view, headerOff) {
	return {
		capacity: view.getUint32(headerOff + HEADER.capacity, true),
		archetypeCount: view.getUint32(headerOff + HEADER.archetype_count, true),
		viewStamp: view.getUint32(headerOff + HEADER.view_stamp, true),
		layoutDescriptorOff: view.getUint32(headerOff + HEADER.layout_descriptor_off, true)
	};
}

/** Every archetype descriptor, in the order the region holds them. The walk is
 * sequential: each archetype's column count gives the stride to the next. */
export function readDescriptors(view, headerOff) {
	const header = readStoreHeader(view, headerOff);
	let addr = headerOff + header.layoutDescriptorOff;
	const out = [];
	for (let a = 0; a < header.archetypeCount; a++) {
		const columnCount = view.getUint32(addr + ARCH.column_count, true);
		const mask = [];
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			mask.push(view.getUint32(addr + ARCH.component_mask + w * 4, true));
		}
		const columns = [];
		for (let c = 0; c < columnCount; c++) {
			const co = addr + ARCH_HEADER_BYTES + c * COL_BYTES;
			const byteOff = view.getUint32(co + COL.byte_off, true);
			columns.push({
				componentId: view.getUint16(co + COL.component_id, true),
				fieldId: view.getUint16(co + COL.field_id, true),
				typeTag: view.getUint8(co + COL.type_tag),
				byteOff,
				address: headerOff + byteOff,
				stride: view.getUint16(co + COL.stride, true)
			});
		}
		out.push({
			archetypeId: view.getUint32(addr + ARCH.archetype_id, true),
			mask,
			rowCount: view.getUint32(addr + ARCH.row_count, true),
			rowCapacity: view.getUint32(addr + ARCH.row_capacity, true),
			enabledCount: view.getUint32(addr + ARCH.enabled_count, true),
			descriptorAddress: addr,
			columns
		});
		addr += ARCH_HEADER_BYTES + columnCount * COL_BYTES;
	}
	return out;
}

/** Whether a mask holds a component id. */
export function maskHas(mask, componentId) {
	const word = componentId >>> 5;
	if (word >= mask.length) return false;
	return (mask[word] & (1 << (componentId & 31))) !== 0;
}

function fold(hash, word) {
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
export function foldLayout(view, headerOff) {
	let hash = FNV1A_BASIS >>> 0;
	const descriptors = readDescriptors(view, headerOff);
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
export function fnv1aBytes(buffer, offset, length) {
	const bytes = new Uint8Array(buffer, offset, length);
	let hash = FNV1A_BASIS >>> 0;
	for (let i = 0; i < length; i++) hash = Math.imul((hash ^ bytes[i]) >>> 0, FNV1A_PRIME) >>> 0;
	return hash >>> 0;
}

/** The six column addresses one archetype holds for a position and a velocity
 * component, or `null` when it holds neither. Resolved by
 * `(component_id, field_id)`, the way the module resolves them. */
export function resolveXyz(d, posId, velId) {
	const at = (componentId, fieldId) => {
		for (const c of d.columns) {
			if (c.componentId === componentId && c.fieldId === fieldId) return c.address;
		}
		return null;
	};
	const pos = [at(posId, 0), at(posId, 1), at(posId, 2)];
	const vel = [at(velId, 0), at(velId, 1), at(velId, 2)];
	if (pos.some((a) => a === null) || vel.some((a) => a === null)) return null;
	return { pos, vel };
}

/**
 * `pos += vel * dt` over the enabled rows of every archetype that holds both
 * components, in f32.
 *
 * Every operation rounds to f32 with `Math.fround`, because that is what the
 * module does. An engine that folds the arithmetic to f32 by itself agrees
 * without the rounding, and that agreement is an optimisation and not a
 * contract. This harness runs on three engines, so the rounding is written out.
 */
export function stepF32(buffer, headerOff, posId, velId, dt) {
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
export function stepI32(buffer, headerOff, posId, velId, dt) {
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
export function collectColumnValues(buffer, headerOff, componentId, kind) {
	const out = [];
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
export function seedColumns(buffer, headerOff, posId, velId, kind) {
	let state = 0x2545f491;
	const next = () => {
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
