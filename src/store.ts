/***
 * Store — Internal ECS data orchestrator.
 *
 * Owns all mutable state: entity ID allocation, component metadata,
 * archetype graph, and entity-to-archetype mapping. World delegates
 * every data operation here; Store is never exposed to systems or
 * external code.
 *
 * Architecture: Archetype-based storage with cached graph edges.
 * Component data lives in typed array columns within each Archetype.
 * Moving an entity between archetypes copies its column data from the
 * source row to a fresh row in the target archetype, then swap-removes
 * the source row.
 *
 * The archetype graph caches add/remove edges, so repeated transitions
 * (e.g. "add Velocity to [Position]") resolve in O(1) after the first
 * occurrence.
 *
 * Deferred operations (add_component_deferred, remove_component_deferred,
 * destroy_entity_deferred) buffer changes in flat parallel arrays and
 * flush them in batch — avoiding per-operation archetype transitions
 * during system execution.
 *
 ***/

import {
  get_entity_index,
  get_entity_generation,
  create_entity_id,
  INDEX_BITS,
  INDEX_MASK,
  MAX_GENERATION,
  type EntityID,
} from "./entity";
import {
  as_component_id,
  type ComponentDef,
  type ComponentID,
  type ComponentSchema,
  type ComponentFields,
  type FieldValues,
} from "./component";
import {
  EventChannel,
  as_event_id,
  type EventDef,
  type EventReader,
} from "./event";
import {
  ResourceChannel,
  as_resource_id,
  type ResourceDef,
  type ResourceReader,
} from "./resource";
import { unsafe_cast, BitSet, type TypedArrayTag } from "type_primitives";
import {
  Archetype,
  as_archetype_id,
  build_transition_map,
  _move_result,
  type ArchetypeColumnLayout,
  type ArchetypeEdge,
  type ArchetypeID,
} from "./archetype";
import { ECS_ERROR, ECSError } from "./utils/error";
import { bucket_push } from "./utils/arrays";
import {
  UNASSIGNED,
  NO_SWAP,
  EMPTY_VALUES,
  BITS_PER_WORD_SHIFT,
  BITS_PER_WORD_MASK,
  INITIAL_GENERATION,
  DEFAULT_COLUMN_CAPACITY,
} from "./utils/constants";

interface ComponentMeta {
  field_names: string[];
  field_index: Record<string, number>;
  field_types: TypedArrayTag[];
}

export class Store {
  // --- Entity ID management ---
  // Generational slot allocator: entity_generations[index] holds the current
  // generation for that slot. Free indices are recycled via a stack.
  private readonly entity_generations: number[] = [];
  private entity_high_water = 0;
  private readonly entity_free_indices: number[] = [];
  private entity_alive_count = 0;

  // --- Component metadata ---
  // Parallel array indexed by ComponentID: field_names, field_index, and field_types
  // for building archetype column layouts.
  private readonly component_metas: ComponentMeta[] = [];
  private component_count = 0;

  // --- Event channels ---
  // Parallel array indexed by EventID: each channel holds SoA columns + reader.
  private readonly event_channels: EventChannel[] = [];
  private event_count = 0;

  // --- Resource channels ---
  // Parallel array indexed by ResourceID: each channel holds a single row of SoA columns.
  private readonly resource_channels: ResourceChannel[] = [];
  private resource_count = 0;

  // --- Archetype management ---
  private readonly archetypes: Archetype[] = [];
  // Hash-bucketed lookup: BitSet.hash() → ArchetypeID[] for deduplication
  private readonly archetype_map: Map<number, ArchetypeID[]> = new Map();
  private next_archetype_id = 0;
  // Inverted index: ComponentID → set of ArchetypeIDs containing that component.
  // Used by get_matching_archetypes to start from the smallest set.
  private readonly component_index: Map<ComponentID, Set<ArchetypeID>> =
    new Map();
  // Registered queries: the Store pushes newly-created archetypes into matching
  // query result arrays, so queries are always up-to-date.
  private readonly registered_queries: {
    include_mask: BitSet;
    exclude_mask: BitSet | null;
    any_of_mask: BitSet | null;
    result: Archetype[];
  }[] = [];
  private empty_archetype_id: ArchetypeID;

  // entity_index → ArchetypeID (UNASSIGNED = not in any archetype)
  private readonly entity_archetype: number[] = [];
  // entity_index → row within its archetype (UNASSIGNED = no row)
  private readonly entity_row: number[] = [];

  // --- Deferred operation buffers ---
  // Flat parallel arrays: pending_add_ids[i], pending_add_defs[i], pending_add_values[i]
  // describe one deferred add. No per-operation object allocation.
  private readonly pending_destroy: EntityID[] = [];
  private readonly pending_add_ids: EntityID[] = [];
  private readonly pending_add_defs: ComponentDef[] = [];
  private readonly pending_add_values: Record<string, number>[] = [];
  private readonly pending_remove_ids: EntityID[] = [];
  private readonly pending_remove_defs: ComponentDef[] = [];

  private readonly initial_capacity: number;

  constructor(initial_capacity?: number) {
    this.initial_capacity = initial_capacity ?? DEFAULT_COLUMN_CAPACITY;
    this.empty_archetype_id = this.arch_get_or_create_from_mask(new BitSet());
  }

  // =======================================================
  // Archetype graph
  // =======================================================

  private arch_get(id: ArchetypeID): Archetype {
    if (__DEV__) {
      if (id < 0 || id >= this.archetypes.length) {
        throw new ECSError(
          ECS_ERROR.ARCHETYPE_NOT_FOUND,
          `Archetype with ID ${id} not found`,
        );
      }
    }
    return this.archetypes[id];
  }

  /**
   * Find or create an archetype for the given component mask.
   * Also updates the component_index and pushes into matching registered queries.
   */
  private arch_get_or_create_from_mask(mask: BitSet): ArchetypeID {
    const hash = mask.hash();

    // Check hash-bucketed map for an existing archetype with the same mask
    const bucket = this.archetype_map.get(hash);
    if (bucket !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        if (this.archetypes[bucket[i]].mask.equals(mask)) {
          return bucket[i];
        }
      }
    }

    const id = as_archetype_id(this.next_archetype_id++);

    // Build column layouts from component metadata (tags have no fields → no layout)
    const layouts: ArchetypeColumnLayout[] = [];
    mask.for_each((bit) => {
      const comp_id = bit as ComponentID;
      const meta = this.component_metas[comp_id as number];
      if (meta && meta.field_names.length > 0) {
        layouts.push({
          component_id: comp_id,
          field_names: meta.field_names,
          field_index: meta.field_index,
          field_types: meta.field_types,
        });
      }
    });

    const archetype = new Archetype(id, mask, layouts, this.initial_capacity);
    this.archetypes.push(archetype);
    bucket_push(this.archetype_map, hash, id);

    // Update inverted component index
    mask.for_each((bit) => {
      const component_id = bit as ComponentID;
      let set = this.component_index.get(component_id);
      if (!set) {
        set = new Set();
        this.component_index.set(component_id, set);
      }
      set.add(id);
    });

    // Push new archetype into any registered query whose masks it satisfies
    const rqs = this.registered_queries;
    for (let i = 0; i < rqs.length; i++) {
      const rq = rqs[i];
      if (
        archetype.matches(rq.include_mask) &&
        (!rq.exclude_mask || !archetype.mask.overlaps(rq.exclude_mask)) &&
        (!rq.any_of_mask || archetype.mask.overlaps(rq.any_of_mask))
      ) {
        rq.result.push(archetype);
      }
    }

    return id;
  }

  /** Resolve "add component_id to archetype_id" → target ArchetypeID. Caches the edge. */
  private arch_resolve_add(
    archetype_id: ArchetypeID,
    component_id: ComponentID,
  ): ArchetypeID {
    const current = this.arch_get(archetype_id);
    if (current.mask.has(component_id as number)) return archetype_id;
    const edge = current.get_edge(component_id);
    if (edge?.add != null) return edge.add;
    const target_id = this.arch_get_or_create_from_mask(
      current.mask.copy_with_set(component_id as number),
    );
    this.arch_cache_edge(current, this.arch_get(target_id), component_id);
    return target_id;
  }

  /** Resolve "remove component_id from archetype_id" → target ArchetypeID. Caches the edge. */
  private arch_resolve_remove(
    archetype_id: ArchetypeID,
    component_id: ComponentID,
  ): ArchetypeID {
    const current = this.arch_get(archetype_id);
    if (!current.mask.has(component_id as number)) return archetype_id;
    const edge = current.get_edge(component_id);
    if (edge?.remove != null) return edge.remove;
    const target_id = this.arch_get_or_create_from_mask(
      current.mask.copy_with_clear(component_id as number),
    );
    this.arch_cache_edge(this.arch_get(target_id), current, component_id);
    return target_id;
  }

  /** Cache a bidirectional add/remove edge between two archetypes. */
  private arch_cache_edge(
    from: Archetype,
    to: Archetype,
    component_id: ComponentID,
  ): void {
    // from + component_id → to (add edge)
    const from_edge: ArchetypeEdge = from.get_edge(component_id) ?? {
      add: null,
      remove: null,
      add_map: null,
      remove_map: null,
    };
    from_edge.add = to.id;
    from_edge.add_map = build_transition_map(from, to);
    from.set_edge(component_id, from_edge);

    // to - component_id → from (remove edge)
    const to_edge: ArchetypeEdge = to.get_edge(component_id) ?? {
      add: null,
      remove: null,
      add_map: null,
      remove_map: null,
    };
    to_edge.remove = from.id;
    to_edge.remove_map = build_transition_map(to, from);
    to.set_edge(component_id, to_edge);
  }

  // =======================================================
  // Entity lifecycle
  // =======================================================

  public create_entity(): EntityID {
    let index: number;
    let generation: number;

    if (this.entity_free_indices.length > 0) {
      // ! safe: length > 0 guarantees pop() returns a value
      index = this.entity_free_indices.pop()!;
      generation = this.entity_generations[index];
    } else {
      index = this.entity_high_water++;
      this.entity_generations[index] = INITIAL_GENERATION;
      generation = INITIAL_GENERATION;
    }

    this.entity_alive_count++;
    const id = create_entity_id(index, generation);

    // New entities start in the empty archetype with no row assignment
    this.entity_archetype[index] = this.empty_archetype_id;
    this.entity_row[index] = UNASSIGNED;

    return id;
  }

  /** Immediately destroy an entity, removing it from its archetype. */
  public destroy_entity(id: EntityID): void {
    if (!this.is_alive(id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const index = get_entity_index(id);
    const row = this.entity_row[index];

    if (row !== UNASSIGNED) {
      const arch = this.arch_get(this.entity_archetype[index] as ArchetypeID);
      // swap-and-pop returns the entity_index that was swapped into our row
      const swapped_idx = arch.remove_entity(row);
      if (swapped_idx !== NO_SWAP) this.entity_row[swapped_idx] = row;
    }

    this.entity_archetype[index] = UNASSIGNED;
    this.entity_row[index] = UNASSIGNED;

    // Bump generation so stale IDs referencing this slot are detected as dead
    const generation = get_entity_generation(id);
    if (__DEV__ && generation >= MAX_GENERATION)
      throw new ECSError(ECS_ERROR.EID_MAX_GEN_OVERFLOW);
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

  // =======================================================
  // Deferred destruction
  // =======================================================

  public destroy_entity_deferred(id: EntityID): void {
    if (__DEV__ && !this.is_alive(id))
      throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_destroy.push(id);
  }

  /** Flush all buffered entity destructions in batch. */
  public flush_destroyed(): void {
    const buf = this.pending_destroy;
    if (buf.length === 0) return;

    // Hot loop — hoist fields to locals for faster access
    const ent_arch = this.entity_archetype;
    const ent_row = this.entity_row;
    const ent_gens = this.entity_generations;
    const archs = this.archetypes;
    const hw = this.entity_high_water;

    for (let i = 0; i < buf.length; i++) {
      const eid = buf[i];
      // Inline entity ID unpacking (avoids function call overhead in hot path)
      const idx = (eid as number) & INDEX_MASK;
      const gen = (eid as number) >> INDEX_BITS;
      // Skip if entity was already destroyed (stale generation)
      if (idx >= hw || ent_gens[idx] !== gen) continue;

      const row = ent_row[idx];
      if (row !== UNASSIGNED) {
        const arch = archs[ent_arch[idx] as ArchetypeID];
        // Tag-only archetypes skip column operations entirely
        const sw = arch.has_columns
          ? arch.remove_entity(row)
          : arch.remove_entity_tag(row);
        if (sw !== NO_SWAP) ent_row[sw] = row;
      }

      ent_arch[idx] = UNASSIGNED;
      ent_row[idx] = UNASSIGNED;
      if (__DEV__ && gen >= MAX_GENERATION)
        throw new ECSError(ECS_ERROR.EID_MAX_GEN_OVERFLOW);
      ent_gens[idx] = (gen + 1) & MAX_GENERATION;
      this.entity_free_indices.push(idx);
      this.entity_alive_count--;
    }

    buf.length = 0;
  }

  public get pending_destroy_count(): number {
    return this.pending_destroy.length;
  }

  // =======================================================
  // Deferred structural changes
  // =======================================================

  public add_component_deferred(
    entity_id: EntityID,
    def: ComponentDef<Record<string, never>>,
  ): void;
  public add_component_deferred<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: FieldValues<S>,
  ): void;
  public add_component_deferred(
    entity_id: EntityID,
    def: ComponentDef,
    values?: Record<string, number>,
  ): void {
    if (__DEV__ && !this.is_alive(entity_id))
      throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_add_ids.push(entity_id);
    this.pending_add_defs.push(def);
    this.pending_add_values.push(values ?? EMPTY_VALUES);
  }

  public remove_component_deferred(
    entity_id: EntityID,
    def: ComponentDef,
  ): void {
    if (__DEV__ && !this.is_alive(entity_id))
      throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_remove_ids.push(entity_id);
    this.pending_remove_defs.push(def);
  }

  public flush_structural(): void {
    if (this.pending_add_ids.length > 0) this._flush_adds();
    if (this.pending_remove_ids.length > 0) this._flush_removes();
  }

  /** Batch-apply all deferred component additions. */
  private _flush_adds(): void {
    const ids = this.pending_add_ids;
    const defs = this.pending_add_defs;
    const vals = this.pending_add_values;
    const n = ids.length;

    const ent_arch = this.entity_archetype;
    const ent_row = this.entity_row;
    const ent_gens = this.entity_generations;
    const archs = this.archetypes;
    const metas = this.component_metas;
    const hw = this.entity_high_water;

    for (let i = 0; i < n; i++) {
      const eid = ids[i];
      // Inline entity ID unpacking
      const idx = (eid as number) & INDEX_MASK;
      const gen = (eid as number) >> INDEX_BITS;
      if (idx >= hw || ent_gens[idx] !== gen) continue;

      const src_arch_id = ent_arch[idx] as ArchetypeID;
      const comp_id = defs[i] as unknown as ComponentID;
      const src = archs[src_arch_id];

      // Already has this component → overwrite field values in-place (no transition)
      if (src.mask.has(comp_id as number)) {
        if (metas[comp_id as number].field_names.length > 0) {
          src.write_fields(ent_row[idx], comp_id, vals[i]);
        }
        continue;
      }

      const tgt_id = this.arch_resolve_add(src_arch_id, comp_id);
      const tgt = archs[tgt_id];
      const src_row = ent_row[idx];
      const tag_only = !tgt.has_columns && !src.has_columns;

      let dst_row: number;

      if (src_row !== UNASSIGNED) {
        if (tag_only) {
          tgt.move_entity_from_tag(src, src_row, eid);
        } else {
          const edge = src.get_edge(comp_id)!;
          tgt.move_entity_from(src, src_row, eid, edge.add_map!);
        }
        dst_row = _move_result[0];
        if (_move_result[1] !== NO_SWAP) ent_row[_move_result[1]] = src_row;
      } else {
        dst_row = tag_only ? tgt.add_entity_tag(eid) : tgt.add_entity(eid);
      }

      // Write the new component's field values
      if (metas[comp_id as number].field_names.length > 0) {
        tgt.write_fields(dst_row, comp_id, vals[i]);
      }

      ent_arch[idx] = tgt_id;
      ent_row[idx] = dst_row;
    }

    ids.length = 0;
    defs.length = 0;
    vals.length = 0;
  }

  /** Batch-apply all deferred component removals. */
  private _flush_removes(): void {
    const ids = this.pending_remove_ids;
    const defs = this.pending_remove_defs;
    const n = ids.length;

    const ent_arch = this.entity_archetype;
    const ent_row = this.entity_row;
    const ent_gens = this.entity_generations;
    const archs = this.archetypes;
    const hw = this.entity_high_water;

    for (let i = 0; i < n; i++) {
      const eid = ids[i];
      const idx = (eid as number) & INDEX_MASK;
      const gen = (eid as number) >> INDEX_BITS;
      if (idx >= hw || ent_gens[idx] !== gen) continue;

      const src_arch_id = ent_arch[idx] as ArchetypeID;
      const comp_id = defs[i] as unknown as ComponentID;
      const src = archs[src_arch_id];

      if (!src.mask.has(comp_id as number)) continue;

      const tgt_id = this.arch_resolve_remove(src_arch_id, comp_id);
      const tgt = archs[tgt_id];
      const src_row = ent_row[idx];
      const tag_only = !tgt.has_columns && !src.has_columns;

      if (tag_only) {
        tgt.move_entity_from_tag(src, src_row, eid);
      } else {
        const edge = src.get_edge(comp_id)!;
        tgt.move_entity_from(src, src_row, eid, edge.remove_map!);
      }
      if (_move_result[1] !== NO_SWAP) ent_row[_move_result[1]] = src_row;

      ent_arch[idx] = tgt_id;
      ent_row[idx] = _move_result[0];
    }

    ids.length = 0;
    defs.length = 0;
  }

  public get pending_structural_count(): number {
    return this.pending_add_ids.length + this.pending_remove_ids.length;
  }

  // =======================================================
  // Component registration
  // =======================================================

  public register_component<S extends Record<string, TypedArrayTag>>(
    schema: S,
  ): ComponentDef<S> {
    const id = as_component_id(this.component_count++);
    const field_names = Object.keys(schema);
    const field_types: TypedArrayTag[] = new Array(field_names.length);
    const field_index: Record<string, number> = Object.create(null);
    for (let i = 0; i < field_names.length; i++) {
      field_index[field_names[i]] = i;
      field_types[i] = schema[field_names[i]];
    }
    this.component_metas.push({ field_names, field_index, field_types });
    return unsafe_cast<ComponentDef<S>>(id);
  }

  // =======================================================
  // Immediate component operations (for setup/spawning)
  // =======================================================

  public add_component(
    entity_id: EntityID,
    def: ComponentDef<Record<string, never>>,
  ): void;
  public add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: FieldValues<S>,
  ): void;
  public add_component(
    entity_id: EntityID,
    def: ComponentDef,
    values?: Record<string, number>,
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[
      entity_index
    ] as ArchetypeID;
    const current_arch = this.arch_get(current_archetype_id);

    // Already has this component → overwrite in-place (no archetype transition)
    if (current_arch.has_component(def)) {
      current_arch.write_fields(
        this.entity_row[entity_index],
        def as ComponentID,
        values as Record<string, number>,
      );
      return;
    }

    const target_archetype_id = this.arch_resolve_add(
      current_archetype_id,
      def,
    );
    const target_arch = this.arch_get(target_archetype_id);
    const src_row = this.entity_row[entity_index];

    let dst_row: number;

    if (src_row !== UNASSIGNED) {
      const edge = current_arch.get_edge(def as unknown as ComponentID)!;
      const tag_only = !target_arch.has_columns && !current_arch.has_columns;

      if (tag_only) {
        target_arch.move_entity_from_tag(current_arch, src_row, entity_id);
      } else {
        target_arch.move_entity_from(current_arch, src_row, entity_id, edge.add_map!);
      }
      dst_row = _move_result[0];
      if (_move_result[1] !== NO_SWAP) this.entity_row[_move_result[1]] = src_row;
    } else {
      dst_row = target_arch.has_columns
        ? target_arch.add_entity(entity_id)
        : target_arch.add_entity_tag(entity_id);
    }

    target_arch.write_fields(
      dst_row,
      def as ComponentID,
      values as Record<string, number>,
    );

    this.entity_archetype[entity_index] = target_archetype_id;
    this.entity_row[entity_index] = dst_row;
  }

  /** Add multiple components in one transition (resolves final archetype, then moves once). */
  public add_components(
    entity_id: EntityID,
    entries: {
      def: ComponentDef;
      values?: Record<string, number>;
    }[],
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[
      entity_index
    ] as ArchetypeID;

    // Walk the graph through all adds to find the final target archetype
    let target_archetype_id: ArchetypeID = current_archetype_id;
    for (let i = 0; i < entries.length; i++) {
      target_archetype_id = this.arch_resolve_add(
        target_archetype_id,
        entries[i].def,
      );
    }

    if (target_archetype_id !== current_archetype_id) {
      const source_arch = this.arch_get(current_archetype_id);
      const target_arch = this.arch_get(target_archetype_id);
      const src_row = this.entity_row[entity_index];

      let dst_row: number;

      if (src_row !== UNASSIGNED) {
        const map = build_transition_map(source_arch, target_arch);
        target_arch.move_entity_from(source_arch, src_row, entity_id, map);
        dst_row = _move_result[0];
        if (_move_result[1] !== NO_SWAP) this.entity_row[_move_result[1]] = src_row;
      } else {
        dst_row = target_arch.add_entity(entity_id);
      }

      for (let i = 0; i < entries.length; i++) {
        target_arch.write_fields(
          dst_row,
          entries[i].def as ComponentID,
          entries[i].values ?? EMPTY_VALUES,
        );
      }

      this.entity_archetype[entity_index] = target_archetype_id;
      this.entity_row[entity_index] = dst_row;
    } else {
      // All components already present — overwrite in-place
      const arch = this.arch_get(current_archetype_id);
      const row = this.entity_row[entity_index];
      for (let i = 0; i < entries.length; i++) {
        arch.write_fields(
          row,
          entries[i].def as ComponentID,
          entries[i].values ?? EMPTY_VALUES,
        );
      }
    }
  }

  public remove_component(
    entity_id: EntityID,
    def: ComponentDef,
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[
      entity_index
    ] as ArchetypeID;
    const current_arch = this.arch_get(current_archetype_id);

    if (!current_arch.has_component(def)) return;

    const target_archetype_id = this.arch_resolve_remove(
      current_archetype_id,
      def,
    );
    const target_arch = this.arch_get(target_archetype_id);
    const src_row = this.entity_row[entity_index];
    const edge = current_arch.get_edge(def as unknown as ComponentID)!;
    const tag_only = !target_arch.has_columns && !current_arch.has_columns;

    if (tag_only) {
      target_arch.move_entity_from_tag(current_arch, src_row, entity_id);
    } else {
      target_arch.move_entity_from(current_arch, src_row, entity_id, edge.remove_map!);
    }
    if (_move_result[1] !== NO_SWAP) this.entity_row[_move_result[1]] = src_row;

    this.entity_archetype[entity_index] = target_archetype_id;
    this.entity_row[entity_index] = _move_result[0];
  }

  /** Remove multiple components in one transition (resolves final archetype, then moves once). */
  public remove_components(
    entity_id: EntityID,
    defs: ComponentDef[],
  ): void {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return;
    }

    const entity_index = get_entity_index(entity_id);
    const current_archetype_id = this.entity_archetype[
      entity_index
    ] as ArchetypeID;

    // Walk the graph through all removes to find the final target archetype
    let target_archetype_id: ArchetypeID = current_archetype_id;
    for (let i = 0; i < defs.length; i++) {
      target_archetype_id = this.arch_resolve_remove(
        target_archetype_id,
        defs[i] as unknown as ComponentID,
      );
    }

    // If target === source, none of the components were present — no-op
    if (target_archetype_id === current_archetype_id) return;

    const source_arch = this.arch_get(current_archetype_id);
    const target_arch = this.arch_get(target_archetype_id);
    const src_row = this.entity_row[entity_index];

    const map = build_transition_map(source_arch, target_arch);
    target_arch.move_entity_from(source_arch, src_row, entity_id, map);
    if (_move_result[1] !== NO_SWAP) this.entity_row[_move_result[1]] = src_row;

    this.entity_archetype[entity_index] = target_archetype_id;
    this.entity_row[entity_index] = _move_result[0];
  }

  public has_component(
    entity_id: EntityID,
    def: ComponentDef,
  ): boolean {
    if (!this.is_alive(entity_id)) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
      return false;
    }
    const entity_index = get_entity_index(entity_id);
    return this.arch_get(
      this.entity_archetype[entity_index] as ArchetypeID,
    ).has_component(def);
  }

  /**
   * Bulk add a component to ALL entities in the given archetype.
   * Uses TypedArray.set() for O(columns) instead of O(N×columns).
   * The archetype must not already contain this component.
   */
  public batch_add_component(
    src_arch: Archetype,
    def: ComponentDef,
    values?: Record<string, number>,
  ): void {
    if (src_arch.length === 0) return;
    const comp_id = def as unknown as ComponentID;
    if (src_arch.mask.has(comp_id as number)) return;

    const tgt_id = this.arch_resolve_add(src_arch.id, comp_id);
    const tgt = this.arch_get(tgt_id);
    const edge = src_arch.get_edge(comp_id)!;
    const count = src_arch.length;

    // Record entity indices before bulk move (entity_ids will be cleared)
    const src_eids = src_arch._entity_ids.buf;
    const ent_arch = this.entity_archetype;
    const ent_row = this.entity_row;

    const dst_start = tgt.bulk_move_all_from(src_arch, edge.add_map!);

    // Update entity→archetype/row mappings for all moved entities
    for (let i = 0; i < count; i++) {
      const idx = get_entity_index(tgt.entity_ids[dst_start + i] as EntityID);
      ent_arch[idx] = tgt_id;
      ent_row[idx] = dst_start + i;
    }

    // Write field values to all new entries
    const meta = this.component_metas[comp_id as number];
    if (meta.field_names.length > 0 && values) {
      for (let i = 0; i < count; i++) {
        tgt.write_fields(dst_start + i, comp_id, values);
      }
    }
  }

  /**
   * Bulk remove a component from ALL entities in the given archetype.
   * Uses TypedArray.set() for O(columns) instead of O(N×columns).
   * The archetype must contain this component.
   */
  public batch_remove_component(
    src_arch: Archetype,
    def: ComponentDef,
  ): void {
    if (src_arch.length === 0) return;
    const comp_id = def as unknown as ComponentID;
    if (!src_arch.mask.has(comp_id as number)) return;

    const tgt_id = this.arch_resolve_remove(src_arch.id, comp_id);
    const tgt = this.arch_get(tgt_id);
    const edge = src_arch.get_edge(comp_id)!;
    const count = src_arch.length;

    const dst_start = tgt.bulk_move_all_from(src_arch, edge.remove_map!);

    // Update entity→archetype/row mappings for all moved entities
    const ent_arch = this.entity_archetype;
    const ent_row = this.entity_row;
    for (let i = 0; i < count; i++) {
      const idx = get_entity_index(tgt.entity_ids[dst_start + i] as EntityID);
      ent_arch[idx] = tgt_id;
      ent_row[idx] = dst_start + i;
    }
  }

  // =======================================================
  // Direct data access (used by SystemContext)
  // =======================================================

  public get_entity_archetype(entity_id: EntityID): Archetype {
    return this.arch_get(
      this.entity_archetype[get_entity_index(entity_id)] as ArchetypeID,
    );
  }

  public get_entity_row(entity_id: EntityID): number {
    return this.entity_row[get_entity_index(entity_id)];
  }

  // =======================================================
  // Query support
  // =======================================================

  /**
   * Find all archetypes matching the given masks.
   * Uses the inverted component_index to start from the component with the
   * fewest archetypes, minimizing the number of superset checks.
   */
  public get_matching_archetypes(
    required: BitSet,
    excluded?: BitSet,
    any_of?: BitSet,
  ): readonly Archetype[] {
    const words = required._words;
    let has_any_bit = false;
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== 0) {
        has_any_bit = true;
        break;
      }
    }
    // Empty required mask → match all archetypes (only filter by exclude/any_of)
    if (!has_any_bit) {
      return this.archetypes.filter(
        (arch) =>
          (!excluded || !arch.mask.overlaps(excluded)) &&
          (!any_of || arch.mask.overlaps(any_of)),
      );
    }

    // Find the smallest component_index set among all required components.
    // This is the tightest starting point for intersection.
    let smallest_set: Set<ArchetypeID> | undefined;
    let has_empty = false;
    for (let wi = 0; wi < words.length; wi++) {
      let word = words[wi];
      if (word === 0) continue;
      const base = wi << BITS_PER_WORD_SHIFT;
      while (word !== 0) {
        // Extract lowest set bit
        const t = word & (-word >>> 0);
        const bit = base + (BITS_PER_WORD_MASK - Math.clz32(t));
        word ^= t;
        const set = this.component_index.get(bit as ComponentID);
        if (!set || set.size === 0) {
          has_empty = true;
          break;
        }
        if (!smallest_set || set.size < smallest_set.size) smallest_set = set;
      }
      if (has_empty) break;
    }
    // If any required component has zero archetypes, no match is possible
    if (has_empty || !smallest_set) return [];

    const result: Archetype[] = [];
    for (const archetype_id of smallest_set) {
      const arch = this.arch_get(archetype_id);
      if (
        arch.matches(required) &&
        (!excluded || !arch.mask.overlaps(excluded)) &&
        (!any_of || arch.mask.overlaps(any_of))
      ) {
        result.push(arch);
      }
    }
    return result;
  }

  /**
   * Register a live query. Returns a mutable Archetype[] that this Store will
   * push newly-created matching archetypes into, keeping the query always up-to-date.
   */
  public register_query(
    include: BitSet,
    exclude?: BitSet,
    any_of?: BitSet,
  ): Archetype[] {
    const result = this.get_matching_archetypes(
      include,
      exclude,
      any_of,
    ) as Archetype[];
    this.registered_queries.push({
      include_mask: include.copy(),
      exclude_mask: exclude ? exclude.copy() : null,
      any_of_mask: any_of ? any_of.copy() : null,
      result,
    });
    return result;
  }

  public get archetype_count(): number {
    return this.archetypes.length;
  }

  // =======================================================
  // Event channels
  // =======================================================

  public register_event<F extends readonly string[]>(fields: F): EventDef<F> {
    const id = as_event_id(this.event_count++);
    const channel = new EventChannel(fields as unknown as string[]);
    this.event_channels.push(channel);
    return unsafe_cast<EventDef<F>>(id);
  }

  public emit_event<F extends ComponentFields>(
    def: EventDef<F>,
    values: Record<string, number>,
  ): void {
    this.event_channels[def as unknown as number].emit(values);
  }

  public emit_signal(def: EventDef<readonly []>): void {
    this.event_channels[def as unknown as number].emit_signal();
  }

  public get_event_reader<F extends ComponentFields>(
    def: EventDef<F>,
  ): EventReader<F> {
    return this.event_channels[def as unknown as number]
      .reader as EventReader<F>;
  }

  public clear_events(): void {
    const channels = this.event_channels;
    for (let i = 0; i < channels.length; i++) {
      channels[i].clear();
    }
  }

  // =======================================================
  // Resource channels
  // =======================================================

  public register_resource<F extends readonly string[]>(
    fields: F,
    initial: Record<string, number>,
  ): ResourceDef<F> {
    const id = as_resource_id(this.resource_count++);
    const channel = new ResourceChannel(fields as unknown as string[], initial);
    this.resource_channels.push(channel);
    return unsafe_cast<ResourceDef<F>>(id);
  }

  public get_resource_reader<F extends ComponentFields>(
    def: ResourceDef<F>,
  ): ResourceReader<F> {
    if (__DEV__) {
      const idx = def as unknown as number;
      if (idx < 0 || idx >= this.resource_channels.length) {
        throw new ECSError(
          ECS_ERROR.RESOURCE_NOT_REGISTERED,
          `Resource with ID ${idx} not registered`,
        );
      }
    }
    return this.resource_channels[def as unknown as number]
      .reader as ResourceReader<F>;
  }

  public get_resource_channel(
    def: ResourceDef<ComponentFields>,
  ): ResourceChannel {
    if (__DEV__) {
      const idx = def as unknown as number;
      if (idx < 0 || idx >= this.resource_channels.length) {
        throw new ECSError(
          ECS_ERROR.RESOURCE_NOT_REGISTERED,
          `Resource with ID ${idx} not registered`,
        );
      }
    }
    return this.resource_channels[def as unknown as number];
  }
}
