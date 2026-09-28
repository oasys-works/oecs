/***
 * The snapshot seam. The host-side state a capture carries, the record `Store`
 * hands the service, and what the world calls on a service it did not build.
 *
 * The framing, the serialization and the fail-closed validation live in the
 * snapshots plugin. The core keeps this file because `Store` rebuilds its own
 * rows from a `HostState`, hands out a `SnapshotHost`, and reports the frame
 * version to a caller that never installs the plugin.
 *
 * Cold path. Every member here belongs to a capture or a mount.
 ***/

import type { Archetype } from "./archetype";
import type { RelationStoreView } from "./relation";
import type { SparseComponentStore } from "./sparse_store";
import type { StorageProvider } from "./storage_provider";
import type { ColumnStore, InPlaceBufferAllocator } from "../store";

/** Combined-frame format version. Bumped if the section framing or host-state
 * layout changes. Independent of `SIM_ABI_VERSION` (which gates the dense
 * bytes). Version 2 adds the plugin storage section. A restore still reads
 * version 1. */
export const ECS_SNAPSHOT_VERSION = 2;

/** Per-archetype host-side row bookkeeping the SAB doesn't carry authoritatively. */
export interface ArchetypeRowState {
	readonly archetypeId: number;
	/** Total live rows (enabled + disabled). */
	readonly length: number;
	/** Enabled-row partition boundary: rows `[0, enabledCount)` enabled. */
	readonly enabledCount: number;
}

/** The host-side state a snapshot captures alongside the dense + sparse bytes. */
export interface HostState {
	/** World tick at snapshot time (`Store.tick`). */
	readonly tick: number;
	/** Entity-index high-water (count of slots ever issued). Also mirrored in the
	 * SAB region's `length` header. Carried here for a cross-check on restore. */
	readonly entityHighWater: number;
	/** Live entity count. */
	readonly entityAliveCount: number;
	/** Recycle free-list in live order (LIFO: the last element is the next slot
	 * `createEntity` hands out). */
	readonly freeIndices: readonly number[];
	/** Per-archetype row state, one entry per SAB-backed archetype. */
	readonly archetypeRows: readonly ArchetypeRowState[];
}

/** What the snapshot and resume orchestration needs from `Store`, closure-
 * injected (the `RelationServiceHost` style). Accessors re-read live fields
 * per call (the column store and the entity-index views are replaced on
 * restore). The three mutation members keep Store-owned state transitions on
 * the Store side. All cold-path. */
export interface SnapshotHost {
	readonly sparseStores: () => readonly SparseComponentStore[];
	/** The relation stores, narrowed to what the codec folds and rebuilds. A
	 * world without the relations plugin answers with an empty list. */
	readonly relationStores: () => readonly RelationStoreView[];
	/** The plugin stores, in registration order. */
	readonly storages: () => readonly StorageProvider[];
	/** Live SAB generations view (replanted on restore), for rebuilding
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
	 * republish (the grow tail). Owned by Store, see `_mountRestoredDense`. */
	readonly mountRestoredDense: (restored: ColumnStore) => void;
	/** Rebuild each archetype's host-side `length` and `enabledCount`/entity-id
	 * back-references from the restored entity-index region + captured host
	 * state. Owned by Store, see `_reconstructHostRows`. */
	readonly reconstructHostRows: (host: HostState) => void;
	/** Every archetype's membership only changed, bump the query epoch and
	 * force the next descriptor publish. */
	readonly invalidateCaches: () => void;
}

/** What the world calls into a snapshot service it did not build.
 *
 * `Store` keeps the `DETERMINISM_DISABLED` gate and delegates the four
 * captures and mounts through this. A world without the plugin holds `null`
 * here and answers a reach with the fault that names the import. */
export interface SnapshotHooks {
	snapshot(): Uint8Array;
	restore(bytes: Uint8Array): void;
	snapshotSparse(): Uint8Array;
	restoreSparse(bytes: Uint8Array): void;
}
