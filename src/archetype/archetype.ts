/***
 *
 * Archetype - Dense-storage grouping of entities by component signature.
 * See docs/DESIGN.md [opt:2, opt:3, opt:9] for sparse-set, edge cache, and growth strategy.
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";
import type { ComponentID } from "../component/component";
import type { ComponentSchema, ComponentDef, ColumnsForSchema } from "../component/component";
import { get_entity_index, type EntityID } from "../entity/entity";
import { ECS_ERROR, ECSError } from "../utils/error";
import { grow_number_array } from "../utils/arrays";
import type { BitSet } from "type_primitives";

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
    is_non_negative_integer,
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
  field_index: Record<string, number>;
}

interface ArchetypeColumnGroup {
  layout: ArchetypeColumnLayout;
  columns: number[][];
  _record: Record<string, number[]> | null; // lazy; null = needs rebuild
}

//=========================================================
// Archetype
//=========================================================

export class Archetype {
  readonly id: ArchetypeID;
  readonly mask: BitSet;

  private entity_ids: number[];
  private index_to_row: number[];
  private length: number = 0;
  private capacity: number;
  private edges: Map<ComponentID, ArchetypeEdge> = new Map();
  private _cached_list: number[] | null = null;

  // Component columns: ComponentID → column group
  private column_groups: Map<ComponentID, ArchetypeColumnGroup> = new Map();

  /**
   * @param id - Archetype identifier
   * @param mask - BitSet representing the component signature
   * @param layouts - Column layouts for each component in this archetype
   */
  constructor(
    id: ArchetypeID,
    mask: BitSet,
    layouts?: ArchetypeColumnLayout[],
  ) {
    this.id = id;
    this.mask = mask;
    this.capacity = INITIAL_DENSE_CAPACITY;
    this.entity_ids = new Array(this.capacity).fill(0);
    this.index_to_row = new Array(INITIAL_SPARSE_CAPACITY).fill(EMPTY_ROW);

    if (layouts) {
      for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        const columns: number[][] = new Array(layout.field_names.length);
        for (let j = 0; j < layout.field_names.length; j++) {
          columns[j] = new Array(this.capacity).fill(0);
        }
        this.column_groups.set(layout.component_id, { layout, columns, _record: null });
      }
    }
  }

  //=========================================================
  // Queries
  //=========================================================

  public get entity_count(): number {
    return this.length;
  }

  public get entity_list(): number[] {
    if (this._cached_list === null) {
      this._cached_list = this.entity_ids.slice(0, this.length);
    }
    return this._cached_list;
  }

  public has_component(id: ComponentID): boolean {
    return this.mask.has(id);
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
  ): number[] {
    const group = this.column_groups.get(def);
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
    return group!.columns[col_idx];
  }

  /** Get all columns for a component as a typed record. Lazily cached per archetype-component pair. */
  public get_column_group<S extends ComponentSchema>(def: ComponentDef<S>): ColumnsForSchema<S> {
    const group = this.column_groups.get(def);
    if (!group) return {} as ColumnsForSchema<S>; // tag component — no columns
    if (group._record === null) {
      const rec: Record<string, number[]> = Object.create(null);
      const { field_names } = group.layout;
      for (let i = 0; i < field_names.length; i++) rec[field_names[i]] = group.columns[i];
      group._record = rec;
    }
    return group._record as ColumnsForSchema<S>;
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
    const { field_names } = group.layout;
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

  /** Copy shared component data from source to target row. */
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
    this.entity_ids[row] = entity_id;
    this.index_to_row[entity_index] = row;
    this.length++;
    this._cached_list = null;
    return row;
  }

  /**
   * Remove an entity by its index using swap-and-pop.
   * Swap-and-pop applies to ALL component columns as well.
   * Returns the swapped entity_index, or -1 if no swap was needed.
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

    let swapped_index = -1;
    if (row !== last_row) {
      // Swap entity_ids
      this.entity_ids[row] = this.entity_ids[last_row];
      swapped_index = get_entity_index(this.entity_ids[row] as EntityID);
      this.index_to_row[swapped_index] = row;

      // Swap all component columns
      for (const [, group] of this.column_groups) {
        for (let i = 0; i < group.columns.length; i++) {
          group.columns[i][row] = group.columns[i][last_row];
        }
      }
    }

    this.length--;
    this._cached_list = null;
    return swapped_index;
  }

  //=========================================================
  // Growth helpers
  //=========================================================

  /** Grow entity_ids and ALL component columns together. */
  private grow(): void {
    const new_capacity = this.capacity * 2;

    const next_ids = new Array(new_capacity).fill(0);
    for (let i = 0; i < this.length; i++) next_ids[i] = this.entity_ids[i];
    this.entity_ids = next_ids;

    for (const [, group] of this.column_groups) {
      for (let i = 0; i < group.columns.length; i++) {
        const old = group.columns[i];
        const next = new Array(new_capacity).fill(0);
        for (let j = 0; j < old.length; j++) next[j] = old[j];
        group.columns[i] = next;
      }
      group._record = null; // invalidate lazy column record cache
    }

    this.capacity = new_capacity;
  }

  private grow_index_to_row(min_capacity: number): void {
    this.index_to_row = grow_number_array(this.index_to_row, min_capacity, EMPTY_ROW);
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
