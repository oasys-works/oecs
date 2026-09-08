/**
 * The world the WASM probes share, and the readers that go with it.
 *
 * The shape is chosen so a module has to do real work: four archetypes, two of
 * which hold both components, one of which holds only the position, and one
 * that carries a third component so the masks differ. A module that ignores
 * the mask and the (component_id, field_id) pair gets the wrong answer here.
 *
 * Every offset the store writes is measured from the header, so each reader
 * here takes the header offset and adds it. `readDescriptors` returns both
 * forms of a column position: `byteOff` is the value the descriptor holds, and
 * `address` is where the column starts in the buffer. Fold `byteOff`, and read
 * through `address`.
 */

export const MAX_PAGES = 512;
export const MAX_BYTES = MAX_PAGES * 65536;

export const HDR = {
	magic: 0,
	version: 4,
	viewStamp: 8,
	capacity: 12,
	archetypeCount: 16,
	layoutOff: 20,
	entityIndexOff: 32
};
export const ARCH = {
	id: 0,
	mask: 4,
	rowCount: 20,
	rowCapacity: 24,
	columnCount: 28,
	enabledCount: 32,
	entityIdsOff: 36,
	bytes: 40
};
export const COL = { componentId: 0, fieldId: 2, typeTag: 4, byteOff: 8, stride: 12, bytes: 16 };

/** Four archetypes, deterministic contents, no random source. */
export function buildWorld(
	ECS,
	{ kind = "f32", deterministic = false, n = 4, maxPages = MAX_PAGES, seed = true, storeBase } = {}
) {
	const ecs = ECS.create({
		deterministic,
		memory: { storeBase, backing: { wasm: { maximumPages: maxPages } } }
	});
	// The engine names the base, and a probe never assumes it. `subscribeLayout`
	// seeds the listener at once, so the offset is known before the first spawn.
	let headerOff = 0;
	ecs.subscribeLayout({ setLayout: (off) => (headerOff = off) })();
	const Pos = ecs.registerComponent({ x: kind, y: kind, z: kind });
	const Vel = ecs.registerComponent({ vx: kind, vy: kind, vz: kind });
	const Mass = ecs.registerComponent({ m: "u32" });
	const both = ecs.template(Pos({ x: 1, y: 2, z: 3 }), Vel({ vx: 1, vy: 2, vz: 3 }));
	const posOnly = ecs.template(Pos({ x: 7, y: 7, z: 7 }));
	const heavy = ecs.template(
		Pos({ x: 5, y: 6, z: 7 }),
		Vel({ vx: 2, vy: 3, vz: 4 }),
		Mass({ m: 11 })
	);
	const ids = [
		...ecs.spawnMany(both, n),
		...ecs.spawnMany(posOnly, Math.max(1, n >> 1)),
		...ecs.spawnMany(heavy, Math.max(1, n >> 2))
	];
	ecs.publishRowCounts();
	if (seed) seedColumns(ecs.wasmMemory.buffer, Pos.id, Vel.id, kind, headerOff);
	return { ecs, Pos, Vel, Mass, ids, headerOff };
}

/** Fill the columns with a deterministic sequence that uses the whole mantissa.
 * A world where every row holds the same small integer hides a rounding
 * difference, because a small integer survives every rounding mode. */
export function seedColumns(buffer, posId, velId, kind = "f32", headerOff = 0) {
	const Ctor = kind === "f32" ? Float32Array : Int32Array;
	let state = 0x2545f491;
	const next = () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state;
	};
	for (const d of readDescriptors(buffer, headerOff)) {
		for (const col of d.columns) {
			if (col.componentId !== posId && col.componentId !== velId) continue;
			const view = new Ctor(buffer, col.address, d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) {
				const bits = next();
				// A value in [1, 2) carries a full f32 mantissa and never
				// overflows, so a long run of steps stays finite.
				view[r] = kind === "f32" ? 1 + (bits >>> 8) / 16777216 : (bits >>> 8) | 0;
			}
		}
	}
}

/** FNV-1a over the bytes the header claims. The module computes the same
 * range, so a mismatch is a disagreement about the bytes and not about the
 * algorithm. */
export function bufferFnv(buffer, capacity, headerOff = 0) {
	const u8 = new Uint8Array(buffer, headerOff, capacity);
	let h = 0x811c9dc5;
	for (let i = 0; i < capacity; i++) h = Math.imul((h ^ u8[i]) >>> 0, 16777619) >>> 0;
	return h >>> 0;
}

export function readHeader(buffer, headerOff = 0) {
	const dv = new DataView(buffer);
	const out = {};
	for (const [k, off] of Object.entries(HDR)) out[k] = dv.getUint32(headerOff + off, true);
	return out;
}

/** Every archetype descriptor, read the way a module reads it. */
export function readDescriptors(buffer, headerOff = 0) {
	const dv = new DataView(buffer);
	const acount = dv.getUint32(headerOff + HDR.archetypeCount, true);
	let off = headerOff + dv.getUint32(headerOff + HDR.layoutOff, true);
	const out = [];
	for (let a = 0; a < acount; a++) {
		const ncol = dv.getUint32(off + ARCH.columnCount, true);
		const cols = [];
		for (let c = 0; c < ncol; c++) {
			const co = off + ARCH.bytes + c * COL.bytes;
			const byteOff = dv.getUint32(co + COL.byteOff, true);
			cols.push({
				componentId: dv.getUint16(co + COL.componentId, true),
				fieldId: dv.getUint16(co + COL.fieldId, true),
				typeTag: dv.getUint8(co + COL.typeTag),
				byteOff,
				address: headerOff + byteOff,
				stride: dv.getUint16(co + COL.stride, true)
			});
		}
		out.push({
			descOff: off,
			id: dv.getUint32(off + ARCH.id, true),
			mask: dv.getUint32(off + ARCH.mask, true),
			rowCount: dv.getUint32(off + ARCH.rowCount, true),
			enabledCount: dv.getUint32(off + ARCH.enabledCount, true),
			entityIdsOff: dv.getUint32(off + ARCH.entityIdsOff, true),
			columnCount: ncol,
			columns: cols
		});
		off += ARCH.bytes + ncol * COL.bytes;
	}
	return out;
}

/**
 * The TypeScript twin of the module kernel, driven off the same descriptors.
 * `round` picks the arithmetic: `fround` rounds each operation to f32 the way
 * WebAssembly does, `native` lets the intermediate stay double.
 */
export function tsStepFromDescriptors(
	buffer,
	posId,
	velId,
	dt,
	{ round = "fround", headerOff = 0 } = {}
) {
	const descs = readDescriptors(buffer, headerOff);
	let rows = 0;
	const dtf = round === "fround" ? Math.fround(dt) : dt;
	for (const d of descs) {
		const find = (cid, fid) => d.columns.find((c) => c.componentId === cid && c.fieldId === fid);
		const p = [0, 1, 2].map((f) => find(posId, f));
		const v = [0, 1, 2].map((f) => find(velId, f));
		if (p.some((c) => c === undefined) || v.some((c) => c === undefined)) continue;
		for (let axis = 0; axis < 3; axis++) {
			const pc = new Float32Array(buffer, p[axis].address, d.enabledCount);
			const vc = new Float32Array(buffer, v[axis].address, d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) {
				pc[r] =
					round === "fround" ? Math.fround(pc[r] + Math.fround(vc[r] * dtf)) : pc[r] + vc[r] * dtf;
			}
		}
		rows += d.enabledCount;
	}
	return rows;
}

/** The integer twin, for a deterministic world. */
export function tsStepI32FromDescriptors(buffer, posId, velId, dt, headerOff = 0) {
	const descs = readDescriptors(buffer, headerOff);
	let rows = 0;
	for (const d of descs) {
		const find = (cid, fid) => d.columns.find((c) => c.componentId === cid && c.fieldId === fid);
		const p = [0, 1, 2].map((f) => find(posId, f));
		const v = [0, 1, 2].map((f) => find(velId, f));
		if (p.some((c) => c === undefined) || v.some((c) => c === undefined)) continue;
		for (let axis = 0; axis < 3; axis++) {
			const pc = new Int32Array(buffer, p[axis].address, d.enabledCount);
			const vc = new Int32Array(buffer, v[axis].address, d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) pc[r] = (pc[r] + Math.imul(vc[r], dt)) | 0;
		}
		rows += d.enabledCount;
	}
	return rows;
}

/** Name the region an address falls in. The header carries the offset of every
 * region, so the map comes from the store and not from a guess. */
export function describeAddress(buffer, addr, headerOff = 0) {
	const dv = new DataView(buffer);
	const at = (off) => headerOff + dv.getUint32(headerOff + off, true);
	const marks = [
		["header", headerOff],
		["command ring", at(24)],
		["entity index", at(32)],
		["event ring", at(36)],
		["action ring", at(28)],
		["layout descriptors", at(20)]
	].sort((a, b) => a[1] - b[1]);
	const capacity = dv.getUint32(headerOff + 12, true);
	if (addr < headerOff || addr >= headerOff + capacity) return "outside the store";
	let best = marks[0][0];
	for (const [name, off] of marks) if (addr >= off) best = name;
	const lastRegion = marks[marks.length - 1][1];
	return addr >= lastRegion ? `${best} or columns` : best;
}

/** Coalesce the byte positions where two snapshots differ. */
export function changedRanges(before, after, limit = 8) {
	const ranges = [];
	let start = -1;
	const n = Math.min(before.length, after.length);
	for (let i = 0; i < n; i++) {
		const differs = before[i] !== after[i];
		if (differs && start < 0) start = i;
		if (!differs && start >= 0) {
			ranges.push([start, i]);
			start = -1;
		}
	}
	if (start >= 0) ranges.push([start, n]);
	// Adjacent runs separated by a byte that happened to match are one write in
	// practice, so merge anything closer than a machine word.
	const merged = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] - last[1] <= 8) last[1] = r[1];
		else merged.push([...r]);
	}
	return {
		count: merged.length,
		first: merged.slice(0, limit),
		span: merged.length === 0 ? null : [merged[0][0], merged[merged.length - 1][1]]
	};
}

/** Every live value of one component, in descriptor order. A digest says
 * "different". This says how many values are different. */
export function collectColumns(buffer, descs, componentId, kind = "f32") {
	const Ctor = kind === "f32" ? Float32Array : Int32Array;
	const out = [];
	for (const d of descs) {
		for (const col of d.columns) {
			if (col.componentId !== componentId) continue;
			const view = new Ctor(buffer, col.address, d.enabledCount);
			for (let r = 0; r < d.enabledCount; r++) out.push(view[r]);
		}
	}
	return out;
}

/** Sample a column, so the probe can say the module wrote the bytes the host
 * reads and not a copy of them. */
export function sampleColumn(buffer, descs, componentId, fieldId, count, kind = "f32") {
	for (const d of descs) {
		const col = d.columns.find((c) => c.componentId === componentId && c.fieldId === fieldId);
		if (col === undefined || d.enabledCount === 0) continue;
		const Ctor = kind === "f32" ? Float32Array : Int32Array;
		return [...new Ctor(buffer, col.address, Math.min(count, d.enabledCount))];
	}
	return [];
}
