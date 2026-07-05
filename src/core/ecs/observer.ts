/***
 * Observer — per-component reactive hooks (onAdd / onRemove / onDisable /
 * onEnable / onSet).
 *
 * Resolves #517 §1; design locked by [ADR-0013](../../../../../docs/adr/0013-component-observers.md).
 * onDisable / onEnable (#677, [ADR-0023](../../../../../docs/adr/0023-disable-enable-observers.md))
 * extend the structural model to the entity enable/disable transition (#577):
 * the partition swap (`disableRow`/`enableRow`) fires no onAdd/onRemove, so a
 * consumer (the reactive bridge) was blind to it. onDisable / onEnable fire at
 * the *deferred* toggle drain in `flushStructural` — like onAdd/onRemove, an
 * *immediate* host-side `world.disable()` does not fire — for *every component
 * the entity carries* (a disable is a soft remove of the whole mask from default
 * queries, the symmetric idea to a destroy fanning onRemove over the mask), and
 * collapse to one event per *net* transition across a drain (disable→enable→
 * disable in a tick = a single onDisable; required so the radix canonical order
 * never reorders a duplicate eid).
 * bitECS / flecs expose first-class component observers; we had only *system*
 * lifecycle hooks, so reactions ("on `Death` added → spawn corpse", "on
 * `HexPos` set → mark spatial index") were hand-polled every tick. Observers
 * express them directly.
 *
 * The mechanism is fixed by the ADR — the two measured traps it avoids:
 *
 *   1. **onSet is not a per-write hook.** A per-element observable setter loses
 *      to change detection (`observer_onset_probe.ts`). So onSet is *derived*:
 *      archetype-granular onSet ≡ the existing per-archetype change tick (free),
 *      per-entity onSet ≡ the ADR-0012 opt-in per-row dirty list surfaced as a
 *      callback.
 *   2. **onAdd/onRemove ordering is a comparator sort.** `Array.sort` for the
 *      canonical firing order costs 2–4× the entire flush (`observer_dispatch_probe.ts`);
 *      an O(K) LSD radix on the bounded 20-bit entity index is the same order at
 *      <0.3×. Determinism is cheap *only* if you don't compare-sort.
 *
 * Firing order is two composed layers, both deterministic:
 *   - **across observers** — access-topological (writer-of-X before readers-of-X,
 *     from each observer's `SystemAccessDeclaration`): deterministic *and*
 *     glitch-free, the ECS analog of Solid's height order (`observer_ordering_sim.ts`).
 *   - **within an observer** — entity-id order via the radix pass above.
 *
 * Structural observers (onAdd/onRemove) fire during `Store.flushStructural`,
 * *after* the batch commits (observers never see a torn state), looping to a
 * fixed point so cascades settle. onSet fires at the post-update detection
 * point. Observer / dirty / event state is a scheduling artifact — kept OUT of
 * `stateHash` and snapshot (like `_changedTick`), but produced in canonical
 * order so replays reproduce.
 *
 * This module owns the registry + ordering + dispatch; the hot-path event
 * collection and the deferred fixed-point loop live in `store.ts` (it owns the
 * flush). The access-topological order built here is the same write-disjointness
 * graph #517 §4 (multithreaded execution) will reuse.
 ***/

import { unsafeCast } from "../../type_primitives";
import type { ArchetypeView } from "./archetype";
import type { ComponentDef, ComponentHandle } from "./component";
import type { EntityID } from "./entity";
import type { FrameTraceSink, ObserverOp } from "./frame_trace";
import type { SystemContext } from "./query";
import type { StructuralObserverEvents } from "./store";
import {
	_INTERNAL_EMPTY_ACCESS,
	asSystemId,
	type SystemAccessDeclaration,
	type SystemDescriptor
} from "./system";
import { accessCheck } from "./access_check";
import { ECS_ERROR, ECSError } from "./utils/error";
import { DEV } from "../../dev_flag";

/** What the observer registry needs from `Store` — the typed seam replacing
 * bare underscore-convention reach-through (M1). `Store` implements this; the
 * registry holds only this view, so the compiler bounds what observer dispatch
 * can touch. Underscore names are kept so `Store`'s members stay one
 * declaration (they read as "internal" at every other call site). */
export interface ObserverHost {
	/** Current change tick — read for onSet baselines. */
	readonly _tick: number;
	/** Dev-only frame-trace sink (`null` when unset; always null in prod). */
	readonly _trace: FrameTraceSink | null;
	/** Sync a component's observation flags (add/remove/disable/enable/dirty). */
	_configureComponentObservation(
		cid: number,
		hasAdd: boolean,
		hasRem: boolean,
		hasDisable: boolean,
		hasEnable: boolean,
		trackDirty: boolean
	): void;
	/** Drain the per-entity onSet dirty list for `cid` (clears marks). */
	_takeDirty(cid: number): EntityID[];
	/** Visit archetypes whose `cid` column changed since `baseline`, in
	 * canonical (creation-id) order. */
	_forEachChangedArchetype(cid: number, baseline: number, cb: (arch: ArchetypeView) => void): void;
	/** Every live entity currently holding `cid` (dispose-on-disable sweep). */
	_collectEntitiesWithComponent(cid: number): EntityID[];
	isAlive(id: EntityID): boolean;
	isDisabled(id: EntityID): boolean;
	hasComponent(entityId: EntityID, def: ComponentHandle): boolean;
}

/** Per-entity observer callback (onAdd / onRemove / onDisable / onEnable, and
 * per-entity onSet). */
export type ObserverFn = (eid: EntityID, ctx: SystemContext) => void;
/** Archetype-granular onSet callback — fires once per changed archetype-column;
 * the consumer iterates `arch.entityCount` rows itself. */
export type ArchetypeObserverFn = (arch: ArchetypeView, ctx: SystemContext) => void;

/** Fields common to every observer registration. `access` drives both the
 * dev-mode `accessCheck` and the access-topological firing order; it is merged
 * over an all-empty declaration, so a caller spells out only what it touches. */
interface ObserverConfigBase {
	onAdd?: ObserverFn;
	onRemove?: ObserverFn;
	/** Fires when an entity carrying this component is *disabled* (#577) — at the
	 * deferred toggle drain, once per net transition (ADR-0023). Mirrors `onRemove`:
	 * a disable is a soft remove of the whole mask from default queries. An immediate
	 * host-side `world.disable()` does not fire (like immediate `addComponent`). */
	onDisable?: ObserverFn;
	/** Fires when an entity carrying this component is *enabled* (#577), symmetric
	 * with `onDisable` / `onAdd`. */
	onEnable?: ObserverFn;
	/** Access surface the callbacks touch (reads / writes / spawns / …). Partial:
	 * merged over `_INTERNAL_EMPTY_ACCESS`. Undeclared access throws in `DEV`. */
	access?: Partial<SystemAccessDeclaration>;
	/** flecs-style replay of current matches on registration (onAdd only — seeds the
	 * *enabled* members; a disabled entity is simply absent, matching default-query
	 * semantics), for order-independence of register-vs-spawn. */
	yieldExisting?: boolean;
}

/** Per-entity onSet: `onSet(eid, ctx)` fires once per changed entity, drained
 * from the opt-in per-row dirty list (registering this enables dirty tracking
 * for the component — the ADR-0012 list + dedup bit). */
export interface EntitySetObserverConfig extends ObserverConfigBase {
	onSet: ObserverFn;
	granularity: "entity";
}

/** Archetype-granular onSet (default): `onSet(arch, ctx)` fires once per
 * changed archetype-column (the change tick), in canonical archetype order. Free
 * write path. */
export interface ArchetypeSetObserverConfig extends ObserverConfigBase {
	onSet: ArchetypeObserverFn;
	granularity?: "archetype";
}

/** Structural-only observer — no onSet. */
export interface StructuralObserverConfig extends ObserverConfigBase {
	onSet?: undefined;
	granularity?: undefined;
}

export type ObserverConfig =
	| StructuralObserverConfig
	| EntitySetObserverConfig
	| ArchetypeSetObserverConfig;

/** Handle returned by `world.observe(...)`. `dispose()` unregisters; safe to
 * call more than once. */
export interface ObserverHandle {
	dispose(): void;
}

/** A registered observer (one component). */
interface ObserverEntry {
	readonly id: number;
	readonly cid: number;
	/** The observed component's handle — carried so per-entity onSet can
	 *  call `hasComponent(eid, def)` without re-minting a def from `cid`. */
	readonly def: ComponentHandle;
	readonly onAdd: ObserverFn | undefined;
	readonly onRemove: ObserverFn | undefined;
	readonly onDisable: ObserverFn | undefined;
	readonly onEnable: ObserverFn | undefined;
	readonly onSetEntity: ObserverFn | undefined;
	readonly onSetArch: ArchetypeObserverFn | undefined;
	/** Synthesized frozen descriptor for `accessCheck` (cached in its WeakMap). */
	readonly descriptor: SystemDescriptor;
	/** Component ids this observer writes / reads — drives the topo order. */
	readonly writes: ReadonlySet<number>;
	readonly reads: ReadonlySet<number>;
	readonly yieldExisting: boolean;
	/** Per-observer baseline tick for archetype-granular onSet (mirrors
	 * `ChangedQuery`'s `lastRunTick`). */
	lastSetTick: number;
	disposed: boolean;
}

const INDEX_MASK = (1 << 20) - 1; // entity.ts: 20-bit dense index

let _nextObserverId = 0;

/** Synthesize a frozen `SystemDescriptor` from a (partial) access declaration so
 * `accessCheck` can validate observer callbacks exactly as it does systems. The
 * object identity is stable for the observer's lifetime (cached in accessCheck's
 * WeakMap). The `fn` is never called — observers dispatch through their own
 * callbacks. */
function synthDescriptor(
	name: string,
	access: Partial<SystemAccessDeclaration>
): SystemDescriptor {
	const merged: SystemDescriptor = {
		..._INTERNAL_EMPTY_ACCESS,
		...access,
		id: asSystemId(_nextObserverId++),
		name,
		fn: _noopSystemFn
	};
	return Object.freeze(merged);
}

function _noopSystemFn(): void {
	/* observers never run via the schedule */
}

function idSet(defs: readonly ComponentDef[] | undefined): Set<number> {
	const s = new Set<number>();
	if (defs) for (let i = 0; i < defs.length; i++) s.add(defs[i].id);
	return s;
}

/** Access-topological order over the registered observers: a producer (writes X)
 * precedes any consumer (reads X). Deterministic Kahn sort, tie-broken by
 * component id then registration id. A write/read cycle (no valid topo order)
 * degrades gracefully: the remaining observers are appended in the same
 * deterministic tie-break order, so the result is still replay-stable (it just
 * can't promise glitch-freedom for the cyclic subset). Mirrors
 * `observer_ordering_sim.ts`'s `topoOrder`. */
function topoOrder(entries: readonly ObserverEntry[]): ObserverEntry[] {
	const tie = (a: ObserverEntry, b: ObserverEntry): number => a.cid - b.cid || a.id - b.id;
	const edges = new Map<ObserverEntry, ObserverEntry[]>();
	const indeg = new Map<ObserverEntry, number>();
	for (const o of entries) {
		edges.set(o, []);
		indeg.set(o, 0);
	}
	for (const producer of entries) {
		if (producer.writes.size === 0) continue;
		for (const consumer of entries) {
			if (producer === consumer) continue;
			let dependent = false;
			for (const w of producer.writes) {
				if (consumer.reads.has(w)) {
					dependent = true;
					break;
				}
			}
			if (dependent) {
				edges.get(producer)!.push(consumer);
				indeg.set(consumer, indeg.get(consumer)! + 1);
			}
		}
	}
	const ready = entries.filter((o) => indeg.get(o) === 0).sort(tie);
	const out: ObserverEntry[] = [];
	while (ready.length > 0) {
		const n = ready.shift()!;
		out.push(n);
		for (const c of edges.get(n)!) {
			const d = indeg.get(c)! - 1;
			indeg.set(c, d);
			if (d === 0) {
				ready.push(c);
				ready.sort(tie);
			}
		}
	}
	if (out.length !== entries.length) {
		// Cyclic write/read dependency — append the rest deterministically.
		const seen = new Set(out);
		for (const o of entries.slice().sort(tie)) if (!seen.has(o)) out.push(o);
	}
	return out;
}

/**
 * Registry of component observers. Owned by `ECS`; the `Store` calls back into
 * `dispatchStructural` between fixed-point rounds during `flushStructural`,
 * and `ECS.update` calls `dispatchSet` at the post-update detection point.
 */
export class ObserverRegistry {
	private readonly entries: ObserverEntry[] = [];
	/** ComponentID → its observers (structural + onSet). */
	private readonly byCid = new Map<number, ObserverEntry[]>();
	/** Cached access-topological order; invalidated on register / dispose. */
	private _topo: ObserverEntry[] | null = null;

	// --- dispatch scratch (reused; never reallocated in the hot loop) ---
	// Per-component eid buckets for the current structural round, keyed by cid.
	private readonly _addBuckets = new Map<number, number[]>();
	private readonly _remBuckets = new Map<number, number[]>();
	// Disable / enable buckets (#677) — populated only on a toggle-drain round
	// (toggles drain once add/remove/destroy are quiescent, so a round carries
	// either structural events or toggle events, never both).
	private readonly _disBuckets = new Map<number, number[]>();
	private readonly _enaBuckets = new Map<number, number[]>();
	private readonly _radixOut: number[] = [];
	private readonly _radixC0 = new Int32Array(1024);
	private readonly _radixC1 = new Int32Array(1024);
	// Per-`dispatchSet` cache of each component's drained dirty list, so a
	// component with more than one per-entity onSet observer takes (and clears
	// the dedup bits of) its list exactly once and fans the same snapshot out to
	// every observer. Cleared at the end of each dispatch. (Bug: a second
	// per-entity onSet observer on the same component used to see an empty list.)
	private readonly _setDrainCache = new Map<number, EntityID[]>();

	constructor(
		private readonly store: ObserverHost,
		private readonly ctx: SystemContext
	) {}

	get count(): number {
		return this.entries.length;
	}

	/** The synthesized `SystemDescriptor`s of every registered observer, in
	 * registration order (`dispose()` splices entries out, so none are stale).
	 * Fed into the `startup()` archetype-prewarm closure so an observer's declared
	 * `spawns` / `transitions` create their target archetypes eagerly, exactly as a
	 * system's do (#768). Without this an observer-spawned/-transitioned archetype
	 * first-touches lazily mid-tick — the one asymmetry left in the otherwise
	 * uniform "no lazy archetypes" prewarm. */
	descriptors(): SystemDescriptor[] {
		const out: SystemDescriptor[] = new Array(this.entries.length);
		for (let i = 0; i < this.entries.length; i++) out[i] = this.entries[i].descriptor;
		return out;
	}

	register(def: ComponentHandle, config: ObserverConfig): ObserverHandle {
		const cid = def.id;
		const granularity = config.granularity ?? "archetype";
		const isEntitySet = config.onSet !== undefined && granularity === "entity";
		const isArchSet = config.onSet !== undefined && granularity !== "entity";
		if (DEV && config.onSet === undefined && config.granularity !== undefined) {
			throw new ECSError(
				ECS_ERROR.OBSERVER_INVALID_CONFIG,
				"observe(): `granularity` is meaningless without `onSet`"
			);
		}
		if (
			DEV &&
			config.onAdd === undefined &&
			config.onRemove === undefined &&
			config.onDisable === undefined &&
			config.onEnable === undefined &&
			config.onSet === undefined
		) {
			throw new ECSError(
				ECS_ERROR.OBSERVER_INVALID_CONFIG,
				"observe(): at least one of onAdd / onRemove / onDisable / onEnable / onSet is required"
			);
		}

		const access = config.access ?? {};
		const descriptor = synthDescriptor(`observer(${cid})`, access);
		const entry: ObserverEntry = {
			// Share one identity space with the descriptor (used only for the
			// topo tie-break + diagnostics).
			id: descriptor.id as unknown as number,
			cid,
			def,
			onAdd: config.onAdd,
			onRemove: config.onRemove,
			onDisable: config.onDisable,
			onEnable: config.onEnable,
			onSetEntity: isEntitySet ? (config.onSet as ObserverFn) : undefined,
			onSetArch: isArchSet ? (config.onSet as ArchetypeObserverFn) : undefined,
			descriptor,
			writes: idSet(access.writes),
			reads: idSet(access.reads),
			yieldExisting: config.yieldExisting ?? false,
			lastSetTick: 0,
			disposed: false
		};

		this.entries.push(entry);
		let bucket = this.byCid.get(cid);
		if (bucket === undefined) {
			bucket = [];
			this.byCid.set(cid, bucket);
		}
		bucket.push(entry);
		this._topo = null;
		this._reconfigureComponent(cid);

		if (entry.yieldExisting && entry.onAdd !== undefined) this._yieldExisting(entry);

		return {
			dispose: () => this._dispose(entry)
		};
	}

	private _dispose(entry: ObserverEntry): void {
		if (entry.disposed) return;
		entry.disposed = true;
		const i = this.entries.indexOf(entry);
		if (i >= 0) this.entries.splice(i, 1);
		const bucket = this.byCid.get(entry.cid);
		if (bucket !== undefined) {
			const j = bucket.indexOf(entry);
			if (j >= 0) bucket.splice(j, 1);
			if (bucket.length === 0) this.byCid.delete(entry.cid);
		}
		this._topo = null;
		this._reconfigureComponent(entry.cid);
	}

	/** Recompute the component's hot-path observation flags from its live
	 * observers and push them to the store (which owns the flags + fast-path
	 * counters). */
	private _reconfigureComponent(cid: number): void {
		const bucket = this.byCid.get(cid);
		let hasAdd = false;
		let hasRem = false;
		let hasDisable = false;
		let hasEnable = false;
		let trackDirty = false;
		if (bucket !== undefined) {
			for (let i = 0; i < bucket.length; i++) {
				const e = bucket[i];
				if (e.onAdd !== undefined) hasAdd = true;
				if (e.onRemove !== undefined) hasRem = true;
				if (e.onDisable !== undefined) hasDisable = true;
				if (e.onEnable !== undefined) hasEnable = true;
				if (e.onSetEntity !== undefined) trackDirty = true;
			}
		}
		this.store._configureComponentObservation(
			cid,
			hasAdd,
			hasRem,
			hasDisable,
			hasEnable,
			trackDirty
		);
	}

	private getTopo(): ObserverEntry[] {
		if (this._topo === null) this._topo = topoOrder(this.entries);
		return this._topo;
	}

	// =======================================================
	// Structural dispatch (onAdd / onRemove)
	// =======================================================

	/**
	 * Fire onAdd / onRemove / onDisable / onEnable for one fixed-point round's
	 * effective events, in canonical order: access-topological across observers,
	 * entity-id order (radix) within each observer. Called by
	 * `Store.flushStructural` after the batch commits; observer callbacks may
	 * enqueue further structural ops (or toggles) onto the deferred buffers (the
	 * store loops until quiescent).
	 *
	 * The events arrive as flat `(comp, eid)` parallel arrays collected during the
	 * flush; we bucket by component once (O(K)), then walk observers in topo order
	 * so a producer's writes are visible to a consumer (glitch-free). A round
	 * carries either structural (add/rem) OR toggle (dis/ena) events, never both —
	 * toggles drain only once add/remove/destroy are quiescent (`flushStructural`)
	 * — but we bucket all four uniformly; the empty pairs are no-ops. Within an
	 * observer the fire order is remove, add, disable, enable (the "leaving" edges
	 * before the "entering" edges).
	 */
	dispatchStructural(ev: StructuralObserverEvents): void {
		this._bucket(ev.addComp, ev.addEid, ev.addLen, this._addBuckets);
		this._bucket(ev.remComp, ev.remEid, ev.remLen, this._remBuckets);
		this._bucket(ev.disComp, ev.disEid, ev.disLen, this._disBuckets);
		this._bucket(ev.enaComp, ev.enaEid, ev.enaLen, this._enaBuckets);

		const order = this.getTopo();
		const prev = DEV ? accessCheck.current() : null;
		for (let oi = 0; oi < order.length; oi++) {
			const obs = order[oi];
			// Skip an observer disposed mid-round: a `dispose()` handle is reachable
			// from a sibling observer's callback; `_dispose` flips `disposed` and
			// splices the master arrays, but not this already-captured `order`
			// snapshot — without this check the "disposed" observer still fires for
			// components later in the topo order this same round. #726.
			if (obs.disposed) continue;
			if (obs.onRemove !== undefined) {
				const eids = this._remBuckets.get(obs.cid);
				if (eids !== undefined && eids.length > 0)
					this._fireEach(obs, obs.onRemove, eids, "remove");
			}
			if (obs.onAdd !== undefined) {
				const eids = this._addBuckets.get(obs.cid);
				if (eids !== undefined && eids.length > 0) this._fireEach(obs, obs.onAdd, eids, "add");
			}
			if (obs.onDisable !== undefined) {
				const eids = this._disBuckets.get(obs.cid);
				if (eids !== undefined && eids.length > 0)
					this._fireEach(obs, obs.onDisable, eids, "disable");
			}
			if (obs.onEnable !== undefined) {
				const eids = this._enaBuckets.get(obs.cid);
				if (eids !== undefined && eids.length > 0)
					this._fireEach(obs, obs.onEnable, eids, "enable");
			}
		}
		if (DEV && prev !== null) accessCheck.enter(prev);

		this._clearBuckets(this._addBuckets);
		this._clearBuckets(this._remBuckets);
		this._clearBuckets(this._disBuckets);
		this._clearBuckets(this._enaBuckets);
	}

	/** Radix-sort `eids` by entity index (canonical within-observer order), then
	 * fire `fn` per entity under the observer's access scope. */
	private _fireEach(obs: ObserverEntry, fn: ObserverFn, eids: number[], op: ObserverOp): void {
		radixSortByIndex(eids, this._radixOut, this._radixC0, this._radixC1);
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			const trace = DEV ? this.store._trace : null;
			for (let i = 0; i < eids.length; i++) {
				fn(unsafeCast<EntityID>(eids[i]), this.ctx);
				if (DEV) trace?.observerFired(op, obs.cid, eids[i], obs.descriptor);
			}
		} finally {
			if (DEV) accessCheck.leave();
		}
	}

	private _bucket(comp: number[], eid: number[], len: number, into: Map<number, number[]>): void {
		for (let i = 0; i < len; i++) {
			const cid = comp[i];
			let b = into.get(cid);
			if (b === undefined) {
				b = [];
				into.set(cid, b);
			}
			b.push(eid[i]);
		}
	}

	private _clearBuckets(buckets: Map<number, number[]>): void {
		for (const b of buckets.values()) b.length = 0;
	}

	// =======================================================
	// onSet dispatch (post-update detection point)
	// =======================================================

	/**
	 * Fire onSet observers for the current tick, in canonical order. Per-entity
	 * onSet drains the opt-in dirty list (once per changed entity); archetype-
	 * granular onSet scans the change tick (once per changed archetype-column).
	 * Called by `ECS.update` after all phases, with `tick === store._tick`.
	 */
	dispatchSet(tick: number): void {
		if (this.entries.length === 0) return;
		const prev = DEV ? accessCheck.current() : null;
		// Canonical across observers: topo order (same as structural).
		const order = this.getTopo();
		const drained = this._setDrainCache;
		for (let oi = 0; oi < order.length; oi++) {
			const obs = order[oi];
			if (obs.onSetEntity !== undefined) this._dispatchSetEntity(obs, drained);
			else if (obs.onSetArch !== undefined) this._dispatchSetArch(obs, tick);
		}
		// Return the drained scratch lists to the store empty and reset the cache.
		for (const eids of drained.values()) eids.length = 0;
		drained.clear();
		if (DEV && prev !== null) accessCheck.enter(prev);
	}

	private _dispatchSetEntity(obs: ObserverEntry, drained: Map<number, EntityID[]>): void {
		// Take this component's dirty list once per dispatch (clearing its dedup
		// bits) and cache it, so every per-entity onSet observer on the same
		// component fires over the same snapshot instead of the first one draining
		// it out from under the rest.
		let eids = drained.get(obs.cid);
		if (eids === undefined) {
			eids = this.store._takeDirty(obs.cid);
			radixSortByIndex(eids, this._radixOut, this._radixC0, this._radixC1);
			drained.set(obs.cid, eids);
		}
		if (eids.length === 0) return;
		const def = obs.def;
		const fn = obs.onSetEntity!;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			for (let i = 0; i < eids.length; i++) {
				const eid = unsafeCast<EntityID>(eids[i]);
				// A row written then destroyed (or losing the component) before the drain
				// must not fire — verify liveness + membership. A *disabled* entity is
				// also skipped (#677): it is excluded from default queries, so per-entity
				// onSet must match the archetype-granular grain, whose `entityCount`
				// sweep already skips the disabled tail. (The dirty entry is still drained
				// here, so it doesn't accumulate; the value is republished by `onEnable`.)
				if (
					this.store.isAlive(eid) &&
					this.store.hasComponent(eid, def) &&
					!this.store.isDisabled(eid)
				) {
					fn(eid, this.ctx);
					if (DEV) this.store._trace?.observerFired("set", obs.cid, eid, obs.descriptor);
				}
			}
		} finally {
			if (DEV) accessCheck.leave();
		}
	}

	private _dispatchSetArch(obs: ObserverEntry, tick: number): void {
		const fn = obs.onSetArch!;
		const baseline = obs.lastSetTick;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			this.store._forEachChangedArchetype(obs.cid, baseline, (arch) => {
				fn(arch, this.ctx);
				// Archetype-granular onSet has no per-entity id; report a single
				// component-level firing (entity -1) per changed archetype.
				if (DEV) this.store._trace?.observerFired("set", obs.cid, -1, obs.descriptor);
			});
		} finally {
			if (DEV) accessCheck.leave();
		}
		// Next tick, only fire for archetypes changed AFTER this tick.
		obs.lastSetTick = tick + 1;
	}

	// =======================================================
	// yieldExisting
	// =======================================================

	private _yieldExisting(obs: ObserverEntry): void {
		const fn = obs.onAdd!;
		// Enabled members only (#677): a disabled entity is excluded from default
		// queries, so seeding it via onAdd would publish a row that an immediate
		// onDisable should have removed. It is simply absent at seed, matching
		// "delete on disable" — `_collectEntitiesWithComponent` bounds on
		// `enabled_count`.
		const eids = this.store._collectEntitiesWithComponent(obs.cid);
		if (eids.length === 0) return;
		radixSortByIndex(eids, this._radixOut, this._radixC0, this._radixC1);
		// Registration can happen mid-frame (a system closure registering a
		// yieldExisting observer lazily), so snapshot + restore the caller's frame
		// the way `dispatchStructural` / `dispatchSet` do — `accessCheck.leave`
		// nulls `active` rather than popping, and a bare leave here would silently
		// disable dev-mode access enforcement for the rest of the caller's body.
		const prev = DEV ? accessCheck.current() : null;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			for (let i = 0; i < eids.length; i++) fn(unsafeCast<EntityID>(eids[i]), this.ctx);
		} finally {
			if (DEV) {
				accessCheck.leave();
				if (prev !== null) accessCheck.enter(prev);
			}
		}
	}
}

/**
 * O(K) LSD radix sort of entity ids by their 20-bit dense index (two 10-bit
 * passes), in place. This is the canonical within-observer order — *never* a
 * comparator `Array.sort`, which the bench measured at 2–4× the entire flush
 * (`observer_dispatch_probe.ts`). Distinct live entities have distinct indices,
 * so index order is a total canonical order. `out` is scratch (grown to length);
 * `c0` / `c1` are 1024-entry histograms (reused).
 */
export function radixSortByIndex(
	eids: number[],
	out: number[],
	c0: Int32Array,
	c1: Int32Array
): void {
	const K = eids.length;
	if (K < 2) return;
	if (out.length < K) out.length = K;
	c0.fill(0);
	c1.fill(0);
	for (let k = 0; k < K; k++) {
		const v = eids[k] & INDEX_MASK;
		c0[v & 1023]++;
		c1[(v >> 10) & 1023]++;
	}
	for (let i = 1; i < 1024; i++) {
		c0[i] += c0[i - 1];
		c1[i] += c1[i - 1];
	}
	for (let k = K - 1; k >= 0; k--) {
		const v = eids[k];
		out[--c0[v & INDEX_MASK & 1023]] = v;
	}
	for (let k = K - 1; k >= 0; k--) {
		const v = out[k];
		eids[--c1[((v & INDEX_MASK) >> 10) & 1023]] = v;
	}
}
