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
