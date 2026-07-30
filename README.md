# oecs

**A complete, archetype-based Entity Component System for TypeScript.**

`@oasys/oecs` gives you more than storage and queries. It gives you the tools that a mature engine
has:

- observers;
- relations with wildcards;
- sparse storage;
- system sets and run conditions;
- enable and disable for an entity;
- templates;
- deterministic hashing, with snapshot and restore;
- a typed write path from the host into the ECS;
- an optional reactive UI bridge.

The package is **pure TypeScript, and it has no dependencies by default**. It runs over one plain
`ArrayBuffer`. So it does not need a `SharedArrayBuffer`, and it does not need cross-origin
isolation (COOP/COEP). An optional shared-memory profile uses a `SharedArrayBuffer` instead. Use
that profile for worker offload, or for a WASM compute backend. The two profiles use one core, and
they agree byte-for-byte on `stateHash`.

- **Data-oriented** — Columns use struct-of-arrays storage, grouped by archetype. Iteration is a
  small loop over typed arrays. The loop allocates no object for each entity.
- **Type-safe** — A component handle is a callable definition. It has a stable numeric id at run
  time and a full schema type at compile time. A field name with a spelling error is a compile
  error.
- **Deterministic** — An optional mode gives you a `stateHash` that is independent of the storage
  type. It also gives you snapshot, restore, and replay of a command log.
- **Complete** — The features below are the full engine. They are not only a start.

## Installation

```bash
pnpm add @oasys/oecs        # npm / pnpm / yarn
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

const ecs = new ECS(); // pure-TS heap profile — no SharedArrayBuffer needed

// Components — record syntax (per-field type) or array shorthand (defaults to "f64")
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent(["vx", "vy"] as const);

// A query is a live, cached view of the matching archetypes. Build it once, then use it again.
const movers = ecs.query(Pos, Vel);

// Systems declare the components that they read and write (checked in development builds).
const move = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos], // a declared write also gives read access to the same component
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);    // the full group; sets the change tick of Pos one time
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
- **Components with phantom types** — `registerComponent({ x: "f64", y: "f64" })` gives you a
  callable `ComponentDef`. The definition has a stable numeric `.id` at run time and a full schema
  type at compile time. Use the record syntax for different types in each field. Use the array
  shorthand when all fields are `f64`. Use `registerTag()` for markers that hold no data. The field
  types are `f32 f64 i8 i16 i32 u8 u16 u32`.
- **Two storage profiles, one core** — The default is a pure-TS heap (`ArrayBuffer`). A
  `SharedArrayBuffer` for workers or WASM is optional. The code path is the same, the `stateHash`
  is the same, and one `memory` option sets the size (an entity budget, a byte limit, or a fixed
  capacity).

**Queries**

- **Live, cached queries** — Write `ecs.query(Pos, Vel)`, then make it more exact with `.and()`,
  `.without()`, or `.anyOf()`. The store adds new matching archetypes to the query automatically.
- **Two iteration verbs** — Use `forEach(arch => …)` to read archetypes. Use
  `eachChunk((cols, count) => …)` for the high-frequency loop that writes. In that loop, `cols.mut`
  and `cols.read` give you all the columns of one component at the same time.
- **Change detection** — Each `(archetype, component)` pair has a change tick.
  `query.changed(Pos)` visits only the archetypes that changed at or after the threshold tick of
  the system.
- **Queries for relations and hierarchies** — Use the wildcards `(R, *)` and `(*, T)`, plus
  `forEachRelatedTo` and `query.hierarchy(rel, depth)`. For **sparse queries**, use
  `query.withSparse(...)`. Queries skip disabled entities. To include them, use
  `query.includeDisabled()`.

**Systems and the schedule**

- **Systems that declare their access** — A system is a plain function in a `SystemConfig` that
  declares `reads` and `writes`. A development-mode access checker holds you to that declaration,
  and the build tool removes that checker from a production build. There are also `(ctx, dt)` and
  `(q, ctx, dt)`
  forms with a query builder, for connection code that touches no data. The lifecycle hooks are
  `onAdded`, `onRemoved`, and `dispose`. Set `exclusive: true` for full-world setup or teardown.
- **A topological scheduler** — There are seven phases: `PRE_STARTUP`, `STARTUP`, `POST_STARTUP`,
  `FIXED_UPDATE`, `PRE_UPDATE`, `UPDATE`, and `POST_UPDATE`. Each phase does a Kahn sort on the
  `before` and `after` constraints. Insertion order breaks a tie, which keeps the result
  deterministic. Cycle detection is always active.
- **A fixed timestep** — An accumulator loop uses the `fixedTimestep` value that you set. A limit
  protects against the spiral of death.
- **System sets and run conditions** — Use `systemSet(...)` with `configureSet(...)`. The supplied
  conditions are `runIfResourceEq`, `runEveryNTicks`, and `runIfAnyMatch`. You can also write your
  own `RunCondition`.

**Structural changes**

- **Deferred in a system, immediate on the host** — `ctx.commands` is a facade in the style of the
  Bevy `Commands` type. It holds add, remove, despawn, enable, and disable operations until the
  flush at the end of the phase, so that iterators stay correct. `commands.spawn` gives you the id
  immediately, but it attaches the components later. Each mutation on the host
  (`ecs.addComponent`, `ecs.removeComponent`, `ecs.despawn`, `ecs.disable`, and `ecs.enable`)
  applies immediately.
- **Enable and disable for an entity** — Use `disable`, `enable`, and `isDisabled`. Disabled rows
  stay in a partition at the end of the archetype, and queries skip them by default.
- **Templates and bundles** — `ecs.template(Pos({ x, y }), …)` makes a blueprint. `spawn` and
  `spawnMany` use that blueprint to create entities with no archetype transition. The same callable
  bundles are the arguments to `spawnBundle(...)` and `addComponents(...)`.

**Reactions and relationships**

- **Observers** — `ecs.observe(...)` registers `onAdd`, `onRemove`, `onSet`, `onEnable`, and
  `onDisable` callbacks, for a structure or for one entity.
- **Relations** — A relation is a `(relation, target)` pair. The presets are `ChildOf` and `IsA`.
  A relation is exclusive or multi. Queries go in both directions (`targetOf`, `sourcesOf`,
  `ancestorsOf`, `rootOf`, and `cascadeOf`). The cleanup policy for a deleted target is
  `delete`, `clear`, or `orphan`. Relations use sparse storage. So they cause no archetype
  transition, and they use no identity bit.
- **Sparse storage** — Use `registerSparseComponent` and `registerSparseTag`, then `addSparse` and
  `removeSparse`. Sparse storage is correct for data that changes frequently or is rare, because it
  causes no archetype transition.
- **Resources** — A resource is a typed global value, keyed with `resourceKey<T>`. **Events** are
  send-and-forget channels in struct-of-arrays form, keyed with `eventKey<F>` or `signalKey`. The
  ECS clears the events at the end of each `update`.
- **Cached refs** — `ctx.ref(def, e)` gives you a writable ref, and it sets the change tick.
  `ctx.refRead(def, e)` gives you a read-only ref. A ref finds the archetype, the row, and the
  columns one time. Then you can write `pos.x += vel.vx * dt`.

**Determinism, storage of state, and integration**

- **Determinism** (optional) — Construct the ECS with `new ECS({ deterministic: true })`. Then use
  `ecs.snapshots.stateHash()`, which gives a 32-bit digest in FNV-1a style over the live dense
  bytes, the sparse stores, and the target sets of multi relations. Also use
  `ecs.snapshots.capture()`, `ecs.snapshots.restore(...)`, and the equivalent functions for sparse
  data. The hash is independent of the storage type: a heap ECS and a shared ECS with the same
  history give the same hash.
- **A write path from the host into the ECS** — `installHostCommandSeam(ecs)` applies typed
  `HostCommand` values from outside the schedule, through one approved `exclusive` system. It
  supports record and replay (`HostCommandRecorder` and `replayCommandLog`), and a ring transport
  between threads.
- **A reactive UI connection** (optional) — There are three parts. `@oasys/oecs/reactive` is a
  signals kernel with no dependencies. `@oasys/oecs/reactive-sync` is a bridge from the ECS to that
  kernel, and it publishes only the changed entities and columns. `@oasys/oecs/solid` is a SolidJS
  adapter.
- **An editor layer** — It adds undo, redo, and field handles above the host write path
  (`@oasys/oecs/editor`).
- **Frame traces** — `ecs.setTrace(sink)` with `FrameTraceRecorder` gives you a structured stream
  of the events in each frame. It is available in development builds only.
- **A compute backend connection** — `ecs.attachBackend(...)` runs the body of a system on a
  compiled backend, such as WASM, instead of its TypeScript closure.

**Reference**

- **Typed errors** — There is an `ECSError` taxonomy with a `category` enum and an `isEcsError`
  guard. The package exports all of them.
- **Primitives that you can use again** (`@oasys/oecs/primitives`) — `BitSet`, `SparseSet`,
  `SparseMap`, `GrowableTypedArray`, `BinaryHeap`, and `topologicalSort` also operate alone.

## Entry points

The core is `@oasys/oecs`. Each other entry point is optional, and it costs nothing until you
import it.

| Import | What it is |
| --- | --- |
| `@oasys/oecs` | the ECS — the pure-TS heap profile by default (a production build, with the development guards removed) |
| `@oasys/oecs/dev` | the same ECS with the development guards **on** — import this to get the guards directly; see [Development and production](#dev-vs-prod) |
| `@oasys/oecs/shared` | the optional `SharedArrayBuffer` allocators, for worker offload or a WASM backend (this needs COOP/COEP) |
| `@oasys/oecs/reactive` | the reactive kernel, which has no dependencies (`signal`, `computed`, `effect`, and reactive collections) |
| `@oasys/oecs/reactive-sync` | the bridge from the ECS to the kernel — it publishes only the changed entities and columns |
| `@oasys/oecs/editor` | undo, redo, and field handles above the host write path |
| `@oasys/oecs/solid` | the SolidJS adapter (`solid-js` is an **optional** peer dependency) |
| `@oasys/oecs/primitives` | the data structures that oecs is built from, which also operate alone |
| `@oasys/oecs/internal` | unstable internal parts (codecs, ABI constants, the access checker) — **there are no semver guarantees** |

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
On **JSR and Deno** there is no bundler, because the package is raw source. The default is also
production (`__DEV__ = false`). To turn the guards on while you develop, set
`globalThis.__DEV__ = true` before the first import. For the full details, which include the
browser, CDN, and manual paths, read the
[**Development guards and production builds**](docs/PRODUCTION.md) guide.

## Documentation

- **If oecs is new to you**, start with the [Getting started](docs/GETTING_STARTED.md) tutorial.
  Then read [Best practices](docs/BEST_PRACTICES.md) and the
  [Architecture](docs/ARCHITECTURE.md) overview.
- **If you use the optional extensions**, read the [Extensions guide](docs/EXTENSIONS.md) for the
  reactive UI, the editor, Solid, shared memory, and the primitives.
- **If you upgrade from 0.4**, read the
  [Migration guide (0.4 to 0.5)](docs/MIGRATION-0.4-to-0.5.md) and the [CHANGELOG](CHANGELOG.md).
- **If you upgrade from 0.3**, read the
  [Migration guide (0.3 to 0.4)](docs/MIGRATION-0.3-to-0.4.md).
- **The full API reference** — Start at the [reference index](docs/api/index.md):
  [components](docs/api/components.md) ·
  [entities](docs/api/entities.md) ·
  [queries](docs/api/queries.md) ·
  [systems](docs/api/systems.md) ·
  [schedule](docs/api/schedule.md) ·
  [resources](docs/api/resources.md) ·
  [events](docs/api/events.md) ·
  [refs](docs/api/refs.md) ·
  [change detection](docs/api/change-detection.md) ·
  [observers](docs/api/observers.md) ·
  [relations](docs/api/relations.md) ·
  [sparse storage](docs/api/sparse-storage.md) ·
  [determinism](docs/api/determinism.md) ·
  [memory](docs/api/memory.md) ·
  [WASM backends](docs/api/wasm.md) ·
  [parallel execution](docs/api/parallel.md) ·
  [the host write path](docs/api/host-write-seam.md) ·
  [reactive](docs/api/reactive.md) ·
  [editor](docs/api/editor.md) ·
  [traces](docs/api/tracing.md) ·
  [primitives](docs/api/primitives.md) ·
  [errors](docs/api/errors.md)

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
  **[bitECS](https://github.com/NateTheGreatt/bitECS)** — a continuous source of ideas. Their
  designs gave shape to the archetypes, relations, schedule, and change detection in oecs.
- **[@clinuxrulz](https://github.com/clinuxrulz)** — for an excellent demonstration and for very
  valuable comments on the ECS.

## License

[MIT](LICENSE)
