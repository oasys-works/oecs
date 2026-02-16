/***
 *
 * Store - Top-level ECS orchestrator
 *
 * The Store owns all registries and delegates archetype operations to
 * ArchetypeRegistry. It is the single entry point for entity/component
 * operations. Archetypes are lazily created when a new component
 * combination appears, never explicitly by external code.
 *
 * Key architectural win: zero-cost archetype transitions. Since
 * ComponentRegistry indexes data by entity index (not by archetype row),
 * moving an entity between archetypes only changes membership lists.
 * No component data is copied.
 *
 ***/

import { EntityRegistry } from "../entity/entity_registry";
import { ComponentRegistry } from "../component/component_registry";
import { get_entity_index, type EntityID } from "../entity/entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentSchema,
  SchemaValues,
} from "../component/component";
import type { Archetype, ArchetypeID } from "../archetype/archetype";
import { ArchetypeRegistry } from "../archetype/archetype_registry";
import { ECS_ERROR, ECSError } from "../utils/error";
import type { BitSet } from "../collections/bitset";

//=========================================================
// Constants
//=========================================================

const INITIAL_ENTITY_ARCHETYPE_CAPACITY = 64;
const UNASSIGNED = -1;

//=========================================================
// Deferred structural change types
//=========================================================

interface PendingAdd {
  entity_id: EntityID;
  def: ComponentDef<ComponentSchema>;
  values: Record<string, number>;
}

interface PendingRemove {
  entity_id: EntityID;
  def: ComponentDef<ComponentSchema>;
}

//=========================================================
// Store
//=========================================================

export class Store {
  private entities: EntityRegistry;
  private components: ComponentRegistry;
  private archetype_registry: ArchetypeRegistry;

  // Entity → archetype mapping
  // Int32Array indexed by entity_index. Value = ArchetypeID or -1 (unassigned).
  private entity_archetype: Int32Array;

  // Deferred destruction buffer — filled by systems, flushed between phases
  private pending_destroy: EntityID[] = [];

  // Deferred structural change buffers — filled by systems, flushed between phases
  private pending_add: PendingAdd[] = [];
  private pending_remove: PendingRemove[] = [];

  constructor() {
    this.entities = new EntityRegistry();
    this.components = new ComponentRegistry();
    this.archetype_registry = new ArchetypeRegistry();
    this.entity_archetype = new Int32Array(
      INITIAL_ENTITY_ARCHETYPE_CAPACITY,
    ).fill(UNASSIGNED);
  }

  //=========================================================
  // Entity lifecycle
  //=========================================================

  public create_entity(): EntityID {
    const id = this.entities.create_entity();
    const index = get_entity_index(id);

    if (index >= this.entity_archetype.length) {
      this.grow_entity_archetype(index + 1);
    }

    // Place in empty archetype
    const empty_id = this.archetype_registry.empty_archetype_id;
    const empty = this.archetype_registry.get(empty_id);
    empty.add_entity(id, index);
    this.entity_archetype[index] = empty_id;

    return id;
  }

  public destroy_entity(id: EntityID): void {
    if (!this.entities.is_alive(id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const index = get_entity_index(id);
    const archetype_id = this.get_entity_archetype_id(index);

    if (archetype_id === UNASSIGNED) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_IN_ARCHETYPE);
      return;
    }

    // Remove from archetype membership
    const arch = this.archetype_registry.get(archetype_id);
    arch.remove_entity(index);

    // Zero out component data for all components in this archetype
    arch.mask.for_each((component_id) => {
      this.components.clear(component_id as ComponentID, index);
    });

    // Clear entity-archetype mapping
    this.entity_archetype[index] = UNASSIGNED;

    // Destroy in entity registry (bumps generation)
    this.entities.destroy(id);
  }

  public is_alive(id: EntityID): boolean {
    return this.entities.is_alive(id);
  }

  public get entity_count(): number {
    return this.entities.count;
  }

  //=========================================================
  // Deferred destruction
  //=========================================================

  public destroy_entity_deferred(id: EntityID): void {
    if (__DEV__) {
      if (!this.entities.is_alive(id)) {
        throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      }
    }
    this.pending_destroy.push(id);
  }

  public flush_destroyed(): void {
    const buf = this.pending_destroy;
    if (buf.length === 0) return;
    for (let i = 0; i < buf.length; i++) {
      if (this.entities.is_alive(buf[i])) {
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

  public add_component_deferred<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: SchemaValues<S>,
  ): void {
    if (__DEV__) {
      if (!this.entities.is_alive(entity_id)) {
        throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      }
    }
    this.pending_add.push({ entity_id, def, values });
  }

  public remove_component_deferred(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
  ): void {
    if (__DEV__) {
      if (!this.entities.is_alive(entity_id)) {
        throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      }
    }
    this.pending_remove.push({ entity_id, def });
  }

  public flush_structural(): void {
    if (this.pending_add.length === 0 && this.pending_remove.length === 0) return;

    // Adds first, then removes
    const adds = this.pending_add;
    for (let i = 0; i < adds.length; i++) {
      if (this.entities.is_alive(adds[i].entity_id)) {
        this.add_component(adds[i].entity_id, adds[i].def, adds[i].values);
      }
    }
    adds.length = 0;

    const removes = this.pending_remove;
    for (let i = 0; i < removes.length; i++) {
      if (this.entities.is_alive(removes[i].entity_id)) {
        this.remove_component(removes[i].entity_id, removes[i].def);
      }
    }
    removes.length = 0;
  }

  public get pending_structural_count(): number {
    return this.pending_add.length + this.pending_remove.length;
  }

  //=========================================================
  // Component registration
  //=========================================================

  public register_component<S extends ComponentSchema>(
    schema: S,
  ): ComponentDef<S> {
    return this.components.register(schema);
  }

  //=========================================================
  // Component operations
  //=========================================================

  public add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: SchemaValues<S>,
  ): void {
    if (!this.entities.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.get_entity_archetype_id(entity_index);
    const current_arch = this.archetype_registry.get(current_archetype_id);

    // Already has component → overwrite data in-place (no transition)
    if (current_arch.has_component(def)) {
      this.components.set(def, entity_id, values);
      return;
    }

    // Write data to ComponentRegistry
    this.components.set(def, entity_id, values);

    // Resolve target archetype via graph edges
    const target_archetype_id = this.archetype_registry.resolve_add(
      current_archetype_id,
      def,
    );
    const target_arch = this.archetype_registry.get(target_archetype_id);

    // Move membership: remove from current, add to target
    current_arch.remove_entity(entity_index);
    target_arch.add_entity(entity_id, entity_index);

    // Update entity-archetype mapping
    this.entity_archetype[entity_index] = target_archetype_id;
  }

  public add_components(
    entity_id: EntityID,
    entries: { def: ComponentDef<ComponentSchema>; values: Record<string, number> }[],
  ): void {
    if (!this.entities.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    let current_archetype_id = this.get_entity_archetype_id(entity_index);
    let target_archetype_id = current_archetype_id;

    // Write all component data and resolve final archetype
    for (let i = 0; i < entries.length; i++) {
      const { def, values } = entries[i];
      this.components.set(def, entity_id, values);
      target_archetype_id = this.archetype_registry.resolve_add(target_archetype_id, def);
    }

    // Single membership move if archetype changed
    if (target_archetype_id !== current_archetype_id) {
      const source_arch = this.archetype_registry.get(current_archetype_id);
      source_arch.remove_entity(entity_index);
      this.archetype_registry.get(target_archetype_id).add_entity(entity_id, entity_index);
      this.entity_archetype[entity_index] = target_archetype_id;
    }
  }

  public remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
  ): void {
    if (!this.entities.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.get_entity_archetype_id(entity_index);
    const current_arch = this.archetype_registry.get(current_archetype_id);

    // Doesn't have component → no-op
    if (!current_arch.has_component(def)) {
      return;
    }

    // Zero out component data
    this.components.clear(def, entity_index);

    // Resolve target archetype via graph edges
    const target_archetype_id = this.archetype_registry.resolve_remove(
      current_archetype_id,
      def,
    );
    const target_arch = this.archetype_registry.get(target_archetype_id);

    // Move membership
    current_arch.remove_entity(entity_index);
    target_arch.add_entity(entity_id, entity_index);

    // Update entity-archetype mapping
    this.entity_archetype[entity_index] = target_archetype_id;
  }

  public has_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
  ): boolean {
    if (!this.entities.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return false;
    }

    const entity_index = get_entity_index(entity_id);
    const archetype_id = this.get_entity_archetype_id(entity_index);
    const arch = this.archetype_registry.get(archetype_id);
    return arch.has_component(def);
  }

  //=========================================================
  // Direct data access
  //=========================================================

  public get_component_registry(): ComponentRegistry {
    return this.components;
  }

  //=========================================================
  // Query support (delegated to ArchetypeRegistry)
  //=========================================================

  public get_matching_archetypes(
    required: BitSet,
  ): readonly Archetype[] {
    return this.archetype_registry.get_matching(required);
  }

  public register_query(mask: BitSet): Archetype[] {
    return this.archetype_registry.register_query(mask);
  }

  get archetype_count(): number {
    return this.archetype_registry.count;
  }

  public get_component_archetype_count(id: ComponentID): number {
    return this.archetype_registry.get_component_archetype_count(id);
  }

  public get_archetype(id: ArchetypeID): Archetype {
    return this.archetype_registry.get(id);
  }

  //=========================================================
  // Internal: entity-archetype mapping
  //=========================================================

  /**
   * May return UNASSIGNED (-1) cast as ArchetypeID for destroyed entities.
   * Callers must guard with is_alive() before using the result as a real ID.
   */
  private get_entity_archetype_id(entity_index: number): ArchetypeID {
    return this.entity_archetype[entity_index] as ArchetypeID;
  }

  private grow_entity_archetype(min_capacity: number): void {
    let new_capacity = this.entity_archetype.length;
    while (new_capacity < min_capacity) {
      new_capacity *= 2;
    }

    const next = new Int32Array(new_capacity).fill(UNASSIGNED);
    next.set(this.entity_archetype);
    this.entity_archetype = next;
  }
}
