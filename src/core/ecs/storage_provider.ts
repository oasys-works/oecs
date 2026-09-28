/***
 * The storage seam. A plugin gives the core a store it owns beside the core's own.
 *
 * The store then takes part in the destroy purge, `stateHash` and the world
 * snapshot. `PluginHost.registerStorage` hands it over.
 *
 * A leaf, so the store, the plugin host and the snapshot plugin import it
 * without a cycle.
 ***/

import type { EntityID } from "./entity";

/** Folds one 32-bit word into the world digest. */
export type StorageHashFold = (word: number) => void;

/** A store a plugin owns. Every member but `name` is optional.
 * Supply `capture` and `restore` together, or neither. */
export interface StorageProvider {
	/** Keys the snapshot section. Unique in one world. Keep it stable across
	 * releases, because a restore matches sections by this name. */
	readonly name: string;
	/** Drop the data of a destroyed entity. Runs on every destroy path,
	 * after the row leaves its archetype and before the slot is recycled.
	 * Do not create or destroy an entity here. Hot. */
	purge?(entityId: EntityID): void;
	/** Fold the contents into `stateHash`, in an order that does not depend
	 * on the history of adds and removes. */
	hash?(fold: StorageHashFold): void;
	/** Serialize the contents. Equal contents must give equal bytes. A
	 * restore refuses a world that holds a store with no `capture`. */
	capture?(): Uint8Array;
	/** Throw to refuse a section. Runs before the restore changes any state. */
	validate?(bytes: Uint8Array): void;
	/** Replace the contents with a section from `capture`. Runs after the
	 * core state is restored, so `isAlive` and field reads are current. */
	restore?(bytes: Uint8Array): void;
}
