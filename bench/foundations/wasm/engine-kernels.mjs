/**
 * The JavaScript twins of the module kernels the engine probe runs.
 *
 * The engine hands a `js` kernel one typed array for each declared column, in
 * `parallel.columns` order, then `begin`, `end` and `dt`. The bodies below take
 * that argument list, so the same function serves the `js` kernel lane and the
 * sequential `fn` lane. A difference between the two can then come only from
 * the split, and never from two copies of a body.
 *
 * Every column is `i32`, because the probe measures a deterministic world and
 * `snapshots.stateHash()` refuses a float column.
 *
 * The arithmetic is written to match WebAssembly exactly. `Math.imul` is the
 * `i32.mul` of this file, and a store into an `Int32Array` wraps the way
 * `i32.add` wraps. So the module lane and this lane must agree bit for bit, and
 * the probe fails loudly when they do not.
 *
 * Every row is independent of every other row. A kernel that read a
 * neighbouring row would answer differently under a split, and the state hash
 * would not tell you why.
 */

/** `pos += vel * dt` over four columns. Two loads, two fused updates, no
 * branch. Memory bound, and the cheapest per-row body a real system has. */
export function integrateI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		px[i] = (px[i] + Math.imul(vx[i], dt)) | 0;
		py[i] = (py[i] + Math.imul(vy[i], dt)) | 0;
	}
}

/** The rounds the heavy body runs for each row. The module unrolls this count
 * at emit time, so the two lanes must carry the same value. */
export const MIX_ROUNDS = 4;

/**
 * A hash mix with a branch, over the same four columns.
 *
 * Each round is a multiply, an add, a shift, an xor and a branch that is taken
 * for about half the rows. The branch is the point. A body with no branch runs
 * the same instruction stream for every row, and a split then measures only the
 * memory system.
 *
 * Compute bound, so the case a split should win.
 */
export function mixI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		const bx = vx[i];
		const by = vy[i];
		let h = (px[i] + Math.imul(bx, dt)) | 0;
		for (let r = 0; r < MIX_ROUNDS; r++) {
			h = (Math.imul(h, 1103515245) + 12345) | 0;
			h ^= h >>> 15;
			if ((h & 1023) > 512) h = (Math.imul(h, 3) + by) | 0;
			else h = h ^ bx;
		}
		px[i] = h;
		py[i] = (py[i] + (h & 255)) | 0;
	}
}

/** The slot count of the scratch array and of the constant table. One power of
 * two, so a mask picks a slot and no branch does. Keep in step with `SLOTS` in
 * every module source, or the lanes stop computing one function. */
export const SLOTS = 64;

/** The scratch the JavaScript twin gathers from. A module puts this array on
 * its shadow stack, and that is the whole point of the body below. This file
 * runs on one thread for each worker, so one array serves every call. */
const scratch = new Int32Array(SLOTS);

/**
 * A body that a compiled module must spill to its shadow stack.
 *
 * Each row fills a scratch array, then gathers from it with an index the
 * scratch itself decides. A compiler cannot fold that array into registers, so
 * a module addresses it in linear memory below `__stack_pointer`. Two instances
 * of one module over one memory with one stack pointer overwrite each other,
 * and the rows both touched come out wrong.
 */
export function stackI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		const by = vy[i];
		let h = (px[i] + Math.imul(vx[i], dt)) | 0;
		for (let k = 0; k < SLOTS; k++) {
			h = (Math.imul(h, 1103515245) + 12345) | 0;
			scratch[k] = h;
		}
		let acc = 0;
		for (let k = 0; k < SLOTS; k++) acc = (acc + scratch[(scratch[k] ^ by) & 63]) | 0;
		px[i] = acc;
		py[i] = (py[i] + (acc & 255)) | 0;
	}
}

/** The constant table a module carries in a data segment. Every module source
 * computes the same values at build time. */
export const TABLE = (() => {
	const t = new Int32Array(SLOTS);
	for (let k = 0; k < SLOTS; k++) t[k] = (Math.imul(k, 2654435761) ^ (k << 3)) | 0;
	return t;
})();

/** A body that reads the module's own data segment, one slot for each row. */
export function tableI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		const by = vy[i];
		let h = (px[i] + Math.imul(vx[i], dt)) | 0;
		h = (h + TABLE[(h ^ by) & 63]) | 0;
		px[i] = h;
		py[i] = (py[i] + (h & 255)) | 0;
	}
}
