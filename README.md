# oecs

**A complete, archetype-based Entity Component System for TypeScript.**

`@oasys/oecs` gives you more than storage and queries. It gives you the tools that a mature engine
has:

- observers
- relations with wildcards
- sparse storage
- system sets and run conditions
- enable and disable for an entity
- templates
- deterministic hashing, with snapshot and restore
- a typed write path from the host into the ECS
- one system across a pool of workers, with a WASM or a JavaScript kernel
- an optional Solid plugin, for a UI

The package is **pure TypeScript, and it has no dependencies by default**. It runs over one plain
`ArrayBuffer`. So it does not need a `SharedArrayBuffer`, and it does not need cross-origin
isolation (COOP and COEP). An optional shared-memory profile uses a `SharedArrayBuffer` instead. Use
that profile for worker offload, or for a WASM compute backend. The two profiles use one core, and
they agree byte-for-byte on `stateHash`.

- **Data-oriented**. Columns use struct-of-arrays storage, grouped by archetype. Iteration is a
  small loop over typed arrays. The loop allocates no object for each entity.
- **Type-safe**. A component handle is a callable definition. It has a stable numeric id at run
  time and a full schema type at compile time. A field name with a spelling error is a compile
  error.
- **Deterministic**. An optional mode gives you a `stateHash` that is independent of the storage
  type. It also gives you snapshot, restore, and replay of a command log.
- **Complete**. The features below are the full engine. They are not only a start.

## Installation

```bash
pnpm add @oasys/oecs        # npm, pnpm or yarn
# or
deno add jsr:@oasys/oecs    # JSR (Deno)
# or
npx jsr add @oasys/oecs     # JSR (npm-compatible)
```

Supported runtimes: Node 20 or later, Deno 1.38 or later, Chrome 111 or later, Firefox 128 or
later, and Safari 16.4 or later. The default heap profile uses a plain, fixed `ArrayBuffer`. The
optional shared and WASM profiles need a growable `SharedArrayBuffer` or `WebAssembly.Memory`, and
those requirements set the version limits.

## Quick start

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const ecs = new ECS(); // the pure-TS heap profile, and no SharedArrayBuffer needed

// Components. The record syntax gives a type to each field. The array shorthand uses "f64".
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent(["vx", "vy"] as const);

// A query is a live, cached view of the matching archetypes. Build it once, then use it again.
const movers = ecs.query(Pos, Vel);

// Systems declare the components that they read and write (checked in development builds).
const move = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos], // a declared write also gives read access to the same component
  fn: (ctx, dt) => {
    movers.forEachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);    // the full group. Sets the change tick of Pos one time
      const { vx, vy } = cols.read(Vel); // a read-only group
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});

ecs.addSystems(SCHEDULE.UPDATE, move);
ecs.startup();

const e = ecs.spawn();
ecs.addComponent(e, Pos, { x: 0, y: 0 });
ecs.addComponent(e, Vel, { vx: 100, vy: 50 });

ecs.update(1 / 60);
ecs.getField(e, Pos, "x"); // about 1.667
```

## Features

**Storage and the data model**

- **Archetype storage in struct-of-arrays form**, above a storage-neutral `ColumnStore`. Entities
  with the same set of components share adjacent typed-array columns. Loops use the cache well, and
  they allocate no object for each entity.
- **Components with phantom types**. `registerComponent({ x: "f64", y: "f64" })` gives you a
  callable `ComponentDef`. The definition has a stable numeric `.id` at run time and a full schema
  type at compile time. Use the record syntax for different types in each field. Use the array
  shorthand when all fields are `f64`. Use `registerTag()` for markers that hold no data. The field
  types are `f32 f64 i8 i16 i32 u8 u16 u32`.
- **Two storage profiles, one core**. The default is a pure-TS heap (`ArrayBuffer`). A
  `SharedArrayBuffer` for workers or WASM is optional. The code path is the same, the `stateHash`
  is the same, and one `memory` option sets the size (a number of entities, a byte limit, or a
  fixed capacity). Size and storage are separate fields, so any pair of them is legal. The shared
  allocators are `growableSabAllocator`, `fixedSabAllocator` and `wasmMemoryAllocator`, from
  `@oasys/oecs/shared`. `fixedSabAllocator(maxBytes)` reserves one buffer that never grows, and it
  keeps the fast write path on JavaScriptCore.

**Queries**

- **Live, cached queries**. Write `ecs.query(Pos, Vel)`, then make it more exact with `.and()`,
  `.without()`, or `.anyOf()`. The store adds new matching archetypes to the query automatically.
- **Two iteration verbs**. Use `forEach(arch => …)` to read archetypes. Use
  `forEachChunk((cols, count) => …)` for the high-frequency loop that writes. In that loop, `cols.mut`
  and `cols.read` give you all the columns of one component at the same time.
- **Change detection**. Each `(archetype, component)` pair has a change tick.
  `query.changed(Pos)` visits only the archetypes that changed at or after the threshold tick of
  the system.
- **Queries for relations and hierarchies**. Use the wildcards `(R, *)` and `(*, T)`, plus
  `forEachRelatedTo` and `query.hierarchy(rel, depth)`. For **sparse queries**, use
  `query.withSparse(...)`. Queries skip disabled entities. To include them, use
  `query.includeDisabled()`.

**Systems and the schedule**

- **Systems that declare their access**. A system is a plain function in a `SystemConfig` that
  declares `reads` and `writes`. A development-mode access checker holds you to that declaration,
  and the build tool removes that checker from a production build. There are also `(ctx, dt)` and
  `(q, ctx, dt)`
  forms with a query builder, for connection code that touches no data. The lifecycle hooks are
  `onAdded`, `onRemoved`, and `dispose`. Set `exclusive: true` for full-world setup or teardown.
- **A topological scheduler**. There are seven phases: `PRE_STARTUP`, `STARTUP`, `POST_STARTUP`,
  `FIXED_UPDATE`, `PRE_UPDATE`, `UPDATE`, and `POST_UPDATE`. Each phase does a Kahn sort on the
  `before` and `after` constraints. Insertion order breaks a tie, which keeps the result
  deterministic. Cycle detection is always active.
- **A fixed timestep**. An accumulator loop uses the `fixedTimestep` value that you set. A limit
  protects against the spiral of death.
- **System sets and run conditions**. Use `systemSet(...)` with `configureSet(...)`. The supplied
  conditions are `runIfResourceEq`, `runEveryNTicks`, and `runIfAnyMatch`. You can also write your
  own `RunCondition`.

**Structural changes**

- **Deferred in a system, immediate on the host**. `ctx.commands` is a facade in the style of the
  Bevy `Commands` type. It holds add, remove, despawn, enable, and disable operations until the
  flush at the end of the phase, so that iterators stay correct. `commands.spawn` gives you the id
  immediately, but it attaches the components later. Each mutation on the host
  (`ecs.addComponent`, `ecs.removeComponent`, `ecs.despawn`, `ecs.disable`, and `ecs.enable`)
  applies immediately.
- **Enable and disable for an entity**. Use `disable`, `enable`, and `isDisabled`. Disabled rows
  stay in a partition at the end of the archetype, and queries skip them by default.
- **Templates and bundles**. `ecs.template(Pos({ x, y }), …)` makes a blueprint. `spawn` and
  `spawnMany` use that blueprint to create entities with no archetype transition. The same callable
  bundles are the arguments to `spawnBundle(...)` and `addComponents(...)`.

**Reactions and relationships**

- **Observers** (the `observers()` plugin). `ecs.observe(...)` registers `onAdd`, `onRemove`,
  `onSet`, `onEnable`, and `onDisable` callbacks, for a structure or for one entity. A sparse
  component takes the entity-level `onSet`.
- **Change detection at the row grain**. `ecs.trackRows(def)` keeps a change tick for each row.
  A chunk loop records a row with one store into `cols.ticks(def)`, a reader compares
  `cols.ticksRead(def)` with `cols.since` inside `changed(def).forEachChunk`, and
  `ctx.sparseChanged(def, e)` asks the same of a sparse component.
- **Relations** (the `relations()` plugin). A relation is a `(relation, target)` pair. The
  presets are `ChildOf` and `IsA`.
  A relation is exclusive or multi. Queries go in both directions (`targetOf`, `sourcesOf`,
  `ancestorsOf`, `rootOf`, and `cascadeOf`). The cleanup policy for a deleted target is
  `delete`, `clear`, or `orphan`. Relations use sparse storage. So they cause no archetype
  transition, and they use no identity bit.
- **Sparse storage**. Use `registerSparseComponent` and `registerSparseTag`, then `addSparse` and
  `removeSparse`. A sparse component keeps its data in columns indexed by entity, so a read by id
  is one load, and `sparseCursor(def)` with `sparseCursorRead(def)` is the fastest read by id that
  the engine has. Sparse storage is correct for data that a system reads by id, that changes
  frequently, or that is rare, because it causes no archetype transition.
- **Resources**. A resource is a typed global value, keyed with `resourceKey<T>`. It needs no
  plugin. **Events** (the `events()` plugin) are send-and-forget channels in
  struct-of-arrays form, keyed with `eventKey<F>` or `signalKey`. The ECS clears the events at the
  end of each `update`.
- **Cached refs**. `ctx.ref(def, e)` gives you a writable ref, and it sets the change tick.
  `ctx.refRead(def, e)` gives you a read-only ref. A ref finds the archetype, the row, and the
  columns one time. Then you can write `pos.x += vel.vx * dt`.
- **Cursors**. `ctx.cursor(def)` gives you an accessor that you can use again for a different
  entity. `ctx.cursorRead(def)` gives you the read-only form. The same two functions are on `ecs`.
  You make a cursor one time. Then each `at(entity)` call moves it to a different entity. Use a
  cursor when you read or write many entities from a list of ids. The loop then makes no ref for
  each entity, and the cursor finds the position of each field one time. Each `at` call finds the
  archetype and the row again. Thus a structural change between two `at` calls cannot make a
  cursor read a different entity.

**Determinism, storage of state, and integration**

- **Determinism** (optional). Construct the ECS with
  `ECS.create({ deterministic: true, plugins: [snapshots()] })`. Then use
  `ecs.snapshots.stateHash()`, which gives a 32-bit digest in FNV-1a style over the live dense
  bytes, the sparse stores, and the target sets of multi relations. The hash is independent of the
  storage type: a heap ECS and a shared ECS with the same history give the same hash.
  `ecs.snapshots.capture()`, `ecs.snapshots.restore(...)`, and the equivalent functions for sparse
  data need the `snapshots()` plugin beside the flag.
- **A write path from the host into the ECS**. `installHostCommandSeam(ecs)` applies typed
  `HostCommand` values from outside the schedule, through one approved `exclusive` system. It
  supports record and replay (`HostCommandRecorder` and `replayCommandLog`), and a ring transport
  between threads.
- **A UI connection** (optional). A Solid app installs the `solid()` plugin from
  `@oasys/oecs/solid`. It projects ECS state into Solid signals, straight off the change feed, and
  a row is one signal. It is the one path into a UI, and this release ships no other framework
  path.
- **An editor layer**. It adds undo, redo, and field handles above the host write path
  (`@oasys/oecs/editor`).
- **Frame traces**. `ecs.setTrace(sink)` with `FrameTraceRecorder` gives you a structured stream
  of the events in each frame. It is available in development builds only.
- **A compute backend connection**. `ecs.attachBackend(...)` runs the body of a system on a
  compiled backend, such as WASM, instead of its TypeScript closure. A backend body receives the
  phase `dt` and the frame tick, because neither is in the store bytes.
- **Parallel systems**. `ecs.attachWorkers({ count })` starts a pool of workers on the package's
  own entry, `@oasys/oecs/worker`. A bundled app passes `workerUrl` instead, because a bundler
  leaves that entry out of its graph. A system that carries a `parallel` config names a kernel a worker
  can load, either a compiled `WebAssembly.Module` export or an export of a JavaScript module URL,
  and the columns the kernel receives in order. The schedule hands the pass to the pool, parks the
  host, and joins before the phase flush, so no structural change can overlap the workers. Every
  worker computes its own row range, so the result is deterministic. Below `parallel.minRows`, and
  with no pool, the system runs its own `fn`. In a browser the world lives inside a worker, because
  a main thread cannot park, and Blink, Gecko and WebKit all run the pool from there. A `wasm` kernel
  follows a module contract that holds for any toolchain: one memory import, one exported function,
  and an exported `__stack_pointer` when the body uses a stack. Every worker instantiates the module
  over one memory, so the pool gives each instance its own shadow stack, and `stackBytes` says how
  big one is. The suite runs kernels built by Zig, Rust, C and AssemblyScript beside one emitted
  with no toolchain.
- **A store that starts anywhere in its memory**. `memory.storeBase` places the header at a byte
  offset you choose, and the store writes nothing below it. `storeBaseAbove(exports, extraBytes)`
  reads that offset from a module's `__heap_base`, so a WASM-backed world never lands on the
  addresses the module owns.

**Reference**

- **Typed errors**. There is an `ECSError` taxonomy with a `category` enum and an `isEcsError`
  guard. The package exports all of them.
- **Primitives that you can use again** (`@oasys/oecs/primitives`). `BitSet`, `SparseSet`,
  `SparseMap`, `GrowableTypedArray`, `BinaryHeap`, and `topologicalSort` also operate alone.

## Entry points

The core is `@oasys/oecs`. Each other entry point is optional, and it costs nothing until you
import it.

Four subsystems are **plugins**: relations, events, snapshots and observers. A world installs
the ones it uses, and carries no code for the rest.

```ts
import { ECS } from "@oasys/oecs";
import { relations } from "@oasys/oecs/relations";
import { observers } from "@oasys/oecs/observers";

const world = ECS.create({ plugins: [relations(), observers()] });
world.relations.register(); // ok
world.events.emit(Damaged, { amount: 1 }); // compile error, events is not installed
```

`ECS.create` returns the world intersected with the facades its plugins contribute, so reaching for
a plugin you did not install is a compile error rather than a fault at run time. `new ECS()`
still builds a world, and that world holds none of the four. A class method cannot be removed by a
bundler, which is why these live behind an import you make rather than a member you always carry.

To write a plugin of your own, import the types `Plugin`, `PluginHost` and `PluginsOf`
from `@oasys/oecs`. `Plugin<X>` is what a factory such as `relations()` returns, and what a
plugin list holds. Its `install` takes a `PluginHost` and returns `X`, the surface the world
gains. `PluginsOf` is the surface a plugin list adds to the world. The
[plugins](./docs/api/plugins.md) page documents every host member, the rules `ECS.create`
checks, and the change feed a plugin drains.

| Import | What it is |
| --- | --- |
| `@oasys/oecs` | the ECS, the pure-TS heap profile by default (a production build, with the development guards removed) |
| `@oasys/oecs/dev` | the same ECS with the development guards on. Import this to get the guards directly. See [Development and production](#dev-vs-prod) |
| `@oasys/oecs/shared` | the optional `SharedArrayBuffer` allocators, `growableSabAllocator`, `fixedSabAllocator` and `wasmMemoryAllocator`, for worker offload or a WASM backend (this needs COOP and COEP) |
| `@oasys/oecs/relations` | the relations plugin, `(relation, target)` pairs, wildcards and hierarchy traversal |
| `@oasys/oecs/events` | the events plugin, host-side channels and signals, and `ctx.emit` |
| `@oasys/oecs/snapshots` | the snapshots plugin, `capture` and `restore` for a live world |
| `@oasys/oecs/observers` | the observers plugin, `ecs.observe` for `onAdd`, `onRemove` and `onSet` |
| `@oasys/oecs/editor` | undo, redo, and field handles above the host write path |
| `@oasys/oecs/solid` | the solid plugin, `solid()`, ECS state into Solid signals off the change feed (`solid-js` is an **optional** peer dependency) |
| `@oasys/oecs/worker` | the engine's worker entry, which `ecs.attachWorkers` starts. A bundled app imports it for its URL alone, and passes that as `workerUrl`. `@oasys/oecs/worker/dev` is the guarded build |
| `@oasys/oecs/primitives` | the data structures that oecs is built from, which also operate alone |
| `@oasys/oecs/internal` | unstable internal parts (codecs, ABI constants, the access checker). There are no semver guarantees |

<a id="dev-vs-prod"></a>

## Development and production

A compile-time flag, `__DEV__`, controls each run-time check. The checks include bounds and
liveness checks, detection of a system that you added two times, validation at registration, and
the system access checker for `reads` and `writes`. The build tool **removes these checks from a
production build**. So, when the documentation says that an operation "throws in development",
that behavior is a development aid. It is not a production guarantee. Two checks stay active in
each build: cycle detection in the scheduler, and validation of the constructor options (the
timestep, the memory options, and the cardinality of a relation).

**Production is the default on both channels. You must turn the guards on.** On **npm**,
`@oasys/oecs` is the production build, with the guards removed. A bundler in development mode
(`vite dev` or `webpack --mode development`) selects the build with the guards automatically,
through the `development` export condition. As an alternative, import `@oasys/oecs/dev` directly.
Each plugin has the same subpath, `@oasys/oecs/relations/dev`, `@oasys/oecs/events/dev`,
`@oasys/oecs/snapshots/dev` and `@oasys/oecs/observers/dev`. Take the plugin from the same
channel as the world, because a plugin binds to the core build it was made against.
On **JSR and Deno** there is no bundler, because the package is raw source. The default is also
production (`__DEV__ = false`). To turn the guards on while you develop, set
`globalThis.__DEV__ = true` before the first import. For the full details, which include the
browser, CDN, and manual paths, read the
[**Development guards and production builds**](docs/PRODUCTION.md) guide.

## Documentation

- **If oecs is new to you**, start with the [Getting started](docs/GETTING_STARTED.md) tutorial.
  Then read [Best practices](docs/BEST_PRACTICES.md) and the
  [Architecture](docs/ARCHITECTURE.md) overview.
- **If you use the optional entry points**, read the
  [Integration guide](docs/INTEGRATION.md) for Solid, the editor, shared memory, and the
  primitives.
- **If you upgrade from 0.5**, read the
  [Migration guide (0.5 to 0.6)](docs/MIGRATION-0.5-to-0.6.md) and the [CHANGELOG](CHANGELOG.md).
- **If you upgrade from 0.4**, read the
  [Migration guide (0.4 to 0.5)](docs/MIGRATION-0.4-to-0.5.md).
- **If you upgrade from 0.3**, read the
  [Migration guide (0.3 to 0.4)](docs/MIGRATION-0.3-to-0.4.md).
- **The full API reference.** Start at the [reference index](docs/api/index.md). The pages are:
  - [components](docs/api/components.md)
  - [entities](docs/api/entities.md)
  - [queries](docs/api/queries.md)
  - [systems](docs/api/systems.md)
  - [schedule](docs/api/schedule.md)
  - [resources](docs/api/resources.md)
  - [events](docs/api/events.md)
  - [refs](docs/api/refs.md)
  - [change detection](docs/api/change-detection.md)
  - [observers](docs/api/observers.md)
  - [relations](docs/api/relations.md)
  - [sparse storage](docs/api/sparse-storage.md)
  - [determinism](docs/api/determinism.md)
  - [memory](docs/api/memory.md)
  - [WASM backends](docs/api/wasm.md)
  - [parallel execution](docs/api/parallel.md), the worker pool and the `parallel` system form
  - [the host write path](docs/api/host-write-seam.md)
  - [solid](docs/api/solid.md)
  - [editor](docs/api/editor.md)
  - [traces](docs/api/tracing.md)
  - [primitives](docs/api/primitives.md)
  - [errors](docs/api/errors.md)
  - [plugins](docs/api/plugins.md)

## Development

```bash
pnpm install
pnpm test              # vitest
pnpm bench             # vitest bench
pnpm build             # vite library build (multi-entry → dist/)
pnpm exec tsc --noEmit # type check
```

## Acknowledgements

oecs is built on the work of the ECS community. We thank:

- **[Bevy](https://bevyengine.org)**, **[Flecs](https://github.com/SanderMertens/flecs)**, and
  **[bitECS](https://github.com/NateTheGreatt/bitECS)**, a continuous source of ideas. Their
  designs gave shape to the archetypes, relations, schedule, and change detection in oecs.
- **[@clinuxrulz](https://github.com/clinuxrulz)**, for an excellent demonstration and for very
  valuable comments on the ECS.

## License

[MIT](license)
