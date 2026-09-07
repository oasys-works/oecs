/**
 * A kernel whose workers finish far apart, so a test can count host wakes.
 *
 * The join is only observable when the host actually parks. A kernel every
 * worker finishes at the same instant leaves the host free to find a complete
 * count on its first read, and then the wake count says nothing.
 *
 * `begin` is the first row of the worker's range, so it names the worker
 * without any channel of its own. The body spins for a stretch proportional to
 * it, which orders the reports and spreads them far apart. Worker zero
 * reports at once and the last worker reports well after it.
 *
 * A worker imports this file by URL, which is why it is a plain module and not
 * TypeScript.
 */

/** Spins in proportion to `begin`, then writes the row so the pass is not
 * dead code. The multiplier is what pushes the last report far enough past the
 * first that a host cannot miss the park. */
export function staggered(px, vx, begin, end) {
	let sink = 0;
	const spins = begin * 4000;
	for (let i = 0; i < spins; i++) sink += i & 7;
	globalThis.__staggerSink = sink;
	for (let i = begin; i < end; i++) px[i] = vx[i];
}
