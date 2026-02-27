/***
 * Archetype — Dense entity grouping by component signature.
 *
 * An archetype represents a unique combination of components (its "mask").
 * All entities sharing the exact same set of components live in the same
 * archetype. Data is stored in Structure-of-Arrays (SoA) layout: each
 * component field gets its own typed array column, and entity i's data is
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
  GrowableTypedArray,
  GrowableUint32Array,
  TypedArrayFor,
  type AnyTypedArray,
  type TypedArrayTag,
} from "type_primitives";
import type {
  ComponentID,
  ComponentDef,
  ComponentSchema,
  TagToTypedArray,
} from "./component";
import { get_entity_index, type EntityID } from "./entity";
import { ECS_ERROR, ECSError } from "./utils/error";
import { NO_SWAP, DEFAULT_COLUMN_CAPACITY } from "./utils/constants";
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
  /** Pre-computed column mapping for add direction: this → add target. */
  add_map: Int16Array | null;
  /** Pre-computed column mapping for remove direction: this → remove target. */
  remove_map: Int16Array | null;
}

export interface ArchetypeColumnLayout {
  component_id: ComponentID;
  field_names: string[];
  field_index: Record<string, number>;
  field_types: TypedArrayTag[];
}

interface ArchetypeColumnGroup {
  layout: ArchetypeColumnLayout;
  columns: GrowableTypedArray<AnyTypedArray>[];
}

export class Archetype {
  readonly id: ArchetypeID;
  readonly mask: BitSet;
  readonly has_columns: boolean;

  private readonly _entity_ids: GrowableUint32Array;
  public length: number = 0;
  private readonly edges: ArchetypeEdge[] = [];

  // --- Flat column storage ---
  // Dense array of ALL columns across all components in this archetype.
  readonly _flat_columns: GrowableTypedArray<AnyTypedArray>[] = [];
  // Sparse by ComponentID → starting index into _flat_columns.
  readonly _col_offset: number[] = [];
  // Sparse by ComponentID → number of fields for that component.
  readonly _field_count: number[] = [];
  // Sparse by ComponentID → field_index record (field name → offset within component).
  private readonly _field_index: Record<string, number>[] = [];
  // Sparse by ComponentID → field_names array.
  private readonly _field_names: string[][] = [];

  // Sparse array indexed by ComponentID — kept for create_ref compatibility.
  readonly column_groups: (ArchetypeColumnGroup | undefined)[] = [];
  // Dense list of ComponentIDs that have columns — used for copy_shared_from.
  readonly _column_ids: number[] = [];

  constructor(
    id: ArchetypeID,
    mask: BitSet,
    layouts?: ArchetypeColumnLayout[],
    initial_capacity: number = DEFAULT_COLUMN_CAPACITY,
  ) {
    this.id = id;
    this.mask = mask;
    this._entity_ids = new GrowableUint32Array(initial_capacity);

    if (layouts) {
      let flat_idx = 0;
      for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        const cid = layout.component_id as number;
        const columns: GrowableTypedArray<AnyTypedArray>[] = new Array(layout.field_names.length);

        this._col_offset[cid] = flat_idx;
        this._field_count[cid] = layout.field_names.length;
        this._field_index[cid] = layout.field_index;
        this._field_names[cid] = layout.field_names;

        for (let j = 0; j < layout.field_names.length; j++) {
          const col = new (TypedArrayFor[layout.field_types[j]])(initial_capacity);
          columns[j] = col;
          this._flat_columns[flat_idx++] = col;
        }

        this.column_groups[cid] = { layout, columns };
        this._column_ids.push(cid);
      }
    }

    this.has_columns = this._column_ids.length > 0;
  }

  public get entity_count(): number {
    return this.length;
  }

  /** Raw entity ID buffer. Valid data at indices 0..entity_count-1. */
  public get entity_ids(): Uint32Array {
    return this._entity_ids.buf;
  }

  public get entity_list(): Uint32Array {
    return this._entity_ids.view();
  }

  public has_component(id: ComponentID): boolean {
    return this.mask.has(id);
  }

  public matches(required: BitSet): boolean {
    return this.mask.contains(required);
  }

  /** Get a single field's column. Valid data: indices 0..entity_count-1. */
  public get_column<S extends ComponentSchema, K extends string & keyof S>(
    def: ComponentDef<S>,
    field: K,
  ): TagToTypedArray[S[K]] {
    const cid = def as unknown as number;
    if (__DEV__) {
      if (this._col_offset[cid] === undefined) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Component ${def} not in archetype ${this.id}`,
        );
      }
    }
    const fi = this._field_index[cid][field];
    if (__DEV__) {
      if (fi === undefined) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Field "${field}" does not exist on component`,
        );
      }
    }
    return this._flat_columns[this._col_offset[cid] + fi].buf as TagToTypedArray[S[K]];
  }

  public write_fields(
    row: number,
    component_id: ComponentID,
    values: Record<string, number>,
  ): void {
    const cid = component_id as number;
    const offset = this._col_offset[cid];
    if (offset === undefined) return;
    const names = this._field_names[cid];
    const cols = this._flat_columns;
    for (let i = 0; i < names.length; i++) {
      cols[offset + i].buf[row] = values[names[i]];
    }
  }

  /** Fast positional write: values[i] → field[i] in declaration order. No string lookup. */
  public write_fields_positional(
    row: number,
    component_id: ComponentID,
    values: ArrayLike<number>,
  ): void {
    const cid = component_id as number;
    const offset = this._col_offset[cid];
    if (offset === undefined) return;
    const cols = this._flat_columns;
    for (let i = 0; i < values.length; i++) {
      cols[offset + i].buf[row] = values[i];
    }
  }

  public read_field(
    row: number,
    component_id: ComponentID,
    field: string,
  ): number {
    const cid = component_id as number;
    const offset = this._col_offset[cid];
    if (offset === undefined) return NaN;
    const fi = this._field_index[cid][field];
    if (fi === undefined) return NaN;
    return this._flat_columns[offset + fi].buf[row];
  }

  /** Copy all shared component columns from source archetype at src_row into dst_row. */
  public copy_shared_from(
    source: Archetype,
    src_row: number,
    dst_row: number,
  ): void {
    const src_offsets = source._col_offset;
    const src_fcounts = source._field_count;
    const src_cols = source._flat_columns;
    const dst_cols = this._flat_columns;
    const ids = this._column_ids;
    for (let i = 0; i < ids.length; i++) {
      const cid = ids[i];
      const src_off = src_offsets[cid];
      if (src_off === undefined) continue;
      const dst_off = this._col_offset[cid];
      const fc = src_fcounts[cid];
      for (let j = 0; j < fc; j++) {
        dst_cols[dst_off + j].buf[dst_row] = src_cols[src_off + j].buf[src_row];
      }
    }
  }

  /**
   * Add an entity. Pushes zeroes into all columns and returns the assigned row.
   * Store is responsible for tracking entity_index → row.
   */
  public add_entity(entity_id: EntityID): number {
    const row = this.length;
    this._entity_ids.push(entity_id as number);
    const cols = this._flat_columns;
    for (let i = 0; i < cols.length; i++) {
      cols[i].push(0);
    }
    this.length++;
    return row;
  }

  /**
   * Remove entity at row via swap-and-pop. Swaps the last entity into the
   * vacated row to keep data dense. Returns the entity_index of the swapped
   * entity (so Store can update its row), or NO_SWAP if no swap was needed.
   */
  public remove_entity(row: number): number {
    const last_row = this.length - 1;
    let swapped_entity_index = NO_SWAP;
    const cols = this._flat_columns;
    const eids = this._entity_ids.buf;

    if (row !== last_row) {
      eids[row] = eids[last_row];
      swapped_entity_index = get_entity_index(eids[row] as EntityID);
      for (let i = 0; i < cols.length; i++) {
        cols[i].swap_remove(row);
      }
    } else {
      for (let i = 0; i < cols.length; i++) {
        cols[i].pop();
      }
    }

    this._entity_ids.pop();
    this.length--;
    return swapped_entity_index;
  }

  /** Tag-optimized add: skip column push entirely (no data to store). */
  public add_entity_tag(entity_id: EntityID): number {
    const row = this.length;
    this._entity_ids.push(entity_id as number);
    this.length++;
    return row;
  }

  /** Tag-optimized remove via swap-and-pop: skip column swap/pop entirely. */
  public remove_entity_tag(row: number): number {
    const last_row = this.length - 1;
    let swapped_entity_index = NO_SWAP;
    const eids = this._entity_ids.buf;

    if (row !== last_row) {
      eids[row] = eids[last_row];
      swapped_entity_index = get_entity_index(eids[row] as EntityID);
    }

    this._entity_ids.pop();
    this.length--;
    return swapped_entity_index;
  }

  /**
   * Move an entity from src archetype into this archetype in a single pass.
   * Combines add_entity + copy_shared_from + remove_entity(src).
   * Uses a pre-computed transition map for branchless column copy.
   * Writes dst_row to _move_result[0], swapped entity index to _move_result[1].
   */
  public move_entity_from(
    src: Archetype,
    src_row: number,
    entity_id: EntityID,
    transition_map: Int16Array,
  ): void {
    const dst_row = this.length;
    this._entity_ids.push(entity_id as number);

    const dst_cols = this._flat_columns;
    const src_cols = src._flat_columns;

    // Single pass: push from src or push 0 for new columns
    for (let i = 0; i < dst_cols.length; i++) {
      const si = transition_map[i];
      dst_cols[i].push(si >= 0 ? src_cols[si].buf[src_row] : 0);
    }

    this.length++;

    // Swap-remove entity from source
    const sw = src.has_columns
      ? src.remove_entity(src_row)
      : src.remove_entity_tag(src_row);

    _move_result[0] = dst_row;
    _move_result[1] = sw;
  }

  /**
   * Move an entity from src into this archetype (tag-only: no columns to copy).
   * Writes dst_row to _move_result[0], swapped entity index to _move_result[1].
   */
  public move_entity_from_tag(
    src: Archetype,
    src_row: number,
    entity_id: EntityID,
  ): void {
    const dst_row = this.length;
    this._entity_ids.push(entity_id as number);
    this.length++;

    const sw = src.remove_entity_tag(src_row);

    _move_result[0] = dst_row;
    _move_result[1] = sw;
  }

  /**
   * Bulk-move ALL entities from src into this archetype using TypedArray.set().
   * Much faster than per-entity move_entity_from when the entire source is moving.
   * After this call, src is empty. Returns the starting dst_row for the batch.
   */
  public bulk_move_all_from(
    src: Archetype,
    transition_map: Int16Array,
  ): number {
    const count = src.length;
    if (count === 0) return this.length;

    const dst_start = this.length;
    const dst_cols = this._flat_columns;
    const src_cols = src._flat_columns;

    // Bulk copy entity IDs
    this._entity_ids.bulk_append(src._entity_ids.buf, 0, count);

    // Bulk copy columns using TypedArray.set()
    for (let i = 0; i < dst_cols.length; i++) {
      const si = transition_map[i];
      if (si >= 0) {
        dst_cols[i].bulk_append(src_cols[si].buf as any, 0, count);
      } else {
        dst_cols[i].bulk_append_zeroes(count);
      }
    }

    this.length += count;

    // Clear source archetype
    src.length = 0;
    src._entity_ids.clear();
    for (let i = 0; i < src_cols.length; i++) {
      src_cols[i].clear();
    }

    return dst_start;
  }

  public get_edge(component_id: ComponentID): ArchetypeEdge | undefined {
    return this.edges[component_id];
  }

  public set_edge(component_id: ComponentID, edge: ArchetypeEdge): void {
    this.edges[component_id] = edge;
  }
}

/** Reusable result buffer for move_entity_from/move_entity_from_tag. [dst_row, swapped_index] */
export const _move_result: [number, number] = [0, NO_SWAP];

/**
 * Build a transition map from src archetype to dst archetype.
 * For each column in dst, stores the index of the corresponding column in src,
 * or -1 if the column is new (no source).
 */
export function build_transition_map(src: Archetype, dst: Archetype): Int16Array {
  const dst_cols = dst._flat_columns;
  const map = new Int16Array(dst_cols.length);

  const dst_ids = dst._column_ids;
  const src_offsets = src._col_offset;
  const dst_offsets = dst._col_offset;
  const dst_fcounts = dst._field_count;

  for (let i = 0; i < dst_ids.length; i++) {
    const cid = dst_ids[i];
    const dst_off = dst_offsets[cid];
    const fc = dst_fcounts[cid];
    const src_off = src_offsets[cid];

    if (src_off !== undefined) {
      // Shared component: map each dst column to its src counterpart
      for (let j = 0; j < fc; j++) {
        map[dst_off + j] = src_off + j;
      }
    } else {
      // New component: no source
      for (let j = 0; j < fc; j++) {
        map[dst_off + j] = -1;
      }
    }
  }

  return map;
}
