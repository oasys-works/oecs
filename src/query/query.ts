/***
 *
 * SystemContext - Store wrapper passed to every system function
 *
 * Provides a cached query() method that returns matching archetypes.
 * Cache invalidation uses per-component fingerprinting: each cache
 * entry tracks the sum of per-component archetype counts for its
 * queried components. When a new archetype is created, only queries
 * whose components overlap with the new archetype's signature see a
 * fingerprint change. Stale entries are rebuilt incrementally — only
 * new archetypes (appended since last rebuild) are tested.
 *
 ***/

import type { Store } from "../store/store";
import type { Archetype, ArchetypeID } from "../archetype/archetype";
import type { EntityID } from "../entity/entity";
import type { ComponentRegistry } from "../component/component_registry";
import type {
  ComponentDef,
  ComponentID,
  ComponentSchema,
  SchemaValues,
} from "../component/component";
import { BitSet } from "../collections/bitset";

//=========================================================
// Cache entry
//=========================================================

interface QueryCacheEntry {
  query_mask: BitSet;           // BitSet for collision check
  fingerprint: number;          // sum of per-component archetype counts
  archetype_count: number;      // total archetypes when last rebuilt
  result: readonly Archetype[];
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
   * Results are cached with per-component fingerprinting. Only queries
   * whose components overlap with newly created archetypes are
   * invalidated, and stale entries rebuild incrementally by scanning
   * only the new archetypes.
   */
  query(...defs: ComponentDef<ComponentSchema>[]): readonly Archetype[] {
    // Build scratch mask — clear and set bits
    const mask = this.scratch_mask;
    // Zero out the words
    mask._words.fill(0);
    for (let i = 0; i < defs.length; i++) {
      mask.set(defs[i] as unknown as number);
    }

    const key = mask.hash();
    const fingerprint = this.compute_fingerprint(defs);

    const cached = this.find_cached(key, mask);

    if (cached !== undefined && cached.fingerprint === fingerprint) {
      // Advance archetype_count so the next incremental rebuild doesn't
      // re-scan archetypes that can't match (their components didn't
      // change the fingerprint, so they don't contain any queried component).
      cached.archetype_count = this.store.archetype_count;
      return cached.result;
    }

    if (cached !== undefined) {
      // Incremental rebuild: only scan archetypes added since last rebuild
      const current_count = this.store.archetype_count;
      const additions: Archetype[] = [];

      for (let i = cached.archetype_count; i < current_count; i++) {
        const arch = this.store.get_archetype(i as ArchetypeID);
        if (arch.matches(mask)) {
          additions.push(arch);
        }
      }

      if (additions.length > 0) {
        const result = (cached.result as Archetype[]).concat(additions);
        cached.fingerprint = fingerprint;
        cached.archetype_count = current_count;
        cached.result = result;
        return result;
      }

      // False positive: fingerprint changed but no new matches
      cached.fingerprint = fingerprint;
      cached.archetype_count = current_count;
      return cached.result;
    }

    // Cold miss: full scan
    const result = this.store.get_matching_archetypes(mask);
    const entry: QueryCacheEntry = {
      query_mask: mask.copy(),
      fingerprint,
      archetype_count: this.store.archetype_count,
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

  private compute_fingerprint(defs: ComponentDef<ComponentSchema>[]): number {
    if (defs.length === 0) return this.store.archetype_count;
    let sum = 0;
    for (let i = 0; i < defs.length; i++) {
      sum += this.store.get_component_archetype_count(defs[i] as ComponentID);
    }
    return sum;
  }

}
