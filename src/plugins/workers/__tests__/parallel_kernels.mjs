/**
 * The kernel bodies the parallel tests run, in one file so the worker and the
 * sequential fallback execute the same source.
 *
 * A worker imports this file by URL, which is why it is a plain module and not
 * TypeScript. The test's `fn` imports it too, so a difference between the two
 * paths can only come from the split and never from two copies of the body.
 *
 * Every row is independent of every other row. A kernel that read a
 * neighbouring row would give a different answer under a split, and these tests
 * would not catch it.
 */

/** `pos += vel * dt` over integer columns. The deterministic lane. */
export function integrateI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		px[i] = px[i] + vx[i] * dt;
		py[i] = py[i] + vy[i] * dt;
	}
}

/** The float twin. Each operation rounds to f32, so the body agrees with a
 * module that computes in f32 rather than relying on an engine to fold it. */
export function integrateF32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		px[i] = Math.fround(px[i] + Math.fround(vx[i] * dt));
		py[i] = Math.fround(py[i] + Math.fround(vy[i] * dt));
	}
}

/** Throws on its first call, to drive the kernel-failure path. */
export function throwing() {
	throw new Error("the kernel refuses to run");
}

/** Never returns, to drive the join timeout. A worker inside this loop reports
 * no failure and never reaches the done word, which is what a dead worker looks
 * like from the host. Only `terminate` ends it. */
export function spinning() {
	for (;;) {
		globalThis.__spinSink = (globalThis.__spinSink ?? 0) + 1;
	}
}

/** The value `markKernel` writes, and the one the sequential body beside it
 * writes. Both sit outside the seeded range, so either one names the path that
 * ran. */
export const KERNEL_MARK = -777;
export const SEQUENTIAL_MARK = -333;

/** Writes the kernel's mark, so a test can tell which path ran. */
export function markKernel(px, py, vx, vy, begin, end) {
	for (let i = begin; i < end; i++) {
		px[i] = KERNEL_MARK;
		py[i] = KERNEL_MARK;
	}
}

/** The slot count of the scratch array and of the constant table. Every
 * checked-in kernel module carries the same value, and a module that carries a
 * different one disagrees with the body below. */
export const SLOTS = 64;

/** The scratch the JavaScript twin gathers from. A compiled module puts this
 * array on its shadow stack. */
const scratch = new Int32Array(SLOTS);

/**
 * A body a compiled module must spill to its shadow stack.
 *
 * Each row fills a scratch array, then gathers from it with an index the
 * scratch itself decides. A compiler cannot fold that array into registers, so
 * a module addresses it in linear memory below `__stack_pointer`. Two instances
 * over one memory with one stack pointer overwrite each other's frames.
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

/** The constant table every kernel module carries in a data segment. */
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

/** A hash mix with a branch, over the same four columns. The heavy body, and
 * the one whose rounds a module unrolls. */
export function mixI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		const bx = vx[i];
		const by = vy[i];
		let h = (px[i] + Math.imul(bx, dt)) | 0;
		for (let r = 0; r < 4; r++) {
			h = (Math.imul(h, 1103515245) + 12345) | 0;
			h ^= h >>> 15;
			if ((h & 1023) > 512) h = (Math.imul(h, 3) + by) | 0;
			else h = h ^ bx;
		}
		px[i] = h;
		py[i] = (py[i] + (h & 255)) | 0;
	}
}

/** `pos += vel * dt` with the wrapping the modules do. `integrateI32` above
 * multiplies with a JavaScript number, which is the js-kernel lane. This one is
 * the twin of a module body, where every step is an i32 operation. */
export function integrateWrapI32(px, py, vx, vy, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		px[i] = (px[i] + Math.imul(vx[i], dt)) | 0;
		py[i] = (py[i] + Math.imul(vy[i], dt)) | 0;
	}
}
