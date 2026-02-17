/***
 *
 * Archetype - Dense-storage grouping of entities by component signature
 *
 * An archetype tracks which entities share the same set of components
 * and owns the component data as dense, packed columns indexed by row
 * (0..N-1). Iteration is sequential, maximizing spatial locality.
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
 * Component data is stored as per-component column groups. Each
 * component gets one TypedArray per field, all indexed by row.
 * Swap-and-pop on remove applies to ALL columns, keeping data dense.
 *
 * Graph edges cache archetype transitions: "if I add/remove component X,
 * which archetype do I end up in?" These are lazily populated by the
 * Store and make repeated transitions O(1). Edges use a Map indexed
 * by ComponentID.
 *
 ***/

import { Brand, validate_and_cast } from "type_primitives";
import type { ComponentID } from "../component/component";
import type { ComponentSchema, ComponentDef } from "../component/component";
import { get_entity_index, type EntityID } from "../entity/entity";
import { ECS_ERROR, ECSError } from "../utils/error";
import type { BitSet } from "type_primitives";
import { TYPED_ARRAY_MAP, type TypedArray, type TypeTag, type TypedArrayFor } from "type_primitives";

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
// ArchetypeColumn — per-component column group
//=========================================================

export interface ArchetypeColumnLayout {
  component_id: ComponentID;
  field_names: string[];
  field_tags: TypeTag[];
  field_index: Record<string, number>;
}

interface ArchetypeColumnGroup {
  layout: ArchetypeColumnLayout;
  columns: TypedArray[];
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
  private capacity: number;
  private edges: Map<ComponentID, ArchetypeEdge> = new Map();
  private _cached_list: Uint32Array | null = null;

  // Component columns: ComponentID → column group
  private column_groups: Map<ComponentID, ArchetypeColumnGroup> = new Map();

  /**
   * @param id - Archetype identifier
   * @param mask - BitSet representing the component signature
   * @param layouts - Column layouts for each component in this archetype
   */
  constructor(id: ArchetypeID, mask: BitSet, layouts?: ArchetypeColumnLayout[]) {
    this.id = id;
    this.mask = mask;
    this.capacity = INITIAL_DENSE_CAPACITY;
    this.entity_ids = new Uint32Array(this.capacity);
    this.index_to_row = new Int32Array(INITIAL_SPARSE_CAPACITY).fill(EMPTY_ROW);

    if (layouts) {
      for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        const columns: TypedArray[] = new Array(layout.field_tags.length);
        for (let j = 0; j < layout.field_tags.length; j++) {
          columns[j] = new TYPED_ARRAY_MAP[layout.field_tags[j]](this.capacity);
        }
        this.column_groups.set(layout.component_id, { layout, columns });
      }
    }
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
  // Column data access
  //=========================================================

  /** Get the dense column for a component field. Rows 0..entity_count-1. */
  public get_column<S extends ComponentSchema, F extends keyof S & string>(
    def: ComponentDef<S>,
    field: F,
  ): TypedArrayFor<S[F]> {
    const group = this.column_groups.get(def as ComponentID);
    if (__DEV__) {
      if (!group) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Component ${def} not in archetype ${this.id}`,
        );
      }
    }
    const col_idx = group!.layout.field_index[field];
    if (__DEV__) {
      if (col_idx === undefined) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Field "${field}" does not exist on component`,
        );
      }
    }
    return group!.columns[col_idx] as TypedArrayFor<S[F]>;
  }

  /** Get the row index for an entity_index, or -1 if not present. */
  public get_row(entity_index: number): number {
    if (entity_index >= this.index_to_row.length) return EMPTY_ROW;
    return this.index_to_row[entity_index];
  }

  /** Write all fields for a component at a given row. */
  public write_fields(
    row: number,
    component_id: ComponentID,
    values: Record<string, number>,
  ): void {
    const group = this.column_groups.get(component_id);
    if (!group) return; // tag component — no columns
    const { field_names, field_index } = group.layout;
    for (let i = 0; i < field_names.length; i++) {
      group.columns[i][row] = values[field_names[i]];
    }
  }

  /** Read a single field at a given row. */
  public read_field(
    row: number,
    component_id: ComponentID,
    field: string,
  ): number {
    const group = this.column_groups.get(component_id);
    if (!group) return NaN;
    const col_idx = group.layout.field_index[field];
    if (col_idx === undefined) return NaN;
    return group.columns[col_idx][row];
  }

  /** Copy all fields for a component from src_row to dst_row (within same archetype). */
  public copy_row(
    component_id: ComponentID,
    dst_row: number,
    src_row: number,
  ): void {
    const group = this.column_groups.get(component_id);
    if (!group) return;
    for (let i = 0; i < group.columns.length; i++) {
      group.columns[i][dst_row] = group.columns[i][src_row];
    }
  }

  //=========================================================
  // Cross-archetype data copy
  //=========================================================

  /**
   * Copy shared component data from a source archetype row to this
   * archetype's row. Only copies components that exist in both archetypes.
   */
  public copy_shared_from(
    source: Archetype,
    src_row: number,
    dst_row: number,
  ): void {
    for (const [comp_id, dst_group] of this.column_groups) {
      const src_group = source.column_groups.get(comp_id);
      if (!src_group) continue;
      for (let i = 0; i < dst_group.columns.length; i++) {
        dst_group.columns[i][dst_row] = src_group.columns[i][src_row];
      }
    }
  }

  //=========================================================
  // Membership (called by Store only)
  //=========================================================

  /**
   * Add an entity to this archetype. Returns the assigned row.
   */
  public add_entity(entity_id: EntityID, entity_index: number): number {
    if (this.length >= this.capacity) this.grow();
    if (entity_index >= this.index_to_row.length)
      this.grow_index_to_row(entity_index + 1);

    const row = this.length;
    this.entity_ids[row] = entity_id as number;
    this.index_to_row[entity_index] = row;
    this.length++;
    this._cached_list = null;
    return row;
  }

  /**
   * Remove an entity by its index using swap-and-pop.
   *
   * Returns the entity_index of the entity that was swapped into the
   * removed slot, or -1 if the removed entity was the last element
   * (no swap needed).
   *
   * Swap-and-pop applies to ALL component columns as well.
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
      // Swap entity_ids
      this.entity_ids[row] = this.entity_ids[last_row];
      const swapped_index = get_entity_index(this.entity_ids[row] as EntityID);
      this.index_to_row[swapped_index] = row;

      // Swap all component columns
      for (const [, group] of this.column_groups) {
        for (let i = 0; i < group.columns.length; i++) {
          group.columns[i][row] = group.columns[i][last_row];
        }
      }

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

  /** Grow entity_ids and ALL component columns together. */
  private grow(): void {
    const new_capacity = this.capacity * 2;

    // Grow entity_ids
    const next_ids = new Uint32Array(new_capacity);
    next_ids.set(this.entity_ids);
    this.entity_ids = next_ids;

    // Grow all component columns
    for (const [, group] of this.column_groups) {
      for (let i = 0; i < group.columns.length; i++) {
        const old = group.columns[i];
        const next = new TYPED_ARRAY_MAP[group.layout.field_tags[i]](new_capacity);
        next.set(old);
        group.columns[i] = next;
      }
    }

    this.capacity = new_capacity;
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
