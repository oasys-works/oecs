/***
 *
 * Entity - Packed generational ID (20-bit index | 12-bit generation).
 * See docs/DESIGN.md [opt:1] for bit layout and rationale.
 *
 ***/

import { Brand, unsafe_cast } from "type_primitives";
import { ECS_ERROR, ECSError } from "./utils/error";

export type EntityID = Brand<number, "entity_id">;

//=========================================================
// Constants
//=========================================================
export const INDEX_BITS = 20;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xF_FFFF - a bitmask of 20 ones
export const MAX_INDEX = INDEX_MASK; // 1_048_575
export const MAX_GENERATION = (1 << (32 - INDEX_BITS)) - 1; // 0xFFF (4095)

// optimization*1

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
  return unsafe_cast<EntityID>(((generation << INDEX_BITS) | index) >>> 0);
};

// optimization*1

/** Extract the slot index (low 20 bits). */
export const get_entity_index = (id: EntityID): number => id & INDEX_MASK;

/** Extract generation (high 12 bits). */
export const get_entity_generation = (id: EntityID): number =>
  (id >>> INDEX_BITS) & MAX_GENERATION;
