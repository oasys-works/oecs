/***
 *
 * SystemContext - Store wrapper passed to every system function.
 * Provides deferred structural changes (add/remove component, destroy entity).
 * See docs/DESIGN.md [opt:6, opt:7] for query performance design.
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
import { BitSet } from "type_primitives";

const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

//=========================================================
// Type utilities
//=========================================================

type DefsToColumns<Defs extends readonly ComponentDef<ComponentFields>[]> = {
  [K in keyof Defs]: ColumnsForSchema<
    Defs[K] extends ComponentDef<infer F> ? F : never
  >;
};

type EachFn<Defs extends readonly ComponentDef<ComponentFields>[]> = (
  ...args: [...DefsToColumns<Defs>, number]
) => void;

//=========================================================
// Cache entry
//=========================================================

export interface QueryCacheEntry {
  include_mask: BitSet;
  exclude_mask: BitSet | null;
  any_of_mask: BitSet | null;
  query: Query<any>;
}

//=========================================================
// QueryResolver interface
//=========================================================

export interface QueryResolver {
  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef<ComponentFields>[],
  ): Query<any>;
}

//=========================================================
// Query<Defs>
//=========================================================

export class Query<Defs extends readonly ComponentDef<ComponentFields>[]> {
  private readonly _archetypes: Archetype[];
  private readonly _defs: Defs;
  readonly _resolver: QueryResolver;
  readonly _include: BitSet;
  readonly _exclude: BitSet | null;
  readonly _any_of: BitSet | null;
  private readonly _args_buf: unknown[]; // pre-allocated: defs.length + 1 slots

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

  get length(): number {
    return this._archetypes.length;
  }
  get archetypes(): readonly Archetype[] {
    return this._archetypes;
  }
  *[Symbol.iterator](): Iterator<Archetype> {
    const archs = this._archetypes;
    for (let i = 0; i < archs.length; i++) {
      if (archs[i].entity_count > 0) yield archs[i];
    }
  }

  /** Typed per-archetype iteration — one closure call per archetype, not per entity. */
  each(fn: EachFn<Defs>): void {
    const archs = this._archetypes;
    const defs = this._defs;
    const buf = this._args_buf;
    for (let ai = 0; ai < archs.length; ai++) {
      const arch = archs[ai];
      const count = arch.entity_count;
      if (count === 0) continue;
      for (let di = 0; di < defs.length; di++) {
        buf[di] = arch.get_column_group(defs[di]);
      }
      buf[defs.length] = count;
      (fn as (...a: unknown[]) => void).apply(null, buf);
    }
  }

  /** Extend required component set — returns a new (cached) Query with extended include mask. */
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

  /** Exclude archetypes that have any of these components. Returns same typed Query. */
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

  /** Require archetypes that have at least one of these components. Returns same typed Query. */
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

//=========================================================
// QueryBuilder
//=========================================================

export class QueryBuilder {
  constructor(private readonly _resolver: QueryResolver) {}

  every<T extends ComponentDef<ComponentFields>[]>(...defs: T): Query<T> {
    const mask = new BitSet();
    for (let i = 0; i < defs.length; i++) mask.set(defs[i] as number);
    return this._resolver._resolve_query(mask, null, null, defs);
  }
}

//=========================================================
// SystemContext
//=========================================================

export class SystemContext {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Create a new entity. Returns immediately (not deferred). */
  create_entity(): EntityID {
    return this.store.create_entity();
  }

  /**
   * Get a single field value for a component on an entity.
   * Looks up the entity's archetype and row.
   */
  get_field<F extends ComponentFields>(
    def: ComponentDef<F>,
    entity_id: EntityID,
    field: F[number],
  ): number {
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    return arch.read_field(row, def as ComponentID, field);
  }

  /**
   * Set a single field value for a component on an entity.
   * Looks up the entity's archetype and row.
   */
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

  /**
   * Buffer an entity for deferred destruction.
   * The entity stays alive until flush_destroyed() is called.
   */
  destroy_entity(id: EntityID): void {
    this.store.destroy_entity_deferred(id);
  }

  /**
   * Flush all deferred entity destructions.
   * Called by Schedule between phases — not intended for system code.
   */
  flush_destroyed(): void {
    this.store.flush_destroyed();
  }

  /**
   * Buffer a component addition for deferred processing.
   * The entity keeps its current archetype until flush() is called.
   */
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
    this.store.add_component_deferred(entity_id, def, values ?? EMPTY_VALUES);
  }

  /**
   * Buffer a component removal for deferred processing.
   * The entity keeps its current archetype until flush() is called.
   */
  remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): void {
    this.store.remove_component_deferred(entity_id, def);
  }

  /**
   * Flush all deferred changes: structural (add/remove) first, then destructions.
   * Called by Schedule between phases — not intended for system code.
   */
  flush(): void {
    this.store.flush_structural();
    this.store.flush_destroyed();
  }
}
