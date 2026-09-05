/***
 * Grouped ECS facades.
 *
 * Four cohesive secondary surfaces move off the flat `ECS` namespace onto
 * narrow typed facades: `ecs.relations`, `ecs.events`, `ecs.resources`,
 * `ecs.snapshots`. Each wraps the same `Store` entry points the flat
 * methods used (monomorphic one-hop delegation, measured as free), and the
 * `DEV` adaptation the flat methods carried (dispatch-trace recording,
 * access checks) moves here with them.
 *
 * The pre-0.5 flat forms were removed from `ECS` in 0.5.0 (never published
 * as deprecated aliases, 0.5.0 is the break). Hot-path API (component ops,
 * queries, spawn and destroy, sparse ops) stays flat by design.
 *
 * Constructed once per `ECS`. Hold no state of their own.
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
	EventShape,
	SignalKey
} from "./event";
import { accessCheck } from "./access_check";
import { capabilityMissingError } from "./utils/capability_error";
import { dispatchTrace } from "./dispatch_trace";
import { unsafeCast } from "../../type_primitives";
import { DEV } from "../../dev_flag";

/** Relations, sparse `(relation, target)` pairs and hierarchy traversal.
 * Add, remove and re-target cause no archetype
 * transition. Ops are immediate and safe mid-tick. Traversal and wildcard
 * reads are cold-path. */
export class ECSRelations {
	private readonly _store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this._store = store;
	}

	/** Register a relation kind. Exclusive (default) stores one target per
	 * source. `{ multi: true }` stores a target set per source.
	 * `{ onDeleteTarget: "delete" | "clear" | "orphan" }` selects target-death
	 * cleanup (default `orphan`).
	 *
	 * The overloads stamp the cardinality into the handle type, exactly like
	 * the flat `registerRelation`:
	 * the exclusive-only surfaces (`targetOf`, `ancestorsOf` and `rootOf`/
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
		return this._store.relations.registerRelation(opts);
	}

	/** Count of registered relations. */
	public get count(): number {
		return this._store.relations.count;
	}

	/** Add a `(R, tgt)` pair to `src`. Exclusive replaces the existing target
	 * multi adds to the set. No archetype transition. */
	public add(src: EntityID, def: RelationDef, tgt: EntityID): this {
		this._store.relations.addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`. For multi, omitting `tgt` removes
	 * all of `src`'s targets. No archetype transition. */
	public remove(src: EntityID, def: RelationDef, tgt?: EntityID): this {
		this._store.relations.removeRelation(src, def, tgt);
		return this;
	}

	/** Whether `src` holds any pair under `R`. */
	public has(src: EntityID, def: RelationDef): boolean {
		return this._store.relations.hasRelation(src, def);
	}

	/** The single target of `src` under an exclusive relation, or `undefined`. */
	public targetOf(src: EntityID, def: RelationDef<"exclusive">): EntityID | undefined {
		return this._store.relations.targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id. */
	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		return this._store.relations.targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id.
	 * `(entity, def)` order, matching `targetOf` / `targetsOf`. */
	public sourcesOf(tgt: EntityID, def: RelationDef): EntityID[] {
		return this._store.relations.sourcesOf(tgt, def);
	}

	/** All `(source, target)` pairs of relation `R`, the `(R, *)` wildcard.
	 * Sources in canonical entity-index order. Cold path. */
	public pairsOf(def: RelationDef): readonly (readonly [EntityID, EntityID])[] {
		return this._store.relations.pairsOf(def);
	}

	/** Every `(relation, source)` pointing at `tgt`, across all relation kinds,
	 * the `(*, T)` wildcard. Ordered by relation id then source id. */
	public sourcesOfAny(tgt: EntityID): readonly (readonly [RelationDef, EntityID])[] {
		return this._store.relations.sourcesOfAny(tgt);
	}

	/** Walk relation `R` up from `src` to its chain root, returning
	 * `[src, parent, …, root]` (nearest-ancestor-first). Exclusive only. */
	public ancestorsOf(src: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this._store.relations.ancestorsOf(src, def);
	}

	/** The root of `src`'s `R`-chain (`src` itself when it has no target).
	 * Exclusive only. */
	public rootOf(src: EntityID, def: RelationDef<"exclusive">): EntityID {
		return this._store.relations.rootOf(src, def);
	}

	/** Walk relation `R` down from `root` over the reverse index, returning the
	 * subtree (including `root`) breadth-first, parents before children (the
	 * `cascade` order). Exclusive only. */
	public cascadeOf(root: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this._store.relations.cascadeOf(root, def);
	}

	/** Reclaim relation reverse-index memory: drop every reverse entry whose
	 * target has been destroyed, returning the total dropped. Purely
	 * cold-path, no observable state change, call at a scene or snapshot
	 * boundaries. */
	public compact(): number {
		return this._store.relations.compactRelations();
	}
}

/** Event channels and signals. Emit during one `update()`, visible to every
 * later system in that call, cleared before the next. System-side reads and
 * emits go through `ctx`. This facade is the host-side surface. */
export class ECSEvents {
	private readonly _store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this._store = store;
	}

	/** Register an event channel at world setup, before anything emits on it.
	 * `fields` must name every schema key, an under-registered channel would
	 * silently drop the missing fields at emit (see `EventFieldsCover`).
	 *
	 * @example
	 * const Damaged = eventKey<{ target: EntityID; amount: number }>("Damaged");
	 * ecs.events.register(Damaged, ["target", "amount"]);
	 * ecs.events.emit(Damaged, { target: e, amount: 10 }); // or ctx.emit inside a system
	 */
	public register<S extends EventShape<S>, const F extends readonly (keyof S & string)[]>(
		key: EventKey<S>,
		fields: F & EventFieldsCover<S, F>
	): void {
		this._store.events.registerByKey<S>(key, fields);
	}

	/** Register a signal (empty-payload event channel). */
	public registerSignal(key: SignalKey): void {
		this._store.events.registerByKey<EmptyEventSchema>(key, []);
	}

	public emit(key: SignalKey): void;
	public emit<S extends EventShape<S>>(key: EventKey<S>, values: NoInfer<S>): void;
	// Erased implementation position spells `<any>`, not the bare/`unknown`
	// form, `EventKey` is invariant under the typestate seams (function-typed
	// phantom), so only `<any>` erases (see project typestate constraints).
	public emit(key: EventKey<any>, values?: Record<string, number>): void {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventEmit(key.description ?? "");
		}
		const def = this._store.events.defByKey(key);
		if (values === undefined) {
			this._store.events.emitSignal(def as EventDef<EmptyEventSchema>);
		} else {
			this._store.events.emit(def, values);
		}
	}

	public read<S extends EventShape<S>>(key: EventKey<S>): EventReader<S> {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventRead(key.description ?? "");
		}
		const def = this._store.events.defByKey(key);
		return this._store.events.reader(def) as EventReader<S>;
	}
}

/** World resources, singleton values keyed by `ResourceKey<T>`. Runtime
 * mutations (`set` / `remove`) are access-checked as resource writes inside
 * a system span. `register` is a one-time world-setup op. */
export class ECSResources {
	private readonly _store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this._store = store;
	}

	/** Register a resource at world setup. Reading and writing an unregistered
	 * key throws (fail-closed), registration is the explicit "this world has
	 * this singleton" declaration, not a lazy default.
	 *
	 * @example
	 * const GameTime = resourceKey<{ elapsed: number }>("GameTime");
	 * ecs.resources.register(GameTime, { elapsed: 0 });
	 * ecs.resources.get(GameTime).elapsed; // or ctx.getResource(GameTime) inside a system
	 */
	public register<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordResourceRegister(key.description ?? "");
		}
		this._store.resources.register(key, value);
	}

	public get<T>(key: ResourceKey<T>): T {
		if (DEV) {
			accessCheck.assertResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<T>(this._store.resources.get(key));
	}

	public set<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this._store.resources.set(key, value);
	}

	/** Drop a resource from the world. Access-checked as a *write*
	 * fails closed on a missing key. Afterwards the key is free to `register`
	 * again, the present → absent → present lifecycle. */
	public remove<T>(key: ResourceKey<T>): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this._store.resources.remove(key);
	}

	public has<T>(key: ResourceKey<T>): boolean {
		return this._store.resources.has(key);
	}
}

/** The determinism surface: world snapshot and resume and the
 * canonical state digest. Every member except `deterministic` throws
 * `DETERMINISM_DISABLED` unless the world was constructed with
 * `{ deterministic: true }`. All cold-path, take captures at tick
 * boundaries (between `update()`s). */
export class ECSSnapshots {
	// Protected, not private: the snapshot capability subclasses this to add
	// `capture` / `restore`, and reaches the store the same way.
	protected readonly _store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this._store = store;
	}

	/** Whether the determinism surface is enabled. */
	public get deterministic(): boolean {
		return this._store.deterministic;
	}

	/** FNV-1a 32 digest over every archetype's live rows in id order, the
	 * canonical "live ECS state digest". Per-call cost scales with live
	 * entity count, not SAB capacity. */
	public stateHash(): number {
		return this._store.stateHash();
	}

}

/** The capture and restore surface, present at run time and absent from the
 * type. A bare world must fail to compile on `ecs.snapshots.capture`. The
 * method cannot appear in the class body, so the snapshot capability's subclass
 * declares it. A JavaScript caller has no compiler. The prototype answers with
 * the fault that names the import, not with a `TypeError` about a missing
 * method. `ECSSnapshotsFull` overrides all four. */
for (const method of ["capture", "restore", "captureSparse", "restoreSparse"]) {
	(ECSSnapshots.prototype as unknown as Record<string, () => never>)[method] = function (): never {
		throw capabilityMissingError("snapshots", `ecs.snapshots.${method}`);
	};
}
