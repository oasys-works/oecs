/***
 * ECS. Public ECS facade.
 *
 * Single entry point that composes Store (data), Schedule (execution),
 * and SystemContext (system interface) into a unified API. An application
 * reaches the world through ECS, and a system body reaches it through the
 * SystemContext the schedule hands in. A plugin is the third caller, and it
 * reaches further: `ECS.create` hands each installed plugin a `PluginHost`
 * that carries the store, the bare world, the change feed and the system
 * context. See `plugin.ts` for what that host opens and why.
 *
 * Architecture: Facade pattern over an archetype-based ECS.
 * - Entities are generational IDs (no object allocation)
 * - Components are typed array columns grouped by archetype
 * - Queries are cached and live-updated as new archetypes appear
 * - Systems are plain functions scheduled across the lifecycle phases
 *
 * Usage:
 *
 *   const ecs = new ECS({ fixedTimestep: 1 / 50 });
 *
 *   // Record syntax (per-field type control)
 *   const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
 *   const Energy = ecs.registerComponent({ current: "i32", max: "i32" });
 *
 *   // Array shorthand (uniform type, defaults to "f64")
 *   const Vel = ecs.registerComponent(["vx", "vy"] as const);
 *
 *   const Frozen = ecs.registerTag();
 *
 *   // A query is a live, cached view over matching archetypes.
 *   const movers = ecs.query(Pos, Vel);
 *
 *   // Systems declare the components they read and write (dev-mode access checking).
 *   const moveSys = ecs.registerSystem({
 *     reads: [Pos, Vel],
 *     writes: [Pos],
 *     fn: (ctx, dt) => {
 *       movers.forEach((arch) => {
 *         // Reads use getColumnRead (advisory read-only view of the column).
 *         const vx = arch.getColumnRead(Vel, "vx");
 *         const vy = arch.getColumnRead(Vel, "vy");
 *         const ids = arch.entityIds;
 *         for (let i = 0; i < arch.entityCount; i++) {
 *           // ctx.ref is the mutable default. It bumps the component's change tick.
 *           const pos = ctx.ref(Pos, ids[i]);
 *           pos.x += vx[i] * dt
 *           pos.y += vy[i] * dt
 *         }
 *       });
 *     },
 *   });
 *
 *   ecs.addSystems(SCHEDULE.UPDATE, moveSys);
 *   ecs.startup();
 *
 *   const e = ecs.spawn();
 *   ecs.addComponent(e, Pos, { x: 0, y: 0 });
 *   ecs.addComponent(e, Vel, { vx: 1, vy: 2 });
 *   ecs.addComponent(e, Frozen);
 *   ecs.flush();
 *
 *   // game loop
 *   ecs.update(1 / 60);
 *
 ***/

import { Store, type Template, type TemplateOverrides } from "./store";
import type { FrameTraceSink } from "./frame_trace";
import type { ColumnStore } from "../store";
import { ECSResources, ECSSnapshots } from "./facades";
import type {
	Plugin,
	PluginHost,
	PluginMemory,
	PluginsOf,
	SystemRoutePlanner
} from "./plugin";
import { Schedule } from "./schedule";
import type { Phase, PhaseConfig, SchedulePhase } from "./phase";
import type { Archetype, ArchetypeID } from "./archetype";
import { Query, QueryBuilder } from "./query";
import { QueryCache, type QueryResolver } from "./query_cache";
import type { QueryTerms } from "./query_terms";
import { SystemContext } from "./system_context";
import type { EntityID } from "./entity";
import { entityNotAliveError } from "./entity";
import { componentLabel } from "./debug_names";
import {
	createCursor,
	createRef,
	createSparseCursor,
	type ComponentCursor,
	type ReadonlyComponentCursor,
	type ReadonlyComponentRef
} from "./ref";
import type {
	ComponentDef,
	ComponentHandle,
	ComponentRegisterOptions,
	ComponentSchema,
	CompleteFieldValues,
	Bundle,
	BundleOrDef,
	StrictBundles,
	DefsOf
} from "./component";
import { bundleDef, bundleValues } from "./component";
import type { SparseComponentDef, SparseComponentID } from "./sparse_store";
import type { RelationDef } from "./relation";
import {
	_INTERNAL_EMPTY_ACCESS,
	_assertQueriesDeclared,
	_assertSystemRunnable,
	_createBareSystemConfig,
	_createSystemDescriptor,
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
import type { SystemEntry, SystemSet, SystemSetConfig } from "./system_set";
import { BitSet, type TypedArrayTag } from "../../type_primitives";
import { ECSError, ECS_ERROR } from "./utils/error";
import { pluginMissingError, pluginInstalledTwiceError } from "./utils/plugin_error";
import {
	DEFAULT_FIXED_TIMESTEP,
	DEFAULT_MAX_FIXED_STEPS,
	HASH_GOLDEN_RATIO,
	HASH_SECONDARY_PRIME
} from "./utils/constants";
import type { StoreLayoutListener } from "./store_layout_listener";
import type { ComputeBackend } from "./compute_backend";
import type { ColumnStoreRegionHandle } from "../store";
import { resolveECSMemory, type ResolvedECSMemory } from "./ecs_memory";
import {
	ECS_OPTION_KEYS,
	assertTemplate,
	validateFixedTimestep,
	validateMaxFixedSteps,
	type ECSOptions
} from "./ecs_options";
import { computeArchetypeClosure } from "./archetype_closure";
import {
	MISSING_EVENTS,
	MISSING_RELATIONS,
	MISSING_WORKERS,
	assertPluginSurface,
	missingObserve
} from "./plugin_slots";
import { DEV } from "../../dev_flag";

/** `ECSOptions` moved to `ecs_options.ts` with the guards that read it. The
 * re-export holds the name a caller already imports from this module. */
export type { ECSOptions };

/** The plugins installed on a world. Each optional subsystem contributes
 * its facade property here, so a world that never installed one cannot name it.
 * The empty default keeps `ECS` usable unparameterised. */
export type Plugins = object;

export class ECS<C extends Plugins = object> implements QueryResolver {
	/** Phantom. Carries the installed-plugin surface so `C` is measurable
	 * to the compiler. Declared, never assigned, and erased from the emitted
	 * JavaScript, so it costs a world nothing. */
	declare readonly __plugins?: C;

	/** Build a world with plugins installed.
	 *
	 * The returned type is the world intersected with the facades its plugins
	 * contribute, so `ECS.create({ plugins: [relations()] }).relations` type-checks
	 * and the same read on a bare `new ECS()` does not. Reach for `new ECS()`
	 * when the world needs none of the optional subsystems: that world does not
	 * carry their code.
	 *
	 * @example
	 * import { relations } from "@oasys/oecs/relations";
	 * const world = ECS.create({ plugins: [relations()] });
	 * world.relations.register();
	 */
	public static create<const P extends readonly Plugin<object>[]>(
		options?: ECSOptions & { readonly plugins?: P }
	): ECS<PluginsOf<P>> & PluginsOf<P> {
		const world = new ECS<PluginsOf<P>>(options);
		const plugins = options?.plugins;
		if (plugins !== undefined) {
			// The list is walked in order, so a plugin that names a
			// dependency has to come after it. Order is the whole check: a
			// later plugin can read what an earlier one installed, never the
			// reverse.
			const installed = new Set<string>();
			for (let i = 0; i < plugins.length; i++) {
				const plugin = plugins[i] as unknown as Plugin<object>;
				const requires = plugin.requires;
				if (requires !== undefined) {
					for (let r = 0; r < requires.length; r++) {
						if (!installed.has(requires[r]))
							throw pluginMissingError(requires[r], `${plugin.name} plugin`);
					}
				}
				if (installed.has(plugin.name)) throw pluginInstalledTwiceError(plugin.name);
				installed.add(plugin.name);
				const surface = plugin.install(world._pluginHost());
				if (DEV) assertPluginSurface(world, plugin.name, surface);
				Object.assign(world, surface);
			}
		}
		return world as ECS<PluginsOf<P>> & PluginsOf<P>;
	}

	/** The host a plugin installs through. Built per world, once per
	 * install. Cold path. */
	private _pluginHost(): PluginHost {
		return {
			store: this._store,
			changes: this._store,
			world: this,
			context: this._ctx,
			onSettle: (fn) => {
				this._settleHooks.push(fn);
			},
			onPrewarm: (fn) => {
				this._prewarmSources.push(fn);
			},
			onDispose: (fn) => {
				this._disposeHooks.push(fn);
			},
			memory: this._pluginMemory(),
			installRoute: (planner) => {
				if (this._routePlanner !== null) throw pluginInstalledTwiceError("route");
				// Keyed and cold at install. The world caches the planner into
				// the typed field the registration path already read, so no hot
				// path learns that a route exists by name.
				this._routePlanner = planner;
				const schedule = this._schedule;
				return { route: (dispatch) => schedule.setRoute(dispatch) };
			}
		};
	}

	/** Where this world's bytes are, for a plugin that reads them directly.
	 * Built once, at install.
	 *
	 * `backing` is a getter, because a reader can attach after a grow, and a
	 * grow replaces the buffer the world started with. The wasm memory
	 * survives a grow, so it answers first. Cold path. */
	private _pluginMemory(): PluginMemory {
		const memory = this._memory;
		const store = this._store;
		return {
			get backing(): SharedArrayBuffer | WebAssembly.Memory | null {
				if (memory.wasmMemory !== null) return memory.wasmMemory;
				const buffer = store.columnStore.buffer;
				const hasShared = typeof SharedArrayBuffer !== "undefined";
				return hasShared && buffer instanceof SharedArrayBuffer ? buffer : null;
			},
			backingSource: memory.source,
			storeBase: memory.storeBase
		};
	}

	private readonly _store: Store;
	private readonly _schedule: Schedule;
	private readonly _ctx: SystemContext;
	/** What each plugin contributes to the archetype closure `startup()`
	 * plants. Empty on a world that installed no such plugin, and read once, at
	 * startup. */
	private readonly _prewarmSources: (() => readonly SystemDescriptor[])[] = [];
	/** What each plugin ends when the world goes away, in install order. */
	private readonly _disposeHooks: (() => void)[] = [];
	/** The consumers of the tick-tail detection point, in install order. Each
	 * one runs once per `update()` with the change tick of the point. Empty on
	 * a world that installed no consumer, and the tail reads the length once. */
	private readonly _settleHooks: ((run: number) => void)[] = [];

	// --- Grouped facades ---
	// Cohesive secondary surfaces, each wrapping the same Store entry points
	// the pre-0.5 flat methods used. The flat forms went away in 0.5.0. The
	// hot-path API stays flat: component ops, queries, spawn and destroy,
	// sparse ops.
	/** World resources, to register, get, set, remove and test. See
	 * `ECSResources`. */
	public readonly resources: ECSResources;
	/** Determinism: `stateHash()` and the `deterministic` flag, both properties
	 * of the world itself. Capture and restore are not here. They arrive with
	 * the snapshot plugin, which replaces this with a widened facade, so a
	 * world that never installs it carries no serialization code. */
	public readonly snapshots: ECSSnapshots;

	private readonly _systems: Set<SystemDescriptor> = new Set();
	private _nextSystemId = 0;

	// Tick counter for change detection
	private _tick: number = 0;

	// DEV-only: true while this world's schedule is executing (startup and update).
	// Distinguishes "a system of this world is on the stack" from "some other
	// world's system opened the process-global accessCheck span", driving a
	// second world from inside a system is a supported pattern, and its
	// host-facade mutations must not trip this world's in-system guards.
	private _updating = false;

	// Fixed timestep accumulator
	private _fixedTimestep: number;
	private _accumulator = 0;
	private _maxFixedSteps: number;

	// Reusable BitSet for building query masks, avoids allocation per query() call
	private readonly _scratchMask: BitSet = new BitSet();

	private _nextQueryIdCounter: number = 0;
	// All query-resolution caches, dedup + the shared composition maps, in
	// one owner. See `QueryCache` in query_cache.ts for keying and id-space notes.
	/** @internal Query-composition caches (QueryResolver seam), not public API. */
	public readonly caches: QueryCache = new QueryCache();

	// --- SAB layout subscribers (e.g. a compute backend) ---
	// The engine publishes SAB-layout changes to whoever subscribed via
	// `subscribeLayout`. The engine has no knowledge of what the
	// listeners do with the layout, their typed call surfaces live in the
	// consumer's own code.
	private readonly _layoutSubscribers: StoreLayoutListener[] = [];

	// The opt-in compute backend, or null (the default, pure-TS). A
	// system carrying a `backendHandle` is routed here by the `Schedule` when
	// this is set. Otherwise its `fn` runs. Attached via `attachBackend`.
	private _backend: ComputeBackend | null = null;

	// What the workers plugin installed, or null (the default). `registerSystem`
	// reads it only inside `if (config.parallel !== undefined)`, so a world
	// with no parallel system never touches it, and a world without the plugin
	// builds no plan and runs the system's `fn`.
	// The one system dispatch route, `null` until a plugin installs one. Read
	// at registration, which is cold. The schedule holds its own typed field
	// for the dispatch, so nothing on a frame path reads this.
	private _routePlanner: SystemRoutePlanner | null = null;

	private readonly _memory: ResolvedECSMemory;

	/** What `ECSOptions.memory` resolved to: backing allocator kind,
	 * column capacity, entity-index reservation, byte cap, and a
	 * human-readable derivation trace. Diagnostics surface, log it when
	 * sizing questions come up instead of reverse-engineering the SAB. */
	public get memoryPlan(): ResolvedECSMemory {
		return this._memory;
	}

	/** The backing `WebAssembly.Memory` when `memory.wasm` was used (both
	 * bring-your-own and engine-constructed), else `null`. A consumer hands
	 * this to its WASM `ComputeBackend` so the module and the live columns
	 * share the same bytes. */
	public get wasmMemory(): WebAssembly.Memory | null {
		return this._memory.wasmMemory;
	}

	constructor(options?: ECSOptions) {
		// Loud migration guard: the pre-release sizing knobs were
		// *replaced*, not aliased. An untyped JS caller still passing them
		// would otherwise be silently ignored, and a silently-dropped
		// `bufferAllocator` means a WASM consumer's module would read a different
		// buffer than the columns live in.
		const hasOwn = Object.prototype.hasOwnProperty;
		if (
			options !== undefined &&
			(hasOwn.call(options, "initial_capacity") || hasOwn.call(options, "buffer_allocator"))
		) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				"ECSOptions.initial_capacity and buffer_allocator were replaced by ECSOptions.memory. " +
					"Pass initial_capacity as memory.columnCapacity (or memory.budget), " +
					"and buffer_allocator as memory.wasm (WASM-backed) or memory.allocator (custom in-place)"
			);
		}
		// Typo tripwire: an unknown key (e.g. `initialCapacity`) would otherwise
		// be silently ignored, excess-property checking doesn't fire on a value
		// built through a variable or spread. Dev-only, warn not throw.
		if (DEV && options !== undefined) {
			for (const key of Object.keys(options)) {
				if (!ECS_OPTION_KEYS.has(key)) {
					(options.onWarn ?? console.warn)(
						`ECSOptions: unknown option '${key}' ignored, known options: ${[...ECS_OPTION_KEYS].join(", ")}`
					);
				}
			}
		}
		const memory: ResolvedECSMemory = resolveECSMemory(options?.memory);
		this._memory = memory;
		// `onBufferReplaced` fires after every extend and grow so any subscribed
		// listener (typically a compute backend) can re-walk the layout
		// descriptor. The callback is captured here rather than in Store
		// so Store has no reason to know about layout listeners, the
		// layering stays one-way.
		this._store = new Store({
			initialCapacity: memory.columnCapacity,
			bufferAllocator: memory.allocator,
			entityIndexCapacity: memory.entityIndexCapacity,
			capContext: {
				capBytes: memory.capBytes,
				intentLabel: memory.intentLabel,
				budgetEntities: memory.budgetEntities
			},
			storeBase: memory.storeBase,
			onBufferReplaced: () => {
				const subs = this._layoutSubscribers;
				for (let i = 0; i < subs.length; i++) {
					subs[i].setLayout(memory.storeBase);
				}
			},
			regions: options?.regions,
			bindingsRegionBytes: options?.bindingsRegionBytes,
			deterministic: options?.deterministic
		});
		this._schedule = new Schedule(options?.onWarn);
		this.resources = new ECSResources(this._store);
		this.snapshots = new ECSSnapshots(this._store);
		// Reserve a slot for every plugin facade this package ships, filled
		// or not. `ECS.create` then assigns into an existing property instead of
		// adding one, so a world with plugins and a world without share one
		// hidden shape. Measured: without this, `spawn` on a bare world slowed
		// once a plugin world existed in the same process, because the call
		// site saw two shapes. The names cost no import, so the core still
		// carries none of the plugin code. A plugin outside this package
		// adds a slot and pays that cost.
		//
		// Each slot holds a reader that names the missing plugin, not
		// `undefined`. `ECS.create` overwrites the value, so the shape is the
		// same either way.
		const slots = this as unknown as Record<string, unknown>;
		slots.relations = MISSING_RELATIONS;
		slots.events = MISSING_EVENTS;
		slots.observe = missingObserve;
		slots.workers = MISSING_WORKERS;
		this._ctx = new SystemContext(this._store);
		// Observers dispatch through the shared SystemContext + accessCheck. The
		// store calls the structural hook between fixed-point flush rounds. OnSet
		// is driven from `update()`'s tail (the post-update detection point).

		this._fixedTimestep = validateFixedTimestep(
			options?.fixedTimestep ?? DEFAULT_FIXED_TIMESTEP
		);
		this._maxFixedSteps = validateMaxFixedSteps(
			options?.maxFixedSteps ?? DEFAULT_MAX_FIXED_STEPS
		);
	}

	/** Batch variant of `regionHandle` for hosts wiring several consumer
	 * regions at startup: returns the handles in argument order, never null,
	 * throws one `REGION_NOT_DECLARED` naming every missing region id instead
	 * of a null-guard per region. Same staleness rule as `regionHandle`:
	 * re-fetch after a SAB grow. */
	public regionHandles(...regionIds: number[]): ColumnStoreRegionHandle[] {
		const out: ColumnStoreRegionHandle[] = new Array(regionIds.length);
		let missing: number[] | null = null;
		for (let i = 0; i < regionIds.length; i++) {
			const handle = this._store.regionHandle(regionIds[i]);
			if (handle === null) (missing ??= []).push(regionIds[i]);
			else out[i] = handle;
		}
		if (missing !== null) {
			throw new ECSError(
				ECS_ERROR.REGION_NOT_DECLARED,
				`regionHandles: region ids [${missing.join(", ")}] are not declared. Pass them in ECSOptions.regions`
			);
		}
		return out;
	}

	/** Subscribe to store-layout publications. `listener.setLayout(storeBase)`
	 * is called immediately to seed the initial layout, then again after every
	 * grow and extend (the `view_stamp` republish protocol). The argument is the
	 * byte offset of the header inside the backing, and every offset the
	 * listener then reads from the bytes is relative to it. Returns an
	 * unsubscribe function.
	 *
	 * The engine has no concept of what subscribes. It publishes SAB layouts
	 * and walks away. A consumer subscribes whatever wrapper it owns (a compute
	 * backend, a Worker proxy, a debug recorder) and drives it from its own
	 * code. A `ComputeBackend` is subscribed automatically by `attachBackend`,
	 * so most consumers call that rather than this directly. */
	public subscribeLayout(listener: StoreLayoutListener): () => void {
		this._layoutSubscribers.push(listener);
		listener.setLayout(this._memory.storeBase);
		return () => {
			const i = this._layoutSubscribers.indexOf(listener);
			if (i >= 0) this._layoutSubscribers.splice(i, 1);
		};
	}

	/** Attach an opt-in compute backend. Default is none: a bare `ECS`
	 * runs pure-TS systems and the schedule's dispatch is byte-for-byte the
	 * no-backend path. Once attached, a scheduled system carrying a
	 * `backendHandle` (its `SystemConfig`) is executed via `backend.run(handle)`
	 * instead of its `fn` closure. Systems without a handle are unaffected.
	 *
	 * The backend is also subscribed as a SAB-layout listener (seeded now, then
	 * republished on every grow), folding in the `subscribeLayout` seam.
	 * Returns a detach function that unsubscribes the layout listener and reverts
	 * the schedule to the pure-TS path.
	 *
	 * One backend per ECS: attaching while one is already attached throws in
	 * `DEV` (detach first). The engine never inspects the backend beyond
	 * `setLayout` and `run`. It carries no game vocabulary. */
	public attachBackend(backend: ComputeBackend): () => void {
		if (DEV && this._backend !== null) {
			throw new ECSError(
				ECS_ERROR.BACKEND_ALREADY_ATTACHED,
				"a ComputeBackend is already attached to this world. Detach it before attaching another, because a world holds one backend"
			);
		}
		this._backend = backend;
		this._schedule.setBackend(backend);
		const unsubscribeLayout = this.subscribeLayout(backend);
		return () => {
			unsubscribeLayout();
			if (this._backend === backend) {
				this._backend = null;
				this._schedule.setBackend(null);
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

	/** Attach (or detach with `null`) a per-world frame-trace sink:
	 * the engine then fires structured `FrameTraceSink` events at each system,
	 * flush, command, observer firing, and event during `update()`, so a consumer
	 * can reconstruct exactly what travelled through the ECS each frame. The sink
	 * also receives a `phaseBoundary(phase)` at each phase's post-flush settle
	 * point, the safe seam to read `stateHash()` between phases of one frame and
	 * bisect a divergence to the exact phase. The seam is
	 * `DEV`-gated end to end, in a production build this setter keeps an empty
	 * body and the world never retains a sink. The sink only observes. It does not
	 * perturb `stateHash`, ordering, or any behaviour. */
	public setTrace(sink: FrameTraceSink | null): void {
		if (DEV) this._store.trace = sink;
	}

	/**
	 * Register a dense component and get back its typed handle. Record syntax
	 * gives per-field type control. The array shorthand types every field the
	 * same (default `"f64"`, rejected on a `{ deterministic: true }` world,
	 * pass an explicit integer type there). An empty schema `{}` is a
	 * tag. `opts.name` labels dev-mode diagnostics (`'Pos' (component 5)`
	 * instead of `component 5`), diagnostic only, no behavioural effect.
	 *
	 * The handle is *callable*: `Pos({ x: 1 })` mints a `Bundle` for the
	 * attach surfaces (`spawnBundle`, `ctx.commands.spawn`, `addComponent`).
	 *
	 * @example
	 * const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	 * const Hp = ecs.registerComponent(["current", "max"], "i32");
	 * const Frozen = ecs.registerComponent({}, { name: "Frozen" }); // tag
	 * ecs.getField(e, Pos, "x"); // field names and types flow from the schema
	 */
	public registerComponent<S extends Record<string, TypedArrayTag>>(
		schema: S,
		opts?: ComponentRegisterOptions
	): ComponentDef<S>;
	// Overload 2: array shorthand (uniform type, defaults to "f64"). On a
	// `{ deterministic: true }` world the "f64" default is rejected, pass
	// an explicit integer type, e.g. `registerComponent(["x","y"], "i32")`.
	public registerComponent<const F extends readonly string[], T extends TypedArrayTag = "f64">(
		fields: F,
		type?: T,
		opts?: ComponentRegisterOptions
	): ComponentDef<{ readonly [K in F[number]]: T }>;
	// Implementation
	public registerComponent(
		schemaOrFields: Record<string, TypedArrayTag> | readonly string[],
		typeOrOpts?: TypedArrayTag | ComponentRegisterOptions,
		opts?: ComponentRegisterOptions
	): ComponentDef<any> {
		if (Array.isArray(schemaOrFields)) {
			const t = typeof typeOrOpts === "string" ? typeOrOpts : "f64";
			const schema: Record<string, TypedArrayTag> = Object.create(null);
			for (const f of schemaOrFields) schema[f] = t;
			return this._store.registerComponent(schema, opts?.name);
		}
		const o = typeof typeOrOpts === "object" ? typeOrOpts : opts;
		return this._store.registerComponent(
			schemaOrFields as Record<string, TypedArrayTag>,
			o?.name
		);
	}

	// Overload 1: record syntax (per-field types)
	public registerSparseComponent<S extends Record<string, TypedArrayTag>>(
		schema: S,
		opts?: ComponentRegisterOptions
	): SparseComponentDef<S>;
	// Overload 2: array shorthand (uniform type, defaults to "f64"). Same
	// float ban as `registerComponent` on a `{ deterministic: true }` world.
	public registerSparseComponent<
		const F extends readonly string[],
		T extends TypedArrayTag = "f64"
	>(fields: F, type?: T, opts?: ComponentRegisterOptions): SparseComponentDef<{ readonly [K in F[number]]: T }>;
	// Implementation
	/** Register an out-of-identity sparse component. Mirrors
	 * `registerComponent`, but the result lives in an engine-managed sparse set
	 * outside the archetype mask: add and remove cause **no** archetype transition
	 * and consume **no** identity bit (it does not count against the 128-component
	 * cap). Use for churny or rarely-queried data (relation targets, cooldowns,
	 * transient markers). */
	public registerSparseComponent(
		schemaOrFields: Record<string, TypedArrayTag> | readonly string[],
		typeOrOpts?: TypedArrayTag | ComponentRegisterOptions,
		opts?: ComponentRegisterOptions
	): SparseComponentDef<any> {
		if (Array.isArray(schemaOrFields)) {
			const t = typeof typeOrOpts === "string" ? typeOrOpts : "f64";
			const schema: Record<string, TypedArrayTag> = Object.create(null);
			for (const f of schemaOrFields) schema[f] = t;
			return this._store.registerSparseComponent(schema, opts?.name);
		}
		const o = typeof typeOrOpts === "object" ? typeOrOpts : opts;
		return this._store.registerSparseComponent(
			schemaOrFields as Record<string, TypedArrayTag>,
			o?.name
		);
	}

	/**
	 * Spawn an entity, immediately. Bare `spawn()` creates an empty entity,
	 * attach components afterward. `spawn(template, overrides?)` lands
	 * directly in the template's archetype with zero archetype transitions,
	 * applying optional flat per-field overrides on top of the template
	 * defaults. Inside a system use `ctx.commands.spawn(...)` instead.
	 *
	 * `spawn` takes a template. It does not take a component definition, and it
	 * does not take a bundle. For components with no template, use `spawnBundle`.
	 *
	 * @example
	 * const e = ecs.spawn();
	 * ecs.addComponent(e, Pos, { x: 0, y: 0 });
	 *
	 * // Build a template from callable bundles.
	 * const Bullet = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 0 }));
	 * const b = ecs.spawn(Bullet, { x: 5 }); // override a template default
	 *
	 * // One entity, components given directly, no template.
	 * const c = ecs.spawnBundle(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 0 }));
	 */
	public spawn(): EntityID;
	public spawn<Defs extends readonly ComponentDef[]>(
		template: Template<Defs>,
		overrides?: TemplateOverrides<Defs>
	): EntityID;
	public spawn<Defs extends readonly ComponentDef[]>(
		template?: Template<Defs>,
		overrides?: TemplateOverrides<Defs>
	): EntityID {
		if (DEV) {
			this._assertOutsideSystem(
				"spawn",
				"ctx.commands.spawn (deferred to the phase flush)"
			);
			if (template !== undefined) assertTemplate(template, "spawn");
		}
		if (template === undefined) return this._store.createEntity();
		return this._store.spawn(template, overrides);
	}

	/**
	 * Spawn an entity from varargs bundles, the immediate
	 * host-side analog of `ctx.commands.spawn`, and the same callable-bundle
	 * grammar as `addComponents` and `template`. `ecs.spawnBundle(Pos({x,y}),
	 * Vel({vx:1}), IsEnemy)` collapses the attach shapes into one. Each item is
	 * checked against its own def's schema (`StrictBundles`). Bundles are applied
	 * immediately. A single combined-archetype insertion (one transition instead
	 * of one-per-component) is a later optimization, for now this mirrors the
	 * per-component `addComponent` path (unlike `addComponents`, which batches).
	 *
	 * Immediate, inside a system use the deferred `ctx.commands.spawn(...)`
	 * (calling this from a system body throws in DEV). Note the redirect trades
	 * timing: `commands.spawn` returns the id now but defers the attaches to the
	 * phase flush, so the entity sits in its empty and partial archetype until then,
	 * unlike `spawnBundle`'s immediate, fully-populated archetype.
	 */
	public spawnBundle<Items extends readonly BundleOrDef[]>(
		...items: StrictBundles<Items>
	): EntityID {
		if (DEV)
			this._assertOutsideSystem(
				"spawnBundle",
				"ctx.commands.spawn (deferred to the phase flush)"
			);
		const e = this._store.createEntity();
		for (let i = 0; i < items.length; i++) {
			const item = items[i] as BundleOrDef;
			const def = bundleDef(item);
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponent(e, def, bundleValues(item));
		}
		return e;
	}

	/** Bulk-spawn `count` entities from `template`, optionally applying one
	 * shared `overrides` object to every spawned row (same typed keys as
	 * `spawn`). Field writes are O(columns) (one `TypedArray.fill` per
	 * column), not O(count×columns). Returns the new ids in spawn order.
	 * Immediate, inside a system use `ctx.commands.spawn` per entity (calling
	 * this from a system body throws in DEV). */
	public spawnMany<Defs extends readonly ComponentDef[]>(
		template: Template<Defs>,
		count: number,
		overrides?: TemplateOverrides<Defs>
	): EntityID[] {
		if (DEV) {
			this._assertOutsideSystem(
				"spawnMany",
				"ctx.commands.spawn (deferred to the phase flush)"
			);
			assertTemplate(template, "spawnMany");
		}
		return this._store.spawnMany(template, count, overrides);
	}

	/** DEV-only: throw when an *immediate* host structural mutator is called
	 * from inside one of this world's system bodies. An observer callback and an
	 * `onAdded` hook run in the same access span, so the guard covers them too.
	 * One rule covers every host structural mutator: `despawn`, `addComponent`,
	 * `addComponents`, `removeComponent`, `removeComponents`,
	 * `batchAddComponent`, `batchRemoveComponent`, `disable`, `enable`, and the
	 * spawn family (`spawn`, `spawnBundle` and `spawnMany`).
	 * An immediate structural op mid-schedule can move or swap rows
	 * a running query is walking. A spawn-append into that archetype can trip a
	 * column realloc under it. Neither is visible to observers. The archetype-level
	 * `_iterDepth` guard only catches mutations touching the archetype currently
	 * being iterated (and the append paths skip even that), so an op landing
	 * elsewhere would silently skip observers. The receiver rule ("inside a
	 * system, use ctx.commands") is enforced wholesale here.
	 *
	 * `_updating` scopes the guard to this world: the accessCheck slot is
	 * process-global, so without it a system of world A mutating world B (a
	 * supported pattern. B is not mid-iteration) would false-throw. */
	private _assertOutsideSystem(op: string, alternative: string): void {
		if (this._updating && accessCheck.current() !== null) {
			const desc = accessCheck.current()!;
			const name = desc.name ?? `system_${desc.id}`;
			throw new ECSError(
				ECS_ERROR.ACCESS_UNDECLARED,
				`ecs.${op} was called from inside system '${name}'. The host ${op} is immediate, unsafe mid-iteration, and invisible to observers. Use ${alternative} instead`,
				{ op }
			);
		}
	}

	/** Immediately destroy an entity, `ecs.despawn(e); ecs.isAlive(e)` is
	 *  `false` on the next line, matching the immediacy of every other host
	 *  facade mutation. Inside a system the buffered path is
	 *  `ctx.commands.despawn`, applied at the phase flush. A call from a system
	 *  body throws in DEV, because an immediate destroy mid-iteration can
	 *  invalidate rows the running query is walking. */
	public despawn(entityId: EntityID): this {
		if (DEV)
			this._assertOutsideSystem(
				"despawn",
				"ctx.commands.despawn (deferred to the phase flush)"
			);
		this._store.destroyEntity(entityId);
		return this;
	}

	// --- Entity enable and disable ---
	// A disabled entity keeps its components, relations, sparse data, and stable
	// `EntityID`, but is excluded from queries by default (it sits in the disabled
	// tail of its archetype, so `arch.entityCount` skips it). No archetype
	// transition. Toggling is a single row swap. Host-side calls are immediate
	// (mirrors `addComponent`). The deferred in-system path is
	// `ctx.commands.disable` and `ctx.commands.enable`, because a row swap would
	// corrupt an in-flight `forEach` over that archetype. An entity must hold at
	// least one component (a component-less entity has no archetype row to
	// partition).

	/** Disable `entityId` (idempotent). Excluded from default queries until re-enabled. */
	public disable(entityId: EntityID): this {
		if (DEV)
			this._assertOutsideSystem(
				"disable",
				"ctx.commands.disable (deferred to the phase flush)"
			);
		this._store.disableEntity(entityId);
		return this;
	}

	/** Re-enable a disabled `entityId` (idempotent). */
	public enable(entityId: EntityID): this {
		if (DEV)
			this._assertOutsideSystem(
				"enable",
				"ctx.commands.enable (deferred to the phase flush)"
			);
		this._store.enableEntity(entityId);
		return this;
	}

	/**
	 * Attach a component to an entity, immediately (inside a system, use the
	 * deferred `ctx.commands.add`). Three shapes: a bare def attaches a tag. A
	 * bundle (`Pos({ x: 1 })`) zero-fills omitted fields. The explicit
	 * `(e, def, values)` form demands every field, so a typo'd or missing
	 * field is a compile error.
	 *
	 * @example
	 * ecs.addComponent(e, Frozen);                 // tag
	 * ecs.addComponent(e, Pos({ x: 1 }));          // bundle, y zero-fills
	 * ecs.addComponent(e, Pos, { x: 1, y: 2 });    // complete values
	 */
	public addComponent(entityId: EntityID, def: ComponentDef<Record<string, never>>): this;
	public addComponent<S extends ComponentSchema>(entityId: EntityID, bundle: Bundle<S>): this;
	public addComponent<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): this;
	public addComponent(
		entityId: EntityID,
		item: BundleOrDef,
		values?: Record<string, number>
	): this {
		const def = bundleDef(item);
		if (DEV) {
			this._assertOutsideSystem(
				"addComponent",
				"ctx.commands.add (deferred to the phase flush)"
			);
			accessCheck.assertAdd(def);
		}
		this._store.addComponent(entityId, def, values ?? bundleValues(item));
		return this;
	}

	/** Batch-attach several components in one archetype transition. Takes the
	 * same callable-bundle varargs as `spawnBundle`, `world.addComponents(e,
	 * Pos({ x, y }), Vel({ vx }), Frozen)`, each item checked against its own
	 * def's schema (a misspelled or cross-component field is a compile error,
	 * and a tag refuses values). Omitted fields zero-fill. */
	public addComponents<Items extends readonly BundleOrDef[]>(
		entityId: EntityID,
		...items: StrictBundles<Items>
	): this {
		const entries: { def: ComponentDef; values: Readonly<Record<string, number>> }[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i] as BundleOrDef;
			entries.push({ def: bundleDef(item), values: bundleValues(item) });
		}
		if (DEV) {
			this._assertOutsideSystem(
				"addComponents",
				"ctx.commands.add (deferred to the phase flush)"
			);
			for (let i = 0; i < entries.length; i++) accessCheck.assertAdd(entries[i].def);
		}
		this._store.addComponents(entityId, entries);
		return this;
	}

	public removeComponent(entityId: EntityID, def: ComponentDef): this {
		if (DEV) {
			this._assertOutsideSystem(
				"removeComponent",
				"ctx.commands.remove (deferred to the phase flush)"
			);
			accessCheck.assertRemove(def);
		}
		this._store.removeComponent(entityId, def);
		return this;
	}

	/** Detach several components in one archetype transition, the varargs
	 * mirror of `addComponents` (bare defs, removing needs no values). */
	public removeComponents(entityId: EntityID, ...defs: ComponentDef[]): this {
		if (DEV) {
			this._assertOutsideSystem(
				"removeComponents",
				"ctx.commands.remove (deferred to the phase flush)"
			);
			for (let i = 0; i < defs.length; i++) accessCheck.assertRemove(defs[i]);
		}
		this._store.removeComponents(entityId, defs);
		return this;
	}

	/**
	 * Bulk add a component to all entities in the given archetype.
	 * O(columns) via TypedArray.set() instead of O(N×columns).
	 *
	 * Takes an `ArchetypeID` (from `ArchetypeView.id`) rather than a concrete
	 * `Archetype`, the concrete type is internal.
	 */
	public batchAddComponent(src: ArchetypeID, def: ComponentDef<Record<string, never>>): this;
	public batchAddComponent<S extends ComponentSchema>(
		src: ArchetypeID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): this;
	public batchAddComponent(
		src: ArchetypeID,
		def: ComponentDef,
		values?: Record<string, number>
	): this {
		if (DEV) {
			this._assertOutsideSystem(
				"batchAddComponent",
				"ctx.commands.add per entity, or the batch after update() returns"
			);
			accessCheck.assertAdd(def);
		}
		this._store.batchAddComponent(src, def, values);
		return this;
	}

	/**
	 * Bulk remove a component from all entities in the given archetype.
	 * O(columns) via TypedArray.set() instead of O(N×columns).
	 *
	 * Takes an `ArchetypeID`, from `ArchetypeView.id`. See `batchAddComponent`.
	 */
	public batchRemoveComponent(src: ArchetypeID, def: ComponentDef): this {
		if (DEV) {
			this._assertOutsideSystem(
				"batchRemoveComponent",
				"ctx.commands.remove per entity, or the batch after update() returns"
			);
			accessCheck.assertRemove(def);
		}
		this._store.batchRemoveComponent(src, def);
		return this;
	}

	public getField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S
	): number {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("getField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		return arch.readField(this._store.resolvedRow, def.id, field);
	}

	/** Host-side parity with `SystemContext.refRead`: a
	 * read-only whole-component view for tooling and tests, instead of reading
	 * field-by-field. Same advisory-`readonly` semantics as the ctx variant,
	 * and no `_changedTick` bump. Dev-throws on a dead entity, or when the entity
	 * doesn't hold the component (tags included, no fields, nothing to ref).
	 *
	 * **Staleness:** unlike ctx refs (protected by deferred structural changes
	 * until the phase flush), host-side structural mutations apply immediately,
	 * any `addComponent`, `removeComponent` and `despawn` after creating the ref can
	 * row-swap so the old ref silently reads *another entity's* data. The ref is
	 * only valid until the next structural mutation. Treat it as an immediate
	 * single-expression read and re-create it after any structural change. */
	public refRead<S extends ComponentSchema>(
		def: ComponentDef<S>,
		entityId: EntityID
	): ReadonlyComponentRef<S> {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId))
				throw entityNotAliveError("refRead", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		if (DEV && arch.accessorColumns[def.id] === undefined)
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`refRead: ${componentLabel(def)} has no columns in this archetype, the entity doesn't hold it, or it is a tag (no fields to ref)`,
				{ component: def.id, entity: entityId }
			);
		// ! safe in prod (dev guard above): _accCols is populated for all components with fields in this archetype
		return createRef<S>(arch.accessorColumns[def.id]!, row);
	}

	/**
	 * A re-pointable single-entity cursor over `def`, the by-id sweep accessor.
	 *
	 * `refRead` resolves an entity one time, and each field after that is almost
	 * free. But it allocates one accessor for each entity. That allocation is the
	 * largest part of the cost of a read of one field by id, because to make an
	 * accessor and to read through it costs much more than to move an accessor
	 * that exists. In a loop over a list of entities, the allocation is not
	 * necessary: the code discards each accessor, and it then makes an equal
	 * accessor for the next entity. You make a cursor one time, and you then
	 * move it again:
	 *
	 *   const p = ecs.cursor(Pos);
	 *   for (let i = 0; i < ids.length; i++) {
	 *     p.at(ids[i]);
	 *     p.x += p.y
	 *   }
	 *
	 * Reach for it when you touch many entities by id. Reach for `refRead` or
	 * `ref` for a single entity, and for `forEachChunk` whenever a query can express
	 * the set. A column walk resolves nothing for each row, so it stays quicker
	 * than a cursor, a cursor removes the allocation, not the resolution.
	 *
	 * Mutable, every `at()` stamps the component's change tick, like `ctx.ref`.
	 * See `cursorRead` for the read-only variant.
	 *
	 * **Staleness:** safer than a held ref, because `at()` re-resolves the
	 * archetype and row each time, a structural mutation between two `at()` calls
	 * cannot make it read the wrong entity. Only the window between one `at()` and
	 * the field accesses following it must be free of structural mutation.
	 */
	public cursor<S extends ComponentSchema>(def: ComponentDef<S>): ComponentCursor<S> {
		if (DEV) accessCheck.assertWrite(def);
		return createCursor<S>(this._store.componentFieldNames(def), this._store.cursorBinder(def, true));
	}

	/** Read-only {@link cursor}: no change-tick stamp on `at()`. Advisory only,
	 * same caveat as `refRead` (the setters exist on the shared prototype). */
	public cursorRead<S extends ComponentSchema>(def: ComponentDef<S>): ReadonlyComponentCursor<S> {
		if (DEV) accessCheck.assertRead(def);
		return createCursor<S>(
			this._store.componentFieldNames(def),
			this._store.cursorBinder(def, false)
		) as ReadonlyComponentCursor<S>;
	}

	/**
	 * A re-pointable single-entity cursor over a sparse component, the sparse
	 * sibling of {@link cursor}, and the fastest read by id the engine has.
	 *
	 * A sparse component's columns are indexed by entity index, so `at(entity)`
	 * writes one field and a field access is one load: there is no archetype
	 * and no row to resolve, which is what a dense cursor must do on every
	 * `at()`. Make the cursor one time and move it in the loop:
	 *
	 *   const hp = ecs.sparseCursor(Health);
	 *   for (let i = 0; i < ids.length; i++) {
	 *     hp.at(ids[i]);
	 *     hp.current -= damage[i];
	 *   }
	 *
	 * Mutable, like `cursor`. Once the component keeps row ticks
	 * (`trackRows`, or an entity-level `onSet`), `at()` records the entity for
	 * them, as the dense cursor does. See `sparseCursorRead` for the read-only
	 * variant.
	 *
	 * **Membership:** in development `at()` throws when the entity is dead or
	 * does not hold the component. In production it does not test, and a read
	 * then gives whatever the column holds at that index. Test with `hasSparse`
	 * first when the component can be absent.
	 */
	public sparseCursor<S extends ComponentSchema>(def: SparseComponentDef<S>): ComponentCursor<S> {
		if (DEV) accessCheck.assertSparseWrite(def);
		return createSparseCursor<S>(
			this._store.sparseFieldNames(def),
			this._store.sparseAccessorColumns(def),
			this._store.sparseCursorCheck(def, true),
			this._store.sparseTickPlane(def),
			this._store
		);
	}

	/** Read-only {@link sparseCursor}. Advisory only, same caveat as
	 * `cursorRead` (the setters exist on the shared prototype). */
	public sparseCursorRead<S extends ComponentSchema>(
		def: SparseComponentDef<S>
	): ReadonlyComponentCursor<S> {
		if (DEV) accessCheck.assertSparseRead(def);
		return createSparseCursor<S>(
			this._store.sparseFieldNames(def),
			this._store.sparseAccessorColumns(def),
			this._store.sparseCursorCheck(def, false)
		) as ReadonlyComponentCursor<S>;
	}

	/** Total sibling of {@link getField}: `undefined` when the
	 * entity is dead or doesn't hold the component, instead of a dev throw and a
	 * prod garbage read. The safe way to probe-and-read in one call:
	 * `ecs.tryGetField(e, Health, "current") ?? 0`. */
	public tryGetField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S
	): number | undefined {
		if (DEV) accessCheck.assertRead(def);
		if (!this._store.hasComponent(entityId, def)) return undefined;
		const arch = this._store.resolveEntity(entityId);
		return arch.readField(this._store.resolvedRow, def.id, field);
	}

	public setField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		value: number
	): void {
		if (DEV) {
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("setField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		const col = arch.getColumnMut(def, field, this._store.changeTick);
		col[row] = value;
		// Per-entity onSet observers drain the opt-in dirty list. Record
		// this host-side write so an entity-granular observer sees it, matching
		// `SystemContext.setField`. Gated so the no-observer path pays nothing.
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
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

	/**
	 * Get the live, cached query matching entities that have **all** of
	 * `defs`. Queries are deduplicated by mask, calling this twice with the
	 * same terms returns the same instance, so build once at setup and reuse.
	 * The view stays live as archetypes appear. Refine with `.and()`,
	 * `.not()` or `.or()`. Iterate with `forEachChunk` (mutating hot path),
	 * `forEach` (per-archetype), or `forEachEntity` (per-entity).
	 *
	 * @example
	 * const movers = ecs.query(Pos, Vel);
	 * movers.forEachChunk((cols, count) => {
	 *   const { x, y } = cols.mut(Pos);
	 *   const { vx, vy } = cols.read(Vel);
	 *   for (let i = 0; i < count; i++) { x[i] += vx[i]; y[i] += vy[i]; }
	 * });
	 */
	public query<T extends ComponentDef[]>(...defs: T): Query<T> {
		// Reuse scratchMask to avoid allocating a new BitSet per query call.
		// Zero it out, set bits, then hand the scratch straight to the resolver:
		// `resolveQuery` Borrows its mask arguments (it copies on the mint path,
		// twice, and `Store.registerQuery` copies again), so the caller-side
		// `.copy()` this used to do was pure garbage on the cache-hit path,
		// a BitSet + backing `number[]` per `ecs.query(...)` call.
		const mask = this._scratchMask;
		mask.words.fill(0);
		for (let i = 0; i < defs.length; i++) {
			mask.set(defs[i].id);
		}
		return this.resolveQuery(mask, null, null, defs);
	}

	public nextQueryId(): number {
		return this._nextQueryIdCounter++;
	}

	/** QueryResolver implementation, creates or retrieves a cached Query.
	 *
	 * **Mask ownership: borrowed.** The three mask arguments are read, never
	 * retained, the mint path copies each one into the `Query`, into the dedup
	 * entry, and (via `Store.registerQuery`) into the registered-query record.
	 * So callers may pass a scratch mask they intend to reuse (`ecs.query`) or
	 * a live mask they still own (`Query.and`, `.not` and `.or` pass
	 * `this._include` etc.). Do not add a caller-side `.copy()` "for safety":
	 * on the cache-hit path that is a per-call BitSet + `number[]` allocation
	 * for nothing. */
	public resolveQuery(
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

		const cached = this.caches.findDedup(key, include, exclude, anyOf);
		if (cached !== undefined) return cached.query;

		// Mint path. The masks are copied three times below at three different
		// moments (into `registerQuery`'s record, into the `Query`, and into the
		// dedup entry), so the borrow contract documented above has to hold across
		// all three: a callee that mutated `include` mid-mint would give the copies
		// different contents and silently mis-key the cache. `ecs.query` passes a
		// reusable scratch mask, and `Query.and`, `.not` and `.or` pass another
		// Query's live mask, so a violation corrupts existing queries, not only a
		// temporary. Everything reachable from here (`getMatchingArchetypes`,
		// `bucketPush`) only reads them.
		//
		// Store.registerQuery returns a live Archetype[] that the Store will
		// push new matching archetypes into as they are created
		const result = this._store.registerQuery(include, exclude ?? undefined, anyOf ?? undefined);
		const q = new Query(
			result,
			defs as ComponentDef[],
			this,
			include.copy(),
			exclude?.copy() ?? null,
			anyOf?.copy() ?? null,
			this._nextQueryIdCounter++
		);
		this._store.updateQueryRef(result, q);
		this.caches.addDedup(key, {
			includeMask: include.copy(),
			excludeMask: exclude?.copy() ?? null,
			anyOfMask: anyOf?.copy() ?? null,
			query: q
		});
		return q;
	}

	/**
	 * Register a system and get its scheduling handle. The config form is the
	 * production shape. It declares the access surface. `reads` and `writes` are
	 * mandatory. The `spawns`, `despawns`, resource, sparse and relation terms
	 * are optional. The runtime enforces the surface in dev, and it narrows `ctx` at
	 * the type level so undeclared access fails to compile. Registration does
	 * not schedule, pass the returned descriptor to
	 * `ecs.addSystems(SCHEDULE.UPDATE, ...)`.
	 *
	 * @example
	 * // Full config, declared access, dev-checked and compile-checked
	 * const move = ecs.registerSystem({
	 *   reads: [Vel],
	 *   writes: [Pos],
	 *   fn(ctx, dt) {
	 *     movers.forEachChunk((cols, count) => { ... });
	 *   },
	 * });
	 * ecs.addSystems(SCHEDULE.UPDATE, move);
	 *
	 * @example
	 * // Bare function (no declared access, any component touch throws in dev)
	 * ecs.registerSystem((ctx, dt) => { ... });
	 * // Function + query builder (query resolved at registration time)
	 * ecs.registerSystem((q, ctx, dt) => { q.forEach((arch) => { ... }); }, (qb) => qb.and(Pos, Vel));
	 */
	public registerSystem(fn: SystemFn): SystemDescriptor;
	public registerSystem<Defs extends readonly ComponentDef[]>(
		fn: (q: Query<Defs>, ctx: SystemContext, dt: number) => void,
		queryFn: (qb: QueryBuilder) => Query<Defs>
	): SystemDescriptor;
	/** `exclusive: true` grants full world access at runtime (system.ts), so
	 * the context stays fully permissive at the type layer too. Declared before
	 * the typed-config overload so exclusive configs never get narrowed. */
	public registerSystem(config: SystemConfig & { readonly exclusive: true }): SystemDescriptor;
	/** Config form (system.ts): the declaration lists are inferred
	 * as literal tuples, and `fn` and `onAdded` receive
	 * `SystemContext<DeclaredAccess<…>>`, undeclared access fails to compile
	 * with the same taxonomy the runtime `accessCheck` throws with in
	 * `DEV`. A config value typed as plain `SystemConfig` (dynamically
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
				// (fn, queryFn) overload, resolve query at registration time
				const q = queryFn(new QueryBuilder(this));
				const ctx = this._ctx;
				const fn = fnOrConfig as (q: Query<any>, ctx: SystemContext, dt: number) => void;
				config = { ..._INTERNAL_EMPTY_ACCESS, fn: (_ctx, dt) => fn(q, ctx, dt) };
			} else {
				config = _createBareSystemConfig(fnOrConfig as SystemFn);
			}
		} else {
			config = fnOrConfig as SystemConfig;
		}

		// Declared-access lint: catch a `queries` declaration that outruns
		// `reads ∪ writes` at registration, before the system's first iteration.
		if (DEV) _assertQueriesDeclared(config);
		if (DEV) _assertSystemRunnable(config);

		// The installed route resolves its plan here, once. The plugin owns the
		// plan and its validation, so a world with no route leaves `routePlan`
		// undefined and the system runs its `fn`. The planner answers `undefined`
		// for a system it does not claim, which is why the core spells no
		// plugin's config member. Registration is cold.
		const planner = this._routePlanner;
		const routePlan: object | undefined = planner === null ? undefined : planner.plan(config);

		const descriptor: SystemDescriptor = _createSystemDescriptor(
			config,
			routePlan,
			this._nextSystemId++
		);
		this._systems.add(descriptor);
		return descriptor;
	}

	public removeSystem(system: SystemDescriptor): this {
		this._schedule.removeSystem(system);
		system.onRemoved?.();
		this._systems.delete(system);
		return this;
	}

	public get systemCount(): number {
		return this._systems.size;
	}

	/**
	 * Run the startup phases, once, before the first `update()`. Prewarms
	 * every archetype the registered systems and observers can produce, runs each
	 * system's `onAdded` hook, then the `PRE_STARTUP` → `STARTUP` →
	 * `POST_STARTUP` schedule. Events emitted during startup are drained at
	 * its tail. They do not leak into frame 1.
	 *
	 * @example
	 * ecs.addSystems(SCHEDULE.UPDATE, move);
	 * ecs.startup();
	 * ecs.update(1 / 60); // now tick every frame
	 */
	public startup(): void {
		// Archetype prewarm, walk every registered system's `spawns` +
		// `transitions` to compute the archetype closure they can produce,
		// and plant the whole set in a single `extendColumnStore` call. After
		// this returns, every spawn and transition target hits the cached
		// `archGetOrCreateFromMask` path, no per-add SAB extends, which
		// was the O(N²) cost this avoids. Dynamically-generated masks not
		// covered by the closure still hit the lazy single-mask fallback.
		this._prewarmArchetypes();

		if (DEV) this._updating = true;
		try {
			for (const descriptor of this._systems.values()) {
				if (descriptor.onAdded === undefined) continue;
				if (DEV) accessCheck.enter(descriptor);
				try {
					descriptor.onAdded(this._ctx);
				} finally {
					if (DEV) accessCheck.leave();
				}
			}
			this._schedule.runStartup(this._ctx);
		} finally {
			if (DEV) this._updating = false;
		}

		// Events live exactly one *update* tick. Startup is setup, not an
		// update tick, so any event a startup phase emits (readable across the
		// `PRE_STARTUP`→`STARTUP`→`POST_STARTUP` run above) must be drained here,
		// otherwise it sits in the channel until the first `update()` clears it
		// at its tail, and a first-frame `PRE_UPDATE` or `UPDATE` reader sees it as if
		// emitted this frame. Mirrors `update()`'s tail.
		if (this._store.hasEvents) this._store.events.clear();
	}

	/** Compute the archetype closure from every registered system's and
	 * observer's `spawns` + `transitions` and ask the store to plant the
	 * whole set in one `extendColumnStore` call. Observers carry the same
	 * access shape systems do (a synthesized `SystemDescriptor`), so an
	 * observer that spawns and transitions gets its target archetype prewarmed
	 * too rather than first-touching lazily mid-tick. Exposed as
	 * `private` because the only caller is `startup()`. Visible to tests via
	 * the `archetypeCount` delta on the public ECS facade. */
	private _prewarmArchetypes(): void {
		const sources = this._prewarmSources;
		const contributed: SystemDescriptor[] = [];
		for (let i = 0; i < sources.length; i++) contributed.push(...sources[i]());
		const closure = computeArchetypeClosure([...this._systems, ...contributed]);
		if (closure.length === 0) return;
		this._store.archCreateManyFromMasks(closure);
	}

	/**
	 * Advance the world one frame. Runs the fixed-timestep accumulator loop
	 * (`FIXED_UPDATE`, when any fixed system is registered), then
	 * `PRE_UPDATE` → `UPDATE` → `POST_UPDATE`, flushing deferred structural
	 * commands at each phase boundary. Events emitted this tick are readable
	 * for the rest of the tick and cleared at the tail. `dt` is in seconds.
	 *
	 * @example
	 * let last = performance.now();
	 * function frame(now: number) {
	 *   ecs.update((now - last) / 1000);
	 *   last = now;
	 *   requestAnimationFrame(frame);
	 * }
	 * requestAnimationFrame(frame);
	 */
	public update(dt: number): void {
		// Multi-world re-entrancy: a system may drive a *second* world's
		// tick from inside its own open access span, e.g. a host running N
		// worlds where world A's system calls `worldB.update()`. The schedule's
		// per-system `enter` and `leave` writes the single process-global
		// `accessCheck` slot, so B's tick ends with the slot nulled, silently
		// disabling dev access enforcement for the rest of A's system body (the
		// `check*` guards early-return when no span is active). Snapshot the
		// caller's span and restore it after the tick, the same save and restore the
		// observer dispatch already performs for nested spans (`dispatchStructural`
		// and `dispatchSet` on the registry). Dev-only. `prevAccessSpan` is
		// null on the normal host-driven (non-nested) path, so the restore is a
		// no-op there. This keeps each world isolated.
		const prevAccessSpan = DEV ? accessCheck.current() : null;
		try {
			if (DEV) this._updating = true;
			this._store.tick = this._tick;
			if (DEV) this._store.trace?.tickBegin(this._tick, dt);

			// Publish row counts before the first phase runs. Covers any
			// immediate-mode `addComponents`, `removeComponents` or
			// `despawn` the host did between updates, those mutate
			// archetype lengths without touching the SAB descriptor.
			// Subsequent phase boundaries re-publish via `ctx.flush()`, so
			// any WASM scan in any phase sees fresh `row_count` fields.
			this._store.publishRowCounts();

			if (this._schedule.hasFixedSystems()) {
				this._accumulator += dt;
				const maxAcc = this._maxFixedSteps * this._fixedTimestep;
				if (this._accumulator > maxAcc) {
					this._accumulator = maxAcc;
				}
				while (this._accumulator >= this._fixedTimestep) {
					this._schedule.runFixedUpdate(this._ctx, this._fixedTimestep);
					this._accumulator -= this._fixedTimestep;
				}
			}

			this._schedule.runUpdate(this._ctx, dt);
			// The post-update detection point:
			// per-entity onSet drains the dirty list, archetype-granular onSet scans
			// the change tick, both in canonical order. The point gets its own
			// change tick, above every run this frame, so an observer's baseline
			// orders against every system's stamps and against the previous host
			// window. onSet runs inside the event
			// window, and `events.clear()` is the tick's last act. So onSet reads the
			// settled component snapshot *and* this tick's events. The channel is
			// then empty at the tick boundary, which snapshot and restore relies on,
			// because it excludes event state. Any structural ops an onSet observer enqueues flush at the next
			// tick's first phase boundary.
			const evBefore = DEV && this._store.hasEvents ? this._store.events.devBufferedCount() : 0;
			// The tick advances whether or not a consumer exists. It marks the
			// detection point, which a `changed()` query reads on a world that
			// installed no plugin. Only the dispatch is conditional.
			const setTick = this._store.advanceChangeTick();
			const settle = this._settleHooks;
			for (let i = 0; i < settle.length; i++) settle[i](setTick);
			if (DEV && this._store.hasEvents && this._store.events.devBufferedCount() !== evBefore) {
				// An onSet observer emitted: `events.clear()` below would wipe it before
				// any reader, so it is silently dropped, and it would break snapshot
				// and restore determinism if it survived. Bridge a detected change to
				// a next-tick event from a system reading the dirty list, not from onSet.
				throw new ECSError(
					ECS_ERROR.OBSERVER_ONSET_EMIT,
					"an onSet observer emitted an event. onSet runs at the tick tail, and events.clear() drops what it emits. Emit from a system instead"
				);
			}
			if (this._store.hasEvents) this._store.events.clear();
			if (DEV) this._store.trace?.tickEnd(this._tick);
			this._tick++;
			// The host window. A write between two updates stamps the value this
			// leaves, which is above every system's last run and above the onSet
			// dispatch, so the next frame reports it once at both grains.
			this._store.advanceChangeTick();
		} finally {
			if (DEV) this._updating = false;
			// Restore the outer world's access span (no-op when not nested).
			if (DEV && prevAccessSpan !== null) accessCheck.enter(prevAccessSpan);
		}
	}

	public dispose(): void {
		// The workers hold the store bytes and keep the process alive, so they
		// stop with the world. `dispose` is synchronous and the stop is not, so
		// the plugin starts it here and a caller that wants the end awaits
		// `world.workers.detach()` instead.
		const disposers = this._disposeHooks;
		for (let i = 0; i < disposers.length; i++) disposers[i]();
		for (const descriptor of this._systems.values()) {
			descriptor.dispose?.();
			descriptor.onRemoved?.();
		}
		this._systems.clear();
		this._schedule.clear();
	}

	/** Register an archetype template. Resolves the component set +
	 * default field values to a target archetype once (creating it if absent,
	 * fits the prewarm model), so a later `spawn` or `spawnMany` call lands
	 * entities directly in that archetype with no archetype transition.
	 *
	 *   const Bullet = ecs.template(Position({ x: 0, y: 0 }), Velocity({ vx: 0, vy: 0 }));
	 *
	 * Takes the same callable-bundle varargs as `spawnBundle` and
	 * `addComponents`, each item schema-checked against its own def. The resulting
	 * `Template<[Position, Velocity]>` keeps the typed key set that `spawn`'s
	 * `overrides` map over. Not a pass-through. It normalizes bundles to the
	 * store's entry shape, so it lives here with the other real logic, not in the
	 * delegation band. The big win is multi-component entities and bulk spawns. A
	 * single-component spawn is no faster than `spawn` + `addComponent`, which
	 * already bump-allocates a fresh entity into the target archetype. */
	public template<Items extends readonly BundleOrDef[]>(
		...items: StrictBundles<Items>
	): Template<DefsOf<Items>> {
		// DEV-only: reject the old array-of-entries call. Before the 0.5
		// callable-bundle change the shape was `template([{ def, values }])`, and
		// that shape stayed in one JSDoc example after the change. An array reaches
		// `createTemplate`, which reads `entries[0].def.id` and fails with a
		// `TypeError` about `id`. That error names the store, not the caller.
		if (DEV && items.length === 1 && Array.isArray(items[0])) {
			throw new ECSError(
				ECS_ERROR.INVALID_TEMPLATE,
				`template: got an array. This is the pre-0.5 shape ` +
					`\`template([{ def: Pos, values: { x: 0 } }])\`, which no longer works. ` +
					`Pass callable bundles instead: \`template(Pos({ x: 0 }), Vel)\`.`,
				{ op: "template" }
			);
		}
		const entries: { def: ComponentDef; values: Readonly<Record<string, number>> }[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i] as BundleOrDef;
			entries.push({ def: bundleDef(item), values: bundleValues(item) });
		}
		return this._store.createTemplate(entries) as unknown as Template<DefsOf<Items>>;
	}

	// ============================================================================
	// === BEGIN STORE PASS-THROUGH BAND ===
	//
	// Every member below is a single mechanical delegation to a collaborator,
	// one of `this._store`, `this._schedule` and `this._ctx`.
	// It may also delegate to one the store exposes by name, one of
	// `this._store.relations`, `.events`, `.resources` and `.snapshots`. Each is
	// exactly one call or property read,
	// optionally followed by `return this` for chaining. No branches, no loops,
	// no dev checks, no argument adaptation beyond literal defaults. The named
	// hop is not logic, it says which object owns the state, so the store no
	// longer needs a forwarding method per operation. This section must stay
	// logic-free, a method that outgrows the shape (gains a check, adapts a
	// result, combines calls) moves above the band, next to the other real
	// logic.
	//
	// Enforced by src/core/ecs/__tests__/unit/ecs_passthrough_guard.test.ts,
	// which parses this file and asserts the shape of every member between
	// the begin and end markers.
	// ============================================================================


	/** Resolve a consumer-declared SAB region's byte offset by `region_id`, or
	 * 0 when absent. Generic, de-gamed replacement for the removed
	 * game-named accessors. Pair with the consumer's own region module to
	 * materialise a typed view. Delegates to `Store.regionOffset`. */
	public regionOffset(regionId: number): number {
		return this._store.regionOffset(regionId);
	}

	/** A handle (`{ buffer, view, offset, bytes }`) to a consumer-declared SAB
	 * region resolved by `region_id`, or `null` when absent. A consumer's
	 * region module builds a TypedArray view over the region's span from this.
	 * Re-fetch after a SAB grow. Delegates to `Store.regionHandle`. */
	public regionHandle(regionId: number): ColumnStoreRegionHandle | null {
		return this._store.regionHandle(regionId);
	}

	/** Look up the field index a component reserves for `fieldName`. The
	 * index is assigned by `registerComponent` in insertion order and is
	 * stable for the lifetime of the ECS. Used by systems that need to
	 * pass `(component_id, field_id)` pairs across the WASM FFI, because the
	 * module identifies columns by these numeric ids. */
	public fieldId<S extends Record<string, TypedArrayTag>>(
		def: ComponentDef<S>,
		fieldName: Extract<keyof S, string>
	): number {
		return this._store.fieldIdOf(def, fieldName);
	}

	/** Resolve an archetype's row index to the `EntityID` at that slot.
	 * A WASM system that drains events from the event ring as
	 * `(archId, row, …)` payloads uses this to convert the (archId, row)
	 * pair into the `EntityID` the `ctx.emit(...)` API expects.
	 * Throws if the (archId, row) pair is out of range. */
	public entityIdAtRow(archetypeId: number, row: number): EntityID {
		return this._store.entityIdAtRow(archetypeId, row);
	}

	/** The single SAB backing every archetype's column views. Exposed for
	 * snapshot and restore, `columnStoreStateHash`-based determinism checks, and
	 * WASM or worker hand-off paths. Mutation flows through the
	 * usual `addComponent`, `removeComponent` and `flush` APIs. Readers
	 * that hold a column view across a grow must consult
	 * `header.view_stamp` to detect a republish. */
	public get columnStore(): ColumnStore {
		return this._store.columnStore;
	}

	/** Count of live archetypes (including the empty one). Surfaces the
	 * Store-side `archetype_count` so tests can assert the
	 * pre-warmed closure was materialised. Equally useful for diagnostics. */
	public get archetypeCount(): number {
		return this._store.archetypeCount;
	}

	public registerTag(): ComponentDef<Record<string, never>> {
		return this._store.registerComponent({} as Record<string, never>);
	}

	/** Register a sparse tag (empty schema), membership only, no data. */
	public registerSparseTag(): SparseComponentDef<Record<string, never>> {
		return this._store.registerSparseComponent({} as Record<string, never>);
	}

	public isAlive(entityId: EntityID): boolean {
		return this._store.isAlive(entityId);
	}

	public get entityCount(): number {
		return this._store.entityCount;
	}

	public hasComponent(entityId: EntityID, def: ComponentDef): boolean {
		return this._store.hasComponent(entityId, def);
	}

	/** Whether `entityId` is currently disabled. Toggle with `disable` or `enable`
	 * (immediate, above the band. They carry the in-system dev guard). */
	public isDisabled(entityId: EntityID): boolean {
		return this._store.isDisabled(entityId);
	}

	// --- Sparse (out-of-identity) component operations ---
	// Mutating a sparse component causes no archetype transition, so these are
	// immediate (no deferred buffer) and safe mid-tick. They never reallocate
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
		this._store.addSparse(entityId, def, values);
		return this;
	}

	public removeSparse(entityId: EntityID, def: SparseComponentDef): this {
		this._store.removeSparse(entityId, def);
		return this;
	}

	public hasSparse(entityId: EntityID, def: SparseComponentDef): boolean {
		return this._store.hasSparse(entityId, def);
	}

	public getSparseField<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		field: string & keyof S
	): number {
		return this._store.getSparseField(entityId, def, field);
	}

	public setSparseField<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		field: string & keyof S,
		value: number
	): void {
		this._store.setSparseField(entityId, def, field, value);
	}


	public getLastRunTick(): number {
		return this._ctx.lastRunTick;
	}

	/** The change tick, the stamp `forEachChunk` makes via `cols.mut`. */
	public getChangeTick(): number {
		return this._store.changeTick;
	}

	/** QueryResolver implementation: a chunk loop took `cols.ticks(def)`. */
	public noteScan(cid: number): void {
		this._store.noteScan(cid);
	}

	public getQueryDirtyEpoch(): number {
		return this._store.queryDirtyEpoch;
	}

	/** QueryResolver implementation, sparse-membership match path. */
	public forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void
	): void {
		this._store.forEachSparseMatch(include, exclude, anyOf, terms, denseArchetypes, cb);
	}

	/** QueryResolver implementation, backing sparse id of a relation, for the
	 * `(R, *)` wildcard term (`Query.andRelation`). */
	public relationBackingSparseId(def: RelationDef, api: string): SparseComponentID {
		return this._store.relationBackingSparseId(def, api);
	}

	/** QueryResolver implementation, `(*, T)` wildcard match path. */
	public forEachTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		cb: (entityId: EntityID) => void
	): void {
		this._store.forEachTargetMatch(target, include, exclude, anyOf, terms, cb);
	}

	/** QueryResolver implementation, depth-ordered hierarchy match path. */
	public forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		cb: (entityId: EntityID) => void
	): void {
		this._store.forEachHierarchyMatch(
			include,
			exclude,
			anyOf,
			terms,
			denseArchetypes,
			relation,
			maxDepth,
			cb
		);
	}

	public addSystems(
		phase: SchedulePhase,
		...entries: (SystemDescriptor | SystemEntry)[]
	): this {
		this._schedule.addSystems(phase, ...entries);
		return this;
	}

	/**
	 * Add one phase to a loop, and hand back its handle. Setup only, cold path.
	 *
	 * A plugin that owns a slot no longer contends for insertion order inside a
	 * phase the application also writes to. `before` and `after` order the new
	 * phase against the other phases of the same loop, built-in or added.
	 *
	 * The handle belongs to this world, and identity and not name decides which
	 * phase it is, the rule `systemSet` follows.
	 *
	 * @example
	 * const physics = ecs.addPhase("physics", {
	 *   loop: "update",
	 *   after: [SCHEDULE.PRE_UPDATE],
	 *   before: [SCHEDULE.UPDATE]
	 * });
	 * ecs.addSystems(physics, integrate);
	 */
	public addPhase(name: string, config: PhaseConfig): Phase {
		return this._schedule.addPhase(name, config);
	}

	/**
	 * Configure a `SystemSet`, the shared run condition, or its ordering,
	 * every member inherits. Additive and order-independent with respect to
	 * `addSystems`: see `Schedule.configureSet`. Returns `this` to chain.
	 */
	public configureSet(set: SystemSet, config: SystemSetConfig): this {
		this._schedule.configureSet(set, config);
		return this;
	}

	/**
	 * Keep a change tick for each row of `def`, the row grain of change
	 * detection. `cols.ticksRead(def)` and `changed(def).forEachChunk` read it
	 * against `cols.since`, and every write path stamps it: `setField`, `ref`,
	 * a cursor, `markChanged`, and a store into `cols.ticks(def)`. An `onSet`
	 * observer with entity granularity turns it on as well. Costs one word for
	 * each row of every archetype that holds `def`, and one store on each by-id
	 * write. Never turned off. Idempotent. A sparse component keeps one tick
	 * for each entity index instead, read through `ctx.sparseChanged`.
	 */
	public trackRows(def: ComponentHandle | SparseComponentDef): void {
		this._store.trackRows(def);
	}

	/**
	 * Stamp every SAB-backed archetype's live `length` into its SAB
	 * descriptor's `row_count` field. **You usually don't need to call
	 * this directly**, `update()` publishes at tick start and
	 * `SystemContext.flush()` publishes at every phase boundary, so any
	 * WASM scan running inside the schedule sees fresh counts for free.
	 * This is an escape hatch for code that mutates archetype state
	 * outside the system framework and wants to force a republish without
	 * going through `flush()`. No in-repo callers today.
	 *
	 * Cheap: walks the descriptor region once, does no column I/O.
	 */
	public publishRowCounts(): void {
		this._store.publishRowCounts();
	}

	public flush(): void {
		this._ctx.flush();
	}
	// === END STORE PASS-THROUGH BAND ===
}

/** @internal, test seam for the closure walk that `archetype_closure.ts`
 * holds. Exposed so the prewarm tests can exercise the walk without standing
 * up a full Store. */
export const _ecsInternals = {
	computeArchetypeClosure
};
