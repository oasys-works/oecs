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

/** Maps component schema to scalar get/set properties: { x: number, y: number }. */
export type ComponentRef<S extends ComponentSchema> = {
	-readonly [K in keyof S]: number;
};

/**
 * Read-only view of a component reference. This is an **advisory** barrier,
 * not a runtime safety boundary: the `readonly` properties block field writes
 * at the type layer, but `createRef` installs working get/set on the shared
 * prototype for both `ref()` and `refRead()`, so a §10c-policed cast can
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
