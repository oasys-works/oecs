# oecs API reference

`@oasys/oecs` is an **archetype-based Entity Component System for TypeScript that can be
deterministic**. It is pure TypeScript, it has no dependencies, and by default it runs over one
plain `ArrayBuffer`. It needs no `SharedArrayBuffer`, and no COOP and COEP headers.

This reference documents the full public surface of **0.6**. Each signature here is checked against
the source. If oecs is new to you, read the pages in the order below. If you know other ECS
libraries, go directly to the page that you need.

> The examples name the instance `ecs` (`const ecs = new ECS()`). Method names are camelCase. Type
> names and handle names are PascalCase (`ECS`, `Pos`, `EntityID`). Constants are
> SCREAMING_SNAKE (`SCHEDULE.UPDATE`).

## The model in short

- An **entity** is only an integer id (`EntityID`). It is not an object, and it holds no data.
- A **component** is a typed struct-of-arrays. `registerComponent({ x: "f64", y: "f64" })` gives
  you a handle (`Pos`). The data stays in packed typed-array columns. There is no object for each
  entity.
- Entities that have the **same set of components** share an **archetype**, which is one adjacent
  block of columns. This is why iteration is a small loop over arrays, and it is the reason for the
  word "archetype" in the name.
- A **query** (`ecs.query(Pos, Vel)`) is a **live, cached** view of each archetype that agrees with
  it. The store adds new matching archetypes automatically. Build the query one time, then use it
  again.
- A **system** is a plain function that runs over queries in each frame. It declares the components
  that it reads and writes, and development builds check that declaration.
- The **schedule** runs the systems in phases. The startup phases run one time. The update
  phases run in each frame. The fixed-update phase runs at a fixed timestep. A world starts with
  seven phases, and `ecs.addPhase` adds one more.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const ecs = new ECS();

const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent(["vx", "vy"] as const); // array shorthand → f64
const movers = ecs.query(Pos, Vel);                        // live, cached

const move = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  fn: (ctx, dt) => {
    movers.forEachChunk((cols, count) => {                    // the high-frequency loop that writes
      const { x, y } = cols.mut(Pos);                      // sets the change tick of Pos
      const { vx, vy } = cols.read(Vel);
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

## Entry points

oecs has several import paths. The core is `@oasys/oecs`. Each other path is optional, and it costs
nothing until you import it.

Six subsystems are **plugins**: relations, events, snapshots, observers, workers and solid. A world
installs the ones it uses, and carries no code for the rest.

```ts
import { ECS, eventKey } from "@oasys/oecs";
import { relations } from "@oasys/oecs/relations";
import { events } from "@oasys/oecs/events";
import { observers } from "@oasys/oecs/observers";

const Damaged = eventKey<{ amount: number }>("Damaged");

const world = ECS.create({ plugins: [relations(), events(), observers()] });
world.relations.register();
world.events.register(Damaged, ["amount"]);
world.events.emit(Damaged, { amount: 1 });
```

`ECS.create` returns the world intersected with the facades its plugins contribute. Drop `events()`
from the list and the last two lines are a compile error. `new ECS()` still builds a world, and that
world holds none of the six. A JavaScript caller that reaches for a plugin the world did not install
gets `PLUGIN_NOT_INSTALLED`. A plugin list that installs one plugin two times gets
`PLUGIN_ALREADY_INSTALLED`. See [errors](./errors.md).

To write a plugin of your own, read [plugins](./plugins.md). It documents `Plugin`, `PluginHost`
and `PluginsOf`, the nine host members, the route seam, the rules `ECS.create` checks, and the
change feed a plugin drains.

| Import | What it is |
| --- | --- |
| `@oasys/oecs` | the ECS, the pure-TS heap profile by default |
| `@oasys/oecs/shared` | the optional `SharedArrayBuffer` allocators, `growableSabAllocator`, `fixedSabAllocator` and `wasmMemoryAllocator`, for worker offload or a WASM backend (this needs COOP and COEP) |
| `@oasys/oecs/relations` | the **relations** plugin, `(relation, target)` pairs, wildcards and hierarchy traversal |
| `@oasys/oecs/events` | the **events** plugin, host-side channels and signals, and `ctx.emit` |
| `@oasys/oecs/snapshots` | the **snapshots** plugin, `capture` and `restore` for a live world |
| `@oasys/oecs/observers` | the **observers** plugin, `ecs.observe` |
| `@oasys/oecs/workers` | the **workers** plugin, `ecs.workers`, one pool of workers for the `parallel` systems |
| `@oasys/oecs/editor` | undo, redo, and field handles above the host write path |
| `@oasys/oecs/solid` | the **solid** plugin, `solid()`, ECS state into Solid signals off the change feed (`solid-js` is an **optional** peer dependency) |
| `@oasys/oecs/primitives` | the data structures that oecs is built from (`BitSet`, `SparseSet`, and others) |
| `@oasys/oecs/worker` | the engine's **worker entry**. `world.workers.attach` starts it, and you never import it. On npm the guarded build is `@oasys/oecs/worker/dev` |
| `@oasys/oecs/internal` | an **unstable** surface for tools, codecs, ABI constants, memory inspectors, and development singletons. There are no semver guarantees |

### The open phase set

A world starts with seven phases, and a plugin adds one of its own.
[schedule](./schedule.md) documents each name.

| Name | Where | What it is |
| --- | --- | --- |
| `ecs.addPhase(name, config)` | `ECS` | adds one slot to a loop, and gives back its handle |
| `Phase` | root, type | that handle. Identity, and not name, picks the phase |
| `PhaseConfig` | root, type | `loop`, and the optional `before` and `after` |
| `PhaseLoop` | root, type | `"startup"`, `"fixed"` or `"update"` |
| `SchedulePhase` | root, type | either spelling, a `SCHEDULE` member or a `Phase` |
| `PhaseName` | root, type | what a frame trace event carries, so a `switch` needs a default arm |
| `UNKNOWN_PHASE` | `ECS_ERROR` | a name no built-in spells, or a handle another world made |
| `CIRCULAR_PHASE_DEPENDENCY` | `ECS_ERROR` | one loop's phase order holds a cycle |

### The plugin route seam

A plugin runs a system body itself through one route. [plugins](./plugins.md) documents the seam.

| Name | Where | What it is |
| --- | --- | --- |
| `host.installRoute(planner)` | `PluginHost` | claims the bodies this plugin routes, one route per world |
| `SystemRoutePlanner` | root, type | `plan(config)`, what one routed dispatch reads |
| `RouteControl` | root, type | `route(dispatch)` and `route(null)` |
| `RouteDispatch` | root, type | `run(plan, ctx, dt, runTick)`, true when the route took the body |
| `PluginMemory` | root, type | `host.memory`, the backing, its source and the store base |

The root exports all four as types. Each is structural, so a plugin satisfies one without
naming it, and names it when it wants the compiler to check the shape.

### The archetype term

| Name | Where | What it is |
| --- | --- | --- |
| `query.where(term)` | `Query` | narrows the matched archetypes with a term of your own |
| `ArchetypeTerm` | root, type | `name` and `matches(mask)`, the term `where` takes |
| `and`, `or`, `not` | root | build an `ArchetypeTerm` from definitions and other terms |
| `QUERY_TERM_DENSE_PATH` | `ECS_ERROR` | a dense-list reader on a query that carries a term |
| `SNAPSHOT_RESTORE_FAILED` | `ECS_ERROR` | `ecs.snapshots.restore` refused a frame, and `ECSRestoreError` carries it |
| `InPlaceBufferAllocator`, `BufferAllocator` | root and `/shared`, type | the interface a custom allocator implements |

See [queries](./queries.md).

### The parallel and WASM surface

One system can run across a pool of workers. These are the names that carry it, and
[parallel execution](./parallel.md) with [WASM backends](./wasm.md) documents each one.

| Name | Where | What it is |
| --- | --- | --- |
| `workers()` | `@oasys/oecs/workers` | the plugin, for `ECS.create({ plugins: [workers()] })` |
| `ecs.workers.attach(options)` | workers plugin | starts the pool, resolves when every kernel is loaded |
| `ecs.workers.pool` | workers plugin | the attached `WorkerPool`, or `null` |
| `ecs.workers.detach()` | workers plugin | stops every worker, back to the sequential path |
| `WorkerPool` | workers plugin, type | `count`, `settled()` and `detach()` |
| `AttachWorkersOptions` | workers plugin, type | `count`, `workerUrl`, `joinTimeoutMs` and `stackBytes` |
| `WorkersPlugin` | workers plugin, type | the surface the plugin adds to the world |
| `ECSWorkers` | workers plugin, type | the facade behind `ecs.workers`, with `attach`, `pool` and `detach` |
| `DEFAULT_JOIN_TIMEOUT_MS` | workers plugin | what `joinTimeoutMs` falls back to |
| `SystemConfig.parallel` | `registerSystem` | `kernel`, `columns`, `minRows` and `query` |
| `ParallelConfig` | root, type | the shape of that field |
| `ParallelKernel` | root, type | `{ wasm, export }` or `{ js, export }` |
| `ParallelColumn` | root, type | one `[component, field]` pair, held to the component's schema |
| `memory.storeBase` | `ECSMemoryOptions` | the byte offset the store header sits at |
| `ecs.memoryPlan.storeBase` | `ResolvedECSMemory` | the value the engine resolved |
| `storeBaseAbove(exports, extraBytes)` | root | a base read from a module's `__heap_base` |
| `WASM_STORE_BASE_BYTES` | `@oasys/oecs/internal` | the default base for the wasm backing, one page |
| `ComputeBackend.run(handle, dt, tick)` | root, type | a backend body, with the phase `dt` and the frame tick |
| `ecs.publishRowCounts()` | `ECS` | refresh the descriptor row counts for a module you drive yourself |

The errors are `WORKERS_ATTACHED`, `WORKERS_NEED_SHARED_BACKING`, `WORKERS_HOST_CANNOT_PARK`,
`WORKERS_COUNT_INVALID`, `WORKERS_ENTRY_UNREACHABLE`, `PARALLEL_ACCESS`,
`PARALLEL_KERNEL_MODULE` and `PARALLEL_KERNEL_FAILED`. See [errors](./errors.md).

The root also exports **`VERSION`**, which is the package version as a string constant that you can
read at run time (`import { VERSION } from "@oasys/oecs"`). It is a literal in the source, and not
a value that the build inserts. So a consumer of the raw source (JSR) sees the same value as a
consumer of the npm bundle.

## Pages

### Core

Read these pages in this order, to get a model that you can use.

1. [components](./components.md), `registerComponent`, the field types, tags, callable
   definitions, and bundles
2. [entities](./entities.md), create, destroy, enable, and disable. Templates, and the `EntityID`
   codec
3. [queries](./queries.md), `query`, the verbs `and`, `not` and `or`, their sparse and relation
   forms `andSparse`, `notSparse`, `andRelation` and `notRelation`, the `where` expression,
   `forEach` compared to `forEachChunk`, and the archetype view
4. [systems](./systems.md), `registerSystem`, `reads` and `writes`, the system context, and
   `ctx.commands`
5. [schedule](./schedule.md), the seven built-in phases, `addPhase` for one of your own, the order
   of systems, system sets, the run conditions with `runIfNot`, `runIfAll` and `runIfAny`, and the
   frame loop
6. [resources](./resources.md), typed global values
7. [events](./events.md), send-and-forget messages, which the ECS clears in each frame
8. [refs](./refs.md), cached field accessors for one entity (`ctx.ref` and `ctx.refRead`), and
   cursors, which you can use again for a different entity (`ctx.cursor` and `ctx.cursorRead`)
9. [change detection](./change-detection.md), the change tick and the `changed()` queries at the
   archetype grain. `ecs.trackRows`, `cols.ticks` and `cols.ticksRead`, `cols.since`, and
   `changed(def).forEachChunk` at the row grain
10. [observers](./observers.md), `onAdd`, `onRemove`, `onSet`, `onEnable`, and `onDisable`
11. [relations](./relations.md), `(relation, target)` pairs, `ChildOf` and `IsA`, wildcards, and
    cleanup policies
12. [sparse storage](./sparse-storage.md), components outside the identity, in id-indexed columns:
    for data read by id, rare data, or data that changes frequently. `sparseCursor` and
    `sparseCursorRead` for the fastest read by id, and `ctx.sparseChanged` for its change detection

### Determinism and stored state

13. [determinism](./determinism.md), `deterministic: true`, `stateHash`, snapshot and restore, and
    replay of a command log
14. [memory](./memory.md), the `memory` option that sets the size, and the storage profiles
15. [WASM backends](./wasm.md), a shared `WebAssembly.Memory`, `ComputeBackend`, and the FFI ids
16. [parallel execution](./parallel.md), the workers plugin, the `parallel` system form, the kernel
    signature, the join stamp, and the limits

### Integration with a host and a UI

17. [the optional entry points](../INTEGRATION.md), how they fit together in a real application
18. [the host write path](./host-write-seam.md), how to queue typed writes from a host, a UI, or
    an editor
19. [solid](./solid.md), the `solid()` plugin, which is the one path from ECS state into a UI
20. [editor](./editor.md), undo, redo, and field handles
21. [traces](./tracing.md), the frame trace and the dispatch trace (development builds only)

### Reference

22. [primitives](./primitives.md), the data structures under `@oasys/oecs/primitives` that you can
    use again
23. [errors](./errors.md), the `ECSError` taxonomy, including the two development-only id
    faults `INVALID_EVENT_ID` and `INVALID_SYSTEM_ID`
24. [plugins](./plugins.md), for a plugin author: `Plugin`, `PluginHost`, `PluginsOf`, the nine
    host members, the route seam, a phase of your own, the rules `ECS.create` checks, and the
    change feed a plugin drains, which is `ChangeFeed` with `ObservationFlags`, `DrainResult` and
    `StructuralObserverEvents`

<a id="dev-vs-prod--read-this-once"></a>

## Development and production, read this one time

A compile-time flag, `__DEV__`, controls each run-time check:

- the bounds and liveness checks
- the detection of a system that you added two times
- the validation at registration
- the **system access checker**, which holds you to `reads` and `writes`.

The build tool **removes these checks from a production build**.

**Production is the default.** On npm, `@oasys/oecs` is the production build, with the guards
removed. A bundler in development mode selects the build with the guards automatically, through the
`development` export condition. As an alternative, import `@oasys/oecs/dev`. Each plugin has
the same subpath: `@oasys/oecs/relations/dev`, `@oasys/oecs/events/dev`,
`@oasys/oecs/snapshots/dev`, `@oasys/oecs/observers/dev`, `@oasys/oecs/workers/dev`,
`@oasys/oecs/editor/dev` and `@oasys/oecs/solid/dev`. Take the
plugin from the same channel as the world. A plugin binds to the core build it was made against. On JSR and Deno the
default is also production. JSR publishes no `/dev` subpath. Set `globalThis.__DEV__ = true`
before the first import to turn the guards on. The
[Development guards and production builds](../PRODUCTION.md) guide has the full matrix.

> [!IMPORTANT]
> When this documentation says that an operation "throws in development", that behavior is a
> **development aid, and not a production guarantee**. In a production build the guards are absent,
> and the same mistake *fails without a signal*. You then get an incorrect value, a `NaN`, or
> quiet corruption, and not an exception. Correct each violation while you develop. Do not depend
> on a production build to catch it. A few checks stay active in each build, and the scheduler's
> cycle detection is one. [errors](./errors.md) names each of them.
