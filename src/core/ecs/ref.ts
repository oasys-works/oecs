/***
 * ComponentRef — Cached single-entity field accessor.
 *
 * A ComponentRef<S> provides typed get/set properties that read and write
 * directly into SoA column arrays. The archetype + row + column lookup is
 * performed once at creation; subsequent field access is a single
 * columns[colIdx][row] operation.
 *
 * Prototypes are cached per column group (WeakMap keyed by object identity),
 * so creating a ref is just Object.create(proto) + one `_row` write — no
 * defineProperty loop, no per-call buffer array, no closure allocation per call.
 *
 * Safe inside systems because structural changes are deferred — the entity
 * cannot move archetypes until the phase flush.
 *
 * Naming: `ctx.ref()` is the mutable default (bumps the component's change
 * tick); `ctx.refRead()` is the read-only variant to reach for when you are
 * not mutating. The read-only typing (`ReadonlyComponentRef`) is *advisory* —
 * see the note on that type below.
 *
 * Argument order is DEF-FIRST — `ref(Pos, e)`, not `ref(e, Pos)` — because a
 * ref is a single-entity member of the column-cursor family, the
 * outside-iteration analog of `cols.mut(Pos)` / `cols.read(Vel)` (query.ts).
 * It shares that family's mutable-default/`Read`-suffix split AND its def-first
 * order; it deliberately does NOT follow the entity-first `getField(e, def,
 * field)` reader family (a per-call reader vs a create-once, reused cursor).
 *
 * Usage (inside a system):
 *
 *   const pos = ctx.ref(Pos, entity);       // mutable (default) — bumps change tick
 *   const vel = ctx.refRead(Vel, entity);  // read-only — use when not mutating
 *   pos.x += vel.vx * dt;
 *   pos.y += vel.vy * dt;
 *
 ***/

import type { ComponentSchema } from "./component";
import type { ArchetypeColumnLayout } from "./archetype";
import type { AnyTypedArray, ColumnBacking } from "../../type_primitives";
import { ECS_ERROR, ECSError } from "./utils/error";

/** Maps component schema to scalar get/set properties: { x: number, y: number }. */
export type ComponentRef<S extends ComponentSchema> = {
	-readonly [K in keyof S]: number;
};

/**
 * Read-only view of a component reference. This is an **advisory** barrier,
 * not a runtime safety boundary: the `readonly` properties block field writes
 * at the type layer, but `createRef` installs working get/set on the shared
 * prototype for both `ref()` and `refRead()`, so a deliberate cast can
 * still write through (and would skip the change-tick bump `ref()` performs).
 * Treat it as "I promise I am only reading," enforced by the escape-hatch lint
 * (`bun run lint:escape-hatches`), not by the runtime.
 */
export type ReadonlyComponentRef<S extends ComponentSchema> = {
	readonly [K in keyof S]: number;
};

interface RefInternal {
	_row: number;
}

/** Minimal column group shape needed by createRef. */
export interface RefColumnGroup {
	readonly layout: ArchetypeColumnLayout;
	readonly columns: ColumnBacking<AnyTypedArray>[];
}

// Keyed by column group identity (same object ref = same component in same archetype).
// The prototype's getters/setters close over each (stable) column backing and read
// its live `col.buf[this._row]`, so creating a ref is a single Object.create(proto)
// + one `_row` write — no per-ref `bufs` array. The column object is stable for the
// archetype's lifetime (grow refreshes its view in place; see Archetype.grow), and
// `.buf` is a cheap field read, so reading live (vs snapshotting at creation) is
// both correct and grow-safe.
const refProtoCache = new WeakMap<RefColumnGroup, object>();

/**
 * Create a ComponentRef bound to a specific row in a column group.
 * The prototype is built once per column group and cached; subsequent
 * calls for the same group only allocate the lightweight ref object.
 */
export function createRef<S extends ComponentSchema>(
	group: RefColumnGroup,
	row: number
): ComponentRef<S> {
	let proto = refProtoCache.get(group);
	if (!proto) {
		proto = Object.create(null) as object;
		const { fieldNames } = group.layout;
		for (let i = 0; i < fieldNames.length; i++) {
			const col = group.columns[i];
			Object.defineProperty(proto, fieldNames[i], {
				get(this: RefInternal) {
					return col.buf[this._row];
				},
				set(this: RefInternal, v: number) {
					col.buf[this._row] = v;
				},
				enumerable: true,
				configurable: false
			});
		}
		refProtoCache.set(group, proto);
	}

	const ref: RefInternal = Object.create(proto);
	ref._row = row;
	return ref as unknown as ComponentRef<S>;
}

/***
 * ── Re-pointable cursor ─────────────────────────────────────────────────────
 *
 * The code makes one `ComponentRef` for each entity. That construction is the
 * largest part of the cost of a read of one field by id. Measured:
 * `Object.create(proto)`, with one row write and one field read, costs **much
 * more** than a move of an accessor that exists and a read of the same field.
 * Thus a sweep by id uses most of its time to make accessors, and then to
 * discard them.
 *
 * A cursor is the same accessor with the allocation lifted out of the loop:
 * created once per component, then repointed with `at(entity)`.
 *
 *   const p = ecs.cursor(Pos);
 *   for (let i = 0; i < ids.length; i++) {
 *     p.at(ids[i]);
 *     p.x += p.y;            // reads/writes entity ids[i]
 *   }
 *
 * Where a ref's prototype closes over ONE column group — fixing it to one
 * component in one archetype — a cursor must follow entities across archetypes,
 * so its accessors read through the archetype's row plane instead:
 * `_bufs[_off + ordinal][_row]`. `at()` writes those three fields and nothing
 * else, so repointing costs the same whether the component has one field or ten.
 *
 * That indirection also makes a cursor *safer* than a held ref rather than more
 * dangerous: it re-resolves (archetype, row) on every `at()`, so a structural
 * mutation between two `at()` calls cannot leave it reading another entity's row
 * — the failure mode `ECS.refRead`'s doc warns about. Only the window between one
 * `at()` and the field accesses that follow it must stay structurally quiet.
 *
 * Mutable by default (`cursor`) with an explicit read-only variant
 * (`cursorRead`), def-first, same as the rest of the cursor family — see the
 * naming note at the top of this file and in `core/ecs/index.ts`.
 ***/

/** The one member name a cursor adds, and therefore the one field name a
 * cursor-using component cannot have. Rejected loudly at cursor creation rather
 * than silently shadowed — see `createCursor`. */
const CURSOR_RESERVED = "at";

interface CursorInternal {
	/** The current archetype's row plane (`Archetype._bufs`), index-parallel with
	 * its `_flatColumns`. Re-read on every `at()`; safe to hold between `at()` and
	 * a field access because `_syncRowPlane` refills it in place. */
	_bufs: AnyTypedArray[];
	/** Where this component's columns start in `_bufs` for the current archetype. */
	_off: number;
	_row: number;
}

/** Mutable single-entity cursor: field get/set plus `at(entity)`. */
export type ComponentCursor<S extends ComponentSchema> = {
	-readonly [K in keyof S]: number;
} & CursorSeek;

/**
 * Read-only cursor. **Advisory**, exactly like `ReadonlyComponentRef`: the
 * prototype carries working setters for both variants, so a deliberate cast
 * can still write through — and would skip the change-tick bump the mutable
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
	 * reading fields off the cursor — that is the form the allocation-free path
	 * exists for.
	 */
	at(entity: import("./entity").EntityID): this;
}

/**
 * `at()` needs the archetype and row for an entity, and only the Store can
 * resolve those. Passing the whole Store into the cursor would hand it (and its
 * users) the mutation surface; this is the one operation it actually needs,
 * supplied as a closure by whoever creates the cursor.
 *
 * The binder also carries the mutable/read-only difference: `Store.cursorBinder`
 * closes over whether to stamp the change tick, so the variant is settled once
 * at creation instead of branched on per `at()`.
 */
export type CursorBinder = (cursor: CursorInternal, entity: unknown) => void;

// One prototype per component, keyed by the `fieldNames` array its meta owns, so
// every cursor for a component shares one shape and the accessor site stays
// monomorphic per component. Mutability is NOT part of the key: both variants
// carry the same working get/set (`ReadonlyComponentCursor` is a compile-time
// barrier only), and the tick stamp lives in the binder, not the prototype — so
// a mutable and a read-only cursor over one component share this object.
const cursorProtoCache = new WeakMap<readonly string[], object>();

/**
 * Build a cursor over `fieldNames`, bound by `bind`. The prototype (field
 * accessors by ordinal, plus `at`) is built once per component and cached; each
 * call allocates one small object, and then nothing per entity.
 */
export function createCursor<S extends ComponentSchema>(
	fieldNames: readonly string[],
	bind: CursorBinder
): ComponentCursor<S> {
	let proto = cursorProtoCache.get(fieldNames);
	if (proto === undefined) {
		proto = Object.create(null) as object;
		for (let i = 0; i < fieldNames.length; i++) {
			const name = fieldNames[i];
			if (name === CURSOR_RESERVED) {
				throw new ECSError(
					ECS_ERROR.FIELD_NOT_REGISTERED,
					`A component with a field named "${CURSOR_RESERVED}" cannot be read through a cursor — ` +
						`the name collides with the cursor's own \`${CURSOR_RESERVED}(entity)\` method. Rename the ` +
						`field, or read this component with getField / ref instead.`,
					{ field: name }
				);
			}
			// `ordinal` is captured per property, so a read is two index operations
			// off the cursor's own fields — no per-cursor closure over a column.
			const ordinal = i;
			Object.defineProperty(proto, name, {
				get(this: CursorInternal) {
					return this._bufs[this._off + ordinal][this._row];
				},
				set(this: CursorInternal, v: number) {
					this._bufs[this._off + ordinal][this._row] = v;
				},
				enumerable: true,
				configurable: false
			});
		}
		cursorProtoCache.set(fieldNames, proto);
	}

	const cursor = Object.create(proto) as CursorInternal & { at: unknown };
	// `at` lives on the instance rather than the shared prototype because it
	// closes over `bind`, which differs per cursor (mutable vs read-only, and one
	// Store per cursor). One closure per cursor, none per entity.
	cursor.at = function at(this: CursorInternal, entity: unknown) {
		bind(this, entity);
		return this;
	};
	// Pre-initialised so the object's shape is complete before the first `at()`:
	// adding these lazily would transition the map underneath the accessors.
	cursor._bufs = EMPTY_ROW_PLANE;
	cursor._off = 0;
	cursor._row = 0;
	return cursor as unknown as ComponentCursor<S>;
}

/** Placeholder row plane for a freshly created cursor, so `_bufs` holds an array
 * from the start and the object's shape does not change on the first `at()`.
 *
 * It is empty, so a field read before the first `at()` indexes `undefined` and
 * throws a `TypeError`. That is the correct result: an unpointed cursor names no
 * entity, and a throw at the read is clearer than a value from row 0 of an
 * arbitrary archetype. */
const EMPTY_ROW_PLANE: AnyTypedArray[] = [];
