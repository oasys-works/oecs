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
