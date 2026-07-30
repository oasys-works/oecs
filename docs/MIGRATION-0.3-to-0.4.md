# Migration from oecs 0.3 to 0.4

Version 0.4 derives oecs again from the ECS of the upstream oasys engine. The full public surface
moved to the shape of that engine. So **each consumer meets breaking changes**. But those changes
group into a small number of mechanical rules:

1. **Names** — Each method, property, and field changed from `snake_case` to `camelCase` (§0), and
   a small number of verbs changed also.
2. **Construction of the world** — `WorldOptions` becomes `ECSOptions`, and `initial_capacity`
   becomes the `memory` surface (§1).
3. **Systems** — A `__DEV__` access checker now requires each system that touches component data to
   declare `reads` and `writes`, through the config form (§2).
4. **Iteration and column access** — Mutation is now the default, because the `_mut` suffix is
   gone. The high-frequency loop that mutates is `eachChunk` with `cols.mut` (§3).
5. **Events and resources** — The key factories changed their names, and the shape of an event
   schema changed (§4).
6. **Errors** — The vocabulary is still public. `is_ecs_error` became `isEcsError` (§5).

Types and handles stay **PascalCase** (`ECS`, `EntityID`, `SCHEDULE`, and your own `Pos` and
`Vel`). The SCREAMING_SNAKE constants (`SCHEDULE.UPDATE`, and others) did not change.

---

## 0. Names — from `snake_case` to `camelCase`

Each method, property, parameter, and field on the public surface is now `camelCase`. For most
calls it is a mechanical rename, one to one:

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

These renames are examples, and the list is not complete, because the rule applies to each name:

- `register_component` → `registerComponent`; `register_tag` → `registerTag`
- `create_entity` → `createEntity`
- `add_component(s)` → `addComponent(s)`; `remove_component(s)` → `removeComponent(s)`
- `has_component` → `hasComponent`; `is_alive` → `isAlive`
- `get_field` → `getField`; `set_field` → `setField`
- `register_system` → `registerSystem`; `add_systems` → `addSystems`; `remove_system` →
  `removeSystem`
- `register_event` → `registerEvent`; `register_signal` → `registerSignal`
- `register_resource` → `registerResource`; `set_resource` → `setResource`; `has_resource` →
  `hasResource`
- `world_tick` → `ecsTick` (on the system context)
- `entity_count` → `entityCount`; `entity_ids` → `entityIds`

The camelCase surface is the final state, and not a temporary condition. Version 0.4 shipped no
snake_case alias.

### The names that changed the *word*, and not only the case

| 0.3 | 0.4 | Notes |
| --- | --- | --- |
| `QueryBuilder.every(...)` | `QueryBuilder.with(...)` | the entry verb of the query builder |
| `query.not(...)` | `query.without(...)` | the term that removes |
| `query.any_of(...)` | `query.anyOf(...)` | the term for a minimum of one |
| `query.for_each(...)` | `query.forEach(...)` | read-only iteration of the archetypes |
| `arch.get_column(def, field)` | `arch.getColumnRead(def, field)` | a read-only column |
| `arch.get_column_mut(def, field, tick)` | *(internal)* — mutate with `query.eachChunk` and `cols.mut(def)` | see §3 |
| `ctx.ref(def, e)` *(was read-only)* | `ctx.refRead(def, e)` | a read-only ref |
| `ctx.ref_mut(def, e)` | `ctx.ref(def, e)` | the mutable ref is now the name with no suffix |
| `world.destroy_entity_deferred(id)` | `world.destroyEntity(id)` | still deferred to the flush at the end of the phase |
| `event_key(...)` / `signal_key(...)` | `eventKey(...)` / `signalKey(...)` | see §4 |
| `resource_key(...)` | `resourceKey(...)` | see §4 |
| `is_ecs_error(...)` | `isEcsError(...)` | still public — see §5 |

> **The meaning of the `ref` name changed.** In 0.3, `ctx.ref` gave a *read-only* ref, and
> `ctx.ref_mut` gave the writable one. In 0.4 the name with no suffix is the **mutable** default
> (`ctx.ref`), and the read-only variant carries an explicit suffix (`ctx.refRead`). So a 0.3
> read that you wrote as `ctx.ref(...)` must become `ctx.refRead(...)`, and a 0.3 write that you
> wrote as `ctx.ref_mut(...)` becomes `ctx.ref(...)`. The same rule, that the name with no suffix
> is mutable, applies to the columns of an archetype (`getColumn` compared to `getColumnRead`).

---

## 1. Construction of the world — `initial_capacity` is gone

`WorldOptions` is now `ECSOptions`. `fixed_timestep` is now `fixedTimestep`. `initial_capacity` is
removed, and the `memory` surface replaces it. If you give one of the old option keys, the
constructor **throws**. It fails safely, and it names `memory`.

```ts
// 0.3
const world = new ECS({ initial_capacity: 4096, fixed_timestep: 1 / 50 });

// 0.4
const world = new ECS({ fixedTimestep: 1 / 50 });                        // the heap default
const world = new ECS({ memory: { budget: { entities: 50_000 } } });      // size it by the expected entities
const world = new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });        // a byte limit
const world = new ECS({ memory: { columnCapacity: 4096 } });              // set the initial rows for each archetype
```

The default profile is a **pure-TS heap**: a plain resizable `ArrayBuffer`. So it needs no
`SharedArrayBuffer`, and no cross-origin isolation (COOP/COEP). To select the shared-memory profile,
for worker offload or a WASM compute backend, use `new ECS({ memory: { shared: {} } })` with the
`@oasys/oecs/shared` entry point. The `memory` field takes one of the arms `budget`, `maxBytes`,
`columnCapacity`, `shared`, `wasm`, or `allocator`. The package also exports `resolveECSMemory(...)`,
if you want to examine the result of an intention. Since 0.5.0 it imports from
`@oasys/oecs/internal`, and not from the package root.

---

## 2. A system that touches component data must declare `reads` and `writes`

**This is the change that is most likely to break a simple rename.** Version 0.4 adds a
development-mode access checker. It validates the component reads and writes of a system against a
declared access surface. The check runs under `__DEV__` alone, and the build tool **removes it from
a production build**. But in development it *throws* for each access that you did not declare.

Each path that the engine checks holds you to it: `cols.mut(def)` and `getColumnRead(def)` inside
iteration, the accessors for one entity (`ctx.ref`, `ctx.refRead`, `ctx.getField`, and
`ctx.setField`), and `ctx.resource` and `ctx.setResource`. A system that you register through the
bare `(ctx, dt)` form, or through the `(q, ctx, dt)` form with a query builder, declares **no**
access. So each component access inside it throws in development. **Move each system that reads
or writes ECS data to the config form**, and declare what it touches:

```ts
// 0.3 — the query-builder form, with no access declaration
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

// 0.4 — the config form: declare the access, capture the query, and iterate with eachChunk
const movers = world.query(Pos, Vel);
const move = world.registerSystem({
  reads: [Vel],
  writes: [Pos],            // a declared write also gives read access to the same component
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y }   = cols.mut(Pos);   // the full group; mut() sets the change tick one time
      const { vx, vy } = cols.read(Vel);  // a read-only group
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

- The `fn` of the config form is `(ctx, dt)`, and it does **not** receive the query. Capture the
  query one time at module scope (`const movers = world.query(...)`), and refer to it inside `fn`.
  The engine caches each query and keeps it current, so a handle that you captured stays correct as
  new archetypes appear.
- `reads` and `writes` are **necessary** on the config form. Empty arrays mean "this system touches
  nothing", explicitly. They do not mean "do not check". A write authorizes a read of the same
  component, so you rarely list a component in both.
- The bare `(ctx, dt)` form, and the `(q, ctx, dt)` form with a builder, still compile. They are
  correct for a system that touches no ECS data, which is pure connection code for the schedule.
  They are also correct if you depend on the removal of the check from a production build. But a
  system that touches a component and that you register in that way throws in development. Use the
  config form.
- A system with `exclusive: true` bypasses the checker completely, and it gets full access to the
  world. It is the alternative for a setup or teardown system that truly touches everything.

---

## 3. Column and ref access — mutable by default, and read-only by an explicit name

The name of the accessor now shows the ability to mutate. The `_mut` suffix is gone, and read-only
carries `Read`. The mutable accessors also handle the tick for you.

| 0.3 | 0.4 |
| --- | --- |
| `arch.get_column_mut(def, field, tick)` | `cols.mut(def).field` inside `query.eachChunk(...)` |
| `arch.get_column(def, field)` (a read) | `arch.getColumnRead(def, field)` (a read) |
| `ctx.ref_mut(def, e)` | `ctx.ref(def, e)` (mutable by default) |
| `ctx.ref(def, e)` (a read) | `ctx.refRead(def, e)` (a read) |

**There are two iteration verbs:**

- `query.forEach((arch) => …)` gives you a **read-only** `ArchetypeView`, which has only
  `getColumnRead`, `getColumnsRead`, `getOptionalColumnRead`, `entityIds`, and `entityCount`. The
  mutable `getColumn` is on the concrete archetype, but it is **not** on the view. So a `forEach`
  loop cannot write to a column directly. Use `forEach` for a system that only reads.
- `query.eachChunk((cols, count) => …)` is the iterator for each archetype that can mutate, and it
  is the recommended default for the high-frequency path of a system that writes. `cols.mut(def)`
  and `cols.read(def)` resolve each field column of one component at the same time, into a group
  that you can destructure (`const { x, y } = cols.mut(Pos)`). `mut` sets the change tick one time,
  and `read` does not. `count` is the limit of the enabled rows, which is `entityCount`.

If you prefer to write one entity at a time, and not one chunk at a time, `ctx.ref(def, e)` gives a
mutable ref and sets the change tick, so that `query.changed(...)` sees it.
`ctx.refRead(def, e)` is the read-only equivalent.

---

## 4. Events and resources — renamed factories, and a new shape for an event schema

The key factories changed their names: `event_key` → `eventKey`, `signal_key` → `signalKey`, and
`resource_key` → `resourceKey`. The **type parameter of an event schema also changed**, from a
tuple of field *names* to a record of field to value *type*. Because the type parameter now carries
the value type, a field with a brand, for example `EntityID`, keeps that brand through `emit` and
`read`.

```ts
// 0.3 — the schema is a tuple of field names
const Damage = event_key<readonly ["target", "amount"]>("Damage");
world.register_event(Damage, ["target", "amount"]);
world.emit(Damage, { target: e, amount: 5 });

// 0.4 — the schema is a record of field to value type; registerEvent still takes the list of names
const Damage = eventKey<{ target: EntityID; amount: number }>("Damage");
world.registerEvent(Damage, ["target", "amount"]);
world.emit(Damage, { target: e, amount: 5 });
```

A signal, which is an event with no payload, follows the same rename: `signal_key(name)` →
`signalKey(name)`, and `register_signal` → `registerSignal`.

The resources keep the key-to-value model of 0.3, with new names, plus a new `removeResource`
function:

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

## 5. Errors — still public, and `is_ecs_error` is now `isEcsError`

The error vocabulary of the ECS **is still part of the public surface**. Only the name of the guard
changed, from snake case to camel case. `ECSError` and the `ECS_ERROR` category enum keep their
names.

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

`ECSError` still extends `Error`, with `name === "ECSError"`, and it carries a typed `category`.
So both the guard and a test on the name or the category operate correctly. The separate
`SparseRestoreError` and `WorldRestoreError` classes, which the new sparse and snapshot restore
paths throw, are plain `Error` objects, and the package exports them beside the others.

---

## 6. Small changes to a signature

- **`removeComponents` takes an array, and not a variable number of arguments.**
  `world.remove_components(e, A, B)` → `world.removeComponents(e, [A, B])`. (`addComponents` already
  took an array of entries in 0.3, and it did not change apart from the rename.)
- **`batchAddComponent` and `batchRemoveComponent` take an `ArchetypeID`, and not an `Archetype`
  object.** This is important only if you drove a batch transition directly.
- **`SCHEDULE` did not change.** There are the same seven phases (`PRE_STARTUP`, `STARTUP`,
  `POST_STARTUP`, `FIXED_UPDATE`, `PRE_UPDATE`, `UPDATE`, and `POST_UPDATE`), and `startup()`,
  `update(dt)`, `flush()`, and `dispose()` keep their names and their behavior.

---

## 7. New, optional surface (you must migrate nothing)

These additions are optional. Your 0.3 code needs none of them, but they are the reason for the
increase of the major version. Use them as they help you:

- **Determinism** — `new ECS({ deterministic: true })`, and then `world.stateHash()`,
  `world.snapshot()`, and `world.restoreInto(bytes)`, with `snapshotSparse` and `restoreSparse`.
  The hash is independent of the storage type: a heap world and a shared world with the same
  history agree.
- **Observers** — `world.observe(def, { onAdd, onRemove, onSet, onDisable, onEnable })`, for a
  structure or for one entity.
- **Relations** — `registerRelation`, `addRelation`, and `removeRelation`. The reads are
  `targetOf`, `targetsOf`, and `sourcesOf`. The traversal helpers are `ancestorsOf`, `rootOf`, and
  `cascadeOf`. The presets are `ChildOf` and `IsA` (`registerChildOf` and `registerIsA`). The
  `(R, *)` and `(*, T)` wildcard queries are `withRelation`, `forEachRelatedTo`, and
  `ANY_RELATION`. There are also the hierarchy queries (`query.hierarchy(rel, depth)`), and the
  cleanup policies for a deleted target.
- **Sparse component storage** — `registerSparseComponent` and `registerSparseTag`, `addSparse` and
  `removeSparse`, and `query.withSparse(...)`. This is data outside the archetype. It uses no
  identity bit, and it causes no archetype transition.
- **Enable and disable for an entity** — `disable`, `enable`, and `isDisabled`. A disabled row is
  in a partition at the end of the archetype, and a default query skips it. Use
  `query.includeDisabled()` to include those rows.
- **Templates and bundles** — `world.template([...])` with `world.createEntity(template, overrides)`
  and `world.createEntities(template, count)`, for a create with no transition. Also
  `bundle(def, values)` with `world.spawnBundle(...)` and `ctx.commands.spawn(...)`.
- **System sets and run conditions** — `systemSet(...)` with `world.configureSet(set, { ... })`,
  plus `runIfResourceEq`, `runEveryNTicks`, and `runIfAnyMatch`, and a `RunCondition` that you
  write.
- **`ctx.commands`** — a facade in the style of the Bevy `Commands` type, for the *deferred*
  structural operations (`spawn`, `add`, `remove`, `despawn`, `disable`, and `enable`). It is
  clearly deferred, in contrast to the immediate `world.addComponent`.
- **A write path from the host into the ECS** — `installHostCommandSeam(world)` applies
  `HostCommand` values from outside the schedule, through one approved `exclusive` system. It
  supports record and replay (`HostCommandRecorder`, `replayCommandLog`, and
  `serializeCommandLog`), and a ring transport between threads (`HostCommandDispatcher`, which
  imports from `@oasys/oecs/internal` since 0.5.0).
- **A frame trace** — `world.setTrace(sink)` with `FrameTraceRecorder` gives a structured stream of
  the events in each frame. The `__DEV__` flag controls it.
- **A compute backend connection** — `world.attachBackend(backend)` runs the body of a system on a
  compiled backend, such as WASM, instead of its TypeScript closure.

### The new entry points

| Import | What |
| --- | --- |
| `@oasys/oecs` | the ECS (the default, a pure-TS heap) |
| `@oasys/oecs/shared` | the `SharedArrayBuffer` and WASM allocators (they need COOP/COEP) |
| `@oasys/oecs/primitives` | `BitSet`, `SparseSet`, `SparseMap`, the growable typed arrays, `BinaryHeap`, and `topologicalSort` |
| `@oasys/oecs/reactive` | the reactive kernel, which has no dependencies |
| `@oasys/oecs/reactive-sync` | the bridge from the ECS to the kernel (it publishes only the changed data, in O(changed)) |
| `@oasys/oecs/solid` | the SolidJS adapter (`solid-js` is an optional peer dependency) |
| `@oasys/oecs/editor` | undo, redo, and field handles above the host write path |

---

## A quick checklist

- [ ] Change each `snake_case` call to `camelCase` (§0).
- [ ] `every` → `with`, `not` → `without`, `any_of` → `anyOf`, and `for_each` → `forEach` (§0).
- [ ] Change `ctx.ref` (a read) → `ctx.refRead`, and `ctx.ref_mut` (a write) → `ctx.ref` (§0 and
      §3).
- [ ] `WorldOptions` → `ECSOptions`. Replace `initial_capacity` with an arm of `memory` (§1).
- [ ] Move each system that touches a component to the config form, with `reads` and `writes` (§2).
- [ ] Change each mutating `get_column_mut` loop to `eachChunk` with `cols.mut` (§3).
- [ ] `event_key`, `signal_key`, and `resource_key` → `eventKey`, `signalKey`, and `resourceKey`.
      Change each event schema to a record of field to type (§4).
- [ ] `is_ecs_error` → `isEcsError` (it is still public) (§5).
- [ ] `remove_components(e, A, B)` → `removeComponents(e, [A, B])` (§6).
