# Migration from oecs 0.5 to 0.6

Version 0.6 makes every name state the act it performs, and it fixes the change tick so that one
write is reported one time. There is **no alias for an old name**. The compiler finds every rename,
because each old name is gone.

Most of the work is mechanical. Four changes are not, and you must read them: the plugin
install, the removed reactive subpaths, the change tick, and the two reserved field names.

1. **Relations, events, snapshots and observers are plugins the world installs**. Build the
   world with `ECS.create({ plugins: [relations(), events()] })`, and name the ones it uses.
   `new ECS()` still builds a world, and that world holds none of the four.
2. **The change tick reports a write one time**. `changed()` used to report a write on two
   frames when the writer ran before the reader, which is the usual order. It no longer does. A
   system that both writes a component and reads `changed()` on it no longer sees its own stamp on
   its next run.
3. **`__cols` and `__row` are reserved field names**. Registration of a component with either
   name now throws.
4. **The renames on the public surface**. One table, applied by search and replace.
5. **The fields another module reads lost the underscore**. These were never in the documented
   API, so most callers see nothing.
6. **A sparse component stores a typed value**. A field declared `i32` now truncates, where it
   used to keep the number you gave.
7. **`for..in` over a ref no longer lists a component's fields**.
8. **`memory` is two fields, and not one union**.
9. **The signals kernel, its bridge and the kernel-to-Solid adapter are gone**. The `solid()`
   plugin is the one path into a UI.

Everything else did not change. That includes the component operations, the query verbs, the
schedule, the resources, the determinism surface, and the snapshot format. The observer, the
relation and the event call sites are the same. Only the construction of the world moves.

---

## The change tick reports a write one time

`changed()` compared a per-frame tick against the last run of the reader. A frame tick cannot order
two systems inside one frame, so a write by an earlier system was reported on that frame and again
on the next.

The engine now keeps a change tick apart from the frame tick. It advances before each system run,
before each phase flush, before the `onSet` dispatch, and at the end of each update. A consumer
reports a stamp above its own last run.

What to expect:

- A `changed(C)` reader that runs after the writer fires one time, not two. If your code counted on
  the second frame, remove the counter.
- A system that writes `C` **and** reads `changed(C)` used to fire on every frame, because it saw
  its own stamp. It now fires for the writes of other systems, and for its own inside the run that
  made them.
- A host write between two `update()` calls now reaches an archetype-level `onSet`. It did not
  before.
- `ctx.ecsTick` still counts frames. It did not change.

`ecs.getCurrentTick()` is `ecs.getChangeTick()`. On `Schedule`, `runStartup`, `runUpdate` and
`runFixedUpdate` no longer take a tick argument.

## `__cols` and `__row` are reserved field names

A ref and a cursor keep their state in two own fields with those names. `registerComponent` and
`registerSparseComponent` reject either name with `FIELD_NOT_REGISTERED`. Rename the field.

```ts
ecs.registerComponent({ __row: "i32" }); // throws in 0.6
ecs.registerComponent({ row: "i32" });   // fine
```

`at` is unchanged: it is still rejected at the creation of a cursor over the component, and not at
registration.

## The renames on the public surface

| 0.5 | 0.6 |
| --- | --- |
| `query.eachChunk(cb)` | `query.forEachChunk(cb)` |
| `query.forEachUntil(cb)` | `query.some(cb)` |
| `ctx.read(key)` | `ctx.readEvents(key)` |
| `ecs.getCurrentTick()` | `ecs.getChangeTick()` |
| `ecs.onStoreLayoutPublished(fn)` | `ecs.subscribeLayout(fn)` |
| `ecs.publishArchetypeRowCounts()` | `ecs.publishRowCounts()` |
| `queue.pending` | `queue.pendingCount` |
| `FrameTraceSink.systemStart` | `FrameTraceSink.systemBegin` |
| `column.get(i)`, on `/primitives` | `column.getAt(i)` |
| `column.ensureCapacity(n)`, on `/primitives` | `column.reserve(n)` |

Why each one moved:

- `ctx.read` collided with `cols.read(def)` in the same walk, where one verb returned a column
  group and the other an event reader.
- `forEachUntil` returns whether a callback accepted, so it is a predicate and now reads as one.
- `reserve` is the contract of `ColumnBacking`: guarantee room for the count, or throw. A heap
  column grows to keep it. A buffer-backed column cannot grow, so it throws.

On `@oasys/oecs/internal`, every `accessCheck.check*` method is `assert*`, and
`dispatchTrace.recordEmit` and `recordRead` are `recordEventEmit` and `recordEventRead`.

Three rules now hold across the package. One verb throws on a bad state, `assert`, and `validate`
keeps only the helpers that return the value they test. One verb constructs, `create`. The
underscore prefix marks a private or a protected class member and nothing else.

## The fields another module reads lost the underscore

None of these is in the documented API. Each is public because another module reads it, so the
prefix claimed a privacy the member never had.

| 0.5 | 0.6 |
| --- | --- |
| `query._defs` | `query.defs` |
| `query._include` | `query.include` |
| `query._id` | `query.id` |
| `query._sparseInclude`, `query._sparseExclude` | `query.sparseIncludes`, `query.sparseExcludes` |
| `query._optional` | `query.optionalTerms` |
| `query._includeDisabled` | `query.includesDisabled` |
| `query._relationIncludes`, `query._relationExcludes` | `query.relationIncludes`, `query.relationExcludes` |
| `query._hierarchy` | `query.hierarchyTerm` |
| `cols._arch`, `cols._tick`, on `ChunkColumns` | `cols.arch`, `cols.tick` |
| `ecs._caches` | `ecs.caches` |
| `bitset._words`, on `/primitives` | `bitset.words` |

Three could not drop the prefix alone, because `Query` already carries an `optional`, an
`includeDisabled` and a `hierarchy` method. Each of those three now names the thing it holds: a
term list, a flag, a term.

## A sparse component stores a typed value

A sparse component kept each entity's values in a plain array, so a value was stored as the number
you gave. Each field is now one typed array of the declared type, indexed by entity index. A value
converts as the field's type converts, exactly as a dense field does.

```ts
const Hp = ecs.registerSparseComponent({ v: "i32" });
ecs.addSparse(e, Hp, { v: 3.7 });
ecs.getSparseField(e, Hp, "v"); // 0.5 gave 3.7, 0.6 gives 3
```

Declare `f64` if you want the old behaviour for a field.

Two more consequences:

- The columns double to fit the highest member index, so the memory of one store is proportional to
  that index and not to the member count.
- `store.indices` is a typed view with a fixed length, and not an array. A later add or remove is
  not visible through a view you kept.

The snapshot format did not change.

## `for..in` over a ref no longer lists a component's fields

Every ref and every cursor now shares one prototype for the whole process, which carries the field
name of every component registered in the process. `for..in` reports all of them, plus the two
reserved names. `Object.keys` and the spread report the two reserved names alone.

Read the schema instead. It is the value you passed to `registerComponent`, and it is the only
source that names one component's fields.

A field the component does not have throws `FIELD_NOT_REGISTERED` under `DEV`, where it used to
read a neighbouring column.

## `memory` is two fields, and not one union

`ECSOptions.memory` held two questions that do not depend on each other, how big the world is and
what holds its bytes, inside one key-discriminated union, so a caller could answer only one.

```ts
new ECS({ memory: { entities: 50_000 } });                     // size only
new ECS({ memory: { backing: "shared" } });                    // storage only
new ECS({ memory: { entities: 50_000, backing: "shared" } });  // both, a type error before
new ECS({ memory: { entities: 50_000, maxBytes: 64 * MiB } }); // size from one, ceiling from the other
```

The `budget` key is `entities`, and the arm names for the backing are the `backing` field. The
shared backing is the string `"shared"`. `ResolvedECSMemory.source` names the backing alone, and
the new field `sizing` names the size axis.

---

## A module that reads the layout adds the store base

`SIM_ABI_VERSION` is 1. A module that read a version 0 store took every offset it found as a buffer
address. In a version 1 store every offset in the header, in the column descriptors, in the region
table and in the rings is measured from the store header, and the header sits at `memory.storeBase`.
A wasm-backed world defaults that base to one page and refuses zero. Read a column at
`storeBase + byte_off`, and take the base from `setLayout(storeBase)`. `storeBaseAbove(exports,
extraBytes)` derives a base above a module's `__heap_base`.

The archetype descriptor header is 40 bytes. It ends with `entity_ids_off`, which is reserved and
holds zero. A walker steps to the next record by `40 + column_count * 16`.

`ComputeBackend.run(handle, dt, tick)` replaces `run(handle)`. A backend that still declares
`run(handle)` keeps compiling and keeps running. The schedule publishes the descriptor row counts
before every backend dispatch. A host that drives a module outside the schedule calls
`ecs.publishRowCounts()` first.

A snapshot the 0.5 line wrote still restores. Every version 0 store sat at byte 0, so its offsets
read correctly as offsets from the header, and restore rewrites its descriptor region at the new
width before it reads anything else.

---

## Install the plugins the world uses

Relations, events, snapshots and observers moved off `new ECS()`. Install the ones the world uses:

```ts
// before
const world = new ECS({ deterministic: true });
world.relations.register();
world.observe(Pos, { onAdd });

// after
import { relations } from "@oasys/oecs/relations";
import { observers } from "@oasys/oecs/observers";

const world = ECS.create({ deterministic: true, plugins: [relations(), observers()] });
world.relations.register();
world.observe(Pos, { onAdd });
```

Only the construction line changes. Every call site is the same.

| You call | Install |
| --- | --- |
| `ecs.relations.*`, `ctx.addRelation`, `query.withRelation`, `query.hierarchy`, `query.forEachRelatedTo` | `relations()` from `@oasys/oecs/relations` |
| `ecs.events.*`, `ctx.emit`, `ctx.readEvents` | `events()` from `@oasys/oecs/events` |
| `ecs.snapshots.capture`, `.restore`, `.captureSparse`, `.restoreSparse` | `snapshots()` from `@oasys/oecs/snapshots` |
| `ecs.observe` | `observers()` from `@oasys/oecs/observers` |

`ecs.snapshots.stateHash()` and `ecs.snapshots.deterministic` need no plugin. They describe the
world. The determinism opt-in is unchanged and still separate: `capture` and `restore` throw
`DETERMINISM_DISABLED` on a world built without `{ deterministic: true }`.

A world that installs none of the four carries none of their code, which is the point. A class
method cannot be removed by a bundler, so while `ECS` declared `relations` and `snapshots`, every
program shipped that code whether or not it named them.

If you miss one, the compiler says so. In TypeScript, a world built without a plugin has no
member to reach for, so the mistake is a compile error.

In JavaScript nothing stops the call, so the world throws `ECS_ERROR.PLUGIN_NOT_INSTALLED`, and
the message names the API and the import that supplies it. On a bare world, every member of
`ecs.relations` and of `ecs.events` throws it. So do the call `ecs.observe(...)` and the four
members `ecs.snapshots.capture`, `restore`, `captureSparse` and `restoreSparse`. The system-side
seams throw it too. `ctx.emit`, `ctx.readEvents`, `ctx.addRelation`, `query.withRelation`,
`query.hierarchy` and `query.forEachRelatedTo` are among them.

Install one plugin two times and the world throws `ECS_ERROR.PLUGIN_ALREADY_INSTALLED`.

A world type that must carry a plugin spells it out:

```ts
import type { RelationsPlugin } from "@oasys/oecs/relations";

type RelationalWorld = ECS<RelationsPlugin> & RelationsPlugin;
```

To write a plugin of your own, import the types `Plugin`, `PluginHost` and `PluginsOf`
from `@oasys/oecs`. `Plugin<X>` is what a factory such as `relations()` returns, and what a
plugin list holds. Its `install` takes a `PluginHost` and returns `X`, the surface the world
gains. `PluginsOf` is the surface a plugin list adds to the world.

## The reactive subpaths are gone, take the Solid plugin

`@oasys/oecs/reactive` and `@oasys/oecs/reactive-sync` no longer exist. The adapter functions on
`@oasys/oecs/solid`, `fromKernel`, `fromKernelMap`, `fromKernelStruct` and `fromKernelArray`, no
longer exist either. `@oasys/oecs/solid` exports the `solid()` plugin alone, and that plugin is the
one path from ECS state into a UI.

A Solid app installs the plugin and takes a view. The plugin reads the store's change feed and
writes Solid, so no kernel and no mirror sit in the path.

```ts
// before
import { syncFieldsToMap, batchedUpdate } from "@oasys/oecs/reactive-sync";
import { fromKernelMap } from "@oasys/oecs/solid";

const ecs = new ECS();
const sync = syncFieldsToMap(ecs, Pos, ["x", "y"] as const);
const view = fromKernelMap(sync.map);
batchedUpdate(ecs, 1 / 60);

// after
import { ECS } from "@oasys/oecs";
import { solid } from "@oasys/oecs/solid";

const ecs = ECS.create({ plugins: [solid()] });
const view = ecs.solid.fields(Pos, ["x", "y"] as const);
ecs.update(1 / 60);
```

| You called | You call |
| --- | --- |
| `syncComponentToMap(ecs, def, project, opts)` | `ecs.solid.component(def, project, opts)` |
| `syncFieldsToMap(ecs, def, fields, opts)` | `ecs.solid.fields(def, fields, opts)` |
| `syncSingletonToStruct(ecs, def, eid, fields)` | `ecs.solid.singleton(def, eid, fields)` |
| `syncSingletonToArray(ecs, def, eid, fields)` | `ecs.solid.singleton(def, eid, fields)` |
| `fromKernelMap(sync.map)` and `view.bindCell(id)` | the view itself, and `view.cell(id)` |
| `fromKernel`, `fromKernelStruct`, `fromKernelArray` | the view the entry point returns |
| `batchedUpdate(ecs, dt)` | `ecs.update(dt)` |
| `shallow` as the `eq` of a field projection | `fields`, which supplies its own `eq` |

`grain`, `seedExisting`, `eq` and `dispose()` keep their meaning. `keys()` is a signal of the ids
the view holds, and `cell(id)` is one row's value as one Solid signal. Bind `cell(id)` once for each
row, in the row's own scope.

Three things have no replacement in this release:

- **A React consumer, and a consumer with no framework.** The kernel carried `toExternalStore` for
  `useSyncExternalStore`, and the plugin writes Solid alone. Poll the world with `ecs.getField`,
  with a cursor, or with a `changed()` query until a path lands.
- **`syncJoinToMap`.** A view subscribes to one component. Take one view for each component of the
  join, and combine them where you read.
- **The kernel by itself**, which is `signal`, `computed`, `effect`, `batch`, `untrack`, `root`,
  `onCleanup` and the reactive collections. Take a signals library of your own.

Everything now publishes at the settle point, the tail of `update()`. One `update()` is one Solid
flush, whatever the number of views, so no wrapper around the frame is needed. As before, only a
deferred structural operation reaches a view. Destroy an entity through `ctx.commands.despawn` or
through the host command path.

See [solid](api/solid.md) for the full surface, the refusals, and what the suite does not test.

## What is new in 0.6

These are additions. None of them is required to upgrade.

- **The row grain of change detection.** `ecs.trackRows(def)` keeps one change tick for each row.
  Inside `forEachChunk`, `cols.ticksRead(def)` is that column and `cols.since` is the change tick of
  the previous run of the system, so `t[i] > cols.since` picks the rows that changed. A
  `ChangedQuery` now has `forEachChunk`. See [change detection](api/change-detection.md).
- **`cols.ticks(def)`.** The record a raw column loop makes for an entity-level `onSet`:
  `t[i] = cols.tick` beside the write, in place of a `ctx.markChanged` call for each row.
- **`ecs.sparseCursor(def)` and `ecs.sparseCursorRead(def)`**, with the two on `ctx`. The sparse
  form of `cursor`, and the fastest read by id. See [sparse storage](api/sparse-storage.md).
- **Change detection for a sparse component.** `ctx.sparseChanged(def, entityId)` as a pull, and
  `observe(def, { granularity: "entity", onSet })` as a push.
- **`fixedSabAllocator(maxBytes)`**, from `@oasys/oecs/shared`. A shared buffer that does not grow.
  See [memory](api/memory.md).

A `ref` or a cursor write now reaches an entity-level `onSet` observer, which the change detection
page always said it did. `ctx.ref` records the entity when you create the ref, and a mutable cursor
records it on each `at`. `refRead` and `cursorRead` record nothing.
- **`memory.storeBase` and `storeBaseAbove(exports, extraBytes)`.** The store header sits at a byte
  offset you choose, above everything a module owns. See [WASM](api/wasm.md).
- **One system across workers.** `ecs.attachWorkers({ count })` starts a pool, and the `parallel`
  config on `registerSystem` names a kernel from any toolchain that the pool runs over disjoint row
  ranges. See [parallel execution](api/parallel.md).
