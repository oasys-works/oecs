/**
 * Entity-index SAB region — `EntityID` → `(archetype_id, row, generation)`
 * lookup table shared with the Zig sim. (#245 / Phase 4 PR 4B)
 *
 * Every hot fixed-update system that needs to resolve an `EntityID`
 * held in a column (e.g. a component field that points at another
 * entity → that entity's columns) has to do
 * `entityId → archetype + row` translation. The plan forbids
 * WASM-into-TS callbacks during `tick()` (§4 / §5.2), so the lookup
 * tables must live in shared memory.
 *
 * Layout:
 *
 *   [ length:    u32 ]   high-water index (count of slots ever issued)
 *   [ capacity:  u32 ]   backing-array length (slots × 1; not bytes)
 *   [ _pad0:     u32 ]   alignment pad to 16 bytes
 *   [ _pad1:     u32 ]   ───
 *   [ generations[capacity]: i32 ]
 *   [ archetypes[capacity]:  i32 ]
 *   [ rows[capacity]:        i32 ]
 *
 * Sentinels:
 *   - `generations[i] = 0` (INITIAL_GENERATION) for never-used slots.
 *     Generation grows by 1 on every destroy; an `EntityID`'s generation
 *     field matches `generations[index]` iff it's still alive.
 *   - `archetypes[i] = -1` (UNASSIGNED) when the slot hasn't been placed
 *     into an archetype, OR when the entity is destroyed.
 *   - `rows[i]      = -1` (UNASSIGNED) on destroy / not-placed.
 *
 * Field width: i32 (signed) on the TS side so `-1` round-trips through
 * `Int32Array` without unsigned coercion. Zig reads as i32 too — bit
 * pattern is identical to u32 `0xFFFFFFFF` for the UNASSIGNED case, and
 * for valid archetype_ids (bounded by `MAX_INDEX = 2^20`) the sign bit
 * is never set, so signed/unsigned interpretation agrees.
 *
 * Region placement: between command ring and descriptor region so the
 * offset is stable across descriptor / column-region growth (same
 * property the command ring gets). Grow path (when entityHighWater
 * exceeds `capacity`) uses `growColumnStore` — slow path, same as
 * descriptor-region overflow.
 *
 * Reading from Zig: see `packages/sim/src/entity_index.zig` for the
 * symmetric reader.
 */

/** Fixed bytes of the region header (length, capacity, two pad u32s for
 * 16-byte alignment of the i32 arrays that follow). */
export const ENTITY_INDEX_HEADER_BYTES = 16;

/** Bytes per slot: three i32 columns. */
export const ENTITY_INDEX_BYTES_PER_SLOT = 12;

/** Byte offsets within the region header. Locked by the
 * `entity_index.test.ts` golden bytes; any change here is a
 * `SIM_ABI_VERSION` bump. */
export const ENTITY_INDEX_HEADER_OFFSETS = {
	length: 0,
	capacity: 4
	// 8..16: pad to 16-byte alignment so the i32 arrays start aligned.
} as const;

/** Default initial slot count when the engine creates a Store. Matches
 * `MAX_INDEX = (1 << 20) - 1 + 1 = 1_048_576` (the EntityID 20-bit index
 * range, see `entity.ts`), so the region pre-sizes to the entire
 * addressable entity space and `createEntity` can never run out under
 * the default. 1M × 12 B ≈ 12 MiB SAB region — virtual memory only;
 * physical pages allocate lazily via OS page-fault on first touch, so
 * the typical 1000-entity workload pays for ~12 KiB physical even though the
 * virtual reservation is 12 MiB.
 *
 * Tests / benches can pass a smaller `StoreOptions.entityIndexCapacity`
 * to bench tighter reservations. A future PR will replace this with
 * on-demand growth via `growColumnStore` so the default can drop. */
export const ENTITY_INDEX_DEFAULT_CAPACITY = 1 << 20;

/** Total region bytes for `capacity` slots: header + 3 i32 columns. */
export function entityIndexRegionBytes(capacity: number): number {
	if (capacity < 0 || !Number.isInteger(capacity)) {
		throw new EntityIndexError(
			`entity_index capacity must be a non-negative integer (got ${capacity})`
		);
	}
	return ENTITY_INDEX_HEADER_BYTES + capacity * ENTITY_INDEX_BYTES_PER_SLOT;
}

/** Byte offset of the generations column within the region. */
export function entityIndexGenerationsOff(regionOff: number): number {
	return regionOff + ENTITY_INDEX_HEADER_BYTES;
}

/** Byte offset of the archetype-id column. */
export function entityIndexArchetypesOff(regionOff: number, capacity: number): number {
	return regionOff + ENTITY_INDEX_HEADER_BYTES + capacity * 4;
}

/** Byte offset of the row column. */
export function entityIndexRowsOff(regionOff: number, capacity: number): number {
	return regionOff + ENTITY_INDEX_HEADER_BYTES + capacity * 8;
}

export class EntityIndexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EntityIndexError";
	}
}

/** Initialise the region header at `regionOff`. Sets `length=0` and
 * `capacity=<arg>`. The i32 arrays past the header are left untouched
 * (callers normally allocate the region on a fresh, zero-initialised
 * SAB; generation 0 is the INITIAL_GENERATION sentinel, archetype/row
 * sentinels of 0 are caught by `length=0` so no read reaches them). */
export function initEntityIndexRegion(
	view: DataView,
	regionOff: number,
	capacity: number
): void {
	if (capacity < 0 || !Number.isInteger(capacity)) {
		throw new EntityIndexError(
			`entity_index capacity must be a non-negative integer (got ${capacity})`
		);
	}
	view.setUint32(regionOff + ENTITY_INDEX_HEADER_OFFSETS.length, 0, true);
	view.setUint32(regionOff + ENTITY_INDEX_HEADER_OFFSETS.capacity, capacity, true);
	// Pad bytes (8..16) stay zero.
}

/** Read the region's current length (high-water index, ≤ capacity). */
export function entityIndexLength(view: DataView, regionOff: number): number {
	return view.getUint32(regionOff + ENTITY_INDEX_HEADER_OFFSETS.length, true);
}

/** Read the region's current capacity (backing-array length). */
export function entityIndexCapacity(view: DataView, regionOff: number): number {
	return view.getUint32(regionOff + ENTITY_INDEX_HEADER_OFFSETS.capacity, true);
}

/** Update the region's length (called from the engine's Store on every
 * entity allocation that pushes `entityHighWater` past its previous
 * value). */
export function setEntityIndexLength(view: DataView, regionOff: number, length: number): void {
	view.setUint32(regionOff + ENTITY_INDEX_HEADER_OFFSETS.length, length, true);
}

/** Materialise the three Int32Array views over the region's column data
 * for use by the engine's Store. The views live as long as the
 * SharedArrayBuffer hasn't been reallocated — refresh on `view_stamp`
 * bump (the engine's `_onBufferResized` callback).
 *
 * Three separate views (not a single struct-of-arrays object) because
 * the engine's hot paths benefit from each being a direct typed-array
 * read; V8 specialises `arr[i] = v` aggressively for typed arrays. */
export function buildEntityIndexViews(
	buffer: ArrayBufferLike,
	regionOff: number,
	capacity: number
): {
	readonly generations: Int32Array;
	readonly archetypes: Int32Array;
	readonly rows: Int32Array;
} {
	// boundary: TypedArray interop. The region was sized to fit
	// `capacity` slots × 3 i32 columns; the SAB is the source of truth.
	return {
		generations: new Int32Array(buffer, entityIndexGenerationsOff(regionOff), capacity),
		archetypes: new Int32Array(buffer, entityIndexArchetypesOff(regionOff, capacity), capacity),
		rows: new Int32Array(buffer, entityIndexRowsOff(regionOff, capacity), capacity)
	};
}
