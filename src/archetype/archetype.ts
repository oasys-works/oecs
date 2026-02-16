/***
 *
 * Archetype - Metadata-only grouping of entities by component signature
 *
 * An archetype tracks which entities share the same set of components.
 * It holds no component data - that lives in ComponentRegistry's typed
 * arrays indexed by entity index. Moving an entity between archetypes
 * only changes membership lists; no component data is copied.
 *
 * The signature is a BitSet where each set bit corresponds to a
 * ComponentID. This enables O(1) has_component checks and O(words)
 * superset checks for query matching.
 *
 * Entity membership uses a classic sparse-set backed by typed arrays:
 *   - entity_ids (Uint32Array, dense) holds packed EntityIDs
 *   - index_to_row (Int32Array, sparse) maps entity_index → row
 * Uint32Array is required because EntityIDs use unsigned coercion
 * (>>> 0) and can exceed Int32 range. The sentinel EMPTY_ROW = -1
 * marks unused slots since rows are always non-negative.
 *
 * Graph edges cache archetype transitions: "if I add/remove component X,
 * which archetype do I end up in?" These are lazily populated by the
 * Store and make repeated transitions O(1). Edges use a plain array
 * indexed by ComponentID instead of a Map for faster lookup.
 *
 ***/

import { Brand, validate_and_cast } from "type_primitives";
import type { ComponentID } from "../component/component";
import { get_entity_index, type EntityID } from "../entity/entity";
import { ECS_ERROR, ECSError } from "../utils/error";
import type { BitSet } from "../collections/bitset";

const INITIAL_DENSE_CAPACITY = 16;
const INITIAL_SPARSE_CAPACITY = 64;
const EMPTY_ROW = -1;

//=========================================================
// ArchetypeID
//=========================================================

export type ArchetypeID = Brand<number, "archetype_id">;

export const as_archetype_id = (value: number) =>
  validate_and_cast<number, ArchetypeID>(
    value,
    (v) => Number.isInteger(v) && v >= 0,
    "ArchetypeID must be a non-negative integer",
  );

//=========================================================
// ArchetypeEdge
//=========================================================

export interface ArchetypeEdge {
  add: ArchetypeID | null;
  remove: ArchetypeID | null;
}

//=========================================================
// Archetype
//=========================================================

export class Archetype {
  readonly id: ArchetypeID;
  readonly mask: BitSet;

  private entity_ids: Uint32Array;
  private index_to_row: Int32Array;
  private length: number = 0;
  private edges: Map<ComponentID, ArchetypeEdge> = new Map();
  private _cached_list: Uint32Array | null = null;

  /**
   * @param id - Archetype identifier
   * @param mask - BitSet representing the component signature
   */
  constructor(id: ArchetypeID, mask: BitSet) {
    this.id = id;
    this.mask = mask;
    this.entity_ids = new Uint32Array(INITIAL_DENSE_CAPACITY);
    this.index_to_row = new Int32Array(INITIAL_SPARSE_CAPACITY).fill(EMPTY_ROW);
  }

  //=========================================================
  // Queries
  //=========================================================

  public get entity_count(): number {
    return this.length;
  }

  public get entity_list(): Uint32Array {
    if (this._cached_list === null) {
      this._cached_list = this.entity_ids.subarray(0, this.length);
    }
    return this._cached_list;
  }

  public has_component(id: ComponentID): boolean {
    return this.mask.has(id as number);
  }

  /** Check if this archetype's mask is a superset of `required`. */
  public matches(required: BitSet): boolean {
    return this.mask.contains(required);
  }

  public has_entity(entity_index: number): boolean {
    return (
      entity_index < this.index_to_row.length &&
      this.index_to_row[entity_index] !== EMPTY_ROW
    );
  }

  //=========================================================
  // Membership (called by Store only)
  //=========================================================

  public add_entity(entity_id: EntityID, entity_index: number): void {
    if (this.length >= this.entity_ids.length) this.grow_entity_ids();
    if (entity_index >= this.index_to_row.length)
      this.grow_index_to_row(entity_index + 1);

    const row = this.length;
    this.entity_ids[row] = entity_id as number;
    this.index_to_row[entity_index] = row;
    this.length++;
    this._cached_list = null;
  }

  /**
   * Remove an entity by its index using swap-and-pop.
   *
   * Returns the entity_index of the entity that was swapped into the
   * removed slot, or -1 if the removed entity was the last element
   * (no swap needed).
   */
  public remove_entity(entity_index: number): number {
    if (__DEV__) {
      if (
        entity_index >= this.index_to_row.length ||
        this.index_to_row[entity_index] === EMPTY_ROW
      ) {
        throw new ECSError(
          ECS_ERROR.ENTITY_NOT_IN_ARCHETYPE,
          `Entity index ${entity_index} is not in archetype ${this.id}`,
        );
      }
    }

    const row = this.index_to_row[entity_index];
    const last_row = this.length - 1;

    this.index_to_row[entity_index] = EMPTY_ROW;

    if (row !== last_row) {
      this.entity_ids[row] = this.entity_ids[last_row];
      const swapped_index = get_entity_index(this.entity_ids[row] as EntityID);
      this.index_to_row[swapped_index] = row;
      this.length--;
      this._cached_list = null;
      return swapped_index;
    }

    this.length--;
    this._cached_list = null;
    return -1;
  }

  //=========================================================
  // Growth helpers
  //=========================================================

  private grow_entity_ids(): void {
    const next = new Uint32Array(this.entity_ids.length * 2);
    next.set(this.entity_ids);
    this.entity_ids = next;
    this._cached_list = null;
  }

  private grow_index_to_row(min_capacity: number): void {
    let cap = this.index_to_row.length;
    while (cap < min_capacity) cap *= 2;
    const next = new Int32Array(cap).fill(EMPTY_ROW);
    next.set(this.index_to_row);
    this.index_to_row = next;
  }

  //=========================================================
  // Graph edges (called by ArchetypeRegistry only)
  //=========================================================

  public get_edge(component_id: ComponentID): ArchetypeEdge | undefined {
    return this.edges.get(component_id);
  }

  public set_edge(component_id: ComponentID, edge: ArchetypeEdge): void {
    this.edges.set(component_id, edge);
  }
}
