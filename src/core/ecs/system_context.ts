/***
 * Commands and SystemContext. The system-facing write surface.
 *
 * `SystemContext` is what a system body receives. It reads and writes
 * components, sparse components, relations, events and resources for one
 * entity at a time, and it carries the change tick the write stamps.
 * `Commands` is its deferred half: every structural op it takes is applied
 * at the phase flush, never during iteration.
 *
 * These two own the receiver-implies-timing rule. `ecs.*` is immediate.
 * `ctx.commands.*` is deferred. The rule is why `Commands` exists as a
 * separate object instead of more methods on the context.
 *
 * The file holds no query machinery. A system reaches archetypes through the
 * `Query` it declared, and neither class here refers to one.
 *
 * The access parameter `A` narrows every def-taking method to the enclosing
 * system's declared surface. Its variance is load-bearing and fragile: read
 * the note above `DeclaredBundleOrDef` before changing an annotation here.
 ***/

import type { Store } from "./store";
import type { FrameTraceSink } from "./frame_trace";
import { _setIterAllRows } from "./archetype";
import type { EntityID } from "./entity";
import { entityNotAliveError } from "./entity";
import { componentLabel } from "./debug_names";
import type {
	ComponentDef,
	AttachValuesArg,
	BundleOrDef,
	SchemaOf,
	FieldValues
} from "./component";
import { bundleDef, bundleValues } from "./component";
import type { SparseComponentDef, SparseSchemaOf } from "./sparse_store";
import type { RelationDef } from "./relation";
import type {
	SystemAccess,
	DeclaredRead,
	DeclaredWrite,
	DeclaredAdd,
	DeclaredRemove,
	DeclaredSparseRead,
	DeclaredSparseWrite,
	DeclaredRelationRead,
	DeclaredRelationWrite,
	DeclaredResourceRead,
	DeclaredResourceWrite,
	DespawnArg
} from "./system";
import {
	createCursor,
	createRef,
	createSparseCursor,
	type ComponentCursor,
	type ComponentRef,
	type ReadonlyComponentCursor,
	type ReadonlyComponentRef
} from "./ref";
import type {
	EmptyEventSchema,
	EventDef,
	EventKey,
	EventReader,
	EventShape,
	SignalKey
} from "./event";
import type { ResourceKey, ResourceValueOf } from "./resource";
import { unsafeCast } from "../../type_primitives";
import { ECSError, ECS_ERROR } from "./utils/error";
import { dispatchTrace } from "./dispatch_trace";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

/**
 * A `BundleOrDef` whose def is constrained to the enclosing system's declared
 * add surface (system.ts). The bundle branch restates `Bundle`'s shape with
 * the def slot narrowed, intersecting `Bundle<any> & { def: … }` instead
 * would put two `ComponentDef` instantiations in one intersection, which TS
 * relates leniently (see the access-typing notes in system.ts).
 *
 * The outer conditional is a deliberate no-op (`[D] extends [unknown]` is
 * always true): it makes the variance of `D`, and therefore of the access
 * param `A` threaded through `Commands` / `SystemContext`. Unmeasurable to
 * the compiler. A measurable (plain-union) definition here gets `A` marked
 * reliably contravariant, variance-based comparison then rejects
 * `SystemContext<Narrow> → SystemContext` without the structural fallback,
 * and every helper taking a bare `SystemContext` stops accepting typed
 * contexts. Unmeasurable variance forces the structural path, where class
 * methods compare bivariantly and the conversion holds.
 *
 * The inner `D extends ComponentDef ? … : never` Distributes over the declared
 * add-set union, so each raw-literal branch carries its own def's schema
 * (`Partial<FieldValues<SchemaOf<D>>>`) rather than the erased
 * `Partial<Record<string, number>>`. A hand-written `{ def: Vel, values: { x }}`
 * whose fields don't match its def is then rejected in a declared-access system,
 * matching the `StrictBundles` guarantee on the `ecs.*` surface. A permissive
 * context (`add: ComponentDef<any>`, i.e. an unnarrowed / `exclusive` system)
 * keeps the loose shape, which is the point of opting out of narrowing. The
 * outer no-op is preserved, so the variance invariant above still holds
 * (verified: the `permissiveHelper(ctx)` assertion still compiles).
 */
export type DeclaredBundleOrDef<D> = [D] extends [unknown]
	? D extends ComponentDef
		? D | { readonly def: D; readonly values: Readonly<Partial<FieldValues<SchemaOf<D>>>> }
		: never
	: never;

/**
 * Deferred structural-command facade (Bevy `Commands`).
 * Namespaces the deferred structural ops so the call site is self-documenting:
 * `ctx.commands.add(e, …)` is *always* deferred (applied at the phase flush),
 * ending the collision where `ecs.addComponent` (immediate) and a bare
 * `ctx.addComponent` (deferred) would share a name with opposite timing. Takes
 * varargs callable bundles, so one shape, `commands.spawn(bundle(Pos,{x,y}), bundle(Vel,{vx:1}))`,
 * serves spawn and add. This is the only deferred surface: the bare
 * `ctx.addComponent` / `ctx.removeComponent` / `ctx.disable` / `ctx.enable`
 * duplicates were removed in 0.5.0, completing the receiver-implies-timing
 * rule (`ecs.*` immediate, `ctx.commands.*` deferred) that 0.5.0 started for
 * spawn/despawn.
 *
 * `A` narrows the def-taking methods to the enclosing system's declared access
 * (system.ts). The default is fully permissive.
 *
 * `out A` (declared covariance) is deliberate: every use of `A` sits inside a
 * declared-access conditional, whose variance the compiler cannot measure,
 * left unannotated, the measured verdict rejects `Commands<Narrow> →
 * Commands` (the direction every permissive consumer needs). Covariance is
 * the honest direction: a context with more declared access is usable where
 * one with less is expected. The checks themselves are per-instantiation, so
 * the annotation does not weaken them.
 */
export class Commands<out A extends SystemAccess = SystemAccess> {
	constructor(private readonly _store: Store) {}

	/** Spawn from bundles. Create is immediate (the id is returned now); the
	 *  component attaches are deferred to the phase flush, so until that flush the
	 *  entity exists in its empty and partial archetype and a query running later in
	 *  the same phase can observe it half-built. (Same semantics as
	 *  `ctx.commands.spawn()` + `ctx.addComponent`. Fully-deferred id-reservation
	 *  spawn, à la Bevy, is a separate follow-up.) */
	public spawn(...items: DeclaredBundleOrDef<A["add"]>[]): EntityID {
		const e = this._store.createEntity();
		if (DEV) this._store.trace?.commandQueued("spawn", e, null);
		for (let i = 0; i < items.length; i++) {
			const def = bundleDef(items[i]);
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponentDeferred(e, def, bundleValues(items[i]));
			// Trace each attach like `add` does, the queued adds are what the
			// flush drains, so a sink reconstructing the frame sees all of them.
			if (DEV) this._store.trace?.commandQueued("add", e, def.id);
		}
		return e;
	}

	/** Attach bundles to an existing entity (deferred). Bundles zero-fill
	 * omitted fields. */
	public add(entityId: EntityID, ...items: DeclaredBundleOrDef<A["add"]>[]): this;
	/** Explicit complete-values attach (deferred), the compile-checked shape
	 * where a typo'd or missing field is a compile error, mirroring the
	 * immediate `ecs.addComponent(e, def, values)`. Tags take no values
	 * argument (`AttachValuesArg`). */
	public add<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredAdd<A, D>,
		...values: AttachValuesArg<SchemaOf<D>>
	): this;
	public add(entityId: EntityID, ...items: (BundleOrDef | Record<string, number>)[]): this {
		// (def, values) shape: a callable def followed by a values record. A
		// bundle always carries a *callable* `def` property, so a plain record,
		// even one whose schema has a field literally named "def" (a number
		// there, not a function), can never be mistaken for one.
		if (
			items.length === 2 &&
			typeof items[0] === "function" &&
			items[1] !== null &&
			typeof items[1] === "object" &&
			typeof (items[1] as { def?: unknown }).def !== "function"
		) {
			const def = items[0] as ComponentDef;
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponentDeferred(entityId, def, items[1] as Record<string, number>);
			if (DEV) this._store.trace?.commandQueued("add", entityId, def.id);
			return this;
		}
		for (let i = 0; i < items.length; i++) {
			const item = items[i] as BundleOrDef;
			const def = bundleDef(item);
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponentDeferred(entityId, def, bundleValues(item));
			if (DEV) this._store.trace?.commandQueued("add", entityId, def.id);
		}
		return this;
	}

	/** Remove a component (deferred). */
	public remove<D extends ComponentDef<any>>(entityId: EntityID, def: D & DeclaredRemove<A, D>): this {
		if (DEV) accessCheck.assertRemove(def);
		this._store.removeComponentDeferred(entityId, def);
		if (DEV) this._store.trace?.commandQueued("remove", entityId, def.id);
		return this;
	}

	/** Destroy an entity (deferred). */
	public despawn(entityId: DespawnArg<A>): this {
		if (DEV) accessCheck.assertDespawn();
		// The conditional argument type is `EntityID` whenever this compiles
		// (the false branch is uninhabited); the cast recovers it for a body
		// where `A` is still generic.
		const id = entityId as EntityID;
		this._store.destroyEntityDeferred(id);
		if (DEV) this._store.trace?.commandQueued("despawn", id, null);
		return this;
	}

	/** Buffer `entityId` to be disabled at the phase flush (idempotent).
	 * Deferred because a toggle is an in-archetype row swap, which would corrupt
	 * a `forEach` SoA loop iterating that archetype if applied mid-system (it
	 * reorders the dense columns being read). A disabled entity is excluded from
	 * default queries. Opt back in per query with `.includeDisabled()`. The
	 * immediate read is `ctx.isDisabled`. */
	public disable(entityId: EntityID): this {
		this._store.disableEntityDeferred(entityId);
		if (DEV) this._store.trace?.commandQueued("disable", entityId, null);
		return this;
	}

	/** Buffer `entityId` to be re-enabled at the phase flush (idempotent).
	 * Deferred for the same row-swap reason as `disable`. */
	public enable(entityId: EntityID): this {
		this._store.enableEntityDeferred(entityId);
		if (DEV) this._store.trace?.commandQueued("enable", entityId, null);
		return this;
	}
}

/**
 * The per-system world facade. `A` is the system's declared access surface
 * (system.ts): the config-form `registerSystem` computes it from
 * the literal `reads` and `writes`/… declarations and every guarded method below
 * checks its handle argument against the matching union at compile time,
 * the same rules `accessCheck` enforces at runtime in `DEV`. The default
 * `A = SystemAccess` is fully permissive, so a bare `SystemContext` (helper
 * functions, host-side code, explicitly-annotated escape hatches) behaves
 * exactly as before, and every narrowed `SystemContext<…>` is assignable to
 * it.
 *
 * `out A` (declared covariance) is deliberate, see `Commands` above: the
 * declared-access conditionals are unmeasurable to the compiler, and the
 * unannotated verdict rejects exactly the `SystemContext<Narrow> →
 * SystemContext` conversion the whole design depends on.
 */
export class SystemContext<out A extends SystemAccess = SystemAccess> {
	public lastRunTick: number = 0;

	/** Deferred structural-command facade. */
	public readonly commands: Commands<A>;

	/** The frame tick: the count of `update()` calls so far. Run conditions
	 * read it. The change tick that a write stamps is a separate counter that
	 * advances before every system run, so it does not equal this value. */
	public get ecsTick(): number {
		return this._store.tick;
	}

	/** @internal Advance the change tick for the run that follows and return
	 * the new value. The schedule calls it before each system run and before
	 * each phase flush. Not for a system body. */
	public advanceChangeTick(): number {
		return this._store.advanceChangeTick();
	}

	/** The world's frame-trace sink, or `null`. Lets the schedule
	 * fire `systemBegin` and `flush*` without reaching into the private store.
	 * Read only under `if (DEV)`. The seam is dead-code-eliminated in prod. */
	public get trace(): FrameTraceSink | null {
		return this._store.trace;
	}

	constructor(private readonly _store: Store) {
		this.commands = new Commands<A>(_store);
	}

	public isAlive(entityId: EntityID): boolean {
		return this._store.isAlive(entityId);
	}

	public hasComponent(entityId: EntityID, def: ComponentDef): boolean {
		return this._store.hasComponent(entityId, def);
	}

	public getField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredRead<A, D>,
		field: string & keyof SchemaOf<D>
	): number {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.getField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		return arch.readField(row, def.id, field);
	}

	/** Total sibling of {@link getField}, mirroring `ecs.tryGetField`
	 *: `undefined` when the entity is dead or doesn't hold
	 * the component, instead of a dev throw or a prod garbage read. The safe way
	 * to probe-and-read in one call: `ctx.tryGetField(e, Health, "current") ?? 0`. */
	public tryGetField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredRead<A, D>,
		field: string & keyof SchemaOf<D>
	): number | undefined {
		if (DEV) accessCheck.assertRead(def);
		if (!this._store.hasComponent(entityId, def)) return undefined;
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		return arch.readField(row, def.id, field);
	}

	public setField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredWrite<A, D>,
		field: string & keyof SchemaOf<D>,
		value: number
	): void {
		if (DEV) {
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.setField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		// `getColumnMut` (mutable) invokes `accessCheck.assertWrite` under DEV,
		// so setField doesn't need a separate check.
		const col = arch.getColumnMut(def, field, this._store.changeTick);
		col[row] = value;
		// Per-entity onSet: record the changed row for components with a dirty-list
		// observer. Gated so the common no-onSet path pays nothing.
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
	}

	/** Read-modify-write one field: `updateField(e, Gold, "value", v => v - cost)`
	 * is the one-line form of the `getField` → compute → `setField` round trip.
	 * Returns the written value. Same access-check and observer semantics as the
	 * two calls it composes (inlined here: the declared-access conditionals on
	 * those methods only resolve per `A` instantiation, so a body where `A` is
	 * still generic cannot call them without casts). */
	public updateField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredWrite<A, D>,
		field: string & keyof SchemaOf<D>,
		fn: (current: number) => number
	): number {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.updateField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		const next = fn(arch.readField(row, def.id, field));
		const col = arch.getColumnMut(def, field, this._store.changeTick);
		col[row] = next;
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
		return next;
	}

	/**
	 * Record an entity as changed for a component's per-entity `onSet` observer.
	 * The SoA write idiom, `const { x } = cols.mut(D); x[i] = v` in a tight
	 * loop, bypasses the engine, which never sees the per-element writes, so a
	 * per-entity `onSet` consumer records the row by hand. This is the by-id
	 * form: a call, a resolve and a list push per row. The row form,
	 * `cols.ticks(D)[i] = cols.tick`, is one store per row, and the one to
	 * reach for inside a chunk loop. No-op for components without a
	 * per-entity onSet observer. `setField`, `ref` and a cursor record on
	 * their own.
	 */
	public markChanged(entityId: EntityID, def: ComponentDef): void {
		if (this._store.anyDirtyTracked) this._store.noteSetEntity(def, entityId);
	}

	/**
	 * Create a cached component reference for a single entity. Marks the
	 * component as changed (the mutable default, see `refRead` for the
	 * read-only variant to reach for when you are not mutating), and records
	 * the entity for a per-entity onSet observer. Both happen here, at
	 * creation: the accessor's setters write raw columns and cannot record,
	 * so the record is conservative, as the archetype stamp is. See ref.ts.
	 */
	public ref<D extends ComponentDef<any>>(
		def: D & DeclaredWrite<A, D>,
		entityId: EntityID
	): ComponentRef<SchemaOf<D>> {
		if (DEV) {
			accessCheck.assertWrite(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.ref", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		if (DEV && arch.accessorColumns[def.id] === undefined)
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`ctx.ref: ${componentLabel(def)} has no columns in this archetype, the entity doesn't hold it, or it is a tag (no fields to ref)`,
				{ component: def.id, entity: entityId }
			);
		arch.changedTick[def.id] = this._store.changeTick;
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
		// ! safe in prod (dev guard above): _accCols is populated for all components with fields in this archetype
		return createRef<SchemaOf<D>>(arch.accessorColumns[def.id]!, row);
	}

	/**
	 * Create a cached read-only component reference for a single entity. Use
	 * this when you are not mutating. The returned `ReadonlyComponentRef<S>`
	 * is an *advisory* compile-time barrier (no `_changedTick` bump): the
	 * `readonly` typing blocks field writes at the type layer, but the
	 * underlying accessor shares its prototype with `ref()` and can still be
	 * written through a deliberate cast. See ref.ts.
	 */
	public refRead<D extends ComponentDef<any>>(
		def: D & DeclaredRead<A, D>,
		entityId: EntityID
	): ReadonlyComponentRef<SchemaOf<D>> {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.refRead", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		if (DEV && arch.accessorColumns[def.id] === undefined)
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`ctx.refRead: ${componentLabel(def)} has no columns in this archetype, the entity doesn't hold it, or it is a tag (no fields to ref)`,
				{ component: def.id, entity: entityId }
			);
		// ! safe in prod (dev guard above): _accCols is populated for all components with fields in this archetype
		return createRef<SchemaOf<D>>(arch.accessorColumns[def.id]!, row);
	}

	/**
	 * A re-pointable single-entity cursor over `def`, the in-system twin of
	 * {@link ECS.cursor}, and the accessor to reach for when a system touches many
	 * entities **by id** rather than by query span.
	 *
	 * `ctx.ref` allocates one accessor for each entity. That allocation is the
	 * largest part of the cost of a read of one field by id, because to make an
	 * accessor costs much more than to move one. Make the cursor one time,
	 * outside the loop:
	 *
	 *   const p = ctx.cursor(Pos);
	 *   for (const e of hits) { p.at(e); p.x += p.y * dt; }
	 *
	 * Mutable: every `at()` stamps the change tick. Still prefer `forEachChunk` when
	 * a query can express the entity set, a cursor removes the per-entity
	 * allocation, not the per-entity archetype resolution.
	 */
	public cursor<D extends ComponentDef<any>>(
		def: D & DeclaredWrite<A, D>
	): ComponentCursor<SchemaOf<D>> {
		if (DEV) accessCheck.assertWrite(def);
		return createCursor<SchemaOf<D>>(
			this._store.componentFieldNames(def),
			this._store.cursorBinder(def, true)
		);
	}

	/** Read-only {@link cursor}: no change-tick stamp on `at()`. Advisory only,
	 * same caveat as `ctx.refRead`. */
	public cursorRead<D extends ComponentDef<any>>(
		def: D & DeclaredRead<A, D>
	): ReadonlyComponentCursor<SchemaOf<D>> {
		if (DEV) accessCheck.assertRead(def);
		return createCursor<SchemaOf<D>>(
			this._store.componentFieldNames(def),
			this._store.cursorBinder(def, false)
		) as ReadonlyComponentCursor<SchemaOf<D>>;
	}

	// --- Deferred structural ops live on `ctx.commands` ---
	// The bare `ctx.addComponent` / `ctx.removeComponent` / `ctx.disable` /
	// `ctx.enable` duplicates were removed in 0.5.0 (same break that removed
	// `ctx.createEntity` / `ctx.destroyEntity`): one deferred surface, one
	// timing rule per receiver. `isDisabled` stays here. It is an immediate
	// *read*, not a buffered structural op.

	/** Whether `entityId` is currently disabled (immediate read). Toggling is
	 * deferred, `ctx.commands.disable` / `ctx.commands.enable`. */
	public isDisabled(entityId: EntityID): boolean {
		return this._store.isDisabled(entityId);
	}

	// --- Sparse (out-of-identity) component operations ---
	// Immediate, not deferred: a sparse add and remove causes no archetype
	// transition and no row reallocation, so it's safe to apply mid-system.
	// It can't invalidate a *dense* query's iteration the way a structural
	// change would. Field reads and writes mirror `getField` / `setField`.
	//
	// Sharp edge of the immediacy: it is not safe during `forEachEntity` over
	// a query whose driving sparse term is the one being mutated, the immediate
	// add and remove edits the live key array under the walk (see `forEachEntity`).
	// Buffer such edits and apply after.
	//
	// Access-checked under `DEV` against the system's `sparseReads` /
	// `sparseWrites` declarations: add, remove and set_field require a write
	// term, getField a read term (a write implies a read). `hasSparse` is
	// unchecked, mirroring `hasComponent`. Sparse ids live in their own id
	// space, so the check keys the dedicated sparse sets, never the dense ones.

	/** Tags take no values argument. Valued schemas require a complete one. */
	public addSparse<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseWrite<A, D>,
		...values: AttachValuesArg<SparseSchemaOf<D>>
	): this {
		if (DEV) accessCheck.assertSparseWrite(def);
		this._store.addSparse(entityId, def, values[0] as Record<string, number> | undefined);
		return this;
	}

	public removeSparse<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseWrite<A, D>
	): this {
		if (DEV) accessCheck.assertSparseWrite(def);
		this._store.removeSparse(entityId, def);
		return this;
	}

	public hasSparse(entityId: EntityID, def: SparseComponentDef): boolean {
		return this._store.hasSparse(entityId, def);
	}

	public getSparseField<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseRead<A, D>,
		field: string & keyof SparseSchemaOf<D>
	): number {
		if (DEV) accessCheck.assertSparseRead(def);
		return this._store.getSparseField(entityId, def, field);
	}

	public setSparseField<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseWrite<A, D>,
		field: string & keyof SparseSchemaOf<D>,
		value: number
	): void {
		if (DEV) accessCheck.assertSparseWrite(def);
		this._store.setSparseField(entityId, def, field, value);
	}

	/** A cursor over a sparse component, the sparse sibling of {@link cursor}
	 * and the fastest read by id in a system: `at()` writes the entity index and
	 * a field access is one load. Mutable. Declare the component in
	 * `sparseWrites`. See `ECS.sparseCursor`. */
	public sparseCursor<D extends SparseComponentDef<any>>(
		def: D & DeclaredSparseWrite<A, D>
	): ComponentCursor<SparseSchemaOf<D>> {
		if (DEV) accessCheck.assertSparseWrite(def);
		return createSparseCursor<SparseSchemaOf<D>>(
			this._store.sparseFieldNames(def),
			this._store.sparseAccessorColumns(def),
			this._store.sparseCursorCheck(def, true),
			this._store.sparseTickPlane(def),
			this._store
		);
	}

	/** Whether the sparse component of `entityId` changed since the previous
	 * run of this system: its row tick is above `lastRunTick`. The row grain
	 * of change detection for a sparse component, as a pull. Needs row ticks
	 * (`ecs.trackRows(def)`, or an entity-level `onSet`), and throws
	 * `ROW_TICKS_NOT_TRACKED` without them. A non-member reads `false`. */
	public sparseChanged<D extends SparseComponentDef<any>>(
		def: D & DeclaredSparseRead<A, D>,
		entityId: EntityID
	): boolean {
		if (DEV) accessCheck.assertSparseRead(def);
		return this._store.sparseTickOf(def, entityId) > this.lastRunTick;
	}

	/** Read-only {@link sparseCursor}; declare the component in `sparseReads`.
	 * Advisory only, same caveat as `ctx.cursorRead`. */
	public sparseCursorRead<D extends SparseComponentDef<any>>(
		def: D & DeclaredSparseRead<A, D>
	): ReadonlyComponentCursor<SparseSchemaOf<D>> {
		if (DEV) accessCheck.assertSparseRead(def);
		return createSparseCursor<SparseSchemaOf<D>>(
			this._store.sparseFieldNames(def),
			this._store.sparseAccessorColumns(def),
			this._store.sparseCursorCheck(def, false)
		) as ReadonlyComponentCursor<SparseSchemaOf<D>>;
	}

	// --- Relations (sparse (relation, target) pairs) ---
	// Immediate like the sparse ops, no archetype transition, safe mid-system.
	// Registration is host-side (`ECS.registerRelation`), so it is not mirrored
	// here. Systems add, remove and query pairs.
	//
	// Access-checked under `DEV` against `relationReads` / `relationWrites`:
	// add and remove require a write term, target_of, targets_of and sources_of a
	// read term (write implies read). `hasRelation` is unchecked, mirroring
	// `hasComponent`. Relation ids are their own id space, the check keys the
	// dedicated relation sets.

	/** Add a `(R, tgt)` pair to `src` (exclusive replaces, multi adds). */
	public addRelation<D extends RelationDef>(src: EntityID, def: D & DeclaredRelationWrite<A, D>, tgt: EntityID): this {
		if (DEV) accessCheck.assertRelationWrite(def);
		this._store.requireRelations("ctx.addRelation").addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`. For multi, omitting `tgt` removes all. */
	public removeRelation<D extends RelationDef>(src: EntityID, def: D & DeclaredRelationWrite<A, D>, tgt?: EntityID): this {
		if (DEV) accessCheck.assertRelationWrite(def);
		this._store.requireRelations("ctx.removeRelation").removeRelation(src, def, tgt);
		return this;
	}

	/** The single target of `src` under an exclusive relation, or `undefined`. */
	public targetOf<D extends RelationDef<"exclusive">>(
		src: EntityID,
		def: D & DeclaredRelationRead<A, D>
	): EntityID | undefined {
		if (DEV) accessCheck.assertRelationRead(def);
		return this._store.requireRelations("ctx.targetOf").targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id. */
	public targetsOf<D extends RelationDef>(src: EntityID, def: D & DeclaredRelationRead<A, D>): EntityID[] {
		if (DEV) accessCheck.assertRelationRead(def);
		return this._store.requireRelations("ctx.targetsOf").targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id.
	 * `(entity, def)` order, matching `targetOf` / `targetsOf`. */
	public sourcesOf<D extends RelationDef>(tgt: EntityID, def: D & DeclaredRelationRead<A, D>): EntityID[] {
		if (DEV) accessCheck.assertRelationRead(def);
		return this._store.requireRelations("ctx.sourcesOf").sourcesOf(tgt, def);
	}

	/** Whether `src` holds any pair under `R`. */
	public hasRelation(src: EntityID, def: RelationDef): boolean {
		return this._store.requireRelations("ctx.hasRelation").hasRelation(src, def);
	}

	/** Flush all deferred changes: structural (add and remove) first, then
	 *  destructions. Republishes archetype row counts into the SAB
	 *  descriptor at the end so any WASM scan running in the next phase
	 *  sees fresh `row_count` fields. This is one of two publish sites,
	 *  `ECS.update()` also republishes once at tick start, which covers
	 *  host-side mutations between updates. The publish walks
	 *  descriptors only. It doesn't touch column data, and benches at
	 *  sub-microsecond per archetype, so paying it once per phase boundary
	 *  is materially cheaper than the earlier pattern of paying it per
	 *  WASM-using system per tick. The descriptor walk is now gated
	 *  on a dirty flag, so read-only phases skip the walk entirely. */
	public flush(): void {
		this._store.flushStructural();
		this._store.flushDestroys();
		this._store.publishRowCounts();
	}

	// =======================================================
	// Events
	// =======================================================

	/**
	 * Emit an event (or a payload-less signal) onto its channel. The event is
	 * visible to every system that runs *later* in the same `update()` and is
	 * cleared at the tick's tail, events live exactly one tick, there is no
	 * ack/consume. The channel must have been registered at world setup via
	 * `ecs.events.register(key, fields)` / `registerSignal(key)`.
	 *
	 * @example
	 * const Damaged = eventKey<{ target: EntityID; amount: number }>("Damaged");
	 * ecs.events.register(Damaged, ["target", "amount"]);
	 * // inside a system:
	 * ctx.emit(Damaged, { target: e, amount: 10 });
	 */
	public emit(key: SignalKey): void;
	public emit<S extends EventShape<S>>(key: EventKey<S>, values: NoInfer<S>): void;
	public emit(key: EventKey, values?: Record<string, number>): void {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventEmit(key.description ?? "");
		}
		if (DEV) this._store.trace?.eventEmitted(key.description ?? "");
		const registry = this._store.requireEvents("ctx.emit");
		const def = registry.defByKey(key);
		if (values === undefined) {
			registry.emitSignal(def as EventDef<EmptyEventSchema>);
		} else {
			registry.emit(def, values);
		}
	}

	/**
	 * Read this tick's events on a channel. Returns an SoA reader over
	 * everything emitted *earlier in the same `update()`*, order systems so
	 * readers run after emitters, or they see an empty reader.
	 *
	 * @example
	 * const dmg = ctx.readEvents(Damaged); // SoA columns, one per field
	 * for (let i = 0; i < dmg.length; i++) {
	 *   applyDamage(dmg.target[i], dmg.amount[i]);
	 * }
	 */
	public readEvents<S extends EventShape<S>>(key: EventKey<S>): EventReader<S> {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventRead(key.description ?? "");
		}
		const registry = this._store.requireEvents("ctx.readEvents");
		const def = registry.defByKey(key);
		const reader = registry.reader(def) as EventReader<S>;
		if (DEV) this._store.trace?.eventRead(key.description ?? "", reader.length);
		return reader;
	}

	// =======================================================
	// Resources
	// =======================================================

	/** Read a resource (declared in `resourceReads`). The flat `ctx` surface verbs
	 * its accessors, `getResource`, `setResource`, `removeResource` and `hasResource`,
	 * matching `getField`, `setField` and `hasComponent`. The grouped `ecs.resources`
	 * facade drops the noun (`get`, `set`, `remove` and `has`) because its receiver
	 * already names it. */
	public getResource<K extends ResourceKey<any>>(
		key: K & DeclaredResourceRead<A, K>
	): ResourceValueOf<K> {
		if (DEV) {
			accessCheck.assertResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<ResourceValueOf<K>>(this._store.resources.get(key));
	}

	public setResource<K extends ResourceKey<any>>(
		key: K & DeclaredResourceWrite<A, K>,
		value: ResourceValueOf<NoInfer<K>>
	): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this._store.resources.set(key, value);
	}

	/** Drop a resource mid-tick. A lifecycle mutation, so it is access-
	 * checked as a *write*, the system must declare the key in `resourceWrites`,
	 * which serialises it against readers and writers of the same resource. Fails
	 * closed on a missing key. */
	public removeResource<K extends ResourceKey<any>>(key: K & DeclaredResourceWrite<A, K>): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this._store.resources.remove(key);
	}

	public hasResource<T>(key: ResourceKey<T>): boolean {
		return this._store.resources.has(key);
	}
}
