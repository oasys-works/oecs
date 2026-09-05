/**
 * The toolchain-free module under test. It reads the store of oecs through the
 * shared memory and it knows nothing about JavaScript.
 *
 * It exports three entries:
 *   - `fnv1a(off, len)` folds raw bytes, the cross-language digest oracle.
 *   - `walk(headerOff)` walks every archetype descriptor and folds the layout
 *     it found, so the host can prove both sides read the same table.
 *   - `step(headerOff, posId, velId, dt)` finds the x, y and z columns of two
 *     components by (component_id, field_id) and integrates over the live rows.
 *
 * `step_at(base, desc, posId, velId, dt)` is `step` for one archetype, and it
 * exists to measure the cost of one crossing for each archetype against one
 * crossing for the frame. It takes the base separately, because a descriptor
 * address is not a column base.
 *
 * Every offset the store writes is measured from the header. So a column
 * address is `headerOff + byte_off`, and the descriptor region starts at
 * `headerOff + layout_descriptor_off`. The module adds the base it is given and
 * never treats a stored offset as an address. That is one add per column, and a
 * caller that passes a base of zero gets the addresses the store wrote.
 *
 * The module holds no state. Every entry re-reads the header, so a grow of the
 * memory cannot leave it with a stale offset. A module that caches offsets is
 * a separate probe.
 */

import { ModuleBuilder, op } from "./emit.mjs";

export const HDR = { magic: 0, version: 4, viewStamp: 8, capacity: 12, archetypeCount: 16, layoutOff: 20, entityIndexOff: 32 };
export const ARCH = { id: 0, mask: 4, rowCount: 20, rowCapacity: 24, columnCount: 28, enabledCount: 32, entityIdsOff: 36, bytes: 40 };
export const COL = { componentId: 0, fieldId: 2, typeTag: 4, byteOff: 8, stride: 12, bytes: 16 };
export const FNV_BASIS = 0x811c9dc5 | 0;
export const FNV_PRIME = 16777619;

/** The word fold both sides run. `walk` folds a layout with it, and the host
 * mirrors it in JavaScript. */
export function foldWord(h, w) {
	return Math.imul((h ^ (w >>> 0)) >>> 0, FNV_PRIME) >>> 0;
}

function fnv1aBody() {
	const OFF = 0;
	const LEN = 1;
	const H = 2;
	const I = 3;
	return [
		op.i32(FNV_BASIS), op.set(H),
		op.i32(0), op.set(I),
		op.block([
			op.loop([
				op.get(I), op.get(LEN), op.ge_u, op.br_if(1),
				op.get(H),
				op.get(OFF), op.get(I), op.add, op.load8_u(0),
				op.xor,
				op.i32(FNV_PRIME), op.mul, op.set(H),
				op.get(I), op.i32(1), op.add, op.set(I),
				op.br(0)
			])
		]),
		op.get(H)
	];
}

function walkBody() {
	const HEADER = 0;
	const H = 1;
	const ACOUNT = 2;
	const DESC = 3;
	const A = 4;
	const NCOL = 5;
	const C = 6;
	const CO = 7;
	const fold = (value) => [op.get(H), ...value.flat(Infinity), op.xor, op.i32(FNV_PRIME), op.mul, op.set(H)];
	return [
		op.i32(FNV_BASIS), op.set(H),
		op.get(HEADER), op.load_i32(HDR.archetypeCount), op.set(ACOUNT),
		op.get(HEADER), op.load_i32(HDR.layoutOff), op.get(HEADER), op.add, op.set(DESC),
		fold([op.get(ACOUNT)]),
		op.i32(0), op.set(A),
		op.block([
			op.loop([
				op.get(A), op.get(ACOUNT), op.ge_u, op.br_if(1),
				fold([op.get(DESC), op.load_i32(ARCH.id)]),
				fold([op.get(DESC), op.load_i32(ARCH.columnCount), op.tee(NCOL)]),
				fold([op.get(DESC), op.load_i32(ARCH.rowCount)]),
				fold([op.get(DESC), op.load_i32(ARCH.enabledCount)]),
				fold([op.get(DESC), op.load_i32(ARCH.mask)]),
				// The reserved row-to-entity offset. The module folds it so the
				// comparison covers the whole header, and so a store that starts
				// writing a real offset there fails here first.
				fold([op.get(DESC), op.load_i32(ARCH.entityIdsOff)]),
				op.i32(0), op.set(C),
				op.block([
					op.loop([
						op.get(C), op.get(NCOL), op.ge_u, op.br_if(1),
						op.get(DESC), op.i32(ARCH.bytes), op.add,
						op.get(C), op.i32(COL.bytes), op.mul, op.add, op.set(CO),
						fold([op.get(CO), op.load16_u(COL.componentId)]),
						fold([op.get(CO), op.load16_u(COL.fieldId)]),
						fold([op.get(CO), op.load8_u(COL.typeTag)]),
						fold([op.get(CO), op.load_i32(COL.byteOff)]),
						fold([op.get(CO), op.load16_u(COL.stride)]),
						op.get(C), op.i32(1), op.add, op.set(C),
						op.br(0)
					])
				]),
				op.get(DESC), op.i32(ARCH.bytes), op.add,
				op.get(NCOL), op.i32(COL.bytes), op.mul, op.add, op.set(DESC),
				op.get(A), op.i32(1), op.add, op.set(A),
				op.br(0)
			])
		]),
		op.get(H)
	];
}

/** The layout fold the host runs, so a disagreement is a real disagreement and
 * not a difference of definition. Keep in step with `walkBody`. */
export function walkInJs(view, headerOff) {
	let h = FNV_BASIS >>> 0;
	const acount = view.getUint32(headerOff + HDR.archetypeCount, true);
	let desc = headerOff + view.getUint32(headerOff + HDR.layoutOff, true);
	h = foldWord(h, acount);
	for (let a = 0; a < acount; a++) {
		const ncol = view.getUint32(desc + ARCH.columnCount, true);
		h = foldWord(h, view.getUint32(desc + ARCH.id, true));
		h = foldWord(h, ncol);
		h = foldWord(h, view.getUint32(desc + ARCH.rowCount, true));
		h = foldWord(h, view.getUint32(desc + ARCH.enabledCount, true));
		h = foldWord(h, view.getUint32(desc + ARCH.mask, true));
		h = foldWord(h, view.getUint32(desc + ARCH.entityIdsOff, true));
		for (let c = 0; c < ncol; c++) {
			const co = desc + ARCH.bytes + c * COL.bytes;
			h = foldWord(h, view.getUint16(co + COL.componentId, true));
			h = foldWord(h, view.getUint16(co + COL.fieldId, true));
			h = foldWord(h, view.getUint8(co + COL.typeTag));
			h = foldWord(h, view.getUint32(co + COL.byteOff, true));
			h = foldWord(h, view.getUint16(co + COL.stride, true));
		}
		desc += ARCH.bytes + ncol * COL.bytes;
	}
	return h >>> 0;
}

/** Integrate one archetype descriptor at `DESC`. Shared by `step` and
 * `step_at`, which differ only in who walks the descriptor region. */
function integrateOneArchetype({ BASE, DESC, POS, VEL, DT, NCOL, NROW, C, CO, CID, FID, BOFF, PX, PY, PZ, VX, VY, VZ, R, OFS, ROWS }, kind = "f32") {
	const capture = (target, fieldIndex) => [
		op.get(FID), op.i32(fieldIndex), op.eq,
		op.if_([op.get(BOFF), op.set(target)])
	];
	const axis = (pos, vel) =>
		kind === "f32"
			? [
					op.get(pos), op.get(OFS), op.add,
					op.get(pos), op.get(OFS), op.add, op.load_f32(0),
					op.get(vel), op.get(OFS), op.add, op.load_f32(0),
					op.get(DT), op.f32_mul, op.f32_add,
					op.store_f32(0)
				]
			: [
					op.get(pos), op.get(OFS), op.add,
					op.get(pos), op.get(OFS), op.add, op.load_i32(0),
					op.get(vel), op.get(OFS), op.add, op.load_i32(0),
					op.get(DT), op.mul, op.add,
					op.store_i32(0)
				];
	const present = (l) => [op.get(l), op.i32(0), op.ne];
	return [
		op.get(DESC), op.load_i32(ARCH.columnCount), op.set(NCOL),
		op.get(DESC), op.load_i32(ARCH.enabledCount), op.set(NROW),
		op.i32(0), op.set(PX), op.i32(0), op.set(PY), op.i32(0), op.set(PZ),
		op.i32(0), op.set(VX), op.i32(0), op.set(VY), op.i32(0), op.set(VZ),
		op.i32(0), op.set(C),
		op.block([
			op.loop([
				op.get(C), op.get(NCOL), op.ge_u, op.br_if(1),
				op.get(DESC), op.i32(ARCH.bytes), op.add,
				op.get(C), op.i32(COL.bytes), op.mul, op.add, op.set(CO),
				op.get(CO), op.load16_u(COL.componentId), op.set(CID),
				op.get(CO), op.load16_u(COL.fieldId), op.set(FID),
				// The store measures `byte_off` from the header, so the column
				// address is the base plus the stored offset. An absent column
				// leaves its local at zero, which is what `present` tests, and the
				// base is added only to an offset a descriptor gave.
				op.get(CO), op.load_i32(COL.byteOff), op.get(BASE), op.add, op.set(BOFF),
				op.get(CID), op.get(POS), op.eq,
				op.if_([capture(PX, 0), capture(PY, 1), capture(PZ, 2)]),
				op.get(CID), op.get(VEL), op.eq,
				op.if_([capture(VX, 0), capture(VY, 1), capture(VZ, 2)]),
				op.get(C), op.i32(1), op.add, op.set(C),
				op.br(0)
			])
		]),
		present(PX), present(PY), op.and, present(PZ), op.and,
		present(VX), op.and, present(VY), op.and, present(VZ), op.and,
		op.if_([
			op.i32(0), op.set(R),
			op.block([
				op.loop([
					op.get(R), op.get(NROW), op.ge_u, op.br_if(1),
					op.get(R), op.i32(4), op.mul, op.set(OFS),
					axis(PX, VX), axis(PY, VY), axis(PZ, VZ),
					op.get(R), op.i32(1), op.add, op.set(R),
					op.br(0)
				])
			]),
			op.get(ROWS), op.get(NROW), op.add, op.set(ROWS)
		])
	];
}

function stepBody(kind = "f32") {
	const HEADER = 0, POS = 1, VEL = 2, DT = 3;
	const ACOUNT = 4, DESC = 5, A = 6, NCOL = 7, NROW = 8, C = 9, CO = 10;
	const CID = 11, FID = 12, BOFF = 13;
	const PX = 14, PY = 15, PZ = 16, VX = 17, VY = 18, VZ = 19;
	const R = 20, OFS = 21, ROWS = 22;
	// The header offset is the base of every offset the store wrote, so `step`
	// walks and addresses from the one argument it is given.
	const names = { BASE: HEADER, DESC, POS, VEL, DT, NCOL, NROW, C, CO, CID, FID, BOFF, PX, PY, PZ, VX, VY, VZ, R, OFS, ROWS };
	return [
		op.get(HEADER), op.load_i32(HDR.archetypeCount), op.set(ACOUNT),
		op.get(HEADER), op.load_i32(HDR.layoutOff), op.get(HEADER), op.add, op.set(DESC),
		op.i32(0), op.set(ROWS),
		op.i32(0), op.set(A),
		op.block([
			op.loop([
				op.get(A), op.get(ACOUNT), op.ge_u, op.br_if(1),
				integrateOneArchetype(names, kind),
				op.get(DESC), op.i32(ARCH.bytes), op.add,
				op.get(NCOL), op.i32(COL.bytes), op.mul, op.add, op.set(DESC),
				op.get(A), op.i32(1), op.add, op.set(A),
				op.br(0)
			])
		]),
		op.get(ROWS)
	];
}

function stepAtBody() {
	const BASE = 0, DESC = 1, POS = 2, VEL = 3, DT = 4;
	const NCOL = 5, NROW = 6, C = 7, CO = 8, CID = 9, FID = 10, BOFF = 11;
	const PX = 12, PY = 13, PZ = 14, VX = 15, VY = 16, VZ = 17;
	const R = 18, OFS = 19, ROWS = 20;
	const names = { BASE, DESC, POS, VEL, DT, NCOL, NROW, C, CO, CID, FID, BOFF, PX, PY, PZ, VX, VY, VZ, R, OFS, ROWS };
	return [op.i32(0), op.set(ROWS), integrateOneArchetype(names), op.get(ROWS)];
}

/**
 * Integrate one archetype from six column addresses the caller already
 * resolved. This is the shape of a module that caches offsets across frames.
 * The cache is on the caller's side here, because the emitter has no globals
 * and a cache in linear memory would sit inside the store.
 */
function stepCachedBody() {
	const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, NROW = 6, DT = 7;
	const R = 8, OFS = 9;
	const axis = (pos, vel) => [
		op.get(pos), op.get(OFS), op.add,
		op.get(pos), op.get(OFS), op.add, op.load_f32(0),
		op.get(vel), op.get(OFS), op.add, op.load_f32(0),
		op.get(DT), op.f32_mul, op.f32_add,
		op.store_f32(0)
	];
	return [
		op.i32(0), op.set(R),
		op.block([
			op.loop([
				op.get(R), op.get(NROW), op.ge_u, op.br_if(1),
				op.get(R), op.i32(4), op.mul, op.set(OFS),
				axis(PX, VX), axis(PY, VY), axis(PZ, VZ),
				op.get(R), op.i32(1), op.add, op.set(R),
				op.br(0)
			])
		]),
		op.get(NROW)
	];
}

/** Emit the module. `minPages` and `maxPages` must match the memory the host
 * hands over, or instantiation fails. */
export function emitAbiModule({ minPages, maxPages }) {
	const m = new ModuleBuilder();
	m.importMemory("env", "memory", { minPages, maxPages, shared: true });
	m.addFunction({ name: "fnv1a", params: ["i32", "i32"], results: ["i32"], locals: ["i32", "i32"], body: fnv1aBody() });
	m.addFunction({
		name: "walk",
		params: ["i32"],
		results: ["i32"],
		locals: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		body: walkBody()
	});
	m.addFunction({
		name: "step",
		params: ["i32", "i32", "i32", "f32"],
		results: ["i32"],
		locals: new Array(19).fill("i32"),
		body: stepBody()
	});
	m.addFunction({
		name: "step_at",
		params: ["i32", "i32", "i32", "i32", "f32"],
		results: ["i32"],
		locals: new Array(16).fill("i32"),
		body: stepAtBody()
	});
	// The integer twin. A deterministic world rejects an f32 column, so the
	// `stateHash` comparison needs an integer kernel.
	m.addFunction({
		name: "step_i32",
		params: ["i32", "i32", "i32", "i32"],
		results: ["i32"],
		locals: new Array(19).fill("i32"),
		body: stepBody("i32")
	});
	// The empty body. Calling it measures the crossing and nothing else, so it
	// carries the argument list of `step_at` and compares against it.
	m.addFunction({
		name: "nop",
		params: ["i32", "i32", "i32", "i32", "f32"],
		results: ["i32"],
		locals: [],
		body: [op.i32(0)]
	});
	m.addFunction({
		name: "step_cached",
		params: ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "f32"],
		results: ["i32"],
		locals: ["i32", "i32"],
		body: stepCachedBody()
	});
	return m.emit();
}
