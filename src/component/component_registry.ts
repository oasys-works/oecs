/***
 *
 * ComponentRegistry - Schema-only registry for component definitions
 *
 * Tracks component schemas and assigns ComponentIDs. No longer owns
 * component data — that lives in archetype-local dense columns.
 *
 ***/

import type { TypeTag } from "type_primitives";
import { unsafe_cast } from "type_primitives";
import {
  as_component_id,
  type ComponentDef,
  type ComponentID,
  type ComponentSchema,
} from "./component";
import { ECS_ERROR, ECSError } from "../utils/error";

//=========================================================
// Internal types
//=========================================================

interface ComponentMeta {
  schema: ComponentSchema;
  field_names: string[];
  field_tags: TypeTag[];
  field_index: Record<string, number>;
}

//=========================================================
// ComponentRegistry
//=========================================================

export class ComponentRegistry {
  private metas: ComponentMeta[] = [];
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
    return this.metas[id].schema;
  }

  /** Get field names for a registered component. */
  public get_field_names(id: ComponentID): string[] {
    if (__DEV__) {
      if (id < 0 || id >= this.component_count) {
        throw new ECSError(ECS_ERROR.COMPONENT_NOT_REGISTERED);
      }
    }
    return this.metas[id].field_names;
  }

  /** Get field type tags for a registered component. */
  public get_field_tags(id: ComponentID): TypeTag[] {
    if (__DEV__) {
      if (id < 0 || id >= this.component_count) {
        throw new ECSError(ECS_ERROR.COMPONENT_NOT_REGISTERED);
      }
    }
    return this.metas[id].field_tags;
  }

  /** Get field name → index mapping for a registered component. */
  public get_field_index(id: ComponentID): Record<string, number> {
    if (__DEV__) {
      if (id < 0 || id >= this.component_count) {
        throw new ECSError(ECS_ERROR.COMPONENT_NOT_REGISTERED);
      }
    }
    return this.metas[id].field_index;
  }

  //=========================================================
  // Registration
  //=========================================================

  /**
   * Register a new component schema.
   *
   * Allocates a ComponentID and records schema metadata.
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

    const field_index: Record<string, number> = Object.create(null);
    for (let i = 0; i < field_names.length; i++) {
      field_index[field_names[i]] = i;
    }

    this.metas.push({
      schema,
      field_names,
      field_tags,
      field_index,
    });

    return unsafe_cast<ComponentDef<S>>(id);
  }
}
