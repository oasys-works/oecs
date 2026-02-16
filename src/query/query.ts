/***
 *
 * SystemContext - Store wrapper passed to every system function
 *
 * Provides a cached query() method that returns matching archetypes.
 * Queries are registered on first call and return a live array that
 * the ArchetypeRegistry updates automatically when new archetypes are
 * created. Subsequent calls are a pure hash-map lookup — no
 * fingerprint validation, no incremental scanning.
 *
 ***/

import type { Store } from "../store/store";
import type { Archetype } from "../archetype/archetype";
import type { EntityID } from "../entity/entity";
import type { ComponentRegistry } from "../component/component_registry";
import type {
  ComponentDef,
  ComponentSchema,
  SchemaValues,
} from "../component/component";
import { BitSet } from "../collections/bitset";

//=========================================================
// Cache entry
//=========================================================

interface QueryCacheEntry {
  query_mask: BitSet;
  result: Archetype[];
}

//=========================================================
// SystemContext
//=========================================================

export class SystemContext {
  private readonly store: Store;

  private cache: Map<number, QueryCacheEntry[]> = new Map();
  private scratch_mask: BitSet = new BitSet();

  constructor(store: Store) {
    this.store = store;
  }

  /** Create a new entity. Returns immediately (not deferred). */
  create_entity(): EntityID {
    return this.store.create_entity();
  }

  /** Direct access to the component registry for reading/writing field data. */
  get components(): ComponentRegistry {
    return this.store.get_component_registry();
  }

  /**
   * Query for archetypes matching all provided component defs.
   *
   * First call registers with the ArchetypeRegistry and returns a live
   * array. Subsequent calls return the same array — the registry pushes
   * new matching archetypes into it automatically.
   *
   * Overloads avoid rest-parameter array allocation on the hot path.
   */
  query(a: ComponentDef<ComponentSchema>): readonly Archetype[];
  query(a: ComponentDef<ComponentSchema>, b: ComponentDef<ComponentSchema>): readonly Archetype[];
  query(a: ComponentDef<ComponentSchema>, b: ComponentDef<ComponentSchema>, c: ComponentDef<ComponentSchema>): readonly Archetype[];
  query(a: ComponentDef<ComponentSchema>, b: ComponentDef<ComponentSchema>, c: ComponentDef<ComponentSchema>, d: ComponentDef<ComponentSchema>): readonly Archetype[];
  query(...defs: ComponentDef<ComponentSchema>[]): readonly Archetype[];
  query(): readonly Archetype[] {
    // Build scratch mask — clear and set bits (uses arguments to avoid rest-param allocation)
    const mask = this.scratch_mask;
    mask._words.fill(0);
    for (let i = 0; i < arguments.length; i++) {
      mask.set(arguments[i] as unknown as number);
    }

    const key = mask.hash();

    // Cache lookup
    const cached = this.find_cached(key, mask);
    if (cached !== undefined) return cached.result;

    // Cold miss: register with store for push-based updates
    const result = this.store.register_query(mask);
    const query_mask = mask.copy();
    Object.freeze(query_mask);
    const entry: QueryCacheEntry = {
      query_mask,
      result,
    };
    const bucket = this.cache.get(key);
    if (bucket !== undefined) {
      bucket.push(entry);
    } else {
      this.cache.set(key, [entry]);
    }
    return result;
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
  add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: SchemaValues<S>,
  ): void {
    this.store.add_component_deferred(entity_id, def, values);
  }

  /**
   * Buffer a component removal for deferred processing.
   * The entity keeps its current archetype until flush() is called.
   */
  remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
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

  //=========================================================
  // Internal
  //=========================================================

  /** Find a cache entry matching the given mask in a hash bucket. */
  private find_cached(key: number, mask: BitSet): QueryCacheEntry | undefined {
    const bucket = this.cache.get(key);
    if (bucket === undefined) return undefined;
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].query_mask.equals(mask)) return bucket[i];
    }
    return undefined;
  }
}
