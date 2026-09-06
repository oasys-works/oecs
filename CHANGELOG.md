# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-09-06

### Changed (breaking). Four subsystems became plugins a world installs

`new ECS()` no longer carries relations, events, snapshot and restore, or observers. Each is a
plugin on its own subpath, installed at construction:

```ts
import { ECS } from "@oasys/oecs";
import { relations } from "@oasys/oecs/relations";
import { observers } from "@oasys/oecs/observers";

const world = ECS.create({ plugins: [relations(), observers()] });
world.relations.register();
```

`ECS.create` returns the world intersected with the facades its plugins contribute. A world that
did not install a plugin has no member to reach for, so `ecs.relations` on a bare world is a
compile error and not a fault at run time. `new ECS()` still builds a world, and that world holds
none of the four.

The reason is that a class method cannot be removed by a bundler. While `ECS` declared `relations`
and `snapshots`, every program carried the relation and snapshot code whether or not it named them.
A plugin the construction site imports is a reference a bundler can follow, and one it can drop.
A program that installs none of the four now ships far less code. `bench/` holds the measurement.

Each plugin keeps its call sites unchanged. Only construction moves.

- `@oasys/oecs/relations`, `relations()`, gives `ecs.relations` and the relation terms on a query.
- `@oasys/oecs/events`, `events()`, gives `ecs.events`, `ctx.emit` and `ctx.readEvents`.
- `@oasys/oecs/snapshots`, `snapshots()`, gives `ecs.snapshots.capture` and `.restore`.
- `@oasys/oecs/observers`, `observers()`, gives `ecs.observe`.

On npm, each plugin also has a `/dev` subpath. `@oasys/oecs/relations/dev` and the three others
serve the build with the development guards on. JSR publishes no `/dev` subpath. A plugin binds
to the core build it was made against. Take the plugin and the world from the same channel.

`ecs.snapshots.stateHash()` and `ecs.snapshots.deterministic` stay on every world. They describe the
world, not the plugin, and the determinism opt-in is still separate: `capture` and `restore`
throw `DETERMINISM_DISABLED` on a world built without `{ deterministic: true }`, installed or not.

In TypeScript, reaching for a plugin the world did not install is a compile error. In JavaScript
nothing stops the call, so the world throws `ECS_ERROR.PLUGIN_NOT_INSTALLED`. The message names
the API and the import that supplies it. The fix is at the construction site. On a bare world every
member of `ecs.relations` and of `ecs.events` throws it. So do the call `ecs.observe(...)` and the
four members `ecs.snapshots.capture`, `restore`, `captureSparse` and `restoreSparse`. The
system-side seams throw it too. `ctx.emit`, `ctx.readEvents`, `ctx.addRelation`,
`query.withRelation`, `query.hierarchy` and `query.forEachRelatedTo` are among them.

Installing one plugin two times throws the new `ECS_ERROR.PLUGIN_ALREADY_INSTALLED`.

The types `Plugin`, `PluginHost` and `PluginsOf` are exported from `@oasys/oecs`. A
third-party plugin is typed the way the four built-in plugins are. `Plugin<X>` is what a
factory such as `relations()` returns, and what a plugin list holds. Its `install` takes a
`PluginHost` and returns `X`, the surface the world gains. `PluginsOf` is the surface a plugin
list adds to the world.

### Changed (breaking). `registerIsA` and `registerChildOf` ship on the relations entry

The two built-in relation presets moved off the package root:

```ts
// before
import { ECS, registerChildOf } from "@oasys/oecs";

// after
import { ECS } from "@oasys/oecs";
import { relations, registerChildOf } from "@oasys/oecs/relations";

const world = ECS.create({ plugins: [relations()] });
const ChildOf = registerChildOf(world);
```

`BuiltinRelationOptions` moved with them. Each function calls
`world.relations.register`, so it needs the plugin, and a bare world cannot call it. Exporting
them from the root also pulled the relation code into every bundle, which is the thing the plugin
split set out to stop.

### Added. A change feed more than one plugin reads, and a richer plugin host

The store's record of what changed is now a seam any plugin drains. `ChangeFeed` names it,
`Store` implements it, and `PluginHost.changes` hands it out. A consumer asks for a grain with
`configureObservation` or `configureSparseObservation`, keyed by its plugin name. It drains with
`drainSet` or `drainSparseSet`. The store merges every consumer's ask by OR. So one consumer dropping
a flag never takes that flag from another. Each drain is memoized on its run. A second consumer of
one run gets the result the first one got. A consumer also takes each structural round through
`addStructuralHook`, and the feed carries `forEachChangedArchetype`, `collectEnabledWith`, `isAlive`,
`isDisabled` and `hasComponent`.

`PluginHost` gains three members. `host.world` is the bare world. Take it to register a system,
read a field, build a cursor or reach a resource. `host.changes` is the change feed.
`host.onSettle(fn)` runs `fn` at the tail of every `update()`, after every system and every flush of
the frame. Hooks run in install order. The `run` argument sits above every stamp the frame made.

`Plugin` gains `requires`, the plugins this one reads through, by name. `ECS.create` walks
the plugin list in order, so a dependency comes earlier in the list. A missing one throws
`PLUGIN_NOT_INSTALLED` at construction, and the message names the plugin that asked.

`ECS.create` now checks the facade a plugin returns. A key that names a member the world already
carries throws the new `ECS_ERROR.PLUGIN_SURFACE_COLLISION`. `Object.assign` would overwrite that
member without a word. The four reserved slots, `relations`, `events`, `observe` and
`snapshots`, are the exception. The check is development-only.

Four types are exported from `@oasys/oecs`: `ChangeFeed`, `ObservationFlags`, `DrainResult` and
`StructuralObserverEvents`. The new [plugins](docs/api/plugins.md) page documents the host,
the rules and the feed for an author.

### Added. `solid()`, a plugin that writes one Solid signal per row off the change feed

`@oasys/oecs/solid` now exports `solid()`, for `ECS.create({ plugins: [solid()] })`. A world that
installs it carries `ecs.solid`, which projects ECS state into Solid signals. It reads the change
feed and writes Solid, with nothing in between. The observers plugin is out of that path. This is
the one path from ECS state into a UI.

`ecs.solid` has three entry points, and each view carries `dispose()`. `component(def, project)`
projects one dense component, and `cell(id)` is that row's value as one Solid signal. The first call
for an id makes the signal and every later call returns the same accessor, so bind it once for each
row. A `keys()` signal beside it drives a keyed `<For>`. `fields(def, fields)` is sugar that
publishes a fixed field list as a record, with an `eq` that compares those fields.
`singleton(def, eid, fields)` publishes one entity's fields into a keyless Solid store, where a fixed
key set earns the store's cost. A remove or a disable of the target resets them. `grain` is
`"entity"`, the default, or `"column"`. `eq` is each cell's value equality, handed to Solid as the
signal's `equals`, and it defaults to Solid's `===`. `seedExisting` publishes the current enabled
members at creation, and defaults to true.

The first design published into a Solid store keyed by entity id. `bench/foundations/p23-solid.mjs`
measured that store's publish above the publish that ships, at every density, so a row became a
signal before this release.

Everything publishes at the settle point, the tail of `update()`. A structural event arrives mid-tick
and records an entity id. Nothing reaches Solid inside the flush. The plugin then publishes
inside one Solid `batch`. One `update()` is one Solid flush, whatever the number of views. An entity
spawned and despawned in one tick never appears. A published value is the final value of the tick.
Only a deferred structural operation reaches a view. The observers carry the same limit, because both
read structural events from one flush.

This plugin and the observers plugin are two consumers of one feed. Install both, in either
order, and each one sees the same by-id write.

What it refuses. Dense components only. A sparse definition throws a `TypeError` that names the call.
No join. A view subscribes to one component, so a projection that reads a second component goes
stale. An entity that leaves the component and rejoins inside one tick projects twice. The value is
the final one. A cell carries the whole projected value, so a field read does not track that field
alone. A projection must not return a function, which a Solid setter reads as an updater. A cell is
kept for the life of the view.

Measured against the path it replaces. `bench/foundations/p23-solid.mjs` times a whole tick on both
paths with one effect per entity. Once the path is warm, the plugin is the cheaper of the two at
every dense density the probe measures, and the gap widens with density. Its publish alone, with no
subscriber, costs less as well. On a tick that moves one row or no row the older path measures
lower.

What is untested. Under the test runner, `solid-js` resolves to its server build, where a signal
holds a value, consults no comparator and schedules no effect. The tests assert the value, and they
assert that `eq` reaches the signal and then run it by hand. The suite renders no component. It
proves nothing about a `<For>` re-render.

`src/plugins/solid/__tests__/solid.test.ts` locks the seed, the by-id publish, and the spawn and
the despawn. It locks the disable and the enable, the column grain, and one batch for each update.
It locks the cell identity across a delete, the `eq` the cell carries, coexistence with observers,
the singleton reset and the sparse refusal.

### Removed (breaking). The signals kernel, its ECS bridge, and the kernel-to-Solid adapter

`@oasys/oecs/reactive` and `@oasys/oecs/reactive-sync` are gone. So are the adapter functions on
`@oasys/oecs/solid`: `fromKernel`, `fromKernelMap`, `fromKernelStruct` and `fromKernelArray`.
`@oasys/oecs/solid` now exports the `solid()` plugin alone.

The `solid()` plugin is the one path from ECS state into a UI. It reads the change feed and writes
Solid. The kernel and its mirror were a second path to the same place. They put two more graphs in
between. `component`, `fields` and `singleton` replace `syncComponentToMap`, `syncFieldsToMap` and
the two singleton bridges. `batchedUpdate` has no replacement, because a view publishes inside one
Solid `batch` at the settle point of `update()`.

There is **no React path in this release**, and no framework-free reactive path. A consumer that is
not a Solid app polls the world. Take `ecs.getField`, a cursor, or a `changed()` query.
`syncJoinToMap` also has no replacement. A view subscribes to one component, so take one view for
each component and combine them where you read.

### Added. The store can start anywhere in its memory

`memory.storeBase` places the store header at a caller-chosen byte offset. Every offset the store
writes, in the header, in the column descriptors, in the region table and in the rings, is now
relative to that base, and `capacity` is the span from it. The store writes nothing below the base.
A wasm-backed world defaults to one page and refuses zero, because a compiled module owns the low
addresses of its own linear memory and a safe Zig or Rust build cannot read address 0. A caller
places the base above the module's `__heap_base` and its run-time heap. `memoryPlan.storeBase`
reports the value. `WASM_STORE_BASE_BYTES` is exported.

`storeBaseAbove(exports, extraBytes)` reads a module's `__heap_base` export, adds the run-time heap
the caller reserves, and rounds up to a whole page, so the base clears everything the module owns.

A checked-in WebAssembly module, built with no toolchain, now reads a live store in the test suite
and agrees with the TypeScript side on the layout walk, the byte digest, an f32 kernel and the
deterministic state hash. The layout is a tested ABI, not a fixture that TypeScript compares with
itself.

### Added. One system across workers

`workers()` from `@oasys/oecs/workers` is a plugin. `ECS.create({ plugins: [workers()] })` gives a
world `ecs.workers`, which carries `attach(options)`, `pool` and `detach()`. The pool, the plan
builder and the shim that reaches the node threads module ship in that subpath, so a world that
never names it carries none of them. A JavaScript caller reading `world.workers.attach` on a bare
world gets `ECS_ERROR.PLUGIN_NOT_INSTALLED`, and the message names the import. `AttachWorkersOptions`,
`WorkerPool`, `WorkersPlugin` and `DEFAULT_JOIN_TIMEOUT_MS` are exported from the same subpath, and
`ParallelConfig`, `ParallelKernel` and `ParallelColumn` stay on the root, because they erase.

`world.workers.attach({ count })` starts a persistent pool on the package's own worker entry,
`@oasys/oecs/worker`. A system that carries a `parallel` config names a kernel a worker can load,
either a compiled `WebAssembly.Module` export or an export of a JavaScript module URL, and the
columns the kernel receives in order. The schedule hands the pass to the pool inside the same
access span a TypeScript body gets, parks the host on `Atomics.wait`, and joins before the phase
flush. No spawn, no despawn and no grow can overlap the workers, because nothing else runs on the
main thread while it is parked. Every worker computes its own row range per archetype from the
descriptor row counts, its index and the worker count, so no plan crosses the wire and the result
is deterministic. The join stamps every matched archetype for each declared write.

A parallel system declares only `reads`, `writes` and a dense query. Sparse, relation, resource,
spawn, despawn and transition declarations, `exclusive`, and `backendHandle` are refused at
registration with `ECS_ERROR.PARALLEL_ACCESS`. Those refusals ship with the plugin, so a world that
installed no workers plugin validates no `parallel` config, builds no plan and runs the system's
`fn`. Below `parallel.minRows`, and without an attached pool, the system runs its `fn`. A heap world cannot attach workers. A WASM kernel needs the wasm
backing, because a `SharedArrayBuffer` cannot be imported as a module memory.

The split pays only above a row count that depends on the machine, the kernel and the worker count.
`parallel.minRows` carries a measured default that sits above every crossover the probes found, on
both bodies, both kernel forms, both backings and every runtime tested. A world that never tunes it
never pays a pooled frame the sequential frame would have won. It gives up the gain instead. A
compute-bound kernel crosses far earlier and should set its own value, and a caller's value always
wins. `bench/` holds the measurements and the tuning method.

With a bundler, pass `workerUrl` from the bundler's own URL import of the `@oasys/oecs/worker` entry, for
Vite `import workerUrl from "@oasys/oecs/worker?worker&url"`. The default resolution finds the entry beside
the package as it ships and not inside a bundle. A worker whose script does not load now fails
`workers.attach` with `ECS_ERROR.WORKERS_ENTRY_UNREACHABLE` and terminates the pool, instead of
resolving with workers that never answer. The node threads module is reached through
`process.getBuiltinModule`, so a browser build sees no node builtin specifier and prints no warning.

`workers.attach` takes `joinTimeoutMs`, a safety net and not a budget. A worker that dies inside a pass
can never report done, and the parked host would wait forever. On timeout the frame throws
`PARALLEL_KERNEL_FAILED`, the pool enters a failed state in which every later frame runs `fn`, and
`detach` terminates the hung worker.

At the join every worker adds one to a done word, and the worker whose add completes the count
wakes the host. So the host wakes once for a pass, whatever the worker count is. `bench/` holds
the measurement beside a per-worker done word and a tree join, both of which cost more.

### Added. A kernel module contract that holds for any toolchain

Every worker of the pool instantiates one module over one memory. `docs/api/parallel.md` now states
what that costs a module and what a build has to do about it: the one import, the export and its
arity, the store base, the stack, the data segment and the heap. It carries one build line for Zig,
for Rust, for C through `zig cc` and for AssemblyScript.

`registerSystem` refuses a `wasm` kernel module the pool cannot serve, with the new
`ECS_ERROR.PARALLEL_KERNEL_MODULE`. An import other than `env.memory` is named in the message. A
module that imports no memory is refused as well, because it addresses a linear memory of its own,
writes rows nothing reads, and reports success. An export name the module does not carry, and an
export that is not a function, are the other two. Development builds only, at registration.

A worker now checks the export's parameter count against the column count plus three, and fails the
kernel load with both numbers when they disagree.

Five modules are checked into the test suite, built by the four toolchains above and by a
hand-written emitter that uses no toolchain. Each carries the same bodies, and each runs on the real
pool across several workers and must leave the bytes the sequential TypeScript body leaves. Five
more carry one fault each, so every refusal above has a real module behind it. The suite proves the
contract on a machine with no compiler installed.

### Added. Each worker instance owns its shadow stack, and `stackBytes` sizes it

A worker gives each instance of a `wasm` kernel module its own shadow stack.

An LLVM build, which is Zig, Rust, C and others, keeps a shadow stack in linear memory and addresses
it through the mutable global `__stack_pointer`. A wasm global is per-instance, and every instance
starts at the address the linker chose, so every worker wrote its frames to the same bytes. A kernel
that spilled a local array, a struct passed by pointer, or the address of a local read back what
another worker wrote. The corruption was silent, it needed no shared column, and no probe before
this one caught it, because the earlier kernels held every value in a wasm local.

The worker now carves one region for each worker out of `[__heap_base, storeBase)` and moves
`__stack_pointer` to the top of its own. The regions come off the top of that span, downward from
the store base, so worker `i` gets its top at `storeBase - i * stackBytes`.

`workers.attach({ stackBytes })` says how big one region is, and everything below the lowest region
stays the module's heap. Reserve the module's peak run-time heap plus one stack for each worker with
`storeBaseAbove`, then pass the same `stackBytes` to the pool. Omit it and the pool divides the whole
span, which leaves the module no heap. That is the default, and it suits a kernel that allocates
nothing, which is what the heap rule asks for anyway.

`stackBytes` must be an integer, a multiple of the frame alignment of 16, and at least one WASM page.
A value outside that fails the attach with `WORKERS_COUNT_INVALID`. A span too small to hold one
region for each worker fails the kernel load with `PARALLEL_KERNEL_FAILED`, and the message names the
span, the region, the worker count and the remedy. A module that exports no `__stack_pointer` is left
alone, and the docs say such a kernel may not use a stack. One worker needs no region, because one
instance owns the linked stack alone.

The assignment runs once for each kernel load, so a pass pays nothing for it.

### Changed (breaking for a module that reads the layout). `SIM_ABI_VERSION` is 1

A reader that carries version 0 measured every offset from buffer byte 0. A module that treated a
`byte_off` as a buffer address must add the store base it receives through `setLayout`. Restore and
resume accept a version 0 snapshot, because every version 0 store sat at byte 0 and its offsets read
correctly as offsets from the header, so a snapshot the 0.5 line wrote still restores. Any other
version is refused.

The archetype descriptor header grows from 36 bytes to 40 and gains `entity_ids_off` at offset 36.
The field is reserved for the archetype's row-to-entity table, and the store writes zero, which says
the archetype carries no such table. A walker steps to the next record by `40 + column_count * 16`,
and a reader that ignores the field reads every other field as before. A snapshot carries the
descriptor bytes, so restore rewrites a version 0 region at the new width before it reads anything
else, and the world's `stateHash` is unchanged because it never folds a descriptor.

### Changed. `ComputeBackend.run` takes `dt` and the tick

`ComputeBackend.run(handle, deltaTime, tick)` replaces `run(handle)`. A backend that still declares
`run(handle)` keeps compiling and keeps running, because the extra arguments are ignored. Only code
that calls `run` itself sees the new shape. A module body needs `dt`, and
neither `dt` nor the frame tick lives in the bytes. The schedule also publishes the descriptor row
counts before every backend dispatch, so a module never reads a stale count after a host spawn
before `startup()` or a spawn from a run condition.

A caller-supplied `WebAssembly.Memory` may now carry `maxBytes`. The store needs a cap to promise
its span, so the cap is `maxBytes` or the default ceiling.

### Fixed

A kernel that would not load rejected `workers.attach` and left its workers running, so a node
process never exited on its own. The pool now ends the workers before the fault leaves.

An `ECSError` built on an engine without `Error.captureStackTrace` was a `TypeError` with no
category. The base class now checks for that V8 extension before it calls it. `error.name` read as
one minified letter in the production build, because it came off the constructor. It is now the
literal `ECSError`.

The command, event and action rings copied slot payloads through a view built from buffer byte 0.
At a nonzero base they wrote below the store. The rings now add the view offset.

`wasmMemoryAllocator` predicted the JavaScriptCore write cost of a growable `SharedArrayBuffer`. A
shared `WebAssembly.Memory` does not pay it. The comment now says so, and `bench/` holds the
measurement.

### Changed. The store's observation seam takes a consumer name

`Store.configureObservation` and `Store.configureSparseObservation` take the consumer name first, and
the store merges every consumer's record instead of holding one. The structural hook seam is now a
list that every consumer joins. It was one dispatch bound to the observer registry. The registry is
now one consumer among others, named `observers`.

The observers plugin behaves as it did. It still owns the access-topological order, the radix
entity order, the access span of each callback and `yieldExisting`.
`src/core/ecs/__tests__/unit/change_feed.test.ts` locks the flag merge, the drain memo, and the
install order of both hook lists.

### Changed (breaking). The store no longer forwards to its collaborators

Thirty methods on the internal `Store` forwarded one operation each to a collaborator, and carried
no logic. A caller now names the owner: `store.relations.addRelation`, `store.events.emit`,
`store.resources.get`, `store.snapshots.capture`. The forwarding hid which object held the state and
widened the class for nothing.

### Changed. The query terms travel as one record

A query carries two kinds of term. A dense term sets a bit in the component mask and picks the
archetypes. Every other term (sparse membership, optional fetch, include-disabled, the `(R, *)`
wildcard, hierarchy ordering) now rides in one `QueryTerms` record. `Query`'s constructor takes one
parameter where it took seven, the three driver seams take one where they repeated four, and a query
that declares no such term shares one frozen record. Adding a term is one edit instead of five.

### Changed. `Commands` and `SystemContext` moved to their own module

`query.ts` held the read side and the write side of the system-facing interface. The write side is
`system_context.ts` now. Every export is unchanged, and the barrel re-exports both.

### Fixed. The build no longer splits the core entry into small chunks

Declaring the plugin entries beside the core entries put them in one rollup graph, and rollup
then split `index.js` into ten small shared chunks. Those splits are real module boundaries at run
time, and a measurement of `spawn` against the shipped artifact showed the cost. The plugins
build in their own pass now, and the core chunk graph is unchanged.

### Changed (breaking). A name that misdescribed its body now says what it does

A name that promises one act and performs another sends a reader to the wrong conclusion without
opening the body. An audit read every named function and method in `src/` against its body. Each
name that failed is now the act it performs. The old names are removed and not aliased, because a
name that stays reachable keeps teaching the wrong model.

The public surface:

| 0.5 | 0.6 |
| --- | --- |
| `query.eachChunk(cb)` | `query.forEachChunk(cb)` |
| `query.forEachUntil(cb)` | `query.some(cb)` |
| `ctx.read(key)` | `ctx.readEvents(key)` |
| `ecs.onStoreLayoutPublished(fn)` | `ecs.subscribeLayout(fn)` |
| `ecs.publishArchetypeRowCounts()` | `ecs.publishRowCounts()` |
| `queue.pending` | `queue.pendingCount` |
| `FrameTraceSink.systemStart` | `FrameTraceSink.systemBegin` |
| `column.get(i)`, on `/primitives` | `column.getAt(i)` |
| `column.ensureCapacity(n)`, on `/primitives` | `column.reserve(n)` |

`ctx.read` moves because `cols.read(def)` in the same walk returns a column group, so one verb
carried two shapes. `forEachUntil` returns whether a callback accepted, thus it is a predicate and
now reads as one. `reserve` is the contract of `ColumnBacking`: guarantee room for the count, or
throw. A heap column grows to keep it. A buffer-backed column cannot grow, so it throws, and each
doc states which.

On `@oasys/oecs/internal`, every `accessCheck.check*` method is now `assert*`, and
`dispatchTrace.recordEmit` and `recordRead` are `recordEventEmit` and `recordEventRead`.

Three rules now hold across the tree. One verb throws on a bad state, `assert`, and `validate`
keeps only the helpers that return the value they test. One verb constructs, `create`. The
underscore prefix marks a private or a protected class member and nothing else, so a member that
another module reaches carries no prefix.

### Changed (breaking). A field name now says what it holds

The same audit read every field and every module-scope variable. A field whose name promised one
content and held another is now the content it holds, and the underscore prefix now marks a private
or a protected member on a field exactly as it does on a method. A member that another module
reaches carries no prefix, whatever its role.

The public surface:

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

None of these is part of the documented API. Each is public because another module reads it, so the
prefix claimed a privacy the member never had. Three of them could not drop the prefix alone,
because `Query` already carries an `optional`, an `includeDisabled` and a `hierarchy` method. Each
of those three now names the thing it holds: a term list, a flag, a term.

Inside the package the same rule moved about a hundred more members. `Archetype` publishes
`flatColumns`, `bufs`, `accessorColumns`, `colOffset`, `fieldCount`, `columnIds` and `changedTick`
without a prefix, and `Store` publishes `tick`, `trace`, `anyDirtyTracked` and `queryDirtyEpoch`.
Every private field of `Store`, `Schedule`, `ECS`, `AccessCheck`, `EventRegistry` and the editor now
carries one. A table that holds one entry per entity reads as plural, so `Store.entityRow` is
`_entityRows` and `Store.entityArchetype` is `_entityArchetypes`. `Schedule.setConditions` and
`setOrdering` read as verbs and are `_conditionsBySet` and `_orderingBySet`. `EventRegistry.count`
allocates the next event id and is `_nextEventId`. `DispatchTrace.buf` holds counts, not bytes, and
is `_counts`.

### Fixed. A fifth column type made every row move in the process slow

Every structural row operation, the copy behind `addComponent` and `removeComponent`, the
swap-remove behind `despawn`, the swaps behind `disable` and `enable`, walked the columns of an
archetype through one loop, and that loop had one typed-array access site. The site saw every column
type that any archetype in the process used. V8 keeps one site fast for at most four typed-array
classes. At the fifth type the site became megamorphic, and each element move then cost far more,
in every archetype, and not only in the one that mixed the types. The library offers eight
column types, so a schema with `f32` positions, an `i32` counter, a `u8` flag, a `u16` team and an
`f64` timer reached the fifth type without notice.

The structural operations now move bits through views whose class depends on the element width
alone (`Uint8Array`, `Uint16Array`, `Uint32Array`, `Float64Array`), so the site sees at most four
classes. A write of a number must convert to the column's type, so the value-writing paths (`spawn`
with a template, `addComponent` with values) use the true view through one access site for each
type. The cost of a row move is now flat across the number of column types, and unchanged for a
world that uses one type.

### Changed. A sparse component is id-indexed, and `sparseCursor` is the fastest read by id

A sparse component kept each entity's values in a small JavaScript array inside a map keyed by
entity index, so a read by id paid a lookup and a pointer chase, and a value was stored as the
number given and not as the declared type. The store now keeps one typed array of the declared type
for each field, indexed by entity index, with a sparse set beside them for membership. A read by id
is one load, an add or a remove is a bit and a write at the index, and a value converts as the
field's type converts (an `i32` truncates, a `u8` wraps, an `f32` rounds), as a dense field does.

`sparseCursor` and `sparseCursorRead`, on `ecs` and on `ctx`, are the sparse form of `cursor`.
`at` writes the entity index alone and a field access is one load, so a sparse cursor is the read
by id to use when a system touches many entities from a list of ids. In development, `at` throws
for a dead entity or a non-member. In production it does not test. `ctx.sparseCursor` needs the
component in `sparseWrites`, and `ctx.sparseCursorRead` in `sparseReads`.

The columns of a store double to fit the highest member index, so the memory of a sparse component
is proportional to that index and not to the member count. The snapshot format is unchanged. The
`indices` view of a store is now a typed view with a fixed length. The query driver walks the live
member list, so a walk sees an edit made during it as before. That walk (`forEachEntity` over a
sparse term) now keeps the dense verdict of the last archetype it saw, so members of one archetype
that sit together in the sparse list pay the mask test one time and not each.

### Fixed. Every ref and cursor read paid for a property key that the optimizer could not fold

The state of a ref or cursor was keyed by two symbols that other modules imported. The package
build puts the accessor module and the store in different chunks, and a key read through an import
binding is not a constant to the optimizer, so every field access through a ref or a cursor was a
generic keyed load. A symbol has no other way to be reached, so the state is now keyed by two
reserved names, `__cols` and `__row`, written as literals at each site. Registration refuses those
two names on a dense or a sparse component.

Two more constants on the by-id paths, the entity index mask and the entity-id bounds that
`isAlive` compares against, are read through local copies for the same reason, and the `switch`
over column types in the value-write path compares against local copies of the tags, so it compiles
to a jump table.

The shape of the accessors is also settled when the module loads. A dense cursor reassigns its
column array on every `at`, and a ref or a sparse cursor never does, so the first dense `at` in a
process changed a field of the shared shape from constant to mutable, and every optimized function
that had read the field under the constant assumption was thrown away and compiled again, slower.
One throwaway object of each shape now reassigns both fields at load, so nothing compiles under the
assumption and nothing is thrown away.

### Fixed. Systems made from one factory ran their hot loops much slower

V8 decides what to inline from the feedback of a call site. When every system in a world came from
one function literal, a factory such as `makeMover(component)`, or a world with a single system,
the scheduler's dispatch site saw one target, and the engine inlined the system body, with its
`eachChunk` callback and its hot loop, into the scheduler's own loop over the systems. That inlined
loop ran much slower than the same loop compiled on its own. A world whose systems came from two
or more literals never hit this, so the factory case was slower than the plain case, and nothing in
the user's code said why.

Every system body now runs through one trampoline whose call site the module makes megamorphic
when it loads. No system body is inlined into the scheduler, whatever the number of literals, and
each is compiled on its own. A dispatch costs a little more, one time for each system in each phase.
A system that does any work gains more than that cost.

### Changed. The cost of a new archetype no longer grows with the number of archetypes

A world discovers its archetypes as it runs, and each new one extends the column store. That extend
took the in-place path, which moves no rows, but it still walked every archetype three times: one
walk to build a list of row counts that only the realloc path reads, one to sum the descriptor bytes
in use, and one to copy the archetype map. So the N-th archetype cost N steps, and a world with many
archetypes paid for that at startup. The list is now built only when the realloc path runs, the
descriptor bytes in use are cached on the store, and the in-place extend appends to the archetype
map instead of copying it. The cost of a new archetype is now the cost of its own columns.

### Fixed. A fifth component made every ref and cursor in the process slow

A ref got one prototype for each (archetype, component) pair, and a cursor one for each component.
An engine gives an object a distinct shape for each distinct prototype, so the read of the row inside
each getter saw one shape for each component that the program read through refs or cursors. At the
fifth shape that read became megamorphic, and every field access through every ref and every cursor
in the process became far slower. A world with five components, each with only `f64` fields,
was enough.

Every ref and every cursor now shares one prototype for the whole process. Each distinct field name
gets one global id and one accessor on the prototype, installed at the first component registration
that uses the name. An accessor holds the component's columns indexed by that id, so a field read
costs the same two index operations it did before. The own state of an accessor is the two reserved
names `__cols` and `__row`, which registration refuses as field names, so no field can collide with
it. A field the component does not have throws `FIELD_NOT_REGISTERED` under `DEV`, where it read a
neighbouring column before.

`for..in` over a ref or a cursor is no longer a way to list a component's fields. Use the schema.
The shared prototype carries the field name of every component registered in the process, and the
two reserved names are own fields, so the walk reports all of them. `Object.keys` and the spread
report the two reserved names alone, where they reported nothing before.

A field name that two components give different types (an `x` that is `f32` in one and `i32` in
another) reads and writes correctly on both. Its accessor dispatches on the column's class, which
costs one `switch` more than an accessor for a name with one type.

### Changed (breaking). `memory` is two fields, and not one union of five arms

`ECSOptions.memory` held two questions that do not depend on each other, how big the world is, and
what holds its bytes, inside one key-discriminated union. A caller could answer only one of them.
The `budget` arm and the `maxBytes` arm each selected the heap allocator themselves, so "a budget of
50,000 entities on a shared backing" was not something you could say. `maxBytes` had to appear three
times, once for each backing arm, because the size axis had nowhere else to live.

Sizing and backing are now two fields, and every pair of them is legal:

```ts
new ECS({ memory: { entities: 50_000 } });                    // size only
new ECS({ memory: { backing: "shared" } });                   // storage only
new ECS({ memory: { entities: 50_000, backing: "shared" } }); // both, this was a type error before
new ECS({ memory: { entities: 50_000, maxBytes: 64 * MiB } });// size from one, ceiling from the other
```

Each removed arm throws `INVALID_MEMORY_OPTIONS` and names its new spelling. They are removed and
not aliased, because a sizing that the engine ignored in silence would build a world of the wrong
size and show it much later, as a limit error far from its cause.

| 0.5 | 0.6 |
| --- | --- |
| `{ budget: { entities: N } }` | `{ entities: N }` |
| `{ heap: { maxBytes: X } }` | `{ maxBytes: X, backing: "heap" }` |
| `{ shared: { maxBytes: X } }` | `{ maxBytes: X, backing: "shared" }` |
| `{ wasm: W }` | `{ backing: { wasm: W } }` |
| `{ allocator: A, capBytesHint: X }` | `{ maxBytes: X, backing: { allocator: A } }` |

`maxBytes` and `columnCapacity` keep their names and their meaning. The types `EntityBudget` and
`SharedMemoryArm` are removed: the three fields of a budget are now fields of `memory` itself, and
the shared backing is the string `"shared"`. The new type `MemoryBacking` names the backing axis.
`ResolvedECSMemory.source` now names the backing alone, and the new field `sizing` names the size
axis.

### Fixed. A custom allocator with a limit below about 12.6 MiB could not build a world

The `allocator` arm reserved the full identity space for the entity index, always, and ignored the
limit that `capBytesHint` declared. The reservation happens when the store is built, so the index
alone did not fit under a small limit and the world threw `STORE_CAP_EXCEEDED` before it existed.
The error then blamed the caller for runaway entity growth, in a world that held no entities. Every
other arm already sized the index from the limit.

The reservation of the entity index now comes from `entities` first, from the byte limit second, and
from the default last, for each backing equally.

### Fixed. A declared number of entities now sizes the entity index on every backing

Only the `budget` arm derived the index from the entity count, and that arm forced the heap backing.
On each other backing the index was sized backwards from the byte limit, which reserves much more
than a small world needs. A count now reaches the index whichever backing holds the bytes.

### Added. `fixedSabAllocator`, a shared buffer that does not grow

`fixedSabAllocator(maxBytes)`, from `@oasys/oecs/shared`, reserves one fixed `SharedArrayBuffer` at
the limit. It is `heapArraybufferAllocator` with a `SharedArrayBuffer`, so the bytes stay shareable
with a worker or a WASM module and the buffer never moves.

It exists for a measured reason. JavaScriptCore has no fast store path for a TypedArray view over a
growable `SharedArrayBuffer`: a column read costs what a fixed buffer costs, but every column write
costs far more. The cost is for each access and not for each byte, so a small world pays it too.
V8 shows no such difference. Safari and Bun are JavaScriptCore. A fixed buffer restores the fast
store path on both engine families and gives up only the growth.

`growableSabAllocator` and `wasmMemoryAllocator` now carry that warning in their own documentation.
A shared `WebAssembly.Memory` gives a growable `SharedArrayBuffer` and can give nothing else, so the
WASM backing should pay the same cost on JavaScriptCore. That last point is reasoning and not
measurement, and it is marked as such.

The default backing for `{ backing: "shared" }` is unchanged: it is still `growableSabAllocator`.

### Fixed. The fixed-length rule for a column view is now stated and locked

Each column view is built with an explicit `(byteOffset, length)`. A TypedArray built with no length
argument tracks the length of its buffer, and measurement puts that shape far behind a fixed-length
view on every engine tested. `makeView` is the only place that builds a column view, but nothing
said so and nothing tested a view's length. The rule is now in the `makeView` documentation, and two
tests hold it: one walks every column of every archetype, and one proves that a view keeps its
length when the buffer below it grows. The second matters most, because a length-tracking view
survives the identity and data checks that were already there.

### Added. `ECS_ERROR.INVALID_TEMPLATE`

`spawn` and `spawnMany` take a template from `ecs.template(...)`. A component definition, a callable
bundle, the pre-0.5 array of entries, or some other value reached the store instead. The store then
failed with a `TypeError` about an internal field. That error named the wrong place, and it did not
say what to do. A development build now throws `INVALID_TEMPLATE`. It names the value the caller
gave, and it names the call to make in its place. `ecs.template` rejects the array of entries with
the same code. The types already reject all four shapes, so this catches an untyped call site. Both
checks are development only, and the production build is unchanged.

### Fixed. A write was reported on two frames when the writer ran before the reader

`changed()` compared a per-frame tick with the last run of the reader, and it took a stamp at or
after that run. A frame tick cannot order a writer and a reader inside one frame, so a write by an
earlier system was reported on that frame and again on the next. Writer before reader is the usual
order, so the usual order reported every write twice. The same tick missed a host write between
frames at an archetype-level `onSet`: the observer's baseline was the next frame, which a host
write never reached.

The engine now keeps a change tick apart from the frame tick. It advances before each system run,
before each phase flush, before the `onSet` dispatch and at the end of each update. A write stamps
it, and a consumer reports a stamp above its own last run. One write is reported one time at each
grain, whichever system runs first, and a host write between frames reaches both grains on the
next update. `ctx.ecsTick` still counts frames. A system no longer sees its own stamp on its next
run: a writer that also read `changed()` on the same component fired on every frame, and it now
fires for the writes of other systems, and for its own inside the run that made them.

`ecs.getCurrentTick()` is `ecs.getChangeTick()`, and the schedule's `runStartup`, `runUpdate` and
`runFixedUpdate` no longer take a tick.

### Fixed. A `ref` or `cursor` write never reached an entity-level `onSet`

Only `setField`, `updateField` and `markChanged` recorded an entity for an `onSet` observer with
entity granularity, while the change detection page said a `ref` write was seen. The accessor
setters write raw columns and cannot record, so `ctx.ref` records the entity when you create the
ref, and a mutable cursor records it on each `at`, on the context and on the host. Both are
conservative, as the archetype stamp is. `refRead` and `cursorRead` record nothing. The entity
level drain also no longer allocates a list on each frame.

### Added. `cols.ticks(def)`, the row record for an entity-level `onSet`

A raw column write in a chunk loop is invisible to the engine, so an `onSet` observer with entity
granularity needed `ctx.markChanged` for each row, a call and a list push. The loop can now store
the change tick into the row of `cols.ticks(def)`: `t[i] = cols.tick`. One typed-array store,
which costs about what the write beside it costs. The column exists only while an entity-level
`onSet` observer tracks the component, and the call throws `ROW_TICKS_NOT_TRACKED` otherwise.

### Added. `ecs.trackRows(def)`, `cols.ticksRead(def)`, `cols.since` and `changed(def).forEachChunk`

Change detection at the row grain as a pull. `ecs.trackRows(def)` keeps one change tick for each
row of every archetype that holds `def`, stamped by every write path. A `ChangedQuery` now has
`forEachChunk`, and inside it `cols.ticksRead(def)` is the row tick column and `cols.since` is the
change tick of the previous run of the system, so `t[i] > cols.since` picks the rows that changed
since that run. An `onSet` observer with entity granularity turns the row ticks on as well.

### Added. Change detection for a sparse component

A sparse component had none. It now has the row grain: `ecs.trackRows(def)` keeps one change tick
for each entity index in the sparse store, `setSparseField` and `at` on the mutable sparse cursor
stamp it, and an add zeroes it. `ctx.sparseChanged(def, entityId)` reads it as a pull, true for the
run after a write. `observe(def, { granularity: "entity", onSet })` reads it as a push, the one
observer shape a sparse component takes: it has no archetype, so no structural callback and no
archetype grain, and `observe` names that in its error. A mutable sparse cursor's `at` pays one load
and one branch while the component keeps no row ticks.

### Changed. A by-id record stops listing once the list outgrows a fraction of the live entities

An entity-level `onSet` drain paid a push, three checks and a sort slot for each recorded entity,
so a system that wrote most rows by id paid more than a scan of the rows would cost. Past a cap
set from the live entity count at each drain, a frame switches to the scan, the by-id record stamps
the row and pushes nothing, and the drain walks the plane of each archetype a writer stamped. A
`markChanged` record stamps no archetype, so it is listed still, and dropped when a scan covers it.

### Fixed. The observer drain took a slow path on JavaScriptCore

The radix pass that orders a drain by entity index kept its scratch in a plain array grown by a
length assignment. JavaScriptCore turns such an array into a sparse store, and each element store
in the pass became a hash insert. The scratch is a typed array now, grown by doubling, in the
observer registry and in the hierarchy walk of the relation service. V8 did not care either way.

### Changed. The entity grain keeps a row tick, and not a dedup byte for each entity slot

An entity-level `onSet` observer used to allocate one byte for each entity index slot of the world,
for each tracked component, whatever the live count. It now gives every archetype of the component
one word of ticks for each row, which rides the row plane through every move, and the dirty list
takes an entity one time per drain by comparing that tick. A row carries its tick across a
transition, so the compare holds for a move. It does not hold when the entity leaves the component
and joins it again, because the new row has no tick to carry, so the drain drops a repeated id
after it orders the list. The drain fires a row a chunk loop recorded with no liveness check,
because a row inside the enabled partition is alive, a member and enabled by construction. A row a
by-id path recorded is still checked. In a frame where a chunk loop took `cols.ticks(def)`, the
drain walks each row of every archetype of the component that a writer stamped, so take the column
only in a loop that stores into it.

A tag keeps no row ticks. It has no field, so no write can record one, and `trackRows` on a tag
does nothing.

### Fixed. `observe()` on a sparse component named "component undefined"

A sparse component and a relation have no observers and no change tick. `observe` now throws
`OBSERVER_INVALID_CONFIG` and names the remedy.

## [0.5.4] - 2026-07-31

### Added. `cursor` and `cursorRead`, the accessor for a sweep by id

`ecs.cursor(def)` and `ecs.cursorRead(def)`, with the two equivalents on `ctx`, give a single-entity
accessor that you can **move again**. You create it one time, and then you move it with
`at(entity)`.

```ts
const p = ctx.cursor(Pos);
for (let i = 0; i < ids.length; i++) {
  p.at(ids[i]);
  p.x += p.y * dt;
}
```

The engine creates a ref for each entity. Over a list of ids, the loop then discards each ref that
it created. A cursor lifts that creation out of the loop: `at` writes the archetype, the offset, and
the row, and nothing else. A cursor also resolves the position of each field when you create it, so
a read does not look up a field name.

A cursor is **safer than a ref that you hold**, and not more dangerous. `at` resolves the archetype
and the row again on each call. So a structural change between two `at` calls cannot make the cursor
read a different entity. A cursor also follows an entity that changes archetype, which a ref cannot
do. Only the window between one `at` call and the reads that follow it must be free of structural
change.

In a development build, a cursor makes its declared-access check on **each `at`**, and not only when
you create it. `cursor` makes a write check, and `cursorRead` makes a read check. The check is on
`at` because you keep a cursor, and a cursor can therefore outlive the system that made it. A cursor
that you make outside a system, or in a different system, is checked against the system that
**uses** it. An `at` outside every system makes no check, because no system can hold the fault. A
production build removes this check, as it removes each of the other development guards.

A cursor obeys the rules of the family: the definition comes first, the mutable name has no suffix,
and the read-only name has the `Read` suffix. There is one constraint. A component with a field
named `at` collides with the method of the cursor. Creation of the cursor rejects that component,
and the message says so.

See [refs and cursors](docs/api/refs.md#cursors-many-entities-by-id).

### Added. `ECS_ERROR.ARCHETYPE_ROW_INVARIANT`

This error reports that the row bookkeeping of an archetype does not agree with its backing columns.
There are three causes. A reserve did not give the capacity that the engine asked for. A restore
gave a partition boundary that is out of range. Or a cached row plane points at a buffer that is no
longer current. The error is for development builds only. It reports a failure of an internal
invariant, and not a mistake by the caller. That is what makes it different from
`STORE_CAP_EXCEEDED`, which is the allocator that refuses a legitimate grow. Two development
assertions that reported the general `COMPONENT_NOT_REGISTERED` now use it.

### Changed. Structural churn, system dispatch, and fragmented iteration

No signature changed on a function that exists, and no result changed. Each entry below is a change
to the internal mechanism. What moved:

- **The row plane of an archetype.** Row placement went through the `ColumnBacking` API (`push`,
  `swapRemove`, and `pop`). That API costs three things **for each column and for each row**: a call
  to the `.buf` accessor, a comparison against the capacity, and a load and store of `_len`. The
  actual work is one move of an element. But `Archetype.length` is already the row count of every
  column. So the archetype now indexes cached raw views (`_bufs[i][row]`), and it moves `length` one
  time. The probe for an overflow on an append becomes one comparison against a cached capacity.
- **`eachChunk` no longer refreshes a column group on each call.** `cols.mut(def)` and
  `cols.read(def)` used one cached object for each (archetype, component) pair. But they wrote one
  property for each field on *every* call, and a fragmented pass makes that call one time for each
  chunk. Only `_syncRowPlane` can change the identity of the buffer of a column. So `_syncRowPlane`
  now points the cached groups at the current buffers, and the accessors make no test for a stale
  buffer.
- **`readField` indexes the row plane.** It reads `_bufs[i][row]`, and not
  `_flatColumns[i].buf[row]`. This removes a `.buf` accessor whose concrete type is different for a
  heap column and for a `SharedArrayBuffer` column.
- **The last-run ticks of the schedule.** `systemLastRun` was a `Map<SystemDescriptor, number>`, and
  a phase read it and wrote it one time for each system. It is now a packed array that a slot, local
  to the schedule, indexes. The slots travel in the cached phase plan, next to the sorted
  descriptors. `hasFixedSystems()` holds the node list of `FIXED_UPDATE` directly, and it makes no
  lookup by key for each frame.
- **One probe of the edge for a single add or remove.** `addComponent` made four lookups before it
  touched a row: `mask.has`, `archResolveAdd`, which read both again, `archGet`, and then a second
  `getEdge` for the transition map. An `edge.add` value that is not null means exactly "this
  archetype does not hold the component, and the destination is resolved". So one probe of the holey
  `edges` array answers all of it. The first-sight case and the overwrite-in-place case move to a
  cold tail. `removeComponent` is the mirror image.
- **One resolve of liveness and index, in place of two derivations.** `Store.hasComponent` called
  `isAlive`, which derived the packed entity index. It then derived that index a second time to
  reach `entityArchetype`. The read of the generations also went through a call into the allocator.
  Both now fold into one `_liveIndex`. `getEntityArchetype` and `getEntityRow` become one
  `resolveEntity`.
- **`ecs.query(...)` allocates nothing when the cache holds the query.** The caller copied its
  scratch mask before it gave that mask to the resolver, and the resolver copies each mask that it
  keeps. That copy made a `BitSet` and a backing `number[]` for each call, for nothing. The contract
  for the borrowed mask is now written at the resolver.
- **`clearEvents` returns immediately when the frame emitted no event.** A write of `length` on an
  array is a property store, and V8 does not remove that store for an array that is already empty.
  This ran one time for each `update()` call, and most phases emit no event.

### Changed. Diagnostic vocabulary catch-up (the deferred snake_case remnants)

- **Breaking (diagnostics):** `ECS.memoryPlan.source` now reports `"maxBytes"` instead of
  `"max_bytes"` for the arm with the explicit byte cap. The name now agrees with the option key
  that it names. Every other arm already agreed: `budget`, `heap`, `shared`, `wasm`, `allocator`,
  and `default`.
- The `INVALID_MEMORY_OPTIONS` messages and the `memoryPlan.derivation` trace now name the options
  by their real camelCase keys (`columnCapacity`, `entityIndex`, `budget.bytesPerEntity`,
  `wasm.maximumPages`, `wasm.initialPages`, and `capBytesHint`), and not by the snake_case
  spellings from before 0.4.

### Fixed. Row-plane and schedule-slot correctness under the new caches

- **A grow that throws no longer leaves the row plane on a buffer that the engine released.** The
  reserve grows the entity-id array on the heap before it asks the store to grow the columns. So
  when a refusal of the `SharedArrayBuffer` cap threw out of the grow handler, the cached entity-id
  view pointed at a buffer that the engine had released, and the array itself had moved. The world
  must survive a refusal of the cap, because that refusal is the basis of the fail-closed `spawn`
  and `spawnMany` contract. But a later append that fitted the stale capacity wrote its entity id
  into the released buffer. The next re-sync then put in the buffer that never received that row. A
  re-sync occurs on a successful grow, and on the `refreshViews` call that each new archetype
  causes. The id then read back as `0`, and the swap-remove that followed corrupted the row pointer
  of a *different live entity*. The engine now derives the plane again on the path that throws.
- **A shortfall of capacity in the entity-id array alone no longer causes a reallocation of the
  full store.** The cached row capacity is the smaller of two values: the capacity of the entity-id
  array, and the capacity of every column. But the *decision to grow* belongs to the column term
  alone. A decision on the smaller value sent a shortfall to the store when only the entity-id array
  had one, and that array had already grown. The store then calculated a capacity that did not
  change, and it found no column to resize. But it still did a full snapshot, create, and restore of
  the full column store, plus a `refreshViews` call on each archetype. It did all of that to resize
  nothing. This is reachable after a restore from a snapshot, because a restore grows the entity-id
  array to the *number* of restored rows, and not to its capacity.
- **A recycled `systemLastRun` slot can no longer be the slot of two systems.** A phase copies the
  slot array of its plan into a local. So a system that you remove from inside that phase still runs
  from the snapshot, and it still writes its last-run tick as it ends. Before this fix, the engine
  could give that freed slot to a system that you added during the same drive. The write of the
  removed system then landed on the tick of the new system. That write moved the `changed()` window
  of the new system, and it gave no signal. The engine now recycles a slot only outside a running
  drive. Between drives the slots recycle as before, so the array stays bounded.

### Note. The lookup of a field name stays as it is

`getField` resolves a field name through the `_fieldIndex[cid][field]` table. The engine builds that
table with `Object.create(null)`, which puts it in dictionary mode. The investigation covered three
replacements: a `{}` literal, a `Map`, and interning of the names with a perfect hash for each
component. None of the three is better than the table that exists in a world that has many
components with different field names. The table stays, and a comment next to it records the
investigation. To remove the lookup, the caller must hold the ordinal of the field, and not its name.
`cursor` does exactly that for a sweep. To do the measurement again, use
`bench/vs/probe-fieldshape.mjs` and `bench/vs/probe-lookupcost.mjs`.

### Docs

- `ARCHITECTURE.md` carries the 0.5.4 stamp. It now describes the row plane of an archetype, the
  packed last-run slots of the schedule, and the `ARCHETYPE_ROW_INVARIANT` assertion.
- `ARCHITECTURE.md` gives **no line numbers**. A reference names its source file only, because a
  line number becomes incorrect as the source changes. To find a claim, search for the name of the
  symbol next to the reference.
- The documentation gives no benchmark figures. Each entry describes what changed.
- `ARCHITECTURE.md`, `README.md`, `api/memory.md`, `api/index.md`, and `BEST_PRACTICES.md` no
  longer describe the default heap backing as a growable or resizable `ArrayBuffer`. It is fixed at
  the cap, and has been since 0.5.3.
- `api/refs.md` documents cursors, and `api/errors.md` documents
  `ARCHETYPE_ROW_INVARIANT`. The error count in `api/errors.md` is now 48.

### Packaging

- `bench/` is no longer part of the JSR package. npm ships from a list of the files to include
  (`files: ["dist", "CHANGELOG.md"]`), so npm was never affected. But JSR publishes the source tree
  against a list of the files to exclude, and the local bench and oracle harnesses would have
  shipped as soon as git tracked them.

## [0.5.3] - 2026-07-09

### Fixed. Heap columns are again on the fast element-access path of V8

- The pure-TS **heap profile** (`heapArraybufferAllocator`, the default backing)
  now reserves its store as a **fixed, non-resizable `ArrayBuffer`** at the full
  cap. Before this release it used a growable buffer, and it made that buffer
  larger with `.resize()`. V8 has no fast element-access path for a TypedArray
  view over a **resizable or growable** `ArrayBuffer`, because each `col[i]`
  reads the mutable length again. Thus a loop over a column was much slower than
  the same loop over a fixed buffer. This made each iteration-bound system slower
  from 0.3.x, and it gave no signal. Version 0.5.3 corrects the fault, and a
  cross-library bench gives the throughput of 0.3.1 again.
- The fixed buffer faults pages in lazily. Thus RSS follows the real use, and not
  the reservation: a world with few entities keeps a small resident set at the
  256 MiB default cap, which is equivalent to the old resizable buffer.
  Growth remains in place: the store relocates columns within the pre-reserved
  buffer, so the buffer identity never changes and every existing view stays
  valid.
  `isInPlace: true` and the entity-index-hoist-across-grow invariant hold
  unchanged. The store keys its tail cursor off the header `capacity` (the
  logical high-water) rather than `buffer.byteLength` (now always the cap).
- Only the heap backing changed. The `growable_sab` / `wasm_memory` backings
  keep their resizable buffers and page-rounded tail layout byte-for-byte
  (their determinism and layout goldens are unchanged).

## [0.5.2] - 2026-07-08

### Added. A guards-on build and an explicit dev entry

- **`@oasys/oecs/dev`**, the same public API as `@oasys/oecs` with the `__DEV__`
  guards left **on**, for a direct guards-on import (browser or CDN, quick debugging,
  or bundlers that don't auto-select conditions).
- **`development` export condition**, dev-mode bundlers (`vite dev`,
  `webpack --mode development`) now resolve `@oasys/oecs` (and every subpath) to a
  guards-on build automatically. Production-mode builds resolve to the stripped
  build as before.
- npm now ships a **dual build** (`scripts/build.mjs`): the default `*.js` and `*.cjs`
  are the stripped production artifacts (unchanged), alongside new guards-on
  `*.development.js` and `*.development.cjs`.
- New guide: [Development guards & production builds](docs/PRODUCTION.md).

### Changed. Dev-guard default is now production on JSR or Deno

- Raw-source (JSR and Deno) consumers now default to `__DEV__ = false` (production, with the
  guards off and no cost in each frame), which matches the npm default. Previously the raw path
  defaulted to guards-on. To enable the guards while developing on Deno, set
  `globalThis.__DEV__ = true` **before the first import**. The `globalThis.__DEV__`
  override is unchanged. Only the default flipped. (`dev_flag.ts`)

## [0.5.1] - 2026-07-06

### Changed (breaking). One attach grammar

`addComponents` and `template` now take the same callable-bundle varargs as `spawnBundle`
and `ctx.commands.spawn` / `add`, replacing the `{ def, values }[]` entry-object array, one
grammar across every authoring surface:

```ts
// before
ecs.addComponents(e, [{ def: Pos, values: { x, y } }, { def: Vel, values: { vx } }]);
const Bullet = ecs.template([{ def: Pos, values: { x: 0, y: 0 } }]);
// after
ecs.addComponents(e, Pos({ x, y }), Vel({ vx }));
const Bullet = ecs.template(Pos({ x: 0, y: 0 }));
```

To migrate: drop the array brackets, wrap a valued entry in its def's call
(`{ def: X, values: V }` → `X(V)`), and leave a bare entry bare (`{ def: X }` → `X`).

- Each item is schema-checked against its **own** def via the `StrictBundles` mapped tuple
  (`{ [K in keyof Items]: … }`), a misspelled or cross-component field, including a
  hand-written raw `{ def, values }` literal, is a compile error. `spawnBundle` gains this
  per-item checking (it previously had none).
- `ctx.commands.spawn` / `ctx.commands.add` now schema-check their bundle values in
  declared-access systems as well (the `DeclaredBundleOrDef` type distributes over the
  declared add set). A permissive / `exclusive` context stays loose, as before.
- The `TemplateEntry` / `TemplateEntries` public types are removed (they encoded the retired
  entry-object grammar). The host command seam (`HostCommandQueue.spawn`, the record and replay
  and editor-undo transport) deliberately keeps its entry-object + complete-values shape.

### Changed. API vocabulary consistency

Cheap alignments from a public-API vocabulary audit that followed the grammar unification:

- `removeComponents(e, ...defs)` is now varargs, mirroring `addComponents` (was
  `removeComponents(e, defs[])`).
- `HostCommandQueue.pending()` is now a `pending` getter (matching every other count accessor).
- `ReadonlyEntityIdArray` → `ReadonlyEntityIDArray` (acronym casing, matching `EntityID`).
- The entity-id parameter is now uniformly `entityId` across the core surface (ECS lifecycle,
  host-command queue, `ObserverFn`). The `HostCommand` wire-format field stays `eid`.
- Source-compatible widenings: `ecs.despawn`, `ecs.removeSystem`, and the `HostCommandQueue`
  mutators now return `this` for chaining.

The `ref` / `refRead` argument order was reviewed and **deliberately kept** def-first
(`ctx.ref(def, entityId)`): these are the outside-iteration members of the `cols.mut` /
`cols.read` column-cursor family, so def-first is the cursor convention, not an inconsistency
to fix, flipping it would align with `getField` while breaking alignment with `cols.mut`.
Documented as such (`refs.md`, `queries.md`) rather than flipped.

### Changed (breaking). Host-write-seam verb grammar

The host-write-seam handles are namespaced command buffers, so they drop the component noun
to match `ctx.commands.add` / `remove`, and their own already-bare
`spawn`, `despawn`, `disable`, `enable` and `setField`:

- `HostCommandQueue.addComponent` / `removeComponent` → `add` / `remove`.
- `Editor` and `TransactionBuilder` `.addComponent` / `.removeComponent` → `add` / `remove`
  (the two surfaces are designed to match, so they move together).
- The editor extension's entity-id parameters and its `FieldReader` type now read `entityId`,
  completing the core's `eid` → `entityId` pass.

The wire-format `kind` discriminants (`"add_component"` / `"remove_component"`), the ring
codecs, and the `HostCommand` record's `eid` field are unchanged, transport vocabulary.

### Changed (breaking). `ctx.getResource`

The in-system resource getter is now `ctx.getResource(key)` (was the verb-less `ctx.resource(key)`),
matching its flat-surface siblings `setResource` / `removeResource` / `hasResource` and the
`getField` / `setField` / `hasComponent` convention. The rule is now explicit: the flat `ctx`
surface verbs every accessor. The grouped `ecs.resources` facade drops the noun (`get` / `set` /
`remove` / `has`) because its receiver already names it. `ConditionContext` (run-condition
predicates) moves in lockstep.

### Fixed

- The immediate host spawn family (`spawn` / `spawnBundle` / `spawnMany`) now throws in DEV
  when called from inside a system body, redirecting to `ctx.commands.spawn`, like every
  other immediate host structural mutator. Previously it was silently unguarded (the archetype
  iteration guard does not cover the append path), a live mid-iteration footgun. Its guard
  docstring's "one rule for every host mutator" claim is now true.
- Added explicit public `QueryCache` cache-map type annotations so JSR publish passes
  slow-type validation and can generate package declarations cleanly.

## [0.5.0] - 2026-07-06

### Changed (breaking). Lifecycle & naming unification

One vocabulary across host, commands, and access declarations. The receiver now implies the
timing (host = immediate, `ctx.commands` = deferred). Hard renames, no deprecation aliases.
See [docs/MIGRATION-0.4-to-0.5.md](docs/MIGRATION-0.4-to-0.5.md) for the complete map of the
renames and the removals:

| 0.4 | 0.5 |
| --- | --- |
| `ecs.createEntity()` / `ecs.createEntity(template, overrides?)` | `ecs.spawn()` / `ecs.spawn(template, overrides?)` |
| `ecs.createEntities(template, count)` | `ecs.spawnMany(template, count, overrides?)` |
| `ecs.destroyEntity(e)` *(deferred)* | `ecs.despawn(e)`, **now immediate** |
| `ctx.createEntity()` | `ctx.commands.spawn()` |
| `ctx.destroyEntity(e)` | `ctx.commands.despawn(e)` |
| `ctx.addComponent(e, def, values?)` | `ctx.commands.add(e, def, values)` or `ctx.commands.add(e, def({ … }))` |
| `ctx.removeComponent(e, def)` | `ctx.commands.remove(e, def)` |
| `ctx.disable(e)` / `ctx.enable(e)` | `ctx.commands.disable(e)` / `ctx.commands.enable(e)` |
| `sourcesOf(def, tgt)` | `sourcesOf(tgt, def)`, matches `targetOf` / `targetsOf` |
| `query.count()` | `query.entityCount` (getter, beside `archetypeCount`) |
| `WorldRestoreError` / `WORLD_SNAPSHOT_VERSION` | `ECSRestoreError` / `ECS_SNAPSHOT_VERSION` |

- **Host `despawn` is immediate**, `ecs.despawn(e); ecs.isAlive(e)` is `false` on the next
  line. This removes the inconsistency: host `addComponent` was immediate, but destroy was
  buffered.
  **Observer note:** like every immediate op, host `despawn` fires no *structural* observers.
  `onRemove` no longer sees host-despawned entities (it did at 0.4, when host destroy was
  deferred). Observer-driven consumers, including the `reactive-sync` map bridges, only see
  despawns that go through `ctx.commands.despawn` or the host-command seam. (`onSet` is
  receiver-blind, derived change detection sees host `setField` writes as always.)
- **Every immediate host structural mutator throws in dev when called from inside a system
  body**, `despawn`, `addComponent` and `addComponents`, `removeComponent` and `removeComponents`,
  `batchAddComponent` and `batchRemoveComponent`, `disable` and `enable`, each error pointing at its
  `ctx.commands` equivalent. Mid-system these ops can move rows a running query is walking and
  are invisible to observers. Previously only `despawn` was guarded wholesale (the others were
  caught only when they touched the archetype being iterated). Cross-world host mutation from
  another world's system is unaffected, the guard is scoped to the mutated world.
- **The bare deferred duplicates on `ctx` are removed**, `ctx.addComponent`,
  `ctx.removeComponent`, `ctx.disable`, `ctx.enable` join the already-removed
  `ctx.createEntity` / `ctx.destroyEntity`. `ctx.commands` is now the *only* deferred surface,
  completing the receiver-implies-timing rule with zero exceptions. `ctx.commands.add` gains
  the explicit complete-values shape (`ctx.commands.add(e, Pos, { x: 0, y: 0 })`) the removed
  `ctx.addComponent` carried, so compile-checked complete attaches survive the move.
  `ctx.isDisabled` stays (immediate read), as do the immediate sparse and relation ops.
- **`sourcesOf` canonicalized to `(entity, def)`** on `ecs.relations` and `SystemContext`,
  It was the one arg-order outlier on the relation surface.
- **The package root is now a curated, explicit export list**, `export *` no longer flattens the
  whole core barrel, so future barrel additions cannot silently widen the public API. A checked-in
  public-API snapshot test makes any surface change an explicit diff in review.
- **Internal and tooling symbols moved to `@oasys/oecs/internal`** (explicitly **unstable, no semver
  guarantees**): the packed-EntityID codec (`createEntityId`, `getEntityGeneration`, `MAX_INDEX`,
  `MAX_GENERATION`, `MAX_LIVE_GENERATION`, `RETIRED_GENERATION`, `MAX_ENTITY_ID`), the SAB
  command-ring transport (`HostCommandDispatcher`, `ring*Codec`, `HOST_COMMAND_PAYLOAD_BYTES`),
  memory-sizing internals (`resolveECSMemory`, `DEFAULT_ECS_CAP_BYTES`, `BUDGET_*`), and the
  dev-mode singletons (`accessCheck`, `dispatchTrace`). `getEntityIndex` stays at the root.

### Added

- **`addComponent` bundle overload**, `ecs.addComponent(e, Pos({ x: 1 }))` accepts a bundle
  with the usual zero-fill semantics. The explicit `(e, def, values)` form stays
  complete-values, so a typo'd or missing field is still a compile error.
- **`spawnMany` typed template + shared overrides**, bulk spawn takes the same typed
  `Template<Defs>` as `spawn` plus one optional `TemplateOverrides<Defs>` object applied to
  every row (contiguous batches use one `fill` per overridden column).
- **JSDoc `@example` on the core surface**, `registerComponent`, `spawn`, `addComponent`,
  `query`, `registerSystem`, `startup`, `update`, `ctx.emit` / `ctx.read`,
  `events.register`, `resources.register` now carry hover-visible examples.
- **Component debug names**, `registerComponent(schema, { name: "Pos" })` (and the sparse
  sibling) records a diagnostic label, so access-violation and liveness errors read
  `'Pos' (component 5)` instead of leaving you to count registration order
  (`ComponentRegisterOptions`).
- **Total probes + `tryGetField`**, `hasComponent` / `hasSparse` / `relations.has` now return
  `false` for a dead entity instead of dev-throwing (a "has" probe is exactly the call made to
  avoid dead entities). `ecs.tryGetField(e, def, field)` returns `undefined` for a dead entity or
  missing component, and `ctx.tryGetField` mirrors it inside systems (declared-read checked).
- **Plural host mutators chain**, `addComponents`, `removeComponents`, `batchAddComponent`,
  `batchRemoveComponent` return `this` (previously `void`), matching their singular siblings.
- **`Query.firstEntity()` / `Query.singleEntity()`**, singleton reads (player, camera) without a
  hand-rolled `forEach` + capture. `singleEntity` dev-throws `QUERY_NOT_SINGLETON` on 0 or >1.
- **Host-side `ecs.refRead(def, e)`**, whole-component read-only view, parity with
  `ctx.refRead`.
- **Run-condition combinators**, `not()` / `allOf()` / `anyOf()`, merging the operands' declared
  read surfaces.
- **Editor change notification**, `editor.onChange(cb)` (fires on commit, undo, redo and clear) plus
  `canUndo` / `canRedo` getters. No more per-frame `depths()` polling.
- **`using` support**, `ObserverHandle` implements `Symbol.dispose`.
- **Write-seam lifecycle**, `uninstallHostCommandSeam(world, queue)`,
  `HostCommandQueue.clear()`, `HostCommandDispatcher.off(opCode)`,
  `HostCommandRecorder.snapshotLog()` (stable deep copy).
- **`VERSION`** export and a `"./package.json"` export. `engines: { node: ">=20" }` and a README
  runtime note (resizable `ArrayBuffer`).
- Root re-exports so failure modes are nameable without extra entry points:
  `StoreRestoreError`, `SabUnavailableError`, `TypedArrayTag`. `/reactive` now exports `Eq` and
  `shallow` (moved from `/reactive-sync`, which re-exports for compat). `signal()` gains the
  zero-arg Solid-parity overload. `SingletonSyncOptions.eq`.
- **`FrameStepper`**, optional host-side driver over the authoritative `ecs.update(dt)`:
  `play()`, `pause()` and `toggle()` on `requestAnimationFrame` (injectable `requestFrame` and `cancelFrame`
  for tests and non-browser hosts), explicit `step()` and `stepFrames()` for debuggers, editors, and
  rollback playback, and a `maxDt` clamp (default 0.25 s) so a resumed background tab doesn't feed
  the whole suspension into the accumulator as one delta. Validation throws `INVALID_FRAME_STEP`.
- **`ObserverConfig.name`**, diagnostic label surfaced as the frame trace's
  `observer_fired.observer` field (the role a system's `name` plays). Observe-only, never affects
  `stateHash` or dispatch order. Unnamed observers fall back to `observer(<component debug name>)`
  when the component was registered with a name, else `observer(<cid>)`.
- **`ECSOptions.onWarn`**, injectable sink for dev-mode engine diagnostics (currently the
  schedule's dropped-ordering-edge warning and the `ECSOptions` unknown-key warning),
  defaulting to `console.warn`. Replaces the internal `src/log` singleton, which is deleted.
- **Editor `fieldHandle` `read` thunk is optional**, defaults to `Editor.committedField`.

### Fixed

- **Host iteration guard (`STRUCTURAL_DURING_ITERATION`)**, with host `despawn` now immediate,
  a host-side `forEach` and `eachChunk` callback that despawned (or transitioned and toggled) an entity of
  the archetype it was visiting silently skipped entities via the row swap-remove. Row-removing
  ops on an archetype a live dense walk is standing in now throw in dev, *before* any mutation
  lands (the transition path checks ahead of the destination append, so no dual-residency
  half-state). Collect ids during the walk and mutate after it. Mutating archetypes the walk is
  *not* currently visiting stays legal, the fresh-snapshot machinery still covers those.
- **Cross-world despawn false positive**, `worldB.despawn(e)` from inside world A's system no
  longer trips the in-system despawn guard (the accessCheck span is process-global, the guard now
  also requires *this* world to be mid-schedule). Driving a second world from a system
  mutates it host-style, which is safe. B is not iterating. Unnamed systems in the guard message
  now render as `system_<id>` instead of `'?'`.
- **Frame trace records every deferred command**, the removed bare `ctx.*` deferred
  forms bypassed the `commandQueued` trace hook, so host-command-seam adds, removes and toggles (and
  any system using the bare forms) were invisible to an attached `FrameTraceSink` while their
  spawns and despawns were visible. With `ctx.commands` as the only deferred surface every queued
  command is traced, and `ctx.commands.spawn` now also traces each bundle attach it queues
  (previously only the spawn itself).
- **Stale deferred-attach docs**, `host_commands.ts` / the host-write-seam page claimed the
  deferred add path does not zero-fill omitted fields (NaN readback). Every attach path
  zero-fills (`writeFields`'s `?? 0`). The complete-values requirement on
  `SpawnEntry` is documented as what it is, explicit intent in a reified, replayable record.
  The observer docs now scope "immediate ops fire no observers" to *structural* observers
  (`onSet` is derived change detection and sees host `setField` writes).
- **`ecs.refRead` / `ctx.ref` / `ctx.refRead` on a missing component or tag def**, threw a raw
  `TypeError` from the ref internals. Now a dev `ECSError` (`COMPONENT_NOT_REGISTERED`) naming the
  op and component, matching `getField`. Host `refRead`'s docstring now states the single-
  expression lifetime rule (any immediate structural mutation can row-swap under a held ref).
- **Editor: aborted transactions no longer poison undo**, `transaction(tx => …)` staged its
  `setField` shadow writes into the editor's shared map at build time, so a build callback that
  threw left phantom pending values behind and seeded the *next* edit's undo inverse with a value
  the world never held. Staging is now transaction-local and merges only on commit.
- **Editor: `pendingField` self-resolves for dead slots**, a shadow entry for a despawned entity
  (or removed component) echoed its stale value forever and leaked. The reconcile-on-read now
  prunes it and returns `undefined`.
- **JSR or Deno consumers no longer break on the `__DEV__` global**, shipped source now reads a
  guarded `DEV` flag (`src/dev_flag.ts`) that constant-folds in the npm bundle and defaults to
  dev-on for raw-source consumers (`globalThis.__DEV__ = false` opts out).
- **Error experience**, every `ENTITY_NOT_ALIVE` names the operation and decodes the packed id
  (index + generation, with context). System access violations use the new `ACCESS_UNDECLARED`
  category instead of overloading `*_NOT_REGISTERED`. Resource and event "not registered" messages
  name the key and hint the registration call. Messages no longer reference pre-0.4 snake_case
  option names or private tracker issue numbers.
- **Packaging**, per-entry `.d.cts` and explicit-extension declaration specifiers
  (`attw --pack` fully green: node10/node16/bundler across all eight entry points, was
  masquerading + resolution errors). `typesVersions` for `moduleResolution: node10` subpaths. Npm
  tarball ships `CHANGELOG.md`. `@internal` editor internals no longer leak into published types.
- **Type-level closures**, `EventShape<S>` homomorphic bound (interface-declared event schemas
  now accepted). `RelationOptions` is a union so `{ exclusive: true, multi: true }` is a compile
  error. `ResourceKey`'s phantom is a unique symbol (no `.__phantom` in autocomplete)
  `pairsOf` / `sourcesOfAny` return readonly tuples. `SystemConfig.fn` optional when
  `backendHandle` is present.
- Dev-mode diagnostics: ownerless `computed()` / `onCleanup()` warn (kernel). ECSOptions warns on
  unknown keys. `runIfResourceEq` warns on object-valued `expected` (reference-identity `===`)
  `runEveryNTicks` validation throws `ECSError` (`INVALID_RUN_CONDITION`).
- **Docs standardized on the `ecs` receiver**. README, GETTING_STARTED, BEST_PRACTICES, the
  api reference, and every in-source JSDoc example now spell `const ecs = new ECS()`
  (with the `World*` names renamed to `ECS*`, "world" survives only as prose). The
  host-write-seam docs now explain *why* `queue.spawn` takes complete-value `spawnEntry`s
  rather than zero-filling bundles: commands are a reified, replayable record, complete
  values are explicit intent legible to replay, not a correctness need. The deferred add path
  zero-fills omitted fields.
- **JSR publish no longer ships `__tests__` helper files** (`casing_codemod.ts`,
  `test_helpers.ts`, including a `node:fs` import subject to JSR type-checking).

### Changed (breaking). Type-level & facade surface

- **Compile-time typestate across the system, query, relation, and key seams.** The config-form
  `registerSystem` now infers your access declarations as literal types and hands `fn` and `onAdded` a
  `SystemContext<DeclaredAccess<…>>` narrowed to exactly the declared surface, undeclared access
  is a compile error naming the missing declaration, with the dev-mode runtime check remaining as
  the backstop for dynamic values. Query columns are typed by the query's terms
  (`ChunkColumns<Defs>` / `ArchetypeView<Defs>`, `.and(...)` extends the term set), relation
  handles carry their cardinality (`RelationDef<"exclusive">` vs `RelationDef<"multi">`, the
  exclusive-only traversal surfaces reject a multi handle at compile time), and
  `ResourceKey`, `EventKey` and `EventDef` are invariant so a key can no longer widen through
  `unknown`. A checked-in type battery (`typing_assertions.ts`) pins every rule.
- **Grouped facades: `ecs.relations`, `ecs.events`, `ecs.resources`, `ecs.snapshots`.** Cohesive
  secondary surfaces move off the flat namespace onto narrow typed facades:
  `ecs.relations.add(child, ChildOf, parent)`, `ecs.events.emit(Damage, {...})`,
  `ecs.resources.get(Time)`, `ecs.snapshots.capture()`. The facades mirror the typestate
  surface exactly (cardinality-stamped `relations.register`, exclusive-only traversal). Hot-path
  API (component ops, queries, spawn and destroy, sparse ops) stays flat by design. Facade classes
  are exported type-only. The runtime export list is unchanged.
- **Value arguments are schema-checked at compile time across every attach seam.** Tag defs
  reject value objects (`Frozen({ x: 1 })` no longer compiles, tags carry no data)
  `addComponents` takes schema-checked entries (`TemplateEntries<Defs>`), so a misspelled or
  cross-component field key is a compile error instead of a silent zero-fill. Host-seam
  `queue.spawn` entries (`SpawnEntries<Defs>`) are checked complete against each def's own
  schema (`ValuesArg` / `CompleteFieldValues` exported), and `events.register` requires the
  field list to cover the event schema (`EventFieldsCover`), a partial list silently dropped
  columns and read back `undefined` at runtime. Smaller closures in the same vein: `observe`
  accepts any `ComponentHandle`, `NoInfer` pins key-typed value params (`events.emit`,
  resources), and reactive-sync's `JoinReader.field` is constrained to the join's component
  set.

### Removed (breaking)

- The 29 flat forms the new facades replace (`registerRelation`, `addRelation` and `targetOf`/…,
  `registerEvent`, `registerSignal`, `emit` and `read`, `registerResource`, `resource` and `setResource`/
  `removeResource` and `hasResource`, `snapshot`, `restoreInto`, `snapshotSparse` and `restoreSparse`/
  `stateHash` and `deterministic`, `relationCount` and `compactRelations`). Each maps 1:1 onto its
  grouped replacement, `ecs.relations.add(...)`, `ecs.events.emit(...)`, `ecs.resources.get(...)`,
  `ecs.snapshots.capture()` (was `snapshot()`) / `ecs.snapshots.restore(...)` (was
  `restoreInto(...)`), `ecs.relations.count` (was `relationCount`), `ecs.relations.compact()`
  (was `compactRelations()`). System-side `ctx.*` and all `Store`-level methods are unchanged.

### Changed (internal)

- **`Store` decomposed into seven focused collaborators** (RelationService, EventRegistry +
  ResourceRegistry, EntityAllocator, DeferredCommandBuffer, SnapshotService, ArchetypeGraph) with
  `Store` as the coordinator. The hot-path extractions were A/B-benchmarked against
  identical-code controls with no regression. The `ECS` facade's pure delegations now live in a
  marker-delimited pass-through band whose logic-free invariant is enforced by an ast guard test.
- Typed per-consumer host seams (`ObserverHost`, `QueryHost`) replace underscore-convention
  reach-through on `Store`. `QueryCache` now owns all 12 query-resolution cache maps.
- Store layer consolidation: one strategy-parameterized factory behind
  `growableSabAllocator` / `heapArraybufferAllocator`. A typed `isColumnStoreInternal` guard
  replaces six structural casts. Grow and extend's ~200 duplicated lines moved to a shared
  `layout_ops.ts` (bit-identical layouts pinned by a golden differential test across the
  full allocator matrix).
- `core/reactive` moved to `src/reactive` (the published `./reactive` subpath is unchanged)
  `__generated__/abi.ts` renamed to `vendored_abi/abi.ts` (it is a hand-maintained snapshot,
  not generated output).
- Deleted orphaned duplicate `src/utils/{arrays,constants}.ts`. Renamed the custom `TypeError`
  (shadowed the ECMAScript global) to `AssertionError`. Retired the 246-line casing codemod +
  guard test (the 0.4 rename has converged).

## [0.4.0] - 2026-06-24

Major release. oecs is **re-derived from the upstream oasys engine ECS**, its modern descendant, and
gains whole subsystems while staying pure-TS and zero-dependency by default. The public API moves to
the engine's surface, so **every consumer touches breaking changes**, chiefly a global
`snake_case` → `camelCase` rename. See [docs/MIGRATION-0.3-to-0.4.md](docs/MIGRATION-0.3-to-0.4.md).

### Changed (breaking)

- **The entire public API is now `camelCase`.** Every method, property, parameter, and field renamed
  from `snake_case` (`create_entity` → `createEntity`, `add_component` → `addComponent`, `get_field` →
  `getField`, `is_alive` → `isAlive`, `register_system` → `registerSystem`, …). Types and handles stay
  PascalCase and SCREAMING_SNAKE constants are unchanged. A `vitest` casing guard prevents regressions.
- **Renamed query and context verbs.** `QueryBuilder.every` → `with`. `query.not` → `without`
  `query.any_of` → `anyOf`. `query.for_each` → `forEach`. `archetype.get_column` → `getColumnRead`
  `event_key` / `signal_key` / `resource_key` → `eventKey` / `signalKey` / `resourceKey`
  `is_ecs_error` → `isEcsError`. `destroy_entity_deferred` → `destroyEntity` (still deferred).
- **Ref mutability flipped on the unsuffixed name.** `ctx.ref` is now the **mutable** default (was
  read-only in 0.3). The read-only variant is `ctx.refRead` (was `ctx.ref_mut` for the mutable one).
  Same rule for columns: mutable `getColumn` (internal) vs read-only `getColumnRead`.
- **`WorldOptions` → `ECSOptions`. `fixed_timestep` → `fixedTimestep`.**
- **`initial_capacity` removed**, replaced by the `memory` surface (`memory: { budget }` /
  `{ maxBytes }` / `{ columnCapacity }` pin / `{ shared }` / `{ wasm }` / `{ allocator }`). Passing the
  old option keys throws at construction, pointing at `memory`.
- **Component-touching systems must declare `reads` / `writes`.** A new `__DEV__` access checker
  (tree-shaken from production) validates every column, ref, field and resource access against a
  system's declared surface. The bare `(ctx, dt)` and `(q, ctx, dt)` + query-builder `registerSystem`
  overloads declare no access, so a system that touches ECS data through them throws in dev, move it
  to the config form (`registerSystem({ reads, writes, fn })`). `exclusive: true` systems bypass the
  checker. A registration-time lint (`QUERY_ACCESS_UNDECLARED`) additionally checks any declared
  `queries ⊆ reads ∪ writes`.
- **`removeComponents` takes an array, not varargs** (`removeComponents(e, [A, B])`)
  `batchAddComponent` / `batchRemoveComponent` key on `ArchetypeID` instead of an `Archetype` object.
- **Event schema shape.** `eventKey`'s type parameter is now a field → value-type record
  (`eventKey<{ target: EntityID; amount: number }>("Damage")`) rather than a tuple of field names, so
  branded fields round-trip through `emit` / `read`. `registerEvent(key, [...fieldNames])` unchanged
  otherwise.

### Added

- **Two storage profiles over one backing-neutral `ColumnStore`.** Default is pure-TS **heap** (a plain
  resizable `ArrayBuffer`), no `SharedArrayBuffer`, no cross-origin isolation. Opt-in
  `@oasys/oecs/shared` (`memory: { shared: {} }`) uses a `SharedArrayBuffer` for worker offload / a WASM
  compute backend. Same code path. Identical state hash.
- **Determinism** (opt-in `deterministic: true`): a state hash over column bytes + `snapshot()` /
  `restoreInto()` (and `snapshotSparse` / `restoreSparse`), **backing-agnostic**, a heap world and a
  shared world with identical history agree. `WorldRestoreError` / `SparseRestoreError` fail closed
  before overwriting live backing.
- **Observers**, `world.observe(def, { onAdd, onRemove, onSet, onDisable, onEnable })`, structural +
  per-entity.
- **Relations**, `(relation, target)` pairs, `ChildOf` / `IsA` presets (`registerChildOf` /
  `registerIsA`), `(R,*)` / `(*,T)` wildcard queries (`withRelation`, `forEachRelatedTo`,
  `ANY_RELATION`), hierarchy queries (`query.hierarchy`), traversal (`ancestorsOf` / `rootOf` /
  `cascadeOf`), and on-delete cleanup policies.
- **Sparse component storage** (`registerSparseComponent` / `addSparse` / `query.withSparse`),
  **run conditions and system sets** (`systemSet` + `configureSet`, `runIfResourceEq` / `runEveryNTicks`
  / `runIfAnyMatch`), **entity enable and disable** (row-partitioned. `disable` / `enable` /
  `includeDisabled`), and **templates** (`world.template([...])` + `createEntity(template, overrides)`
  / `createEntities(template, count)` for zero-transition spawns).
- **Typed host→ECS write seam**, `installHostCommandSeam(world)` + `applyHostCommand` + a
  `HostCommandQueue` drained by a blessed `exclusive` apply system. A cross-thread ring transport
  (`HostCommandDispatcher`). Record and replay (`HostCommandRecorder`, `replayCommandLog`,
  `serializeCommandLog`), and an undo and redo + field-handle layer at `@oasys/oecs/editor`.
- **Frame trace**, `world.setTrace(sink)` + `FrameTraceRecorder` emit a structured per-frame event
  stream (`__DEV__`-gated). **Compute backend seam**, `world.attachBackend(backend)` runs a system's
  body on a compiled backend instead of its TS closure.
- **Reactive UI seam (optional):** zero-dependency kernel at `@oasys/oecs/reactive`. ECS→reactive
  bridge at `@oasys/oecs/reactive-sync` (publish-only-dirty, O(changed)). SolidJS adapter at
  `@oasys/oecs/solid` with `solid-js` as an **optional** peer dependency.
- **`memory` sizing surface** on the constructor: `budget` (by expected `entities`) / `maxBytes` /
  `columnCapacity` / `shared` / `wasm` / `allocator` arms. `resolveECSMemory(...)` exported to inspect
  what an intent resolves to.
- **Hot-path iteration ergonomics:**
  - **`query.eachChunk((cols, count) => …)`**, the mutable per-archetype iterator. `cols.mut(def)` /
    `cols.read(def)` resolve a whole component's field columns at once into a destructurable group
    (`const { x, y } = cols.mut(Pos)`), stamping the change tick once inside `mut` and handing back
    `count` (= `entityCount`). The only mutable column accessor reachable through iteration (the
    `ArchetypeView` from `forEach` stays read-only). Honours `includeDisabled()`. Dense-only like `forEach`.
  - **`ctx.commands`**, a Bevy-`Commands`-style facade namespacing the **deferred** structural ops
    (`spawn` / `add` / `remove` / `despawn` / `disable` / `enable`), unambiguously deferred vs the
    immediate `world.addComponent`.
  - **Callable bundles**, `bundle(def, values)` pairs a def with field values (omitted fields
    zero-fill). `world.spawnBundle(...)` (immediate) and `ctx.commands.spawn` / `.add` (deferred)
    accept a `bundle(...)` or a bare def (tag / all-zero), unifying the attach shapes.
  - **`ctx.updateField` / `ctx.markChanged`**, and optional-component queries (`query.optional(...)` +
    `getOptionalColumnRead`).
- **Composable change-detection queries**, `query.changed(...)` returns a `ChangedQuery` that now
  mirrors the dense query verbs (`and` / `without` / `anyOf` / `optional`), so
  `q.changed(Pos).without(Dead)` works (refining *after* `changed()`, previously a dead end).
- **New public exports**, entity-ID codec (`createEntityId` / `getEntityIndex` / `getEntityGeneration`
  + `MAX_*` bounds) for snapshot and replication decode. The error taxonomy (`ECSError`, `ECS_ERROR`,
  `isEcsError`) for catch-and-branch, and `@oasys/oecs/primitives` (`BitSet`, `SparseSet`, `SparseMap`,
  growable typed arrays, `BinaryHeap`, `topologicalSort`).

### Packaging

- **Multi-entry build** → `dist/` emits ESM + CJS + `.d.ts` for every subpath (`.`, `/primitives`,
  `/shared`, `/reactive`, `/reactive-sync`, `/editor`, `/solid`). `sideEffects:false` + tree-shaking
  keep core consumers from pulling SAB / Solid. `solid-js` is an optional peer dependency. `jsr.json`
  exports updated.

## [0.3.3] - 2026-04-30

Release-process and packaging hygiene. No runtime changes.

### Changed

- **JSR bundle slimmed.** `.github/` and `docs/` are now excluded from the published JSR package. Consumers download less. Build and CI artefacts stay on GitHub.
- **Tag-driven publish workflow.** `.github/workflows/publish.yml` now triggers on `v*` tag pushes instead of every push to `main`, and creates a GitHub Release alongside the JSR publish. Cuts a release by tagging.

## [0.3.2] - 2026-04-30

Documentation-only release. No runtime changes.

### Added

- **Module overview on `src/index.ts`.** A `@module` block now renders as the JSR Overview tab.
- **JSDoc on the full public surface.** `ECS` and its public methods, `Query` / `QueryBuilder` / `SystemContext` / `ChangedQuery`, all type aliases and interfaces, the event and resource key minters, and the `SCHEDULE` phases are now documented in-source.
- **`@internal` tags on internal-but-public TS members** (e.g. `_resolve_query`, `Query._include`, `SystemContext.store`) so JSR hides them from the rendered docs.

## [0.3.1] - 2026-04-23

Performance-only patch release. Two targeted allocation-elimination changes on hot paths. No API changes. Full 466-test suite unchanged.

### Performance

- **Cache multi-component transition maps on `Archetype`.** `add_components` / `remove_components` on already-populated entities previously allocated a fresh `Int16Array` per call via `build_transition_map`. A per-archetype `batch_transition_maps: Map<ArchetypeID, Int16Array>` now caches the map on first use. Single-component paths unchanged. Measured on the same workload: a higher throughput of `add_components` on an already-populated entity, a much smaller peak heap, and a much smaller peak RSS. ([#9](https://github.com/oasys-works/oecs/pull/9))
- **Per-Query composition cache for single-component composition shapes.** `q.and(X)`, `q.not(X)`, `q.any_of(X)`, and `q.changed(X)` previously allocated a BitSet copy, a defs slice (and, for `.changed`, a new `ChangedQuery`) on every call, even though the resolver already cached the resulting `Query` object. Single-component calls now short-circuit through a per-parent-`Query` Map and skip the allocation path entirely. Multi-component compositions fall through unchanged. Measured on a compose loop with four shapes: a much higher throughput, a much smaller peak heap, and almost no growth of RSS during the workload. ([#10](https://github.com/oasys-works/oecs/pull/10))

## [0.3.0] - 2026-04-21

A substantial release focused on change detection, stricter component-access
typing, and a simpler key-based API for events and resources. Several public
entry points change shape. See the migration notes under *Breaking changes*.

### Added

#### Change detection

- Frame-based tick counter on the world. `ECS` now holds a `_tick` that
  advances once per `update()`. Systems can see it via `ctx.world_tick`,
  and each `SystemContext` receives `last_run_tick`, the tick at which that
  system last executed.
- Per-component change ticks on archetypes. Each archetype tracks
  `_changed_tick[component_id]`, the tick at which any entity in that
  archetype last had the component mutated. Maintained automatically by
  `write_fields`, `write_fields_positional`, `copy_shared_from`,
  `move_entity_from`, and `bulk_move_all_from`, all of which now accept a
  `tick` parameter.
- `ChangedQuery<Defs>`, a new query variant, produced by `query.changed(...)`,
  that restricts iteration to archetypes whose tracked components were
  modified after `last_run_tick`. Validates at construction that the named
  components are part of the parent query's include set.

#### Readonly component views

- `ReadonlyColumn<T>` and `ReadonlyUint32Array`, compile-time readonly views
  of typed-array columns. Returned by `archetype.get_column()` and the new
  `archetype.entity_ids` getter. Prevents accidental indexed writes at the
  type level. Zero runtime cost.
- `ReadonlyComponentRef<S>`, readonly variant of `ComponentRef`. Returned by
  `query.ref(...)`. Use it when you only need to read component fields.
- `archetype.get_column_mut(def, field, tick)`, explicit mutable column
  accessor. Writes through `get_column_mut` update `_changed_tick`.
- `query.ref_mut(...)`, mutable sibling of `ref()`. Returns a `ComponentRef`
  and records the component as changed for the current tick.

#### Key-based Event API

- `EventKey<F>`, symbol-typed key that carries the event's field schema as
  a phantom type.
- `event_key<F>(name)` / `signal_key(name)`, factories for module-scope
  event keys. `signal_key` is a convenience wrapper for zero-field events.

#### Key-based Resource API

- `ResourceKey<T>`, symbol-typed key carrying the resource's value type as
  a phantom type.
- `resource_key<T>(name)`, factory for module-scope resource keys.
- `world.has_resource(key)`, existence check.
- Resources are now plain key→value storage. `world.resource(key)` returns
  the stored `T` directly.

#### Errors

- New `ECS_ERROR` categories: `RESOURCE_ALREADY_REGISTERED`,
  `EVENT_ALREADY_REGISTERED`, `EVENT_NOT_REGISTERED`.
- New `TYPE_ERROR` category: `ASSERTION_FAIL_NON_NULLABLE`, emitted by the
  new `assert_non_null` helper.

#### Assertions

- `assert_non_null<T>(value, message?)` in `type_primitives/assertions`, a
  dev-only (`__DEV__` guarded) assertion that narrows `T` to `NonNullable<T>`
  and throws a `TypeError` with contextual info on failure.

#### New primitives

- `BinaryHeap<T>` in `type_primitives/binary_heap`, generic array-backed
  heap with a user-supplied comparator. `push`, `pop`, `peek`, `clear`,
  `size`. O(log n) push and pop, O(1) peek.
- `topological_sort<T>(nodes, edges, tiebreaker, node_name?)` in
  `type_primitives/topological_sort`. Kahn's algorithm with a
  `BinaryHeap`-backed ready queue for deterministic tie-breaking. Throws
  `TypeError` on cycles. The schedule layer re-wraps as
  `ECSError(CIRCULAR_SYSTEM_DEPENDENCY)`.

#### Public exports

- `SystemFn`, `ReadonlyComponentRef`, `ChangedQuery`, `ReadonlyColumn`,
  `ReadonlyUint32Array`, `EventKey`, `event_key`, `signal_key`,
  `ResourceKey`, `resource_key` are now part of the package surface.

### Changed

- Query iteration is callback-based. `Query` no longer implements
  `[Symbol.iterator]`. Iterate with `query.for_each((archetype) => { ... })`.
- `world.register_event`, `world.register_signal`, and `world.register_resource`
  return `void` and take an `EventKey` / `ResourceKey` as their first argument.
- `world.emit`, `world.read`, `world.resource`, and `world.set_resource`
  accept keys instead of definition objects. `world.resource(key)` returns
  the typed value `T` directly rather than a field-reader wrapper.
- Schedule execution methods take a tick. `run_startup(label, tick)`,
  `run_update(label, tick)`, and `run_fixed_update(label, tick)` require
  the current frame tick. `ECS.update()` wires this automatically.
- System ordering now uses the shared `topological_sort` primitive. Observable
  behavior is unchanged: `before` and `after` constraints respected,
  `insertion_order` remains the tie-breaker, cycles surface as
  `ECSError(CIRCULAR_SYSTEM_DEPENDENCY)`.
- Store and query wiring. The store keeps a reference to each active `Query` via
  `update_query_ref` and calls `mark_non_empty_dirty` only when structural
  changes occur, avoiding spurious query rebuilds on stable frames.
- Bit-manipulation and hash constants (`BITS_PER_WORD`, `BITS_PER_WORD_SHIFT`,
  `BITS_PER_WORD_MASK`, `FNV_OFFSET_BASIS`, `FNV_PRIME`) are exported from
  `type_primitives/bitset` rather than `utils/constants`.
- Growable-array defaults (`DEFAULT_INITIAL_CAPACITY`, `GROWTH_FACTOR`) are
  exported from `type_primitives/typed_arrays`.

### Fixed

- Query dirty propagation. `flush_destroyed` now marks affected queries dirty
  so subsequent iteration sees the correct archetype set. `flush_structural`
  skips dirty marking when no changes occurred.
- `set_field` on the world goes through `get_column_mut` with the current
  tick, so mutations via the high-level API are visible to `ChangedQuery`.

### Removed

- `ResourceChannel`, `ResourceDef<F>`, `ResourceReader<F>`, `ResourceID`,
  `as_resource_id`, and the `__resource_schema` marker symbol, the entire
  SoA column-based resource storage layer. Resources are now key→value.
- `RESOURCE_ROW` constant, unused.
- `EventDef<F>`, replaced by `EventKey<F>`.

### Breaking changes

1. **Event definitions.** Define a key at module scope, then register and use it:
   ```ts
   // before
   const damage = world.register_event({ amount: "u32" } as const);
   world.emit(damage, { amount: 5 });

   // after
   const DAMAGE = event_key<{ amount: "u32" }>("damage");
   world.register_event(DAMAGE, { amount: "u32" } as const);
   world.emit(DAMAGE, { amount: 5 });
   ```

2. **Resource registration / access.**
   ```ts
   // before
   const clock = world.register_resource({ ms: "u32" } as const, { ms: 0 });
   const ms = world.resource(clock).ms;

   // after
   const CLOCK = resource_key<{ ms: number }>("clock");
   world.register_resource(CLOCK, { ms: 0 });
   const ms = world.resource(CLOCK).ms;
   ```
   `world.resource()` returns the stored value directly. The reader wrapper
   and the SoA column storage are gone.

3. **Query iteration.**
   ```ts
   // before
   for (const arch of query) { ... }

   // after
   query.for_each((arch) => { ... });
   ```

4. **Mutable vs readonly refs.** `query.ref(...)` now returns
   `ReadonlyComponentRef`. Switch to `query.ref_mut(...)` when you write, because
   this is also what enables change detection for that component.

5. **Archetype column access.** `archetype.get_column(...)` returns a
   `ReadonlyColumn`. Use `archetype.get_column_mut(def, field, tick)` for
   direct writes. Most callers should use `query.ref_mut` and won't notice.

6. **Schedule driver signatures.** If you drive the scheduler directly
   (bypassing `ECS.update()`), `run_startup`, `run_update`, and
   `run_fixed_update` now require a `tick: number` argument.

## [0.2.1] and earlier

Prior releases, see git history.
