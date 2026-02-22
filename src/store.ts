/***
 * Store — Internal ECS data orchestrator.
 *
 * Owns all mutable state: entity ID allocation, component metadata,
 * archetype graph, and entity-to-archetype mapping. World delegates
 * every data operation here; Store is never exposed to systems or
 * external code.
 *
 * Architecture: Archetype-based storage with cached graph edges.
 * Component data lives in plain number[] columns within each Archetype.
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
  type ComponentFields,
  type FieldValues,
} from "./component";
import {
  EventChannel,
  as_event_id,
  type EventDef,
  type EventReader,
} from "./event";
import { unsafe_cast, BitSet } from "type_primitives";
import {
  Archetype,
  as_archetype_id,
  type ArchetypeColumnLayout,
  type ArchetypeID,
} from "./archetype";
import { ECS_ERROR, ECSError } from "./utils/error";
import { bucket_push } from "./utils/arrays";

const UNASSIGNED = -1;
const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

interface ComponentMeta {
  field_names: string[];
  field_index: Record<string, number>;
}

export class Store {
  // --- Entity ID management ---
  // Generational slot allocator: entity_generations[index] holds the current
  // generation for that slot. Free indices are recycled via a stack.
  private entity_generations: number[] = [];
  private entity_high_water = 0;
  private entity_free_indices: number[] = [];
  private entity_alive_count = 0;

  // --- Component metadata ---
  // Parallel array indexed by ComponentID: field_names and field_index
  // for building archetype column layouts.
  private component_metas: ComponentMeta[] = [];
  private component_count = 0;

  // --- Event channels ---
  // Parallel array indexed by EventID: each channel holds SoA columns + reader.
  private event_channels: EventChannel[] = [];
  private event_count = 0;

  // --- Archetype management ---
  private archetypes: Archetype[] = [];
  // Hash-bucketed lookup: BitSet.hash() → ArchetypeID[] for deduplication
  private archetype_map: Map<number, ArchetypeID[]> = new Map();
  private next_archetype_id = 0;
  // Inverted index: ComponentID → set of ArchetypeIDs containing that component.
  // Used by get_matching_archetypes to start from the smallest set.
  private component_index: Map<ComponentID, Set<ArchetypeID>> = new Map();
  // Registered queries: the Store pushes newly-created archetypes into matching
  // query result arrays, so queries are always up-to-date.
  private registered_queries: {
    include_mask: BitSet;
    exclude_mask: BitSet | null;
    any_of_mask: BitSet | null;
    result: Archetype[];
  }[] = [];
  private empty_archetype_id: ArchetypeID;

  // entity_index → ArchetypeID (UNASSIGNED = not in any archetype)
  private entity_archetype: number[] = [];
  // entity_index → row within its archetype (UNASSIGNED = no row)
  private entity_row: number[] = [];

  // --- Deferred operation buffers ---
  // Flat parallel arrays: pending_add_ids[i], pending_add_defs[i], pending_add_values[i]
  // describe one deferred add. No per-operation object allocation.
  private pending_destroy: EntityID[] = [];
  private pending_add_ids: EntityID[] = [];
  private pending_add_defs: ComponentDef<ComponentFields>[] = [];
  private pending_add_values: Record<string, number>[] = [];
  private pending_remove_ids: EntityID[] = [];
  private pending_remove_defs: ComponentDef<ComponentFields>[] = [];

  constructor() {
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
        });
      }
    });

    const archetype = new Archetype(id, mask, layouts);
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
    const from_edge = from.get_edge(component_id) ?? {
      add: null,
      remove: null,
    };
    from_edge.add = to.id;
    from.set_edge(component_id, from_edge);

    const to_edge = to.get_edge(component_id) ?? { add: null, remove: null };
    to_edge.remove = from.id;
    to.set_edge(component_id, to_edge);
  }

  // =======================================================
  // Entity lifecycle
  // =======================================================

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
      if (swapped_idx !== -1) this.entity_row[swapped_idx] = row;
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
        if (sw !== -1) ent_row[sw] = row;
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
    def: ComponentDef<readonly []>,
  ): void;
  public add_component_deferred<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): void;
  public add_component_deferred(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
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
    def: ComponentDef<ComponentFields>,
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
      // Tag-only optimization: if neither archetype has columns, skip all column work
      const tag_only = !tgt.has_columns && !src.has_columns;

      const dst_row = tag_only ? tgt.add_entity_tag(eid) : tgt.add_entity(eid);

      if (src_row !== UNASSIGNED) {
        if (!tag_only) tgt.copy_shared_from(src, src_row, dst_row);
        const sw = tag_only
          ? src.remove_entity_tag(src_row)
          : src.remove_entity(src_row);
        if (sw !== -1) ent_row[sw] = src_row;
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

      const dst_row = tag_only ? tgt.add_entity_tag(eid) : tgt.add_entity(eid);

      if (!tag_only) tgt.copy_shared_from(src, src_row, dst_row);

      const sw = tag_only
        ? src.remove_entity_tag(src_row)
        : src.remove_entity(src_row);
      if (sw !== -1) ent_row[sw] = src_row;

      ent_arch[idx] = tgt_id;
      ent_row[idx] = dst_row;
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

  public register_component<F extends readonly string[]>(
    fields: F,
  ): ComponentDef<F> {
    const id = as_component_id(this.component_count++);
    const field_names = fields as unknown as string[];
    const field_index: Record<string, number> = Object.create(null);
    for (let i = 0; i < field_names.length; i++) {
      field_index[field_names[i]] = i;
    }
    this.component_metas.push({ field_names, field_index });
    return unsafe_cast<ComponentDef<F>>(id);
  }

  // =======================================================
  // Immediate component operations (for setup/spawning)
  // =======================================================

  public add_component(
    entity_id: EntityID,
    def: ComponentDef<readonly []>,
  ): void;
  public add_component<F extends ComponentFields>(
    entity_id: EntityID,
    def: ComponentDef<F>,
    values: FieldValues<F>,
  ): void;
  public add_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentFields>,
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
    const dst_row = target_arch.add_entity(entity_id);

    if (src_row !== UNASSIGNED) {
      target_arch.copy_shared_from(current_arch, src_row, dst_row);
      const swapped_idx = current_arch.remove_entity(src_row);
      if (swapped_idx !== -1) this.entity_row[swapped_idx] = src_row;
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
      def: ComponentDef<ComponentFields>;
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
      const dst_row = target_arch.add_entity(entity_id);

      if (src_row !== UNASSIGNED) {
        target_arch.copy_shared_from(source_arch, src_row, dst_row);
        const swapped_idx = source_arch.remove_entity(src_row);
        if (swapped_idx !== -1) this.entity_row[swapped_idx] = src_row;
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
    def: ComponentDef<ComponentFields>,
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
    const dst_row = target_arch.add_entity(entity_id);

    target_arch.copy_shared_from(current_arch, src_row, dst_row);

    const swapped_idx = current_arch.remove_entity(src_row);
    if (swapped_idx !== -1) this.entity_row[swapped_idx] = src_row;

    this.entity_archetype[entity_index] = target_archetype_id;
    this.entity_row[entity_index] = dst_row;
  }

  /** Remove multiple components in one transition (resolves final archetype, then moves once). */
  public remove_components(
    entity_id: EntityID,
    defs: ComponentDef<ComponentFields>[],
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
    const dst_row = target_arch.add_entity(entity_id);

    target_arch.copy_shared_from(source_arch, src_row, dst_row);

    const swapped_idx = source_arch.remove_entity(src_row);
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
    return this.arch_get(
      this.entity_archetype[entity_index] as ArchetypeID,
    ).has_component(def);
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
      const base = wi << 5;
      while (word !== 0) {
        // Extract lowest set bit
        const t = word & (-word >>> 0);
        const bit = base + (31 - Math.clz32(t));
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

  get archetype_count(): number {
    return this.archetypes.length;
  }

  // =======================================================
  // Event channels
  // =======================================================

  public register_event<F extends readonly string[]>(
    fields: F,
  ): EventDef<F> {
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
    return this.event_channels[def as unknown as number].reader as EventReader<F>;
  }

  public clear_events(): void {
    const channels = this.event_channels;
    for (let i = 0; i < channels.length; i++) {
      channels[i].clear();
    }
  }
}
