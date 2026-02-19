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
import { unsafe_cast, BitSet } from "type_primitives";
import {
  Archetype,
  as_archetype_id,
  type ArchetypeColumnLayout,
  type ArchetypeID,
} from "./archetype";
import { ECS_ERROR, ECSError } from "./utils/error";
import { bucket_push } from "./utils/arrays";

//=========================================================
// Constants
//=========================================================

const UNASSIGNED = -1;
const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

//=========================================================
// ComponentMeta — schema info needed to build archetype columns
//=========================================================

interface ComponentMeta {
  field_names: string[];
  field_index: Record<string, number>;
}

//=========================================================
// Store
//=========================================================

export class Store {
  // Entity ID management
  private entity_generations: number[] = [];
  private entity_high_water = 0;
  private entity_free_indices: number[] = [];
  private entity_alive_count = 0;

  // Component metadata
  private component_metas: ComponentMeta[] = [];
  private component_count = 0;

  // Archetype management
  private archetypes: Archetype[] = [];
  private archetype_map: Map<number, ArchetypeID[]> = new Map();
  private next_archetype_id = 0;
  private component_index: Map<ComponentID, Set<ArchetypeID>> = new Map();
  private registered_queries: {
    include_mask: BitSet;
    exclude_mask: BitSet | null;
    any_of_mask: BitSet | null;
    result: Archetype[];
  }[] = [];
  private empty_archetype_id: ArchetypeID;

  // entity_index → ArchetypeID (-1 = unassigned)
  private entity_archetype: number[] = [];
  // entity_index → row within its archetype (-1 = unassigned)
  private entity_row: number[] = [];

  // Deferred destruction buffer
  private pending_destroy: EntityID[] = [];

  // Deferred structural change buffers — flat parallel arrays (no per-op allocation)
  private pending_add_ids: EntityID[] = [];
  private pending_add_defs: ComponentDef<ComponentFields>[] = [];
  private pending_add_values: Record<string, number>[] = [];
  private pending_remove_ids: EntityID[] = [];
  private pending_remove_defs: ComponentDef<ComponentFields>[] = [];

  constructor() {
    this.empty_archetype_id = this.arch_get_or_create_from_mask(new BitSet());
  }

  //=========================================================
  // Internal: archetype management
  //=========================================================

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

  private arch_get_or_create_from_mask(mask: BitSet): ArchetypeID {
    const hash = mask.hash();

    const bucket = this.archetype_map.get(hash);
    if (bucket !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        if (this.archetypes[bucket[i]].mask.equals(mask)) {
          return bucket[i];
        }
      }
    }

    const id = as_archetype_id(this.next_archetype_id++);

    // Build column layouts from component metadata
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

    // Update component index
    mask.for_each((bit) => {
      const component_id = bit as ComponentID;
      let set = this.component_index.get(component_id);
      if (!set) {
        set = new Set();
        this.component_index.set(component_id, set);
      }
      set.add(id);
    });

    // Push new archetype to matching registered queries
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

    this.entity_archetype[index] = this.empty_archetype_id;
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
      const arch = this.arch_get(this.entity_archetype[index] as ArchetypeID);
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
    if (__DEV__ && !this.is_alive(id))
      throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    this.pending_destroy.push(id);
  }

  public flush_destroyed(): void {
    const buf = this.pending_destroy;
    if (buf.length === 0) return;

    const ent_arch = this.entity_archetype;
    const ent_row = this.entity_row;
    const ent_gens = this.entity_generations;
    const archs = this.archetypes;
    const hw = this.entity_high_water;

    for (let i = 0; i < buf.length; i++) {
      const eid = buf[i];
      const idx = (eid as number) & INDEX_MASK;
      const gen = ((eid as number) >>> INDEX_BITS) & MAX_GENERATION;
      if (idx >= hw || ent_gens[idx] !== gen) continue;

      const row = ent_row[idx];
      if (row !== UNASSIGNED) {
        const arch = archs[ent_arch[idx] as ArchetypeID];
        const sw = arch.has_columns
          ? arch.remove_entity(row)
          : arch.remove_entity_tag(row);
        if (sw !== -1) ent_row[sw] = row;
      }

      ent_arch[idx] = UNASSIGNED;
      ent_row[idx] = UNASSIGNED;
      ent_gens[idx] = (gen + 1) & MAX_GENERATION;
      this.entity_free_indices.push(idx);
      this.entity_alive_count--;
    }

    buf.length = 0;
  }

  public get pending_destroy_count(): number {
    return this.pending_destroy.length;
  }

  //=========================================================
  // Deferred structural changes
  //=========================================================

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
      const idx = (eid as number) & INDEX_MASK;
      const gen = ((eid as number) >>> INDEX_BITS) & MAX_GENERATION;
      if (idx >= hw || ent_gens[idx] !== gen) continue;

      const src_arch_id = ent_arch[idx] as ArchetypeID;
      const comp_id = defs[i] as unknown as ComponentID;
      const src = archs[src_arch_id];

      // Overwrite in-place if already has component
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

      const dst_row = tag_only ? tgt.add_entity_tag(eid) : tgt.add_entity(eid);

      if (src_row !== UNASSIGNED) {
        if (!tag_only) tgt.copy_shared_from(src, src_row, dst_row);
        const sw = tag_only
          ? src.remove_entity_tag(src_row)
          : src.remove_entity(src_row);
        if (sw !== -1) ent_row[sw] = src_row;
      }

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
      const gen = ((eid as number) >>> INDEX_BITS) & MAX_GENERATION;
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

  //=========================================================
  // Component registration
  //=========================================================

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

  //=========================================================
  // Component operations
  //=========================================================

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

    // Already has component → overwrite in-place (no transition)
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

    // Resolve final archetype through all adds
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

  //=========================================================
  // Direct data access
  //=========================================================

  public get_entity_archetype(entity_id: EntityID): Archetype {
    return this.arch_get(
      this.entity_archetype[get_entity_index(entity_id)] as ArchetypeID,
    );
  }

  public get_entity_row(entity_id: EntityID): number {
    return this.entity_row[get_entity_index(entity_id)];
  }

  //=========================================================
  // Query support
  //=========================================================

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
    if (!has_any_bit) {
      return this.archetypes.filter(
        (arch) =>
          (!excluded || !arch.mask.overlaps(excluded)) &&
          (!any_of || arch.mask.overlaps(any_of)),
      );
    }

    let smallest_set: Set<ArchetypeID> | undefined;
    let has_empty = false;
    for (let wi = 0; wi < words.length; wi++) {
      let word = words[wi];
      if (word === 0) continue;
      const base = wi << 5;
      while (word !== 0) {
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
}
