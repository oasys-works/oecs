/***
 * Archetype — Dense entity grouping by component signature.
 *
 * An archetype represents a unique combination of components (its "mask").
 * All entities sharing the exact same set of components live in the same
 * archetype. Data is stored in Structure-of-Arrays (SoA) layout: each
 * component field gets its own number[] column, and entity i's data is
 * at index i across all columns.
 *
 * Membership is managed via swap-and-pop: removing entity at row i swaps
 * it with the last row, keeping data packed with no holes. The Store is
 * responsible for updating the swapped entity's row index.
 *
 * Tag-only archetypes (has_columns === false) skip all column operations
 * since tags carry no data — only the entity_ids array is maintained.
 *
 * Graph edges (ArchetypeEdge) cache "add component X" / "remove component X"
 * transitions so the Store can resolve the target archetype in O(1).
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";
import type { ComponentID } from "./component";
import type {
  ComponentFields,
  ComponentDef,
  ColumnsForSchema,
} from "./component";
import { get_entity_index, type EntityID } from "./entity";
import { ECS_ERROR, ECSError } from "./utils/error";
import type { BitSet } from "type_primitives";

export type ArchetypeID = Brand<number, "archetype_id">;

export const as_archetype_id = (value: number) =>
  validate_and_cast<number, ArchetypeID>(
    value,
    is_non_negative_integer,
    "ArchetypeID must be a non-negative integer",
  );

export interface ArchetypeEdge {
  add: ArchetypeID | null;
  remove: ArchetypeID | null;
}

export interface ArchetypeColumnLayout {
  component_id: ComponentID;
  field_names: string[];
  field_index: Record<string, number>;
}

interface ArchetypeColumnGroup {
  layout: ArchetypeColumnLayout;
  columns: number[][];
  record: Record<string, number[]>;
}

export class Archetype {
  readonly id: ArchetypeID;
  readonly mask: BitSet;
  readonly has_columns: boolean;

  entity_ids: EntityID[] = [];
  length: number = 0;
  private edges: ArchetypeEdge[] = [];

  // Sparse array indexed by ComponentID — undefined for absent components.
  // Allows O(1) column group lookup by component.
  readonly column_groups: (ArchetypeColumnGroup | undefined)[] = [];
  // Dense list of ComponentIDs that have columns — used to iterate only
  // data-bearing components in copy/add/remove operations.
  private _column_ids: number[] = [];

  constructor(
    id: ArchetypeID,
    mask: BitSet,
    layouts?: ArchetypeColumnLayout[],
  ) {
    this.id = id;
    this.mask = mask;

    if (layouts) {
      for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        const columns: number[][] = new Array(layout.field_names.length);
        for (let j = 0; j < layout.field_names.length; j++) {
          columns[j] = [];
        }
        // Build a named record { fieldName: column } so Query.each() can pass
        // e.g. { x: number[], y: number[] } directly to the system callback
        const record: Record<string, number[]> = Object.create(null);
        for (let k = 0; k < layout.field_names.length; k++) {
          record[layout.field_names[k]] = columns[k];
        }
        this.column_groups[layout.component_id as number] = {
          layout,
          columns,
          record,
        };
        this._column_ids.push(layout.component_id as number);
      }
    }

    this.has_columns = this._column_ids.length > 0;
  }

  public get entity_count(): number {
    return this.length;
  }

  public get entity_list(): readonly EntityID[] {
    return this.entity_ids;
  }

  public has_component(id: ComponentID): boolean {
    return this.mask.has(id);
  }

  public matches(required: BitSet): boolean {
    return this.mask.contains(required);
  }

  /** Get a single field's column. Valid data: indices 0..entity_count-1. */
  public get_column<F extends ComponentFields, Field extends F[number]>(
    def: ComponentDef<F>,
    field: Field,
  ): number[] {
    const group = this.column_groups[def as unknown as number];
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

  /** Get all columns for a component as { fieldName: number[] }. */
  public get_column_group<F extends ComponentFields>(
    def: ComponentDef<F>,
  ): ColumnsForSchema<F> {
    const group = this.column_groups[def as unknown as number];
    if (!group) return {} as ColumnsForSchema<F>;
    return group.record as unknown as ColumnsForSchema<F>;
  }

  public write_fields(
    row: number,
    component_id: ComponentID,
    values: Record<string, number>,
  ): void {
    const group = this.column_groups[component_id as number];
    if (!group) return;
    const { field_names } = group.layout;
    for (let i = 0; i < field_names.length; i++) {
      group.columns[i][row] = values[field_names[i]];
    }
  }

  public read_field(
    row: number,
    component_id: ComponentID,
    field: string,
  ): number {
    const group = this.column_groups[component_id as number];
    if (!group) return NaN;
    const col_idx = group.layout.field_index[field];
    if (col_idx === undefined) return NaN;
    return group.columns[col_idx][row] ?? NaN;
  }

  /** Copy all shared component columns from source archetype at src_row into dst_row. */
  public copy_shared_from(
    source: Archetype,
    src_row: number,
    dst_row: number,
  ): void {
    const src_groups = source.column_groups;
    // Only iterate _column_ids (components with data) in this target archetype.
    // If source doesn't have that component, skip — only shared columns are copied.
    const ids = this._column_ids;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const src_group = src_groups[id];
      if (!src_group) continue;
      const dst_group = this.column_groups[id]!;
      for (let j = 0; j < dst_group.columns.length; j++) {
        dst_group.columns[j][dst_row] = src_group.columns[j][src_row];
      }
    }
  }

  /**
   * Add an entity. Pushes zeroes into all columns and returns the assigned row.
   * Store is responsible for tracking entity_index → row.
   */
  public add_entity(entity_id: EntityID): number {
    const row = this.length;
    this.entity_ids.push(entity_id);
    const ids = this._column_ids;
    for (let i = 0; i < ids.length; i++) {
      const group = this.column_groups[ids[i]]!;
      for (let j = 0; j < group.columns.length; j++) {
        group.columns[j].push(0);
      }
    }
    this.length++;
    return row;
  }

  /**
   * Remove entity at row via swap-and-pop. Swaps the last entity into the
   * vacated row to keep data dense. Returns the entity_index of the swapped
   * entity (so Store can update its row), or -1 if no swap was needed.
   */
  public remove_entity(row: number): number {
    const last_row = this.length - 1;
    let swapped_entity_index = -1;

    if (row !== last_row) {
      // Swap: move last entity's data into the vacated row
      this.entity_ids[row] = this.entity_ids[last_row];
      swapped_entity_index = get_entity_index(this.entity_ids[row]);
      const ids = this._column_ids;
      for (let i = 0; i < ids.length; i++) {
        const group = this.column_groups[ids[i]]!;
        for (let j = 0; j < group.columns.length; j++) {
          group.columns[j][row] = group.columns[j][last_row];
        }
      }
    }

    // Pop: remove the last slot
    this.entity_ids.pop();
    const ids = this._column_ids;
    for (let i = 0; i < ids.length; i++) {
      const group = this.column_groups[ids[i]]!;
      for (let j = 0; j < group.columns.length; j++) {
        group.columns[j].pop();
      }
    }
    this.length--;
    return swapped_entity_index;
  }

  /** Tag-optimized add: skip column push entirely (no data to store). */
  public add_entity_tag(entity_id: EntityID): number {
    const row = this.length;
    this.entity_ids.push(entity_id);
    this.length++;
    return row;
  }

  /** Tag-optimized remove via swap-and-pop: skip column swap/pop entirely. */
  public remove_entity_tag(row: number): number {
    const last_row = this.length - 1;
    let swapped_entity_index = -1;

    if (row !== last_row) {
      this.entity_ids[row] = this.entity_ids[last_row];
      swapped_entity_index = get_entity_index(this.entity_ids[row]);
    }

    this.entity_ids.pop();
    this.length--;
    return swapped_entity_index;
  }

  public get_edge(component_id: ComponentID): ArchetypeEdge | undefined {
    return this.edges[component_id];
  }

  public set_edge(component_id: ComponentID, edge: ArchetypeEdge): void {
    this.edges[component_id] = edge;
  }
}
