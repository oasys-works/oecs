/***
 * Entity — Packed generational ID (20-bit index | 11-bit generation).
 *
 * Each entity ID encodes a slot index (low 20 bits, max ~1M entities)
 * and a generation counter (high 11 bits, max 2047). When an entity is
 * destroyed, its slot's generation increments. Subsequent lookups with
 * the old ID detect the stale generation and treat the entity as dead.
 *
 * The packed layout fits in 31 bits, so the sign bit is never set.
 * This means all bitwise results are positive — no unsigned coercion
 * needed, and signed right-shift extracts generation cleanly.
 *
 * Layout: [generation:11][index:20]
 *
 *   create_entity_id(index, gen) → (gen << 20) | index
 *   get_entity_index(id)         → id & 0xFFFFF
 *   get_entity_generation(id)    → id >> 20
 *
 ***/

import { Brand, unsafe_cast } from "type_primitives";
import { ECS_ERROR, ECSError } from "./utils/error";
import { TOTAL_PACKED_BITS } from "./utils/constants";

export type EntityID = Brand<number, "entity_id">;

export const INDEX_BITS = 20;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF — 20-bit mask
export const MAX_INDEX = INDEX_MASK; // 1,048,575
export const GENERATION_BITS = TOTAL_PACKED_BITS - INDEX_BITS; // 11
export const MAX_GENERATION = (1 << GENERATION_BITS) - 1; // 0x7FF (2047)

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
  return unsafe_cast<EntityID>((generation << INDEX_BITS) | index);
};

export const get_entity_index = (id: EntityID): number => id & INDEX_MASK;

export const get_entity_generation = (id: EntityID): number =>
  (id as number) >> INDEX_BITS;
