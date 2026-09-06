/***
 * Archetype. Dense entity grouping by component signature.
 *
 * An archetype represents a unique combination of components (its "mask").
 * All entities sharing the exact same set of components live in the same
 * archetype. Data is stored in Structure-of-Arrays (SoA) layout: each
 * component field gets its own typed array column, and entity i's data is
 * at index i across all columns.
 *
 * Membership is managed via swap-and-pop: removing entity at row i swaps
 * it with the last row, keeping data packed with no holes. The Store is
 * responsible for updating the swapped entity's row index.
 *
 * Tag-only archetypes (hasColumns === false) skip all column operations
 * since tags carry no data, only the entityIds array is maintained.
 *
 * Graph edges (ArchetypeEdge) cache "add component X" and "remove component X"
 * transitions so the Store can resolve the target archetype in O(1).
 *
 ***/

import {
	Brand,
	validateAndCast,
	isNonNegativeInteger,
	GrowableUint32Array,
	type AnyTypedArray,
	type ColumnBacking,
	type TypedArrayTag
} from "../../type_primitives";
import { BufferBackedColumn } from "../store/buffer_backed_column";
import { columnKey, type ColumnStore } from "../store/column_store";
import { TYPE_TAG, TYPED_ARRAY_TAG_TO_TYPE_TAG } from "../store/descriptor";
import { toWidthBits, writeElem, widthView } from "./row_kinds";
import type {
	ComponentID,
	ComponentDef,
	ComponentSchema,
	SchemaOf,
	DeclaredQueryTerm,
	TagToTypedArray,
	ColumnsForSchema,
	MutableColumnsForSchema,
	ReadonlyColumn,
	ReadonlyUint32Array
} from "./component";
import { getEntityIndex, type EntityID, type ReadonlyEntityIDArray } from "./entity";
import { ECS_ERROR, ECSError } from "./utils/error";
import { NO_SWAP as NO_SWAP_IMPORT, UNASSIGNED as UNASSIGNED_IMPORT, DEFAULT_COLUMN_CAPACITY } from "./utils/constants";

// Local copies of the constants the row operations compare against. An
// imported binding is not a constant to the optimizer, see `ref.ts`. A local
// one is.
const NO_SWAP = NO_SWAP_IMPORT;
const UNASSIGNED = UNASSIGNED_IMPORT;
import type { BitSet } from "../../type_primitives";
import { NO_COLUMN, type AccessorColumns } from "./ref";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

export type ArchetypeID = Brand<number, "archetype_id">;

/** Stand-in column capacity for an archetype that has no columns (`_colCap`),
 * so the column term can never win the `min` that yields `_rowCap` and never
 * makes `_growRows` think a column grow is owed. The largest V8 small integer,
 * chosen over `Infinity` and `MAX_SAFE_INTEGER` to keep `_colCap` a smi-typed
 * field. Unreachable as a real capacity, the entity-ID index space caps total
 * rows at `1 << 20`. */
const NO_COLUMN_CAP = 0x7fffffff;
// The type tags of an archetype with no columns.
const EMPTY_U8 = new Uint8Array(0);
// The `f64` tag as a local constant, for the per-field fast path.
const TAG_F64 = TYPE_TAG.f64;

/** `ids[i] = i`, the name ids of a layout that supplied none (tests). */
function identityGids(n: number): Int32Array {
	const ids = new Int32Array(n);
	for (let i = 0; i < n; i++) ids[i] = i;
	return ids;
}

export const asArchetypeId = (value: number) =>
	validateAndCast<number, ArchetypeID>(
		value,
		isNonNegativeInteger,
		"ArchetypeID must be a non-negative integer"
	);

export interface ArchetypeEdge {
	add: ArchetypeID | null;
	remove: ArchetypeID | null;
	/** Pre-computed column mapping for add direction: this → add target. */
	addMap: Int16Array | null;
	/** Pre-computed column mapping for remove direction: this → remove target. */
	removeMap: Int16Array | null;
}

/**
 * Cached resolution of a *multi*-component add out of this archetype: the
 * target archetype the union lands in, plus the pre-built src→target batch
 * transition map. Keyed (on the source archetype) by an exact N-tagged pack of
 * the added component ids, see `Store.addComponents`.
 *
 * Where `ArchetypeEdge` is the per-*component* edge the single-add path indexes
 * by `_edges[component_id]`, this is the per-*set* edge the plural-add path looks
 * up by packed key, folding the mask hash, `archLookup`, and batch-map fetch
 * the final-mask resolve repeats every call into one `Map.get`. Never
 * invalidated: the archetype graph is monotonic (archetypes outlive the Store).
 */
export interface CompositeAddEdge {
	target: ArchetypeID;
	map: Int16Array;
}

export interface ArchetypeColumnLayout {
	componentId: ComponentID;
	fieldNames: string[];
	fieldIndex: Record<string, number>;
	fieldTypes: TypedArrayTag[];
	/** The global name id of each field (`fieldGids` in ref.ts). Optional so a
	 * test can build a heap archetype from a bare layout. The archetype then
	 * uses the ordinals as ids, which is correct for an archetype that no ref or
	 * cursor reaches through the shared prototype. */
	fieldGid?: Int32Array;
}

/**
 * Per-column allocator. Returns a `ColumnBacking` for the field at
 * `fieldIdx` of component `component_id`. The default factory (when none
 * is supplied to the constructor) allocates a `GrowableTypedArray` on the
 * heap. `fromColumnStore` supplies a factory that wraps SAB views instead.
 */
export type ColumnFactory = (
	componentId: ComponentID,
	fieldIdx: number,
	tag: TypedArrayTag
) => ColumnBacking<AnyTypedArray>;

/**
 * Hook the host installs on every SAB-backed archetype so the Archetype
 * can request a SAB grow + refresh from the host before the insertion
 * that would otherwise throw `StoreColumnOverflowError`. The host (Store)
 * is responsible for running `growColumnStore` and `refreshViews`
 * across every SAB-backed archetype. After the handler returns,
 * `arch.flatColumns[i].buf.length` is guaranteed to be `>= arch.length +
 * additional`. Heap-backed archetypes leave this unset, their
 * `GrowableTypedArray` grows in place.
 */
export type ArchetypeGrowHandler = (arch: Archetype, additional: number) => void;

/**
 * Public, read-only window onto an archetype's rows. This is the only
 * surface `Query.archetypes`, `Query.forEach`, and `ChangedQuery.forEach`
 * hand to callers, the concrete `Archetype` (with its structural mutators
 * `swapRemoveRow`, `moveEntityFrom`, `writeFields`, `setEdge`, and the
 * mutable `getColumnMut`) stays internal so query iteration can't bypass the
 * deferred-flush path that prevents iterator invalidation. This is the same
 * back door that is closed for `Store` and closed again for `Query`.
 *
 * `id` is the archetype's opaque identity (not a mutator), exposed so the
 * public `ECS.batchAddComponent` and `batchRemoveComponent` API can target an
 * archetype without the caller holding a concrete `Archetype` reference.
 */
export interface ArchetypeView<
	out Defs extends readonly ComponentDef<any>[] = readonly ComponentDef<any>[]
> {
	/** Opaque archetype identity. Pass to `ECS.batch_*_component`. */
	readonly id: ArchetypeID;
	/** Number of **enabled** entities, the default-iteration bound. Rows
	 * `0..entityCount-1` are enabled. Disabled rows (if any) sit contiguously at
	 * `entityCount..totalCount-1`. `forEach` SoA loops read this, so they skip
	 * disabled rows for free. Use `totalCount` to span disabled rows too. */
	readonly entityCount: number;
	/** Total live rows, enabled + disabled. Equal to `entityCount` unless
	 * some rows are disabled. Use for full-state work (serialization, snapshot,
	 * determinism) that must see every entity regardless of enabled state. */
	readonly totalCount: number;
	/** Number of disabled rows = `totalCount - entityCount`. */
	readonly disabledCount: number;
	/** Raw entity ID buffer (packed `EntityID`s). Valid data at indices
	 * 0..totalCount-1 (enabled rows first, then disabled). */
	readonly entityIds: ReadonlyEntityIDArray;
	/** True if this archetype's mask includes the given component. */
	hasComponent(id: ComponentID): boolean;
	/** Get a single field's column (read-only). Valid data: indices
	 * 0..entityCount-1. `def` must be a term of the iterating query
	 *. The bare-`ArchetypeView` default stays permissive. */
	getColumnRead<D extends ComponentDef<any>, K extends string & keyof SchemaOf<D>>(
		def: D & DeclaredQueryTerm<Defs, D>,
		field: K
	): ReadonlyColumn;
	/** Tuple fetch of several of one component's columns,
	 * `const [q, r] = arch.getColumnsRead(HexPos, "q", "r")`. One small
	 * array allocation per call. See the class doc on `Archetype`. */
	getColumnsRead<
		D extends ComponentDef<any>,
		const K extends readonly (string & keyof SchemaOf<D>)[]
	>(
		def: D & DeclaredQueryTerm<Defs, D>,
		...fields: K
	): { [I in keyof K]: ReadonlyColumn };
	/** Get a single field's column **if this archetype has the component**,
	 * else `undefined`, the optional-query fetch-if-present accessor.
	 * The absent branch is expected (resolve the column pointer per archetype
	 * span: present ⇒ column, absent ⇒ `undefined`), not an error. Same
	 * advisory-readonly view and `reads`-access-check as `getColumnRead`. */
	getOptionalColumnRead<S extends ComponentSchema, K extends string & keyof S>(
		def: ComponentDef<S>,
		field: K
	): ReadonlyColumn | undefined;
}

export class Archetype implements ArchetypeView {
	public readonly id: ArchetypeID;
	public readonly mask: BitSet;
	public readonly hasColumns: boolean;
	/**
	 * Whether a member entity occupies a real row here. True for every archetype
	 * except the **empty archetype** (the one with no components), where a
	 * component-less entity is "alive but unplaced". It points here via
	 * `_entityArchetypes` but carries `_entityRows === UNASSIGNED` and holds no
	 * row, exactly like a freshly `createEntity`'d one. Keeping the empty
	 * archetype rowless gives a component-less entity a single canonical form
	 * regardless of how it got there (created bare vs. lost its last component),
	 * so `stateHash` and zero-require query iteration don't depend on add and remove
	 * history. The row-materialising methods below honour this flag.
	 */
	public readonly materializesRows: boolean;

	private readonly _entityIds: GrowableUint32Array;
	public length: number = 0;
	/**
	 * Enabled and disabled row partition (entity enable and disable). Rows
	 * `[0, enabled_count)` are enabled, `[enabled_count, length)` are disabled.
	 * `enabled_count === length` (no disabled rows) is the common case, every
	 * fast path below short-circuits on it, so an archetype that never disables
	 * an entity pays nothing. Disable and enable swap a row across the boundary
	 * (`disableRow` and `enableRow`). An append places an enabled row in front of
	 * the disabled tail (`_placeTail`). `entityCount` (the query and iteration bound)
	 * returns this. `length` and `totalCount` span disabled rows too. Folded into
	 * `stateHash` and published to the SAB descriptor so the WASM sim and
	 * snapshot and restore honour it.
	 */
	public enabledCount: number = 0;
	/**
	 * Flush-epoch stamp + captured pre-counts for the Store's per-entity flush
	 * 0-crossing detector: `_flushAdds` and `_flushRemoves` stamp each
	 * archetype on first sight per flush (a few field accesses) instead of probing
	 * a `Map<archetype_id, pre_count>` per entity, the same per-entity Map
	 * cost the destroy drain also avoids. Both `flushPreLen` and
	 * `flushPreEnabled` are recorded so the settle pass can detect a 0-crossing
	 * on either the total (`length`) or the enabled partition (`enabledCount`),
	 * an enabled append into an all-disabled archetype crosses only the latter.
	 * Owned by Store. Pure scheduling bookkeeping, never folded into
	 * `stateHash`/snapshot.
	 */
	public flushSeenEpoch: number = -1;
	public flushPreLen: number = 0;
	public flushPreEnabled: number = 0;
	/**
	 * DEV-only iteration guard: >0 while a dense query iterator delivers this
	 * archetype to a user callback. Those iterators are `forEach`,
	 * `forEachChunk`, `some` and `ChangedQuery.forEach`. The row-removing and
	 * reordering primitives `removeRow`, `disableRow` and `enableRow` check it, so an immediate
	 * structural mutation from inside the walk, which would swap-remove under
	 * the iterator and silently skip or repeat entities, throws instead.
	 * Production builds never read or write it.
	 */
	public iterDepth: number = 0;
	private readonly _edges: ArchetypeEdge[] = [];
	/**
	 * Cache of pre-computed transition maps for multi-component transitions
	 * (this → target). Single-component edges live on `_edges[].addMap` and `removeMap`
	 * multi-component pairs land here. Entries never need invalidation,
	 * archetypes live for the Store's lifetime.
	 */
	private readonly _batchTransitionMaps: Map<ArchetypeID, Int16Array> = new Map();
	/**
	 * Per-set add-edge cache for `Store.addComponents`, keyed by an
	 * exact pack of the added component ids. Lazily allocated: most archetypes
	 * never originate a plural add, so the Map stays `null` until the first one
	 * is resolved, the single-add `_edges[]` path never touches it.
	 */
	private _compositeAddEdges: Map<number, CompositeAddEdge> | null = null;

	// --- Flat column storage ---
	// Dense array of all columns across all components in this archetype.
	// Each column conforms to the ColumnBacking surface: the default heap-
	// backed `GrowableTypedArray` for runtime archetypes, or a SAB-backed
	// `BufferBackedColumn` for archetypes built via `fromColumnStore`.
	public readonly flatColumns: ColumnBacking<AnyTypedArray>[] = [];
	// Raw backing views, index-parallel with `flatColumns` (the row plane).
	//
	// The archetype used to place rows through the `ColumnBacking` API,
	// `col.push(v)`, `col.swapRemove(r)` and `col.pop()`, which costs, per column
	// per row, a `.buf` accessor call, a capacity compare, and a `_len`
	// load and store, on top of the one typed-array element move that is the actual
	// work. A profile of a component add and remove churn loop shows that this
	// plumbing, and not the element move, is where `moveEntityFrom` spends most
	// of its time. Since `Archetype.length` already is the row count for every one
	// of its columns, all of it is redundant: the archetype indexes
	// `bufs[i][row]` directly and moves `length` once.
	//
	// Invariant: `bufs[i] === flatColumns[i].buf`, `_colCap` is the smallest
	// column capacity, and `_rowCap` is that against the entity-id array's. All
	// are re-derived by `_syncRowPlane`, which is the only place they are written.
	// Call it after anything that can change a column's buffer identity or
	// capacity (construction, `refreshViews`, a grow, including one that threw),
	// and `_assertRowPlaneFresh` catches a missed call under DEV.
	// Public because the Store and the row-plane readers index it directly, like
	// `flatColumns` and `colOffset` beside it. Refilled in place by
	// `_syncRowPlane`, which is what makes a reference held across a grow see the
	// fresh buffers. The accessor column arrays (`accessorColumns`) are refilled
	// the same way.
	public bufs: AnyTypedArray[] = [];
	// The row plane again, as width-canonical views: index-parallel with `bufs`,
	// over the same bytes, but every column of one element width uses one
	// typed-array class (`widthView` in row_kinds.ts). The structural row
	// operations, copy, move, swap, zero, walk this plane and not `bufs`.
	//
	// Why: those loops have one access site each, and that site sees every
	// element kind that any archetype in the process gives it. V8 keeps one site
	// fast for at most four typed-array classes. The library offers eight column
	// types, so a world that mixes five of them made every row move in the
	// process many times slower, in every archetype, not only the mixed one.
	// Four widths give at most four classes, so the site never crosses that
	// line. A move or a swap copies bits and does not convert values, so a view
	// of the same width is exact for it. A write of a number must convert, so
	// the value paths (`writeFields`, `writeFlatElem`) use the true view in
	// `bufs` through one access site for each kind (row_kinds.ts), and a
	// template converts its defaults one time in advance (`widthBits`).
	private _widthBufs: AnyTypedArray[] = [];
	// --- Row ticks, the row grain of change detection ---
	// One `Uint32Array` per component that an entity-level `onSet` tracks,
	// sparse by ComponentID. `rowTicks[cid][row]` is the change tick of the last
	// record made for that row, and 0 when none was made since the row arrived.
	// The dense list joins `_widthBufs` after the data columns, so a move, a swap
	// and a zero fill carry a row's ticks with the row through the same loops,
	// and the hot row ops do not know the plane exists. The inserts that take a
	// template or a transition zero them apart, because a bit source and a
	// transition map cover the data columns alone. Only a record stamps a tick:
	// an insert and a transition are structural, and `onAdd` reports those.
	// Allocated by `installTicks`, resized to `_rowCap` by `_syncRowPlane`. A
	// scheduling artifact: not in `stateHash` or the snapshot.
	public readonly rowTicks: (Uint32Array | undefined)[] = [];
	private _tickBufs: Uint32Array[] = [];
	private _tickCids: number[] = [];
	// The numeric type tag of each flat column. Fixed at construction, because a
	// live archetype never gains or loses a column.
	private _colKind: Uint8Array = EMPTY_U8;
	// True when every column is `f64`, the default type. The per-field value
	// writes then take one inline loop whose site sees `Float64Array` alone, and
	// skip the tag load and the branch for each field.
	private _allF64 = true;
	// The entity-id column, same treatment: `_entityIds` is a
	// `GrowableUint32Array` carrying its own logical length and grow check, and
	// that length is, again, always `Archetype.length`. Every row op indexes
	// this view directly instead of `push`, `pop` and `buf`. Kept in `_syncRowPlane`
	// alongside `bufs`. Its capacity participates in `_rowCap`, which is what
	// makes the single reserve check cover a tag-only archetype (no columns, but
	// still an entity-id array to grow).
	private _eids!: Uint32Array;
	// Rows this archetype can hold before anything must grow: the minimum of the
	// entity-id array's capacity and every column's. One number, so `reserveRows`
	// is a single compare with no "are there columns?" guard in front of it, and
	// a tag-only archetype (no columns) is covered by the entity-id term alone.
	private _rowCap = 0;
	// The column-only term of `_rowCap` (`NO_COLUMN_CAP` when there are no
	// columns). Kept separately so the cold grow path can tell which term of the
	// `min` fell short: an entity-id-only shortfall is satisfied by the heap grow
	// `_growRows` already did and must not reach `growHandler`, which would
	// realloc and republish the whole column store to resize nothing. See
	// `_growRows`.
	private _colCap = 0;
	/** Set by `fromColumnStore` to record which SAB archetype this Archetype
	 * draws its column views from. `null` for the default heap-backed path
	 * (no SAB linkage, `refreshViews` would be a no-op there and so
	 * isn't supported). */
	private _storeArchetypeId: number | null = null;
	// Sparse by ComponentID → starting index into _flatColumns.
	public readonly colOffset: number[] = [];
	// Sparse by ComponentID → number of fields for that component.
	public readonly fieldCount: number[] = [];
	// Sparse by ComponentID → fieldIndex record (field name → offset within component).
	//
	// This is `Object.create(null)` deliberately, and it keeps string keys
	// deliberately. A field with the name `constructor` must not collide with
	// `Object.prototype`. A null prototype puts the record into dictionary mode,
	// and measurement shows that this is the most stable of the options.
	// A `{}` literal gives fast properties again, and it is much faster with one
	// component. But it is slower than this line in each world that has many
	// different field names. The cause: a load with a varying string key goes
	// through the stub cache of V8, and the cost of that cache increases with the
	// number of different names at the site. The cost of a probe of a dictionary
	// does not increase. We also built and measured a perfect hash for each
	// component over globally interned names, and it fails in the same way.
	// Do not "fix" this line. If you measure it again, measure the condition that
	// has many different field names, and not the condition with one component.
	private readonly _fieldIndex: Record<string, number>[] = [];
	// Sparse by ComponentID → fieldNames array.
	private readonly _fieldNames: string[][] = [];

	// Sparse by ComponentID → the columns a ref or cursor reads through (ref.ts):
	// this component's columns at the global ids of their field names, and
	// `NO_COLUMN` elsewhere. Refilled in place by `_refreshColumnCaches`.
	public readonly accessorColumns: (AccessorColumns | undefined)[] = [];
	// Sparse by ComponentID → the global name id of each field, in schema order.
	private readonly _fieldGid: Int32Array[] = [];
	// Dense list of ComponentIDs that have columns, used for copySharedFrom.
	public readonly columnIds: number[] = [];
	// Sparse by ComponentID → last tick that modified this component's columns.
	public readonly changedTick: number[] = [];

	// forEachChunk group caches, sparse by ComponentID. One reusable
	// field-keyed object per component, refreshed (not reallocated) on each
	// cols.mut()/cols.read() so a chunk loop allocates nothing per archetype.
	private readonly _mutGroupCache: (Record<string, AnyTypedArray> | undefined)[] = [];
	private readonly _readGroupCache: (Record<string, AnyTypedArray> | undefined)[] = [];

	/** Host-installed grow hook. Set by `Store` on every SAB-backed
	 * archetype during construction. `null` on heap-backed archetypes (the
	 * default `GrowableTypedArray` grows in place). Insertion methods call
	 * `_invoke_grow(...)` below before any push that would overflow the
	 * current SAB row capacity. */
	public growHandler: ArchetypeGrowHandler | null = null;

	constructor(
		id: ArchetypeID,
		mask: BitSet,
		layouts?: ArchetypeColumnLayout[],
		initialCapacity: number = DEFAULT_COLUMN_CAPACITY,
		columnFactory?: ColumnFactory
	) {
		this.id = id;
		this.mask = mask;
		this._entityIds = new GrowableUint32Array(initialCapacity);

		if (layouts) {
			let flatIdx = 0;
			const colTags: number[] = [];
			for (let i = 0; i < layouts.length; i++) {
				const layout = layouts[i];
				const cid = layout.componentId as number;
				const columns: ColumnBacking<AnyTypedArray>[] = new Array(layout.fieldNames.length);

				this.colOffset[cid] = flatIdx;
				this.fieldCount[cid] = layout.fieldNames.length;
				this._fieldIndex[cid] = layout.fieldIndex;
				this._fieldNames[cid] = layout.fieldNames;
				this._fieldGid[cid] = layout.fieldGid ?? identityGids(layout.fieldNames.length);

				if (layout.fieldNames.length > 0 && !columnFactory) {
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`Archetype ${id}: layouts with fields require a columnFactory, use Archetype.fromColumnStore for SAB-backed columns, or pass a heap factory explicitly in tests`
					);
				}

				for (let j = 0; j < layout.fieldNames.length; j++) {
					const tag = layout.fieldTypes[j];
					// `columnFactory` is guaranteed non-null by the check above
					// whenever this loop runs (entry only with fieldNames.length > 0).
					const col = columnFactory!(layout.componentId, j, tag);
					columns[j] = col;
					colTags.push(TYPED_ARRAY_TAG_TO_TYPE_TAG[tag]);
					this.flatColumns[flatIdx++] = col;
				}

				this.columnIds.push(cid);
				this.changedTick[cid] = 0;
			}
			this._colKind = Uint8Array.from(colTags);
			for (let i = 0; i < colTags.length; i++) {
				if (colTags[i] !== TYPE_TAG.f64) {
					this._allF64 = false;
					break;
				}
			}
		}

		this.hasColumns = this.columnIds.length > 0;
		// The empty archetype (unique archetype with an empty mask) never
		// materialises rows. Every other archetype does. See the field doc.
		this.materializesRows = !mask.isEmpty();
		this._syncRowPlane();
	}

	// ── Whole-row primitives ───────────────────────────────────────────────
	// These are the only paths that move, copy, swap, zero or write a whole
	// row, and all of them walk `_widthBufs` (the width-canonical plane, see its
	// field doc). A loop of the form `bufs[i][row]` over `bufs` must not come
	// back at a shared site, because that site then sees every element kind in
	// the process.

	/** Row `from` of `src` → row `to` here. `map[i]` is the source column of
	 * column `i`, or negative when the source has no such column. Such a column
	 * gets `0`. Both planes are width-canonical, and a shared column has one
	 * width on both sides, so the copy is a bit copy. */
	private _copyRowFrom(src: Archetype, map: Int16Array, to: number, from: number): void {
		const dst = this._widthBufs;
		const sb = src._widthBufs;
		// `map` covers the data columns. The tick plane sits past them.
		const n = map.length;
		for (let i = 0; i < n; i++) {
			const si = map[i];
			dst[i][to] = si >= 0 ? sb[si][from] : 0;
		}
		if (n !== dst.length) this._copyTicksFrom(src, to, from);
	}

	/** A row's ticks travel with the row across a transition, so a record made
	 * before the move still drains after it. A component the source lacks gets
	 * 0: the add is structural, and `onAdd` reports it. Cold: reached only when
	 * this archetype carries a tick plane. */
	private _copyTicksFrom(src: Archetype, to: number, from: number): void {
		const cids = this._tickCids;
		const bufs = this._tickBufs;
		for (let i = 0; i < cids.length; i++) {
			const st = src.rowTicks[cids[i]];
			bufs[i][to] = st !== undefined ? st[from] : 0;
		}
	}

	/** Give `cid` a row tick column, the row grain of an entity-level `onSet`.
	 * No-op for a component this archetype lacks, for a tag (no field, so no
	 * write to record), and when the column exists. Cold: registration of an
	 * observer, and the birth of an archetype while one is registered. */
	public installTicks(cid: number): void {
		if (this.rowTicks[cid] !== undefined) return;
		const fc = this.fieldCount[cid];
		if (fc === undefined || fc === 0) return;
		const buf = new Uint32Array(Math.max(1, this._rowCap));
		this.rowTicks[cid] = buf;
		this._tickCids.push(cid);
		this._tickBufs.push(buf);
		// Rebuilds `_widthBufs` with the new plane at its tail.
		this._syncRowPlane();
	}

	/** Forget every record. A restore replaces the rows under the plane, so a
	 * tick that survived it would name a write that never happened. */
	public resetTicks(): void {
		const bufs = this._tickBufs;
		for (let i = 0; i < bufs.length; i++) bufs[i].fill(0);
	}

	/** Grow each tick column to `_rowCap` and place the plane after the data
	 * columns in `rowBufs`. Called by `_syncRowPlane`, after it settled the
	 * capacity, and only when a plane exists. */
	private _syncTicks(rowBufs: AnyTypedArray[], base: number): void {
		const cids = this._tickCids;
		const bufs = this._tickBufs;
		const cap = this._rowCap;
		for (let i = 0; i < bufs.length; i++) {
			let buf = bufs[i];
			if (buf.length < cap) {
				const grown = new Uint32Array(cap);
				grown.set(buf);
				buf = bufs[i] = grown;
				this.rowTicks[cids[i]] = grown;
			}
			rowBufs[base + i] = buf;
		}
	}

	/** Row `from` → row `to`, every column. The swap-remove fill. */
	private _moveRow(to: number, from: number): void {
		const bufs = this._widthBufs;
		for (let i = 0; i < bufs.length; i++) bufs[i][to] = bufs[i][from];
	}

	/** Exchange rows `a` and `b`, every column. */
	private _swapRow(a: number, b: number): void {
		const bufs = this._widthBufs;
		for (let i = 0; i < bufs.length; i++) {
			const c = bufs[i];
			const t = c[a];
			c[a] = c[b];
			c[b] = t;
		}
	}

	/** `0` into row `row`, every column. */
	private _zeroRow(row: number): void {
		const bufs = this._widthBufs;
		for (let i = 0; i < bufs.length; i++) bufs[i][row] = 0;
	}

	/** `bits[i]` into row `row` of column `i`, every column, through the
	 * width-canonical plane. `bits` must come from `widthBits`, so each entry is
	 * already the column's stored representation and no conversion remains. The
	 * single-append primitive behind `spawn`. */
	private _writeRowBits(row: number, bits: Float64Array): void {
		const bufs = this._widthBufs;
		const n = bits.length;
		for (let i = 0; i < n; i++) bufs[i][row] = bits[i];
		// The tick plane past the data columns. A spawn makes no record.
		for (let i = n; i < bufs.length; i++) bufs[i][row] = 0;
	}

	/** Re-derive the `bufs`, `_eids` and `_rowCap` row plane from the backing
	 * columns. The sole writer of all three, see the `bufs` field doc for the
	 * invariant it restores. Cold: construction, `refreshViews`, tail of a grow. */
	private _syncRowPlane(): void {
		const cols = this.flatColumns;
		// Refill in place rather than allocating. `flatColumns` is fixed at
		// construction (columns are never added to or removed from a live
		// archetype), so after the first sync the length always matches, and
		// `refreshViews`, the main caller, sits on the O(N²) archetype-registration
		// extend cascade that it is specifically tuned to keep allocation-free.
		// In-place is also the safer aliasing story: a local that captured `bufs`
		// before a grow sees the fresh buffers rather than silently stale ones.
		let bufs = this.bufs;
		if (bufs.length !== cols.length) bufs = this.bufs = new Array(cols.length);
		let rowBufs = this._widthBufs;
		const total = cols.length + this._tickBufs.length;
		if (rowBufs.length !== total) rowBufs = this._widthBufs = new Array(total);
		const colKind = this._colKind;
		this._eids = this._entityIds.buf;
		// The two terms of `_rowCap` are tracked separately, not folded as they are
		// accumulated: `_growRows` has to know whether a shortfall is the columns'
		// or only the entity-id array's. `NO_COLUMN_CAP` makes the no-columns case
		// fall out of the same arithmetic with no branch.
		let colCap = NO_COLUMN_CAP;
		for (let i = 0; i < cols.length; i++) {
			const buf = cols[i].buf;
			bufs[i] = buf;
			rowBufs[i] = widthView(colKind[i], buf);
			if (buf.length < colCap) colCap = buf.length;
		}
		this._colCap = colCap;
		const eidCap = this._eids.length;
		this._rowCap = eidCap < colCap ? eidCap : colCap;
		if (this._tickBufs.length !== 0) this._syncTicks(rowBufs, cols.length);
		// The cached `forEachChunk` groups point at the buffers that were only
		// re-derived, so they are refreshed here rather than re-checked on every
		// read. See `_refreshColumnCaches`.
		this._refreshColumnCaches();
	}

	/** Re-point every cached `forEachChunk` column group at the current `bufs`.
	 *
	 * Called only from `_syncRowPlane`, which is the only thing that can change a
	 * column's buffer identity, so after this runs, a cached group is correct by
	 * construction, and `columnGroupMut` and `columnGroupRead` need no staleness test
	 * at all. That absence is the point: those two run once per archetype per
	 * `forEachChunk` pass, which for a fragmented query is once per chunk, and this
	 * file already carries one hard-won lesson (`_onArchShrink`): one more
	 * statement pushed that per-mutation function past V8's inlining budget, and
	 * it became much slower. We measured two earlier forms of this optimisation
	 * and rejected both for the same cause. A fill through a shared helper made
	 * fragmented iteration slower, and an inline test for a stale buffer also made
	 * it slower. Each loss was larger than the gain in system dispatch. Move the
	 * work to the cold path, and the gain stays with no loss.
	 *
	 * Refreshes in place, preserving object identity, for the same reason
	 * `_syncRowPlane` refills `bufs` in place: a caller that captured the group
	 * sees fresh buffers rather than silently stale ones. */
	private _refreshColumnCaches(): void {
		const ids = this.columnIds;
		const bufs = this.bufs;
		for (let i = 0; i < ids.length; i++) {
			const cid = ids[i];
			// Created here, not on first use: a lazy `if (group === undefined)` in the
			// accessors is the one statement that put them back over the inlining
			// budget (measured, see the note above). `_syncRowPlane` runs during
			// construction, so by the time any accessor can be called both groups for
			// every column-bearing component already exist.
			let mut = this._mutGroupCache[cid];
			if (mut === undefined) mut = this._mutGroupCache[cid] = {};
			let read = this._readGroupCache[cid];
			if (read === undefined) read = this._readGroupCache[cid] = {};
			const offset = this.colOffset[cid];
			const gids = this._fieldGid[cid];
			let acc = this.accessorColumns[cid];
			if (acc === undefined) {
				let max = -1;
				for (let f = 0; f < gids.length; f++) if (gids[f] > max) max = gids[f];
				// Packed, not holey: a hole would make every accessor load test for
				// it. `NO_COLUMN` fills the ids of names this component lacks.
				acc = this.accessorColumns[cid] = new Array<AnyTypedArray>(max + 1).fill(NO_COLUMN);
			}
			const names = this._fieldNames[cid];
			for (let f = 0; f < names.length; f++) {
				const buf = bufs[offset + f];
				mut[names[f]] = buf;
				read[names[f]] = buf;
				acc[gids[f]] = buf;
			}
		}
	}

	/** DEV-only: assert the row plane still addresses the live buffers.
	 *
	 * `bufs` and `_eids` and `flatColumns[i].buf` and `_entityIds.buf` are two paths to
	 * one buffer, and only the first is cached, the row ops index the cache while
	 * `getColumnRead` and `writeFields` read `.buf` fresh. Anything that changes a
	 * buffer's identity owes a `_syncRowPlane`. Miss one and the two paths split
	 * silently, with row writes landing in an orphan that later reads never see.
	 *
	 * Checked at the boundaries that read `.buf` directly, and O(1): index 0 alone
	 * is enough, because `_syncRowPlane` rewrites every entry together. There is
	 * no way to desync one column and not the first. */
	private _assertRowPlaneFresh(where: string): void {
		const cols = this.flatColumns;
		const split =
			this._eids !== this._entityIds.buf ||
			(cols.length > 0 && this.bufs[0] !== cols[0].buf);
		if (split) {
			throw new ECSError(
				ECS_ERROR.ARCHETYPE_ROW_INVARIANT,
				`Archetype ${this.id}: cached row plane is stale at ${where}, a buffer changed identity without a _syncRowPlane`
			);
		}
	}

	/** Make room for `additional` more rows, growing if the append would
	 * overflow. Replaces the `this.length >= cols[0].buf.length` probe the append
	 * paths each open-coded, that read a column object and its buffer's length
	 * on every single-row append. This is one compare against a cached number.
	 *
	 * Every append path calls this, and the spawn path calls it first so it can
	 * reserve capacity before it commits an entity slot. A cap grow throws here,
	 * with the world untouched, instead of mid-append after the slot is live.
	 * See `Store.spawn` and `spawnMany`.
	 *
	 * Both backings are handled by `_growRows` so callers don't branch: a
	 * SAB-backed archetype delegates to the store's `growHandler` (realloc +
	 * republish, which re-enters `refreshViews`), a heap-backed one
	 * (`growHandler === null`, the unit-test factory) grows each column in place.
	 * Either way the buffers may have moved, so the row plane is re-synced before
	 * returning, including when the grow throws. */
	public reserveRows(additional: number): void {
		// One compare against a cached number and nothing else, that is the whole
		// point of `_rowCap`, and the append paths call this per row. The grow lives
		// in `_growRows` so the cold path's locals, branches and `try` and `finally`
		// stay out of the body V8 inlines into those appends.
		if (this.length + additional > this._rowCap) this._growRows(additional);
	}

	/** Cold half of `reserveRows`: the append genuinely doesn't fit, so grow.
	 * Never called on the fast path, see the caller. */
	private _growRows(additional: number): void {
		const need = this.length + additional;
		// The entity-id array is heap-backed on both profiles and reallocates by
		// copying `[0, _len)`, so it always needs the authoritative count first.
		this._entityIds.setLength(this.length);
		this._entityIds.reserve(need);
		if (need <= this._colCap) {
			// The columns already hold the room, the shortfall was the entity-id
			// array's alone, and the grow above settled it. Two ways to get here:
			//
			// 1. A tag-only archetype (`_colCap === NO_COLUMN_CAP`), always. Its rows
			//    live entirely in the entity-id array, and it is expressly allowed to
			//    run past the SAB descriptor's `row_capacity` (the descriptor's
			//    capacity is metadata only when there are no columns).
			// 2. A genuine capacity skew between the two terms. Normally they double
			//    from the same base (`fromColumnStore` seeds `_entityIds` with
			//    `storeArchetype.rowCapacity`), but `restoreHostRows` grows the
			//    entity-id array to the restored row count, not the restored capacity,
			//   so a snapshot of 1100 rows mounted into a 4096-capacity archetype
			//    leaves eids at 2048 against columns at 4096.
			//
			// Either way, delegating to `growHandler` would compute
			// `newCapacity === oldCapacity`, find no column to resize, and fall
			// through to `reallocAndRepublish`: a full snapshot → create → restore of
			// the whole column store, `viewsPreserved: false`, so every archetype
			// takes a `refreshViews`, to resize nothing. Folding the entity-id term
			// into `_rowCap` is what lets one compare cover a column-less archetype,
			// but the grow decision still belongs to the column term alone, which is
			// what the open-coded `this.length >= cols[0].buf.length` probes this
			// method replaced tested.
			this._syncRowPlane();
			return;
		}
		try {
			if (this.growHandler !== null) {
				// SAB-backed columns: the store copies live rows using the row count it
				// holds (`GrowPlan.rowCount` ← `Archetype.length`), so no publish needed.
				this.growHandler(this, additional);
			} else {
				// Heap-backed columns: each reallocates and carries forward its own
				// logical length (`reserve` copies `[0, _len)`), so they must be
				// handed the authoritative row count first or the grow drops the rows.
				this._publishRowCounts();
				const cols = this.flatColumns;
				for (let i = 0; i < cols.length; i++) cols[i].reserve(need);
			}
		} finally {
			// Re-sync on the throw path too, not only on success. A `growHandler`
			// throw is a state the world is meant to survive, not a fatal: the
			// SAB-cap grow throws from here by design "with the world untouched",
			// which is the whole basis of the fail-closed, all-or-nothing
			// `Store.spawn` and `Store.spawnMany` contract.
			//
			// But the entity-id array already reallocated above, so from that point
			// `_eids` addresses an orphaned buffer while `_entityIds._buf` is the new
			// one, and `_rowCap` still describes the old capacity. Left unsynced, a
			// later append that fits the stale `_rowCap` takes the fast path and
			// writes its entity id into the orphan. The next `_syncRowPlane`, a
			// successful grow, or the `refreshViews` that fires whenever any new
			// archetype is registered, swaps in the buffer that never received that
			// row, so the id reads back 0 and the following swap-remove corrupts
			// `entityRows[getEntityIndex(0)]`.
			this._syncRowPlane();
		}
		// Post-condition: every append path writes `[length, length + additional)`
		// through the row plane without bounds-checking (that is the point of the
		// cached `_rowCap`), so a grow that silently failed to deliver the capacity
		// would corrupt rows rather than throw. Assert it here, once, instead of
		// re-checking on every element write.
		if (DEV && need > this._rowCap) {
			throw new ECSError(
				ECS_ERROR.ARCHETYPE_ROW_INVARIANT,
				`Archetype ${this.id}: reserve of ${additional} row(s) left capacity ${this._rowCap} below the required ${need}`
			);
		}
	}

	/** Push `Archetype.length` down into each column's own logical length (and
	 * the entity-id array's). The row plane keeps `length` authoritative and never
	 * touches `_len`, so the columns' view of it goes stale between publishes.
	 * Nothing on the ECS hot paths reads it. The boundaries that do, a
	 * reallocating `reserve`, `refreshView`'s shrink check, `view()`,
	 * publish first. */
	private _publishRowCounts(): void {
		const cols = this.flatColumns;
		const len = this.length;
		for (let i = 0; i < cols.length; i++) cols[i].setLength(len);
		this._entityIds.setLength(len);
	}

	/**
	 * Build an Archetype whose columns are TypedArray views into a single
	 * `ColumnStore`-managed `SharedArrayBuffer`. The store must contain an
	 * archetype entry whose id equals `storeArchetypeId` and whose columns
	 * cover every `(component_id, fieldIdx)` pair declared by `layouts`.
	 *
	 * The resulting archetype is fixed-capacity at the SAB row capacity,
	 * any operation that would push past it throws `StoreColumnOverflowError`.
	 * To grow capacity, call `growColumnStore(...)` between ticks and then
	 * `refreshViews(newStore)` on this archetype.
	 */
	public static fromColumnStore(
		id: ArchetypeID,
		mask: BitSet,
		layouts: ArchetypeColumnLayout[],
		columnStore: ColumnStore,
		storeArchetypeId: number
	): Archetype {
		const storeArchetype = columnStore.archetypes.get(storeArchetypeId);
		if (!storeArchetype) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`ColumnStore has no archetype ${storeArchetypeId}`
			);
		}
		const factory: ColumnFactory = (componentId, fieldIdx) => {
			const view = storeArchetype.columns.get(columnKey(componentId as number, fieldIdx));
			if (!view) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`ColumnStore archetype ${storeArchetypeId} has no column for (${componentId}, ${fieldIdx})`
				);
			}
			return new BufferBackedColumn(view.view);
		};
		const archetype = new Archetype(id, mask, layouts, storeArchetype.rowCapacity, factory);
		archetype._storeArchetypeId = storeArchetypeId;
		return archetype;
	}

	/** True iff this archetype was constructed via `fromColumnStore` and its
	 * `flatColumns` are SAB-backed. Heap-backed archetypes return `false`
	 * and cannot be refreshed (their columns grow in place). */
	public get isBufferBacked(): boolean {
		return this._storeArchetypeId !== null;
	}

	/**
	 * Repoint every column at the matching SAB view in `newColumnStore` after
	 * a host-side `growColumnStore` realloc. The archetype keeps its row
	 * count. Each column's logical length is preserved. Caller is responsible
	 * for ensuring `newColumnStore` was built by `growColumnStore` over the
	 * SAB this archetype was originally drawn from, the matching
	 * `storeArchetypeId` was recorded in `fromColumnStore` and is reused here.
	 *
	 * Throws `ECSError` if this archetype is not SAB-backed, or if the new
	 * store lacks the recorded archetype id or any column the archetype
	 * expects.
	 */
	public refreshViews(newColumnStore: ColumnStore): void {
		if (this._storeArchetypeId === null) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`Archetype ${this.id} is not SAB-backed`
			);
		}
		const storeArch = newColumnStore.archetypes.get(this._storeArchetypeId);
		if (!storeArch) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`new ColumnStore has no archetype ${this._storeArchetypeId}`
			);
		}
		// `flatColumns` and `storeArch.columnsInOrder` share an index space:
		// both are built by walking `layouts` in order, then `fieldNames` and
		// `columns` in order (see `Archetype` constructor and
		// `storeSpecFromLayouts` in store.ts). Iterating by index avoids the
		// per-column `Map.get(columnKey(...))` lookup the previous loop did,
		// during lazy-registration ramp-up `refreshViews` runs once per
		// existing archetype per extend, so trimming this inner cost is the
		// load-bearing win on the O(N²) extend cascade.
		const newViews = storeArch.columnsInOrder;
		// Function entry already established `_storeArchetypeId !== null`, which
		// means this archetype was built via `fromColumnStore` and every entry
		// in `flatColumns` was produced by the SAB `ColumnFactory` (see
		// `fromColumnStore`), i.e. each is a `BufferBackedColumn`. The cast and
		// dev-only assert turn that invariant into a single boundary check
		// instead of a per-column `instanceof` in the hot extend cascade.
		const allCols = this.flatColumns as BufferBackedColumn<AnyTypedArray>[];
		// Hand the columns the authoritative row count before repointing them:
		// `refreshView` refuses a view too small to hold the column's logical
		// length, and the row plane keeps that length on the Archetype,
		// so without this the shrink check would compare against a stale 0.
		this._publishRowCounts();
		if (DEV) {
			for (let i = 0; i < newViews.length; i++) {
				if (!(allCols[i] instanceof BufferBackedColumn)) {
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`Archetype ${this.id} column at index ${i} is not SAB-backed (internal)`
					);
				}
			}
		}
		for (let i = 0; i < newViews.length; i++) {
			allCols[i].refreshView(newViews[i].view);
		}
		// Buffers only changed identity (and possibly capacity), re-derive.
		this._syncRowPlane();
	}

	/** Enabled-row count, the default iteration bound. See `enabled_count`.
	 * Equals `length` whenever no entity is disabled (the common case).
	 *
	 * During an `includeDisabled()` query's `forEach`, the module flag
	 * `iterAllRows` is set so this returns `length` (enabled + disabled), the
	 * user's `for i < arch.entityCount` loop then spans disabled rows
	 * transparently, with no change to the loop. Outside such iteration the flag is
	 * false and this is `enabled_count`. */
	public get entityCount(): number {
		return iterAllRows ? this.length : this.enabledCount;
	}

	/** Total live rows incl. disabled. */
	public get totalCount(): number {
		return this.length;
	}

	/** Disabled-row count. */
	public get disabledCount(): number {
		return this.length - this.enabledCount;
	}

	/** Raw entity ID buffer (packed `EntityID`s). Valid data at indices
	 * 0..totalCount-1 (enabled rows first, then disabled). */
	public get entityIds(): ReadonlyEntityIDArray {
		// branded-ID bridging: the buffer stores packed EntityIDs as raw u32s.
		const ids: ReadonlyUint32Array = this._eids;
		return ids as ReadonlyEntityIDArray;
	}

	/**
	 * Swap the two rows `a` and `b`, entity ids and every column. Does not touch
	 * `entityRows`. The caller updates the entity→row map for whichever rows it
	 * cares about (it knows the two `entityIds` after the swap). The partition
	 * primitives (`disableRow`, `enableRow`, `removeRow` and `_placeTail`) build on
	 * this. Writes through each column's live backing buffer (`buf`), so it works
	 * for both heap- and SAB-backed columns. No-op when `a === b`. */
	public swapRows(a: number, b: number): void {
		if (a === b) return;
		const eids = this._eids;
		const tmp = eids[a];
		eids[a] = eids[b];
		eids[b] = tmp;
		this._swapRow(a, b);
	}

	/**
	 * Place a freshly-appended enabled entity (currently at the tail row `tail`,
	 * already pushed, `length` already incremented) into the enabled region, and
	 * bump `enabled_count`. Returns its final row.
	 *
	 * Common case, no disabled rows (`enabled_count === tail`): the tail row is
	 * the next enabled slot, so this is only `enabled_count++` and returns `tail`
	 * (byte-for-byte the earlier behaviour, `entityRows` untouched). Rare case,
	 * disabled rows occupy `[enabled_count, tail)`: swap the appended row into the
	 * first disabled slot and push that disabled occupant to the tail, updating
	 * its `entityRows`. Requires `entityRows` in that case (a `DEV` guard fires
	 * if a caller appends into a disabled-bearing archetype without passing it). */
	private _placeTail(tail: number, entityRows?: Int32Array): number {
		const ec = this.enabledCount;
		if (ec === tail) {
			this.enabledCount = tail + 1;
			return tail;
		}
		if (DEV && entityRows === undefined) throw partitionNoEntityRowError();
		this.swapRows(ec, tail);
		if (entityRows !== undefined) {
			const eids = this._eids;
			entityRows[getEntityIndex(eids[tail] as EntityID)] = tail;
		}
		this.enabledCount = ec + 1;
		return ec;
	}

	/**
	 * Bulk analog of `_placeTail` for `count` freshly-appended enabled rows at
	 * `[start, start+count)`. Common case (no disabled rows, `enabled_count ===
	 * start`): `enabled_count += count`, return `start`. The bulk callers
	 * (`spawnMany`, batch ops) fall back to a per-entity append loop when the
	 * target already has disabled rows, so the rare branch is a `DEV` guard
	 * rather than a block-rotation. */
	private _placeTailBulk(start: number, count: number): number {
		if (DEV && this.enabledCount !== start) throw bulkIntoDisabledError();
		this.enabledCount += count;
		return start;
	}

	/**
	 * Disable the entity at `row` (precondition: enabled, `row < enabled_count`).
	 * Swaps it to the end of the enabled region and shrinks the region, so it
	 * lands in the disabled tail with its data intact, no archetype transition,
	 * O(1)+one row swap. Updates `entityRows` for both rows touched. */
	public disableRow(row: number, entityRows: Int32Array): void {
		if (DEV && this.iterDepth > 0) throw structuralMidWalkError("disable");
		const lastEnabled = this.enabledCount - 1;
		if (row !== lastEnabled) {
			this.swapRows(row, lastEnabled);
			const eids = this._eids;
			entityRows[getEntityIndex(eids[row] as EntityID)] = row;
			entityRows[getEntityIndex(eids[lastEnabled] as EntityID)] = lastEnabled;
		}
		this.enabledCount = lastEnabled;
	}

	/**
	 * Enable the entity at `row` (precondition: disabled, `row >= enabled_count`).
	 * Swaps it to the front of the disabled region and grows the enabled region.
	 * Updates `entityRows` for both rows touched. */
	public enableRow(row: number, entityRows: Int32Array): void {
		if (DEV && this.iterDepth > 0) throw structuralMidWalkError("enable");
		const firstDisabled = this.enabledCount;
		if (row !== firstDisabled) {
			this.swapRows(row, firstDisabled);
			const eids = this._eids;
			entityRows[getEntityIndex(eids[row] as EntityID)] = row;
			entityRows[getEntityIndex(eids[firstDisabled] as EntityID)] = firstDisabled;
		}
		this.enabledCount = firstDisabled + 1;
	}

	/**
	 * Partition-aware swap-remove that owns its `entityRows` updates. The
	 * Store's destroy and move paths call this instead of `swapRemoveRow`. It keeps the
	 * enabled prefix contiguous in every case:
	 *  - disabled row (`row >= enabled_count`): swap-remove within the disabled
	 *    tail (the last row is disabled), `enabled_count` unchanged.
	 *  - last enabled row: swap-remove with the global last. `enabled_count--`.
	 *  - middle enabled row: move the last enabled row into the hole (so the
	 *    enabled prefix stays packed), then swap-remove that vacated enabled slot
	 *    with the global last. `enabled_count--`.
	 * Updates `entityRows` for every relocated entity (never for the removed one,
	 * the caller frees and repoints it). */
	public removeRow(row: number, entityRows: Int32Array): void {
		if (DEV && this.iterDepth > 0) throw structuralMidWalkError("removeRow");
		// Fast path, no disabled rows (`enabled_count === length`, the common
		// case a partition-free archetype gives). The partition is trivial, so a
		// one-directional swap-remove suffices: copy the last row into the hole
		// and pop, one pass over the columns. The general partition-aware case
		// is split into `_removeRowPartitioned` (a cold split) so
		// this hot body stays inside V8's cumulative inlining budget at the
		// flush-loop call sites. It sits inside `moveEntityFrom`, so it runs
		// on every archetype transition (add, remove and destroy).
		if (this.enabledCount === this.length) {
			const eids = this._eids;
			const last = this.length - 1;
			if (row !== last) {
				eids[row] = eids[last];
				this._moveRow(row, last);
				entityRows[getEntityIndex(eids[row] as EntityID)] = row;
			}
			// No `pop()` on the else branch: dropping the tail is only the length
			// decrement below, the stale bytes at `last` are past `length` and are
			// overwritten by the next append.
			this.length = last;
			this.enabledCount = last;
			return;
		}
		this._removeRowPartitioned(row, entityRows);
	}

	/** @internal, cold partition-aware tail of `removeRow`: the
	 * disabled-bearing archetype case. Split out so the no-disabled fast path
	 * above stays small enough to inline. See the doc on `removeRow`. */
	private _removeRowPartitioned(row: number, entityRows: Int32Array): void {
		const eids = this._eids;
		const ec = this.enabledCount;
		const last = this.length - 1;

		if (row >= ec) {
			// Disabled row, swap-remove within the disabled tail.
			if (row !== last) {
				eids[row] = eids[last];
				this._moveRow(row, last);
				entityRows[getEntityIndex(eids[row] as EntityID)] = row;
			}
			this.length--;
			return;
		}

		// Enabled row. Keep the enabled prefix packed: move the last enabled row
		// into the hole first (if it isn't the hole), then remove that slot.
		const lastEnabled = ec - 1;
		if (row !== lastEnabled) {
			this.swapRows(row, lastEnabled);
			entityRows[getEntityIndex(eids[row] as EntityID)] = row;
		}
		// Now swap-remove the (now vacated) last-enabled slot with the global last.
		if (lastEnabled !== last) {
			eids[lastEnabled] = eids[last];
			this._moveRow(lastEnabled, last);
			entityRows[getEntityIndex(eids[lastEnabled] as EntityID)] = lastEnabled;
		}
		this.length--;
		this.enabledCount = lastEnabled;
	}

	/** The entity ids of the live rows, bounded by `length`. `entityIds` returns
	 * the same buffer at its full capacity, so a walk uses this one. */
	public get rowEntityIds(): Uint32Array {
		// Bound by `Archetype.length`, not the backing array's own logical length,
		// the row plane owns the count and only publishes it down at
		// grow and refresh boundaries.
		return this._eids.subarray(0, this.length);
	}

	public hasComponent(id: ComponentID): boolean {
		return this.mask.has(id);
	}

	public matches(required: BitSet): boolean {
		return this.mask.contains(required);
	}

	/**
	 * Get a single field's column (read-only, use when not mutating). Valid
	 * data: indices 0..entityCount-1. The `ReadonlyColumn` return is an
	 * *advisory* compile-time barrier: it is the live mutable backing buffer,
	 * so the `readonly` index signature blocks writes at the type layer only
	 * (a deliberate cast can still write through). For writes use the
	 * mutable `getColumnMut` (tick-bumping) below.
	 */
	public getColumnRead<S extends ComponentSchema, K extends string & keyof S>(
		def: ComponentDef<S>,
		field: K
	): ReadonlyColumn {
		const cid = def.id;
		if (DEV) {
			accessCheck.assertRead(def);
			if (this.colOffset[cid] === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Component ${def} not in archetype ${this.id}`
				);
			}
			this._assertRowPlaneFresh("getColumnRead");
		}
		const fi = this._fieldIndex[cid][field];
		if (DEV) {
			if (fi === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Field "${field}" does not exist on component`
				);
			}
		}
		return this.flatColumns[this.colOffset[cid] + fi].buf as unknown as ReadonlyColumn;
	}

	/**
	 * Tuple fetch of several of one component's columns,
	 * `const [q, r] = arch.getColumnsRead(HexPos, "q", "r")` collapses the
	 * per-field `getColumnRead` preamble at the top of an iteration callback
	 * to one line. Same advisory-readonly views and `reads` access-check as
	 * `getColumnRead`. Allocates one small array per call, fine once per
	 * archetype per tick. In a per-row loop fetch columns individually.
	 */
	public getColumnsRead<S extends ComponentSchema, const K extends readonly (string & keyof S)[]>(
		def: ComponentDef<S>,
		...fields: K
	): { [I in keyof K]: ReadonlyColumn } {
		const out = fields.map((f) => this.getColumnRead(def, f));
		// boundary: ReadonlyColumn[] → the same-arity mapped tuple (length = fields.length by construction).
		return out as { [I in keyof K]: ReadonlyColumn };
	}

	/**
	 * Get a single field's column **if this archetype has the component**, else
	 * `undefined`, the fetch-if-present accessor for optional query terms
	 * (Bevy `Option<&T>`, flecs `?`). An optional query (`q.optional(T)`) spans
	 * archetypes both with and without `T`. The caller branches once per
	 * archetype span on the return:
	 *
	 *   q.forEach((arch) => {
	 *     const vx = arch.getOptionalColumnRead(Vel, "vx");
	 *     for (let i = 0; i < arch.entityCount; i++) {
	 *       px[i] += vx ? vx[i] : 0;   // absent span ⇒ vx === undefined
	 *     }
	 *   });
	 *
	 * Unlike `getColumnRead`, a component the archetype lacks is the expected
	 * **absent** branch, not a thrown error. The `DEV` checks still run
	 * **first** (before the absent short-circuit), so the requirements don't
	 * depend on whether the current span happens to hold `T`. Two checks fire:
	 * (1) `accessCheck.assertRead`, an optional read needs `reads:[T]` coverage
	 * exactly as a required read does, and (2) `accessCheck.assertOptionalFetch`,
	 * the iterating query must have declared `.optional(T)`, the read-side
	 * analog that makes the query term the fetch's authorization rather than inert
	 * decoration. The return is the same advisory-readonly view `getColumnRead`
	 * hands back.
	 */
	public getOptionalColumnRead<S extends ComponentSchema, K extends string & keyof S>(
		def: ComponentDef<S>,
		field: K
	): ReadonlyColumn | undefined {
		const cid = def.id;
		if (DEV) {
			accessCheck.assertRead(def);
			// The `.optional(T)` query term authorizes this fetch: reject a
			// fetch of a component the iterating query didn't declare optional.
			accessCheck.assertOptionalFetch(def);
		}
		const offset = this.colOffset[cid];
		if (offset === undefined) return undefined;
		const fi = this._fieldIndex[cid][field];
		if (DEV) {
			if (fi === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Field "${field}" does not exist on component`
				);
			}
		}
		return this.flatColumns[offset + fi].buf as unknown as ReadonlyColumn;
	}

	/** Get a single field's column (mutable, the default). Marks the component as changed at the given tick. */
	public getColumnMut<S extends ComponentSchema, K extends string & keyof S>(
		def: ComponentDef<S>,
		field: K,
		tick: number
	): TagToTypedArray[S[K]] {
		const cid = def.id;
		if (DEV) {
			accessCheck.assertWrite(def);
			if (this.colOffset[cid] === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Component ${def} not in archetype ${this.id}`
				);
			}
		}
		this.changedTick[cid] = tick;
		const fi = this._fieldIndex[cid][field];
		if (DEV) {
			if (fi === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Field "${field}" does not exist on component`
				);
			}
		}
		return this.flatColumns[this.colOffset[cid] + fi].buf as TagToTypedArray[S[K]];
	}

	// ── forEachChunk column-group accessors ───────────────────────
	// Resolve all of one component's field columns at once into a field-keyed
	// object, `const { x, y } = cols.mut(Pos)`, collapsing the per-field
	// `getColumnMut` preamble + tick threading into one call, then a plain
	// typed-array inner loop. `_mut` stamps the change tick once (so the loop
	// body is pure indexing). `_read` does not. Both reuse one cached object per
	// (archetype, component), refreshing each field's live buffer reference in
	// place every call, a buffer can change identity across a between-tick grow,
	// so we always re-read. ⇒ zero per-archetype allocation. Safety: destructure
	// the returned group immediately (`const { x, y } = cols.mut(Pos)`). Do not
	// retain the object across calls, a later `cols.mut(SameComponent)` refreshes
	// the same instance. The destructured locals are unaffected (refs are copied).

	/** Mutable field-keyed column group. Stamps the change tick once. */
	public columnGroupMut<S extends ComponentSchema>(
		def: ComponentDef<S>,
		tick: number
	): MutableColumnsForSchema<S> {
		const cid = def.id;
		if (DEV) {
			accessCheck.assertWrite(def);
			if (this.colOffset[cid] === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Component ${def} not in archetype ${this.id}`
				);
			}
		}
		this.changedTick[cid] = tick;
		// No refresh and no staleness test: the group was filled on first use and is
		// re-pointed by `_syncRowPlane` whenever a buffer moves, so reaching it is
		// one array load. This used to rewrite one string-keyed property per field
		// on every call, which a fragmented `forEachChunk` pass pays once per chunk
		// instead of once per tick.
		return this._mutGroupCache[cid] as MutableColumnsForSchema<S>;
	}

	/** Read-only field-keyed column group (no tick bump). */
	public columnGroupRead<S extends ComponentSchema>(def: ComponentDef<S>): ColumnsForSchema<S> {
		const cid = def.id;
		if (DEV) {
			accessCheck.assertRead(def);
			if (this.colOffset[cid] === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`Component ${def} not in archetype ${this.id}`
				);
			}
		}
		// MutableColumnsForSchema widens to the readonly ColumnsForSchema on return.
		return this._readGroupCache[cid] as MutableColumnsForSchema<S>;
	}

	public writeFields(
		row: number,
		componentId: ComponentID,
		values: Record<string, number>,
		tick: number
	): void {
		const cid = componentId as number;
		const offset = this.colOffset[cid];
		if (offset === undefined) return;
		if (DEV) this._assertRowPlaneFresh("writeFields");
		this.changedTick[cid] = tick;
		const names = this._fieldNames[cid];
		const bufs = this.bufs;
		// `?? 0` in both loops: an omitted field is `undefined`. A Float32/64Array
		// would store it as NaN (Int* coerce to 0). Mirror `createTemplate`'s
		// zero-fill so add, insert and batch agree with the template path: omitted ⇒ 0.
		if (this._allF64) {
			// the common case: every column is the default type, so one inline
			// loop whose site sees Float64Array alone.
			for (let i = 0; i < names.length; i++) {
				(bufs[offset + i] as Float64Array)[row] = values[names[i]] ?? 0;
			}
			return;
		}
		const kind = this._colKind;
		for (let i = 0; i < names.length; i++) {
			const v = values[names[i]] ?? 0;
			const k = kind[offset + i];
			// `f64` keeps an inline store here too. Every other type goes through
			// the access site of its kind (row_kinds.ts).
			if (k === TAG_F64) (bufs[offset + i] as Float64Array)[row] = v;
			else writeElem(k, bufs[offset + i], row, v);
		}
	}

	/**
	 * Bulk variant of `writeFields`, fills `count` consecutive rows starting
	 * at `dstStart` with the same field values via per-field `TypedArray.fill`.
	 * For N rows of an F-field component, this is F native fill calls instead
	 * of N×F per-row JS writes. The change-tick is bumped once for the range,
	 * not once per row. Used by `Store.batchAddComponent` after a bulk move,
	 * where every freshly-added row shares the same field values.
	 */
	public bulkWriteFields(
		dstStart: number,
		count: number,
		componentId: ComponentID,
		values: Record<string, number>,
		tick: number
	): void {
		const cid = componentId as number;
		const offset = this.colOffset[cid];
		if (offset === undefined) return;
		this.changedTick[cid] = tick;
		const names = this._fieldNames[cid];
		const cols = this.flatColumns;
		const end = dstStart + count;
		for (let i = 0; i < names.length; i++) {
			// `?? 0`: omitted float field would fill NaN otherwise, mirror the
			// template zero-fill so batch add matches add/insert/template.
			cols[offset + i].buf.fill(values[names[i]] ?? 0, dstStart, end);
		}
	}

	/** Fast positional write: values[i] → field[i] in declaration order. No string lookup. */
	public writeFieldsPositional(
		row: number,
		componentId: ComponentID,
		values: ArrayLike<number>,
		tick: number
	): void {
		const cid = componentId as number;
		const offset = this.colOffset[cid];
		if (offset === undefined) return;
		this.changedTick[cid] = tick;
		const cols = this.flatColumns;
		for (let i = 0; i < values.length; i++) {
			cols[offset + i].buf[row] = values[i];
		}
	}

	public readField(row: number, componentId: ComponentID, field: string): number {
		const cid = componentId as number;
		const offset = this.colOffset[cid];
		if (offset === undefined) {
			if (DEV)
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`readField: component ${cid} has no column in this archetype, the entity doesn't hold it`,
					{ component: cid, field }
				);
			return NaN;
		}
		const fi = this._fieldIndex[cid][field];
		if (fi === undefined) {
			if (DEV)
				throw new ECSError(
					ECS_ERROR.FIELD_NOT_REGISTERED,
					`readField: component ${cid} has no field "${field}", check the schema passed to registerComponent`,
					{ component: cid, field }
				);
			return NaN;
		}
		// `bufs`, not `flatColumns[i].buf`, the row plane exists precisely so a
		// per-row access is one array load instead of an array load plus a `.buf`
		// accessor on a `ColumnBacking` whose concrete type (heap `GrowableTypedArray`
		// vs SAB `BufferBackedColumn`) makes that load polymorphic. Same invariant the
		// row ops rely on, see the `bufs` field doc. `_assertRowPlaneFresh` below
		// catches a missed `_syncRowPlane` under DEV.
		if (DEV) this._assertRowPlaneFresh("readField");
		return this.bufs[offset + fi][row];
	}

	/** Copy all shared component columns from source archetype at srcRow into dstRow. */
	public copySharedFrom(source: Archetype, srcRow: number, dstRow: number, tick: number): void {
		const srcOffsets = source.colOffset;
		const srcFcounts = source.fieldCount;
		const srcCols = source.flatColumns;
		const dstCols = this.flatColumns;
		const ids = this.columnIds;
		for (let i = 0; i < ids.length; i++) {
			const cid = ids[i];
			const srcOff = srcOffsets[cid];
			if (srcOff === undefined) continue;
			this.changedTick[cid] = tick;
			const dstOff = this.colOffset[cid];
			const fc = srcFcounts[cid];
			for (let j = 0; j < fc; j++) {
				dstCols[dstOff + j].buf[dstRow] = srcCols[srcOff + j].buf[srcRow];
			}
		}
		if (this._tickBufs.length !== 0) this._copyTicksFrom(source, dstRow, srcRow);
	}

	/**
	 * Add an entity. Pushes zeroes into all columns and returns the assigned row.
	 * Store is responsible for tracking entityIndex → row.
	 */
	public addEntity(entityId: EntityID, entityRows?: Int32Array): number {
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();
		this.reserveRows(1);
		const tail = this.length;
		this._eids[tail] = entityId as number;
		this._zeroRow(tail);
		this.length++;
		return this._placeTail(tail, entityRows);
	}

	/**
	 * Remove entity at row via swap-and-pop. Swaps the last entity into the
	 * vacated row to keep data dense. Returns the entityIndex of the swapped
	 * entity (so Store can update its row), or NO_SWAP if no swap was needed.
	 */
	public swapRemoveRow(row: number): number {
		const lastRow = this.length - 1;
		let swappedEntityIndex = NO_SWAP;
		const eids = this._eids;

		if (row !== lastRow) {
			eids[row] = eids[lastRow];
			swappedEntityIndex = getEntityIndex(eids[row] as EntityID);
			this._moveRow(row, lastRow);
		}

		this.length--;
		// Keep the partition consistent for direct callers and tests: removing
		// an enabled row shrinks the enabled region. The Store uses `removeRow`
		// for the disabled-aware case. Here `row` is assumed enabled-or-last.
		if (row < this.enabledCount) this.enabledCount--;
		return swappedEntityIndex;
	}

	/** Tag-optimized add: skip column push entirely (no data to store). */
	public addEntityTag(entityId: EntityID, entityRows?: Int32Array): number {
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();
		this.reserveRows(1);
		const tail = this.length;
		this._eids[tail] = entityId as number;
		this.length++;
		return this._placeTail(tail, entityRows);
	}

	/**
	 * Bulk add `count` entities, zero-initialising all columns. Returns the
	 * starting dstRow for the batch. Caller is responsible for tracking
	 * entityIndex → row for every entity in the batch.
	 *
	 * Collapses the N×C per-element cost of N sequential `addEntity` calls into
	 * C `fill` calls, one for each column, the same pattern `bulkMoveAllFrom`
	 * uses for the move-with-data case.
	 */
	public addEntities(entityIds: Uint32Array, count: number = entityIds.length): number {
		if (count === 0) return this.length;
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();

		this.reserveRows(count);
		const startRow = this.length;
		this._eids.set(entityIds.subarray(0, count), startRow);
		const bufs = this.bufs;
		const end = startRow + count;
		for (let i = 0; i < bufs.length; i++) bufs[i].fill(0, startRow, end);
		const ticks = this._tickBufs;
		for (let i = 0; i < ticks.length; i++) ticks[i].fill(0, startRow, end);
		this.length += count;
		return this._placeTailBulk(startRow, count);
	}

	/** Tag-optimized bulk add: skip the per-column zero-fill entirely. */
	public addEntitiesTag(entityIds: Uint32Array, count: number = entityIds.length): number {
		if (count === 0) return this.length;
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();
		// Tag-only: no columns, but the entity-id array still has to fit, its
		// capacity is what `_rowCap` reduces to here.
		this.reserveRows(count);
		const startRow = this.length;
		this._eids.set(entityIds.subarray(0, count), startRow);
		this.length += count;
		return this._placeTailBulk(startRow, count);
	}

	// ===================================================================
	// Direct-spawn append paths. Write the template's default field
	// values straight into the columns as the row is appended, a single
	// pass, skipping the zero-fill-then-overwrite of `addEntity` +
	// `writeFields`. Backs `Store.spawn` and `Store.spawnMany`. The
	// "single-pass append" strategy was the fastest of the strategies that we
	// measured.
	// ===================================================================

	/** Append one entity, writing `flatBits[i]` straight into column `i` (in
	 * `flatColumns` order), no zero-fill-then-overwrite. Bumps every column's
	 * change tick once. Returns the assigned row. `flatBits` must come from
	 * `widthBits`: each entry is already the column's stored representation, so
	 * the write is a bit copy through the width-canonical plane, with no
	 * conversion and no call for each column type. A template resolves its
	 * defaults into bits one time, so every `spawn` from it takes this path. */
	public addEntityWithBits(
		entityId: EntityID,
		flatBits: Float64Array,
		tick: number,
		entityRows?: Int32Array
	): number {
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();
		this.reserveRows(1);
		const tail = this.length;
		this._eids[tail] = entityId as number;
		this._writeRowBits(tail, flatBits);
		this.length++;
		const ids = this.columnIds;
		for (let i = 0; i < ids.length; i++) this.changedTick[ids[i]] = tick;
		return this._placeTail(tail, entityRows);
	}

	/** Convert `flatValues` (in `flatColumns` order) to the stored bit
	 * pattern of each column, as the width-canonical view represents it
	 * (`toWidthBits`). The result is what `addEntityWithBits` writes. A
	 * `Float64Array`, so the append reads each entry with no hole test and no
	 * unboxing. Every bit pattern is an integer below 2^32 or an `f64`, and
	 * both are exact in it. */
	public widthBits(flatValues: number[]): Float64Array {
		const kind = this._colKind;
		const out = new Float64Array(flatValues.length);
		for (let i = 0; i < flatValues.length; i++) out[i] = toWidthBits(kind[i], flatValues[i]);
		return out;
	}

	/** Write one value into row `row` of flat column `idx`, converting as the
	 * column's type converts, through the access site of that type. The
	 * per-instance override path of `spawn`. */
	public writeFlatElem(idx: number, row: number, value: number): void {
		if (DEV) this._assertRowPlaneFresh("writeFlatElem");
		const k = this._colKind[idx];
		// Same `f64` fast path as `writeFields`.
		if (k === TAG_F64) (this.bufs[idx] as Float64Array)[row] = value;
		else writeElem(k, this.bufs[idx], row, value);
	}

	/** Bulk append `count` entities, filling column `i` with `flatValues[i]`
	 * in a single `TypedArray.fill` per column (no zero pass). Returns the
	 * starting row. */
	public addEntitiesWithValues(
		entityIds: Uint32Array,
		count: number,
		flatValues: number[],
		tick: number
	): number {
		if (count === 0) return this.length;
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();
		this.reserveRows(count);
		const startRow = this.length;
		this._eids.set(entityIds.subarray(0, count), startRow);
		const bufs = this.bufs;
		const end = startRow + count;
		for (let i = 0; i < bufs.length; i++) bufs[i].fill(flatValues[i], startRow, end);
		const ticks = this._tickBufs;
		for (let i = 0; i < ticks.length; i++) ticks[i].fill(0, startRow, end);
		this.length += count;
		const ids = this.columnIds;
		for (let i = 0; i < ids.length; i++) this.changedTick[ids[i]] = tick;
		return this._placeTailBulk(startRow, count);
	}

	/** Tag-optimized remove via swap-and-pop: skip column swap and pop entirely. */
	public swapRemoveRowTag(row: number): number {
		const lastRow = this.length - 1;
		let swappedEntityIndex = NO_SWAP;
		const eids = this._eids;

		if (row !== lastRow) {
			eids[row] = eids[lastRow];
			swappedEntityIndex = getEntityIndex(eids[row] as EntityID);
		}

		this.length--;
		if (row < this.enabledCount) this.enabledCount--;
		return swappedEntityIndex;
	}

	/**
	 * Move an entity from src archetype into this archetype in a single pass.
	 * Combines addEntity + copySharedFrom + swapRemoveRow(src).
	 * Uses a pre-computed transition map for branchless column copy.
	 * Writes dstRow to _moveResult[0], swapped entity index to _moveResult[1].
	 */
	public moveEntityFrom(
		src: Archetype,
		srcRow: number,
		entityId: EntityID,
		transitionMap: Int16Array,
		tick: number,
		entityRows: Int32Array
	): void {
		// Iteration guard before the dest append, throwing later (in
		// `src.removeRow`) would leave the entity present in both archetypes.
		if (DEV && src.iterDepth > 0) throw structuralMidWalkError("moveEntityFrom");
		// Preserve the entity's enabled and disabled state across the move:
		// read it from `src` Before removing the row. A disabled entity that gains
		// or loses an *unrelated* component stays disabled in the destination.
		const wasDisabled = srcRow >= src.enabledCount;
		// Destination is the empty archetype (a remove that drops the entity's
		// last component): keep it rowless. Detach from `src` (partition-aware) and
		// report `UNASSIGNED` so the entity lands in the single canonical
		// component-less form (matches `createEntity`). The caller writes that
		// into entityRows.
		if (!this.materializesRows) {
			src.removeRow(srcRow, entityRows);
			_moveResult[0] = UNASSIGNED;
			_moveResult[1] = NO_SWAP;
			return;
		}
		this.reserveRows(1);
		const tail = this.length;
		this._eids[tail] = entityId as number;

		// Single pass: copy from src, or write 0 for columns the source lacks.
		// A bit copy through the width-canonical plane, see `_copyRowFrom`.
		this._copyRowFrom(src, transitionMap, tail, srcRow);

		// Mark all components in this archetype as changed
		const ids = this.columnIds;
		for (let i = 0; i < ids.length; i++) {
			this.changedTick[ids[i]] = tick;
		}

		this.length++;

		// Place the appended row: a disabled entity stays in the disabled tail
		// with no `enabled_count` bump. An enabled one lands in the enabled
		// region, and `_placeTail` corrects past any disabled rows.
		const dstRow = wasDisabled ? tail : this._placeTail(tail, entityRows);

		// Remove the entity from the source (partition-aware, owns its own
		// entityRows updates).
		src.removeRow(srcRow, entityRows);

		_moveResult[0] = dstRow;
		_moveResult[1] = NO_SWAP;
	}

	/**
	 * Move an entity from src into this archetype (tag-only: no columns to copy).
	 * Writes dstRow to _moveResult[0]. _moveResult[1] is always NO_SWAP (the
	 * partition-aware src/dst updates are owned internally).
	 */
	public moveEntityFromTag(
		src: Archetype,
		srcRow: number,
		entityId: EntityID,
		entityRows: Int32Array
	): void {
		// Same pre-append iteration guard as `moveEntityFrom`.
		if (DEV && src.iterDepth > 0) throw structuralMidWalkError("moveEntityFrom");
		const wasDisabled = srcRow >= src.enabledCount;
		// Rowless empty-archetype destination, see `moveEntityFrom` above.
		if (!this.materializesRows) {
			src.removeRow(srcRow, entityRows);
			_moveResult[0] = UNASSIGNED;
			_moveResult[1] = NO_SWAP;
			return;
		}
		this.reserveRows(1);
		const tail = this.length;
		this._eids[tail] = entityId as number;
		this.length++;

		const dstRow = wasDisabled ? tail : this._placeTail(tail, entityRows);

		src.removeRow(srcRow, entityRows);

		_moveResult[0] = dstRow;
		_moveResult[1] = NO_SWAP;
	}

	/**
	 * Bulk-move all entities from src into this archetype using TypedArray.set().
	 * Much faster than per-entity moveEntityFrom when the entire source is moving.
	 * After this call, src is empty. Returns the starting dstRow for the batch.
	 */
	public bulkMoveAllFrom(src: Archetype, transitionMap: Int16Array, tick: number): number {
		const count = src.length;
		if (count === 0) return this.length;
		// The empty archetype never materialises rows, so a bulk move into it is
		// invalid, the caller (`Store.batchRemoveComponent`) must instead
		// unplace every entity (`UNASSIGNED`) and `src.clearRows()`.
		if (DEV && !this.materializesRows) throw emptyArchetypeRowError();

		this.reserveRows(count);
		const dstStart = this.length;
		const dstBufs = this.bufs;
		const srcBufs = src.bufs;

		// Bulk copy entity IDs
		this._eids.set(src._eids.subarray(0, count), dstStart);

		// Bulk copy columns using TypedArray.set() and fill()
		for (let i = 0; i < dstBufs.length; i++) {
			const si = transitionMap[i];
			if (si >= 0) {
				dstBufs[i].set(srcBufs[si].subarray(0, count) as never, dstStart);
			} else {
				dstBufs[i].fill(0, dstStart, dstStart + count);
			}
		}
		// The tick plane: a row's ticks move with the row, a new component gets 0.
		const tickCids = this._tickCids;
		for (let i = 0; i < tickCids.length; i++) {
			const st = src.rowTicks[tickCids[i]];
			const dt = this._tickBufs[i];
			if (st !== undefined) dt.set(st.subarray(0, count), dstStart);
			else dt.fill(0, dstStart, dstStart + count);
		}

		// Mark all components in this archetype as changed
		const ids = this.columnIds;
		for (let i = 0; i < ids.length; i++) {
			this.changedTick[ids[i]] = tick;
		}

		this.length += count;

		// Partition: the appended block is src's `[enabled | disabled]` rows
		// in order, so as long as the destination had no disabled rows of its own
		// (its enabled region ended exactly at `dstStart`), the merged enabled
		// region is `dstStart + src.enabled_count`. If the destination already had
		// disabled rows, the appended enabled rows would land *after* them, the
		// caller must fall back to per-entity moves in that (rare) case.
		if (DEV && this.enabledCount !== dstStart) throw bulkIntoDisabledError();
		this.enabledCount = dstStart + src.enabledCount;

		src.clearRows();

		return dstStart;
	}

	/**
	 * Drop every row at once, length → 0, entity-id list and all columns
	 * cleared, without copying into a destination. Used when an archetype's
	 * entire population leaves in one move: `bulkMoveAllFrom` clears the
	 * source this way, and `Store.batchRemoveComponent` calls it directly when
	 * the destination is the rowless empty archetype (batch-removing the last
	 * component), where there is nothing to copy into.
	 */
	public clearRows(): void {
		this.length = 0;
		this.enabledCount = 0;
		this._entityIds.clear();
		const cols = this.flatColumns;
		for (let i = 0; i < cols.length; i++) cols[i].clear();
	}

	/**
	 * Re-derive the host-side row bookkeeping after a snapshot is mounted onto a
	 * live world (`Store.restore`). A snapshot reloads the column bytes
	 * (dense SAB) but not the host-side `length`, `enabledCount` and `_entityIds`
	 * back-reference, those are reconstructed here. `refreshViews` must have
	 * already repointed the columns at the restored SAB.
	 *
	 * The caller scans the restored entity-index region to learn which entity
	 * occupies each row and passes them in row order (`rowEntityIds[r]` is the
	 * packed `EntityID` at row `r`. Rows `[0, length)` are dense, enabled rows
	 * first then disabled per the partition). `enabledCount` is the restored
	 * partition boundary. This is the inverse of the per-row `addEntity` and
	 * `disableRow` bookkeeping the live run accumulated.
	 */
	public restoreHostRows(rowEntityIds: readonly number[], enabledCount: number): void {
		const len = rowEntityIds.length;
		if (DEV && (enabledCount < 0 || enabledCount > len)) {
			throw new ECSError(
				ECS_ERROR.ARCHETYPE_ROW_INVARIANT,
				`Archetype ${this.id}: restore enabledCount ${enabledCount} out of range [0, ${len}]`
			);
		}
		this._entityIds.clear();
		this._entityIds.reserve(len);
		this._entityIds.setLength(len);
		// `reserve` may have reallocated, re-derive the row plane before
		// writing through it (columns were already repointed by `refreshViews`).
		this._syncRowPlane();
		const eids = this._eids;
		for (let r = 0; r < len; r++) eids[r] = rowEntityIds[r];
		// Re-sync each column's logical length with the restored row count. The
		// column bytes already live in the restored SAB (refreshViews repointed
		// the views), but a `BufferBackedColumn` tracks `_len` separately, and the
		// boundaries handed a bare column key off it: `refreshView`'s shrink check
		// and a reallocating `reserve`, either of which would otherwise see a
		// stale 0 and drop every restored row on the next grow. (`view()` keys off
		// it too, but has no production caller, don't count it as a reason.)
		const cols = this.flatColumns;
		for (let i = 0; i < cols.length; i++) cols[i].setLength(len);
		this.length = len;
		this.enabledCount = enabledCount;
	}

	public getEdge(componentId: ComponentID): ArchetypeEdge | undefined {
		return this._edges[componentId];
	}

	public setEdge(componentId: ComponentID, edge: ArchetypeEdge): void {
		this._edges[componentId] = edge;
	}

	/**
	 * Get the transition map from this archetype to `target`, building and caching
	 * it on miss. `Store.addComponents` and `Store.removeComponents` use it. The
	 * per-edge cache only covers single-component steps.
	 */
	public transitionMapTo(target: Archetype): Int16Array {
		const cached = this._batchTransitionMaps.get(target.id);
		if (cached !== undefined) return cached;
		const map = createTransitionMap(this, target);
		this._batchTransitionMaps.set(target.id, map);
		return map;
	}

	/** Look up a cached plural-add transition by its packed key. Returns
	 * `undefined` until the first composite add out of this archetype plants the
	 * lazy Map, the common case for archetypes that only ever see single adds. */
	public getCompositeAddEdge(key: number): CompositeAddEdge | undefined {
		return this._compositeAddEdges === null ? undefined : this._compositeAddEdges.get(key);
	}

	/** Cache a resolved plural-add transition (target + src→target map) under its
	 * packed key, allocating the backing Map on first use. */
	public cacheCompositeAddEdge(key: number, target: ArchetypeID, map: Int16Array): void {
		(this._compositeAddEdges ??= new Map()).set(key, { target, map });
	}
}

/** Reusable result buffer for move_entity_from/move_entity_from_tag. [dstRow, swapped_index] */
export const _moveResult: [number, number] = [0, NO_SWAP];

/**
 * Module flag: when set, every `Archetype.entityCount` reports `length`
 * (all rows) instead of `enabled_count`. `Query.forEach` sets it for the
 * duration of an `includeDisabled()` iteration so the SoA loop spans disabled
 * rows without the caller changing `for i < arch.entityCount`. Iteration is
 * single-threaded and synchronous, so a plain module variable with save and restore
 * is safe across nesting (an inner default `forEach` restores the outer state).
 * `nonEmptyArchs` and `count` read the `enabled_count` and `length` fields directly, so they
 * never depend on this flag. */
let iterAllRows = false;
export function _setIterAllRows(value: boolean): boolean {
	const prev = iterAllRows;
	iterAllRows = value;
	return prev;
}

/** Dev-only guard error: a row-materialising method was called on the empty
 * archetype, which must stay rowless (component-less entities are unplaced,
 * `entityRows === UNASSIGNED`). Signals a missing rowless-destination branch in
 * a `Store` mutation path. Compiled out of production builds. */
function emptyArchetypeRowError(): ECSError {
	return new ECSError(
		ECS_ERROR.EMPTY_ARCHETYPE_MATERIALIZE,
		"the empty archetype must not materialise rows: a component-less entity is unplaced (entity_row === UNASSIGNED). A Store mutation path is missing its rowless-destination branch."
	);
}

/** Dev-only guard error: an append into an archetype that already holds
 * disabled rows needs the `entityRows` map to repoint the displaced disabled
 * entity, but none was passed. Signals a Store append path that forgot to thread
 * `entityRows` through. Compiled out of production builds. */
/** Dev-only guard error: an immediate structural mutation targeted an archetype
 * that a live query walk is currently visiting. That mutation is a despawn, a
 * `removeComponent` or `addComponent` transition, a disable or an enable. The
 * swap-remove or the partition swap would relocate rows under the iterator,
 * silently skipping or repeating entities. Collect the entity ids during the
 * walk and mutate after
 * it (inside a system, use the deferred `ctx.commands`). Compiled out of
 * production builds. */
function structuralMidWalkError(op: string): ECSError {
	return new ECSError(
		ECS_ERROR.STRUCTURAL_DURING_ITERATION,
		`${op} hit an archetype a live query iteration is visiting, immediate structural mutation mid-walk relocates rows under the iterator (entities get skipped or visited twice). Collect ids during the walk and mutate after it; inside a system use the deferred ctx.commands.`
	);
}

function partitionNoEntityRowError(): ECSError {
	return new ECSError(
		ECS_ERROR.PARTITION_APPEND_NEEDS_ENTITY_ROW,
		"appending into a disabled-bearing archetype requires the entity_row map (to repoint the displaced disabled row). A Store append path is missing its entity_row argument."
	);
}

/** Dev-only guard error: a *bulk* append or move targeted an archetype that
 * already holds disabled rows. The bulk fast paths only maintain the partition
 * when the destination has no disabled rows. The caller must fall back to a
 * per-entity loop in that case. Compiled out of production builds. */
function bulkIntoDisabledError(): ECSError {
	return new ECSError(
		ECS_ERROR.PARTITION_BULK_INTO_DISABLED,
		"bulk append and move into a disabled-bearing archetype is unsupported, the caller must fall back to per-entity placement to keep the enabled prefix contiguous."
	);
}

/**
 * Build a transition map from src archetype to dst archetype.
 * For each column in dst, stores the index of the corresponding column in src,
 * or -1 if the column is new (no source).
 */
export function createTransitionMap(src: Archetype, dst: Archetype): Int16Array {
	const dstCols = dst.flatColumns;
	const map = new Int16Array(dstCols.length);

	const dstIds = dst.columnIds;
	const srcOffsets = src.colOffset;
	const dstOffsets = dst.colOffset;
	const dstFcounts = dst.fieldCount;

	for (let i = 0; i < dstIds.length; i++) {
		const cid = dstIds[i];
		const dstOff = dstOffsets[cid];
		const fc = dstFcounts[cid];
		const srcOff = srcOffsets[cid];

		if (srcOff !== undefined) {
			// Shared component: map each dst column to its src counterpart
			for (let j = 0; j < fc; j++) {
				map[dstOff + j] = srcOff + j;
			}
		} else {
			// New component: no source
			for (let j = 0; j < fc; j++) {
				map[dstOff + j] = -1;
			}
		}
	}

	return map;
}
