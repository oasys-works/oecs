/**
 * The adapter port — the framework-agnostic contract a UI ecosystem plugs into.
 *
 * This is the seam's stable plug-point, the engine's analogue of a store's read
 * API. The engine ships the reactive *core* (signal / computed / effect /
 * reactiveMap) plus this port and **depends on no UI framework** — consume it from
 * anywhere with the vanilla `subscribe` / `toExternalStore`, no extra install. To
 * get framework-idiomatic hooks you attach an *adapter plugin* built on this port,
 * living OUTSIDE the engine (ours, or a community one) — never in here, so the core
 * stays framework-free. (The zustand↔immer split: the core ships; the framework
 * binding is a separate opt-in.) Our Solid plugin lives outside the engine in its
 * own package, `@oasys/oecs/solid`.
 *
 * Frameworks differ, but they all reduce to ONE primitive: "tell me when this value
 * changes, and let me read it." Get this contract right and React / Solid / Preact /
 * Vue each wrap it in a few lines; get it wrong and you get the failure this guards
 * against — a notification per read (or per dependency, or per frame) instead of per
 * *change*, i.e. millions of renders.
 *
 * Two invariants make consumption safe. We verified both against real mounted
 * React, Preact, Vue and Solid trees:
 *   1. `subscribe` fires its callback at most ONCE per coalesced change, and never
 *      on an equal-value write (the kernel's Object.is skip + the effect's
 *      one-run-per-flush guarantee carry straight through).
 *   2. `getSnapshot` is referentially STABLE between changes. This is exactly what
 *      React's useSyncExternalStore requires; an unstable snapshot (a fresh object
 *      every call) sends it into an infinite re-render loop. The accessor returns
 *      the cached value whose identity only moves when it actually changes, so the
 *      store is safe by construction.
 */
import { effect, untrack, type Accessor } from "./kernel";

/**
 * Vanilla subscription: invoke `onChange(value)` once per coalesced change to
 * whatever `accessor` reads. Does NOT fire on subscribe (the consumer reads the
 * initial value itself); returns a disposer. This is the universal adapter base.
 */
export function subscribe<T>(accessor: Accessor<T>, onChange: (value: T) => void): () => void {
	let primed = false;
	return effect(() => {
		const value = accessor(); // tracks accessor's deps fine-grained
		// `onChange` runs inside this effect, so any accessor IT reads would otherwise
		// be captured as a dependency of the subscription (a foreign kernel read in the
		// consumer's callback would silently re-fire it). Untrack so the subscription
		// depends on `accessor` alone.
		if (primed) untrack(() => onChange(value));
		else primed = true; // skip the priming run
	});
}

/**
 * The framework-agnostic external-store contract (React's useSyncExternalStore
 * shape, but useful everywhere). `subscribe` takes a zero-arg "something changed"
 * callback; `getSnapshot` reads the current, referentially-stable value.
 */
export interface ExternalStore<T> {
	subscribe(onStoreChange: () => void): () => void;
	getSnapshot(): T;
}

/** Wrap an accessor as an ExternalStore. Snapshot stability comes from the kernel. */
export function toExternalStore<T>(accessor: Accessor<T>): ExternalStore<T> {
	return {
		subscribe: (onStoreChange) => subscribe(accessor, () => onStoreChange()),
		getSnapshot: accessor
	};
}
