/***
 * Entity — Packed generational ID (20-bit index | 12-bit generation).
 *
 * Each entity ID encodes a slot index (low 20 bits, max ~1M entities)
 * and a generation counter (high 12 bits, max 4095). When an entity is
 * destroyed, its slot's generation increments. Subsequent lookups with
 * the old ID detect the stale generation and treat the entity as dead.
 *
 * The packed layout fits in a single 32-bit integer, avoiding object
 * allocation and enabling fast bitwise extract/compose.
 *
 * Layout: [generation:12][index:20]
 *
 *   create_entity_id(index, gen) → (gen << 20) | index
 *   get_entity_index(id)         → id & 0xFFFFF
 *   get_entity_generation(id)    → (id >>> 20) & 0xFFF
 *
 ***/

import { Brand, unsafe_cast } from "type_primitives";
import { ECS_ERROR, ECSError } from "./utils/error";

export type EntityID = Brand<number, "entity_id">;

export const INDEX_BITS = 20;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF — 20-bit mask
export const MAX_INDEX = INDEX_MASK; // 1,048,575
export const MAX_GENERATION = (1 << (32 - INDEX_BITS)) - 1; // 0xFFF (4095)

export const create_entity_id = (
  index: number,
  generation: number,
): EntityID => {
  if (__DEV__) {
    if (index < 0 || index > MAX_INDEX) {
      throw new ECSError(ECS_ERROR.EID_MAX_INDEX_OVERFLOW);
    }

    if (generation < 0 || generation > MAX_GENERATION) {
      throw new ECSError(ECS_ERROR.EID_MAX_GEN_OVERFLOW);
    }
  }
  // >>> 0 coerces to unsigned 32-bit so the result is always a positive number,
  // even when the generation fills the sign bit
  return unsafe_cast<EntityID>(((generation << INDEX_BITS) | index) >>> 0);
};

export const get_entity_index = (id: EntityID): number => id & INDEX_MASK;

export const get_entity_generation = (id: EntityID): number =>
  (id >>> INDEX_BITS) & MAX_GENERATION;
