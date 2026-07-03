# oecs

**A full-featured, archetype-based Entity Component System for TypeScript.**

`@oasys/oecs` is a complete ECS — not just storage-and-queries, but the whole toolkit you expect from a
mature engine: observers, relations with wildcards, sparse storage, system sets and run conditions,
entity enable/disable, templates, deterministic hashing with snapshot/restore, a typed host→ECS write
seam, and an optional reactive UI bridge. It is **pure TypeScript and zero-dependency by default** — it
runs over a plain resizable `ArrayBuffer`, so it needs no `SharedArrayBuffer` and no cross-origin
isolation (COOP/COEP). An opt-in shared-memory profile swaps in a `SharedArrayBuffer` for worker offload
or a WASM compute backend; both profiles share one core and agree, byte-for-byte, on `stateHash`.

- **Fast** — struct-of-arrays column storage grouped by archetype; iteration is a tight loop over typed
  arrays with no per-entity object allocation.
- **Type-safe** — components are branded integers at runtime and fully-typed schemas at compile time;
  misspelled fields are compile errors.
- **Deterministic** — an opt-in mode gives a backing-agnostic `stateHash` plus snapshot/restore and
  command-log replay.
- **Complete** — the feature surface below is the whole engine, not a starting point.

## Installation

```bash
pnpm add @oasys/oecs        # npm / pnpm / yarn
# or
deno add jsr:@oasys/oecs    # JSR (Deno)
# or
npx jsr add @oasys/oecs     # JSR (npm-compatible)
```

## Quick start

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const world = new ECS(); // pure-TS heap profile — no SharedArrayBuffer needed

// Components — record syntax (per-field type) or array shorthand (defaults to "f64")
const Pos = world.registerComponent({ x: "f64", y: "f64" });
const Vel = world.registerComponent(["vx", "vy"] as const);

// A query is a live, cached view over matching archetypes — build it once, reuse it.
const movers = world.query(Pos, Vel);

// Systems declare the components they read/write (checked in dev builds).
const move = world.registerSystem({
  reads: [Vel],
  writes: [Pos], // a declared write implies read of the same component
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);    // whole group; stamps Pos's change tick once
      const { vx, vy } = cols.read(Vel); // read-only group
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});

world.addSystems(SCHEDULE.UPDATE, move);
world.startup();

const e = world.createEntity();
world.addComponent(e, Pos, { x: 0, y: 0 });
world.addComponent(e, Vel, { vx: 100, vy: 50 });

world.update(1 / 60);
world.getField(e, Pos, "x"); // ≈ 1.667
```

## Features

**Storage & data model**

- **Archetype SoA storage** over a backing-neutral `ColumnStore` — entities with the same component set
  share contiguous typed-array columns; cache-friendly loops, no per-entity object allocation.
- **Phantom-typed components** — `registerComponent({ x: "f64", y: "f64" })` is a branded integer at
  runtime and a fully-typed schema at compile time. Record syntax for per-field types, array shorthand
  for uniform `f64`, and `registerTag()` for data-free markers. Field types: `f32 f64 i8 i16 i32 u8 u16 u32`.
- **Two storage profiles, one core** — pure-TS heap (`ArrayBuffer`) by default; opt-in
  `SharedArrayBuffer` for workers / WASM. Same code path, same `stateHash`, sized through a single
  `memory` surface (entity budget, byte cap, or pinned capacity).

**Queries**

- **Live, cached queries** — `world.query(Pos, Vel)` refined with `.and()` / `.without()` / `.anyOf()`;
  new matching archetypes are pushed in automatically.
- **Two iteration verbs** — `forEach(arch => …)` for read-only archetype iteration, `eachChunk((cols, count) => …)`
  for the mutable hot path (`cols.mut` / `cols.read` resolve a whole component's columns at once).
- **Change detection** — per-`(archetype, component)` change ticks; `query.changed(Pos)` visits only
  archetypes written since the system's threshold tick.
- **Relation & hierarchy queries** — `(R, *)` / `(*, T)` wildcards, `forEachRelatedTo`, and
  `query.hierarchy(rel, depth)`. **Sparse queries** via `query.withSparse(...)`; disabled entities are
  skipped unless you opt in with `query.includeDisabled()`.

**Systems & scheduling**

- **Declarative systems** — plain functions in a `SystemConfig` declaring `reads` / `writes`, enforced by
  a dev-mode access checker (tree-shaken in production). Bare `(ctx, dt)` and `(q, ctx, dt)` +
  query-builder overloads exist for access-free glue; lifecycle hooks `onAdded` / `onRemoved` / `dispose`;
  `exclusive: true` for full-world setup/teardown.
- **Topological scheduler** — seven phases (`PRE_STARTUP` → `STARTUP` → `POST_STARTUP`, `FIXED_UPDATE`,
  `PRE_UPDATE` → `UPDATE` → `POST_UPDATE`); per-phase Kahn sort by `before` / `after`, with insertion
  order as a deterministic tiebreaker. Always-on cycle detection.
- **Fixed timestep** — accumulator loop with configurable `fixedTimestep` and spiral-of-death protection.
- **System sets & run conditions** — `systemSet(...)` + `configureSet(...)`; `runIfResourceEq`,
  `runEveryNTicks`, `runIfAnyMatch`, and custom `RunCondition`s.

**Structural changes**

- **Deferred by default** — `ctx.commands` (a Bevy-`Commands`-style facade) buffers
  spawn / add / remove / despawn / enable / disable until the phase flush, so iterators stay valid.
  Host-side `world.addComponent` / `removeComponent` / `disable` / `enable` apply immediately;
  `world.destroyEntity` is still deferred to match system-side despawn semantics.
- **Entity enable/disable** — `disable` / `enable` / `isDisabled`; disabled rows sit in a partitioned
  tail and are skipped by default queries.
- **Templates & bundles** — `world.template([...])` blueprints consumed by `createEntity` /
  `createEntities` for zero-transition spawns; `bundle(...)` + `spawnBundle(...)`.

**Reactivity & relationships**

- **Observers** — `world.observe(...)` for `onAdd` / `onRemove` / `onSet` / `onEnable` / `onDisable`,
  structural or per-entity.
- **Relations** — `(relation, target)` pairs with `ChildOf` / `IsA` presets, exclusive / multi arities,
  bidirectional queries (`targetOf` / `sourcesOf` / `ancestorsOf` / `rootOf` / `cascadeOf`), and
  configurable on-delete cleanup (`delete` / `clear` / `orphan`). Stored sparsely — no archetype
  transition, no identity bit.
- **Sparse storage** — `registerSparseComponent` / `registerSparseTag`, `addSparse` / `removeSparse` for
  churny or rare data that shouldn't cause archetype transitions.
- **Resources** — typed global singletons via `resourceKey<T>`. **Events** — fire-and-forget SoA channels
  via `eventKey<F>` / `signalKey`, cleared at the end of each `update`.
- **Cached refs** — `ctx.ref(def, e)` (mutable, bumps the change tick) / `ctx.refRead(def, e)`
  (read-only): resolve archetype + row + column once, then `pos.x += vel.vx * dt`.

**Determinism, persistence & integration**

- **Determinism** (opt-in) — `new ECS({ deterministic: true })`, then `world.stateHash()` (FNV-1a over
  live dense bytes, sparse stores, and multi-relation target sets), `snapshot()` / `restoreInto(...)`,
  plus sparse variants. Backing-agnostic: a heap world and a shared world with identical history produce
  identical hashes.
- **Host → ECS write seam** — `installHostCommandSeam(world)` applies typed `HostCommand`s off-schedule
  via a blessed `exclusive` system, with record/replay (`HostCommandRecorder`, `replayCommandLog`) and a
  cross-thread ring transport.
- **Reactive UI seam** (optional) — a zero-dep signals kernel (`@oasys/oecs/reactive`), an ECS→reactive
  bridge that publishes only dirty entities/columns (`@oasys/oecs/reactive-sync`), and a SolidJS adapter
  (`@oasys/oecs/solid`).
- **Editor layer** — undo/redo + field handles over the write seam (`@oasys/oecs/editor`).
- **Frame tracing** — `world.setTrace(sink)` + `FrameTraceRecorder` for a structured per-frame event
  stream (dev-gated).
- **Compute backend seam** — `world.attachBackend(...)` to run a system body on a compiled backend (WASM,
  …) instead of its TS closure.

**Reference**

- **Typed errors** — an `ECSError` taxonomy with a `category` enum and an `isEcsError` guard, all exported.
- **Reusable primitives** (`@oasys/oecs/primitives`) — `BitSet`, `SparseSet`, `SparseMap`,
  `GrowableTypedArray`, `BinaryHeap`, and `topologicalSort`, usable standalone.

## Entry points

The core is `@oasys/oecs`; everything else is opt-in and costs nothing until imported.

| Import | What it is |
| --- | --- |
| `@oasys/oecs` | the ECS — pure-TS heap profile by default |
| `@oasys/oecs/shared` | opt-in `SharedArrayBuffer` allocators for worker offload / a WASM backend (needs COOP/COEP) |
| `@oasys/oecs/reactive` | zero-dependency reactive kernel (`signal`/`computed`/`effect`, reactive collections) |
| `@oasys/oecs/reactive-sync` | ECS→reactive bridge — publishes only dirty entities/columns |
| `@oasys/oecs/editor` | undo/redo + field-handle layer over the host-write seam |
| `@oasys/oecs/solid` | SolidJS adapter (`solid-js` is an **optional** peer dependency) |
| `@oasys/oecs/primitives` | the standalone data structures oecs is built on |

## Dev vs prod

A compile-time `__DEV__` flag gates every runtime check — bounds and liveness checks, duplicate-system
detection, registration validation, and the system access checker (`reads`/`writes`). These are
**tree-shaken out of production builds**, so treat "throws in dev" as a development tripwire, not a
production guarantee. The scheduler's cycle detection is the one check that is always active.

## Documentation

- **New to oecs?** Start with the [Getting Started](docs/GETTING_STARTED.md) tutorial, then
  [Best Practices](docs/BEST_PRACTICES.md) and the [Architecture](docs/ARCHITECTURE.md) overview.
- **Upgrading from 0.3?** See the [Migration guide (0.3 → 0.4)](docs/MIGRATION-0.3-to-0.4.md) and the
  [CHANGELOG](CHANGELOG.md).
- **Full API reference** — start at the [reference index](docs/api/index.md):
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
  [host-write seam](docs/api/host-write-seam.md) ·
  [reactive](docs/api/reactive.md) ·
  [editor](docs/api/editor.md) ·
  [tracing](docs/api/tracing.md) ·
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

oecs stands on the shoulders of the ECS community. Special thanks to:

- **[Bevy](https://bevyengine.org)**, **[Flecs](https://github.com/SanderMertens/flecs)**, and
  **[bitECS](https://github.com/NateTheGreatt/bitECS)** — a constant source of inspiration; their
  designs shaped how oecs approaches archetypes, relations, scheduling, and change detection.
- **[@clinuxrulz](https://github.com/clinuxrulz)** — for his amazing showcase and invaluable input on
  the ECS.

## License

[MIT](LICENSE)
