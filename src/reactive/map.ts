/**
 * Keyed reactive map — per-entity channels.
 *
 * A collection where a reader of key K subscribes to K *alone*. Changing entity 7
 * wakes only the things reading entity 7 — not the effects reading the other 199
 * entities. That isolation is the difference between a per-frame ECS→UI sync that
 * costs O(changed) and one that costs O(all), and it is the collection shape the
 * engine UI bridge needs (and that a plain signal-of-array cannot give).
 *
 * Mechanism: one fine-grained signal per key for its value, plus a single
 * "structure" signal bumped only when the key *set* changes (add / delete).
 *   - get(present key)  -> tracks that key's value signal only
 *   - get(absent key)   -> tracks structure, so a later set(key) wakes the reader
 *   - has / size / keys -> track structure (key-set membership), NOT any value
 *   - set(existing)     -> writes one value signal; structure readers are untouched
 *   - set(new) / delete -> bumps structure; value readers of other keys untouched
 *
 * Built on the kernel's signals, so the no-op skip (equal set) and batching carry
 * through for free. The per-key no-op skip uses `eq` (default `Object.is`); pass a
 * structural `eq` when the values are objects — a per-tick projection object is a
 * fresh reference every frame, so `Object.is` never skips it and the row wakes even
 * when its content is unchanged. A content `eq` restores the "equal write wakes
 * nobody" guarantee for object-valued channels (the common ECS→UI snapshot shape).
 */
import { batch, signal } from "./kernel";
import { DEV } from "../dev_flag";

export interface ReactiveMap<K, V> {
	/** Read a key's value, subscribing the caller to that key (or to structure if absent). */
	get(key: K): V | undefined;
	/** Insert or update a key. Updating an existing key wakes only that key's readers. */
	set(key: K, value: V): void;
	/** Remove a key. Wakes that key's readers (now absent) and structure readers. */
	delete(key: K): boolean;
	/** Membership test, tracking the key set. */
	has(key: K): boolean;
	/** Entry count, tracking the key set. */
	size(): number;
	/** Snapshot of keys, tracking the key set. */
	keys(): K[];
}

export function reactiveMap<K, V>(eq: (a: V, b: V) => boolean = Object.is): ReactiveMap<K, V> {
	const cells = new Map<K, readonly [() => V | undefined, (v: V | undefined) => void]>();
	const [structure, bumpStructure] = signal(0);
	let revision = 0;
	// A cell holds `V | undefined` (delete writes undefined to wake the key's readers
	// as absent). `eq` compares present values; an absent side is equal only to another
	// absent side — so a delete (defined → undefined) is never skipped. Reduces to plain
	// `Object.is` when `eq` is the default.
	const cellEq = (a: V | undefined, b: V | undefined): boolean =>
		a !== undefined && b !== undefined ? eq(a, b) : a === b;

	return {
		get(key) {
			const cell = cells.get(key);
			if (cell !== undefined) return cell[0]();
			structure(); // absent: subscribe to structure so a future insert wakes us
			return undefined;
		},
		set(key, value) {
			if (DEV && value === undefined) {
				// `undefined` is the absent sentinel (see `cellEq`), so a stored
				// `undefined` reads back identically to a never-set key on `get`. #731.
				console.warn(
					"reactiveMap.set(key, undefined): undefined is the absent sentinel — " +
						"get(key) cannot distinguish it from an unset key; use delete(key) to remove."
				);
			}
			const cell = cells.get(key);
			if (cell !== undefined) {
				cell[1](value); // fine-grained: only this key's readers, with no-op skip
			} else {
				cells.set(key, signal<V | undefined>(value, cellEq));
				bumpStructure(++revision);
			}
		},
		delete(key) {
			const cell = cells.get(key);
			if (cell === undefined) return false;
			// Remove from the map FIRST, then coalesce the value-clear + structure
			// bump in one batch. An un-batched value-write flushes synchronously, so
			// the woken reader re-reads get(key) mid-delete; if the cell were still
			// present it would re-subscribe to the (now-orphaned) value signal instead
			// of structure, and a later re-insert of the same key would never wake it.
			// Deleting first + batching makes the reader re-run once, see absence, and
			// track structure — so delete→re-add wakes it.
			cells.delete(key);
			batch(() => {
				cell[1](undefined); // wake this key's readers; they re-read as absent
				bumpStructure(++revision);
			});
			return true;
		},
		has(key) {
			structure();
			return cells.has(key);
		},
		size() {
			structure();
			return cells.size;
		},
		keys() {
			structure();
			return [...cells.keys()];
		}
	};
}
