/***
 * Query, QueryBuilder, SystemContext — System-facing ECS interface.
 *
 * Query<Defs> is a live, cached view over all archetypes matching a
 * component mask. Iterate with for..of, which yields non-empty
 * archetypes. Use arch.get_column() to access SoA columns, then
 * write the inner loop over arch.entity_count.
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
 *   for (const arch of q) {
 *     const px = arch.get_column(Pos, "x");
 *     const py = arch.get_column(Pos, "y");
 *     const vx = arch.get_column(Vel, "vx");
 *     const vy = arch.get_column(Vel, "vy");
 *     for (let i = 0; i < arch.entity_count; i++) {
 *       px[i] += vx[i] * dt;
 *       py[i] += vy[i] * dt;
 *     }
 *   }
 *
 * Queries compose via chaining:
 *
 *   q.and(Health)          — extend required components
 *   q.not(Dead)            — exclude archetypes with Dead
 *   q.any_of(Poison, Fire) — require at least one of these
 *
 ***/

import type { Store } from "./store";
import type { Archetype } from "./archetype";
import type { EntityID } from "./entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentSchema,
  ComponentFields,
  FieldValues,
} from "./component";
import { create_ref, type ComponentRef } from "./ref";
import type { EventDef, EventReader } from "./event";
import type { ResourceDef, ResourceReader } from "./resource";
import { BitSet } from "type_primitives";
import { EMPTY_VALUES } from "./utils/constants";

export interface QueryCacheEntry {
  include_mask: BitSet;
  exclude_mask: BitSet | null;
  any_of_mask: BitSet | null;
  query: Query<any>; // any: heterogeneous cache — different queries have different Defs tuples
}

export interface QueryResolver {
  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef[],
  ): Query<any>; // any: heterogeneous cache — callers downcast to their specific Query<Defs>
}

export class Query<Defs extends readonly ComponentDef[]> {
  private readonly _archetypes: Archetype[];
  private readonly _defs: Defs;
  private readonly _resolver: QueryResolver;
  private readonly _include: BitSet;
  private readonly _exclude: BitSet | null;
  private readonly _any_of: BitSet | null;

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
  }

  /** Number of matching archetypes (including empty ones). */
  public get archetype_count(): number {
    return this._archetypes.length;
  }

  /** Total entity count across all matching archetypes. */
  public count(): number {
    const archs = this._archetypes;
    let total = 0;
    for (let i = 0; i < archs.length; i++) total += archs[i].entity_count;
    return total;
  }
  public get archetypes(): readonly Archetype[] {
    return this._archetypes;
  }
  /** Iterate non-empty archetypes. Skips archetypes with zero entities. */
  public *[Symbol.iterator](): Iterator<Archetype> {
    const archs = this._archetypes;
    for (let i = 0; i < archs.length; i++) {
      if (archs[i].entity_count > 0) yield archs[i];
    }
  }

  /** Extend required component set. Returns a new (cached) Query. */
  public and<D extends ComponentDef[]>(
    ...comps: D
  ): Query<[...Defs, ...D]> {
    const new_include = this._include.copy();
    const new_defs = this._defs.slice() as ComponentDef[];
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
  public not(...comps: ComponentDef[]): Query<Defs> {
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
  public any_of(...comps: ComponentDef[]): Query<Defs> {
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

  public every<T extends ComponentDef[]>(
    ...defs: T
  ): Query<T> {
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

  public create_entity(): EntityID {
    return this.store.create_entity();
  }

  public get_field<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    field: string & keyof S,
  ): number {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    return arch.read_field(row, def as ComponentID, field);
  }

  public set_field<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    field: string & keyof S,
    value: number,
  ): void {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    const col = arch.get_column(def, field);
    col[row] = value;
  }

  /** Create a cached component reference for a single entity. See ref.ts. */
  public ref<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
  ): ComponentRef<S> {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    return create_ref<S>(arch.column_groups[def as unknown as number]!, row);
  }

  /** Buffer an entity for deferred destruction (applied at phase flush). */
  public destroy_entity(id: EntityID): this {
    this.store.destroy_entity_deferred(id);
    return this;
  }

  public add_component(
    entity_id: EntityID,
    def: ComponentDef<Record<string, never>>,
  ): this;
  public add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: FieldValues<S>,
  ): this;
  public add_component(
    entity_id: EntityID,
    def: ComponentDef,
    values?: Record<string, number>,
  ): this {
    this.store.add_component_deferred(entity_id, def, values ?? EMPTY_VALUES);
    return this;
  }

  public remove_component(
    entity_id: EntityID,
    def: ComponentDef,
  ): this {
    this.store.remove_component_deferred(entity_id, def);
    return this;
  }

  /** Flush all deferred changes: structural (add/remove) first, then destructions. */
  public flush(): void {
    this.store.flush_structural();
    this.store.flush_destroyed();
  }

  // =======================================================
  // Events
  // =======================================================

  public emit(def: EventDef<readonly []>): void;
  public emit<F extends ComponentFields>(
    def: EventDef<F>,
    values: { readonly [K in F[number]]: number },
  ): void;
  public emit(
    def: EventDef<ComponentFields>,
    values?: Record<string, number>,
  ): void {
    if (values === undefined) {
      this.store.emit_signal(def as EventDef<readonly []>);
    } else {
      this.store.emit_event(def, values);
    }
  }

  public read<F extends ComponentFields>(def: EventDef<F>): EventReader<F> {
    return this.store.get_event_reader(def);
  }

  // =======================================================
  // Resources
  // =======================================================

  public resource<F extends ComponentFields>(
    def: ResourceDef<F>,
  ): ResourceReader<F> {
    return this.store.get_resource_reader(def);
  }

  public set_resource<F extends ComponentFields>(
    def: ResourceDef<F>,
    values: { readonly [K in F[number]]: number },
  ): void {
    this.store
      .get_resource_channel(def)
      .write(values as Record<string, number>);
  }

}
