/***
 * ECS — Public ECS facade.
 *
 * Single entry point that composes Store (data), Schedule (execution),
 * and SystemContext (system interface) into a unified API. External code
 * interacts exclusively through ECS; systems receive a SystemContext
 * instead, preventing direct access to internals.
 *
 * Architecture: Facade pattern over an archetype-based ECS.
 * - Entities are generational IDs (no object allocation)
 * - Components are typed array columns grouped by archetype
 * - Queries are cached and live-updated as new archetypes appear
 * - Systems are plain functions scheduled across 7 lifecycle phases
 *
 * Usage:
 *
 *   const world = new ECS({ fixedTimestep: 1 / 50 });
 *
 *   // Record syntax (per-field type control)
 *   const Pos = world.registerComponent({ x: "f64", y: "f64" });
 *   const Energy = world.registerComponent({ current: "i32", max: "i32" });
 *
 *   // Array shorthand (uniform type, defaults to "f64")
 *   const Vel = world.registerComponent(["vx", "vy"] as const);
 *
 *   const Frozen = world.registerTag();
 *
 *   // A query is a live, cached view over matching archetypes.
 *   const movers = world.query(Pos, Vel);
 *
 *   // Systems declare the components they read / write (dev-mode access checking).
 *   const moveSys = world.registerSystem({
 *     reads: [Pos, Vel],
 *     writes: [Pos],
 *     fn: (ctx, dt) => {
 *       movers.forEach((arch) => {
 *         // Reads use getColumnRead (advisory read-only view of the column).
 *         const vx = arch.getColumnRead(Vel, "vx");
 *         const vy = arch.getColumnRead(Vel, "vy");
 *         const ids = arch.entityIds;
 *         for (let i = 0; i < arch.entityCount; i++) {
 *           // ctx.ref is the mutable default — it bumps the component's change tick.
 *           const pos = ctx.ref(Pos, ids[i]);
 *           pos.x += vx[i] * dt;
 *           pos.y += vy[i] * dt;
 *         }
 *       });
 *     },
 *   });
 *
 *   world.addSystems(SCHEDULE.UPDATE, moveSys);
 *   world.startup();
 *
 *   const e = world.createEntity();
 *   world.addComponent(e, Pos, { x: 0, y: 0 });
 *   world.addComponent(e, Vel, { vx: 1, vy: 2 });
 *   world.addComponent(e, Frozen);
 *   world.flush();
 *
 *   // game loop
 *   world.update(1 / 60);
 *
 ***/

import { Store, type Template, type TemplateEntries, type TemplateOverrides } from "./store";
import type { FrameTraceSink } from "./frame_trace";
import {
	ObserverRegistry,
	type ObserverConfig,
	type ObserverHandle,
	type EntitySetObserverConfig,
	type ArchetypeSetObserverConfig,
	type StructuralObserverConfig
} from "./observer";
import type { ColumnStore } from "../store";
import { ECSRelations, ECSEvents, ECSResources, ECSSnapshots } from "./facades";
import { Schedule, type SCHEDULE } from "./schedule";
import type { Archetype, ArchetypeID } from "./archetype";
import {
	SystemContext,
	Query,
	QueryBuilder,
	QueryCache,
	type QueryResolver
} from "./query";
import type { EntityID } from "./entity";
import type {
	ComponentDef,
	ComponentHandle,
	ComponentSchema,
	CompleteFieldValues,
	BundleOrDef
} from "./component";
import { bundleDef, bundleValues } from "./component";
import type { SparseComponentDef, SparseComponentID } from "./sparse_store";
import type { RelationDef, RelationOptions, OnDeleteTarget } from "./relation";
import type {
	EmptyEventSchema,
	EventDef,
	EventFieldsCover,
	EventKey,
	EventReader,
	EventSchema,
	SignalKey
} from "./event";
import type { ResourceKey } from "./resource";
import {
	asSystemId,
	_INTERNAL_EMPTY_ACCESS,
	_normalizeAccess,
	_assertQueriesDeclared,
	type SystemFn,
	type SystemConfig,
	type SystemDescriptor,
	type TypedSystemConfig,
	type DenseAccessDecl,
	type SpawnsAccessDecl,
	type DespawnsAccessDecl,
	type TransitionsAccessDecl,
	type SparseAccessDecl,
	type RelationsAccessDecl,
	type ResourcesAccessDecl
} from "./system";
import { accessCheck } from "./access_check";
import type { SystemEntry, SystemSet, SystemSetConfig } from "./schedule";
import { BitSet, unsafeCast, type TypedArrayTag } from "../../type_primitives";
import { ECSError, ECS_ERROR } from "./utils/error";
import {
	EMPTY_VALUES,
	DEFAULT_FIXED_TIMESTEP,
	DEFAULT_MAX_FIXED_STEPS,
	HASH_GOLDEN_RATIO,
	HASH_SECONDARY_PRIME
} from "./utils/constants";
import { dispatchTrace } from "./dispatch_trace";
import type { StoreLayoutListener } from "./store_layout_listener";
import type { ComputeBackend } from "./compute_backend";
import type { ColumnStoreRegionHandle, StoreRegionSpec } from "../store";
import {
	resolveECSMemory,
	type ResolvedECSMemory,
	type ECSMemoryOptions
} from "./ecs_memory";

export interface ECSOptions {
	fixedTimestep?: number;
	maxFixedSteps?: number;
	/** Sink for dev-mode engine diagnostics (currently the schedule's
	 * dropped-ordering-edge warning). Defaults to `console.warn`. Mirrors the
	 * `FrameTraceSink` seam's injectable style — no global logger. */
	onWarn?: (message: string) => void;
	/** How the world's memory is sized and backed (#682) — the single
	 * sizing surface, replacing the pre-release `initialCapacity` +
	 * `bufferAllocator` pair. Express intent through exactly one arm:
	 * `{ budget: { entities } }` (derive everything), `{ maxBytes }`
	 * (explicit cap), `{ wasm: { memory } | { maximumPages } }` (the SAB
	 * IS a WebAssembly.Memory — zero-copy with a WASM `ComputeBackend`), or
	 * `{ allocator }` (expert escape hatch, in-place-typed per ADR-0008).
	 * Omitted ⇒ growable backing with a 256 MiB cap and 1024-row columns.
	 * The resolved plan is exposed as `ECS.memoryPlan`. */
	memory?: ECSMemoryOptions;
	/** Consumer-declared SAB regions (#623), forwarded to `Store`. Each
	 * `StoreRegionSpec` carries an opaque `region_id`, a precomputed byte size,
	 * and an `init` closure; the engine lays them out generically and exposes
	 * them via `regionHandle(id)` / `regionOffset(id)`. A game (e.g.
	 * `@internal/sim`'s region specs) supplies these — the engine ships no
	 * game regions of its own. Replaces the eight game-named region options
	 * (`terrain_map_radius`, `spatial_grid_*`, `army_*`, `flow_field_*`,
	 * `actionRingCapacitySlots`) the ECS used to carry. (ADR-0018.) */
	regions?: readonly StoreRegionSpec[];
	/** Byte size of the opt-in sim-bindings region (#625), forwarded to `Store`.
	 * A consumer that attaches a WASM `ComputeBackend` passes its own size — for
	 * this game, `@internal/sim`'s `SIM_BINDINGS_BYTES` (computed from the binding
	 * manifest) — so the host can publish the `(component_id, field_id)` IDs the
	 * accelerated systems read. Omitted / 0 ⇒ no region: a pure-TS world pays
	 * nothing for the WASM seam. The size is a runtime input, not an engine ABI
	 * constant, since #625 de-welded it from the generated ABI. */
	bindingsRegionBytes?: number;
	/** Opt into the **determinism surface** (#626 / ADR-0020), forwarded to
	 * `Store`. Default `false`. When `false`, the canonical-ordering methods
	 * (`stateHash`, `snapshotSparse`, `restoreSparse`) throw
	 * `DETERMINISM_DISABLED`; when `true`, today's replay/hash behavior is
	 * reproduced bit-for-bit. Determinism is the implementer's choice — our
	 * server match opts in (replay verification), the client stays off (it rolls
	 * back via diffs, not re-sim). The flag gates ONLY that surface: memory-safety
	 * invariants (the in-place SAB allocator, ADR-0008) and the `enabled_count`
	 * partition are always-on regardless. */
	deterministic?: boolean;
}

/** The fixed-timestep drives the `while (accumulator >= dt)` catch-up loop in
 * `update()`. A non-positive `dt` makes that loop non-terminating (the
 * accumulator never decreases), and a non-finite `dt` poisons `fixedAlpha`,
 * so reject both at the configuration boundary rather than hanging mid-tick. */
function validateFixedTimestep(value: number): number {
	if (!(value > 0) || !Number.isFinite(value)) {
		throw new ECSError(
			ECS_ERROR.INVALID_FIXED_TIMESTEP,
			`fixed_timestep must be a finite number > 0, got ${value}`
		);
	}
	return value;
}

/** The spiral-of-death clamp in `update()` is `maxAcc = maxFixedSteps *
 * fixedTimestep; if (accumulator > maxAcc) accumulator = maxAcc`. A non-finite
 * `maxFixedSteps` makes `maxAcc` non-finite so the clamp never fires and a large
 * `dt` runs `while (accumulator >= fixedTimestep)` unboundedly (the exact hang the
 * clamp exists to prevent); `0` clamps the accumulator to 0 so fixed systems never
 * run. Validate it (finite integer ≥ 1) the same way `fixedTimestep` is. */
function validateMaxFixedSteps(value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new ECSError(
			ECS_ERROR.INVALID_MAX_FIXED_STEPS,
			`max_fixed_steps must be an integer >= 1, got ${value}`
		);
	}
	return value;
}

export class ECS implements QueryResolver {
	private readonly store: Store;
	private readonly schedule: Schedule;
	private readonly ctx: SystemContext;
	/** Component observers (#517 §1 / ADR-0013). Inert until `observe(...)` is
	 * called — the structural-flush fast path is byte-for-byte unchanged. */
	private readonly _observers: ObserverRegistry;

	// --- Grouped facades (H3 phase 2) ---
	// Cohesive secondary surfaces, each wrapping the same Store entry points
	// the flat methods used. The flat forms below are @deprecated delegations
	// for one release (removal targeted at 0.6.0); hot-path API stays flat.
	/** Relations: register/add/remove/has, wildcard + traversal reads,
	 * reverse-index compaction. See `ECSRelations`. */
	public readonly relations: ECSRelations;
	/** Host-side event channels + signals: register/registerSignal/emit/read
	 * (system-side `ctx.emit` is unchanged). See `ECSEvents`. */
	public readonly events: ECSEvents;
	/** World resources: register/get/set/remove/has. See `ECSResources`. */
	public readonly resources: ECSResources;
	/** Determinism surface: capture/restore (full + sparse), stateHash,
	 * the `deterministic` flag. See `ECSSnapshots`. */
	public readonly snapshots: ECSSnapshots;

	private readonly systems: Set<SystemDescriptor> = new Set();
	private nextSystemId = 0;

	// Tick counter for change detection
	private _tick: number = 0;

	// Fixed timestep accumulator
	private _fixedTimestep: number;
	private _accumulator = 0;
	private _maxFixedSteps: number;

	// Reusable BitSet for building query masks — avoids allocation per query() call
	private readonly scratchMask: BitSet = new BitSet();

	private _nextQueryIdCounter: number = 0;
	// All query-resolution caches — dedup + the shared composition maps — in
	// one owner (M2); see `QueryCache` in query.ts for keying/id-space notes.
	public readonly _caches: QueryCache = new QueryCache();

	// --- SAB layout subscribers (e.g. a compute backend) ---
	// The engine publishes SAB-layout changes to whoever subscribed via
	// `onStoreLayoutPublished`. The engine has no knowledge of what the
	// listeners do with the layout — their typed call surfaces live in the
	// consumer's own code.
	private readonly _layoutSubscribers: StoreLayoutListener[] = [];

	// The opt-in compute backend (#622), or null (the default — pure-TS). A
	// system carrying a `backendHandle` is routed here by the `Schedule` when
	// this is set; otherwise its `fn` runs. Attached via `attachBackend`.
	private _backend: ComputeBackend | null = null;

	private readonly _memory: ResolvedECSMemory;

	/** What `ECSOptions.memory` resolved to (#682): backing allocator kind,
	 * column capacity, entity-index reservation, byte cap, and a
	 * human-readable derivation trace. Diagnostics surface — log it when
	 * sizing questions come up instead of reverse-engineering the SAB. */
	public get memoryPlan(): ResolvedECSMemory {
		return this._memory;
	}

	/** The backing `WebAssembly.Memory` when `memory.wasm` was used (both
	 * bring-your-own and engine-constructed), else `null`. A consumer hands
	 * this to its WASM `ComputeBackend` so the sim and the live columns
	 * share the same bytes. */
	public get wasmMemory(): WebAssembly.Memory | null {
		return this._memory.wasmMemory;
	}

	constructor(options?: ECSOptions) {
		// Loud migration guard (#682): the pre-release sizing knobs were
		// *replaced*, not aliased. An untyped JS caller still passing them
		// would otherwise be silently ignored — and a silently-dropped
		// `bufferAllocator` means a WASM consumer's sim would read a different
		// buffer than the columns live in.
		const hasOwn = Object.prototype.hasOwnProperty;
		if (
			options !== undefined &&
			(hasOwn.call(options, "initial_capacity") || hasOwn.call(options, "buffer_allocator"))
		) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				"ECSOptions.initial_capacity / buffer_allocator were replaced by ECSOptions.memory (#682): " +
					"initial_capacity → memory.columnCapacity (or memory.budget); " +
					"buffer_allocator → memory.wasm (WASM-backed) or memory.allocator (custom in-place)."
			);
		}
		const memory: ResolvedECSMemory = resolveECSMemory(options?.memory);
		this._memory = memory;
		// `onBufferResized` fires after every extend/grow so any subscribed
		// listener (typically the WASM sim module) can re-walk the layout
		// descriptor. The callback is captured here rather than in Store
		// so Store has no reason to know about layout listeners — the
		// layering stays one-way.
		this.store = new Store({
			initialCapacity: memory.columnCapacity,
			bufferAllocator: memory.allocator,
			entityIndexCapacity: memory.entityIndexCapacity,
			capContext: {
				capBytes: memory.capBytes,
				intentLabel: memory.intentLabel,
				budgetEntities: memory.budgetEntities
			},
			onBufferResized: () => {
				const subs = this._layoutSubscribers;
				for (let i = 0; i < subs.length; i++) {
					subs[i].setLayout(0);
				}
			},
			regions: options?.regions,
			bindingsRegionBytes: options?.bindingsRegionBytes,
			deterministic: options?.deterministic
		});
		this.schedule = new Schedule(options?.onWarn);
		this.relations = new ECSRelations(this.store);
		this.events = new ECSEvents(this.store);
		this.resources = new ECSResources(this.store);
		this.snapshots = new ECSSnapshots(this.store);
		this.ctx = new SystemContext(this.store);
		// Observers dispatch through the shared SystemContext + accessCheck. The
		// store calls the structural hook between fixed-point flush rounds; onSet
		// is driven from `update()`'s tail (the post-update detection point).
		this._observers = new ObserverRegistry(this.store, this.ctx);
		this.store.setStructuralObserverHook((ev) => this._observers.dispatchStructural(ev));
		this._fixedTimestep = validateFixedTimestep(
			options?.fixedTimestep ?? DEFAULT_FIXED_TIMESTEP
		);
		this._maxFixedSteps = validateMaxFixedSteps(
			options?.maxFixedSteps ?? DEFAULT_MAX_FIXED_STEPS
		);
	}

	/** Batch variant of `regionHandle` for hosts wiring several consumer
	 * regions at startup: returns the handles in argument order, never null —
	 * throws ONE `REGION_NOT_DECLARED` naming every missing region id instead
	 * of a null-guard per region. Same staleness rule as `regionHandle`:
	 * re-fetch after a SAB grow. */
	public regionHandles(...regionIds: number[]): ColumnStoreRegionHandle[] {
		const out: ColumnStoreRegionHandle[] = new Array(regionIds.length);
		let missing: number[] | null = null;
		for (let i = 0; i < regionIds.length; i++) {
			const handle = this.store.regionHandle(regionIds[i]);
			if (handle === null) (missing ??= []).push(regionIds[i]);
			else out[i] = handle;
		}
		if (missing !== null) {
			throw new ECSError(
				ECS_ERROR.REGION_NOT_DECLARED,
				`region_handles: region id(s) [${missing.join(", ")}] not declared — pass them via ECSOptions.regions`
			);
		}
		return out;
	}

	/** Subscribe to SAB-layout publications. `listener.setLayout(0)` is
	 * called immediately to seed the initial layout, then again after
	 * every SAB grow / extend (the `view_stamp` republish protocol).
	 * Returns an unsubscribe function.
	 *
	 * The engine has no concept of what subscribes — it publishes SAB layouts
	 * and walks away. A consumer subscribes whatever wrapper it owns (a compute
	 * backend, a Worker proxy, a debug recorder) and drives it from its own
	 * code. A `ComputeBackend` is subscribed automatically by `attachBackend`,
	 * so most consumers call that rather than this directly. */
	public onStoreLayoutPublished(listener: StoreLayoutListener): () => void {
		this._layoutSubscribers.push(listener);
		listener.setLayout(0);
		return () => {
			const i = this._layoutSubscribers.indexOf(listener);
			if (i >= 0) this._layoutSubscribers.splice(i, 1);
		};
	}

	/** Attach an opt-in compute backend (#622). Default is none: a bare `ECS`
	 * runs pure-TS systems and the schedule's dispatch is byte-for-byte the
	 * no-backend path. Once attached, a scheduled system carrying a
	 * `backendHandle` (its `SystemConfig`) is executed via `backend.run(handle)`
	 * instead of its `fn` closure; systems without a handle are unaffected.
	 *
	 * The backend is also subscribed as a SAB-layout listener (seeded now, then
	 * republished on every grow), folding in the `onStoreLayoutPublished` seam.
	 * Returns a detach function that unsubscribes the layout listener and reverts
	 * the schedule to the pure-TS path.
	 *
	 * One backend per ECS: attaching while one is already attached throws in
	 * `__DEV__` (detach first). The engine never inspects the backend beyond
	 * `setLayout` / `run` — it carries no game vocabulary. */
	public attachBackend(backend: ComputeBackend): () => void {
		if (__DEV__ && this._backend !== null) {
			throw new ECSError(
				ECS_ERROR.BACKEND_ALREADY_ATTACHED,
				"A ComputeBackend is already attached; detach it before attaching another (one backend per ECS)."
			);
		}
		this._backend = backend;
		this.schedule.setBackend(backend);
		const unsubscribeLayout = this.onStoreLayoutPublished(backend);
		return () => {
			unsubscribeLayout();
			if (this._backend === backend) {
				this._backend = null;
				this.schedule.setBackend(null);
			}
		};
	}

	public get fixedTimestep(): number {
		return this._fixedTimestep;
	}

	public set fixedTimestep(value: number) {
		this._fixedTimestep = validateFixedTimestep(value);
	}

	public get fixedAlpha(): number {
		return this._accumulator / this._fixedTimestep;
	}

	/** Attach (or detach with `null`) a per-world frame-trace sink (ADR-0030):
	 * the engine then fires structured `FrameTraceSink` events at each system,
	 * flush, command, observer firing, and event during `update()`, so a consumer
	 * can reconstruct exactly what travelled through the ECS each frame. The sink
	 * also receives a `phaseBoundary(phase)` at each phase's post-flush settle
	 * point — the safe seam to read `stateHash()` between phases of one frame and
	 * bisect a divergence to the exact phase (#797 / ADR-0032). The seam is
	 * `__DEV__`-gated end to end — in a production build this setter keeps an empty
	 * body and the world never retains a sink. The sink only observes; it does not
	 * perturb `stateHash`, ordering, or any behaviour. */
	public setTrace(sink: FrameTraceSink | null): void {
		if (__DEV__) this.store._trace = sink;
	}

	// Overload 1: record syntax (per-field types)
	public registerComponent<S extends Record<string, TypedArrayTag>>(schema: S): ComponentDef<S>;
	// Overload 2: array shorthand (uniform type, defaults to "f64"). On a
	// `{ deterministic: true }` world the "f64" default is REJECTED (#777) — pass
	// an explicit integer type, e.g. `registerComponent(["x","y"], "i32")`.
	public registerComponent<const F extends readonly string[], T extends TypedArrayTag = "f64">(
		fields: F,
		type?: T
	): ComponentDef<{ readonly [K in F[number]]: T }>;
	// Implementation
	public registerComponent(
		schemaOrFields: Record<string, TypedArrayTag> | readonly string[],
		type?: TypedArrayTag
	): ComponentDef<any> {
		if (Array.isArray(schemaOrFields)) {
			const t = type ?? "f64";
			const schema: Record<string, TypedArrayTag> = Object.create(null);
			for (const f of schemaOrFields) schema[f] = t;
			return this.store.registerComponent(schema);
		}
		return this.store.registerComponent(schemaOrFields as Record<string, TypedArrayTag>);
	}

	// Overload 1: record syntax (per-field types)
	public registerSparseComponent<S extends Record<string, TypedArrayTag>>(
		schema: S
	): SparseComponentDef<S>;
	// Overload 2: array shorthand (uniform type, defaults to "f64"). Same #777
	// float ban as `registerComponent` on a `{ deterministic: true }` world.
	public registerSparseComponent<
		const F extends readonly string[],
		T extends TypedArrayTag = "f64"
	>(fields: F, type?: T): SparseComponentDef<{ readonly [K in F[number]]: T }>;
	// Implementation
	/** Register an out-of-identity sparse component (#468 / ADR-0011). Mirrors
	 * `registerComponent`, but the result lives in an engine-managed sparse set
	 * outside the archetype mask: add/remove cause **no** archetype transition
	 * and consume **no** identity bit (it does not count against the 128-component
	 * cap). Use for churny or rarely-queried data (relation targets, cooldowns,
	 * transient markers). */
	public registerSparseComponent(
		schemaOrFields: Record<string, TypedArrayTag> | readonly string[],
		type?: TypedArrayTag
	): SparseComponentDef<any> {
		if (Array.isArray(schemaOrFields)) {
			const t = type ?? "f64";
			const schema: Record<string, TypedArrayTag> = Object.create(null);
			for (const f of schemaOrFields) schema[f] = t;
			return this.store.registerSparseComponent(schema);
		}
		return this.store.registerSparseComponent(schemaOrFields as Record<string, TypedArrayTag>);
	}

	/** @deprecated Use `ecs.resources.register()` instead; the flat form is removed in 0.6.0. */
	public registerResource<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordResourceRegister(key.description ?? "");
		}
		this.store.registerResource(key, value);
	}

	/** @deprecated Use `ecs.resources.get()` instead; the flat form is removed in 0.6.0. */
	public resource<T>(key: ResourceKey<T>): T {
		if (__DEV__) {
			accessCheck.checkResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<T>(this.store.getResource(key));
	}

	/** @deprecated Use `ecs.resources.set()` instead; the flat form is removed in 0.6.0. */
	public setResource<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (__DEV__) {
			accessCheck.checkResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this.store.setResource(key, value);
	}

	/** Drop a resource from the world (#798). Unlike {@link registerResource}
	 * — a one-time world-setup op — this is a runtime mutation, so it is access-
	 * checked as a *write* (a system removing a resource must declare it in
	 * `resourceWrites`, which is what serialises it against readers/writers of the
	 * same key). Fails closed on a missing key. Afterwards the key is free to
	 * `registerResource` again — the present → absent → present lifecycle.
	 * Resources are out of `stateHash` and snapshot/resume, so a remove never
	 * perturbs the determinism hash.
	 * @deprecated Use `ecs.resources.remove()` instead; the flat form is removed in 0.6.0. */
	public removeResource<T>(key: ResourceKey<T>): void {
		if (__DEV__) {
			accessCheck.checkResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this.store.removeResource(key);
	}

	public createEntity(): EntityID;
    	public createEntity<Defs extends readonly ComponentDef[]>(
    		template: Template<Defs>,
    		overrides?: TemplateOverrides<Defs>
    	): EntityID;
    	public createEntity<Defs extends readonly ComponentDef[]>(
    		template?: Template<Defs>,
    		overrides?: TemplateOverrides<Defs>
    	): EntityID {
    		if (template === undefined) return this.store.createEntity();
    		return this.store.spawn(template, overrides);
    	}

	/**
	 * Spawn an entity from varargs bundles (§bundles) — the immediate
	 * host-side analog of `ctx.commands.spawn`. `ecs.spawnBundle(bundle(Pos,{x,y}),
	 * bundle(Vel,{vx:1}), IsEnemy)` collapses the five attach shapes into one. Each
	 * bundle is applied immediately; a single combined-archetype insertion (one
	 * transition instead of one-per-component) is a later optimization — for the
	 * prototype this mirrors the existing per-component `addComponent` path.
	 */
	public spawnBundle(...items: BundleOrDef[]): EntityID {
		const e = this.store.createEntity();
		for (let i = 0; i < items.length; i++) {
			const def = bundleDef(items[i]);
			if (__DEV__) accessCheck.checkAdd(def);
			this.store.addComponent(e, def, bundleValues(items[i]));
		}
		return e;
	}

	/** Buffer an entity for deferred destruction (applied at the next phase
	 *  flush — matches the semantics of `SystemContext.destroyEntity`). The
	 *  ECS surface is unsuffixed because the context (`ECS` vs Store) already
	 *  implies the mode; `Store.destroyEntity` is the immediate path. */
	public destroyEntity(id: EntityID): void {
		if (__DEV__) accessCheck.checkDestroy();
		this.store.destroyEntityDeferred(id);
	}

	public addComponent(entityId: EntityID, def: ComponentDef<Record<string, never>>): this;
	public addComponent<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): this;
	public addComponent(
		entityId: EntityID,
		def: ComponentDef,
		values?: Record<string, number>
	): this {
		if (__DEV__) accessCheck.checkAdd(def);
		this.store.addComponent(entityId, def, values ?? EMPTY_VALUES);
		return this;
	}

	/** Batch-attach several components in one archetype transition. Each
	 * entry's `values` is checked against its own def's schema (a misspelled
	 * field is a compile error; tags refuse `values`) — same typing as
	 * `ECS.template` entries. Omitted fields zero-fill. */
	public addComponents<Defs extends readonly ComponentDef[]>(
		entityId: EntityID,
		entries: TemplateEntries<Defs>
	): void {
		if (__DEV__) {
			for (let i = 0; i < entries.length; i++) accessCheck.checkAdd(entries[i].def);
		}
		this.store.addComponents(entityId, entries);
	}

	public removeComponent(entityId: EntityID, def: ComponentDef): this {
		if (__DEV__) accessCheck.checkRemove(def);
		this.store.removeComponent(entityId, def);
		return this;
	}

	public removeComponents(entityId: EntityID, defs: ComponentDef[]): void {
		if (__DEV__) {
			for (let i = 0; i < defs.length; i++) accessCheck.checkRemove(defs[i]);
		}
		this.store.removeComponents(entityId, defs);
	}

	/**
	 * Bulk add a component to ALL entities in the given archetype.
	 * O(columns) via TypedArray.set() instead of O(N×columns).
	 *
	 * Takes an `ArchetypeID` (from `ArchetypeView.id`) rather than a concrete
	 * `Archetype` — the concrete type is internal (issue #378).
	 */
	public batchAddComponent(src: ArchetypeID, def: ComponentDef<Record<string, never>>): void;
	public batchAddComponent<S extends ComponentSchema>(
		src: ArchetypeID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): void;
	public batchAddComponent(
		src: ArchetypeID,
		def: ComponentDef,
		values?: Record<string, number>
	): void {
		if (__DEV__) accessCheck.checkAdd(def);
		this.store.batchAddComponent(src, def, values);
	}

	/**
	 * Bulk remove a component from ALL entities in the given archetype.
	 * O(columns) via TypedArray.set() instead of O(N×columns).
	 *
	 * Takes an `ArchetypeID` (from `ArchetypeView.id`); see `batchAddComponent`.
	 */
	public batchRemoveComponent(src: ArchetypeID, def: ComponentDef): void {
		if (__DEV__) accessCheck.checkRemove(def);
		this.store.batchRemoveComponent(src, def);
	}

	public getField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S
	): number {
		if (__DEV__) {
			accessCheck.checkRead(def);
			if (!this.store.isAlive(entityId)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const arch = this.store.getEntityArchetype(entityId);
		const row = this.store.getEntityRow(entityId);
		return arch.readField(row, def.id, field);
	}

	public setField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		value: number
	): void {
		if (__DEV__) {
			if (!this.store.isAlive(entityId)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const arch = this.store.getEntityArchetype(entityId);
		const row = this.store.getEntityRow(entityId);
		const col = arch.getColumn(def, field, this.store._tick);
		col[row] = value;
		// Per-entity onSet observers drain the opt-in dirty list (#531); record
		// this host-side write so an entity-granular observer sees it, matching
		// `SystemContext.setField`. Gated so the no-observer path pays nothing.
		if (this.store._anyDirtyTracked) this.store._noteSet(def, entityId);
	}

	/** Read-modify-write one field: `updateField(e, Gold, "value", v => v - cost)`
	 * is the one-line form of the `getField` → compute → `setField` round trip.
	 * Returns the written value. Same access-check and observer semantics as the
	 * two calls it composes. */
	public updateField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		fn: (current: number) => number
	): number {
		const next = fn(this.getField(entityId, def, field));
		this.setField(entityId, def, field, next);
		return next;
	}

	/** @deprecated Use `ecs.events.emit()` instead; the flat form is removed in 0.6.0. */
	public emit(key: SignalKey): void;
	/** @deprecated Use `ecs.events.emit()` instead; the flat form is removed in 0.6.0. */
	public emit<S extends EventSchema>(key: EventKey<S>, values: NoInfer<S>): void;
	public emit(key: EventKey, values?: Record<string, number>): void {
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

	/** @deprecated Use `ecs.events.read()` instead; the flat form is removed in 0.6.0. */
	public read<S extends EventSchema>(key: EventKey<S>): EventReader<S> {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordRead(key.description ?? "");
		}
		const def = this.store.getEventDefByKey(key);
		return this.store.getEventReader(def) as EventReader<S>;
	}

	public query<T extends ComponentDef[]>(...defs: T): Query<T> {
		// Reuse scratchMask to avoid allocating a new BitSet per query call.
		// Zero it out, set bits, then copy for the cache key.
		const mask = this.scratchMask;
		mask._words.fill(0);
		for (let i = 0; i < defs.length; i++) {
			mask.set(defs[i].id);
		}
		return this._resolveQuery(mask.copy(), null, null, defs);
	}

	public _nextQueryId(): number {
		return this._nextQueryIdCounter++;
	}

	/** QueryResolver implementation — creates or retrieves a cached Query. */
	public _resolveQuery(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		defs: readonly ComponentDef[]
	): Query<any> {
		// Combine three hashes into one cache key using xor with golden-ratio
		// multipliers to reduce collision probability between masks
		const incHash = include.hash();
		const excHash = exclude ? exclude.hash() : 0;
		const anyHash = anyOf ? anyOf.hash() : 0;
		const key =
			(incHash ^
				Math.imul(excHash, HASH_GOLDEN_RATIO) ^
				Math.imul(anyHash, HASH_SECONDARY_PRIME)) |
			0;

		const cached = this._caches.findDedup(key, include, exclude, anyOf);
		if (cached !== undefined) return cached.query;

		// Store.registerQuery returns a live Archetype[] that the Store will
		// push new matching archetypes into as they are created
		const result = this.store.registerQuery(include, exclude ?? undefined, anyOf ?? undefined);
		const q = new Query(
			result,
			defs as ComponentDef[],
			this,
			include.copy(),
			exclude?.copy() ?? null,
			anyOf?.copy() ?? null,
			this._nextQueryIdCounter++
		);
		this.store.updateQueryRef(result, q);
		this._caches.addDedup(key, {
			includeMask: include.copy(),
			excludeMask: exclude?.copy() ?? null,
			anyOfMask: anyOf?.copy() ?? null,
			query: q
		});
		return q;
	}

	/**
	 * Register a system.
	 *
	 *   // Bare function (no query, no lifecycle hooks)
	 *   world.registerSystem((ctx, dt) => { ... });
	 *
	 *   // Function + query builder (query resolved at registration time)
	 *   world.registerSystem(
	 *     (q, ctx, dt) => { q.forEach((arch) => { ... }); },
	 *     (qb) => qb.with(Pos, Vel),
	 *   );
	 *
	 *   // Full config — declares reads/writes (dev-checked) + optional lifecycle hooks
	 *   world.registerSystem({ reads: [Pos, Vel], writes: [Pos], fn(ctx, dt) { ... } });
	 */
	public registerSystem(fn: SystemFn): SystemDescriptor;
	public registerSystem<Defs extends readonly ComponentDef[]>(
		fn: (q: Query<Defs>, ctx: SystemContext, dt: number) => void,
		queryFn: (qb: QueryBuilder) => Query<Defs>
	): SystemDescriptor;
	/** `exclusive: true` grants full world access at runtime (§system.ts), so
	 * the context stays fully permissive at the type layer too. Declared BEFORE
	 * the typed-config overload so exclusive configs never get narrowed. */
	public registerSystem(config: SystemConfig & { readonly exclusive: true }): SystemDescriptor;
	/** Config form (§typestate, system.ts): the declaration lists are inferred
	 * as literal tuples and `fn` / `onAdded` receive
	 * `SystemContext<DeclaredAccess<…>>` — undeclared access fails to compile
	 * with the same taxonomy the runtime `accessCheck` throws with in
	 * `__DEV__`. A config VALUE typed as plain `SystemConfig` (dynamically
	 * built) still matches: its erased declaration lists compute a permissive
	 * access record. Escape hatch: annotate `fn(ctx: SystemContext, dt)`
	 * explicitly to keep a system permissive at compile time. */
	public registerSystem<
		R extends DenseAccessDecl,
		W extends DenseAccessDecl,
		Sp extends SpawnsAccessDecl = readonly never[],
		De extends DespawnsAccessDecl = readonly never[],
		Tr extends TransitionsAccessDecl = readonly never[],
		SR extends SparseAccessDecl = readonly never[],
		SW extends SparseAccessDecl = readonly never[],
		RR extends RelationsAccessDecl = readonly never[],
		RW extends RelationsAccessDecl = readonly never[],
		QR extends ResourcesAccessDecl = readonly never[],
		QW extends ResourcesAccessDecl = readonly never[]
	>(config: TypedSystemConfig<R, W, Sp, De, Tr, SR, SW, RR, RW, QR, QW>): SystemDescriptor;
	// any: overload implementation must unify bare fn, (fn, queryFn), SystemConfig,
	// and the typed config (whose all-`any` instantiation stands in for every
	// literal inference).
	public registerSystem(
		fnOrConfig:
			| ((q: Query<any>, ctx: SystemContext, dt: number) => void)
			| SystemFn
			| SystemConfig
			| TypedSystemConfig<any, any, any, any, any, any, any, any, any, any, any, any>,
		queryFn?: (qb: QueryBuilder) => Query<any>
	): SystemDescriptor {
		let config: SystemConfig;

		if (typeof fnOrConfig === "function") {
			if (queryFn !== undefined) {
				// (fn, queryFn) overload — resolve query at registration time
				const q = queryFn(new QueryBuilder(this));
				const ctx = this.ctx;
				const fn = fnOrConfig as (q: Query<any>, ctx: SystemContext, dt: number) => void;
				config = { ..._INTERNAL_EMPTY_ACCESS, fn: (_ctx, dt) => fn(q, ctx, dt) };
			} else {
				// Bare function overload — access surface unannotated; Phase B
				// will require config-form to enforce per-system declarations.
				//
				// Footgun guard (#213 H4): a bare `SystemFn` is `(ctx, dt)` — arity
				// ≤ 2. A 3-param function here is almost certainly the `(q, ctx, dt)`
				// query form with its `queryFn` second arg forgotten, which would
				// otherwise silently bind `q := SystemContext`, `ctx := dt`, and
				// `dt := undefined` (a NaN trap on the first arithmetic). Fail fast
				// in `__DEV__` instead. Compiled out of production builds.
				if (__DEV__ && fnOrConfig.length >= 3) {
					throw new ECSError(
						ECS_ERROR.SYSTEM_FN_ARITY,
						`registerSystem was passed a ${fnOrConfig.length}-parameter function with no ` +
							`query builder. A bare system function is (ctx, dt); a query system is ` +
							`(q, ctx, dt) and needs the query builder as the second argument: ` +
							`registerSystem((q, ctx, dt) => …, (qb) => qb.with(…)). ` +
							`Without it, q would receive the SystemContext and dt would be undefined.`
					);
				}
				config = { ..._INTERNAL_EMPTY_ACCESS, fn: fnOrConfig as SystemFn };
			}
		} else {
			config = fnOrConfig as SystemConfig;
		}

		// Phase D lint (#213): catch a `queries` declaration that outruns
		// `reads ∪ writes` at registration, before the system's first iteration.
		if (__DEV__) _assertQueriesDeclared(config);

		const id = asSystemId(this.nextSystemId++);
		const descriptor: SystemDescriptor = Object.freeze({
			...config,
			..._normalizeAccess(config),
			id
		});
		this.systems.add(descriptor);
		return descriptor;
	}

	public removeSystem(system: SystemDescriptor): void {
		this.schedule.removeSystem(system);
		system.onRemoved?.();
		this.systems.delete(system);
	}

	public get systemCount(): number {
		return this.systems.size;
	}

	public startup(): void {
		// Phase C of issue #213 — walk every registered system's `spawns` +
		// `transitions` to compute the archetype closure they can produce,
		// and plant the whole set in a single `extendColumnStore` call. After
		// this returns, every spawn / transition target hits the cached
		// `archGetOrCreateFromMask` path — no per-add SAB extends, which
		// was the O(N²) cost #211 surfaced. Dynamically-generated masks not
		// covered by the closure still hit the lazy single-mask fallback.
		this.prewarmArchetypes();

		for (const descriptor of this.systems.values()) {
			if (descriptor.onAdded === undefined) continue;
			if (__DEV__) accessCheck.enter(descriptor);
			try {
				descriptor.onAdded(this.ctx);
			} finally {
				if (__DEV__) accessCheck.leave();
			}
		}
		this.schedule.runStartup(this.ctx, this._tick);

		// Events live exactly one *update* tick. Startup is setup, not an
		// update tick, so any event a startup phase emits (readable across the
		// PRE_STARTUP→STARTUP→POST_STARTUP run above) must be drained here —
		// otherwise it sits in the channel until the first `update()` clears it
		// at its tail, and a frame-1 PRE_UPDATE/UPDATE reader sees it as if
		// emitted this frame. Mirrors `update()`'s tail.
		this.store.clearEvents();
	}

	/** Compute the archetype closure from every registered system's AND
	 * observer's `spawns` + `transitions` and ask the store to plant the
	 * whole set in one `extendColumnStore` call. Observers carry the same
	 * access shape systems do (a synthesized `SystemDescriptor`), so an
	 * observer that spawns/transitions gets its target archetype prewarmed
	 * too rather than first-touching lazily mid-tick (#768). Exposed as
	 * `private` because the only caller is `startup()`; visible to tests via
	 * the `archetype_count` delta on the public ECS facade. */
	private prewarmArchetypes(): void {
		const closure = computeArchetypeClosure([...this.systems, ...this._observers.descriptors()]);
		if (closure.length === 0) return;
		this.store.archCreateManyFromMasks(closure);
	}

	public update(dt: number): void {
		// #785 multi-world re-entrancy: a system may drive a *second* world's
		// tick from inside its own open access span — e.g. a host running N
		// worlds where world A's system calls `worldB.update()`. The schedule's
		// per-system `enter`/`leave` writes the single process-global
		// `accessCheck` slot, so B's tick ends with the slot nulled, silently
		// disabling dev access enforcement for the rest of A's system body (the
		// `check*` guards early-return when no span is active). Snapshot the
		// caller's span and restore it after the tick — the same save/restore the
		// observer dispatch already performs for nested spans (see observer.ts
		// `dispatchStructural` / `dispatchSet`). Dev-only; `prevAccessSpan` is
		// null on the normal host-driven (non-nested) path, so the restore is a
		// no-op there. See `docs/PATTERNS.md` §97 (multi-world isolation).
		const prevAccessSpan = __DEV__ ? accessCheck.current() : null;
		try {
			this.store._tick = this._tick;
			if (__DEV__) this.store._trace?.tickBegin(this._tick, dt);

			// Publish row counts before the first phase runs. Covers any
			// immediate-mode `addComponents` / `removeComponents` /
			// `destroyEntity` (followed by `flush`) the host did
			// between updates — those mutate archetype lengths without
			// touching the SAB descriptor. Subsequent phase boundaries
			// re-publish via `ctx.flush()`, so any WASM scan in any phase
			// sees fresh `row_count` fields.
			this.store.publishRowCountsToDescriptor();

			if (this.schedule.hasFixedSystems()) {
				this._accumulator += dt;
				const maxAcc = this._maxFixedSteps * this._fixedTimestep;
				if (this._accumulator > maxAcc) {
					this._accumulator = maxAcc;
				}
				while (this._accumulator >= this._fixedTimestep) {
					this.schedule.runFixedUpdate(this.ctx, this._fixedTimestep, this._tick);
					this._accumulator -= this._fixedTimestep;
				}
			}

			this.schedule.runUpdate(this.ctx, dt, this._tick);
			// Post-update detection point for onSet observers (#517 §1 / ADR-0013, #586):
			// per-entity onSet drains the dirty list, archetype-granular onSet scans
			// the change tick, both in canonical order. `store._tick` still equals
			// this tick here (it tracks `this._tick`, bumped below), so the change-tick
			// comparison sees exactly this tick's writes. onSet runs INSIDE the event
			// window — `clearEvents` is the tick's last act, so onSet reads the settled
			// component snapshot *and* this tick's events, and the channel is empty at
			// the tick boundary (snapshot/restore excludes event state and relies on
			// that). Any structural ops an onSet observer enqueues flush at the next
			// tick's first phase boundary.
			const evBefore = __DEV__ ? this.store._devBufferedEventCount() : 0;
			this._observers.dispatchSet(this._tick);
			if (__DEV__ && this.store._devBufferedEventCount() !== evBefore) {
				// An onSet observer emitted: `clearEvents` below would wipe it before
				// any reader, so it is silently dropped — and would break snapshot/
				// restore determinism if it survived (#586). Bridge a detected change to
				// a next-tick event from a system reading the dirty list, not from onSet.
				throw new ECSError(
					ECS_ERROR.OBSERVER_ONSET_EMIT,
					"onSet observer emitted an event; onSet runs at the tick tail and its emissions would be dropped at clear_events. Emit from a system instead."
				);
			}
			this.store.clearEvents();
			if (__DEV__) this.store._trace?.tickEnd(this._tick);
			this._tick++;
		} finally {
			// Restore the outer world's access span (no-op when not nested).
			if (__DEV__ && prevAccessSpan !== null) accessCheck.enter(prevAccessSpan);
		}
	}

	public dispose(): void {
		for (const descriptor of this.systems.values()) {
			descriptor.dispose?.();
			descriptor.onRemoved?.();
		}
		this.systems.clear();
		this.schedule.clear();
	}


	// ============================================================================
	// === BEGIN STORE PASS-THROUGH BAND ===
	//
	// Every member below is a single mechanical delegation to a collaborator
	// (`this.store` / `this.schedule` / `this.ctx` / `this._observers`):
	// exactly one call or property read, optionally followed by `return this`
	// for chaining. No branches, no loops, no dev checks, no argument
	// adaptation beyond literal defaults. This section MUST stay logic-free —
	// a method that outgrows this shape (gains a check, adapts a result,
	// combines calls) moves ABOVE the band, next to the other real logic.
	//
	// Enforced by src/core/ecs/__tests__/unit/ecs_passthrough_guard.test.ts,
	// which parses this file and asserts the shape of every member between
	// the BEGIN/END markers. (plans/H3-ecs-facade-slimming.md, phase 1.)
	// ============================================================================


	/** Resolve a consumer-declared SAB region's byte offset by `region_id`, or
	 * 0 when absent. Generic, de-gamed replacement (#623) for the removed
	 * game-named accessors; pair with the consumer's own region module to
	 * materialise a typed view. Delegates to `Store.regionOffset`. */
	public regionOffset(regionId: number): number {
		return this.store.regionOffset(regionId);
	}

	/** A handle (`{ buffer, view, offset, bytes }`) to a consumer-declared SAB
	 * region resolved by `region_id`, or `null` when absent. A consumer's
	 * region module builds a TypedArray view over the region's span from this.
	 * Re-fetch after a SAB grow. Delegates to `Store.regionHandle`. (#623) */
	public regionHandle(regionId: number): ColumnStoreRegionHandle | null {
		return this.store.regionHandle(regionId);
	}

	/** Look up the field index a component reserves for `fieldName`. The
	 * index is assigned by `registerComponent` in insertion order and is
	 * stable for the lifetime of the ECS. Used by systems that need to
	 * pass `(component_id, field_id)` pairs across the WASM FFI — the Zig
	 * side identifies columns by these numeric IDs. */
	public fieldId<S extends Record<string, TypedArrayTag>>(
		def: ComponentDef<S>,
		fieldName: Extract<keyof S, string>
	): number {
		return this.store.fieldIdOf(def, fieldName);
	}

	/** Resolve an archetype's row index to the `EntityID` at that slot.
	 * A WASM system that drains events from the event ring as
	 * `(archId, row, …)` payloads uses this to convert the (archId, row)
	 * pair into the `EntityID` the `ctx.emit(...)` API expects.
	 * Throws if the (archId, row) pair is out of range. (#250 / Phase 4
	 * PR 4D) */
	public entityIdAtRow(archetypeId: number, row: number): EntityID {
		return this.store.entityIdAtRow(archetypeId, row);
	}

	/** The single SAB backing every archetype's column views. Exposed for
	 * snapshot/restore, `columnStoreStateHash`-based determinism checks, and
	 * Phase 2+ WASM/worker hand-off paths. Mutation flows through the
	 * usual `addComponent` / `removeComponent` / `flush` APIs; readers
	 * that hold a column view across a grow must consult
	 * `header.view_stamp` to detect a republish (#171 §8.1). */
	public get columnStore(): ColumnStore {
		return this.store.columnStore;
	}

	/** Count of live archetypes (including the empty one). Surfaces the
	 * Store-side `archetype_count` so Phase C tests can assert the
	 * pre-warmed closure was materialised; equally useful for diagnostics. */
	public get archetypeCount(): number {
		return this.store.archetypeCount;
	}

	/** Count of registered relations (#471). Surfaces the Store-side count so
	 * tests can assert it alongside `archetype_count` when checking the
	 * no-transition invariant.
	 * @deprecated Use `ecs.relations.count` instead; the flat form is removed in 0.6.0. */
	public get relationCount(): number {
		return this.store.relationCount;
	}

	/** Whether the determinism surface is enabled (#626 / ADR-0020). `false`
	 * (the default) ⇒ `stateHash` / `snapshotSparse` / `restoreSparse` throw
	 * `DETERMINISM_DISABLED`. Opt in via `new ECS({ deterministic: true })`.
	 * @deprecated Use `ecs.snapshots.deterministic` instead; the flat form is removed in 0.6.0. */
	public get deterministic(): boolean {
		return this.store.deterministic;
	}

	/** FNV-1a 32 over (archetype_id, live row count, live column bytes)
	 * for every archetype in id order. The canonical "live ECS state
	 * digest" — broader than the pre-#171 per-networked-component fold
	 * (every column contributes, not just BIT_HEALTH / BIT_HEX_POS etc.)
	 * and tighter than `columnStoreStateHash(ecs.columnStore)` (skips trailing
	 * unused SAB capacity). Per-call cost scales with live entity count,
	 * not SAB capacity. (#171 §6.1.9 Phase 5)
	 *
	 * Opt-in (#626 / ADR-0020): throws `DETERMINISM_DISABLED` unless the ECS was
	 * constructed with `{ deterministic: true }`.
	 * @deprecated Use `ecs.snapshots.stateHash()` instead; the flat form is removed in 0.6.0. */
	public stateHash(): number {
		return this.store.stateHash();
	}

	/** Serialize the sparse stores (out-of-identity components, ADR-0011) to a
	 * self-contained byte buffer — the sparse half of a world snapshot, written
	 * in canonical entity-index order so it's insertion-order-independent
	 * (#470). The dense half is the SAB snapshot (`snapshotColumnStore(columnStore)`).
	 * Pairs with `restoreSparse`.
	 *
	 * Opt-in (#626 / ADR-0020): throws `DETERMINISM_DISABLED` unless the ECS was
	 * constructed with `{ deterministic: true }`.
	 * @deprecated Use `ecs.snapshots.captureSparse()` instead; the flat form is removed in 0.6.0. */
	public snapshotSparse(): Uint8Array {
		return this.store.snapshotSparse();
	}

	/** Repopulate the sparse stores from `snapshotSparse` bytes (full-equality
	 * round-trip of membership + data). Sparse components must already be
	 * registered in the same order; throws `SparseRestoreError` on a shape or
	 * identity mismatch (store/field count, field-identity schema hash, an entity
	 * index past `MAX_INDEX`, or a non-canonical frame with trailing bytes).
	 *
	 * Opt-in (#626 / ADR-0020): throws `DETERMINISM_DISABLED` unless the ECS was
	 * constructed with `{ deterministic: true }`.
	 * @deprecated Use `ecs.snapshots.restoreSparse()` instead; the flat form is removed in 0.6.0. */
	public restoreSparse(bytes: Uint8Array): void {
		this.store.restoreSparse(bytes);
	}

	/** Capture the full live world — dense (SAB columns), sparse + relations, and
	 * the host-side bookkeeping the SAB omits (tick, entity recycle free-list,
	 * alive count, per-archetype row/enabled counts) — to one self-contained byte
	 * buffer that `restoreInto` can mount back onto a live, ticking world
	 * ("rewind a running world and keep ticking", #789). Take it at a tick
	 * boundary (between `update()`s).
	 *
	 * Opt-in (ADR-0020): throws `DETERMINISM_DISABLED` unless `{ deterministic:
	 * true }`. v1 does NOT capture resources, events, or change-detection /
	 * scheduler baselines (`changed()` queries) — see ADR-0031.
	 * @deprecated Use `ecs.snapshots.capture()` instead; the flat form is removed in 0.6.0. */
	public snapshot(): Uint8Array {
		return this.store.snapshot();
	}

	/** Mount a `snapshot()` buffer onto this live world and leave it ready to keep
	 * ticking (#789). Fails closed on a malformed frame or a registration mismatch
	 * (different component/archetype graph, mismatched entity-index capacity, or a
	 * divergent sparse-store registration) BEFORE mutating any live state — the
	 * guard reads the snapshot's descriptors + sparse-section shape from the bytes,
	 * since the dense build reuses (and overwrites) the live in-place backing.
	 * Throws `WorldRestoreError` (dense) / `SparseRestoreError` (sparse). Requires a
	 * world whose archetype set + column layout match the snapshot's (prewarm so the
	 * set is stable).
	 *
	 * Opt-in (ADR-0020): throws `DETERMINISM_DISABLED` unless `{ deterministic:
	 * true }`.
	 * @deprecated Use `ecs.snapshots.restore()` instead; the flat form is removed in 0.6.0. */
	public restoreInto(bytes: Uint8Array): void {
		this.store.restoreInto(bytes);
	}

	public registerTag(): ComponentDef<Record<string, never>> {
		return this.store.registerComponent({} as Record<string, never>);
	}

	/** Register a sparse tag (empty schema) — membership only, no data. */
	public registerSparseTag(): SparseComponentDef<Record<string, never>> {
		return this.store.registerSparseComponent({} as Record<string, never>);
	}

	/** Register an event channel. `fields` must name EVERY schema key — an
	 * under-registered channel would silently drop the missing fields at emit
	 * (see `EventFieldsCover`).
	 * @deprecated Use `ecs.events.register()` instead; the flat form is removed in 0.6.0. */
	public registerEvent<S extends EventSchema, const F extends readonly (keyof S & string)[]>(
		key: EventKey<S>,
		fields: F & EventFieldsCover<S, F>
	): void {
		this.store.registerEventByKey<S>(key, fields);
	}

	/** @deprecated Use `ecs.events.registerSignal()` instead; the flat form is removed in 0.6.0. */
	public registerSignal(key: SignalKey): void {
		this.store.registerEventByKey<EmptyEventSchema>(key, []);
	}

	/** @deprecated Use `ecs.resources.has()` instead; the flat form is removed in 0.6.0. */
	public hasResource<T>(key: ResourceKey<T>): boolean {
		return this.store.hasResource(key);
	}

	/** Register an archetype template (#462). Resolves the component set +
	 * default field values to a target archetype once (creating it if absent —
	 * fits the prewarm model), so later `spawn` / `spawnMany` calls land
	 * entities directly in that archetype with **zero archetype transitions**.
	 *
	 *   const Bullet = ecs.template([
	 *     { def: Position, values: { x: 0, y: 0 } },
	 *     { def: Velocity, values: { vx: 0, vy: 0 } },
	 *   ]);
	 *
	 * The big win is multi-component entities and bulk spawns; a single-
	 * component spawn is no faster than `createEntity` + `addComponent`, which
	 * already bump-allocates a fresh entity into the target archetype. See
	 * ADR-0010. */
	public template<Defs extends readonly ComponentDef[]>(
		entries: TemplateEntries<Defs>
	): Template<Defs> {
		return this.store.resolveTemplate(entries);
	}

	/** Bulk-spawn `count` identical entities from `template`. Field writes are
	 * O(columns) (one `TypedArray.fill` per column), not O(count×columns).
	 * Returns the new ids in spawn order. */
	public createEntities(template: Template, count: number): EntityID[] {
		return this.store.spawnMany(template, count);
	}

	public isAlive(id: EntityID): boolean {
		return this.store.isAlive(id);
	}

	public get entityCount(): number {
		return this.store.entityCount;
	}

	public hasComponent(entityId: EntityID, def: ComponentDef): boolean {
		return this.store.hasComponent(entityId, def);
	}

	// --- Entity enable/disable (#577) ---
	// A disabled entity keeps its components, relations, sparse data, and stable
	// `EntityID`, but is excluded from queries by default (it sits in the disabled
	// tail of its archetype, so `arch.entityCount` skips it). No archetype
	// transition; toggling is a single row swap. Host-side calls are immediate
	// (mirrors `addComponent`); the `SystemContext` mirror is deferred (a row swap
	// would corrupt an in-flight `forEach` over that archetype). A disabled entity
	// must hold at least one component (a component-less entity has no archetype
	// row to partition).

	/** Disable `id` (idempotent). Excluded from default queries until re-enabled. */
	public disable(id: EntityID): this {
		this.store.disableEntity(id);
		return this;
	}

	/** Re-enable a disabled `id` (idempotent). */
	public enable(id: EntityID): this {
		this.store.enableEntity(id);
		return this;
	}

	/** Whether `id` is currently disabled. */
	public isDisabled(id: EntityID): boolean {
		return this.store.isDisabled(id);
	}

	// --- Sparse (out-of-identity) component operations (#468) ---
	// Mutating a sparse component causes no archetype transition, so these are
	// immediate (no deferred buffer) and safe mid-tick — they never reallocate
	// an archetype or move a dense row.

	public addSparse(entityId: EntityID, def: SparseComponentDef<Record<string, never>>): this;
	public addSparse<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		values: CompleteFieldValues<S>
	): this;
	public addSparse(
		entityId: EntityID,
		def: SparseComponentDef,
		values?: Record<string, number>
	): this {
		this.store.addSparse(entityId, def, values);
		return this;
	}

	public removeSparse(entityId: EntityID, def: SparseComponentDef): this {
		this.store.removeSparse(entityId, def);
		return this;
	}

	public hasSparse(entityId: EntityID, def: SparseComponentDef): boolean {
		return this.store.hasSparse(entityId, def);
	}

	public getSparseField<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		field: string & keyof S
	): number {
		return this.store.getSparseField(entityId, def, field);
	}

	public setSparseField<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		field: string & keyof S,
		value: number
	): void {
		this.store.setSparseField(entityId, def, field, value);
	}

	// --- Relations (sparse (relation, target) pairs, #471 / ADR-0011) ---
	// Layered on the sparse storage class, so add/remove/re-target cause no
	// archetype transition. Like the sparse ops, these are immediate (no
	// deferred buffer) and safe mid-tick.

	/** Register a relation kind. Exclusive (default) stores one target per
	 * source in a backing sparse component; `{ multi: true }` stores a target
	 * set per source. `{ onDeleteTarget: "delete" | "clear" | "orphan" }`
	 * selects what happens to a relation's sources when a target is destroyed
	 * (default `orphan`, #473). See `registerRelation` on `Store` / ADR-0011.
	 *
	 * The overloads stamp the CARDINALITY into the handle type
	 * (POLISH_AUDIT #7): the exclusive-only surfaces (`targetOf`,
	 * `ancestorsOf` / `rootOf` / `cascadeOf`, `Query.hierarchy`) accept only
	 * `RelationDef<"exclusive">`, so passing a `{ multi: true }` relation is a
	 * compile error instead of a dev-mode RELATION_MODE_MISMATCH throw. A
	 * dynamically-built options value falls to the erased overload and keeps
	 * the runtime check as its only guard.
	 * @deprecated Use `ecs.relations.register()` instead; the flat form is removed in 0.6.0. */
	public registerRelation(opts?: {
		readonly exclusive?: true;
		readonly multi?: false;
		readonly onDeleteTarget?: OnDeleteTarget;
	}): RelationDef<"exclusive">;
	/** @deprecated Use `ecs.relations.register()` instead; the flat form is removed in 0.6.0. */
	public registerRelation(opts: {
		readonly multi: true;
		readonly exclusive?: false;
		readonly onDeleteTarget?: OnDeleteTarget;
	}): RelationDef<"multi">;
	/** @deprecated Use `ecs.relations.register()` instead; the flat form is removed in 0.6.0. */
	public registerRelation(opts?: RelationOptions): RelationDef;
	public registerRelation(opts?: RelationOptions): RelationDef {
		return this.store.registerRelation(opts);
	}

	/** Add a `(R, tgt)` pair to `src`. Exclusive replaces the existing target;
	 * multi adds to the set. No archetype transition.
	 * @deprecated Use `ecs.relations.add()` instead; the flat form is removed in 0.6.0. */
	public addRelation(src: EntityID, def: RelationDef, tgt: EntityID): this {
		this.store.addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`. For multi, omitting `tgt` removes
	 * all of `src`'s targets. No archetype transition.
	 * @deprecated Use `ecs.relations.remove()` instead; the flat form is removed in 0.6.0. */
	public removeRelation(src: EntityID, def: RelationDef, tgt?: EntityID): this {
		this.store.removeRelation(src, def, tgt);
		return this;
	}

	/** The single target of `src` under an exclusive relation, or `undefined`.
	 * @deprecated Use `ecs.relations.targetOf()` instead; the flat form is removed in 0.6.0. */
	public targetOf(src: EntityID, def: RelationDef<"exclusive">): EntityID | undefined {
		return this.store.targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id.
	 * @deprecated Use `ecs.relations.targetsOf()` instead; the flat form is removed in 0.6.0. */
	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		return this.store.targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id.
	 * @deprecated Use `ecs.relations.sourcesOf()` instead; the flat form is removed in 0.6.0. */
	public sourcesOf(def: RelationDef, tgt: EntityID): EntityID[] {
		return this.store.sourcesOf(def, tgt);
	}

	/** Whether `src` holds any pair under `R`.
	 * @deprecated Use `ecs.relations.has()` instead; the flat form is removed in 0.6.0. */
	public hasRelation(src: EntityID, def: RelationDef): boolean {
		return this.store.hasRelation(src, def);
	}

	/** All `(source, target)` pairs of relation `R` — the `(R, *)` wildcard
	 * (#472). Sources in canonical entity-index order; a multi source's targets
	 * ascending by id. Cold path.
	 * @deprecated Use `ecs.relations.pairsOf()` instead; the flat form is removed in 0.6.0. */
	public pairsOf(def: RelationDef): [EntityID, EntityID][] {
		return this.store.pairsOf(def);
	}

	/** Every `(relation, source)` pointing at `tgt`, across all relation kinds —
	 * the `(*, T)` wildcard (#472). Ordered by relation id then source id. The
	 * single-relation form is `sourcesOf(def, tgt)`.
	 * @deprecated Use `ecs.relations.sourcesOfAny()` instead; the flat form is removed in 0.6.0. */
	public sourcesOfAny(tgt: EntityID): [RelationDef, EntityID][] {
		return this.store.sourcesOfAny(tgt);
	}

	/** Reclaim relation reverse-index memory: drop every reverse entry whose
	 * target has been destroyed, returning the total dropped (#491). Under the
	 * default `orphan` policy a destroyed target's reverse entry lingers until
	 * each source re-targets or dies, so orphan-pointing at a churn of
	 * short-lived targets grows the index without bound. A purely cold-path
	 * reclaim — no observable state change (forward links stay dangling per
	 * `orphan`, `stateHash` is unaffected) — call it at scene/snapshot
	 * boundaries.
	 * @deprecated Use `ecs.relations.compact()` instead; the flat form is removed in 0.6.0. */
	public compactRelations(): number {
		return this.store.compactRelations();
	}

	// --- Relation traversal (parent / IsA chains, #474) ---
	// Exclusive-only walks over an exclusive relation's tree. A cycle is a loud
	// `__DEV__` error (`RELATION_CYCLE`), never a hang. Cold path.

	/** Walk relation `R` up from `src` to its chain root, returning
	 * `[src, parent, …, root]` (nearest-ancestor-first). Exclusive only.
	 * @deprecated Use `ecs.relations.ancestorsOf()` instead; the flat form is removed in 0.6.0. */
	public ancestorsOf(src: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this.store.ancestorsOf(src, def);
	}

	/** The root of `src`'s `R`-chain (`src` itself when it has no target).
	 * Exclusive only.
	 * @deprecated Use `ecs.relations.rootOf()` instead; the flat form is removed in 0.6.0. */
	public rootOf(src: EntityID, def: RelationDef<"exclusive">): EntityID {
		return this.store.rootOf(src, def);
	}

	/** Walk relation `R` down from `root` over the reverse index, returning the
	 * subtree (including `root`) breadth-first — parents before children (the
	 * `cascade` order). Exclusive only.
	 * @deprecated Use `ecs.relations.cascadeOf()` instead; the flat form is removed in 0.6.0. */
	public cascadeOf(root: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this.store.cascadeOf(root, def);
	}

	public _getLastRunTick(): number {
		return this.ctx.lastRunTick;
	}

	/** Current ECS write tick — the tick `eachChunk` stamps via `cols.mut` (§eachChunk). */
	public _getCurrentTick(): number {
		return this.store._tick;
	}

	public _getQueryDirtyEpoch(): number {
		return this.store._queryDirtyEpoch;
	}

	/** QueryResolver implementation — sparse-membership match path (#469). */
	public _forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void,
		includeDisabled: boolean
	): void {
		this.store._forEachSparseMatch(
			include,
			exclude,
			anyOf,
			sparseInclude,
			sparseExclude,
			denseArchetypes,
			cb,
			includeDisabled
		);
	}

	/** QueryResolver implementation — backing sparse id of a relation, for the
	 * `(R, *)` wildcard term (`Query.withRelation`, #579). */
	public _relationBackingSparseId(def: RelationDef): SparseComponentID {
		return this.store.relationBackingSparseId(def);
	}

	/** QueryResolver implementation — `(*, T)` wildcard match path (#579). */
	public _forEachRelationTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void {
		this.store._forEachRelationTargetMatch(
			target,
			include,
			exclude,
			anyOf,
			sparseInclude,
			sparseExclude,
			includeDisabled,
			cb
		);
	}

	/** QueryResolver implementation — depth-ordered hierarchy match path (#581). */
	public _forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void {
		this.store._forEachHierarchyMatch(
			include,
			exclude,
			anyOf,
			sparseInclude,
			sparseExclude,
			denseArchetypes,
			relation,
			maxDepth,
			includeDisabled,
			cb
		);
	}

	public addSystems(label: SCHEDULE, ...entries: (SystemDescriptor | SystemEntry)[]): this {
		this.schedule.addSystems(label, ...entries);
		return this;
	}

	/**
	 * Configure a `SystemSet` (#576) — the shared run condition and/or ordering
	 * every member inherits. Additive and order-independent with respect to
	 * `addSystems`: see `Schedule.configureSet`. Returns `this` to chain.
	 */
	public configureSet(set: SystemSet, config: SystemSetConfig): this {
		this.schedule.configureSet(set, config);
		return this;
	}

	/**
	 * Register a per-component observer (#517 §1 / ADR-0013). Reactions that were
	 * hand-polled every tick — "on `Death` added → spawn corpse", "on `HexPos`
	 * set → mark the spatial index" — become declarative.
	 *
	 * - **`onAdd` / `onRemove`** `(eid, ctx)` fire at the structural-flush
	 *   boundary, after the batch commits, in canonical order (access-topological
	 *   across observers, entity-id order within), looping to a fixed point so
	 *   cascades settle. Determinism: a `stateHash` replay reproduces regardless
	 *   of the order ops were queued.
	 * - **`onDisable` / `onEnable`** `(eid, ctx)` fire at the same flush boundary
	 *   when an entity carrying the component is *disabled* / *enabled* (#577,
	 *   ADR-0023), once per net transition, for every component the entity carries
	 *   (a disable is a soft remove of the whole mask from default queries). Like
	 *   `onAdd`/`onRemove`, an *immediate* `world.disable()` does not fire — only
	 *   the deferred `ctx.disable()` toggle does. `yieldExisting` seeds enabled
	 *   members only, so a disabled entity is correctly absent at seed.
	 * - **`onSet`** fires at the post-update detection point. Default
	 *   `granularity: "archetype"` fires `(arch, ctx)` once per changed
	 *   archetype-column (the consumer iterates `arch.entityCount` rows) — free,
	 *   reusing the change tick. `granularity: "entity"` fires `(eid, ctx)` once
	 *   per changed entity, draining the opt-in per-row dirty list (registering it
	 *   enables dirty tracking for the component; the producer records via
	 *   `ctx.setField` automatically, or `ctx.markChanged` in a `getColumn`
	 *   hot loop).
	 *
	 * Observer callbacks that touch ECS state must declare it via `access`
	 * (merged over an all-empty declaration) — undeclared access throws in
	 * `__DEV__`, and those decls drive the firing order. `yieldExisting` replays
	 * `onAdd` over current matches on registration. Register at world-build time
	 * (before `startup()`); the returned handle's `dispose()` unregisters.
	 */
	// Deliberately non-generic: the callbacks receive `(eid, ctx)` / `(arch,
	// ctx)` and read data through def-carrying APIs (`ctx.getField(eid, def,
	// …)`), which are already schema-checked — a `<S>` here would bind from
	// `def` and flow nowhere. `ComponentHandle` (not the erased `ComponentDef`)
	// so generic callers holding a `ComponentDef<S>` can register without a
	// cast — only the `.id` is read. If a schema-typed row/column argument is
	// ever handed to `onSet`, that's a runtime feature (cursor resolution on
	// the observer hot path), not a signature change.
	public observe(def: ComponentHandle, config: StructuralObserverConfig): ObserverHandle;
	public observe(def: ComponentHandle, config: EntitySetObserverConfig): ObserverHandle;
	public observe(def: ComponentHandle, config: ArchetypeSetObserverConfig): ObserverHandle;
	public observe(def: ComponentHandle, config: ObserverConfig): ObserverHandle {
		return this._observers.register(def, config);
	}

	/**
	 * Stamp every SAB-backed archetype's live `length` into its SAB
	 * descriptor's `row_count` field. **You usually don't need to call
	 * this directly** — `update()` publishes at tick start and
	 * `SystemContext.flush()` publishes at every phase boundary, so any
	 * WASM scan running inside the schedule sees fresh counts for free.
	 * This is an escape hatch for code that mutates archetype state
	 * outside the system framework and wants to force a republish without
	 * going through `flush()`. No in-repo callers today.
	 *
	 * Cheap: walks the descriptor region once, does no column I/O.
	 */
	public publishArchetypeRowCounts(): void {
		this.store.publishRowCountsToDescriptor();
	}

	public flush(): void {
		this.ctx.flush();
	}
	// === END STORE PASS-THROUGH BAND ===
}

/** Phase C of issue #213 — archetype closure from a descriptor set.
 *
 * Each descriptor is a system or an observer's synthesized `SystemDescriptor`
 * (#768) — both carry `spawns` + `transitions`. Seeds the worklist with every
 * descriptor's `spawns`; iteratively applies every descriptor's `transitions`
 * to every discovered mask whose components cover the transition's `whenHas`.
 * Returns the union of seeds + reachable targets, deduplicated by hash-bucketed
 * mask equality.
 *
 * Termination: every transition either monotonically grows the mask (add
 * outpacing remove), monotonically shrinks it, or returns a mask the
 * `seen` map already holds. Because the universe of masks is bounded by
 * `2^|components|` (and in practice the in-tree spawn/transition set is
 * tiny — ~20 masks at most), the worklist is finite and we exit when it
 * empties.
 *
 * Liberal `whenHas` per design doc §6.6 — over-approximation is fine; an
 * unreachable transition target costs one descriptor row at the SAB tail,
 * not column bytes. Empty `spawns` + `transitions` short-circuit to zero.
 */
function computeArchetypeClosure(descriptors: Iterable<SystemDescriptor>): BitSet[] {
	const seen = new Map<number, BitSet[]>();
	const work: BitSet[] = [];

	const tryPush = (mask: BitSet): void => {
		const h = mask.hash();
		const bucket = seen.get(h);
		if (bucket !== undefined) {
			for (let i = 0; i < bucket.length; i++) if (bucket[i].equals(mask)) return;
			bucket.push(mask);
		} else {
			seen.set(h, [mask]);
		}
		work.push(mask);
	};

	const maskFromDefs = (defs: readonly ComponentDef[]): BitSet => {
		const m = new BitSet();
		for (let i = 0; i < defs.length; i++) m.set(defs[i].id);
		return m;
	};

	// Pre-compute every transition's `whenHas` BitSet once (#325). The
	// worklist below tests `mask.contains(whenHas)` per (popped mask ×
	// system × transition), so building the BitSet inside that loop
	// allocated O(W × S × T) throwaway sets per `startup()`. `whenHas`
	// depends only on the (system, transition) pair — hoisting it makes
	// allocation O(sum of transition counts). Sharing the cached BitSet
	// across iterations is safe because `mask.contains(when)` only reads
	// `when`.
	const cachedTransitions: {
		readonly whenHas: BitSet;
		readonly add?: readonly ComponentDef[];
		readonly remove?: readonly ComponentDef[];
	}[] = [];
	for (const desc of descriptors) {
		const transitions = desc.transitions;
		for (let i = 0; i < transitions.length; i++) {
			const t = transitions[i];
			cachedTransitions.push({
				whenHas: maskFromDefs(t.whenHas),
				add: t.add,
				remove: t.remove
			});
		}
	}

	// Seed from spawns. Each spawn entry is the full component set a
	// spawned entity carries at flush time (design doc §4 worked example).
	for (const desc of descriptors) {
		const spawns = desc.spawns;
		for (let i = 0; i < spawns.length; i++) tryPush(maskFromDefs(spawns[i]));
	}

	// Walk transitions until quiescent. A worklist iteration per discovered
	// mask × declared transition; cheap because both factors are small in
	// the in-tree system set.
	while (work.length > 0) {
		const mask = work.pop()!;
		for (let i = 0; i < cachedTransitions.length; i++) {
			const t = cachedTransitions[i];
			if (!mask.contains(t.whenHas)) continue;
			const next = mask.copy();
			if (t.add !== undefined) {
				for (let j = 0; j < t.add.length; j++) {
					next.set(t.add[j].id);
				}
			}
			if (t.remove !== undefined) {
				for (let j = 0; j < t.remove.length; j++) {
					next.clear(t.remove[j].id);
				}
			}
			tryPush(next);
		}
	}

	const out: BitSet[] = [];
	for (const bucket of seen.values()) for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
	return out;
}

/** @internal — test seam for the closure walk. Exposed so the prewarm
 * tests can exercise the BFS without standing up a full Store. */
export const _ecsInternals = {
	computeArchetypeClosure
};
