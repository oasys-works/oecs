/**
 * The kernel bodies that the workers arm runs.
 *
 * A worker imports this file by URL. Therefore it is a plain module, and it is
 * not TypeScript. The system body imports it as well, so the sequential path and
 * the pooled path execute one source. A difference between the two can then come
 * from the split alone.
 *
 * Every row here is independent of every other row. A kernel that read a
 * neighbouring row would give a different answer under a split, and the oracle
 * would not see it.
 *
 * The step is an integer step. A deterministic world gives `stateHash`, and a
 * float step would make the digest depend on the order of the additions.
 */

/** The age bump of `POST_UPDATE`, over one `i32` column.
 *
 * `dt` is the delta time of the frame, and the harness drives the world with a
 * delta time of 1. So one call adds one tick to each row of the range. */
export function ageStepI32(ticks, begin, end, dt) {
	for (let i = begin; i < end; i++) ticks[i] = ticks[i] + dt;
}
