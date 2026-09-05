/***
 * The snapshot plugin. Capture a live world, mount one back.
 *
 * Install it to give a world `capture` / `restore` and their sparse halves.
 * A world that does not install it keeps `ecs.snapshots.stateHash()` and
 * `ecs.snapshots.deterministic`, which are properties of the world itself, and
 * carries none of the serialization, framing or fail-closed validation code.
 *
 * The determinism opt-in is separate and still required: `capture` and
 * `restore` throw `DETERMINISM_DISABLED` on a world built without
 * `{ deterministic: true }`, installed or not. Installing the plugin grants
 * the surface. It does not grant canonical ordering.
 *
 * Cold path. Every method here serializes or validates a whole world.
 ***/

import { SnapshotService } from "../core/ecs/snapshot_service";
import { ECSSnapshots } from "../core/ecs/facades";
import type { Plugin, PluginHost } from "../core/ecs/plugin";

/** The world surface this plugin adds. `ecs.snapshots` is already an
 * `ECSSnapshots`, and this widens it: an intersection of the two is the
 * subclass, so an installed world reaches `capture` and a bare one does not. */
export interface SnapshotsPlugin {
	readonly snapshots: ECSSnapshotsFull;
}

/** `ECSSnapshots` plus the capture and restore surface. */
export class ECSSnapshotsFull extends ECSSnapshots {
	/** Capture the full live world (dense + sparse and relations + host-side
	 * bookkeeping) to one self-contained byte buffer that `restore` can mount
	 * back onto a live, ticking world. v1 does not capture resources,
	 * events, or change-detection baselines. */
	public capture(): Uint8Array {
		return this._store.snapshot();
	}

	/** Mount a `capture()` buffer onto this live world and keep ticking.
	 * Fails closed on a malformed frame or registration mismatch before
	 * mutating any live state. Requires a matching archetype set + column
	 * layout (prewarm so the set is stable). */
	public restore(bytes: Uint8Array): void {
		this._store.restore(bytes);
	}

	/** Serialize the sparse stores + relations to a self-contained buffer,
	 * the sparse half of a world snapshot, canonical entity-index order.
	 * Pairs with `restoreSparse`. */
	public captureSparse(): Uint8Array {
		return this._store.snapshotSparse();
	}

	/** Repopulate the sparse stores + relation indices from `captureSparse`
	 * bytes. Sparse components must already be registered in the same order
	 * throws `SparseRestoreError` on a shape or identity mismatch. */
	public restoreSparse(bytes: Uint8Array): void {
		this._store.restoreSparse(bytes);
	}
}

/** The snapshot plugin, for `ECS.create({ plugins: [snapshots()] })`. */
export function snapshots(): Plugin<SnapshotsPlugin> {
	return {
		name: "snapshots",
		install(host: PluginHost): SnapshotsPlugin {
			const store = host.store;
			store.installSnapshots(new SnapshotService(store.snapshotHost(), store.entityAllocator));
			return { snapshots: new ECSSnapshotsFull(store) };
		}
	};
}
