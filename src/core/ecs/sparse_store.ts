/***
 * Sparse storage class, out-of-identity, id-indexed components (flecs
 * `DontFragment`, Bevy sparse-set storage).
 *
 * A sparse component's membership and data live in an engine-managed sparse
 * set keyed by entity index, outside the 128-bit archetype mask. Add,
 * remove, has, get and set touch no archetype graph: no transition, no row
 * copy, and no bitmask identity bit consumed, so sparse components do **not**
 * count against `STORE_DESCRIPTOR_COMPONENT_LIMIT`. This is the substrate of the
 * relations work. Membership must leave the identity (not only the data): our
 * `moveEntityFrom` copies the whole payload row on every transition, so
 * in-identity churn cost scales with payload width while out-of-identity churn
 * is flat.
 *
 * The data is **id-indexed**: each field is one typed array of the field's
 * declared type, and the value for an entity sits at the entity's index. A
 * read by id is therefore one load, with no archetype and no row to resolve
 * first, which is the fast path that the packed archetype layout cannot give.
 * A dense component keeps its values packed for the column loop. A sparse
 * component keeps its values addressable for the lookup. A component chooses
 * one side at registration.
 *
 * Membership is a sparse set beside the columns: `_dense` lists the member
 * indices, and `_pos` maps an index to its position in that list, or `-1`. A
 * remove is a swap-remove in `_dense`, and the data at the index stays where
 * it is until the next add overwrites it. Because the store is keyed by entity
 * index, not by archetype row, a dense neighbour's swap-remove never disturbs
 * sparse data. Only entity destruction does, via `Store`'s purge hook.
 *
 * The columns grow by doubling to fit the highest member index, so the memory
 * of one store is proportional to the highest entity index that ever held the
 * component, and not to the number of members. That is the cost of the
 * one-load read, and it is the same cost an id-indexed engine pays for every
 * component. The columns live on the heap. The snapshot below carries the
 * members and their values, so the sparse half of a world stays a separate
 * byte section from the dense arena.
 *
 * Refs and cursors read a sparse store through the same shared prototype as
 * the dense accessors (ref.ts): `accCols` holds the columns at the global ids
 * of their field names, and the store refills it in place when it grows, so a
 * cursor made before a grow keeps reading the live columns.
 *
 * Deterministic snapshot and state-hash coverage, hashing and serializing in
 * canonical entity-index order, is in place (`canonicalIndices`,
 * `snapshotSparseStores` and `restoreSparseStores` below).
 ***/

import { Brand, type AnyTypedArray, type TypedArrayTag } from "../../type_primitives";
import { FNV1A_OFFSET_BASIS, fnv1aStep } from "../store/state_hash";
import { TYPE_TAG, TYPED_ARRAY_TAG_TO_TYPE_TAG } from "../store/descriptor";
import type { ComponentSchema } from "./component";
import { MAX_INDEX } from "./entity";
import { fieldGids, NO_COLUMN, type AccessorColumns } from "./ref";
import { writeElem } from "./row_kinds";
// Declared two directories up, so the snapshot plugin's own rollup graph
// can bind to the same class this module throws instead of copying it.
import { SparseRestoreError } from "../restore_errors";

export { SparseRestoreError };

/** Sparse-component handle id. A separate id space from `ComponentID`. It
 * indexes `Store`'s `sparseStores`, never the archetype mask, which is the
 * mechanism by which sparse components escape the 128-bit identity cap. */
export type SparseComponentID = Brand<number, "sparse_component_id">;

// Phantom slot carrying the field schema S at compile time (erased at runtime,
// where a SparseComponentDef is only its SparseComponentID number). Distinct
// from ComponentDef's `__schema` so a sparse def cannot be passed to the dense
// `addComponent` and `getField` surface (and the reverse), the two storage
// classes are not interchangeable.
declare const __sparseSchema: unique symbol;

export type SparseComponentDef<S extends ComponentSchema = ComponentSchema> = SparseComponentID & {
	readonly [__sparseSchema]: S;
};

/** Recover a sparse def's schema type, the sparse sibling of `SchemaOf`
 * (component.ts), used by the typed `SystemContext` sparse surface. */
export type SparseSchemaOf<D> = D extends SparseComponentDef<infer S extends ComponentSchema>
	? S
	: never;

/** The typed-array class of each column type. */
const COLUMN_CLASS: Record<TypedArrayTag, new (n: number) => AnyTypedArray> = {
	f64: Float64Array,
	f32: Float32Array,
	i32: Int32Array,
	u32: Uint32Array,
	i16: Int16Array,
	u16: Uint16Array,
	i8: Int8Array,
	u8: Uint8Array
};

/** The index capacity a store starts with. Small, because most sparse
 * components hold few members. The columns double as the highest member
 * index grows. */
const INITIAL_CAPACITY = 64;

/** The largest index capacity a store can reach: every entity index fits. */
const CAPACITY_LIMIT = MAX_INDEX + 1;

const EMPTY_ROW: readonly number[] = Object.freeze([]);

/** One sparse component's membership + data. Pure data structure, the `Store`
 * owns liveness checks and dev-mode error throwing. This class only knows
 * entity indices and field values. */
export class SparseComponentStore {
	public readonly fieldNames: string[];
	public readonly fieldTypes: TypedArrayTag[];
	public readonly fieldIndex: Record<string, number>;
	/** The columns a ref or cursor reads through (ref.ts): the field columns at
	 * the global ids of their names, `NO_COLUMN` elsewhere. Refilled in place
	 * on every grow, so its identity is stable for the life of the store. */
	public readonly accCols: AccessorColumns;

	/** One column for each field, indexed by entity index. All of one length,
	 * `_cap`. Replaced together on a grow. */
	private _cols: AnyTypedArray[];
	/** The numeric type tag of each field, for the kind-split element writes. */
	private readonly _kinds: Uint8Array;
	/** True when every field is `f64`: the value writes then take one inline
	 * loop whose site sees `Float64Array` alone. */
	private readonly _allF64: boolean;
	/** The global name id of each field, in schema order. */
	private readonly _gids: Int32Array;
	/** The index capacity of `_cols` and `_pos`. */
	private _cap: number;
	/** Entity index → position in `_dense`, or `-1` when not a member. */
	private _pos: Int32Array;
	/** The member indices, valid in `[0, _size)`. */
	private _dense: Uint32Array;
	private _size = 0;
	/** The row ticks, one for each entity index, or `null` until `trackTicks`.
	 * The row grain of change detection for a sparse component: `setField` and
	 * a mutable cursor's `at` stamp the member's entry, and a join zeroes it,
	 * because an add is structural. Grows with the columns. A scheduling
	 * artifact: not in the snapshot or the hash. */
	public ticks: Uint32Array | null = null;
	/** The change tick of the last stamp on any member: the gate an entity-level
	 * onSet drain reads before it walks the members. */
	public changedTick = 0;
	/** The change tick below which every record was drained. See
	 * `Store.drainSparseSet`. */
	public drainTick = 0;
	/** The `run` of the last `Store.drainSparseSet`. A second drain at the same
	 * run returns the first one's array, so several consumers of the change
	 * feed share one drain instead of taking the members away from each
	 * other. */
	public lastDrainRun = 0;

	constructor(fieldNames: string[], fieldTypes: TypedArrayTag[]) {
		this.fieldNames = fieldNames;
		this.fieldTypes = fieldTypes;
		const fieldIndex: Record<string, number> = Object.create(null);
		for (let i = 0; i < fieldNames.length; i++) fieldIndex[fieldNames[i]] = i;
		this.fieldIndex = fieldIndex;
		const n = fieldNames.length;
		const kinds = new Uint8Array(n);
		let allF64 = true;
		for (let i = 0; i < n; i++) {
			kinds[i] = TYPED_ARRAY_TAG_TO_TYPE_TAG[fieldTypes[i]];
			if (kinds[i] !== TYPE_TAG.f64) allF64 = false;
		}
		this._kinds = kinds;
		this._allF64 = allF64;
		this._gids = fieldGids(fieldNames, fieldTypes);
		let maxGid = -1;
		for (let i = 0; i < n; i++) if (this._gids[i] > maxGid) maxGid = this._gids[i];
		this.accCols = new Array<AnyTypedArray>(maxGid + 1).fill(NO_COLUMN);
		this._cap = INITIAL_CAPACITY;
		this._cols = new Array<AnyTypedArray>(n);
		for (let i = 0; i < n; i++) {
			const col = new COLUMN_CLASS[fieldTypes[i]](INITIAL_CAPACITY);
			this._cols[i] = col;
			this.accCols[this._gids[i]] = col;
		}
		this._pos = new Int32Array(INITIAL_CAPACITY).fill(-1);
		this._dense = new Uint32Array(INITIAL_CAPACITY);
	}

	/** Number of entities holding this sparse component. */
	public get size(): number {
		return this._size;
	}

	/** Live entity indices that hold this component, as a view over the member
	 * list at the time of the call (iteration order is insertion and swap order.
	 * Not canonical). The view has a fixed length: a later add or remove is not
	 * visible through it, and a remove moves the last member into the hole. For
	 * a walk that must see its own mutations, loop `size` with `indexAt`, as the
	 * query driver does. For the determinism surface use `canonicalIndices`. */
	public get indices(): Uint32Array {
		return this._dense.subarray(0, this._size);
	}

	/** The member index at position `i` of the member list, `0 <= i < size`.
	 * Reads the live list, so a walk over `size` sees a swap-remove and an
	 * append made during the walk, exactly as a walk over a shrinking array
	 * did. */
	public indexAt(i: number): number {
		return this._dense[i];
	}

	/** Live entity indices in **canonical** (ascending) order, the determinism
	 * ordering for `stateHash` + snapshot/restore. The native
	 * `indices` order is insertion and swap order and would make two worlds with
	 * identical contents reached by different add and remove histories diverge, so
	 * the cold determinism paths sort here. Allocates a sorted copy each call
	 * never call it on the hot query path. Indices are 20-bit entity indices,
	 * so the subtraction comparator can't overflow. */
	public canonicalIndices(): number[] {
		const out = new Array<number>(this._size);
		for (let i = 0; i < this._size; i++) out[i] = this._dense[i];
		return out.sort((a, b) => a - b);
	}

	/** The field-value row for `index` (length = field count, `[]` for a tag),
	 * or `undefined` if `index` isn't a member. A copy, read out of the columns
	 * for the determinism paths (`stateHash`, snapshot); mutate via `setField`. */
	public getRow(index: number): readonly number[] | undefined {
		if (!(this._pos[index] >= 0)) return undefined;
		const n = this._cols.length;
		if (n === 0) return EMPTY_ROW;
		const row = new Array<number>(n);
		for (let f = 0; f < n; f++) row[f] = this._cols[f][index];
		return row;
	}

	/** Drop all membership + data. Restore path only, `restoreSparseStores`
	 * repopulates a cleared store from snapshot bytes. */
	public clear(): void {
		this._pos.fill(-1);
		this._size = 0;
	}

	/** Insert the positional field-value `row` for `index`. Restore path only
	 * bypasses the name→index mapping `setRow` does, because snapshot bytes are
	 * already positional. Each value converts to its field's type. */
	public setRawRow(index: number, row: readonly number[]): void {
		this._join(index);
		const cols = this._cols;
		const kinds = this._kinds;
		for (let f = 0; f < cols.length; f++) writeElem(kinds[f], cols[f], index, row[f]);
	}

	public has(index: number): boolean {
		// An index past the capacity reads `undefined`, and the compare is false.
		return this._pos[index] >= 0;
	}

	/** Insert or overwrite the row for `index`, building it from `values`.
	 * Fields absent from `values` default to 0. A tag stores nothing. Each
	 * value converts to its field's type, as a typed array converts it. */
	public setRow(index: number, values: Record<string, number | undefined>): void {
		this._join(index);
		const names = this.fieldNames;
		const cols = this._cols;
		if (this._allF64) {
			for (let f = 0; f < names.length; f++) {
				(cols[f] as Float64Array)[index] = values[names[f]] ?? 0;
			}
			return;
		}
		const kinds = this._kinds;
		for (let f = 0; f < names.length; f++) writeElem(kinds[f], cols[f], index, values[names[f]] ?? 0);
	}

	/** Drop `index`'s membership. Returns whether it was present. The data at
	 * the index stays until the next add overwrites it. */
	public remove(index: number): boolean {
		const p = this._pos[index];
		if (!(p >= 0)) return false;
		const last = --this._size;
		const moved = this._dense[last];
		this._dense[p] = moved;
		this._pos[moved] = p;
		this._pos[index] = -1;
		return true;
	}

	/** Read one field, or `undefined` if `index` doesn't hold this component. */
	public getField(index: number, fieldIdx: number): number | undefined {
		if (!(this._pos[index] >= 0)) return undefined;
		return this._cols[fieldIdx][index];
	}

	/** Write one field, and stamp the row tick with `tick` when the store keeps
	 * one. Returns `false` (no-op) if `index` isn't a member. */
	public setField(index: number, fieldIdx: number, value: number, tick: number): boolean {
		if (!(this._pos[index] >= 0)) return false;
		writeElem(this._kinds[fieldIdx], this._cols[fieldIdx], index, value);
		const t = this.ticks;
		if (t !== null) {
			t[index] = tick;
			this.changedTick = tick;
		}
		return true;
	}

	/** Keep a row tick for each entity index. Idempotent, never undone. */
	public trackTicks(): void {
		if (this.ticks === null) this.ticks = new Uint32Array(this._cap);
	}

	/** Forget every record. A restore replaces the members and their values,
	 * so a tick that survived it would name a write that never happened. */
	public resetTicks(): void {
		if (this.ticks !== null) this.ticks.fill(0);
		this.changedTick = 0;
	}

	/** Make `index` a member, growing the columns to fit it. No-op for a
	 * member. */
	private _join(index: number): void {
		if (index >= this._cap) this._growToFit(index);
		if (this._pos[index] >= 0) return;
		// A join is structural, and the slot may hold the tick of a member that
		// left. Zero it, so the new member is not reported for a write it never had.
		if (this.ticks !== null) this.ticks[index] = 0;
		if (this._size === this._dense.length) {
			const next = new Uint32Array(this._dense.length * 2);
			next.set(this._dense);
			this._dense = next;
		}
		this._pos[index] = this._size;
		this._dense[this._size++] = index;
	}

	/** Double the index capacity until `index` fits, and move every column and
	 * the position map across. The accessor column array is refilled in place,
	 * so a held cursor keeps reading the live columns. */
	private _growToFit(index: number): void {
		let cap = this._cap;
		while (cap <= index) cap *= 2;
		if (cap > CAPACITY_LIMIT) cap = CAPACITY_LIMIT;
		const cols = this._cols;
		for (let f = 0; f < cols.length; f++) {
			const next = new COLUMN_CLASS[this.fieldTypes[f]](cap);
			next.set(cols[f] as never);
			cols[f] = next;
			this.accCols[this._gids[f]] = next;
		}
		const pos = new Int32Array(cap).fill(-1);
		pos.set(this._pos);
		this._pos = pos;
		if (this.ticks !== null) {
			const ticks = new Uint32Array(cap);
			ticks.set(this.ticks);
			this.ticks = ticks;
		}
		this._cap = cap;
	}
}

/** Per-store snapshot header: `u32 fieldCount` + `u32 schemaHash` +
 * `u32 memberCount`. */
const SPARSE_STORE_HEADER_BYTES = 12;
/** Per-member fixed cost: `u32 entityIndex` (the f64 fields follow). */
const SPARSE_MEMBER_INDEX_BYTES = 4;
const F64_BYTES = 8;

/** FNV-1a 32-bit fingerprint of a store's field schema, every `name:type`
 * pair, in registration order, with separators so neither the name-to-type split
 * nor the field boundary is ambiguous. Folded into the snapshot header so
 * `restoreSparseStores` can reject a buffer whose store *shapes* match
 * field-for-field but whose field **identity** doesn't, the case that lets an
 * exclusive relation's `{target:f64}` backing (byte-identical to any user
 * single-`f64` component) load into the wrong slot when relations and user
 * sparse components are registered in a different interleaving between the
 * snapshot and restore worlds. Field count is already in the header, so
 * the fingerprint exists to catch a same-shape store with a different identity. */
function schemaFingerprint(
	fieldNames: readonly string[],
	fieldTypes: readonly TypedArrayTag[]
): number {
	// Folds bytes (each `charCodeAt & 0xff`, handled by `fnv1aStep`) through the
	// shared FNV-1a byte step, same constants and round as `fnv1a32` and
	// the server determinism folds, so there is one definition, not four copies.
	let h = FNV1A_OFFSET_BASIS;
	const fold = (s: string): void => {
		for (let i = 0; i < s.length; i++) h = fnv1aStep(h, s.charCodeAt(i));
	};
	for (let i = 0; i < fieldNames.length; i++) {
		fold(fieldNames[i]);
		h = fnv1aStep(h, 0x1f); // name-type separator (unit separator)
		fold(fieldTypes[i]);
		h = fnv1aStep(h, 0x1e); // field boundary (record separator)
	}
	return h >>> 0; // canonical u32
}

/** Serialize a registry of sparse stores into a self-contained byte buffer,
 * the **sparse half** of a world snapshot (the dense half is the SAB snapshot,
 * `columnStoreBytesView`). Members are emitted in canonical (ascending
 * entity-index) order so the bytes are independent of insertion and removal
 * history: two worlds with identical sparse contents reached by different
 * mutation orders serialize byte-for-byte the same.
 *
 * Layout (all integers little-endian, to match the dense SAB snapshot and stay
 * architecture-independent):
 *
 *   u32 storeCount
 *   repeat storeCount times:
 *     u32 fieldCount
 *     u32 schemaHash
 *     u32 memberCount
 *     repeat memberCount times (canonical entity-index order):
 *       u32 entityIndex
 *       f64 × fieldCount   (the positional field row, none for a tag)
 *
 * `fieldCount` is redundant with the registered schema but is written so
 * `restoreSparseStores` can reject a snapshot whose shape doesn't match the
 * stores it's restoring into. `schemaHash` (a `schemaFingerprint` over the
 * field names + types) goes further and rejects a buffer whose shape matches
 * field-for-field but whose field **identity** doesn't. */
export function snapshotSparseStores(stores: readonly SparseComponentStore[]): Uint8Array {
	let total = 4; // storeCount
	for (let s = 0; s < stores.length; s++) {
		const store = stores[s];
		const fieldCount = store.fieldNames.length;
		total +=
			SPARSE_STORE_HEADER_BYTES +
			store.size * (SPARSE_MEMBER_INDEX_BYTES + fieldCount * F64_BYTES);
	}

	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	let off = 0;
	view.setUint32(off, stores.length, true);
	off += 4;

	for (let s = 0; s < stores.length; s++) {
		const store = stores[s];
		const fieldCount = store.fieldNames.length;
		const idxs = store.canonicalIndices();
		view.setUint32(off, fieldCount, true);
		off += 4;
		view.setUint32(off, schemaFingerprint(store.fieldNames, store.fieldTypes), true);
		off += 4;
		view.setUint32(off, idxs.length, true);
		off += 4;
		for (let i = 0; i < idxs.length; i++) {
			const index = idxs[i];
			view.setUint32(off, index, true);
			off += 4;
			const row = store.getRow(index)!;
			for (let f = 0; f < fieldCount; f++) {
				view.setFloat64(off, row[f], true);
				off += F64_BYTES;
			}
		}
	}

	return bytes;
}

/** Repopulate already-registered sparse stores from `snapshotSparseStores`
 * bytes, giving full-equality round-trip (membership + data). The `stores`
 * registry must already exist with the same shape the snapshot was taken from.
 * Restore replays data into a world whose sparse components are registered
 * in the same order (the registration is code, not snapshot state). Each store
 * is cleared first, so restoring is idempotent and drops any pre-existing rows.
 *
 * Throws `SparseRestoreError` on any shape or identity mismatch (store count,
 * field count, schema-hash field identity, an entity index past `MAX_INDEX`,
 * or a truncated or over-long buffer) rather than silently corrupting state.
 * The index bound matters because the columns of a store grow to fit the
 * highest member index, an unvalidated crafted u32 (up to ~4.29e9) would ask
 * for a multi-GB column for each field. */
export function restoreSparseStores(
	stores: readonly SparseComponentStore[],
	bytes: Uint8Array
): void {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = bytes.byteLength;
	let off = 0;

	const need = (n: number): void => {
		if (off + n > end) {
			throw new SparseRestoreError(
				`sparse snapshot truncated: need ${n} more bytes at offset ${off}, have ${end - off}`
			);
		}
	};

	need(4);
	const storeCount = view.getUint32(off, true);
	off += 4;
	if (storeCount !== stores.length) {
		throw new SparseRestoreError(
			`sparse store count mismatch: snapshot=${storeCount}, registered=${stores.length}`
		);
	}

	for (let s = 0; s < stores.length; s++) {
		const store = stores[s];
		need(SPARSE_STORE_HEADER_BYTES);
		const fieldCount = view.getUint32(off, true);
		off += 4;
		const schemaHash = view.getUint32(off, true);
		off += 4;
		const memberCount = view.getUint32(off, true);
		off += 4;
		if (fieldCount !== store.fieldNames.length) {
			throw new SparseRestoreError(
				`sparse store ${s} field-count mismatch: snapshot=${fieldCount}, registered=${store.fieldNames.length}`
			);
		}
		const expectedHash = schemaFingerprint(store.fieldNames, store.fieldTypes);
		if (schemaHash !== expectedHash) {
			throw new SparseRestoreError(
				`sparse store ${s} schema identity mismatch: snapshot hash=${schemaHash}, registered=${expectedHash} (same field count, different field names/types, likely a registration-order divergence between the snapshot and restore worlds)`
			);
		}
		store.clear();
		for (let m = 0; m < memberCount; m++) {
			need(SPARSE_MEMBER_INDEX_BYTES + fieldCount * F64_BYTES);
			const index = view.getUint32(off, true);
			off += 4;
			if (index > MAX_INDEX) {
				throw new SparseRestoreError(
					`sparse store ${s} member ${m} entity index ${index} exceeds MAX_INDEX (${MAX_INDEX})`
				);
			}
			const row = new Array<number>(fieldCount);
			for (let f = 0; f < fieldCount; f++) {
				row[f] = view.getFloat64(off, true);
				off += F64_BYTES;
			}
			store.setRawRow(index, row);
		}
	}

	if (off !== end) {
		throw new SparseRestoreError(
			`sparse snapshot has ${end - off} trailing bytes after the last store (not a canonical encoding)`
		);
	}
}

/** Read-only validation of a `snapshotSparseStores` buffer against the live
 * registry, without mutating any store. Mirrors `restoreSparseStores`'s
 * shape, field-identity, index-bounds and frame checks so `Store.restore` can fail
 * closed on a sparse-registration mismatch before the dense mount overwrites live
 * column data. Throws `SparseRestoreError` on any mismatch or malformed buffer. */
export function assertSparseStores(
	stores: readonly SparseComponentStore[],
	bytes: Uint8Array
): void {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = bytes.byteLength;
	let off = 0;

	const need = (n: number): void => {
		if (off + n > end) {
			throw new SparseRestoreError(
				`sparse snapshot truncated: need ${n} more bytes at offset ${off}, have ${end - off}`
			);
		}
	};

	need(4);
	const storeCount = view.getUint32(off, true);
	off += 4;
	if (storeCount !== stores.length) {
		throw new SparseRestoreError(
			`sparse store count mismatch: snapshot=${storeCount}, registered=${stores.length}`
		);
	}

	for (let s = 0; s < stores.length; s++) {
		const store = stores[s];
		need(SPARSE_STORE_HEADER_BYTES);
		const fieldCount = view.getUint32(off, true);
		off += 4;
		const schemaHash = view.getUint32(off, true);
		off += 4;
		const memberCount = view.getUint32(off, true);
		off += 4;
		if (fieldCount !== store.fieldNames.length) {
			throw new SparseRestoreError(
				`sparse store ${s} field-count mismatch: snapshot=${fieldCount}, registered=${store.fieldNames.length}`
			);
		}
		const expectedHash = schemaFingerprint(store.fieldNames, store.fieldTypes);
		if (schemaHash !== expectedHash) {
			throw new SparseRestoreError(
				`sparse store ${s} schema identity mismatch: snapshot hash=${schemaHash}, registered=${expectedHash} (same field count, different field names/types, likely a registration-order divergence between the snapshot and restore worlds)`
			);
		}
		for (let m = 0; m < memberCount; m++) {
			need(SPARSE_MEMBER_INDEX_BYTES + fieldCount * F64_BYTES);
			const index = view.getUint32(off, true);
			off += 4;
			if (index > MAX_INDEX) {
				throw new SparseRestoreError(
					`sparse store ${s} member ${m} entity index ${index} exceeds MAX_INDEX (${MAX_INDEX})`
				);
			}
			off += fieldCount * F64_BYTES;
		}
	}

	if (off !== end) {
		throw new SparseRestoreError(
			`sparse snapshot has ${end - off} trailing bytes after the last store (not a canonical encoding)`
		);
	}
}
