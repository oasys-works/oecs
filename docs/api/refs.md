# Refs

A **ref** is a cached accessor for one entity's component — a small object whose properties get/set that entity's fields. Reach for it on **cold, per-entity paths** where the hot [`eachChunk`](./queries.md#eachchunk--mutable-hot-path) column loop doesn't fit: reacting to a single event, touching a specific entity by id, an occasional cross-entity write.

```ts
const pos = ctx.ref(Pos, entity);      // mutable
const vel = ctx.refRead(Vel, entity);  // read-only
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

## `ref` vs `refRead`

```ts
ref<S>(def: ComponentDef<S>, entityId: EntityID): ComponentRef<S>;          // mutable
refRead<S>(def: ComponentDef<S>, entityId: EntityID): ReadonlyComponentRef<S>;  // read-only

type ComponentRef<S>         = { -readonly [K in keyof S]: number };  // get + set
type ReadonlyComponentRef<S> = {  readonly [K in keyof S]: number };  // get only
```

`ctx.ref` returns a mutable ref; `ctx.refRead` a read-only one. Mutability is in the name — there is no `refMut`.

The accessor does its archetype + row + column lookup **once, at creation**; each subsequent field read or write is a single typed-array index. Creating a ref is cheap (one `Object.create` over a cached prototype), so per-entity work stays fast.

> [!IMPORTANT]
> **`ctx.ref` bumps the component's change tick eagerly, at creation** — before you write anything, and even if you never do. That marks the component changed on that archetype for this tick, which is what [`changed(def)`](./change-detection.md) queries key off. If you're only reading, use **`ctx.refRead`** — it does not bump the tick, so you avoid false change-detection *and* signal intent.

## Caveats

> [!WARNING]
> **A ref does not survive an archetype transition.** It's safe to hold across immediate reads/writes within a system because structural changes are deferred (the entity can't move archetypes until the phase flush). But once the entity gains or loses a component, its row moves — re-create the ref afterward. Refs *are* grow-safe: they read the live column backing, and a column that grows refreshes in place, so a held ref stays valid across a grow.

> [!WARNING]
> `ReadonlyComponentRef` is an **advisory compile-time barrier, not a runtime one** — its accessor shares a prototype with the mutable ref, so a cast can write through it. Worse, such a write skips the change-tick bump `ref()` performs, silently desyncing change detection. Treat `refRead` as genuinely read-only.

> [!NOTE]
> In dev, `ref` runs a write access-check (declare the component in `writes`), `refRead` a read check (declare in `reads`); both throw `ENTITY_NOT_ALIVE` on a dead handle.

## When to use what

| Situation | Use |
| --- | --- |
| Mutating many entities of one archetype, every frame | [`eachChunk`](./queries.md#eachchunk--mutable-hot-path) column loop |
| Reading many entities, every frame | [`forEach`](./queries.md#foreach--read-only) column loop |
| Touching one entity by id, or a cold path | `ctx.ref` / `ctx.refRead` |
| A single field, one entity, one shot | `ctx.getField` / `ctx.setField` |

## See also

- [change detection](./change-detection.md) — what "bumps the tick" means and how `changed()` uses it
- [queries](./queries.md) — the column-loop alternatives for hot paths
- [systems](./systems.md) — the full `ctx` surface
