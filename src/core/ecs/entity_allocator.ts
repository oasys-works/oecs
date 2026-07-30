/***
 * EntityAllocator — generational entity-slot allocator.
 *
 * Owns the allocation half of the entity index: the SAB-backed generations
 * view, the high-water mark, the free-list, and the alive count. `Store`
 * keeps the *membership* half (`entityArchetype` / `entityRow`) — which
 * archetype and row a live slot occupies is archetype state, not allocation
 * state.
 *
 * Slot protocol (see entity.ts for the packed-ID layout):
 *   - `alloc()` pops the free-list (reusing the slot at its already-bumped
 *     generation) or bump-allocates a fresh index at INITIAL_GENERATION,
 *     mirroring the new high-water into the SAB region's `length` header so
 *     an external (WASM) reader knows the in-use range.
 *   - `recycle(index, generation)` bumps the generation so stale handles die;
 *     once the counter would reach the RETIRED_GENERATION tombstone the slot
 *     is retired instead of recycled — the tombstone is never issued
 *     to a live handle, closing the ABA stale-handle window.
 *
 * SAB replant contract: `generations` and the length view are TypedArray
 * views into the column store's entity-index region, which is reallocated on
 * snapshot restore. The owner MUST call `replantViews` whenever the backing
 * moves (Store does this from `_refreshEntityIndexViews`). Collaborators that
 * hold this allocator re-read `generations` per operation via the getter —
 * the same closure-accessor discipline `RelationServiceHost` uses.
 */

import { ECS_ERROR, ECSError } from "./utils/error";
import { createEntityId, RETIRED_GENERATION, type EntityID } from "./entity";
import { INITIAL_GENERATION } from "./utils/constants";

export class EntityAllocator {
	/** SAB-backed per-slot generation counters — replanted on restore. */
	private _generations: Int32Array;
	/** Single-slot view over the entity-index region's `length` header field —
	 * replanted on restore. Written on every high-water bump. */
	private _lengthView: Uint32Array;
	private _highWater = 0;
	private readonly _freeIndices: number[] = [];
	private _aliveCount = 0;
	private readonly _capacity: number;

	/** Slot index of the entity allocated by the most recent `alloc` call —
	 * alloc-free out-param, read immediately after the call (the `_spawnIndex`
	 * pattern the pre-extraction Store used). */
	public lastIndex = 0;

	constructor(capacity: number, generations: Int32Array, lengthView: Uint32Array) {
		this._capacity = capacity;
		this._generations = generations;
		this._lengthView = lengthView;
	}

	/** Re-point the SAB views after the backing buffer was reallocated
	 * (grow/extend/restore). Does NOT touch host-side counters. */
	public replantViews(generations: Int32Array, lengthView: Uint32Array): void {
		this._generations = generations;
		this._lengthView = lengthView;
	}

	/** The live generations view. Hot flush loops hoist this to a local once
	 * per flush; do not cache it across a potential SAB replant. */
	public get generations(): Int32Array {
		return this._generations;
	}

	public get highWater(): number {
		return this._highWater;
	}

	public get aliveCount(): number {
		return this._aliveCount;
	}

	public get freeCount(): number {
		return this._freeIndices.length;
	}

	/** Allocate a slot and return its packed id; the slot index is left in
	 * `lastIndex`. This *commits* the slot (bumps counts, stamps the generation
	 * so `isAliveIndex` is already true) — a caller placing the entity into an
	 * archetype row must have reserved column capacity first. */
	public alloc(): EntityID {
		let index: number;
		let generation: number;
		if (this._freeIndices.length > 0) {
			// ! safe: length > 0 guarantees pop() returns a value
			index = this._freeIndices.pop()!;
			generation = this._generations[index];
		} else {
			// SAB entity-index capacity caps high-water. The
			// future capacity-grow path will lift this; for now, exceeding
			// it surfaces as a clear `EID_MAX_INDEX_OVERFLOW` rather than a
			// silent typed-array out-of-bounds write.
			if (this._highWater >= this._capacity) {
				throw new ECSError(
					ECS_ERROR.EID_MAX_INDEX_OVERFLOW,
					`entityIndexCapacity (${this._capacity}) exhausted; raise it in ECSOptions.memory or destroy unused entities`
				);
			}
			index = this._highWater++;
			this._generations[index] = INITIAL_GENERATION;
			generation = INITIAL_GENERATION;
			// Mirror the high-water index into the SAB region's `length`
			// field so the Zig reader knows the in-use range.
			this._lengthView[0] = this._highWater;
		}
		this._aliveCount++;
		this.lastIndex = index;
		return createEntityId(index, generation);
	}

	/** Pre-check that `count` fresh slots fit, so a bulk-spawn commits
	 * all-or-nothing: `alloc`'s own per-call guard would otherwise
	 * throw partway through the loop, leaving committed slots phantom-alive.
	 * Free-list reuse covers the first `freeCount` slots; only the remainder
	 * draws down the high-water headroom. */
	public ensureCapacity(count: number): void {
		const fromHighWater = count - this._freeIndices.length;
		if (fromHighWater > 0 && this._highWater + fromHighWater > this._capacity) {
			throw new ECSError(
				ECS_ERROR.EID_MAX_INDEX_OVERFLOW,
				`entityIndexCapacity (${this._capacity}) cannot fit ${count} new entities ` +
					`(${this._freeIndices.length} free, high-water ${this._highWater}); ` +
					`raise it in ECSOptions.memory or destroy unused entities`
			);
		}
	}

	/** Recycle (or retire) a slot whose entity carried `generation`. Bumps the
	 * generation so stale IDs read dead; once the counter would reach the
	 * reserved tombstone the slot is RETIRED, not recycled: stamp
	 * RETIRED_GENERATION (never issued to a live handle) and skip the
	 * free-list push, closing the ABA window. Burning one of 2^20 indices
	 * after 2047 reuses is cheap; the branch is predicted not-taken on
	 * essentially every destroy. */
	public recycle(index: number, generation: number): void {
		const nextGen = generation + 1;
		if (nextGen < RETIRED_GENERATION) {
			this._generations[index] = nextGen;
			this._freeIndices.push(index);
		} else {
			this._generations[index] = RETIRED_GENERATION;
		}
		this._aliveCount--;
	}

	/** Allocation-side liveness: the slot is in the issued range and its
	 * current generation matches the handle's. (`Store.isAlive` layers the
	 * malformed-handle guards on top of this.) */
	public isAliveIndex(index: number, generation: number): boolean {
		return index < this._highWater && this._generations[index] === generation;
	}

	/** Mirror the current high-water into the SAB `length` header — called
	 * after a buffer replant so the fresh region carries the host value. */
	public publishLength(): void {
		this._lengthView[0] = this._highWater;
	}

	// --- Snapshot / restore (host-side state; the generations bytes travel
	// --- inside the dense SAB section, not here) ---

	public snapshotFreeIndices(): number[] {
		return this._freeIndices.slice();
	}

	/** Restore path, step 1: adopt the high-water recovered from the restored
	 * region's length header BEFORE the replant republishes it. */
	public setHighWater(value: number): void {
		this._highWater = value;
	}

	/** Restore path, step 2: adopt the captured free-list + alive count. */
	public restoreHostState(freeIndices: readonly number[], aliveCount: number): void {
		this._freeIndices.length = 0;
		for (let i = 0; i < freeIndices.length; i++) this._freeIndices.push(freeIndices[i]);
		this._aliveCount = aliveCount;
	}
}
