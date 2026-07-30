/***
 * Sparse storage class — out-of-identity components (flecs `DontFragment`).
 *
 * A sparse component's membership AND data live in an engine-managed sparse
 * set keyed by **entity index**, OUTSIDE the 128-bit archetype mask. Add /
 * remove / has / get / set touch no archetype graph: no transition, no row
 * copy, and no bitmask identity bit consumed — so sparse components do **not**
 * count against `STORE_DESCRIPTOR_COMPONENT_LIMIT`. This is the substrate of the
 * relations work; membership must leave the
 * identity (not just the data): our `moveEntityFrom` copies the whole
 * payload row on every transition, so in-identity churn cost scales with
 * payload width while out-of-identity churn is flat.
 *
 * Each registered sparse component owns one `SparseComponentStore`, wrapping a
 * `SparseMap<number[]>` (std primitive): entity index → field-value row. A tag
 * (empty schema) stores an empty row; membership is key presence. Because the
 * store is keyed by entity index — not by archetype row — a dense neighbour's
 * swap-remove never disturbs sparse data; only entity destruction does, via
 * `Store`'s purge hook.
 *
 * Field data is stored as plain JS numbers (f64) this slice. The typed-array
 * SAB column mirror the WASM sim reads is a later slice. Deterministic
 * snapshot / state-hash coverage — hashing and serializing in canonical
 * entity-index order — is in place (`canonicalIndices`,
 * `snapshotSparseStores` / `restoreSparseStores` below). `fieldTypes` is
 * retained now so a later column mirror has the schema it needs.
 ***/

import { Brand, SparseMap, type TypedArrayTag } from "../../type_primitives";
import { FNV1A_OFFSET_BASIS, fnv1aStep } from "../store/state_hash";
import type { ComponentSchema } from "./component";
import { MAX_INDEX } from "./entity";

/** Sparse-component handle id. A separate id space from `ComponentID` — it
 * indexes `Store`'s `sparseStores`, never the archetype mask, which is the
 * mechanism by which sparse components escape the 128-bit identity cap. */
export type SparseComponentID = Brand<number, "sparse_component_id">;

// Phantom slot carrying the field schema S at compile time (erased at runtime,
// where a SparseComponentDef is just its SparseComponentID number). Distinct
// from ComponentDef's `__schema` so a sparse def cannot be passed to the dense
// `addComponent` / `getField` surface (and vice-versa) — the two storage
// classes are not interchangeable.
declare const __sparseSchema: unique symbol;

export type SparseComponentDef<S extends ComponentSchema = ComponentSchema> = SparseComponentID & {
	readonly [__sparseSchema]: S;
};

/** Recover a sparse def's schema type — the sparse sibling of `SchemaOf`
 * (component.ts), used by the typed `SystemContext` sparse surface. */
export type SparseSchemaOf<D> = D extends SparseComponentDef<infer S extends ComponentSchema>
	? S
	: never;

/** One sparse component's membership + data. Pure data structure — the `Store`
 * owns liveness checks and dev-mode error throwing; this class only knows
 * entity indices and field rows. */
export class SparseComponentStore {
	/** entity index → field-value row (length = field count; `[]` for a tag). */
	private readonly _data = new SparseMap<number[]>();
	public readonly fieldNames: string[];
	public readonly fieldTypes: TypedArrayTag[];
	public readonly fieldIndex: Record<string, number>;

	constructor(fieldNames: string[], fieldTypes: TypedArrayTag[]) {
		this.fieldNames = fieldNames;
		this.fieldTypes = fieldTypes;
		const fieldIndex: Record<string, number> = Object.create(null);
		for (let i = 0; i < fieldNames.length; i++) fieldIndex[fieldNames[i]] = i;
		this.fieldIndex = fieldIndex;
	}

	/** Number of entities holding this sparse component. */
	public get size(): number {
		return this._data.size;
	}

	/** Live entity indices that hold this component (dense, iteration order is
	 * SparseMap insertion/swap order — NOT canonical). Used by the hot query
	 * integration path; for the determinism surface use
	 * `canonicalIndices` instead. */
	public get indices(): readonly number[] {
		return this._data.keys;
	}

	/** Live entity indices in **canonical** (ascending) order — the determinism
	 * ordering for `stateHash` + snapshot/restore. The native
	 * `indices` getter is insertion/swap order and would make two worlds with
	 * identical contents reached by different add/remove histories diverge, so
	 * the cold determinism paths sort here. Allocates a sorted copy each call;
	 * never call it on the hot query path. Indices are 20-bit entity indices,
	 * so the subtraction comparator can't overflow. */
	public canonicalIndices(): number[] {
		return this._data.keys.slice().sort((a, b) => a - b);
	}

	/** The field-value row for `index` (length = field count; `[]` for a tag),
	 * or `undefined` if `index` isn't a member. Read-only view for the
	 * determinism paths (`stateHash`, snapshot); mutate via `setField`. */
	public getRow(index: number): readonly number[] | undefined {
		return this._data.get(index);
	}

	/** Drop all membership + data. Restore path only — `restoreSparseStores`
	 * repopulates a cleared store from snapshot bytes. */
	public clear(): void {
		this._data.clear();
	}

	/** Insert the positional field-value `row` for `index`, taking ownership of
	 * the array. Restore path only; bypasses the name→index mapping `setRow`
	 * does, because snapshot bytes are already positional. */
	public setRawRow(index: number, row: number[]): void {
		this._data.set(index, row);
	}

	public has(index: number): boolean {
		return this._data.has(index);
	}

	/** Insert or overwrite the row for `index`, building it from `values`.
	 * Fields absent from `values` default to 0; a tag stores `[]`. */
	public setRow(index: number, values: Record<string, number>): void {
		const names = this.fieldNames;
		const row = new Array<number>(names.length);
		for (let i = 0; i < names.length; i++) {
			const v = values[names[i]];
			row[i] = v === undefined ? 0 : v;
		}
		this._data.set(index, row);
	}

	/** Drop `index`'s membership + data. Returns whether it was present. */
	public remove(index: number): boolean {
		return this._data.delete(index);
	}

	/** Read one field, or `undefined` if `index` doesn't hold this component. */
	public getField(index: number, fieldIdx: number): number | undefined {
		const row = this._data.get(index);
		return row === undefined ? undefined : row[fieldIdx];
	}

	/** Write one field. Returns `false` (no-op) if `index` isn't a member. */
	public setField(index: number, fieldIdx: number, value: number): boolean {
		const row = this._data.get(index);
		if (row === undefined) return false;
		row[fieldIdx] = value;
		return true;
	}
}

export class SparseRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SparseRestoreError";
	}
}

/** Per-store snapshot header: `u32 fieldCount` + `u32 schemaHash` +
 * `u32 memberCount`. */
const SPARSE_STORE_HEADER_BYTES = 12;
/** Per-member fixed cost: `u32 entityIndex` (the f64 fields follow). */
const SPARSE_MEMBER_INDEX_BYTES = 4;
const F64_BYTES = 8;

/** FNV-1a 32-bit fingerprint of a store's field schema — every `name:type`
 * pair, in registration order, with separators so neither the name/type split
 * nor the field boundary is ambiguous. Folded into the snapshot header so
 * `restoreSparseStores` can reject a buffer whose store *shapes* match
 * field-for-field but whose field **identity** doesn't — the case that lets an
 * exclusive relation's `{target:f64}` backing (byte-identical to any user
 * single-`f64` component) load into the wrong slot when relations and user
 * sparse components are registered in a different interleaving between the
 * snapshot and restore worlds. Field count is already in the header, so
 * the fingerprint exists purely to catch same-shape / different-identity. */
function schemaFingerprint(
	fieldNames: readonly string[],
	fieldTypes: readonly TypedArrayTag[]
): number {
	// Folds bytes (each `charCodeAt & 0xff`, handled by `fnv1aStep`) through the
	// shared FNV-1a byte step — same constants and round as `fnv1a32` and
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

/** Serialize a registry of sparse stores into a self-contained byte buffer —
 * the **sparse half** of a world snapshot (the dense half is the SAB snapshot,
 * `snapshotColumnStore`). Members are emitted in canonical (ascending
 * entity-index) order so the bytes are independent of insertion / removal
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
 *       f64 × fieldCount   (the positional field row; none for a tag)
 *
 * `fieldCount` is redundant with the registered schema but is written so
 * `restoreSparseStores` can reject a snapshot whose shape doesn't match the
 * stores it's restoring into; `schemaHash` (a `schemaFingerprint` over the
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
 * registry must already exist with the same shape the snapshot was taken from
 * — restore replays data into a world whose sparse components are registered
 * in the same order (the registration is code, not snapshot state). Each store
 * is cleared first, so restoring is idempotent and drops any pre-existing rows.
 *
 * Throws `SparseRestoreError` on any shape or identity mismatch (store count,
 * field count, schema-hash field identity, an entity index past `MAX_INDEX`,
 * or a truncated / over-long buffer) rather than silently corrupting state.
 * The index bound matters because the index keys a `SparseMap` whose backing
 * array grows to `index` length — an unvalidated crafted u32 (up to ~4.29e9)
 * would allocate multi-GB. */
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
				`sparse store ${s} schema identity mismatch: snapshot hash=${schemaHash}, registered=${expectedHash} (same field count, different field names/types — likely a registration-order divergence between the snapshot and restore worlds)`
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
 * registry, WITHOUT mutating any store. Mirrors `restoreSparseStores`'s
 * shape/field-identity/index-bounds/frame checks so `Store.restoreInto` can fail
 * closed on a sparse-registration mismatch BEFORE the dense mount overwrites live
 * column data. Throws `SparseRestoreError` on any mismatch / malformed buffer. */
export function validateSparseStores(
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
				`sparse store ${s} schema identity mismatch: snapshot hash=${schemaHash}, registered=${expectedHash} (same field count, different field names/types — likely a registration-order divergence between the snapshot and restore worlds)`
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
