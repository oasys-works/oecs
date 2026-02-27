# Refs

Refs provide cached single-entity field access via prototype-backed getters and setters.

## Usage

```ts
const pos = ctx.ref(Pos, entity);
const vel = ctx.ref(Vel, entity);

pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

`ctx.ref(def, entity)` returns a `ComponentRef<F>` where each field is a readable/writable `number` property.

## When to Use

| Method | Best for | Relative speed |
|--------|----------|---------------|
| `for..of` query iteration | Batch iteration over many entities | Fastest |
| `ctx.ref()` | Repeated access to one entity's fields | 2x faster than get_field (scattered), 37-44x faster (repeated) |
| `ctx.get_field()` / `ctx.set_field()` | One-off field reads/writes | Simplest API |

Use `ref()` when you need to read or write multiple fields on a single entity. Use `for..of` over a query when iterating over all entities matching a component set.

## How It Works

Prototypes are cached per column group via a `WeakMap`. Creating a ref is just:

1. Look up (or build) the prototype for this column group
2. `Object.create(proto)` -- inherits getters/setters
3. Set `_columns` (raw typed array buffers) and `_row` on the instance

No closure allocation, no `defineProperty` loop per call. The prototype is built once and reused for all refs targeting the same component in the same archetype.

Each field on the prototype is a getter/setter pair that reads/writes directly into the typed array buffer:

```ts
get x() { return this._columns[col_idx][this._row]; }  // _columns[i] is a TypedArray (Float64Array, etc.)
set x(v) { this._columns[col_idx][this._row] = v; }
```

## Safety

Refs are safe inside systems because structural changes (add/remove component, destroy entity) are deferred until the phase flush. The entity cannot move archetypes while the ref is in use.

Do not hold refs across `ctx.flush()` calls -- the entity may have moved to a different archetype, invalidating the ref's column and row references.
