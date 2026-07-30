/***
 * SnapshotService — world snapshot / resume orchestration.
 *
 * Owns the serialization, framing, and fail-closed validation of the
 * determinism-gated snapshot surface: the sparse+relation section
 * (`snapshotSparse` / `restoreSparse`), and the full-world capture/mount
 * (`snapshot` / `restoreInto`). The `DETERMINISM_DISABLED` gate stays
 * on `Store`'s public delegations — this service assumes the gate
 * already passed.
 *
 * Boundary: the service reaches other state ONLY
 * through explicit snapshot seams —
 *   - `EntityAllocator` exposes its own snapshot interface
 *     (`snapshotFreeIndices` / `setHighWater` / `restoreHostState`), passed
 *     in whole as the per-collaborator seam;
 *   - live-world mutations that belong to the Store (swapping the column
 *     store backing, rebuilding host-side rows, cache invalidation) stay as
 *     Store-owned closures on `SnapshotHost`, so the service never assigns
 *     Store fields.
 */

import type { EntityID } from "./entity";
import { createEntityId } from "./entity";
import type { Archetype } from "./archetype";
import type { EntityAllocator } from "./entity_allocator";
import {
	SparseComponentStore,
	snapshotSparseStores,
	restoreSparseStores,
	validateSparseStores,
	SparseRestoreError
} from "./sparse_store";
import { snapshotRelations, restoreRelations, type RelationStore } from "./relation";
import {
	restoreColumnStore,
	snapshotColumnStore,
	type ColumnStore,
	type InPlaceBufferAllocator
} from "../store";
import {
	assertDenseLayoutMatchesLive,
	frameWorldSnapshot,
	parseHostState,
	serializeHostState,
	unframeWorldSnapshot,
	type ArchetypeRowState,
	type HostState
} from "./resume";

/** What the snapshot/resume orchestration needs from `Store` — closure-
 * injected (the `RelationServiceHost` style). Accessors re-read live fields
 * per call (the column store and the entity-index views are replaced on
 * restore); the three mutation members keep Store-owned state transitions on
 * the Store side. All cold-path. */
export interface SnapshotHost {
	readonly sparseStores: () => readonly SparseComponentStore[];
	readonly relationStores: () => readonly RelationStore[];
	/** Live SAB generations view (replanted on restore) — for rebuilding
	 * relation ids from entity indices. */
	readonly generations: () => Int32Array;
	readonly archetypes: () => readonly Archetype[];
	readonly columnStore: () => ColumnStore;
	readonly bufferAllocator: () => InPlaceBufferAllocator;
	readonly entityIndexCapacity: () => number;
	readonly tick: () => number;
	readonly setTick: (tick: number) => void;
	/** Stamp live row counts into the dense descriptors so a bare dense
	 * reader of the snapshot sees self-consistent counts. */
	readonly publishRowCounts: () => void;
	/** Adopt a restored dense store: swap the live backing, refresh archetype
	 * views, recover the allocator high-water from the restored region, and
	 * republish (the grow tail). Owned by Store — see `_mountRestoredDense`. */
	readonly mountRestoredDense: (restored: ColumnStore) => void;
	/** Rebuild each archetype's host-side `length`/`enabledCount`/entity-id
	 * back-references from the restored entity-index region + captured host
	 * state. Owned by Store — see `_reconstructHostRows`. */
	readonly reconstructHostRows: (host: HostState) => void;
	/** Every archetype's membership just changed — bump the query epoch and
	 * force the next descriptor publish. */
	readonly invalidateQueryCaches: () => void;
}

export class SnapshotService {
	private readonly host: SnapshotHost;
	/** The allocator IS its own snapshot seam: free-list copy on
	 * capture; `setHighWater` + `restoreHostState` on mount. */
	private readonly allocator: EntityAllocator;

	constructor(host: SnapshotHost, allocator: EntityAllocator) {
		this.host = host;
		this.allocator = allocator;
	}

	/** Serialize the sparse stores **and** relation side data to a self-contained
	 * byte buffer — the sparse half of a world snapshot (the dense half is the
	 * SAB snapshot). Two framed sections: the sparse stores (`snapshotSparseStores`
	 * — exclusive relation targets + multi membership ride here) followed
	 * by the relation side data (`snapshotRelations` — multi forward target
	 * sets, which live outside the sparse store). Both are written in canonical
	 * entity-index order, so two worlds with identical contents inserted in
	 * different orders snapshot byte-for-byte the same. The reverse index
	 * is derived and never serialized — `restoreSparse` rebuilds it. */
	public snapshotSparse(): Uint8Array {
		const sparse = snapshotSparseStores(this.host.sparseStores());
		const rel = snapshotRelations(this.host.relationStores());
		// Frame: u32 sparseLen, u32 relLen, then the two sections back to back.
		const out = new Uint8Array(8 + sparse.length + rel.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, sparse.length, true);
		view.setUint32(4, rel.length, true);
		out.set(sparse, 8);
		out.set(rel, 8 + sparse.length);
		return out;
	}

	/** Repopulate the sparse stores from `snapshotSparse` bytes, replacing all
	 * current sparse data (full-equality round-trip of membership + data), then
	 * rebuild every relation's derived side indices: multi forward sets from the
	 * relation section, and the reverse index for both cardinalities (exclusive
	 * from the just-restored sparse target field, multi from the rebuilt forward
	 * sets). The sparse components and relations must already be registered in
	 * the same order — restore carries data, not the registration (which is
	 * code). Throws `SparseRestoreError` if the snapshot's shape, field identity,
	 * entity-index bounds, or frame length don't validate. */
	public restoreSparse(bytes: Uint8Array): void {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.byteLength < 8) {
			throw new SparseRestoreError(
				`sparse snapshot truncated: need 8 header bytes, have ${bytes.byteLength}`
			);
		}
		const sparseLen = view.getUint32(0, true);
		const relLen = view.getUint32(4, true);
		// Exact frame, not a lower bound: a buffer LONGER than the declared frame
		// must be rejected too, or two buffers differing only in trailing padding
		// would restore identically — the snapshot wouldn't be a canonical
		// encoding. `!==` also subsumes the old under-declared (truncated)
		// case.
		if (8 + sparseLen + relLen !== bytes.byteLength) {
			throw new SparseRestoreError(
				`sparse snapshot frame mismatch: header declares 8+${sparseLen}+${relLen}=${8 + sparseLen + relLen} bytes, buffer is ${bytes.byteLength}`
			);
		}
		restoreSparseStores(this.host.sparseStores(), bytes.subarray(8, 8 + sparseLen));
		this.rebuildRelationIndices(bytes.subarray(8 + sparseLen, 8 + sparseLen + relLen));
	}

	/** Rebuild every relation's derived side indices after the sparse stores have
	 * been restored. `restoreRelations` resets all relations, rebuilds the multi
	 * forward sets + their reverse edges from `relBytes`, and validates shape.
	 * The exclusive reverse index can't be carried in the bytes (it's derivable),
	 * so it's rebuilt here from the backing sparse store: every member row holds
	 * `(source index → target EntityID)`, which is exactly one reverse edge. */
	private rebuildRelationIndices(relBytes: Uint8Array): void {
		const gens = this.host.generations();
		const makeId = (idx: number): EntityID => createEntityId(idx, gens[idx]);
		const rels = this.host.relationStores();
		restoreRelations(rels, relBytes, makeId);
		// Exclusive relations rebuild their reverse index from the just-restored
		// sparse target field; multi relations already rebuilt theirs alongside the
		// forward sets in `restoreRelations`. The cardinality split is virtual.
		for (let r = 0; r < rels.length; r++) rels[r].rebuildReverseFromForward(makeId);
	}

	/** Capture the full live world to one self-contained byte buffer that
	 * `restoreInto` can mount back onto a live, ticking world. Three
	 * sections (see `resume.ts`): the dense SAB column bytes, the sparse +
	 * relation bytes, and the host-side bookkeeping the SAB omits. */
	public snapshot(): Uint8Array {
		// Keep the dense descriptors self-consistent for any bare dense reader (our
		// own restore reconstructs from host-state + a region scan, not from the
		// descriptor row counts).
		this.host.publishRowCounts();
		// snapshotColumnStore returns a view that tracks later writes — copy it so
		// the combined buffer is a stable owned snapshot.
		const dense = new Uint8Array(snapshotColumnStore(this.host.columnStore()));
		const sparse = this.snapshotSparse();
		const host = serializeHostState(this.collectHostState());
		return frameWorldSnapshot(dense, sparse, host);
	}

	/** Gather the host-side state a snapshot carries alongside the dense + sparse
	 * bytes — see `snapshot()`. The free-list is copied (it's a live mutable). */
	private collectHostState(): HostState {
		const archetypeRows: ArchetypeRowState[] = [];
		const archs = this.host.archetypes();
		for (let i = 0; i < archs.length; i++) {
			const a = archs[i];
			if (!a.isBufferBacked) continue;
			archetypeRows.push({
				archetypeId: a.id as number,
				length: a.length,
				enabledCount: a.enabledCount
			});
		}
		return {
			tick: this.host.tick(),
			entityHighWater: this.allocator.highWater,
			entityAliveCount: this.allocator.aliveCount,
			freeIndices: this.allocator.snapshotFreeIndices(),
			archetypeRows
		};
	}

	/** Mount a `snapshot()` buffer onto the live world and leave it ready to keep
	 * ticking. Fails closed on a malformed frame or a registration mismatch
	 * BEFORE any live state is touched. */
	public restoreInto(bytes: Uint8Array): void {
		const sections = unframeWorldSnapshot(bytes);
		const host = parseHostState(sections.host);

		// --- Fail closed BEFORE mutating any live state ---
		// `restoreColumnStore` (below) builds the restored store through the live
		// world's in-place allocator, which reuses the live backing
		// buffer — so it OVERWRITES live column bytes as it copies the snapshot
		// in. A guard run on the materialised store would therefore fire only
		// after the live world was already clobbered. So validate everything that
		// gates the mount straight from the snapshot BYTES first: the dense
		// archetype set + per-column layout + entity-index capacity, and the
		// sparse-section shape (store count + field identity). The archetype/
		// component/sparse graph is rebuilt from code, not the snapshot (same
		// contract as `restoreSparse`); a mismatch leaves the world untouched.
		assertDenseLayoutMatchesLive(
			sections.dense,
			this.host.columnStore().archetypes,
			this.host.entityIndexCapacity()
		);
		this.assertSparseSectionMatches(sections.sparse);

		// --- Mount: build the restored dense store (now safe to overwrite the
		//     live backing) and hand it to the Store to adopt (view refresh +
		//     high-water recovery + republish — the grow tail). ---
		const restored = restoreColumnStore(sections.dense, this.host.bufferAllocator());
		this.host.mountRestoredDense(restored);

		// --- Reconstruct host-side row bookkeeping + allocator state + tick ---
		this.host.reconstructHostRows(host);
		this.allocator.restoreHostState(host.freeIndices, host.entityAliveCount);
		this.host.setTick(host.tick);

		// Every archetype's membership/length just changed — invalidate query
		// caches and force the next descriptor publish.
		this.host.invalidateQueryCaches();

		// Restore the sparse + relation half in place (rebuilds relation reverse
		// indices). Its shape was already validated above, so this only commits data
		// (a registration mismatch would have failed closed before the dense mount).
		this.restoreSparse(sections.sparse);
	}

	/** Read-only validation of a `snapshotSparse` SECTION (the framed
	 * `[sparseLen][relLen][sparse][rel]` buffer) against the live registry, used
	 * by `restoreInto` to fail closed on a sparse-registration mismatch BEFORE the
	 * dense mount commits. Mirrors `restoreSparse`'s frame check, then validates the
	 * sparse-stores sub-section without mutating. A relation-registration difference
	 * surfaces here too: every `registerRelation` adds a backing sparse store, so a
	 * differing relation set changes the sparse store count / schema. Throws
	 * `SparseRestoreError` on a mismatch. */
	private assertSparseSectionMatches(bytes: Uint8Array): void {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.byteLength < 8) {
			throw new SparseRestoreError(
				`sparse snapshot truncated: need 8 header bytes, have ${bytes.byteLength}`
			);
		}
		const sparseLen = view.getUint32(0, true);
		const relLen = view.getUint32(4, true);
		if (8 + sparseLen + relLen !== bytes.byteLength) {
			throw new SparseRestoreError(
				`sparse snapshot frame mismatch: header declares 8+${sparseLen}+${relLen}=${8 + sparseLen + relLen} bytes, buffer is ${bytes.byteLength}`
			);
		}
		validateSparseStores(this.host.sparseStores(), bytes.subarray(8, 8 + sparseLen));
	}
}
