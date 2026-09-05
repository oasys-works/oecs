/**
 * Four ways for K workers to tell one host that a pass is over.
 *
 * The release side is the same in all four: the host bumps an epoch word and
 * notifies it, and every worker sleeps on that one word. Only the join side
 * changes, because that is the side that grows with the worker count.
 *
 *   "a"  one counter, every worker adds and notifies. What the engine ships.
 *   "b"  one counter, only the worker whose add returned K-1 notifies.
 *   "c"  one word for each worker, each on its own cache line. The host scans
 *        the K words and parks on the first that is still behind.
 *   "d"  a tree. Worker i waits for the words of 2i+1 and 2i+2, then writes its
 *        own. The host waits on worker 0's word alone.
 *
 * Variants "c" and "d" write the epoch into the word instead of counting, so
 * the host resets nothing before a release and a stale word can never read as
 * finished. Variants "a" and "b" need the counter cleared first, which is one
 * extra store on the release side and is what the engine pays today.
 *
 * The words of "c" and "d" sit one cache line apart. `LINE` is 128 bytes,
 * because Apple silicon uses that line size and a smaller stride would put two
 * words on one line there.
 *
 * The host join returns how many times it came out of `Atomics.wait`. A join
 * that scales wakes the host once for each pass, no matter how many workers ran.
 */

/** Int32 words in one cache line stride. */
export const LINE = 32;

/** The frame number, and the word every worker sleeps on. */
export const EPOCH = 0;
/** Which body to run, or `JOB_STOP`. */
export const JOB = 1;
/** Leave the loop and end the thread. */
export const JOB_STOP = -1;

/** The shared counter of variants "a" and "b", alone on its line. */
export const DONE = LINE;

/** Worker `i`'s done word, on a line of its own. Variants "c" and "d". */
export function word(i) {
	return LINE * (2 + i);
}

/** Worker `i`'s scratch word, on a line of its own, so a light kernel writes
 * somewhere no other thread reads. */
export function scratch(workerCount, i) {
	return LINE * (2 + workerCount + i);
}

export function controlBuffer(workerCount) {
	return new SharedArrayBuffer(LINE * (2 + 2 * workerCount) * 4);
}

export const VARIANTS = ["a", "b", "c", "d"];

export function variantLabel(v) {
	if (v === "a") return "a: one counter, every worker notifies (shipped)";
	if (v === "b") return "b: one counter, last worker notifies";
	if (v === "c") return "c: one word for each worker, host scans";
	return "d: tree join, host waits on one word";
}

/** Prepare the control words for one release. Returns the epoch the workers
 * will serve. Variants "a" and "b" pay one extra store here. */
export function hostRelease(variant, ctl, epoch, job) {
	if (variant === "a" || variant === "b") Atomics.store(ctl, DONE, 0);
	Atomics.store(ctl, JOB, job);
	Atomics.store(ctl, EPOCH, epoch);
	Atomics.notify(ctl, EPOCH);
}

/** Block until every worker has reported the epoch. Returns the number of
 * wakes the host took, which is the cost this probe exists to compare. */
export function hostJoin(variant, ctl, workerCount, epoch) {
	let wakes = 0;
	if (variant === "a" || variant === "b") {
		for (;;) {
			const done = Atomics.load(ctl, DONE);
			if (done === workerCount) return wakes;
			Atomics.wait(ctl, DONE, done);
			wakes++;
		}
	}
	if (variant === "c") {
		for (;;) {
			let pending = -1;
			for (let i = 0; i < workerCount; i++) {
				if (Atomics.load(ctl, word(i)) !== epoch) {
					pending = i;
					break;
				}
			}
			if (pending < 0) return wakes;
			const index = word(pending);
			const seen = Atomics.load(ctl, index);
			if (seen === epoch) continue;
			Atomics.wait(ctl, index, seen);
			wakes++;
		}
	}
	for (;;) {
		const root = Atomics.load(ctl, word(0));
		if (root === epoch) return wakes;
		Atomics.wait(ctl, word(0), root);
		wakes++;
	}
}

/** The worker half. Report the pass, and in the tree variant carry the
 * children's reports first. */
export function workerJoin(variant, ctl, index, workerCount, epoch) {
	if (variant === "a") {
		Atomics.add(ctl, DONE, 1);
		Atomics.notify(ctl, DONE);
		return;
	}
	if (variant === "b") {
		// The add that lands last is the only one that can complete the join, so
		// it is the only one whose notify can find the host parked.
		if (Atomics.add(ctl, DONE, 1) === workerCount - 1) Atomics.notify(ctl, DONE);
		return;
	}
	if (variant === "c") {
		Atomics.store(ctl, word(index), epoch);
		Atomics.notify(ctl, word(index));
		return;
	}
	const left = 2 * index + 1;
	const right = left + 1;
	if (left < workerCount) awaitWord(ctl, word(left), epoch);
	if (right < workerCount) awaitWord(ctl, word(right), epoch);
	Atomics.store(ctl, word(index), epoch);
	Atomics.notify(ctl, word(index));
}

function awaitWord(ctl, index, epoch) {
	for (;;) {
		const seen = Atomics.load(ctl, index);
		if (seen === epoch) return;
		Atomics.wait(ctl, index, seen);
	}
}

/** The worker loop every join variant shares. `body(job, epoch)` runs one pass
 * and returns nothing. Ends on `JOB_STOP`. */
export function workerLoop(variant, ctl, index, workerCount, body) {
	let seen = 0;
	for (;;) {
		while (Atomics.load(ctl, EPOCH) === seen) {
			Atomics.wait(ctl, EPOCH, seen);
		}
		seen = Atomics.load(ctl, EPOCH);
		const job = Atomics.load(ctl, JOB);
		if (job === JOB_STOP) return;
		body(job);
		workerJoin(variant, ctl, index, workerCount, seen);
	}
}
