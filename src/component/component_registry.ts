/***
 *
 * ComponentRegistry - Manages schema-defined components backed by typed arrays
 *
 * Each registered component gets a set of parallel typed arrays (one per field)
 * indexed by entity index. This gives cache-friendly, allocation-free access
 * for systems iterating over component data.
 *
 * Follows the same patterns as EntityRegistry: initial capacity, doubling
 * growth, dev-mode assertions.
 *
 ***/

import type { TypeTag } from "type_primitives";
import {
  TYPED_ARRAY_MAP,
  type TypedArrayFor,
  type TypedArray,
} from "type_primitives";
import { unsafe_cast } from "type_primitives";
import { get_entity_index, type EntityID } from "../entity/entity";
import {
  as_component_id,
  type ComponentDef,
  type ComponentID,
  type ComponentSchema,
  type SchemaValues,
} from "./component";
import { ECS_ERROR, ECSError } from "../utils/error";

//=========================================================
// Internal types
//=========================================================

interface ComponentStore {
  schema: ComponentSchema;
  field_names: string[];
  field_tags: TypeTag[];
  columns: TypedArray[];
  field_index: Record<string, number>;
  capacity: number;
}

//=========================================================
// Constants
//=========================================================

const INITIAL_CAPACITY = 64;

// Poison values written on clear so stale reads are self-revealing.
// NaN propagates through arithmetic; all-bits-set integers are
// recognisably invalid (max unsigned / -1 signed).
const POISON_VALUES: Readonly<Record<TypeTag, number>> = {
  f32: NaN,
  f64: NaN,
  u8: 0xff,
  u16: 0xffff,
  u32: 0xffffffff,
  i8: -1,
  i16: -1,
  i32: -1,
};

//=========================================================
// ComponentRegistry
//=========================================================

export class ComponentRegistry {
  private stores: ComponentStore[] = [];
  private component_count = 0;

  //=========================================================
  // Queries
  //=========================================================

  /** Number of registered components. */
  public get count(): number {
    return this.component_count;
  }

  /** Get the schema for a registered component. */
  public get_schema(id: ComponentID): ComponentSchema {
    if (__DEV__) {
      if (id < 0 || id >= this.component_count) {
        throw new ECSError(ECS_ERROR.COMPONENT_NOT_REGISTERED);
      }
    }
    return this.stores[id].schema;
  }

  //=========================================================
  // Registration
  //=========================================================

  /**
   * Register a new component schema.
   *
   * Allocates a ComponentID and creates typed arrays for each field.
   * Returns a phantom-typed ComponentDef so that get/set calls
   * carry the schema at compile-time.
   *
   * Tag components (empty schema) are valid - they create no columns
   * and exist purely as markers for archetype grouping.
   */
  public register<S extends ComponentSchema>(schema: S): ComponentDef<S> {
    const id = as_component_id(this.component_count++);

    const field_names = Object.keys(schema);
    const field_tags = field_names.map((name) => schema[name]);
    const columns = field_tags.map(
      (tag) => new TYPED_ARRAY_MAP[tag](INITIAL_CAPACITY),
    );

    const field_index: Record<string, number> = Object.create(null);
    for (let i = 0; i < field_names.length; i++) {
      field_index[field_names[i]] = i;
    }

    this.stores.push({
      schema,
      field_names,
      field_tags,
      columns,
      field_index,
      capacity: INITIAL_CAPACITY,
    });

    return unsafe_cast<ComponentDef<S>>(id);
  }

  //=========================================================
  // Bulk set
  //=========================================================

  /** Set all fields for a component on an entity. */
  public set<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
    values: SchemaValues<S>,
  ): void {
    const index = get_entity_index(entity_id);
    const store = this.stores[def];

    if (index >= store.capacity) {
      this.grow_store(store, index + 1);
    }

    for (let i = 0; i < store.field_names.length; i++) {
      store.columns[i][index] = values[store.field_names[i]];
    }
  }

  //=========================================================
  // Single-field access (hot path, zero allocation)
  //=========================================================

  /** Set a single field value. Zero allocation. */
  public set_field<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
    field: keyof S & string,
    value: number,
  ): void {
    const index = get_entity_index(entity_id);
    const store = this.stores[def];

    if (index >= store.capacity) {
      this.grow_store(store, index + 1);
    }

    const col = store.field_index[field];
    if (col === undefined) {
      if (__DEV__) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Field "${field}" does not exist on component`,
        );
      }
      return;
    }
    store.columns[col][index] = value;
  }

  /** Get a single field value. Zero allocation. */
  public get_field<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
    field: keyof S & string,
  ): number {
    const index = get_entity_index(entity_id);
    const store = this.stores[def];

    const col = store.field_index[field];
    if (col === undefined) {
      if (__DEV__) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Field "${field}" does not exist on component`,
        );
      }
      return NaN;
    }

    if (index >= store.capacity) return NaN;

    return store.columns[col][index];
  }

  //=========================================================
  // Raw column access (batch iteration in systems)
  //=========================================================

  /** Get the raw typed array for a field. Systems use this for batch processing. */
  public get_column<S extends ComponentSchema, F extends keyof S & string>(
    def: ComponentDef<S>,
    field: F,
  ): TypedArrayFor<S[F]> {
    const store = this.stores[def];
    const col = store.field_index[field];

    if (col === undefined) {
      if (__DEV__) {
        throw new ECSError(
          ECS_ERROR.COMPONENT_NOT_REGISTERED,
          `Field "${field}" does not exist on component`,
        );
      }
      return new Float32Array(0) as TypedArrayFor<S[F]>;
    }

    return store.columns[col] as TypedArrayFor<S[F]>;
  }

  //=========================================================
  // Data cleanup
  //=========================================================

  /**
   * Poison all fields for a component at the given entity index.
   *
   * Writes type-appropriate poison values (NaN for floats, all-bits-set
   * for integers) so that any stale read produces obviously wrong data
   * rather than silently returning zero.
   */
  public clear(component_id: ComponentID, entity_index: number): void {
    const store = this.stores[component_id];
    if (entity_index >= store.capacity) return;
    for (let i = 0; i < store.columns.length; i++) {
      store.columns[i][entity_index] = POISON_VALUES[store.field_tags[i]];
    }
  }

  //=========================================================
  // Capacity management
  //=========================================================

  /**
   * Ensure all component columns can hold at least `entity_capacity` entries.
   *
   * Iterates stores and grows only those whose capacity is below the
   * requested minimum. Use as a bulk pre-allocation hint.
   */
  public ensure_capacity(entity_capacity: number): void {
    for (let i = 0; i < this.stores.length; i++) {
      if (this.stores[i].capacity < entity_capacity) {
        this.grow_store(this.stores[i], entity_capacity);
      }
    }
  }

  /**
   * Grow a single store's columns to hold at least `min_capacity` entries.
   *
   * Doubles the store's capacity until it meets the requirement, then
   * reallocates every column and copies existing data.
   */
  private grow_store(store: ComponentStore, min_capacity: number): void {
    let new_capacity = store.capacity;
    while (new_capacity < min_capacity) {
      new_capacity *= 2;
    }

    for (let i = 0; i < store.columns.length; i++) {
      const old_column = store.columns[i];
      const new_column = new TYPED_ARRAY_MAP[store.field_tags[i]](new_capacity);
      new_column.set(old_column);
      store.columns[i] = new_column;
    }

    store.capacity = new_capacity;
  }
}
