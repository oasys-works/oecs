/***
 * Query, QueryBuilder, SystemContext — System-facing ECS interface.
 *
 * Query<Defs> is a live, cached view over all archetypes matching a
 * component mask. It supports typed batch iteration via each(), which
 * calls a function once per archetype with column groups and entity count
 * (not once per entity — the system loops over the count itself).
 *
 * QueryBuilder is the entry point for creating queries inside
 * register_system(fn, qb => qb.every(Pos, Vel)).
 *
 * SystemContext wraps Store for use inside system functions, exposing
 * only deferred operations (add/remove component, destroy entity) that
 * buffer changes until the phase flush. This prevents iterator
 * invalidation during system execution.
 *
 * Usage (inside a system):
 *
 *   q.each((pos, vel, n) => {
 *     for (let i = 0; i < n; i++) {
 *       pos.x[i] += vel.vx[i] * dt;
 *       pos.y[i] += vel.vy[i] * dt;
 *     }
 *   });
 *
 * Queries compose via chaining:
 *
 *   q.and(Health)          — extend required components
 *   q.not(Dead)            — exclude archetypes with Dead
 *   q.or(Poison, Fire)     — require at least one of these
 *
 ***/

import type { Store } from "./store";
import type { Archetype } from "./archetype";
import type { EntityID } from "./entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentFields,
  FieldValues,
  ColumnsForSchema,
} from "./component";
import type { EventDef, EventReader } from "./event";
import { BitSet } from "type_primitives";

const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

// Maps a tuple of ComponentDefs to a tuple of their column-group records.
// e.g. [ComponentDef<["x","y"]>, ComponentDef<["vx","vy"]>]
//    → [{ x: number[], y: number[] }, { vx: number[], vy: number[] }]
type DefsToColumns<Defs extends readonly ComponentDef<ComponentFields>[]> = {
  [K in keyof Defs]: ColumnsForSchema<
    Defs[K] extends ComponentDef<infer F> ? F : never
  >;
};

// The callback signature for each(): column groups for each def, then entity count.
// e.g. (pos: {x: number[], y: number[]}, vel: {vx: number[], vy: number[]}, count: number) => void
type EachFn<Defs extends readonly ComponentDef<ComponentFields>[]> = (
  ...args: [...DefsToColumns<Defs>, number]
) => void;

export interface QueryCacheEntry {
  include_mask: BitSet;
  exclude_mask: BitSet | null;
  any_of_mask: BitSet | null;
  query: Query<any>;
}

export interface QueryResolver {
  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef<ComponentFields>[],
  ): Query<any>;
}

export class Query<Defs extends readonly ComponentDef<ComponentFields>[]> {
  private readonly _archetypes: Archetype[];
  private readonly _defs: Defs;
  readonly _resolver: QueryResolver;
  readonly _include: BitSet;
  readonly _exclude: BitSet | null;
  readonly _any_of: BitSet | null;
  // Pre-allocated args buffer for each() — avoids allocating a new array per
  // archetype. Holds [columnGroup0, columnGroup1, ..., entityCount].
  private readonly _args_buf: unknown[];

  constructor(
    archetypes: Archetype[],
    defs: Defs,
    resolver: QueryResolver,
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
  ) {
    this._archetypes = archetypes;
    this._defs = defs;
    this._resolver = resolver;
    this._include = include;
    this._exclude = exclude;
    this._any_of = any_of;
    this._args_buf = new Array(defs.length + 1);
  }

  /** Number of matching archetypes (including empty ones). */
  get length(): number {
    return this._archetypes.length;
  }

  /** Total entity count across all matching archetypes. */
  count(): number {
    const archs = this._archetypes;
    let total = 0;
    for (let i = 0; i < archs.length; i++) total += archs[i].entity_count;
    return total;
  }
  get archetypes(): readonly Archetype[] {
    return this._archetypes;
  }
  /** Iterate non-empty archetypes. Skips archetypes with zero entities. */
  *[Symbol.iterator](): Iterator<Archetype> {
    const archs = this._archetypes;
    for (let i = 0; i < archs.length; i++) {
      if (archs[i].entity_count > 0) yield archs[i];
    }
  }

  /**
   * Typed per-archetype iteration. Calls fn once per non-empty archetype
   * with column groups for each queried component, plus the entity count.
   * The system is responsible for the inner loop over entities.
   */
  each(fn: EachFn<Defs>): void {
    const archs = this._archetypes;
    const defs = this._defs;
    const buf = this._args_buf;
    for (let ai = 0; ai < archs.length; ai++) {
      const arch = archs[ai];
      const count = arch.entity_count;
      if (count === 0) continue;
      // Fill the pre-allocated buffer with column groups for this archetype
      for (let di = 0; di < defs.length; di++) {
        buf[di] = arch.get_column_group(defs[di]);
      }
      buf[defs.length] = count;
      // Use apply to spread the buffer as individual arguments
      (fn as (...a: unknown[]) => void).apply(null, buf);
    }
  }

  /** Extend required component set. Returns a new (cached) Query. */
  and<D extends ComponentDef<ComponentFields>[]>(
    ...comps: D
  ): Query<[...Defs, ...D]> {
    const new_include = this._include.copy();
    const new_defs = this._defs.slice() as ComponentDef<ComponentFields>[];
    for (let i = 0; i < comps.length; i++) {
      if (!new_include.has(comps[i] as number)) {
        new_include.set(comps[i] as number);
        new_defs.push(comps[i]);
      }
    }
    return this._resolver._resolve_query(
      new_include,
      this._exclude,
      this._any_of,
      new_defs,
    );
  }

  /** Exclude archetypes that have any of these components. */
  not(...comps: ComponentDef<ComponentFields>[]): Query<Defs> {
    const new_exclude = this._exclude ? this._exclude.copy() : new BitSet();
    for (let i = 0; i < comps.length; i++) new_exclude.set(comps[i] as number);
    return this._resolver._resolve_query(
      this._include,
      new_exclude,
      this._any_of,
      this._defs,
    ) as Query<Defs>;
  }

  /** Require at least one of these components. */
  or(...comps: ComponentDef<ComponentFields>[]): Query<Defs> {
    const new_any_of = this._any_of ? this._any_of.copy() : new BitSet();
    for (let i = 0; i < comps.length; i++) new_any_of.set(comps[i] as number);
    return this._resolver._resolve_query(
      this._include,
      this._exclude,
      new_any_of,
      this._defs,
    ) as Query<Defs>;
  }
}

export class QueryBuilder {
  constructor(private readonly _resolver: QueryResolver) {}

  every<T extends ComponentDef<ComponentFields>[]>(...defs: T): Query<T> {
    const mask = new BitSet();
    for (let i = 0; i < defs.length; i++) mask.set(defs[i] as number);
    return this._resolver._resolve_query(mask, null, null, defs);
  }
}

export class SystemContext {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  create_entity(): EntityID {
    return this.store.create_entity();
  }

  get_field<F extends ComponentFields>(
    def: ComponentDef<F>,
    entity_id: EntityID,
    field: F[number],
  ): number {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    return arch.read_field(row, def as ComponentID, field);
  }

  set_field<F extends ComponentFields>(
    def: ComponentDef<F>,
    entity_id: EntityID,
    field: F[number],
    value: number,
  ): void {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    const col = arch.get_column(def, field);
    col[row] = value;
  }

  /** Buffer an entity for deferred destruction (applied at phase flush). */
  destroy_entity(id: EntityID): this {
    this.store.destroy_entity_deferred(id);
    return this;
  }

  flush_destroyed(): void {
    this.store.flush_destroyed();
  }

  add_component(entity_id: EntityID, def: ComponentDef<readonly []>): this;
  add_component<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): this;
  add_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
    values?: Record<string, number>,
  ): this {
    this.store.add_component_deferred(entity_id, def, values ?? EMPTY_VALUES);
    return this;
  }

  remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): this {
    this.store.remove_component_deferred(entity_id, def);
    return this;
  }

  /** Flush all deferred changes: structural (add/remove) first, then destructions. */
  flush(): void {
    this.store.flush_structural();
    this.store.flush_destroyed();
  }

  // =======================================================
  // Events
  // =======================================================

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

  read<F extends ComponentFields>(def: EventDef<F>): EventReader<F> {
    return this.store.get_event_reader(def);
  }
}
