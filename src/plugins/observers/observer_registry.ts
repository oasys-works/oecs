/***
 * Observer, per-component reactive hooks (onAdd, onRemove, onDisable,
 * onEnable and onSet).
 *
 * onDisable and onEnable extend the structural model to the entity enable and disable transition:
 * the partition swap (`disableRow` and `enableRow`) fires no `onAdd` or `onRemove`, so a
 * consumer that reads the change feed was blind to it. onDisable and onEnable fire at
 * the *deferred* toggle drain in `flushStructural`, like onAdd and onRemove, an
 * *immediate* host-side `ecs.disable()` does not fire, for *every component
 * the entity carries* (a disable is a soft remove of the whole mask from default
 * queries, the symmetric idea to a destroy fanning onRemove over the mask), and
 * collapse to one event per *net* transition across a drain (disable→enable→
 * disable in a tick = a single onDisable. Required so the radix canonical order
 * never reorders a duplicate eid).
 * bitECS and flecs expose first-class component observers. We had only system
 * lifecycle hooks, so reactions ("on `Death` added → spawn corpse", "on
 * `HexPos` set → mark spatial index") were hand-polled every tick. Observers
 * express them directly.
 *
 * The mechanism avoids two measured traps:
 *
 *   1. **onSet is not a per-write hook.** A per-element observable setter loses
 *      to change detection. So onSet is *derived*:
 *      archetype-granular onSet ≡ the existing per-archetype change tick (free),
 *      per-entity onSet ≡ the opt-in per-row dirty list surfaced as a
 *      callback.
 *   2. **onAdd and onRemove ordering is a comparator sort.** `Array.sort` for the
 *      canonical firing order costs more than the entire flush. An O(K) LSD
 *      radix on the bounded 20-bit entity index gives the same order for a
 *      small part of that cost. Determinism is cheap *only* if you do not
 *      compare-sort.
 *
 * Firing order is two composed layers, both deterministic:
 *   - **across observers**, access-topological (writer-of-X before readers-of-X,
 *     from each observer's `SystemAccessDeclaration`): deterministic *and*
 *     glitch-free, the ECS analog of Solid's height order.
 *   - **within an observer**, entity-id order via the radix pass above.
 *
 * Structural observers (onAdd and onRemove) fire during `Store.flushStructural`,
 * *after* the batch commits (observers never see a torn state), looping to a
 * fixed point so cascades settle. onSet fires at the post-update detection
 * point. Observer, dirty and event state is a scheduling artifact, kept out of
 * `stateHash` and snapshot (like `_changedTick`), but produced in canonical
 * order so replays reproduce.
 *
 * This module owns the registry + ordering + dispatch. The hot-path event
 * collection and the deferred fixed-point loop live in `store.ts` (it owns the
 * flush). The access-topological order built here is the same write-disjointness
 * graph a later multithreaded execution can reuse.
 ***/

import { unsafeCast } from "../../type_primitives";
import type { ComponentDef, ComponentHandle } from "../../core/ecs/component";
import type { SparseComponentDef } from "../../core/ecs/sparse_store";
import type { EntityID } from "../../core/ecs/entity";
import type { ObserverOp } from "../../core/ecs/frame_trace";
import type { SystemContext } from "../../core/ecs/system_context";
import type { DrainResult, StructuralObserverEvents } from "../../core/ecs/store";
import {
	_INTERNAL_EMPTY_ACCESS,
	asSystemId,
	type SystemAccessDeclaration,
	type SystemDescriptor
} from "../../core/ecs/system";
import type {
	ArchetypeObserverFn,
	ObserverConfig,
	ObserverFn,
	ObserverHandle,
	ObserverHooks,
	ObserverHost
} from "../../core/ecs/observer";
import { accessCheck } from "../../core/ecs/access_check";
import { componentDebugName } from "../../core/ecs/debug_names";
import { ECS_ERROR, ECSError } from "../../core/ecs/utils/error";
import { radixSortByIndex } from "../../core/ecs/utils/arrays";
import { DEV } from "../../dev_flag";

/** This registry's key in the store's per-consumer observation records. It is
 * the plugin name, which is what keeps two consumers apart. */
const OBSERVERS_CONSUMER = "observers";

// Runtime fallback matching the TS and Babel downlevel `using` helpers, which key
// off Symbol.for("Symbol.dispose") when the well-known symbol is absent.
const DISPOSE: typeof Symbol.dispose =
	Symbol.dispose ?? (Symbol.for("Symbol.dispose") as typeof Symbol.dispose);

/** A registered observer (one component). */
interface ObserverEntry {
	readonly id: number;
	readonly cid: number;
	/** The observed component's handle, carried so per-entity onSet can
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
	/** Component ids this observer writes and reads, drives the topo order. */
	readonly writes: ReadonlySet<number>;
	readonly reads: ReadonlySet<number>;
	readonly yieldExisting: boolean;
	/** Per-observer baseline tick for archetype-granular onSet (mirrors
	 * `ChangedQuery`'s `lastRunTick`). */
	lastSetTick: number;
	disposed: boolean;
}

const INDEX_MASK = (1 << 20) - 1; // entity.ts: 20-bit dense index

let nextObserverId = 0;

/** An entity-level onSet on a sparse component. A sparse component has no
 * archetype, so it has no structural events and no archetype grain: this is
 * the one observer shape it takes. Dispatched after the dense observers, in
 * registration order. */
interface SparseSetEntry {
	readonly id: number;
	readonly sid: number;
	readonly onSet: ObserverFn;
	readonly descriptor: SystemDescriptor;
	disposed: boolean;
}

/** Synthesize a frozen `SystemDescriptor` from a (partial) access declaration so
 * `accessCheck` can validate observer callbacks exactly as it does systems. The
 * object identity is stable for the observer's lifetime (cached in accessCheck's
 * WeakMap). The `fn` is never called, observers dispatch through their own
 * callbacks. */
function synthDescriptor(
	name: string,
	access: Partial<SystemAccessDeclaration>
): SystemDescriptor {
	const merged: SystemDescriptor = {
		..._INTERNAL_EMPTY_ACCESS,
		...access,
		id: asSystemId(nextObserverId++),
		name,
		fn: noopSystem
	};
	return Object.freeze(merged);
}

function noopSystem(): void {
	/* observers never run via the schedule */
}

function idSet(defs: readonly ComponentDef[] | undefined): Set<number> {
	const s = new Set<number>();
	if (defs) for (let i = 0; i < defs.length; i++) s.add(defs[i].id);
	return s;
}

/** Access-topological order over the registered observers: a producer (writes X)
 * precedes any consumer (reads X). Deterministic Kahn sort, tie-broken by
 * component id then registration id. A write-read cycle (no valid topo order)
 * degrades gracefully: the remaining observers are appended in the same
 * deterministic tie-break order, so the result is still replay-stable (it only
 * can't promise glitch-freedom for the cyclic subset). */
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
		// Cyclic write and read dependency, append the rest deterministically.
		const seen = new Set(out);
		for (const o of entries.slice().sort(tie)) if (!seen.has(o)) out.push(o);
	}
	return out;
}

/**
 * Registry of component observers. Owned by `ECS`. The `Store` calls back into
 * `dispatchStructural` between fixed-point rounds during `flushStructural`,
 * and `ECS.update` calls `dispatchSet` at the post-update detection point.
 */
export class ObserverRegistry implements ObserverHooks {
	private readonly _entries: ObserverEntry[] = [];
	/** ComponentID → its observers (structural + onSet). */
	private readonly _byCid = new Map<number, ObserverEntry[]>();
	/** The entity-level onSet observers on sparse components, in registration
	 * order. */
	private readonly _sparseEntries: SparseSetEntry[] = [];
	/** Per-`dispatchSet` cache of each sparse component's drain, so two
	 * observers on one sparse component fire over one snapshot. */
	private readonly _sparseDrainCache = new Map<number, EntityID[]>();
	/** Cached access-topological order. A register or a dispose invalidates it. */
	private _topo: ObserverEntry[] | null = null;

	// --- dispatch scratch (reused, never reallocated in the hot loop) ---
	// Per-component eid buckets for the current structural round, keyed by cid.
	private readonly _addBuckets = new Map<number, number[]>();
	private readonly _remBuckets = new Map<number, number[]>();
	// Disable and enable buckets, populated only on a toggle-drain round
	// (toggles drain once add, remove and destroy are quiescent, so a round carries
	// either structural events or toggle events, never both).
	private readonly _disBuckets = new Map<number, number[]>();
	private readonly _enaBuckets = new Map<number, number[]>();
	// The radix scratch is a typed array, grown by doubling, and never a plain
	// array grown by a length assignment: JavaScriptCore turns the latter into a
	// sparse store, and each element store in the pass becomes a hash insert.
	// Measured at an order of magnitude on the drain of a large frame there.
	private _radixOut = new Uint32Array(1024);
	private readonly _radixC0 = new Int32Array(1024);
	private readonly _radixC1 = new Int32Array(1024);
	// Per-`dispatchSet` cache of each component's drain, so a component with
	// more than one per-entity onSet observer drains exactly once and fans the
	// same snapshot out to every observer. Cleared at the end of each dispatch.
	// (Bug: a second per-entity onSet observer on the same component used to
	// see an empty list.)
	private readonly _setDrainCache = new Map<number, DrainResult>();

	constructor(
		private readonly _store: ObserverHost,
		private readonly _ctx: SystemContext
	) {}

	get count(): number {
		return this._entries.length + this._sparseEntries.length;
	}

	/** The synthesized `SystemDescriptor`s of every registered observer, in
	 * registration order (`dispose()` splices entries out, so none are stale).
	 * Fed into the `startup()` archetype-prewarm closure so an observer's declared
	 * `spawns` and `transitions` create their target archetypes eagerly, exactly as a
	 * system's do. Without this an archetype an observer spawns into or transitions to
	 * first-touches lazily mid-tick, the one asymmetry left in the otherwise
	 * uniform "no lazy archetypes" prewarm. */
	descriptors(): SystemDescriptor[] {
		const out: SystemDescriptor[] = [];
		for (let i = 0; i < this._entries.length; i++) out.push(this._entries[i].descriptor);
		for (let i = 0; i < this._sparseEntries.length; i++) out.push(this._sparseEntries[i].descriptor);
		return out;
	}

	register(def: ComponentHandle | SparseComponentDef, config: ObserverConfig): ObserverHandle {
		// A sparse component is a number at runtime, and takes one observer
		// shape, the entity-level onSet, below. A relation is a number in its own
		// id space, which the types keep apart and the runtime cannot.
		if (typeof def === "number") return this._registerSparse(def as unknown as number, config);
		const cid = def.id;
		if (typeof cid !== "number") {
			throw new ECSError(
				ECS_ERROR.OBSERVER_INVALID_CONFIG,
				"observe(): the definition is not a registered component. Observe a dense or a sparse component"
			);
		}
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
				"observe(): at least one of onAdd, onRemove, onDisable, onEnable and onSet is required"
			);
		}

		const access = config.access ?? {};
		const descriptor = synthDescriptor(
			config.name ?? `observer(${componentDebugName(def) ?? cid})`,
			access
		);
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

		this._entries.push(entry);
		let bucket = this._byCid.get(cid);
		if (bucket === undefined) {
			bucket = [];
			this._byCid.set(cid, bucket);
		}
		bucket.push(entry);
		this._topo = null;
		this._reconfigureComponent(cid);

		if (entry.yieldExisting && entry.onAdd !== undefined) this._yieldExisting(entry);

		const dispose = (): void => this._dispose(entry);
		return { dispose, [DISPOSE]: dispose };
	}

	/** The sparse arm of `register`: an entity-level onSet, and nothing else.
	 * A sparse add and remove are immediate and touch no archetype, so there
	 * is no flush boundary to fire a structural observer at, and no archetype
	 * column for the archetype grain. */
	private _registerSparse(sid: number, config: ObserverConfig): ObserverHandle {
		if (
			config.onSet === undefined ||
			config.granularity !== "entity" ||
			config.onAdd !== undefined ||
			config.onRemove !== undefined ||
			config.onDisable !== undefined ||
			config.onEnable !== undefined
		) {
			throw new ECSError(
				ECS_ERROR.OBSERVER_INVALID_CONFIG,
				'observe(): a sparse component takes onSet with granularity "entity" and no other callback. Move onAdd, onRemove, onDisable, onEnable and the archetype grain to a dense component'
			);
		}
		const descriptor = synthDescriptor(config.name ?? `observer(sparse ${sid})`, config.access ?? {});
		const entry: SparseSetEntry = {
			id: descriptor.id as unknown as number,
			sid,
			onSet: config.onSet as ObserverFn,
			descriptor,
			disposed: false
		};
		this._sparseEntries.push(entry);
		this._store.configureSparseObservation(OBSERVERS_CONSUMER, sid, true);
		const dispose = (): void => {
			if (entry.disposed) return;
			entry.disposed = true;
			const i = this._sparseEntries.indexOf(entry);
			if (i >= 0) this._sparseEntries.splice(i, 1);
			let left = false;
			for (let k = 0; k < this._sparseEntries.length; k++) if (this._sparseEntries[k].sid === sid) left = true;
			if (!left) this._store.configureSparseObservation(OBSERVERS_CONSUMER, sid, false);
		};
		return { dispose, [DISPOSE]: dispose };
	}

	private _dispose(entry: ObserverEntry): void {
		if (entry.disposed) return;
		entry.disposed = true;
		const i = this._entries.indexOf(entry);
		if (i >= 0) this._entries.splice(i, 1);
		const bucket = this._byCid.get(entry.cid);
		if (bucket !== undefined) {
			const j = bucket.indexOf(entry);
			if (j >= 0) bucket.splice(j, 1);
			if (bucket.length === 0) this._byCid.delete(entry.cid);
		}
		this._topo = null;
		this._reconfigureComponent(entry.cid);
	}

	/** Recompute the component's hot-path observation flags from its live
	 * observers and push them to the store (which owns the flags + fast-path
	 * counters). */
	private _reconfigureComponent(cid: number): void {
		const bucket = this._byCid.get(cid);
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
		this._store.configureObservation(OBSERVERS_CONSUMER, cid, {
			add: hasAdd,
			remove: hasRem,
			disable: hasDisable,
			enable: hasEnable,
			set: trackDirty
		});
	}

	private _getTopo(): ObserverEntry[] {
		if (this._topo === null) this._topo = topoOrder(this._entries);
		return this._topo;
	}

	// =======================================================
	// Structural dispatch (onAdd and onRemove)
	// =======================================================

	/**
	 * Fire onAdd, onRemove, onDisable and onEnable for one fixed-point round's
	 * effective events, in canonical order: access-topological across observers,
	 * entity-id order (radix) within each observer. Called by
	 * `Store.flushStructural` after the batch commits. Observer callbacks may
	 * enqueue further structural ops (or toggles) onto the deferred buffers (the
	 * store loops until quiescent).
	 *
	 * The events arrive as flat `(comp, eid)` parallel arrays collected during the
	 * flush. We bucket by component once (O(K)), then walk observers in topo order
	 * so a producer's writes are visible to a consumer (glitch-free). A round
	 * carries either structural (add, remove) or toggle (disable, enable) events, never both,
	 * toggles drain only once add, remove and destroy are quiescent (`flushStructural`),
	 * but we bucket all four uniformly. The empty pairs are no-ops. Within an
	 * observer the fire order is remove, add, disable, enable (the "leaving" edges
	 * before the "entering" edges).
	 */
	dispatchStructural(ev: StructuralObserverEvents): void {
		this._bucket(ev.addComp, ev.addEid, ev.addLen, this._addBuckets);
		this._bucket(ev.remComp, ev.remEid, ev.remLen, this._remBuckets);
		this._bucket(ev.disComp, ev.disEid, ev.disLen, this._disBuckets);
		this._bucket(ev.enaComp, ev.enaEid, ev.enaLen, this._enaBuckets);

		const order = this._getTopo();
		const prev = DEV ? accessCheck.current() : null;
		for (let oi = 0; oi < order.length; oi++) {
			const obs = order[oi];
			// Skip an observer disposed mid-round: a `dispose()` handle is reachable
			// from a sibling observer's callback. `_dispose` flips `disposed` and
			// splices the master arrays, but not this already-captured `order`
			// snapshot, without this check the "disposed" observer still fires for
			// components later in the topo order this same round.
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
		this._radixOut = radixSortByIndex(eids, this._radixOut, this._radixC0, this._radixC1);
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			const trace = DEV ? this._store.trace : null;
			for (let i = 0; i < eids.length; i++) {
				fn(unsafeCast<EntityID>(eids[i]), this._ctx);
				if (DEV) trace?.observerFired(op, obs.cid, eids[i], obs.descriptor);
			}
		} finally {
			if (DEV) accessCheck.leave();
		}
	}

	private _bucket(cids: number[], eids: number[], len: number, into: Map<number, number[]>): void {
		for (let i = 0; i < len; i++) {
			const cid = cids[i];
			let b = into.get(cid);
			if (b === undefined) {
				b = [];
				into.set(cid, b);
			}
			b.push(eids[i]);
		}
	}

	private _clearBuckets(buckets: Map<number, number[]>): void {
		for (const b of buckets.values()) b.length = 0;
	}

	// =======================================================
	// onSet dispatch (post-update detection point)
	// =======================================================

	/**
	 * Fire onSet observers for the current frame, in canonical order. Per-entity
	 * onSet drains the opt-in dirty list, once for each changed entity.
	 * Archetype-granular onSet scans the change tick, once for each changed
	 * archetype column.
	 * Called by `ECS.update` after all phases. `run` is the change tick advanced
	 * for this dispatch: above every system run of the frame, and the baseline
	 * each archetype-granular observer keeps for its next dispatch.
	 */
	dispatchSet(run: number): void {
		if (this._entries.length === 0 && this._sparseEntries.length === 0) return;
		const prev = DEV ? accessCheck.current() : null;
		// Canonical across observers: topo order (same as structural).
		const order = this._getTopo();
		const drained = this._setDrainCache;
		for (let oi = 0; oi < order.length; oi++) {
			const obs = order[oi];
			if (obs.onSetEntity !== undefined) this._dispatchSetEntity(obs, drained, run);
			else if (obs.onSetArch !== undefined) this._dispatchSetArch(obs, run);
		}
		// The store owns and reuses the result objects. Only the cache resets.
		drained.clear();
		// The sparse observers, after the dense ones, in registration order.
		const sparse = this._sparseEntries;
		if (sparse.length !== 0) {
			const cache = this._sparseDrainCache;
			for (let i = 0; i < sparse.length; i++) {
				const obs = sparse[i];
				if (obs.disposed) continue;
				this._dispatchSparseSet(obs, cache, run);
			}
			cache.clear();
		}
		if (DEV && prev !== null) accessCheck.enter(prev);
	}

	/** Fire one sparse observer over the members recorded since the last
	 * drain. The store's walk gives alive, member and enabled entities, so no
	 * check remains here. Canonical order by entity index, through the radix. */
	private _dispatchSparseSet(obs: SparseSetEntry, cache: Map<number, EntityID[]>, run: number): void {
		let eids = cache.get(obs.sid);
		if (eids === undefined) {
			eids = this._store.drainSparseSet(obs.sid, run);
			this._radixOut = radixSortByIndex(eids, this._radixOut, this._radixC0, this._radixC1);
			cache.set(obs.sid, eids);
		}
		if (eids.length === 0) return;
		const fn = obs.onSet;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			for (let i = 0; i < eids.length; i++) {
				fn(eids[i], this._ctx);
				if (DEV) this._store.trace?.observerFired("set", obs.sid, eids[i], obs.descriptor);
			}
		} finally {
			if (DEV) accessCheck.leave();
		}
	}

	private _dispatchSetEntity(
		obs: ObserverEntry,
		drained: Map<number, DrainResult>,
		run: number
	): void {
		// Drain this component once per dispatch and cache the result, so every
		// per-entity onSet observer on the same component fires over the same
		// snapshot instead of the first one draining it out from under the rest.
		let res = drained.get(obs.cid);
		if (res === undefined) {
			res = this._store.drainSet(obs.cid, run);
			this._radixOut = radixSortByIndex(res.scanned, this._radixOut, this._radixC0, this._radixC1);
			this._radixOut = radixSortByIndex(res.listed, this._radixOut, this._radixC0, this._radixC1);
			dedupeSorted(res.listed);
			drained.set(obs.cid, res);
		}
		const scanned = res.scanned;
		const listed = res.listed;
		const n = scanned.length;
		const m = listed.length;
		if (n === 0 && m === 0) return;
		const def = obs.def;
		const fn = obs.onSetEntity!;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			// Two runs, each in entity-index order, merged so the firing order is the
			// canonical one. A scanned row came from the enabled partition of a live
			// archetype, so it fires with no check. A listed entity was recorded by
			// id, and it may have died, lost the component or been disabled since:
			// a disabled entity is excluded from default queries, so per-entity
			// onSet must match the archetype grain, whose `entityCount` sweep skips
			// the disabled tail. (The value is republished by `onEnable`.)
			let i = 0;
			let j = 0;
			while (i < n || j < m) {
				let eid: EntityID;
				if (
					j >= m ||
					(i < n && ((scanned[i] as number) & INDEX_MASK) < ((listed[j] as number) & INDEX_MASK))
				) {
					eid = scanned[i++];
				} else {
					eid = listed[j++];
					if (
						!this._store.isAlive(eid) ||
						!this._store.hasComponent(eid, def) ||
						this._store.isDisabled(eid)
					)
						continue;
				}
				fn(eid, this._ctx);
				if (DEV) this._store.trace?.observerFired("set", obs.cid, eid, obs.descriptor);
			}
		} finally {
			if (DEV) accessCheck.leave();
		}
	}

	private _dispatchSetArch(obs: ObserverEntry, run: number): void {
		const fn = obs.onSetArch!;
		const baseline = obs.lastSetTick;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			this._store.forEachChangedArchetype(obs.cid, baseline, (arch) => {
				fn(arch, this._ctx);
				// Archetype-granular onSet has no per-entity id. Report a single
				// component-level firing (entity -1) per changed archetype.
				if (DEV) this._store.trace?.observerFired("set", obs.cid, -1, obs.descriptor);
			});
		} finally {
			if (DEV) accessCheck.leave();
		}
		// The next dispatch reports only stamps above this run. A stamp the
		// callback made equals `run`, so it comes back to this observer never,
		// and to a later observer in topo order now, which is the glitch-free
		// order. A host write between frames stamps above `run` and is reported.
		obs.lastSetTick = run;
	}

	// =======================================================
	// Seeding a new observer with the existing members
	// =======================================================

	private _yieldExisting(obs: ObserverEntry): void {
		const fn = obs.onAdd!;
		// Enabled members only: a disabled entity is excluded from default
		// queries, so seeding it via onAdd would publish a row that an immediate
		// onDisable should have removed. It is absent at seed, which matches
		// "delete on disable", `collectEnabledWith` bounds on
		// `enabled_count`.
		const eids = this._store.collectEnabledWith(obs.cid);
		if (eids.length === 0) return;
		this._radixOut = radixSortByIndex(eids, this._radixOut, this._radixC0, this._radixC1);
		// Registration can happen mid-frame (a system closure registering a
		// yieldExisting observer lazily), so snapshot + restore the caller's frame
		// the way `dispatchStructural` and `dispatchSet` do, `accessCheck.leave`
		// nulls `active` rather than popping, and a bare leave here would silently
		// disable dev-mode access enforcement for the rest of the caller's body.
		const prev = DEV ? accessCheck.current() : null;
		if (DEV) accessCheck.enter(obs.descriptor);
		try {
			for (let i = 0; i < eids.length; i++) fn(unsafeCast<EntityID>(eids[i]), this._ctx);
		} finally {
			if (DEV) {
				accessCheck.leave();
				if (prev !== null) accessCheck.enter(prev);
			}
		}
	}
}

/**
 * Drop the repeated ids of a list the radix pass has ordered, in place.
 *
 * The by-id record dedups on the row tick: a record pushes the entity only
 * when the row's previous stamp lay at or below the last drain. A row carries
 * its stamp across a transition, so the record holds for a move. It does not
 * hold when the entity leaves the component and joins it again, because the
 * new row has no stamp to carry and reads as 0, which reopens the push. The
 * entity then sits in the list twice and the observer fires twice for it in
 * one dispatch. Equal ids are adjacent after the radix pass, so one walk
 * removes them. Paid one time for each component in a dispatch, not for each
 * observer on it.
 */
function dedupeSorted(eids: EntityID[]): void {
	const n = eids.length;
	if (n < 2) return;
	let w = 1;
	for (let r = 1; r < n; r++) {
		if (eids[r] === eids[w - 1]) continue;
		eids[w++] = eids[r];
	}
	eids.length = w;
}
