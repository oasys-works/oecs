/***
 * World — Public ECS facade.
 *
 * Single entry point that composes Store (data), Schedule (execution),
 * and SystemContext (system interface) into a unified API. External code
 * interacts exclusively through World; systems receive a SystemContext
 * instead, preventing direct access to internals.
 *
 * Architecture: Facade pattern over an archetype-based ECS.
 * - Entities are generational IDs (no object allocation)
 * - Components are plain number[] columns grouped by archetype
 * - Queries are cached and live-updated as new archetypes appear
 * - Systems are plain functions scheduled across 6 lifecycle phases
 *
 * Usage:
 *
 *   const world = new World();
 *
 *   const Pos = world.register_component(["x", "y"] as const);
 *   const Vel = world.register_component(["vx", "vy"] as const);
 *   const IsEnemy = world.register_tag();
 *
 *   const e = world.create_entity();
 *   world.add_component(e, Pos, { x: 0, y: 0 });
 *   world.add_component(e, Vel, { vx: 1, vy: 2 });
 *   world.add_component(e, IsEnemy);
 *
 *   const moveSys = world.register_system(
 *     (q, _ctx, dt) => {
 *       q.each((pos, vel, n) => {
 *         for (let i = 0; i < n; i++) {
 *           pos.x[i] += vel.vx[i] * dt;
 *           pos.y[i] += vel.vy[i] * dt;
 *         }
 *       });
 *     },
 *     (qb) => qb.every(Pos, Vel),
 *   );
 *
 *   world.add_systems(SCHEDULE.UPDATE, moveSys);
 *   world.startup();
 *
 *   // game loop
 *   world.update(1 / 60);
 *
 ***/

import { Store } from "./store";
import { Schedule, type SCHEDULE } from "./schedule";
import {
  SystemContext,
  Query,
  QueryBuilder,
  type QueryResolver,
  type QueryCacheEntry,
} from "./query";
import type { EntityID } from "./entity";
import type { ComponentDef, ComponentID, ComponentFields, FieldValues } from "./component";
import type { EventDef } from "./event";
import {
  as_system_id,
  type SystemConfig,
  type SystemDescriptor,
} from "./system";
import type { SystemEntry } from "./schedule";
import { BitSet } from "type_primitives";
import { bucket_push } from "./utils/arrays";

const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

export class World implements QueryResolver {
  private readonly store: Store;
  private readonly schedule: Schedule;
  private readonly ctx: SystemContext;

  private systems: Set<SystemDescriptor> = new Set();
  private next_system_id = 0;

  // Query deduplication: hash(include, exclude, any_of) → bucket of cache entries.
  // Multiple queries can share the same hash (collision), so each bucket is an array.
  private query_cache: Map<number, QueryCacheEntry[]> = new Map();
  // Reusable BitSet for building query masks — avoids allocation per query() call
  private scratch_mask: BitSet = new BitSet();

  constructor() {
    this.store = new Store();
    this.schedule = new Schedule();
    this.ctx = new SystemContext(this.store);
  }

  register_component<F extends readonly string[]>(fields: F): ComponentDef<F> {
    return this.store.register_component(fields);
  }

  register_tag(): ComponentDef<readonly []> {
    return this.store.register_component([] as const);
  }

  register_event<F extends readonly string[]>(fields: F): EventDef<F> {
    return this.store.register_event(fields);
  }

  register_signal(): EventDef<readonly []> {
    return this.store.register_event([] as const);
  }

  create_entity(): EntityID {
    return this.store.create_entity();
  }

  destroy_entity(id: EntityID): void {
    this.store.destroy_entity_deferred(id);
  }

  is_alive(id: EntityID): boolean {
    return this.store.is_alive(id);
  }

  get entity_count(): number {
    return this.store.entity_count;
  }

  add_component(entity_id: EntityID, def: ComponentDef<readonly []>): void;
  add_component<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): void;
  add_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
    values?: Record<string, number>,
  ): void {
    this.store.add_component(entity_id, def, values ?? EMPTY_VALUES);
  }

  add_components(
    entity_id: EntityID,
    entries: {
      def: ComponentDef<ComponentFields>;
      values?: Record<string, number>;
    }[],
  ): void {
    this.store.add_components(entity_id, entries);
  }

  remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): this {
    this.store.remove_component(entity_id, def);
    return this;
  }

  remove_components(
    entity_id: EntityID,
    ...defs: ComponentDef<ComponentFields>[]
  ): void {
    this.store.remove_components(entity_id, defs);
  }

  has_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): boolean {
    return this.store.has_component(entity_id, def);
  }

  get_field<F extends ComponentFields>(
    def: ComponentDef<F>,
    entity_id: EntityID,
    field: F[number],
  ): number {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    return arch.read_field(row, def as unknown as ComponentID, field);
  }

  emit(def: EventDef<readonly []>): void;
  emit<F extends ComponentFields>(
    def: EventDef<F>,
    values: FieldValues<F>,
  ): void;
  emit(
    def: EventDef<ComponentFields>,
    values?: Record<string, number>,
  ): void {
    if (values === undefined) {
      this.store.emit_signal(def as EventDef<readonly []>);
    } else {
      this.store.emit_event(def, values);
    }
  }

  query<T extends ComponentDef<ComponentFields>[]>(...defs: T): Query<T> {
    // Reuse scratch_mask to avoid allocating a new BitSet per query call.
    // Zero it out, set bits, then copy for the cache key.
    const mask = this.scratch_mask;
    mask._words.fill(0);
    for (let i = 0; i < defs.length; i++) {
      mask.set(defs[i] as unknown as number);
    }
    return this._resolve_query(mask.copy(), null, null, defs);
  }

  /** QueryResolver implementation — creates or retrieves a cached Query. */
  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef<ComponentFields>[],
  ): Query<any> {
    // Combine three hashes into one cache key using xor with golden-ratio
    // multipliers to reduce collision probability between masks
    const inc_hash = include.hash();
    const exc_hash = exclude ? exclude.hash() : 0;
    const any_hash = any_of ? any_of.hash() : 0;
    const key =
      (inc_hash ^
        Math.imul(exc_hash, 0x9e3779b9) ^
        Math.imul(any_hash, 0x517cc1b7)) |
      0;

    const cached = this._find_cached(key, include, exclude, any_of);
    if (cached !== undefined) return cached.query;

    // Store.register_query returns a live Archetype[] that the Store will
    // push new matching archetypes into as they are created
    const result = this.store.register_query(
      include,
      exclude ?? undefined,
      any_of ?? undefined,
    );
    const q = new Query(
      result,
      defs as ComponentDef<ComponentFields>[],
      this,
      include.copy(),
      exclude?.copy() ?? null,
      any_of?.copy() ?? null,
    );
    bucket_push(this.query_cache, key, {
      include_mask: include.copy(),
      exclude_mask: exclude?.copy() ?? null,
      any_of_mask: any_of?.copy() ?? null,
      query: q,
    });
    return q;
  }

  private _find_cached(
    key: number,
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
  ): QueryCacheEntry | undefined {
    const bucket = this.query_cache.get(key);
    if (!bucket) return undefined;
    // Linear scan within the bucket — buckets are typically 1-2 entries
    for (let i = 0; i < bucket.length; i++) {
      const e = bucket[i];
      if (!e.include_mask.equals(include)) continue;
      const exc_ok =
        exclude === null
          ? e.exclude_mask === null
          : e.exclude_mask !== null && e.exclude_mask.equals(exclude);
      if (!exc_ok) continue;
      const any_ok =
        any_of === null
          ? e.any_of_mask === null
          : e.any_of_mask !== null && e.any_of_mask.equals(any_of);
      if (!any_ok) continue;
      return e;
    }
    return undefined;
  }

  /**
   * Register a system with a typed query.
   *
   *   world.register_system(
   *     (q, ctx, dt) => q.each((pos, vel, n) => { ... }),
   *     (qb) => qb.every(Pos, Vel),
   *   );
   *
   * Or with a raw config for systems that don't need a query:
   *
   *   world.register_system({ fn(ctx, dt) { ... } });
   */
  register_system<Defs extends readonly ComponentDef<ComponentFields>[]>(
    fn: (q: Query<Defs>, ctx: SystemContext, dt: number) => void,
    query_fn: (qb: QueryBuilder) => Query<Defs>,
  ): SystemDescriptor;
  register_system(config: SystemConfig): SystemDescriptor;
  register_system(
    fn_or_config:
      | ((q: Query<any>, ctx: SystemContext, dt: number) => void)
      | SystemConfig,
    query_fn?: (qb: QueryBuilder) => Query<any>,
  ): SystemDescriptor {
    let config: SystemConfig;

    if (typeof fn_or_config === "function") {
      // Resolve the query once at registration time, then close over it.
      // The system's fn(ctx, dt) wrapper captures the resolved query and
      // ctx so the schedule only needs to call fn(ctx, dt) each frame.
      const q = query_fn!(new QueryBuilder(this));
      const ctx = this.ctx;
      config = { fn: (_ctx, dt) => fn_or_config(q, ctx, dt) };
    } else {
      config = fn_or_config as SystemConfig;
    }

    const id = as_system_id(this.next_system_id++);
    const descriptor: SystemDescriptor = Object.freeze(
      Object.assign({ id }, config),
    );
    this.systems.add(descriptor);
    return descriptor;
  }

  add_systems(
    label: SCHEDULE,
    ...entries: (SystemDescriptor | SystemEntry)[]
  ): this {
    this.schedule.add_systems(label, ...entries);
    return this;
  }

  remove_system(system: SystemDescriptor): void {
    this.schedule.remove_system(system);
    system.on_removed?.();
    this.systems.delete(system);
  }

  get system_count(): number {
    return this.systems.size;
  }

  startup(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.on_added?.(this.store);
    }
    this.schedule.run_startup(this.ctx);
  }

  update(delta_time: number): void {
    this.store.clear_events();
    this.schedule.run_update(this.ctx, delta_time);
  }

  flush(): void {
    this.ctx.flush();
  }

  dispose(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.dispose?.();
      descriptor.on_removed?.();
    }
    this.systems.clear();
    this.schedule.clear();
  }
}
