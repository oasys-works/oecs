/***
 *
 * SystemContext - Store wrapper passed to every system function.
 * Provides deferred structural changes (add/remove component, destroy entity).
 * See docs/DESIGN.md [opt:6, opt:7] for query performance design.
 *
 ***/

import type { Store } from "../store/store";
import type { Archetype } from "../archetype/archetype";
import type { EntityID } from "../entity/entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentFields,
  FieldValues,
  ColumnsForSchema,
} from "../component/component";
import { BitSet } from "type_primitives";

//=========================================================
// Type utilities
//=========================================================

type DefsToColumns<Defs extends readonly ComponentDef<ComponentFields>[]> = {
  [K in keyof Defs]: ColumnsForSchema<Defs[K] extends ComponentDef<infer F> ? F : never>;
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

  // Compat getters / iterability
  get length(): number {
    return this._archetypes.length;
  }
  get archetypes(): readonly Archetype[] {
    return this._archetypes;
  }
  [Symbol.iterator](): Iterator<Archetype> {
    return this._archetypes[Symbol.iterator]();
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
  and<D extends ComponentDef<ComponentFields>>(d: D): Query<[...Defs, D]>;
  and<
    D1 extends ComponentDef<ComponentFields>,
    D2 extends ComponentDef<ComponentFields>,
  >(d1: D1, d2: D2): Query<[...Defs, D1, D2]>;
  and<
    D1 extends ComponentDef<ComponentFields>,
    D2 extends ComponentDef<ComponentFields>,
    D3 extends ComponentDef<ComponentFields>,
  >(d1: D1, d2: D2, d3: D3): Query<[...Defs, D1, D2, D3]>;
  and<
    D1 extends ComponentDef<ComponentFields>,
    D2 extends ComponentDef<ComponentFields>,
    D3 extends ComponentDef<ComponentFields>,
    D4 extends ComponentDef<ComponentFields>,
  >(d1: D1, d2: D2, d3: D3, d4: D4): Query<[...Defs, D1, D2, D3, D4]>;
  and(...comps: ComponentDef<ComponentFields>[]): Query<any>;
  and(...comps: ComponentDef<ComponentFields>[]): Query<any> {
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

  every<A extends ComponentDef<ComponentFields>>(a: A): Query<[A]>;
  every<
    A extends ComponentDef<ComponentFields>,
    B extends ComponentDef<ComponentFields>,
  >(a: A, b: B): Query<[A, B]>;
  every<
    A extends ComponentDef<ComponentFields>,
    B extends ComponentDef<ComponentFields>,
    C extends ComponentDef<ComponentFields>,
  >(a: A, b: B, c: C): Query<[A, B, C]>;
  every<
    A extends ComponentDef<ComponentFields>,
    B extends ComponentDef<ComponentFields>,
    C extends ComponentDef<ComponentFields>,
    D extends ComponentDef<ComponentFields>,
  >(a: A, b: B, c: C, d: D): Query<[A, B, C, D]>;
  every(...defs: ComponentDef<ComponentFields>[]): Query<any> {
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
  add_component<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): void {
    this.store.add_component_deferred(entity_id, def, values);
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
