/**
 * Reactive array — ordered, per-slot channels with structural-sharing reconcile.
 *
 * The ordered sibling of `reactiveMap` (per-entity channels) and `reactiveStruct`
 * (fixed-field channels) — the last #646 collection shape (ADR-0021). A reader of
 * slot `i` subscribes to slot `i` *alone*; changing slot 7 wakes only the things
 * reading slot 7, not the readers of the other slots. The shape `reactiveMap` can't
 * serve is the *positional* one: a fixed/variable list where order is meaningful
 * (army slots, a hotbar, a sorted board) and a fresh whole-array snapshot is fed in
 * each frame. Bridged to a Solid `<Index>` via `@oasys/oecs/solid`'s
 * `fromKernelArray`.
 *
 * Mechanism — exactly the map's, indexed by position instead of by key:
 *   - one fine-grained signal per slot for its value, plus a single "structure"
 *     signal bumped only when the *length* changes (grow / shrink).
 *   - get(in-range i)  -> tracks slot i's value signal only
 *   - get(out-of-range)-> tracks structure, so a later grow into i wakes the reader
 *   - length / snapshot-> track structure (snapshot also tracks every slot value)
 *   - set(i, v)        -> writes one slot signal (no-op skip); structure untouched
 *   - push / pop / splice / reconcile that change the length -> bump structure once
 *
 * Structural sharing is not a separate step — it falls out of the per-slot no-op
 * skip. `reconcile(next)` writes each slot through its signal's `eq`; an element
 * that is `eq`-equal to the current one is NOT rewritten, so the slot keeps its
 * *current reference*. Feed a fresh array of equal-content objects (the per-tick
 * ECS snapshot shape) under a content `eq` and every unchanged slot keeps its old
 * reference and wakes nobody — the TanStack `replaceEqualDeep` / Solid `reconcile`
 * guarantee, for free. (Reference `Object.is` is the default; pass a content `eq`
 * for object elements, same as the map.)
 *
 * Shrink mirrors `map.delete`: a dropped slot's readers are subscribed to its value
 * signal, not to structure, so a bare `slots.length = m` would never wake them. We
 * detach the tail slots FIRST (so `get(i)` sees out-of-range), then write the ABSENT
 * sentinel to each detached signal inside the batch — that wakes its readers, they
 * re-read `get(i)`, see absence, and re-subscribe to structure (so a later grow back
 * into that index wakes them). Same invariant, same reason as the map.
 */
import { batch, signal, untrack } from "./kernel";

/** Sentinel written to a detached slot to wake its readers as out-of-range. */
const ABSENT = Symbol("reactiveArray.absent");

export interface ReactiveArray<T> {
	/** Read slot `i`, subscribing to that slot (or to structure if out of range). */
	get(i: number): T | undefined;
	/** Element count, tracking structure (length changes only, not value updates). */
	length(): number;
	/**
	 * Whole-array snapshot. Tracks structure AND every slot value — the COARSE read
	 * (any slot change wakes it). Use `length()` + `get(i)` for the fine-grained path;
	 * `snapshot()` is for feeding a positional array to a Solid `<Index each>`.
	 */
	snapshot(): readonly T[];
	/** Fine-grained slot write. Updating an in-range slot wakes only that slot's readers. */
	set(i: number, value: T): void;
	/** Append one element; bumps structure. */
	push(value: T): void;
	/** Remove + return the last element; bumps structure. */
	pop(): T | undefined;
	/** Array-semantics splice; positionally reconciles so only shifted slots wake. */
	splice(start: number, deleteCount?: number, ...items: T[]): T[];
	/** Structural-sharing bulk replace: diff vs current, write only changed slots. */
	reconcile(next: readonly T[]): void;
}

export function reactiveArray<T>(
	initial: readonly T[] = [],
	eq: (a: T, b: T) => boolean = Object.is
): ReactiveArray<T> {
	type Cell = readonly [() => T | typeof ABSENT, (v: T | typeof ABSENT) => void];
	const slots: Cell[] = [];
	const [structure, bumpStructure] = signal(0);
	let revision = 0;

	// A present slot holds a real value; ABSENT is only ever written to a DETACHED
	// slot to wake its readers (mirrors the map's `undefined`). `eq` compares present
	// values; present-vs-absent is unequal so the wake is never skipped. Reduces to
	// plain `Object.is` when `eq` is the default.
	const cellEq = (a: T | typeof ABSENT, b: T | typeof ABSENT): boolean =>
		a !== ABSENT && b !== ABSENT ? eq(a, b) : a === b;

	const makeCell = (v: T): Cell => signal<T | typeof ABSENT>(v, cellEq);
	const peek = (i: number): T => untrack(slots[i][0]) as T; // detached slots are never peeked

	for (const v of initial) slots.push(makeCell(v));

	/** Positional diff + grow/shrink, coalesced into one flush. The single mutator. */
	function reconcileInto(next: readonly T[]): void {
		batch(() => {
			const n = slots.length;
			const m = next.length;
			const common = m < n ? m : n;
			for (let i = 0; i < common; i++) slots[i][1](next[i]); // no-op skip keeps equal refs
			if (m > n) {
				for (let i = n; i < m; i++) slots.push(makeCell(next[i]));
				bumpStructure(++revision); // grow: wake out-of-range readers
			} else if (m < n) {
				const dropped = slots.splice(m); // detach tail FIRST -> get(i>=m) is out-of-range
				for (let i = 0; i < dropped.length; i++) dropped[i][1](ABSENT); // wake their readers
				bumpStructure(++revision);
			}
		});
	}

	return {
		get(i) {
			if (i >= 0 && i < slots.length) {
				const v = slots[i][0]();
				if (v !== ABSENT) return v;
			}
			structure(); // out of range: subscribe to structure so a future grow wakes us
			return undefined;
		},
		length() {
			structure();
			return slots.length;
		},
		snapshot() {
			structure();
			const out = new Array<T>(slots.length);
			for (let i = 0; i < slots.length; i++) out[i] = slots[i][0]() as T;
			return out;
		},
		set(i, value) {
			if (i >= 0 && i < slots.length) slots[i][1](value); // fine-grained, no-op skip via eq
			// Out-of-range `set` is a deliberate no-op (this is per-slot, not a grow). #731.
			else if (__DEV__)
				console.warn(
					`reactiveArray.set(${i}): index out of range [0, ${slots.length}); ignored. ` +
						"Use push / splice / reconcile to change length."
				);
		},
		push(value) {
			slots.push(makeCell(value));
			bumpStructure(++revision);
		},
		pop() {
			const n = slots.length;
			if (n === 0) return undefined;
			const v = peek(n - 1);
			const [dropped] = slots.splice(n - 1);
			batch(() => {
				dropped[1](ABSENT); // wake the last slot's readers as out-of-range
				bumpStructure(++revision);
			});
			return v;
		},
		splice(start, deleteCount, ...items) {
			const n = slots.length;
			const s = start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
			const dc = deleteCount === undefined ? n - s : Math.max(0, Math.min(deleteCount, n - s));
			const removed: T[] = [];
			for (let i = 0; i < dc; i++) removed.push(peek(s + i));
			// Build the post-splice value sequence and positionally reconcile it: the
			// head [0,s) is unchanged (its slots skip), the tail shifts (those slots'
			// values change and rightly wake), and the length delta bumps structure.
			const result: T[] = [];
			for (let i = 0; i < s; i++) result.push(peek(i));
			for (let i = 0; i < items.length; i++) result.push(items[i]);
			for (let i = s + dc; i < n; i++) result.push(peek(i));
			reconcileInto(result);
			return removed;
		},
		reconcile(next) {
			reconcileInto(next);
		}
	};
}
