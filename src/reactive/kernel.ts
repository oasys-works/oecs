/**
 * In-house fine-grained reactive kernel — signal / computed / effect / batch,
 * plus ownership scopes (`root` / `onCleanup`). Zero dependencies (ADR-0021).
 *
 * This is the engine UI seam's propagation core. It is the same class of machine
 * as the ECS observer system (ADR-0013) — fine-grained, glitch-free, cascades to
 * a fixed point — at a different granularity, which is exactly why #646 chose to
 * own it rather than adopt solid-js / @preact/signals-core / alien-signals.
 *
 * The dependency graph is an intrusive doubly-linked structure. One pooled `Link`
 * per edge is threaded into BOTH the source's subscriber list and the target's
 * dependency list at once, so link/unlink is O(1) pointer surgery with no hashing,
 * and a stable-dependency re-run reuses its edges via a tail cursor (zero graph
 * mutation). That is the entire performance story: it ties the throughput leaders
 * on the hot paths and avoids the Set-based prototype's fan-in collapse.
 *
 * Computed is lazy and glitch-free via a version-cutoff pull (the model
 * alien-signals / preact use):
 *
 *   - Every source carries a `version` that bumps only when its value actually
 *     changes. Each edge (`Link`) remembers the source version it last saw.
 *   - A write does NOT eagerly recompute anything. It propagates a "maybe-dirty"
 *     mark (`OUTDATED`) down through computeds to effects, and queues the effects.
 *     Computeds stay lazy.
 *   - Work happens on the pull: when an effect flushes (or a computed is read),
 *     `needsRecompute` walks its deps, refreshes each, and recomputes only if a
 *     dep's version actually advanced. A recompute that produces an equal value
 *     does NOT bump the node's own version, so its subscribers are skipped.
 *
 * That gives glitch-freedom (a diamond resolves with one consistent recompute of
 * the join) and minimal work (unchanged values cut propagation) at once.
 *
 * Known, deliberate scope (refinements, not correctness gaps): computeds ALWAYS
 * track their sources (no auto-unsubscribe of unobserved computeds — the TRACKING
 * optimization) and there is no global-version fast path. The two help only a
 * workload heavy in *unobserved* computeds and are low-value without each other;
 * see ADR-0021. Cycle reads return the stale value rather than throwing.
 */

type Eq<T> = (a: T, b: T) => boolean;

const RUNNING = 1 << 0; // currently recomputing (cycle guard)
const NOTIFIED = 1 << 1; // already seen in this propagation pass (dedup)
const OUTDATED = 1 << 2; // a transitive source may have changed; must re-check
const DISPOSED = 1 << 3;
const QUEUED = 1 << 4; // effect is in the flush queue

// Backstop for a non-settling flush: an effect that writes a signal it depends on
// re-queues itself every run, so the flush never drains. Re-running the same effect
// within one flush is a legitimate cascade (effect A writes a signal effect B reads,
// etc.) up to a point; past this many cascading re-runs it's a runaway cycle and we
// throw instead of hanging forever. Set far above any real cascade — width (fan-in /
// fan-out) never counts toward it, only re-runs do, so a large graph can't trip it.
const MAX_CASCADE = 100_000;

/** A subscribable node: carries a value version and a subscriber list. */
interface LinkSource {
	version: number;
	subs: Link | undefined;
	subsTail: Link | undefined;
	refresh(): void; // signals: no-op; computeds: lazy recompute-if-stale
}

/** A subscribing node: carries a dependency list and propagation flags. */
interface LinkTarget {
	deps: Link | undefined;
	depsTail: Link | undefined;
	flags: number;
	notify(): void; // mark dirty; effects queue, computeds propagate downward
}

/**
 * One edge. Lives in two doubly-linked lists at once: the source's subscriber
 * list (prevSub/nextSub) and the target's dependency list (prevDep/nextDep).
 * `version` is the source's version captured when the target last read it —
 * comparing it against the source's current version is the dirty check.
 */
interface Link {
	source: LinkSource;
	target: LinkTarget;
	version: number;
	prevSub: Link | undefined;
	nextSub: Link | undefined;
	prevDep: Link | undefined;
	nextDep: Link | undefined;
}

let active: LinkTarget | null = null;
let batchDepth = 0;
let flushing = false;
let flushGen = 0; // bumped once per outermost flush; effects stamp `lastFlush` to detect re-runs
const queue: Effect[] = [];
let linkPool: Link | undefined; // freelist; `nextDep` doubles as the pool pointer

// --- ownership ------------------------------------------------------------
// Effects and computeds are also Owners: they collect onCleanup callbacks and
// any child effects/computeds created during their run, and dispose them before
// re-running (so a re-run doesn't leak the previous run's children) and on final
// dispose. A `root` is a bare owner with a manual disposer — the unit a consumer
// tears down to drop a whole subtree.

interface Disposable {
	dispose(): void;
}

interface Owner {
	cleanups: Array<() => void> | null;
	owned: Array<Disposable> | null;
}

let currentOwner: Owner | null = null;

function disposeOwner(o: Owner): void {
	const owned = o.owned;
	if (owned !== null) {
		o.owned = null;
		for (let i = owned.length - 1; i >= 0; i--) owned[i].dispose();
	}
	const cleanups = o.cleanups;
	if (cleanups !== null) {
		o.cleanups = null;
		for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
	}
}

/** Attach a child to the owner in scope, so disposing the owner disposes it. */
function adopt(child: Disposable): void {
	if (currentOwner !== null) (currentOwner.owned ??= []).push(child);
}

// --- graph plumbing -------------------------------------------------------

/** Link `source` into `target`'s dep list at the cursor, capturing the version. */
function link(source: LinkSource, target: LinkTarget): void {
	const prevDep = target.depsTail;
	if (prevDep !== undefined && prevDep.source === source) {
		prevDep.version = source.version; // consecutive re-read
		return;
	}
	const nextDep = prevDep !== undefined ? prevDep.nextDep : target.deps;
	if (nextDep !== undefined && nextDep.source === source) {
		nextDep.version = source.version; // reuse existing link, advance cursor
		target.depsTail = nextDep;
		return;
	}
	const newLink = createLink(source, target, prevDep, nextDep);
	newLink.version = source.version;
	if (prevDep !== undefined) prevDep.nextDep = newLink;
	else target.deps = newLink;
	if (nextDep !== undefined) nextDep.prevDep = newLink;
	target.depsTail = newLink;
	newLink.prevSub = source.subsTail;
	if (source.subsTail !== undefined) source.subsTail.nextSub = newLink;
	else source.subs = newLink;
	source.subsTail = newLink;
}

function createLink(
	source: LinkSource,
	target: LinkTarget,
	prevDep: Link | undefined,
	nextDep: Link | undefined
): Link {
	const pooled = linkPool;
	if (pooled !== undefined) {
		linkPool = pooled.nextDep;
		pooled.source = source;
		pooled.target = target;
		pooled.version = 0;
		pooled.prevDep = prevDep;
		pooled.nextDep = nextDep;
		pooled.prevSub = undefined;
		pooled.nextSub = undefined;
		return pooled;
	}
	return { source, target, version: 0, prevSub: undefined, nextSub: undefined, prevDep, nextDep };
}

/** Remove `node` from both lists, recycle it, return the next dep. */
function unlink(node: Link): Link | undefined {
	const { source, target, prevDep, nextDep, prevSub, nextSub } = node;
	if (prevDep !== undefined) prevDep.nextDep = nextDep;
	else target.deps = nextDep;
	if (nextDep !== undefined) nextDep.prevDep = prevDep;
	if (prevSub !== undefined) prevSub.nextSub = nextSub;
	else source.subs = nextSub;
	if (nextSub !== undefined) nextSub.prevSub = prevSub;
	else source.subsTail = prevSub;
	node.prevDep = undefined;
	node.prevSub = undefined;
	node.nextSub = undefined;
	node.nextDep = linkPool;
	linkPool = node;
	return nextDep;
}

function startTracking(target: LinkTarget): void {
	target.depsTail = undefined; // reset cursor; reuse walks from the head
}

function endTracking(target: LinkTarget): void {
	const tail = target.depsTail;
	let stale = tail !== undefined ? tail.nextDep : target.deps;
	while (stale !== undefined) stale = unlink(stale);
}

/** True if any dependency's value version advanced since the target last read it. */
function needsRecompute(target: LinkTarget): boolean {
	for (let l = target.deps; l !== undefined; l = l.nextDep) {
		l.source.refresh();
		if (l.version !== l.source.version) return true;
	}
	return false;
}

/** Mark every subscriber of `source` dirty (effects queue, computeds cascade). */
function propagate(source: LinkSource): void {
	for (let l = source.subs; l !== undefined; l = l.nextSub) {
		l.target.notify();
	}
}

// --- nodes ----------------------------------------------------------------

class Signal<T> implements LinkSource {
	value: T;
	eq: Eq<T>;
	version = 0;
	subs: Link | undefined = undefined;
	subsTail: Link | undefined = undefined;
	constructor(value: T, eq: Eq<T>) {
		this.value = value;
		this.eq = eq;
	}
	refresh(): void {}
	get(): T {
		if (active !== null) link(this, active);
		return this.value;
	}
	set(v: T): void {
		if (this.eq(this.value, v)) return; // no-op skip
		this.value = v;
		this.version++;
		if (this.subs !== undefined) {
			propagate(this);
			if (batchDepth === 0) flush();
		}
	}
}

class Computed<T> implements LinkSource, LinkTarget, Owner, Disposable {
	value!: T; // assigned by the first refresh, which always runs before any read
	fn: () => T;
	eq: Eq<T>;
	version = 0;
	subs: Link | undefined = undefined;
	subsTail: Link | undefined = undefined;
	deps: Link | undefined = undefined;
	depsTail: Link | undefined = undefined;
	flags = OUTDATED;
	cleanups: Array<() => void> | null = null;
	owned: Array<Disposable> | null = null;
	constructor(fn: () => T, eq: Eq<T>) {
		this.fn = fn;
		this.eq = eq;
	}
	refresh(): void {
		if (this.flags & (RUNNING | DISPOSED)) return; // cycle or dead: leave value as-is
		this.flags &= ~NOTIFIED;
		if (!(this.flags & OUTDATED) && this.version !== 0) return; // already fresh
		this.flags &= ~OUTDATED;
		if (this.version !== 0 && !needsRecompute(this)) return; // deps unchanged in value
		this.flags |= RUNNING;
		disposeOwner(this); // tear down the previous recompute's cleanups/children
		startTracking(this);
		const prevActive = active;
		const prevOwner = currentOwner;
		active = this;
		currentOwner = this;
		try {
			const nv = this.fn();
			if (this.version === 0 || !this.eq(this.value, nv)) {
				this.value = nv;
				this.version++;
			}
		} finally {
			active = prevActive;
			currentOwner = prevOwner;
			endTracking(this);
			this.flags &= ~RUNNING;
		}
	}
	get(): T {
		if (this.flags & RUNNING) return this.value; // cycle read
		this.refresh();
		if (active !== null) link(this, active);
		return this.value;
	}
	notify(): void {
		if (this.flags & NOTIFIED) return;
		this.flags |= NOTIFIED | OUTDATED;
		propagate(this); // cascade the maybe-dirty mark to our subscribers
	}
	dispose(): void {
		if (this.flags & DISPOSED) return;
		this.flags |= DISPOSED;
		let l = this.deps;
		while (l !== undefined) l = unlink(l);
		this.depsTail = undefined;
		disposeOwner(this);
	}
}

class Effect implements LinkTarget, Owner, Disposable {
	fn: () => void;
	deps: Link | undefined = undefined;
	depsTail: Link | undefined = undefined;
	flags = 0;
	lastFlush = 0; // the flush generation this effect last ran in (cycle backstop)
	cleanups: Array<() => void> | null = null;
	owned: Array<Disposable> | null = null;
	constructor(fn: () => void) {
		this.fn = fn;
	}
	notify(): void {
		if (this.flags & NOTIFIED) return;
		this.flags |= NOTIFIED | QUEUED;
		queue.push(this);
	}
	run(): void {
		if (this.flags & DISPOSED) return;
		disposeOwner(this); // run the previous run's cleanups + dispose its children first
		startTracking(this);
		const prevActive = active;
		const prevOwner = currentOwner;
		active = this;
		currentOwner = this;
		try {
			this.fn();
		} finally {
			active = prevActive;
			currentOwner = prevOwner;
			endTracking(this);
		}
	}
	dispose(): void {
		if (this.flags & DISPOSED) return;
		this.flags |= DISPOSED;
		let l = this.deps;
		while (l !== undefined) l = unlink(l);
		this.depsTail = undefined;
		disposeOwner(this);
	}
}

function flush(): void {
	if (flushing) return;
	flushing = true;
	const gen = ++flushGen;
	let cascades = 0;
	// A throwing effect must not poison its siblings. Each effect's QUEUED|NOTIFIED
	// is cleared as we reach it, so if a throw aborted the loop the un-reached
	// effects would keep NOTIFIED set forever and notify() would never re-queue them
	// (they go permanently dead). So isolate each run: one effect throwing still lets
	// every other queued effect run, and the first error is re-thrown after the flush
	// drains so it still surfaces to the caller.
	let error: unknown;
	let errored = false;
	try {
		for (let i = 0; i < queue.length; i++) {
			const e = queue[i];
			e.flags &= ~(QUEUED | NOTIFIED);
			if (!(e.flags & DISPOSED) && needsRecompute(e)) {
				// Stamp the flush generation; a second visit this flush is a cascade
				// re-run. Bounded cascades are fine — an unbounded count is a cycle.
				if (e.lastFlush === gen && ++cascades > MAX_CASCADE) {
					throw new Error(
						`reactive flush did not settle after ${MAX_CASCADE} cascading re-runs ` +
							`(an effect likely writes a signal it depends on — a cycle)`
					);
				}
				e.lastFlush = gen;
				try {
					e.run();
				} catch (err) {
					if (!errored) {
						error = err;
						errored = true;
					}
				}
			}
		}
	} finally {
		queue.length = 0;
		flushing = false;
	}
	if (errored) throw error;
}

// --- public API -----------------------------------------------------------

/** A read accessor; calling it inside an effect/computed subscribes to the source. */
export type Accessor<T> = () => T;
/** A write setter; a same-value write (per `eq`) is a no-op and wakes nobody. */
export type Setter<T> = (v: T) => void;

/** Create a writable signal. Returns `[read, write]`; `eq` defaults to `Object.is`. */
export function signal<T>(initial: T, eq: Eq<T> = Object.is): readonly [Accessor<T>, Setter<T>] {
	const s = new Signal(initial, eq);
	return [() => s.get(), (v: T) => s.set(v)];
}

/** Create a lazy, glitch-free derived value. Recomputes on pull only when a dep changed. */
export function computed<T>(fn: () => T, eq: Eq<T> = Object.is): Accessor<T> {
	const c = new Computed(fn, eq);
	adopt(c); // owned by the enclosing scope, if any
	return () => c.get();
}

/** Run `fn` now and re-run it whenever a tracked dep changes. Returns a disposer. */
export function effect(fn: () => void): () => void {
	const e = new Effect(fn);
	adopt(e); // owned by the enclosing scope, if any
	e.run(); // run once to collect deps
	return () => e.dispose();
}

/** Coalesce all writes inside `fn` into a single flush at the outermost boundary. */
export function batch(fn: () => void): void {
	batchDepth++;
	try {
		fn();
	} finally {
		if (--batchDepth === 0) flush();
	}
}

/**
 * Read inside `fn` without subscribing the enclosing effect/computed to anything it
 * touches (Solid's `untrack`). Use it when a callback that runs during a tracked run
 * must NOT become a dependency — e.g. an interop subscriber whose `onChange` reads
 * other accessors. Returns `fn`'s result.
 */
export function untrack<T>(fn: () => T): T {
	const prev = active;
	active = null;
	try {
		return fn();
	} finally {
		active = prev;
	}
}

/**
 * Create an ownership scope. `fn` receives a disposer that tears down every
 * effect/computed (and their onCleanups) created under the scope. Detached from
 * any enclosing owner — you hold the disposer (Solid's `createRoot` contract).
 */
export function root<T>(fn: (dispose: () => void) => T): T {
	const owner: Owner = { cleanups: null, owned: null };
	const prev = currentOwner;
	currentOwner = owner;
	try {
		return fn(() => disposeOwner(owner));
	} finally {
		currentOwner = prev;
	}
}

/**
 * Register a cleanup with the owner in scope. Inside an effect/computed it runs
 * before each re-run and on dispose; inside a `root` it runs on root disposal.
 */
export function onCleanup(fn: () => void): void {
	if (currentOwner !== null) (currentOwner.cleanups ??= []).push(fn);
}
