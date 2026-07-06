# Migrating oecs 0.3 → 0.4

0.4 re-derives oecs from the upstream oasys engine ECS. The whole public surface moved to the
engine's shape, so **every consumer touches breaking changes** — but they cluster into a handful of
mechanical rules:

1. **Naming** — `snake_case` → `camelCase` on every method, property, and field (§0), plus a few
   renamed verbs.
2. **World construction** — `WorldOptions` → `ECSOptions`; `initial_capacity` → the `memory` surface (§1).
3. **Systems** — a `__DEV__` access checker now requires component-touching systems to declare
   `reads` / `writes` via the config form (§2).
4. **Iteration & column access** — mutation is the default (`_mut` suffix gone); the hot-path mutating
   loop is `eachChunk` + `cols.mut` (§3).
5. **Events / resources** — key factories renamed and the event schema shape changed (§4).
6. **Errors** — the vocabulary is still exported; `is_ecs_error` was renamed `isEcsError` (§5).

Types and handles stay **PascalCase** (`ECS`, `EntityID`, `SCHEDULE`, your own `Pos` / `Vel`), and
SCREAMING_SNAKE constants (`SCHEDULE.UPDATE`, …) are unchanged.

---

## 0. Naming — `snake_case` → `camelCase`

Every method, property, parameter, and field name on the public surface is now `camelCase`. For most
calls it is a mechanical 1:1 rename:

```ts
// 0.3
const Pos = world.register_component({ x: "f64", y: "f64" });
const e = world.create_entity();
world.add_component(e, Pos, { x: 0, y: 0 });
if (world.is_alive(e)) world.query(Pos).for_each((arch) => { /* ... */ });

// 0.4
const Pos = world.registerComponent({ x: "f64", y: "f64" });
const e = world.createEntity();
world.addComponent(e, Pos, { x: 0, y: 0 });
if (world.isAlive(e)) world.query(Pos).forEach((arch) => { /* ... */ });
```

Representative renames (not exhaustive — the rule is universal): `register_component` →
`registerComponent`, `register_tag` → `registerTag`, `create_entity` → `createEntity`,
`add_component(s)` → `addComponent(s)`, `remove_component(s)` → `removeComponent(s)`, `has_component`
→ `hasComponent`, `get_field` / `set_field` → `getField` / `setField`, `is_alive` → `isAlive`,
`register_system` → `registerSystem`, `add_systems` → `addSystems`, `remove_system` → `removeSystem`,
`register_event` → `registerEvent`, `register_signal` → `registerSignal`, `register_resource` →
`registerResource`, `set_resource` → `setResource`, `has_resource` → `hasResource`, `world_tick` →
`ecsTick` (on the system context), `entity_count` → `entityCount`, `entity_ids` → `entityIds`.

The camelCase surface is the invariant, not a transitional state — 0.4 shipped no snake_case
aliases.

### Names that changed the *word*, not just the casing

| 0.3 | 0.4 | Notes |
| --- | --- | --- |
| `QueryBuilder.every(...)` | `QueryBuilder.with(...)` | query-builder entry verb |
| `query.not(...)` | `query.without(...)` | exclude term |
| `query.any_of(...)` | `query.anyOf(...)` | at-least-one term |
| `query.for_each(...)` | `query.forEach(...)` | read-only archetype iteration |
| `arch.get_column(def, field)` | `arch.getColumnRead(def, field)` | read-only column |
| `arch.get_column_mut(def, field, tick)` | *(internal)* — mutate via `query.eachChunk` + `cols.mut(def)` | see §3 |
| `ctx.ref(def, e)` *(was read-only)* | `ctx.refRead(def, e)` | read-only ref |
| `ctx.ref_mut(def, e)` | `ctx.ref(def, e)` | mutable ref is now the unsuffixed default |
| `world.destroy_entity_deferred(id)` | `world.destroyEntity(id)` | still deferred to the phase flush |
| `event_key(...)` / `signal_key(...)` | `eventKey(...)` / `signalKey(...)` | see §4 |
| `resource_key(...)` | `resourceKey(...)` | see §4 |
| `is_ecs_error(...)` | `isEcsError(...)` | still exported — see §5 |

> **Mutability flipped on the `ref` name.** In 0.3, `ctx.ref` returned a *read-only* ref and
> `ctx.ref_mut` was the writable one. In 0.4 the unsuffixed name is the **mutable** default
> (`ctx.ref`), and the read-only variant carries an explicit suffix (`ctx.refRead`). A 0.3 read
> written as `ctx.ref(...)` must become `ctx.refRead(...)`; a 0.3 write written as `ctx.ref_mut(...)`
> becomes `ctx.ref(...)`. The same unsuffixed-is-mutable rule applies to archetype columns
> (`getColumn` vs `getColumnRead`).

---

## 1. World construction — `initial_capacity` is gone

`WorldOptions` is now `ECSOptions`, `fixed_timestep` is `fixedTimestep`, and `initial_capacity` was
removed in favour of a `memory` sizing surface. Passing the old option keys **throws** at
construction (fail-closed, pointing you at `memory`).

```ts
// 0.3
const world = new ECS({ initial_capacity: 4096, fixed_timestep: 1 / 50 });

// 0.4
const world = new ECS({ fixedTimestep: 1 / 50 });                        // heap default
const world = new ECS({ memory: { budget: { entities: 50_000 } } });      // size by expected entities
const world = new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });        // byte ceiling
const world = new ECS({ memory: { columnCapacity: 4096 } });              // pin initial rows/archetype
```

The default profile is **pure-TS heap** — a plain resizable `ArrayBuffer`, so no `SharedArrayBuffer`
and no cross-origin isolation (COOP/COEP). Opt into the shared-memory profile (worker offload / a WASM
compute backend) with `new ECS({ memory: { shared: {} } })` plus the `@oasys/oecs/shared` entry point.
The `memory` field is one of the `budget` / `maxBytes` / `columnCapacity` / `shared` / `wasm` /
`allocator` arms; `resolveECSMemory(...)` is exported if you want to inspect what an intent resolves to
(since 0.5.0 it imports from `@oasys/oecs/internal`, not the package root).

---

## 2. Systems that touch component data must declare `reads` / `writes`

**This is the change most likely to break a straight rename.** 0.4 adds a dev-mode access checker: a
system's component reads and writes are validated against a declared access surface. The check runs
only under `__DEV__` and is **tree-shaken out of production**, but in development it *throws* on any
undeclared access.

Every checked path enforces it — `cols.mut(def)` / `getColumnRead(def)` inside iteration, and the
per-entity `ctx.ref` / `ctx.refRead` / `ctx.getField` / `ctx.setField` accessors, plus
`ctx.resource` / `ctx.setResource`. Systems registered through the bare `(ctx, dt)` or the
`(q, ctx, dt)` + query-builder overloads declare **no** access, so any component access inside them
throws in dev. **Move any system that reads or writes ECS data to the config form** and declare what
it touches:

```ts
// 0.3 — query-builder form, no access declaration
const move = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
      const py = arch.get_column_mut(Pos, "y", ctx.world_tick);
      const vx = arch.get_column(Vel, "vx");
      const vy = arch.get_column(Vel, "vy");
      for (let i = 0; i < arch.entity_count; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    });
  },
  (qb) => qb.every(Pos, Vel),
);
world.add_systems(SCHEDULE.UPDATE, move);

// 0.4 — config form: declare access, capture the query, iterate with eachChunk
const movers = world.query(Pos, Vel);
const move = world.registerSystem({
  reads: [Vel],
  writes: [Pos],            // a declared write implies read of the same component
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y }   = cols.mut(Pos);   // whole group; stamps the change tick once, inside mut()
      const { vx, vy } = cols.read(Vel);  // read-only group
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});
world.addSystems(SCHEDULE.UPDATE, move);
```

Notes:

- The config-form `fn` is `(ctx, dt)` — it does **not** receive the query. Capture it once at module
  scope (`const movers = world.query(...)`) and reference it inside `fn`. Queries are cached and
  live-updated, so a captured handle stays correct as archetypes appear.
- `reads` / `writes` are **mandatory** on the config form (empty arrays are explicit "touches
  nothing", not "unchecked"). A write authorises reading the same component, so you rarely list a
  component in both.
- The bare `(ctx, dt)` and `(q, ctx, dt)` + builder overloads still compile and are fine for systems
  that touch no ECS data (pure scheduling glue), or if you rely on the check being production-stripped
  — but a component-touching system registered that way throws in dev. Prefer the config form.
- An `exclusive: true` system bypasses the checker entirely (full world access) — the escape hatch
  for setup/teardown systems that legitimately touch everything.

---

## 3. Column & ref access — mutation-default, explicit read-only

Mutability is now encoded in the accessor name (the `_mut` suffix is gone; read-only carries `Read`),
and the tick is handled for you inside the mutable accessors.

| 0.3 | 0.4 |
| --- | --- |
| `arch.get_column_mut(def, field, tick)` | `cols.mut(def).field` inside `query.eachChunk(...)` |
| `arch.get_column(def, field)` (read) | `arch.getColumnRead(def, field)` (read) |
| `ctx.ref_mut(def, e)` | `ctx.ref(def, e)` (mutable default) |
| `ctx.ref(def, e)` (read) | `ctx.refRead(def, e)` (read) |

**Two iteration verbs:**

- `query.forEach((arch) => …)` hands you a **read-only** `ArchetypeView` — only `getColumnRead`,
  `getColumnsRead`, `getOptionalColumnRead`, `entityIds`, `entityCount`. The mutable `getColumn`
  exists on the concrete archetype but is **not** on the view, so a `forEach` loop cannot write
  columns directly. Use `forEach` for read-only systems.
- `query.eachChunk((cols, count) => …)` is the mutable per-archetype iterator and the recommended
  hot-path default for mutating systems. `cols.mut(def)` / `cols.read(def)` resolve a whole
  component's field columns at once into a destructurable group (`const { x, y } = cols.mut(Pos)`);
  `mut` stamps the change tick once, `read` doesn't. `count` is the enabled-row bound (`entityCount`).

If you'd rather write per entity than per chunk, `ctx.ref(def, e)` returns a mutable ref and bumps the
change tick (so `query.changed(...)` sees it); `ctx.refRead(def, e)` is the read-only sibling.

---

## 4. Events & resources — renamed factories, new event schema shape

The key factories renamed (`event_key` → `eventKey`, `signal_key` → `signalKey`, `resource_key` →
`resourceKey`), and the **event schema type parameter changed** from a tuple of field *names* to a
record of field → value *type*. Carrying the value type means branded fields (e.g. `EntityID`)
round-trip their brand through `emit` / `read`.

```ts
// 0.3 — schema is a tuple of field names
const Damage = event_key<readonly ["target", "amount"]>("Damage");
world.register_event(Damage, ["target", "amount"]);
world.emit(Damage, { target: e, amount: 5 });

// 0.4 — schema is a field → value-type record; registerEvent still takes the field-name list
const Damage = eventKey<{ target: EntityID; amount: number }>("Damage");
world.registerEvent(Damage, ["target", "amount"]);
world.emit(Damage, { target: e, amount: 5 });
```

Signals (zero-payload events) follow the same rename: `signal_key(name)` → `signalKey(name)`,
`register_signal` → `registerSignal`.

Resources are the same key→value model as 0.3, just renamed — plus a new `removeResource`:

```ts
// 0.3
const Clock = resource_key<{ ms: number }>("clock");
world.register_resource(Clock, { ms: 0 });
const ms = world.resource(Clock).ms;
world.set_resource(Clock, { ms: 16 });

// 0.4
const Clock = resourceKey<{ ms: number }>("clock");
world.registerResource(Clock, { ms: 0 });
const ms = world.resource(Clock).ms;
world.setResource(Clock, { ms: 16 });
world.removeResource(Clock);   // new in 0.4
```

---

## 5. Errors — still exported, `is_ecs_error` renamed to `isEcsError`

The ECS error vocabulary **remains part of the public surface**. Only the guard's name changed
(snake → camel); `ECSError` and the `ECS_ERROR` category enum keep their names.

```ts
// 0.3
import { is_ecs_error, ECS_ERROR } from "@oasys/oecs";
try {
  world.add_component(e, Pos);
} catch (err) {
  if (is_ecs_error(err) && err.category === ECS_ERROR.STORE_CAP_EXCEEDED) { /* ... */ }
}

// 0.4
import { isEcsError, ECS_ERROR } from "@oasys/oecs";
try {
  world.addComponent(e, Pos);
} catch (err) {
  if (isEcsError(err) && err.category === ECS_ERROR.STORE_CAP_EXCEEDED) { /* ... */ }
}
```

`ECSError` still subclasses `Error` with `name === "ECSError"` and carries a typed `category`, so both
guard-based and name/category-based handling work. (The separate `SparseRestoreError` /
`WorldRestoreError` thrown by the new sparse/snapshot restore paths are plain `Error`s, exported
alongside.)

---

## 6. Small signature changes

- **`removeComponents` takes an array, not varargs.** `world.remove_components(e, A, B)` →
  `world.removeComponents(e, [A, B])`. (`addComponents` already took an entries array in 0.3 and is
  unchanged apart from the rename.)
- **`batchAddComponent` / `batchRemoveComponent` key on `ArchetypeID`, not an `Archetype` object.**
  Only relevant if you drove batch transitions directly.
- **`SCHEDULE` is unchanged** — the same seven phases (`PRE_STARTUP` → `STARTUP` → `POST_STARTUP`,
  `FIXED_UPDATE`, `PRE_UPDATE` → `UPDATE` → `POST_UPDATE`), and `startup()` / `update(dt)` / `flush()`
  / `dispose()` keep their names and semantics.

---

## 7. New, opt-in surface (no migration required)

These are additive — nothing in your 0.3 code needs them, but they're the reason for the major bump.
Adopt as useful:

- **Determinism** — `new ECS({ deterministic: true })`, then `world.stateHash()`,
  `world.snapshot()` / `world.restoreInto(bytes)` (and `snapshotSparse` / `restoreSparse`). The hash
  is backing-agnostic: a heap world and a shared world with identical history agree.
- **Observers** — `world.observe(def, { onAdd, onRemove, onSet, onDisable, onEnable })`, structural
  and per-entity.
- **Relations** — `registerRelation`, `addRelation` / `removeRelation`, `targetOf` / `targetsOf` /
  `sourcesOf`, `ancestorsOf` / `rootOf` / `cascadeOf`, `ChildOf` / `IsA` presets (`registerChildOf`
  / `registerIsA`), `(R, *)` / `(*, T)` wildcard queries (`withRelation`, `forEachRelatedTo`,
  `ANY_RELATION`), hierarchy queries (`query.hierarchy(rel, depth)`), and on-delete cleanup policies.
- **Sparse component storage** — `registerSparseComponent` / `registerSparseTag`, `addSparse` /
  `removeSparse`, `query.withSparse(...)`. Out-of-archetype data that doesn't consume an identity bit
  or cause archetype transitions.
- **Entity enable/disable** — `disable` / `enable` / `isDisabled`; disabled rows sit in a partitioned
  tail and are skipped by default queries (`query.includeDisabled()` to include them).
- **Templates & bundles** — `world.template([...])` + `world.createEntity(template, overrides)` /
  `world.createEntities(template, count)` for zero-transition spawns; `bundle(def, values)` +
  `world.spawnBundle(...)` and `ctx.commands.spawn(...)`.
- **System sets & run conditions** — `systemSet(...)` + `world.configureSet(set, { ... })`;
  `runIfResourceEq` / `runEveryNTicks` / `runIfAnyMatch` and custom `RunCondition`s.
- **`ctx.commands`** — a Bevy-`Commands`-style facade for the *deferred* structural ops
  (`spawn` / `add` / `remove` / `despawn` / `disable` / `enable`), unambiguously deferred vs the
  immediate `world.addComponent`.
- **Host → ECS write seam** — `installHostCommandSeam(world)`, `HostCommand`s applied off-schedule via
  a blessed `exclusive` system; plus record/replay (`HostCommandRecorder`, `replayCommandLog`,
  `serializeCommandLog`) and a cross-thread ring transport (`HostCommandDispatcher` — since
  0.5.0 imported from `@oasys/oecs/internal`).
- **Frame trace** — `world.setTrace(sink)` + `FrameTraceRecorder` for a structured per-frame event
  stream (`__DEV__`-gated).
- **Compute backend seam** — `world.attachBackend(backend)` to run a system's body on a compiled
  backend (WASM, …) instead of its TS closure.

### New entry points

| Import | What |
| --- | --- |
| `@oasys/oecs` | the ECS (default, pure-TS heap) |
| `@oasys/oecs/shared` | `SharedArrayBuffer` / WASM allocators (requires COOP/COEP) |
| `@oasys/oecs/primitives` | `BitSet`, `SparseSet`, `SparseMap`, growable typed arrays, `BinaryHeap`, `topologicalSort` |
| `@oasys/oecs/reactive` | zero-dependency reactive kernel |
| `@oasys/oecs/reactive-sync` | ECS → reactive bridge (publishes only dirty, O(changed)) |
| `@oasys/oecs/solid` | SolidJS adapter (`solid-js` optional peer dependency) |
| `@oasys/oecs/editor` | undo/redo + field-handle layer over the host write seam |

---

## Quick checklist

- [ ] Rename every `snake_case` call to `camelCase` (§0).
- [ ] `every` → `with`, `not` → `without`, `any_of` → `anyOf`, `for_each` → `forEach` (§0).
- [ ] Swap `ctx.ref` (read) → `ctx.refRead`, and `ctx.ref_mut` (write) → `ctx.ref` (§0/§3).
- [ ] `WorldOptions` → `ECSOptions`; replace `initial_capacity` with a `memory` arm (§1).
- [ ] Move component-touching systems to the config form with `reads` / `writes` (§2).
- [ ] Convert mutating `get_column_mut` loops to `eachChunk` + `cols.mut` (§3).
- [ ] `event_key`/`signal_key`/`resource_key` → `eventKey`/`signalKey`/`resourceKey`; retype event
      schemas as field→type records (§4).
- [ ] `is_ecs_error` → `isEcsError` (still exported) (§5).
- [ ] `remove_components(e, A, B)` → `removeComponents(e, [A, B])` (§6).
