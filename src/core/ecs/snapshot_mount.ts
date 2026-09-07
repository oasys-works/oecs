/***
 * The two live-world mutation steps a restore takes, after the snapshots
 * plugin has validated and decoded a frame.
 *
 * Free functions with explicit arguments, not a class and not a closure host.
 * A restore runs at most once per frame boundary and usually once per session,
 * so nothing here is on a per-row, per-frame or structural path. Explicit
 * arguments keep the ordering contract visible: `refreshEntityIndexViews`
 * replants the two index views, and `reconstructHostRows` reads them, so the
 * caller passes the fresh views rather than reaching for a field that may be
 * stale.
 *
 * The store keeps the two steps as private methods, because both write state
 * the store owns: the live column store and the archetypes' host-side row
 * bookkeeping. What moves here is the walk, not the assignment.
 *
 * `RestorableArchetype` names what a restore needs from an archetype instead
 * of naming `Archetype` itself. The narrow contract is the point: a restore
 * refreshes views, drops the row ticks and rewrites the host rows, and it
 * touches nothing else on an archetype.
 ***/

import { ENTITY_INDEX_HEADER_OFFSETS } from "../store/entity_index";
import type { ColumnStore } from "../store/column_store";
import type { ArchetypeID } from "./archetype_types";
import type { EntityAllocator } from "./entity_allocator";
import { createEntityId } from "./entity";
import { UNASSIGNED } from "./utils/constants";
import { ECSRestoreError } from "./utils/error";
import type { HostState } from "./snapshot";
import { DEV } from "../../dev_flag";

/** What a restore asks of an archetype. Every live `Archetype` satisfies it. */
export interface RestorableArchetype {
	readonly isBufferBacked: boolean;
	refreshViews(store: ColumnStore): void;
	resetTicks(): void;
	restoreHostRows(rows: number[], enabledCount: number): void;
}

/** One archetype, by id, for the row reconstruction below. */
export type ArchetypeLookup = (id: ArchetypeID) => RestorableArchetype;

/**
 * Republish every buffer-backed archetype's views over the restored backing,
 * drop the row ticks, and recover the allocator high-water from the restored
 * entity-index region.
 *
 * The caller assigns the restored store to its own field first, and calls its
 * buffer-resized handler after. The high-water read has to happen before that
 * handler, because the handler mirrors the host high-water back into the
 * header and a stale host value would clobber the restored one.
 *
 * The rows under the tick plane belong to the snapshot now, so no record made
 * before the restore names a write of theirs. That is why every archetype's
 * ticks reset, buffer-backed or not.
 */
export function adoptRestoredBacking(
	restored: ColumnStore,
	archetypes: readonly RestorableArchetype[],
	allocator: EntityAllocator
): void {
	for (let i = 0; i < archetypes.length; i++) {
		if (archetypes[i].isBufferBacked) archetypes[i].refreshViews(restored);
		archetypes[i].resetTicks();
	}
	allocator.setHighWater(
		restored.view.getUint32(
			restored.header.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length,
			true
		)
	);
}

/**
 * Rebuild each buffer-backed archetype's host-side `length`, `enabledCount`
 * and per-row entity ids after a restore swapped the dense backing.
 *
 * `length` and the row-to-entity back reference come from a scan of the
 * restored entity-index region, which says what entity occupies what row.
 * `enabledCount` comes from the captured host state, because the enabled
 * partition boundary is positional and has no per-entity byte source.
 *
 * The caller guarantees that `entityArchetypes` and `entityRows` are the views
 * over the restored region, not the views from before the swap.
 */
export function reconstructHostRows(
	host: HostState,
	archetypeAt: ArchetypeLookup,
	entityArchetypes: Int32Array,
	entityRows: Int32Array,
	allocator: EntityAllocator
): void {
	const highWater = allocator.highWater;
	const gens = allocator.generations;
	// Per-archetype row → packed EntityID, dense over [0, length).
	const rowsByArch = new Map<number, number[]>();
	for (let i = 0; i < highWater; i++) {
		const aid = entityArchetypes[i];
		if (aid === UNASSIGNED) continue; // free or retired slot
		const row = entityRows[i];
		if (row === UNASSIGNED) continue; // component-less alive entity (no row)
		let rows = rowsByArch.get(aid);
		if (rows === undefined) {
			rows = [];
			rowsByArch.set(aid, rows);
		}
		rows[row] = createEntityId(i, gens[i]) as number;
	}
	for (let r = 0; r < host.archetypeRows.length; r++) {
		const meta = host.archetypeRows[r];
		const a = archetypeAt(meta.archetypeId as ArchetypeID);
		const rows = rowsByArch.get(meta.archetypeId) ?? [];
		if (DEV) {
			if (rows.length !== meta.length) {
				throw new ECSRestoreError(
					`archetype ${meta.archetypeId} row-count mismatch on restore: scan found ` +
						`${rows.length} rows, host-state recorded ${meta.length}`
				);
			}
			for (let k = 0; k < rows.length; k++) {
				if (rows[k] === undefined) {
					throw new ECSRestoreError(
						`archetype ${meta.archetypeId} has a hole at row ${k} after restore ` +
							`(entity-index region inconsistent)`
					);
				}
			}
		}
		a.restoreHostRows(rows, meta.enabledCount);
	}
}
