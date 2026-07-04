/**
 * ecs_sync — the production ECS→UI reactive bridge (#672, the #646 "unlock").
 *
 * Each tick, publish into a `reactiveMap` *only the entities the ECS actually
 * changed* — O(changed) publish work, not O(all). This is the claim that decided
 * #646/ADR-0021 to build the kernel in-house: because we own BOTH the ECS change
 * detection AND the reactive kernel, the bridge can drain exactly what the ECS
 * flagged dirty this tick. A third-party kernel is blind to our change detection,
 * so it must blind-republish every entity every frame (O(all)) and lean on a
 * downstream equality skip. Proven against a mock in `workbench/reactive/`; this
 * wires it to the REAL engine.
 *
 * The API follows the shape every strong prior art converges on (Bevy
 * `ExtractComponent`, WatermelonDB `observeWithColumns`, TanStack `select`, Solid
 * `reconcile`, Reselect): a DECLARATIVE selection of which components feed a row +
 * a CLOSURE that maps the row to its value. Three entry points:
 *   - `syncComponentToMap(def, project)` — one component.
 *   - `syncFieldsToMap(def, [fields])` — sugar: project = pick(fields), with an
 *     auto shallow `eq` (the `observeWithColumns` / `useShallow` model).
 *   - `syncJoinToMap([defs], project)` — a multi-component JOIN. Subscribes change
 *     detection to ALL joined components, so a write to ANY of them republishes
 *     the row. (Reading a second component from a single-component sync would go
 *     STALE — its change isn't subscribed; this is Bevy's `Or<Changed<A>,
 *     Changed<B>>` lesson and why the join is a first-class entry point.)
 *
 * Dirty source: ADR-0013 component observers, NOT a per-frame scan. Per-component
 * grain (`workbench/reactive/bench_ecs_publish_work.ts` measured the crossover):
 *   - **"entity"** (default) — per-entity `onSet` drains the opt-in per-row dirty
 *     list (#531): O(changed) publishes. The right default for UI (most entities
 *     idle per frame). Each publish is a random-access read.
 *   - **"column"** — archetype-granular `onSet` republishes every row of a dirty
 *     archetype via SoA column reads: O(dirty-archetype-rows). For a HIGH-churn
 *     component a sequential column sweep beats per-entity random access, and
 *     `reactiveMap`'s value `eq` still collapses it to O(changed) renders.
 *
 * Entity enable/disable (#577) is bridged as a soft remove/re-add (#677, ADR-0023):
 * `onDisable` deletes the row (a disabled entity leaves the default-query result
 * set, so it leaves the channel — flecs query-monitor / Bevy default-query-filter /
 * RxDB observable-query semantics), `onEnable` republishes it. `seedExisting` seeds
 * enabled members only, so a disabled entity starts correctly absent. The publish is
 * likewise ENABLED-ONLY: the engine pre-filters disabled out of onSet and the seed,
 * but a live `onAdd` fires for a component added to an already-disabled entity (a
 * structural event is enable-agnostic), so each publish guards on `ctx.isDisabled`
 * before writing — completing a (join) membership while disabled must not surface a
 * row the default query excludes (#784). ("Freeze / show-disabled" — Bevy's
 * `Has<Disabled>` — is a future `includeDisabled`-scoped sync that reads the disabled
 * bit, not a mode of this default-scoped channel.)
 *
 * Equality: default `Object.is` (the universal reactive default). A projection
 * returning a FRESH object every tick must pass an `eq` or it wakes every frame
 * (the React `useSyncExternalStore` infinite-loop / zustand `useShallow` footgun);
 * `shallow` is the recommended `eq` for object projections, and `syncFieldsToMap`
 * applies it for you.
 *
 * One tick = one coalesced flush: drive the world with `batchedUpdate` (or wrap
 * your own `world.update` in the kernel's `batch`). onAdd/onRemove fire mid-tick
 * and onSet fires at the tick tail; batching collects every `map.set`/`delete`
 * across both points and flushes the UI effects exactly once. Each sync returns an
 * explicit disposer (the React/MobX/RxJS model) and seeds the map synchronously on
 * registration (`seedExisting`, flecs `yieldExisting`) — the seed is itself
 * batched, so attaching to an already-populated, already-subscribed world is one
 * flush, not one per existing row.
 *
 * Limitations (inherited from the ADR-0013 observer layer; see ADR-0022):
 *   - **High-churn + `syncFieldsToMap` is the worst allocation path.** `syncFieldsToMap`
 *     builds a fresh object per dirty row and `shallow` runs two `Object.keys` per
 *     compare — fine for low-churn, but for a high-churn component (the case you'd
 *     reach for `grain:"column"`) prefer `syncComponentToMap` with a scalar (or
 *     hand-written-`eq`) projection so the hot path allocates nothing.
 *
 * Layering: a plugin on two engine PORTS — the ECS observer API and the reactive
 * kernel — so it lives in `engine-extensions`, never in the engine core (the kernel
 * stays zero-dependency; the ECS never imports the kernel). No third-party
 * dependency, so it sits at its own subpath alongside `solid/`.
 */
import {
	batch,
	reactiveArray,
	reactiveMap,
	reactiveStruct,
	untrack,
	type ReactiveArray,
	type ReactiveMap,
	type StructSetters
} from "../../reactive";
import type {
	ArchetypeView,
	ComponentDef,
	ComponentSchema,
	ECS,
	EntityID,
	ObserverHandle,
	ReadonlyColumn,
	SystemAccessDeclaration,
	SystemContext
} from "../../core/ecs";

/**
 * Shallow (one-level) value equality — the recommended `eq` for object-valued
 * projections. Mirrors zustand `useShallow` / MobX `comparer.shallow`: two objects
 * are equal iff they have the same own keys with `Object.is`-equal values. Restores
 * "equal write wakes nobody" for projections that build a fresh object each tick.
 */
export function shallow(a: object, b: object): boolean {
	if (Object.is(a, b)) return true;
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const ka = Object.keys(ra);
	if (ka.length !== Object.keys(rb).length) return false;
	for (let i = 0; i < ka.length; i++) {
		const k = ka[i];
		if (!Object.prototype.hasOwnProperty.call(rb, k) || !Object.is(ra[k], rb[k])) return false;
	}
	return true;
}

/**
 * A read cursor over one entity's single-component state, handed to a single-
 * component `Projection`. `field` is column-backed under "column" grain
 * (sequential), random-access (`getField`) under "entity" grain.
 *
 * Lifetime: the cursor is a reused, mutable singleton valid ONLY during the
 * synchronous `project` call for the current row. Read what you need and return —
 * never capture `row` (or stash its `field` reads keyed off a later closure): the
 * next row/tick mutates it in place, so a captured cursor reads stale data.
 */
export interface RowReader<S extends ComponentSchema> {
	/** The current entity (the row being projected). */
	readonly eid: EntityID;
	/** Read a field of the synced component for the current row. */
	field<K extends string & keyof S>(name: K): number;
}

/**
 * A read cursor over a JOINED entity (it carries every component in the join), for
 * a `JoinProjection`. `field(def, name)` reads any field of any joined component
 * for the current entity (random-access; the join subscribes to all of them so the
 * read can never go stale).
 *
 * Lifetime: like `RowReader`, a reused mutable singleton valid ONLY during the
 * synchronous `project` call — never capture it; the next dispatch mutates it.
 */
export interface JoinReader<Schemas extends readonly ComponentSchema[] = readonly ComponentSchema[]> {
	/** The current entity (it has all joined components). */
	readonly eid: EntityID;
	/** Read a field of one joined component for the current entity. `def` is
	 * constrained to the join's own component set — reading a def outside the
	 * join is the stale-read footgun the module header warns about (its changes
	 * aren't subscribed), so it's a compile error. */
	field<S extends Schemas[number], K extends string & keyof S>(
		def: ComponentDef<S>,
		name: K
	): number;
}

/** Map one single-component row to the value a UI cell reads. */
export type Projection<S extends ComponentSchema, V> = (row: RowReader<S>) => V;
/** Map one joined entity to the value a UI cell reads. */
export type JoinProjection<
	V,
	Schemas extends readonly ComponentSchema[] = readonly ComponentSchema[]
> = (row: JoinReader<Schemas>) => V;

/** Per-component dirty grain. See the module header for the measured crossover. */
export type SyncGrain = "entity" | "column";

export interface EcsMapSyncOptions<V> {
	/** Dirty grain (default `"entity"`). Use `"column"` for high-churn components. */
	grain?: SyncGrain;
	/**
	 * Value equality for the map's per-key no-op skip (default `Object.is`). Pass
	 * `shallow` for object projections, or a content comparator. A fresh object
	 * every tick under the default reference eq wakes the row every frame.
	 */
	eq?: (a: V, b: V) => boolean;
	/**
	 * Access surface the projection touches, merged over the synced components'
	 * `reads`. `__DEV__` access-checks the observer callbacks exactly like a system.
	 */
	access?: Partial<SystemAccessDeclaration>;
	/**
	 * Replay current matches on registration (default `true`), so a bridge attached
	 * to an already-populated world seeds the map with present state instead of
	 * waking only on the next change. flecs `yieldExisting`.
	 */
	seedExisting?: boolean;
}

export interface EcsMapSync<V> {
	/** The live channel: a reader of key `eid` subscribes to that entity alone. */
	readonly map: ReactiveMap<EntityID, V>;
	/** Unregister the observer(s) and stop publishing. Safe to call more than once. */
	dispose(): void;
}

/**
 * Reader backed by `ctx.getField` — the "entity" grain, and every grain's
 * structural (onAdd) callback. One instance per sync, reused via mutable fields, so
 * neither the per-entity onSet drain nor the structural fire allocates.
 */
class EntityRowReader<S extends ComponentSchema> implements RowReader<S> {
	_ctx!: SystemContext;
	_eid: EntityID = 0 as EntityID;
	constructor(private readonly def: ComponentDef<S>) {}
	get eid(): EntityID {
		return this._eid;
	}
	field<K extends string & keyof S>(name: K): number {
		return this._ctx.getField(this._eid, this.def, name);
	}
}

/**
 * Reader backed by hoisted SoA columns — the "column" grain's per-row sweep. One
 * instance per sync; `bind` resets the per-archetype column cache, then `field`
 * after the first row of that archetype is a Map lookup + array index (near a
 * hoisted local), not the entity→archetype→row indirection of `getField`.
 */
class ColumnRowReader<S extends ComponentSchema> implements RowReader<S> {
	_eid: EntityID = 0 as EntityID;
	_row = 0;
	private cols = new Map<string, ReadonlyColumn>();
	private arch!: ArchetypeView;
	constructor(private readonly def: ComponentDef<S>) {}
	/** Bind to an archetype for one dispatch (drops the previous column cache). */
	bind(arch: ArchetypeView): void {
		this.arch = arch;
		this.cols.clear();
	}
	get eid(): EntityID {
		return this._eid;
	}
	field<K extends string & keyof S>(name: K): number {
		let col = this.cols.get(name);
		if (col === undefined) {
			col = this.arch.getColumnRead(this.def, name);
			this.cols.set(name, col);
		}
		return col[this._row];
	}
}

/** Reader for joins — reads any joined component's field via `getField`. One
 * instance per sync, reused via mutable fields. */
class JoinRowReader implements JoinReader {
	_ctx!: SystemContext;
	_eid: EntityID = 0 as EntityID;
	get eid(): EntityID {
		return this._eid;
	}
	field<S extends ComponentSchema, K extends string & keyof S>(
		def: ComponentDef<S>,
		name: K
	): number {
		return this._ctx.getField(this._eid, def, name);
	}
}

/**
 * Sync ONE component's change detection into a `reactiveMap`, keyed by `EntityID`.
 * A value change publishes the changed rows; a spawn inserts a row and a despawn
 * deletes it. Returns the map + a disposer. Drive with `batchedUpdate(world, dt)`.
 *
 * To read more than one component per row, use `syncJoinToMap` — reading a second
 * component here goes stale (its changes aren't subscribed).
 */
export function syncComponentToMap<S extends ComponentSchema, V>(
	world: ECS,
	def: ComponentDef<S>,
	project: Projection<S, V>,
	opts: EcsMapSyncOptions<V> = {}
): EcsMapSync<V> {
	const map = reactiveMap<EntityID, V>(opts.eq);
	// MERGE the synced def into the caller's reads (don't let an `access.reads`
	// override drop `def` — the projection's `getField(def)` runs under this
	// access declaration and would fail the dev access-check without it).
	const access: Partial<SystemAccessDeclaration> = {
		...opts.access,
		reads: [def as ComponentDef, ...(opts.access?.reads ?? [])]
	};
	const grain: SyncGrain = opts.grain ?? "entity";
	const seed = opts.seedExisting ?? true;

	const er = new EntityRowReader(def);
	const publishEntity = (eid: EntityID, ctx: SystemContext): void => {
		// A disabled entity is absent from the default-query channel (#677 / ADR-0023):
		// it leaves on disable and is republished by onEnable. The engine pre-filters
		// disabled out of onSet and the seed, but a LIVE onAdd fires for a component
		// added to an already-disabled entity (a structural event is enable-agnostic),
		// so it would publish a row the default query excludes — guard here, mirroring
		// the onSet/seed enabled-only filter. onEnable republishes the current value.
		if (ctx.isDisabled(eid)) return;
		er._ctx = ctx;
		er._eid = eid;
		map.set(eid, project(er));
	};

	// Batch registration: `yieldExisting` publishes synchronously. Defensive — the
	// map is created in THIS call, so its one-time seed has no external subscriber to
	// flush today; the batch keeps the seed to one coalesced flush only once a future
	// path seeds into an already-subscribed map (an `into:` option or a re-seed). So
	// there is no isolated flush-count test — that property isn't observable through
	// the current API; the batched seed's CORRECTNESS is covered by the
	// pre-populated-world gate tests (`map.size() === N` on attach).
	let handle!: ObserverHandle;
	batch(() => {
		if (grain === "column") {
			const cr = new ColumnRowReader(def);
			handle = world.observe(def, {
				granularity: "archetype",
				onSet: (arch) => {
					cr.bind(arch);
					const eids = arch.entityIds;
					for (let i = 0; i < arch.entityCount; i++) {
						cr._row = i;
						cr._eid = eids[i] as EntityID;
						map.set(cr._eid, project(cr));
					}
				},
				onAdd: (eid, ctx) => publishEntity(eid, ctx),
				onRemove: (eid) => map.delete(eid),
				// Disable = soft remove from the channel; enable = re-add (#677). The
				// column sweep is bounded by enabled rows, so a disabled row would never
				// refresh — drop it on disable, republish on enable.
				onDisable: (eid) => map.delete(eid),
				onEnable: (eid, ctx) => publishEntity(eid, ctx),
				access,
				yieldExisting: seed
			});
		} else {
			handle = world.observe(def, {
				granularity: "entity",
				onSet: (eid, ctx) => publishEntity(eid, ctx),
				onAdd: (eid, ctx) => publishEntity(eid, ctx),
				onRemove: (eid) => map.delete(eid),
				onDisable: (eid) => map.delete(eid),
				onEnable: (eid, ctx) => publishEntity(eid, ctx),
				access,
				yieldExisting: seed
			});
		}
	});

	return { map, dispose: () => handle.dispose() };
}

/**
 * Sugar over `syncComponentToMap`: project a fixed FIELD LIST into a `{ field:
 * value }` snapshot, with an automatic `shallow` eq so an unchanged row wakes
 * nobody. The declarative-field-list model from WatermelonDB `observeWithColumns` /
 * TanStack `select` — the common "mirror these fields" case without hand-writing
 * the projection + comparator.
 *
 * Allocation note: this builds a fresh object per dirty row and `shallow` does two
 * `Object.keys` per compare — fine for low-churn. For a HIGH-churn component (the
 * case you'd pick `grain:"column"` for), prefer `syncComponentToMap` with a scalar
 * or hand-written-`eq` projection, so the hot path doesn't allocate exactly where
 * the column grain is meant to keep it cheap.
 */
export function syncFieldsToMap<
	S extends ComponentSchema,
	const F extends readonly (string & keyof S)[]
>(
	world: ECS,
	def: ComponentDef<S>,
	fields: F,
	opts: Omit<EcsMapSyncOptions<{ [K in F[number]]: number }>, "eq"> = {}
): EcsMapSync<{ [K in F[number]]: number }> {
	type V = { [K in F[number]]: number };
	const project: Projection<S, V> = (row) => {
		const out: Record<string, number> = {};
		for (let i = 0; i < fields.length; i++) out[fields[i]] = row.field(fields[i]);
		return out as V;
	};
	return syncComponentToMap(world, def, project, { ...opts, eq: shallow });
}

/**
 * Sync a multi-component JOIN into a `reactiveMap`. An entity is a member iff it
 * has EVERY component in `defs`; the projection reads any of them via
 * `row.field(def, name)`. Change detection subscribes to ALL joined components, so
 * a write to ANY of them republishes the row — the join can never go stale (the
 * bug a single-component sync + manual secondary read would have). Spawns/removes
 * of any joined component re-evaluate membership.
 *
 * Entity grain only: a join spans archetypes, so there is no single column to
 * sweep. Drive with `batchedUpdate(world, dt)`.
 */
export function syncJoinToMap<Schemas extends readonly ComponentSchema[], V>(
	world: ECS,
	defs: readonly [...{ [I in keyof Schemas]: ComponentDef<Schemas[I]> }],
	project: JoinProjection<V, Schemas>,
	// No `NoInfer` on `V` here: with a context-sensitive `project` callback it
	// fixes `V` to `unknown` before the second inference pass reads the
	// projection's return type (TS 5.6), collapsing every typed call site.
	opts: Omit<EcsMapSyncOptions<V>, "grain"> = {}
): EcsMapSync<V> {
	// Erase the per-def schemas once — internal plumbing (observers, access
	// declarations, membership checks) is schema-agnostic; the tuple typing
	// above exists to pin the projection's `JoinReader` to the joined set.
	const defList: readonly ComponentDef[] = defs;
	const map = reactiveMap<EntityID, V>(opts.eq);
	// MERGE all joined defs into the caller's reads (don't let an `access.reads`
	// override drop them — the projection reads every joined component).
	const access: Partial<SystemAccessDeclaration> = {
		...opts.access,
		reads: [...defList, ...(opts.access?.reads ?? [])]
	};
	const seed = opts.seedExisting ?? true;

	const jr = new JoinRowReader();
	const matches = (ctx: SystemContext, eid: EntityID): boolean => {
		for (let i = 0; i < defList.length; i++) if (!ctx.hasComponent(eid, defList[i])) return false;
		return true;
	};
	// A value change or a component-add re-evaluates membership and republishes.
	const publishIfMember = (eid: EntityID, ctx: SystemContext): void => {
		// Disabled → absent from the default-query channel (#677 / ADR-0023). A live
		// onAdd fires for a joined component added to an already-disabled entity (the
		// structural event is enable-agnostic), so completing the join while disabled
		// must NOT publish a row the `query(...defs)` default excludes — guard here,
		// mirroring the single-component publish. onEnable re-evaluates and republishes.
		if (ctx.isDisabled(eid)) return;
		if (!matches(ctx, eid)) return;
		jr._ctx = ctx;
		jr._eid = eid;
		map.set(eid, project(jr));
	};
	// Removing ANY required component (or destroying the entity — eid then dead, so
	// never read it) breaks the join → drop the row. Redundant removes are no-ops.
	const dropRow = (eid: EntityID): void => {
		map.delete(eid);
	};

	// Batch the per-def registration loop: each observer's `yieldExisting` seeds
	// synchronously, so coalesce all defs' seeds into one flush. Defensive for the
	// same reason as syncComponentToMap (the map has no seed-time subscriber today).
	let handles!: ObserverHandle[];
	batch(() => {
		handles = defList.map((d) =>
			world.observe(d, {
				granularity: "entity",
				onSet: publishIfMember,
				onAdd: publishIfMember,
				onRemove: dropRow,
				// Disabling any joined component soft-removes the entity from the
				// channel; enabling re-evaluates membership and republishes (#677). A
				// disable fires once per carried joined component — `dropRow` is
				// idempotent, and `publishIfMember` re-checks the full join.
				onDisable: dropRow,
				onEnable: publishIfMember,
				access,
				yieldExisting: seed
			})
		);
	});

	return {
		map,
		dispose: () => {
			for (let i = 0; i < handles.length; i++) handles[i].dispose();
		}
	};
}

export interface SingletonStructSync<V extends object> {
	/** The live per-field channel: reading `struct.field` in a tracked scope
	 * subscribes to that field alone (pair with `fromKernelStruct` to render). */
	readonly struct: V;
	/** Unregister the observer and stop publishing. Safe to call more than once. */
	dispose(): void;
}

export interface SingletonSyncOptions<V extends object = Record<string, number>> {
	/**
	 * Access surface the publish touches, merged over the synced def's read.
	 * `__DEV__` access-checks the observer callbacks exactly like a system.
	 */
	access?: Partial<SystemAccessDeclaration>;
	/** Replay current state on registration (default `true`). flecs `yieldExisting`. */
	seedExisting?: boolean;
	/**
	 * Drive a PRE-CREATED `reactiveStruct` (its `[proxy, set]` pair) instead of
	 * creating a fresh one. Lets the consumer keep the struct at module scope as a
	 * stable "channel" with initial values present before the sync attaches (the
	 * client UI seam: panels import the eager proxy; the sync, set up at world build,
	 * republishes into it via the observer). The seed (`yieldExisting`) overwrites
	 * the eager initials with the entity's current values on registration.
	 */
	into?: readonly [V, StructSetters<V>];
}

/**
 * Sync ONE singleton entity's single-component state into a `reactiveStruct`,
 * keyless — the singleton/resource shape (ADR-0024). This is how heterogeneous
 * ephemeral UI state (net status + latency, FPS/mem, wave timer, hovered hex) joins
 * the same reactive view as per-entity components: model it as components on a
 * reserved singleton entity (the flecs / Unity-DOTS "singleton-as-entity" model)
 * and read it through per-field channels — NOT a separate reactive-resource
 * subsystem. Resources stay non-reactive internal singletons.
 *
 * It reuses the entity-grain ADR-0013 component observer verbatim, filtered to the
 * one target eid: an `onSet` (or seed `onAdd`) republishes the entity's field values
 * into the struct via per-field setters. The per-field `Object.is` eq means an
 * unchanged field writes nothing — "equal write → 0 renders" — and per-field signals
 * give "1-of-N FIELD → 1 re-render"; drive with `batchedUpdate` for "one tick → one
 * commit". Because the component change-detection fires on `ctx.setField`, the
 * in-place write pattern that defeats a `setResource`-keyed resource observer is
 * handled for free.
 *
 * `fields` is explicit: a `ComponentDef` is a branded number at runtime (its schema
 * is a phantom type), so the field names must be passed — same contract as
 * `syncFieldsToMap`. Project a subset to channel only what the UI reads.
 *
 * A `reactiveStruct` has a fixed field set and no `delete`, so the map adapter's
 * delete-on-disable (#677 / ADR-0023) has no struct analog: `onRemove`/`onDisable`
 * **reset the fields to the channel's declared initial values** (`onSet` skips
 * disabled entities), `onEnable` republishes. The defaults are the channel's own
 * initials — the eager `into` struct's declared values (e.g. `NetStats.latency = -1`),
 * or the zeros of a freshly-created one — captured (untracked) at registration, NOT a
 * blind 0. A singleton is rarely despawned; this keeps the channel well-defined if it is.
 */
export function syncSingletonToStruct<
	S extends ComponentSchema,
	const F extends readonly (string & keyof S)[]
>(
	world: ECS,
	def: ComponentDef<S>,
	eid: EntityID,
	fields: F,
	opts: SingletonSyncOptions<{ [K in F[number]]: number }> = {}
): SingletonStructSync<{ [K in F[number]]: number }> {
	type V = { [K in F[number]]: number };

	// Use the caller's pre-created struct (the module-scope channel) when given;
	// otherwise create one seeded with zeros — the registration seed (yieldExisting
	// → onAdd) immediately overwrites either with the entity's current values.
	const initial = {} as Record<string, number>;
	for (let i = 0; i < fields.length; i++) initial[fields[i]] = 0;
	const [struct, set] = opts.into ?? reactiveStruct<V>(initial as V);

	// The reset target (onRemove / onDisable) = the channel's DECLARED initials,
	// captured here before the observer attaches. Read untracked off the proxy (no
	// reactive owner at registration anyway) so a fresh struct gives the zeros above
	// and an eager `into` channel gives its real defaults (e.g. NetStats latency = -1),
	// instead of a blind 0 that would misrepresent the channel's empty state.
	const defaults = untrack(() => fields.map((f) => struct[f]));

	// MERGE the synced def into the caller's reads (the publish's `getField(def)`
	// runs under this access declaration; an override that dropped `def` would fail
	// the dev access-check) — same merge as the map entry points.
	const access: Partial<SystemAccessDeclaration> = {
		...opts.access,
		reads: [def as ComponentDef, ...(opts.access?.reads ?? [])]
	};
	const seed = opts.seedExisting ?? true;

	const publish = (ctx: SystemContext): void => {
		for (let i = 0; i < fields.length; i++) set[fields[i]](ctx.getField(eid, def, fields[i]));
	};
	const reset = (): void => {
		for (let i = 0; i < fields.length; i++) set[fields[i]](defaults[i]);
	};

	let handle!: ObserverHandle;
	batch(() => {
		handle = world.observe(def, {
			granularity: "entity",
			onSet: (e, ctx) => {
				if (e === eid) publish(ctx);
			},
			onAdd: (e, ctx) => {
				// Skip an add to an already-disabled singleton (a structural event is
				// enable-agnostic): it must stay at the channel's defaults until onEnable
				// republishes, mirroring the map/join publish guard (#677 / ADR-0023).
				if (e === eid && !ctx.isDisabled(eid)) publish(ctx);
			},
			onRemove: (e) => {
				if (e === eid) reset();
			},
			onDisable: (e) => {
				if (e === eid) reset();
			},
			onEnable: (e, ctx) => {
				if (e === eid) publish(ctx);
			},
			access,
			yieldExisting: seed
		});
	});

	return { struct, dispose: () => handle.dispose() };
}

export interface SingletonArraySync<T> {
	/** The live ordered channel: a reader of slot `i` subscribes to that slot alone. */
	readonly array: ReactiveArray<T>;
	/** Unregister the observer and stop publishing. Safe to call more than once. */
	dispose(): void;
}

export interface SingletonArraySyncOptions<T> {
	access?: Partial<SystemAccessDeclaration>;
	seedExisting?: boolean;
	/** Drive a PRE-CREATED `reactiveArray` (the module-scope channel) instead of a fresh one. */
	into?: ReactiveArray<T>;
	/** Per-slot equality for the array's no-op skip (default `Object.is`). */
	eq?: (a: T, b: T) => boolean;
}

/**
 * Sync ONE singleton entity's component into a `reactiveArray`, one slot per field
 * in `fields` order (#685 / ADR-0024) — the ORDERED sibling of `syncSingletonToStruct`,
 * for positional UI state (the army slots). On every change to the component it
 * `reconcile`s the array from the field values: a slot whose value is unchanged keeps
 * its reference (structural sharing), only changed slots wake. `onRemove`/`onDisable`
 * reset the slots to the channel's DECLARED initial slots (a reactiveArray has no row
 * delete) — captured (untracked) at registration, so the army channel resets to its
 * empty sentinel (`EMPTY_SLOT`), NOT a blind 0 that would read as unit type 0.
 *
 * `fields` is explicit (a `ComponentDef` is a branded number at runtime). Pair with
 * `@oasys/oecs/solid`'s `fromKernelArray` + a Solid `<Index>`.
 */
export function syncSingletonToArray<S extends ComponentSchema>(
	world: ECS,
	def: ComponentDef<S>,
	eid: EntityID,
	fields: readonly (string & keyof S)[],
	opts: SingletonArraySyncOptions<number> = {}
): SingletonArraySync<number> {
	const array =
		opts.into ?? reactiveArray<number>(new Array<number>(fields.length).fill(0), opts.eq);
	// The reset target (onRemove / onDisable) = the channel's DECLARED initial slots,
	// snapshotted untracked before the observer attaches. For the army's eager channel
	// that is `EMPTY_SLOT` per slot, so a remove/disable resets to "all empty" rather
	// than unit type 0; a fresh array gives the zeros above.
	const defaults = untrack(() => array.snapshot());
	// A caller-supplied `into` MUST carry exactly one slot per field. `publish`
	// reconciles to a `fields.length` array, but `reset` reconciles to this
	// `into`-sized `defaults` snapshot — so a length mismatch oscillates the array's
	// length on every enable↔disable cycle (waking/absenting rows spuriously). Reject
	// the misconfiguration at setup rather than let it flap silently. #722
	if (opts.into !== undefined && defaults.length !== fields.length) {
		throw new Error(
			`syncSingletonToArray: into.length (${defaults.length}) must equal fields.length (${fields.length})`
		);
	}
	const access: Partial<SystemAccessDeclaration> = {
		...opts.access,
		reads: [def as ComponentDef, ...(opts.access?.reads ?? [])]
	};
	const seed = opts.seedExisting ?? true;

	const next = new Array<number>(fields.length);
	const publish = (ctx: SystemContext): void => {
		for (let i = 0; i < fields.length; i++) next[i] = ctx.getField(eid, def, fields[i]);
		array.reconcile(next);
	};
	const reset = (): void => array.reconcile(defaults);

	let handle!: ObserverHandle;
	batch(() => {
		handle = world.observe(def, {
			granularity: "entity",
			onSet: (e, ctx) => {
				if (e === eid) publish(ctx);
			},
			onAdd: (e, ctx) => {
				// Skip an add to an already-disabled singleton (a structural event is
				// enable-agnostic): it must stay at the channel's defaults until onEnable
				// republishes, mirroring the map/join publish guard (#677 / ADR-0023).
				if (e === eid && !ctx.isDisabled(eid)) publish(ctx);
			},
			onRemove: (e) => {
				if (e === eid) reset();
			},
			onDisable: (e) => {
				if (e === eid) reset();
			},
			onEnable: (e, ctx) => {
				if (e === eid) publish(ctx);
			},
			access,
			yieldExisting: seed
		});
	});

	return { array, dispose: () => handle.dispose() };
}

/**
 * Advance the world one tick with every bridge publish coalesced into a single UI
 * flush. onAdd/onRemove fire mid-tick at flush boundaries and onSet fires at the
 * tick tail; wrapping the whole update in `batch` defers the effect flush until the
 * tick completes, so a frame that touched K entities (across any number of syncs on
 * this world) wakes its readers once, not once per observer dispatch point.
 * Equivalent to `batch(() => world.update(dt))`.
 */
export function batchedUpdate(world: ECS, dt: number): void {
	batch(() => world.update(dt));
}
