/***
 * Entity — Packed generational ID (20-bit index | 11-bit generation).
 *
 * Each entity ID encodes a slot index (low 20 bits, max ~1M entities)
 * and a generation counter (high 11 bits, max 2047). When an entity is
 * destroyed, its slot's generation increments. Subsequent lookups with
 * the old ID detect the stale generation and treat the entity as dead.
 *
 * A slot supports 2047 destroy/recreate cycles (generations 0..2046)
 * before its counter is exhausted. On the final cycle the allocator
 * RETIRES the slot (see `Store.destroyEntity`) instead of recycling
 * it, stamping the reserved RETIRED_GENERATION tombstone. Because that
 * value is never issued to a live handle, every stale handle to the
 * retired slot reads as dead — closing the ABA window where a wrapped
 * counter would otherwise let an old generation-0 handle alias a new
 * occupant (#376).
 *
 * The packed layout fits in 31 bits, so the sign bit is never set.
 * This means all bitwise results are positive — no unsigned coercion
 * needed, and signed right-shift extracts generation cleanly.
 *
 * Layout: [generation:11][index:20]
 *
 *   createEntityId(index, gen) → (gen << 20) | index
 *   getEntityIndex(id)         → id & 0xFFFFF
 *   getEntityGeneration(id)    → id >> 20
 *
 ***/

import { Brand, unsafeCast } from "../../type_primitives";
import { ECS_ERROR, ECSError } from "./utils/error";
import { TOTAL_PACKED_BITS } from "./utils/constants";
import { DEV } from "../../dev_flag";

export type EntityID = Brand<number, "entity_id">;

/**
 * Compile-time readonly view of a `Uint32Array` whose elements are packed
 * `EntityID`s — `Archetype.entityIds` returns this, so `ids[i]` is already
 * branded and consumers don't re-brand by hand. Blocks index writes at the
 * type layer.
 *
 * **Advisory, not a runtime barrier** — same caveat as `ReadonlyColumn`: the
 * underlying value is the live mutable buffer, and indexing past
 * `totalCount - 1` reads stale slots (the brand can't catch that).
 */
export interface ReadonlyEntityIdArray {
	readonly [index: number]: EntityID;
	readonly length: number;
}

export const INDEX_BITS = 20;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF — 20-bit mask
export const MAX_INDEX = INDEX_MASK; // 1,048,575
export const GENERATION_BITS = TOTAL_PACKED_BITS - INDEX_BITS; // 11
export const MAX_GENERATION = (1 << GENERATION_BITS) - 1; // 0x7FF (2047)

// Top generation value is reserved as a tombstone, never issued to a live
// handle. The slot allocator stamps it into a retired slot so that every
// stale handle (which can only carry generations 0..MAX_GENERATION-1) fails
// the `isAlive` generation check. Reserving it — rather than wrapping the
// counter back to 0 — is what closes the ABA stale-handle window (#376),
// and it stays in-range so SAB readers never see an out-of-range generation.
export const RETIRED_GENERATION = MAX_GENERATION; // 0x7FF — tombstone, not issued
// Highest generation actually handed out to a live entity (2046). A slot is
// retired once its next generation would reach RETIRED_GENERATION.
export const MAX_LIVE_GENERATION = MAX_GENERATION - 1; // 0x7FE (2046)

// Largest well-formed packed EntityID — every index and generation bit set
// (generation MAX_GENERATION, index MAX_INDEX). The 31-bit layout's ceiling, so
// the sign bit is never set. Bounds-check a decoded handle from semi-trusted bytes
// (snapshot / postMessage) against this before it masks onto a slot index (#723).
export const MAX_ENTITY_ID = (MAX_GENERATION << INDEX_BITS) | MAX_INDEX; // 0x7FFFFFFF

export const createEntityId = (index: number, generation: number): EntityID => {
	if (DEV) {
		if (index < 0 || index > MAX_INDEX) {
			throw new ECSError(ECS_ERROR.EID_MAX_INDEX_OVERFLOW);
		}

		if (generation < 0 || generation > MAX_GENERATION) {
			throw new ECSError(ECS_ERROR.EID_MAX_GEN_OVERFLOW);
		}
	}
	return unsafeCast<EntityID>((generation << INDEX_BITS) | index);
};

export const getEntityIndex = (id: EntityID): number => id & INDEX_MASK;

export const getEntityGeneration = (id: EntityID): number => (id as number) >> INDEX_BITS;
