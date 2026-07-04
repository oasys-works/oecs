/***
 * Grouped ECS facades (H3 phase 2, signed off 2026-07-05).
 *
 * Four cohesive secondary surfaces move off the flat `ECS` namespace onto
 * narrow typed facades: `ecs.relations`, `ecs.events`, `ecs.resources`,
 * `ecs.snapshots`. Each wraps the same `Store` entry points the flat
 * methods used (monomorphic one-hop delegation — bench-established as free
 * by the H1 A/B runs), and the `__DEV__` adaptation the flat methods
 * carried (dispatch-trace recording, access checks) moves here with them.
 *
 * The flat forms remain on `ECS` as `@deprecated` delegations for one
 * release (removal targeted at 0.6.0). Hot-path API (component ops,
 * queries, spawn/destroy, sparse ops) stays flat by design — see
 * plans/H3-ecs-facade-slimming.md.
 *
 * Constructed once per `ECS`; hold no state of their own.
 */

import type { Store } from "./store";
import type { EntityID } from "./entity";
import type { OnDeleteTarget, RelationDef, RelationOptions } from "./relation";
import type { ResourceKey } from "./resource";
import type {
	EmptyEventSchema,
	EventDef,
	EventFieldsCover,
	EventKey,
	EventReader,
	EventSchema,
	SignalKey
} from "./event";
import { accessCheck } from "./access_check";
import { dispatchTrace } from "./dispatch_trace";
import { unsafeCast } from "../../type_primitives";

/** Relations — sparse `(relation, target)` pairs and hierarchy traversal
 * (#471 / #474, ADR-0011). Add/remove/re-target cause no archetype
 * transition; ops are immediate and safe mid-tick. Traversal and wildcard
 * reads are cold-path. */
export class ECSRelations {
	private readonly store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this.store = store;
	}

	/** Register a relation kind. Exclusive (default) stores one target per
	 * source; `{ multi: true }` stores a target set per source.
	 * `{ onDeleteTarget: "delete" | "clear" | "orphan" }` selects target-death
	 * cleanup (default `orphan`, #473).
	 *
	 * The overloads stamp the CARDINALITY into the handle type (typestate
	 * a173382 / POLISH_AUDIT #7), exactly like the flat `registerRelation`:
	 * the exclusive-only surfaces (`targetOf`, `ancestorsOf`/`rootOf`/
	 * `cascadeOf`, `Query.hierarchy`) accept only `RelationDef<"exclusive">`,
	 * so passing a `{ multi: true }` relation is a compile error. A
	 * dynamically-built options value falls to the erased overload and keeps
	 * the runtime check as its only guard. */
	public register(opts?: {
		readonly exclusive?: true;
		readonly multi?: false;
		readonly onDeleteTarget?: OnDeleteTarget;
	}): RelationDef<"exclusive">;
	public register(opts: {
		readonly multi: true;
		readonly exclusive?: false;
		readonly onDeleteTarget?: OnDeleteTarget;
	}): RelationDef<"multi">;
	public register(opts?: RelationOptions): RelationDef;
	public register(opts?: RelationOptions): RelationDef {
		return this.store.registerRelation(opts);
	}

	/** Count of registered relations. */
	public get count(): number {
		return this.store.relationCount;
	}

	/** Add a `(R, tgt)` pair to `src`. Exclusive replaces the existing target;
	 * multi adds to the set. No archetype transition. */
	public add(src: EntityID, def: RelationDef, tgt: EntityID): this {
		this.store.addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`. For multi, omitting `tgt` removes
	 * all of `src`'s targets. No archetype transition. */
	public remove(src: EntityID, def: RelationDef, tgt?: EntityID): this {
		this.store.removeRelation(src, def, tgt);
		return this;
	}

	/** Whether `src` holds any pair under `R`. */
	public has(src: EntityID, def: RelationDef): boolean {
		return this.store.hasRelation(src, def);
	}

	/** The single target of `src` under an exclusive relation, or `undefined`. */
	public targetOf(src: EntityID, def: RelationDef<"exclusive">): EntityID | undefined {
		return this.store.targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id. */
	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		return this.store.targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id. */
	public sourcesOf(def: RelationDef, tgt: EntityID): EntityID[] {
		return this.store.sourcesOf(def, tgt);
	}

	/** All `(source, target)` pairs of relation `R` — the `(R, *)` wildcard
	 * (#472). Sources in canonical entity-index order. Cold path. */
	public pairsOf(def: RelationDef): [EntityID, EntityID][] {
		return this.store.pairsOf(def);
	}

	/** Every `(relation, source)` pointing at `tgt`, across all relation kinds —
	 * the `(*, T)` wildcard (#472). Ordered by relation id then source id. */
	public sourcesOfAny(tgt: EntityID): [RelationDef, EntityID][] {
		return this.store.sourcesOfAny(tgt);
	}

	/** Walk relation `R` up from `src` to its chain root, returning
	 * `[src, parent, …, root]` (nearest-ancestor-first). Exclusive only. */
	public ancestorsOf(src: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this.store.ancestorsOf(src, def);
	}

	/** The root of `src`'s `R`-chain (`src` itself when it has no target).
	 * Exclusive only. */
	public rootOf(src: EntityID, def: RelationDef<"exclusive">): EntityID {
		return this.store.rootOf(src, def);
	}

	/** Walk relation `R` down from `root` over the reverse index, returning the
	 * subtree (including `root`) breadth-first — parents before children (the
	 * `cascade` order). Exclusive only. */
	public cascadeOf(root: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this.store.cascadeOf(root, def);
	}

	/** Reclaim relation reverse-index memory: drop every reverse entry whose
	 * target has been destroyed, returning the total dropped (#491). Purely
	 * cold-path, no observable state change — call at scene/snapshot
	 * boundaries. */
	public compact(): number {
		return this.store.compactRelations();
	}
}

/** Event channels and signals. Emit during one `update()`, visible to every
 * later system in that call, cleared before the next. System-side reads and
 * emits go through `ctx` — this facade is the HOST-side surface. */
export class ECSEvents {
	private readonly store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this.store = store;
	}

	/** Register an event channel. `fields` must name EVERY schema key — an
	 * under-registered channel would silently drop the missing fields at emit
	 * (see `EventFieldsCover`). */
	public register<S extends EventSchema, const F extends readonly (keyof S & string)[]>(
		key: EventKey<S>,
		fields: F & EventFieldsCover<S, F>
	): void {
		this.store.registerEventByKey<S>(key, fields);
	}

	/** Register a signal (empty-payload event channel). */
	public registerSignal(key: SignalKey): void {
		this.store.registerEventByKey<EmptyEventSchema>(key, []);
	}

	public emit(key: SignalKey): void;
	public emit<S extends EventSchema>(key: EventKey<S>, values: NoInfer<S>): void;
	// Erased implementation position spells `<any>`, not the bare/`unknown`
	// form — `EventKey` is invariant under the typestate seams (function-typed
	// phantom), so only `<any>` erases (see project typestate constraints).
	public emit(key: EventKey<any>, values?: Record<string, number>): void {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordEmit(key.description ?? "");
		}
		const def = this.store.getEventDefByKey(key);
		if (values === undefined) {
			this.store.emitSignal(def as EventDef<EmptyEventSchema>);
		} else {
			this.store.emitEvent(def, values);
		}
	}

	public read<S extends EventSchema>(key: EventKey<S>): EventReader<S> {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordRead(key.description ?? "");
		}
		const def = this.store.getEventDefByKey(key);
		return this.store.getEventReader(def) as EventReader<S>;
	}
}

/** World resources — singleton values keyed by `ResourceKey<T>`. Runtime
 * mutations (`set` / `remove`) are access-checked as resource writes inside
 * a system span; `register` is a one-time world-setup op. */
export class ECSResources {
	private readonly store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this.store = store;
	}

	public register<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordResourceRegister(key.description ?? "");
		}
		this.store.registerResource(key, value);
	}

	public get<T>(key: ResourceKey<T>): T {
		if (__DEV__) {
			accessCheck.checkResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<T>(this.store.getResource(key));
	}

	public set<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (__DEV__) {
			accessCheck.checkResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this.store.setResource(key, value);
	}

	/** Drop a resource from the world (#798). Access-checked as a *write*;
	 * fails closed on a missing key. Afterwards the key is free to `register`
	 * again — the present → absent → present lifecycle. */
	public remove<T>(key: ResourceKey<T>): void {
		if (__DEV__) {
			accessCheck.checkResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this.store.removeResource(key);
	}

	public has<T>(key: ResourceKey<T>): boolean {
		return this.store.hasResource(key);
	}
}

/** The determinism surface (#626 / ADR-0020): world snapshot/resume and the
 * canonical state digest. Every member except `deterministic` throws
 * `DETERMINISM_DISABLED` unless the world was constructed with
 * `{ deterministic: true }`. All cold-path — take captures at tick
 * boundaries (between `update()`s). */
export class ECSSnapshots {
	private readonly store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this.store = store;
	}

	/** Whether the determinism surface is enabled. */
	public get deterministic(): boolean {
		return this.store.deterministic;
	}

	/** FNV-1a 32 digest over every archetype's live rows in id order — the
	 * canonical "live ECS state digest". Per-call cost scales with live
	 * entity count, not SAB capacity. */
	public stateHash(): number {
		return this.store.stateHash();
	}

	/** Capture the full live world (dense + sparse/relations + host-side
	 * bookkeeping) to one self-contained byte buffer that `restore` can mount
	 * back onto a live, ticking world (#789). v1 does NOT capture resources,
	 * events, or change-detection baselines (ADR-0031). */
	public capture(): Uint8Array {
		return this.store.snapshot();
	}

	/** Mount a `capture()` buffer onto this live world and keep ticking.
	 * Fails closed on a malformed frame or registration mismatch BEFORE
	 * mutating any live state. Requires a matching archetype set + column
	 * layout (prewarm so the set is stable). */
	public restore(bytes: Uint8Array): void {
		this.store.restoreInto(bytes);
	}

	/** Serialize the sparse stores + relations to a self-contained buffer —
	 * the sparse half of a world snapshot, canonical entity-index order
	 * (#470). Pairs with `restoreSparse`. */
	public captureSparse(): Uint8Array {
		return this.store.snapshotSparse();
	}

	/** Repopulate the sparse stores + relation indices from `captureSparse`
	 * bytes. Sparse components must already be registered in the same order;
	 * throws `SparseRestoreError` on a shape or identity mismatch. */
	public restoreSparse(bytes: Uint8Array): void {
		this.store.restoreSparse(bytes);
	}
}
