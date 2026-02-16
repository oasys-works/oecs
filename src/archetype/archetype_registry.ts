/***
 *
 * ArchetypeRegistry - Manages archetype creation, deduplication, and transitions
 *
 * Owns the archetype dense array, BitSet-based dedup map, graph edge
 * resolution, and component index (for query matching).
 *
 * Store delegates all archetype operations here, keeping itself as a
 * pure orchestrator of registries.
 *
 ***/

import type { ComponentID } from "../component/component";
import { BitSet } from "../collections/bitset";
import {
  Archetype,
  as_archetype_id,
  type ArchetypeID,
} from "./archetype";
import { ECS_ERROR, ECSError } from "../utils/error";

//=========================================================
// ArchetypeRegistry
//=========================================================

export class ArchetypeRegistry {
  private archetypes: Archetype[] = [];
  private archetype_map: Map<number, ArchetypeID[]> = new Map();
  private next_archetype_id = 0;

  // Component index: ComponentID → Set<ArchetypeID>
  private component_index: Map<ComponentID, Set<ArchetypeID>> = new Map();

  // The empty archetype (no components)
  private _empty_archetype_id: ArchetypeID;

  constructor() {
    this._empty_archetype_id = this.get_or_create([]);
  }

  //=========================================================
  // Queries
  //=========================================================

  get count(): number {
    return this.archetypes.length;
  }

  get empty_archetype_id(): ArchetypeID {
    return this._empty_archetype_id;
  }

  get(id: ArchetypeID): Archetype {
    if (__DEV__) {
      if ((id as number) < 0 || (id as number) >= this.archetypes.length) {
        throw new ECSError(
          ECS_ERROR.ARCHETYPE_NOT_FOUND,
          `Archetype with ID ${id} not found`,
        );
      }
    }
    return this.archetypes[id];
  }

  /** Number of archetypes containing a given component. */
  get_component_archetype_count(id: ComponentID): number {
    return this.component_index.get(id)?.size ?? 0;
  }

  /**
   * Find all archetypes whose mask is a superset of `required`.
   *
   * Uses component_index intersection with smallest-set-first optimization.
   */
  get_matching(required: BitSet): readonly Archetype[] {
    // Empty mask means match all
    let has_any_bit = false;
    for (let i = 0; i < required._words.length; i++) {
      if (required._words[i] !== 0) { has_any_bit = true; break; }
    }
    if (!has_any_bit) {
      return this.archetypes.slice();
    }

    // Collect component IDs from the mask and find smallest set
    let smallest_set: Set<ArchetypeID> | undefined;
    required.for_each((bit) => {
      const set = this.component_index.get(bit as ComponentID);
      if (!set || set.size === 0) {
        smallest_set = undefined;
        return;
      }
      if (!smallest_set || set.size < smallest_set.size) {
        smallest_set = set;
      }
    });

    // Check if any component had no archetypes
    // We need a more careful check: re-scan to detect zeros
    let has_empty = false;
    required.for_each((bit) => {
      const set = this.component_index.get(bit as ComponentID);
      if (!set || set.size === 0) has_empty = true;
    });
    if (has_empty) return [];

    // Intersect: start with smallest set, filter by contains
    const result: Archetype[] = [];
    for (const archetype_id of smallest_set!) {
      const arch = this.get(archetype_id);
      if (arch.matches(required)) {
        result.push(arch);
      }
    }

    return result;
  }

  //=========================================================
  // Creation & transitions
  //=========================================================

  get_or_create(signature: readonly ComponentID[]): ArchetypeID {
    const mask = new BitSet();
    for (let i = 0; i < signature.length; i++) {
      mask.set(signature[i] as number);
    }
    return this.get_or_create_from_mask(mask);
  }

  get_or_create_from_mask(mask: BitSet): ArchetypeID {
    const hash = mask.hash();

    const bucket = this.archetype_map.get(hash);
    if (bucket !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        if (this.archetypes[bucket[i]].mask.equals(mask)) {
          return bucket[i];
        }
      }
    }

    const id = as_archetype_id(this.next_archetype_id++);
    const archetype = new Archetype(id, mask);

    this.archetypes.push(archetype);
    if (bucket !== undefined) {
      bucket.push(id);
    } else {
      this.archetype_map.set(hash, [id]);
    }

    // Update component index
    mask.for_each((bit) => {
      const component_id = bit as ComponentID;
      let set = this.component_index.get(component_id);
      if (!set) {
        set = new Set();
        this.component_index.set(component_id, set);
      }
      set.add(id);
    });

    return id;
  }

  resolve_add(archetype_id: ArchetypeID, component_id: ComponentID): ArchetypeID {
    const current = this.get(archetype_id);

    // Already has this component — no transition needed
    if (current.mask.has(component_id as number)) return archetype_id;

    // Check cached edge
    const edge = current.get_edge(component_id);
    if (edge?.add != null) return edge.add;

    // Cache miss: build new mask with the added component
    const target_id = this.get_or_create_from_mask(
      current.mask.copy_with_set(component_id as number),
    );

    // Cache bidirectional edges
    this.cache_edge(current, this.get(target_id), component_id);

    return target_id;
  }

  resolve_remove(archetype_id: ArchetypeID, component_id: ComponentID): ArchetypeID {
    const current = this.get(archetype_id);

    // Doesn't have this component — no transition needed
    if (!current.mask.has(component_id as number)) return archetype_id;

    // Check cached edge
    const edge = current.get_edge(component_id);
    if (edge?.remove != null) return edge.remove;

    // Cache miss: build new mask without the component
    const target_id = this.get_or_create_from_mask(
      current.mask.copy_with_clear(component_id as number),
    );

    // Cache bidirectional edges (reversed: target --add--> current, current --remove--> target)
    this.cache_edge(this.get(target_id), current, component_id);

    return target_id;
  }

  //=========================================================
  // Internal
  //=========================================================

  private cache_edge(
    from: Archetype,
    to: Archetype,
    component_id: ComponentID,
  ): void {
    // Forward edge: from --add component_id--> to
    const from_edge = from.get_edge(component_id) ?? {
      add: null,
      remove: null,
    };
    from_edge.add = to.id;
    from.set_edge(component_id, from_edge);

    // Reverse edge: to --remove component_id--> from
    const to_edge = to.get_edge(component_id) ?? {
      add: null,
      remove: null,
    };
    to_edge.remove = from.id;
    to.set_edge(component_id, to_edge);
  }
}
