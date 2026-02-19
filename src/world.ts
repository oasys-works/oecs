/***
 *
 * World - Unified ECS facade
 *
 * Composes Store + Schedule + SystemContext into a single entry point
 * that owns the full ECS lifecycle. External code creates a World,
 * registers components/systems, calls startup(), then update(dt)
 * each frame.
 *
 * Systems receive a SystemContext (not the World) — the World is not
 * exposed inside system functions.
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
import type { ComponentDef, ComponentFields, FieldValues } from "./component";
import {
  as_system_id,
  type SystemConfig,
  type SystemDescriptor,
} from "./system";
import type { SystemEntry } from "./schedule";
import { BitSet } from "type_primitives";
import { bucket_push } from "./utils/arrays";

const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

//=========================================================
// World
//=========================================================

export class World implements QueryResolver {
  private readonly store: Store;
  private readonly schedule: Schedule;
  private readonly ctx: SystemContext;

  private systems: Set<SystemDescriptor> = new Set();
  private next_system_id = 0;

  private query_cache: Map<number, QueryCacheEntry[]> = new Map();
  private scratch_mask: BitSet = new BitSet();

  constructor() {
    this.store = new Store();
    this.schedule = new Schedule();
    this.ctx = new SystemContext(this.store);
  }

  //=========================================================
  // Component registration
  //=========================================================

  register_component<F extends readonly string[]>(fields: F): ComponentDef<F> {
    return this.store.register_component(fields);
  }

  register_tag(): ComponentDef<readonly []> {
    return this.store.register_component([] as const);
  }

  //=========================================================
  // Entity lifecycle
  //=========================================================

  create_entity(): EntityID {
    return this.store.create_entity();
  }

  /** Deferred destroy — entity stays alive until the next flush. */
  destroy_entity(id: EntityID): void {
    this.store.destroy_entity_deferred(id);
  }

  is_alive(id: EntityID): boolean {
    return this.store.is_alive(id);
  }

  get entity_count(): number {
    return this.store.entity_count;
  }

  //=========================================================
  // Component operations (immediate, for setup/spawning)
  //=========================================================

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
  ): void {
    this.store.remove_component(entity_id, def);
  }

  has_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): boolean {
    return this.store.has_component(entity_id, def);
  }

  //=========================================================
  // Query (setup-time)
  //=========================================================

  query<T extends ComponentDef<ComponentFields>[]>(...defs: T): Query<T> {
    const mask = this.scratch_mask;
    mask._words.fill(0);
    for (let i = 0; i < defs.length; i++) {
      mask.set(defs[i] as unknown as number);
    }
    return this._resolve_query(mask.copy(), null, null, defs);
  }

  //=========================================================
  // QueryResolver implementation
  //=========================================================

  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef<ComponentFields>[],
  ): Query<any> {
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

  //=========================================================
  // System registration
  //=========================================================

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
  ): void {
    this.schedule.add_systems(label, ...entries);
  }

  remove_system(system: SystemDescriptor): void {
    this.schedule.remove_system(system);
    system.on_removed?.();
    this.systems.delete(system);
  }

  get system_count(): number {
    return this.systems.size;
  }

  //=========================================================
  // Execution
  //=========================================================

  /** Initialize all systems and run startup phases. */
  startup(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.on_added?.(this.store);
    }
    this.schedule.run_startup(this.ctx);
  }

  /** Run update phases for one frame. */
  update(delta_time: number): void {
    this.schedule.run_update(this.ctx, delta_time);
  }

  /** Flush all deferred changes: structural first, then destructions. */
  flush(): void {
    this.ctx.flush();
  }

  //=========================================================
  // Cleanup
  //=========================================================

  /** Dispose all systems and clear the schedule. */
  dispose(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.dispose?.();
      descriptor.on_removed?.();
    }
    this.systems.clear();
    this.schedule.clear();
  }
}
