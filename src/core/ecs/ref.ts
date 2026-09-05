/***
 * Accessors, a ref or a cursor gives typed get and set properties on one entity's
 * row, and each property reads or writes one SoA column directly.
 *
 * A **ref** (`ctx.ref(Pos, e)`) resolves the archetype and the row one time, at
 * creation, and each field access after that is one column read. It is the
 * single-entity accessor: made for one entity, used, and discarded. Safe inside
 * systems because structural changes are deferred, so the entity cannot move
 * archetypes until the phase flush.
 *
 * A **cursor** (`ecs.cursor(Pos)`) is the same accessor with the allocation
 * lifted out of the loop. It is made one time and then moved to an entity with
 * `at(entity)`. The code makes one ref for each entity, and that construction
 * is the largest part of the cost of a read of one field by id. A sweep by id
 * uses most of its time to make accessors and then to discard them. A cursor
 * removes that: `at()` writes two fields and nothing else, so it costs the same
 * whether the component has one field or ten.
 *
 *   const pos = ctx.ref(Pos, entity);       // mutable (default), bumps change tick
 *   const vel = ctx.refRead(Vel, entity);  // read-only, use when not mutating
 *   pos.x += vel.vx * dt
 *
 *   const p = ecs.cursor(Pos);
 *   for (let i = 0; i < ids.length; i++) {
 *     p.at(ids[i]);
 *     p.x += p.y;            // reads and writes entity ids[i]
 *   }
 *
 * A cursor re-resolves (archetype, row) on every `at()`, so a structural
 * mutation between two `at()` calls cannot leave it reading another entity's
 * row, the failure mode `ECS.refRead`'s doc warns about. Only the window
 * between one `at()` and the field accesses that follow it must stay
 * structurally quiet.
 *
 * Naming: `ref` / `cursor` are the mutable defaults (they bump the component's
 * change tick); `refRead` / `cursorRead` are the read-only variants. The
 * read-only typing is *advisory*, see the note on `ReadonlyComponentRef`.
 * Argument order is def-first, `ref(Pos, e)`, not `ref(e, Pos)`, because a
 * ref is a single-entity member of the column-cursor family, the
 * outside-iteration analog of `cols.mut(Pos)` / `cols.read(Vel)` (query.ts).
 *
 * ── One prototype for every accessor in the process ─────────────────────────
 *
 * An accessor reads its state from itself: which column group, and which row.
 * A ref used to get one prototype for each (archetype, component) group, and a
 * cursor one for each component. An engine gives an object a distinct shape
 * for each distinct prototype, so five components gave the getter's read of
 * `this` five shapes. V8 keeps one access site fast for at most four shapes.
 * At the fifth, every ref and every cursor in the process paid a large multiple
 * on each field access, in a world with only five components, and with every
 * column of one type. Measured, not inferred.
 *
 * So every ref and every cursor shares one prototype, `ACCESSOR_PROTO`, for the
 * whole process. Each distinct field name gets one global id and one accessor
 * on the prototype, at the first component registration that uses the name
 * (`internFieldName`). An accessor holds the row plus an array of columns indexed
 * by that global id. That array is `Archetype._accCols[cid]`, one array for
 * each component in each archetype. It holds the component's columns at the ids
 * of their names, and `NO_COLUMN` elsewhere. A field read is then two index
 * operations and the typed-array access, the same count as one prototype for
 * each component gave. The own state of an accessor is two fields with
 * reserved names, `__cols` and `__row`. Registration refuses both as field
 * names, so no field can collide with them. Every accessor in the process then
 * has one shape (a cursor has one more own field, `at`, so refs and cursors
 * give a site two shapes, which is still fast).
 *
 * The two names are written as literals at every hot site, and not through a
 * constant. A property key that comes from an imported binding is not a
 * constant to the optimizer: the bundle puts this file and the store in
 * different chunks, and a key read through the import cell makes every access
 * a generic keyed load, which costs several times a field load. A symbol has
 * the same problem, because a symbol can only be reached through a binding.
 * Measured, and it was the whole cost of a field read before this note.
 *
 * ── One accessor literal for each element kind ──────────────────────────────
 *
 * V8 shares one feedback vector between every closure made from the same
 * function literal. One getter literal would give every accessor in the
 * process one typed-array access site, and that site would see every column
 * type in the world. V8 keeps a site fast for at most four typed-array kinds
 * at the fifth, every accessor becomes slow. JavaScriptCore pays a smaller
 * cost from the second kind. So there is one literal for each kind, and the
 * first registration of a field name selects the literal by that field's type.
 * When a later component gives the same name a different type, the name's
 * accessor is replaced with one that dispatches on the column's class through
 * `readElemOf` / `writeElemOf` (row_kinds.ts), which hold one site for each
 * kind. That accessor costs one `switch` more, and only the names with mixed
 * types pay it. The eight bodies are copies with one type name changed, and
 * they must stay separate literals. row_kinds.ts applies the same rule to the
 * archetype's row loops.
 ***/

import type { ComponentSchema } from "./component";
import type { AnyTypedArray, TypedArrayTag } from "../../type_primitives";
import { ECS_ERROR, ECSError } from "./utils/error";
import { DEV } from "../../dev_flag";
import { INDEX_MASK } from "./entity";
import { readElemOf, writeElemOf } from "./row_kinds";

// A local copy: an imported binding is not a constant to the optimizer (see
// the note on the accessor state below), and the sparse cursor's `at` masks
// with it on every call.
const ENTITY_INDEX_MASK = INDEX_MASK;

/** Maps component schema to scalar get and set properties: { x: number, y: number }. */
export type ComponentRef<S extends ComponentSchema> = {
	-readonly [K in keyof S]: number;
};

/**
 * Read-only view of a component reference. This is an **advisory** barrier,
 * not a runtime safety boundary: the `readonly` properties block field writes
 * at the type layer, but the shared prototype installs working get and set for
 * both `ref()` and `refRead()`, so a deliberate cast can still write through
 * (and would skip the change-tick bump `ref()` performs). Treat it as "I
 * promise I am only reading". The typechecker holds the promise. Nothing else
 * does: no lint and no runtime check enforces it.
 */
export type ReadonlyComponentRef<S extends ComponentSchema> = {
	readonly [K in keyof S]: number;
};

/** Mutable single-entity cursor: field get and set plus `at(entity)`. */
export type ComponentCursor<S extends ComponentSchema> = {
	-readonly [K in keyof S]: number;
} & CursorSeek;

/**
 * Read-only cursor. **Advisory**, exactly like `ReadonlyComponentRef`: the
 * prototype carries working setters for both variants, so a deliberate cast
 * can still write through, and would skip the change-tick bump the mutable
 * variant performs.
 */
export type ReadonlyComponentCursor<S extends ComponentSchema> = {
	readonly [K in keyof S]: number;
} & CursorSeek;

export interface CursorSeek {
	/**
	 * Point this cursor at `entity`, resolving its archetype and row. Every
	 * subsequent field access reads or writes `entity` until the next `at()`.
	 *
	 * Returns the cursor, so a single-expression read stays one expression:
	 * `ecs.cursor(Pos).at(e).x`. In a loop, prefer calling it as a statement and
	 * reading fields off the cursor, that is the form the allocation-free path
	 * exists for.
	 */
	at(entity: import("./entity").EntityID): this;
}

/**
 * The columns an accessor reads: one component's columns in one archetype,
 * indexed by the global id of each field's name (`internFieldName`), with holes at
 * the ids of names the component does not have. The archetype owns one such
 * array for each component it holds (`Archetype._accCols`) and refills it in
 * place whenever a buffer moves (grow, refresh), so a held array stays current.
 */
export type AccessorColumns = AnyTypedArray[];

/** The own state of an accessor: two reserved names that registration
 * refuses as field names (`RESERVED_FIELD_NAMES`). Every accessor writes these
 * two in the same order, and thus has the same shape. Write them as literals
 * at a hot site. See the note at the top of the file. */
export interface Accessor {
	__cols: AccessorColumns;
	__row: number;
}

/** Field names a component cannot have, because an accessor owns them. `at`
 * is not here: it is the cursor's own method, and only a cursor over the
 * component rejects it, so a component with such a field keeps every other
 * path. */
export const RESERVED_FIELD_NAMES: readonly string[] = ["__cols", "__row"];

/**
 * `at()` needs the archetype and row for an entity, and only the Store can
 * resolve those. Passing the whole Store into the cursor would hand it (and its
 * users) the mutation surface. This is the one operation it actually needs,
 * supplied as a closure by whoever creates the cursor.
 *
 * The binder also carries the mutable and read-only difference: `Store.cursorBinder`
 * closes over whether to stamp the change tick, so the variant is settled once
 * at creation instead of branched on per `at()`.
 */
export type CursorBinder = (cursor: Accessor, entity: unknown) => void;

/** The DEV-only check a sparse cursor runs on `at()`: access, liveness and
 * membership (`Store.sparseCursorCheck`). Production code never calls it, so
 * the sparse `at` is one mask and one field write. */
export type SparseCursorCheck = (entity: unknown) => void;

// ── The process-wide field-name registry and prototype ────────────────────

const fieldNameIds = new Map<string, number>();
/** The type a name's accessor was installed for, or `null` once the name has
 * been registered with two different types and carries the mixed accessor. */
const fieldNameKinds = new Map<string, TypedArrayTag | null>();
const ACCESSOR_PROTO: object = Object.create(null);

/**
 * The global id of field name `name`. The first call for a name assigns the
 * id and installs the name's accessor on the shared prototype, with the
 * literal that `kind` selects. A later call with a different `kind` replaces
 * that accessor with the mixed one, one time. Every other call returns the id
 * and changes nothing.
 */
export function internFieldName(name: string, kind: TypedArrayTag): number {
	let id = fieldNameIds.get(name);
	if (id === undefined) {
		id = fieldNameIds.size;
		fieldNameIds.set(name, id);
		fieldNameKinds.set(name, kind);
		Object.defineProperty(ACCESSOR_PROTO, name, ACCESSORS[kind](id, name));
		return id;
	}
	const installed = fieldNameKinds.get(name);
	if (installed !== null && installed !== kind) {
		fieldNameKinds.set(name, null);
		Object.defineProperty(ACCESSOR_PROTO, name, mixedAccessor(id, name));
	}
	return id;
}

/** The global name id of each field of a component, in schema order. Made one
 * time at component registration. The archetype places the component's columns
 * at these ids in its accessor column arrays. */
export function fieldGids(
	fieldNames: readonly string[],
	fieldTypes: readonly TypedArrayTag[]
): Int32Array {
	const n = fieldNames.length;
	const ids = new Int32Array(n);
	for (let i = 0; i < n; i++) ids[i] = internFieldName(fieldNames[i], fieldTypes[i]);
	return ids;
}

/** The column at every id of a name the component does not have. An
 * `AccessorColumns` array is packed with it (no holes), so a column load in an
 * accessor never has to test for a hole. It is empty, so a read through it
 * gives `undefined` and a write is dropped: the same silence a wrong field
 * read had before, and DEV names the mistake through `checkedCol`. */
export const NO_COLUMN: AnyTypedArray = new Float64Array(0);

/** DEV-only: the column at `gid`, or a named error when the component has no
 * such field, or when the accessor is a cursor that no `at()` has pointed yet.
 * In production the raw array read stands in for it. */
function checkedCol(cols: AccessorColumns, gid: number, name: string): AnyTypedArray {
	if (cols === EMPTY_COLS) {
		throw new ECSError(
			ECS_ERROR.FIELD_NOT_REGISTERED,
			`Field "${name}" was read from a cursor before its first at(entity), point the cursor at an entity first`,
			{ field: name }
		);
	}
	const c = cols[gid];
	if (c === undefined || c === NO_COLUMN) {
		throw new ECSError(
			ECS_ERROR.FIELD_NOT_REGISTERED,
			`Field "${name}" is not a field of the component this accessor reads, check the schema passed to registerComponent`,
			{ field: name }
		);
	}
	return c;
}

type AccessorFactory = (gid: number, name: string) => PropertyDescriptor;

const ACCESSORS: Record<TypedArrayTag, AccessorFactory> = {
	f64: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Float64Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Float64Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	f32: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Float32Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Float32Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	i32: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Int32Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Int32Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	u32: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Uint32Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Uint32Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	i16: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Int16Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Int16Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	u16: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Uint16Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Uint16Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	i8: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Int8Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Int8Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	}),
	u8: (gid, name) => ({
		get(this: Accessor) {
			const cols = this.__cols;
			return ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Uint8Array)[this.__row];
		},
		set(this: Accessor, v: number) {
			const cols = this.__cols;
			((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Uint8Array)[this.__row] = v;
		},
		enumerable: true,
		configurable: true
	})
};

/** The accessor for a name that two components give different types. It
 * dispatches on the column's class through the kind-split element sites, so
 * no typed-array site here sees more than one kind. */
const mixedAccessor: AccessorFactory = (gid, name) => ({
	get(this: Accessor) {
		const cols = this.__cols;
		return readElemOf(DEV ? checkedCol(cols, gid, name) : cols[gid], this.__row);
	},
	set(this: Accessor, v: number) {
		const cols = this.__cols;
		writeElemOf(DEV ? checkedCol(cols, gid, name) : cols[gid], this.__row, v);
	},
	enumerable: true,
	configurable: true
});

// ── Construction ──────────────────────────────────────────────────────────

/**
 * Create a ref bound to `row` of `cols`: one `Object.create` on the shared
 * prototype and two field writes. Nothing else is allocated for each ref.
 */
export function createRef<S extends ComponentSchema>(
	cols: AccessorColumns,
	row: number
): ComponentRef<S> {
	const ref = Object.create(ACCESSOR_PROTO) as Accessor;
	ref.__cols = cols;
	ref.__row = row;
	return ref as unknown as ComponentRef<S>;
}

/** The one member name a cursor adds, and therefore the one field name a
 * cursor-using component cannot have. Rejected loudly at cursor creation rather
 * than silently shadowed, see `createCursor`. */
const CURSOR_RESERVED = "at";

/** Placeholder columns for a freshly created cursor, so the field holds an
 * array from the start and the object's shape does not change on the first
 * `at()`. It has no columns, so a field read before the first `at()` throws:
 * a named error under DEV (`checkedCol`), a `TypeError` from the `undefined`
 * column in production. That is the correct result: an unpointed cursor names
 * no entity, and a throw at the read is clearer than a value from row 0 of an
 * arbitrary archetype. */
const EMPTY_COLS: AccessorColumns = [];

/**
 * Settle the shape of the accessors before any code compiles against it.
 *
 * Every ref and cursor has the same two own fields, and V8 tracks, for each
 * field of a shape, whether any object of that shape has ever reassigned it.
 * A dense cursor reassigns `__cols` on every `at()`. A ref and a sparse cursor
 * never do. So the first dense `at()` in a process changes the field from
 * constant to mutable, and every optimized function that read `__cols` under
 * the constant assumption is thrown away and compiled again. When this was
 * written, the code compiled after that change ran a sparse cursor far slower,
 * and which kind of cursor ran first decided the speed of the other.
 *
 * Reassigning both fields on one throwaway object of each shape, here, makes
 * them mutable from the start. Nothing then compiles under the constant
 * assumption, and nothing is thrown away. The cost is two small objects at
 * module load.
 *
 * The correction, from a later run: the effect no longer reproduces. A sparse
 * cursor measures the same with and without this call, on both V8 runtimes and
 * on JavaScriptCore, whether or not a dense cursor ran first. Constness
 * tracking is the engine's private business and it changes between versions.
 * The call stays because two objects at module load cost nothing and the
 * mechanism can come back. Do not read the paragraph above as a live
 * measurement.
 */
function primeAccessorShapes(): void {
	const other: AccessorColumns = [];
	const ref = Object.create(ACCESSOR_PROTO) as Accessor;
	ref.__cols = EMPTY_COLS;
	ref.__row = 0;
	ref.__cols = other;
	ref.__row = 1;
	const cursor = Object.create(ACCESSOR_PROTO) as Accessor;
	cursor.__cols = EMPTY_COLS;
	cursor.__row = 0;
	Object.defineProperty(cursor, CURSOR_RESERVED, {
		value: function at() {},
		writable: false,
		enumerable: false,
		configurable: false
	});
	cursor.__cols = other;
	cursor.__row = 1;
}

primeAccessorShapes();

/**
 * Build a cursor over a component whose fields are `fieldNames`, bound by
 * `bind`. One small object, and then nothing per entity. `at` is an own data
 * property defined directly, and not assigned, so that an accessor named `at`
 * on the shared prototype (a field of some other component) cannot intercept
 * the write. `cols` is the column array the cursor starts on: a dense cursor
 * starts on `EMPTY_COLS` and its binder writes the archetype's array on each
 * `at()`. A sparse cursor starts on its store's array, which never changes
 * identity, so its binder writes the row alone.
 */
export function createCursor<S extends ComponentSchema>(
	fieldNames: readonly string[],
	bind: CursorBinder,
	cols: AccessorColumns = EMPTY_COLS
): ComponentCursor<S> {
	for (let i = 0; i < fieldNames.length; i++) {
		if (fieldNames[i] === CURSOR_RESERVED) {
			throw new ECSError(
				ECS_ERROR.FIELD_NOT_REGISTERED,
				`A component with a field named "${CURSOR_RESERVED}" cannot be read through a cursor, ` +
					`the name collides with the cursor's own \`${CURSOR_RESERVED}(entity)\` method. Rename the ` +
					`field, or read this component with getField / ref instead.`,
				{ field: fieldNames[i] }
			);
		}
	}
	const cursor = Object.create(ACCESSOR_PROTO) as Accessor;
	cursor.__cols = cols;
	cursor.__row = 0;
	// `at` closes over `bind`, which differs per cursor (mutable vs read-only,
	// and one Store per cursor). One closure per cursor, none per entity.
	Object.defineProperty(cursor, CURSOR_RESERVED, {
		value: function at(this: Accessor, entity: unknown) {
			bind(this, entity);
			return this;
		},
		writable: false,
		enumerable: false,
		configurable: false
	});
	return cursor as unknown as ComponentCursor<S>;
}

/** What a mutable sparse cursor stamps on each `at()`: the sparse store's
 * row ticks, `null` until the component tracks them, and its component-level
 * change tick. The store object itself, seen through this shape. */
export interface SparseTickPlane {
	ticks: Uint32Array | null;
	changedTick: number;
}

/** Where the stamp's value comes from: the store's change tick. */
export interface ChangeClock {
	readonly changeTick: number;
}

/**
 * Build a cursor over a sparse component. The columns are id-indexed, so
 * `at()` is one mask and one field write, and the column array is the store's
 * own, given at creation and never replaced (the store refills it in place).
 *
 * This is a separate function with its own `at` literal, and not
 * `createCursor` with a different binder, on purpose. A dense cursor's `at`
 * calls its binder through one call site, and that site inlines the binder as
 * long as it sees one function. A sparse binder is a different function, so a
 * world with both kinds of cursor would make that site megamorphic and cost
 * both kinds a call on every `at()`. Separate literals keep separate sites,
 * one for each kind. Measured.
 *
 * A mutable cursor (`plane` given) also records the entity for the row grain
 * of change detection, on each `at()`, as the dense cursor does: one load and
 * one branch while the component keeps no row ticks, two stores once it does.
 * The read-only cursor keeps the bare literal.
 */
export function createSparseCursor<S extends ComponentSchema>(
	fieldNames: readonly string[],
	cols: AccessorColumns,
	check: SparseCursorCheck,
	plane: SparseTickPlane | null = null,
	clock: ChangeClock | null = null
): ComponentCursor<S> {
	for (let i = 0; i < fieldNames.length; i++) {
		if (fieldNames[i] === CURSOR_RESERVED) {
			throw new ECSError(
				ECS_ERROR.FIELD_NOT_REGISTERED,
				`A component with a field named "${CURSOR_RESERVED}" cannot be read through a cursor, ` +
					`the name collides with the cursor's own \`${CURSOR_RESERVED}(entity)\` method. Rename the ` +
					`field, or read this component with getSparseField instead.`,
				{ field: fieldNames[i] }
			);
		}
	}
	const cursor = Object.create(ACCESSOR_PROTO) as Accessor;
	cursor.__cols = cols;
	cursor.__row = 0;
	const at =
		plane === null
			? function at(this: Accessor, entity: unknown) {
					if (DEV) check(entity);
					this.__row = (entity as number) & ENTITY_INDEX_MASK;
					return this;
				}
			: function at(this: Accessor, entity: unknown) {
					if (DEV) check(entity);
					const index = (entity as number) & ENTITY_INDEX_MASK;
					this.__row = index;
					const t = plane.ticks;
					if (t !== null) {
						const now = clock!.changeTick;
						t[index] = now;
						plane.changedTick = now;
					}
					return this;
				};
	Object.defineProperty(cursor, CURSOR_RESERVED, {
		value: at,
		writable: false,
		enumerable: false,
		configurable: false
	});
	return cursor as unknown as ComponentCursor<S>;
}
