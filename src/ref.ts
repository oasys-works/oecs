/***
 * ComponentRef — Cached single-entity field accessor.
 *
 * A ComponentRef<S> provides typed get/set properties that read and write
 * directly into SoA column arrays. The archetype + row + column lookup is
 * performed once at creation; subsequent field access is a single
 * columns[col_idx][row] operation.
 *
 * Prototypes are cached per column group (WeakMap keyed by object identity),
 * so creating a ref is just Object.create(proto) + 2 property writes —
 * no defineProperty loop, no closure allocation per call.
 *
 * Safe inside systems because structural changes are deferred — the entity
 * cannot move archetypes until the phase flush.
 *
 * Usage (inside a system):
 *
 *   const pos = ctx.ref(Pos, entity);
 *   const vel = ctx.ref(Vel, entity);
 *   pos.x += vel.vx * dt;
 *   pos.y += vel.vy * dt;
 *
 ***/

import type { ComponentSchema } from "./component";
import type { ArchetypeColumnLayout } from "./archetype";
import type { GrowableTypedArray, AnyTypedArray } from "type_primitives";

/** Maps component schema to scalar get/set properties: { x: number, y: number }. */
export type ComponentRef<S extends ComponentSchema> = {
  [K in keyof S]: number;
};

interface RefInternal {
  _columns: AnyTypedArray[];
  _row: number;
}

/** Minimal column group shape needed by create_ref. */
export interface RefColumnGroup {
  readonly layout: ArchetypeColumnLayout;
  readonly columns: GrowableTypedArray<AnyTypedArray>[];
}

// Keyed by column group identity (same object ref = same component in same archetype).
// The prototype has getters/setters that read this._columns[col_idx][this._row],
// so creating a ref is just Object.create(proto) + 2 property writes.
const ref_proto_cache = new WeakMap<RefColumnGroup, object>();

/**
 * Create a ComponentRef bound to a specific row in a column group.
 * The prototype is built once per column group and cached; subsequent
 * calls for the same group only allocate a lightweight object.
 */
export function create_ref<S extends ComponentSchema>(
  group: RefColumnGroup,
  row: number,
): ComponentRef<S> {
  let proto = ref_proto_cache.get(group);
  if (!proto) {
    proto = Object.create(null) as object;
    const { field_names } = group.layout;
    for (let i = 0; i < field_names.length; i++) {
      const col_idx = i;
      Object.defineProperty(proto, field_names[i], {
        get(this: RefInternal) { return this._columns[col_idx][this._row]; },
        set(this: RefInternal, v: number) { this._columns[col_idx][this._row] = v; },
        enumerable: true,
        configurable: false,
      });
    }
    ref_proto_cache.set(group, proto);
  }

  const ref: RefInternal = Object.create(proto);
  // Extract raw typed array buffers for direct access
  const bufs: AnyTypedArray[] = new Array(group.columns.length);
  for (let i = 0; i < group.columns.length; i++) bufs[i] = group.columns[i].buf;
  ref._columns = bufs;
  ref._row = row;
  return ref as unknown as ComponentRef<S>;
}
