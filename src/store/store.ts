/***
 *
 * Store - Top-level ECS orchestrator.
 * Owns all state: entity ID management, component metadata, and archetypes.
 *
 ***/

import {
  get_entity_index,
  get_entity_generation,
  create_entity_id,
  MAX_GENERATION,
  type EntityID,
} from "../entity/entity";
import {
  as_component_id,
  type ComponentDef,
  type ComponentID,
  type ComponentFields,
  type FieldValues,
} from "../component/component";
import { unsafe_cast } from "type_primitives";
import type { Archetype, ArchetypeID } from "../archetype/archetype";
import { ArchetypeRegistry, type ComponentMeta } from "../archetype/archetype_registry";
import { ECS_ERROR, ECSError } from "../utils/error";
import type { BitSet } from "type_primitives";

//=========================================================
// Constants
//=========================================================

const UNASSIGNED = -1;
const INITIAL_CAPACITY = 256;

//=========================================================
// Store
//=========================================================

export class Store {
  // Entity ID management (was EntityRegistry)
  private entity_generations: number[] = [];
  private entity_high_water = 0;
  private entity_free_indices: number[] = [];
  private entity_alive_count = 0;

  // Component metadata (was ComponentRegistry)
  private component_metas: ComponentMeta[] = [];
  private component_count = 0;

  private archetype_registry: ArchetypeRegistry;

  // entity_index → ArchetypeID (-1 = unassigned). Grown geometrically.
  private entity_archetype: Int32Array = new Int32Array(INITIAL_CAPACITY).fill(UNASSIGNED);
  // entity_index → row within its archetype (-1 = unassigned). Grown geometrically.
  private entity_row: Int32Array = new Int32Array(INITIAL_CAPACITY).fill(UNASSIGNED);
  private entity_capacity: number = INITIAL_CAPACITY;

  // Deferred destruction buffer
  private pending_destroy: EntityID[] = [];

  // Deferred structural change buffers — flat parallel arrays (no per-op allocation)
  private pending_add_ids: EntityID[] = [];
  private pending_add_defs: ComponentDef<ComponentFields>[] = [];
  private pending_add_values: Record<string, number>[] = [];
  private pending_remove_ids: EntityID[] = [];
  private pending_remove_defs: ComponentDef<ComponentFields>[] = [];

  constructor() {
    this.archetype_registry = new ArchetypeRegistry(this.component_metas);
  }

  //=========================================================
  // Internal: capacity management
  //=========================================================

  private ensure_entity_capacity(index: number): void {
    if (index < this.entity_capacity) return;
    let cap = this.entity_capacity;
    while (cap <= index) cap *= 2;
    const new_arch = new Int32Array(cap).fill(UNASSIGNED);
    const new_row  = new Int32Array(cap).fill(UNASSIGNED);
    new_arch.set(this.entity_archetype);
    new_row.set(this.entity_row);
    this.entity_archetype = new_arch;
    this.entity_row = new_row;
    this.entity_capacity = cap;
  }

  //=========================================================
  // Entity lifecycle
  //=========================================================

  public create_entity(): EntityID {
    let index: number;
    let generation: number;

    if (this.entity_free_indices.length > 0) {
      index = this.entity_free_indices.pop()!;
      generation = this.entity_generations[index];
    } else {
      index = this.entity_high_water++;
      this.entity_generations[index] = 0;
      generation = 0;
    }

    this.entity_alive_count++;
    const id = create_entity_id(index, generation);

    this.ensure_entity_capacity(index);
    this.entity_archetype[index] = this.archetype_registry.empty_archetype_id;
    this.entity_row[index] = UNASSIGNED;

    return id;
  }

  public destroy_entity(id: EntityID): void {
    if (!this.is_alive(id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const index = get_entity_index(id);
    const row = this.entity_row[index];

    if (row !== UNASSIGNED) {
      const arch = this.archetype_registry.get(this.entity_archetype[index] as ArchetypeID);
      const swapped_idx = arch.remove_entity(row);
      if (swapped_idx !== -1) this.entity_row[swapped_idx] = row;
    }

    this.entity_archetype[index] = UNASSIGNED;
    this.entity_row[index] = UNASSIGNED;

    const generation = get_entity_generation(id);
    this.entity_generations[index] = (generation + 1) & MAX_GENERATION;
    this.entity_free_indices.push(index);
    this.entity_alive_count--;
  }

  public is_alive(id: EntityID): boolean {
    const index = get_entity_index(id);
    return (
      index < this.entity_high_water &&
      this.entity_generations[index] === get_entity_generation(id)
    );
  }

  public get entity_count(): number {
    return this.entity_alive_count;
  }

  //=========================================================
  // Deferred destruction
  //=========================================================

  public destroy_entity_deferred(id: EntityID): void {
    if (__DEV__ && !this.is_alive(id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_destroy.push(id);
  }

  public flush_destroyed(): void {
    const buf = this.pending_destroy;
    if (buf.length === 0) return;
    for (let i = 0; i < buf.length; i++) {
      if (this.is_alive(buf[i])) {
        this.destroy_entity(buf[i]);
      }
    }
    buf.length = 0;
  }

  public get pending_destroy_count(): number {
    return this.pending_destroy.length;
  }

  //=========================================================
  // Deferred structural changes
  //=========================================================

  public add_component_deferred<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): void {
    if (__DEV__ && !this.is_alive(entity_id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_add_ids.push(entity_id);
    this.pending_add_defs.push(def);
    this.pending_add_values.push(values as Record<string, number>);
  }

  public remove_component_deferred(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): void {
    if (__DEV__ && !this.is_alive(entity_id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_remove_ids.push(entity_id);
    this.pending_remove_defs.push(def);
  }

  public flush_structural(): void {
    const n_add = this.pending_add_ids.length;
    const n_rem = this.pending_remove_ids.length;
    if (n_add === 0 && n_rem === 0) return;

    for (let i = 0; i < n_add; i++) {
      if (this.is_alive(this.pending_add_ids[i])) {
        this.add_component(this.pending_add_ids[i], this.pending_add_defs[i], this.pending_add_values[i]);
      }
    }
    this.pending_add_ids.length = 0;
    this.pending_add_defs.length = 0;
    this.pending_add_values.length = 0;

    for (let i = 0; i < n_rem; i++) {
      if (this.is_alive(this.pending_remove_ids[i])) {
        this.remove_component(this.pending_remove_ids[i], this.pending_remove_defs[i]);
      }
    }
    this.pending_remove_ids.length = 0;
    this.pending_remove_defs.length = 0;
  }

  public get pending_structural_count(): number {
    return this.pending_add_ids.length + this.pending_remove_ids.length;
  }

  //=========================================================
  // Component registration
  //=========================================================

  public register_component<F extends readonly string[]>(fields: F): ComponentDef<F> {
    const id = as_component_id(this.component_count++);
    const field_names = fields as unknown as string[];
    const field_index: Record<string, number> = Object.create(null);
    for (let i = 0; i < field_names.length; i++) {
      field_index[field_names[i]] = i;
    }
    this.component_metas.push({ field_names, field_index });
    return unsafe_cast<ComponentDef<F>>(id);
  }

  //=========================================================
  // Component operations
  //=========================================================

  public add_component<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[entity_index] as ArchetypeID;
    const current_arch = this.archetype_registry.get(current_archetype_id);

    // Already has component → overwrite in-place (no transition)
    if (current_arch.has_component(def)) {
      current_arch.write_fields(
        this.entity_row[entity_index],
        def as ComponentID,
        values as Record<string, number>,
      );
      return;
    }

    const target_archetype_id = this.archetype_registry.resolve_add(current_archetype_id, def);
    const target_arch = this.archetype_registry.get(target_archetype_id);

    const src_row = this.entity_row[entity_index];
    const dst_row = target_arch.add_entity(entity_id);

    if (src_row !== UNASSIGNED) {
      target_arch.copy_shared_from(current_arch, src_row, dst_row);
      const swapped_idx = current_arch.remove_entity(src_row);
      if (swapped_idx !== -1) this.entity_row[swapped_idx] = src_row;
    }
    target_arch.write_fields(dst_row, def as ComponentID, values as Record<string, number>);

    this.entity_archetype[entity_index] = target_archetype_id;
    this.entity_row[entity_index] = dst_row;
  }

  public add_components(
    entity_id: EntityID,
    entries: { def: ComponentDef<ComponentFields>; values: Record<string, number> }[],
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[entity_index] as ArchetypeID;

    // Resolve final archetype through all adds
    let target_archetype_id: ArchetypeID = current_archetype_id;
    for (let i = 0; i < entries.length; i++) {
      target_archetype_id = this.archetype_registry.resolve_add(target_archetype_id, entries[i].def);
    }

    if (target_archetype_id !== current_archetype_id) {
      const source_arch = this.archetype_registry.get(current_archetype_id);
      const target_arch = this.archetype_registry.get(target_archetype_id);

      const src_row = this.entity_row[entity_index];
      const dst_row = target_arch.add_entity(entity_id);

      if (src_row !== UNASSIGNED) {
        target_arch.copy_shared_from(source_arch, src_row, dst_row);
        const swapped_idx = source_arch.remove_entity(src_row);
        if (swapped_idx !== -1) this.entity_row[swapped_idx] = src_row;
      }
      for (let i = 0; i < entries.length; i++) {
        target_arch.write_fields(dst_row, entries[i].def as ComponentID, entries[i].values);
      }

      this.entity_archetype[entity_index] = target_archetype_id;
      this.entity_row[entity_index] = dst_row;
    } else {
      // All components already present — overwrite in-place
      const arch = this.archetype_registry.get(current_archetype_id);
      const row = this.entity_row[entity_index];
      for (let i = 0; i < entries.length; i++) {
        arch.write_fields(row, entries[i].def as ComponentID, entries[i].values);
      }
    }
  }

  public remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[entity_index] as ArchetypeID;
    const current_arch = this.archetype_registry.get(current_archetype_id);

    if (!current_arch.has_component(def)) return;

    const target_archetype_id = this.archetype_registry.resolve_remove(current_archetype_id, def);
    const target_arch = this.archetype_registry.get(target_archetype_id);

    const src_row = this.entity_row[entity_index];
    const dst_row = target_arch.add_entity(entity_id);

    target_arch.copy_shared_from(current_arch, src_row, dst_row);

    const swapped_idx = current_arch.remove_entity(src_row);
    if (swapped_idx !== -1) this.entity_row[swapped_idx] = src_row;

    this.entity_archetype[entity_index] = target_archetype_id;
    this.entity_row[entity_index] = dst_row;
  }

  public has_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
  ): boolean {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return false;
    }
    const entity_index = get_entity_index(entity_id);
    return this.archetype_registry.get(this.entity_archetype[entity_index] as ArchetypeID).has_component(def);
  }

  //=========================================================
  // Direct data access
  //=========================================================

  public get_entity_archetype(entity_id: EntityID): Archetype {
    return this.archetype_registry.get(
      this.entity_archetype[get_entity_index(entity_id)] as ArchetypeID
    );
  }

  public get_entity_row(entity_id: EntityID): number {
    return this.entity_row[get_entity_index(entity_id)];
  }

  //=========================================================
  // Query support (delegated to ArchetypeRegistry)
  //=========================================================

  public get_matching_archetypes(required: BitSet): readonly Archetype[] {
    return this.archetype_registry.get_matching(required);
  }

  public register_query(mask: BitSet, exclude_mask?: BitSet, any_of?: BitSet): Archetype[] {
    return this.archetype_registry.register_query(mask, exclude_mask, any_of);
  }

  get archetype_count(): number {
    return this.archetype_registry.count;
  }

}
