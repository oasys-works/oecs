# oecs API reference

`@oasys/oecs` is an **archetype-based Entity Component System for TypeScript that can be
deterministic**. It is pure TypeScript, it has no dependencies, and by default it runs over one
plain `ArrayBuffer`. It needs no `SharedArrayBuffer`, and no COOP/COEP headers.

This reference documents the full public surface of **0.5**. Each signature here is checked against
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
- The **schedule** runs the systems in seven phases. The startup phases run one time. The update
  phases run in each frame. The fixed-update phase runs at a fixed timestep.

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
    movers.eachChunk((cols, count) => {                    // the high-frequency loop that writes
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

| Import | What it is |
| --- | --- |
| `@oasys/oecs` | the ECS — the pure-TS heap profile by default |
| `@oasys/oecs/shared` | the optional `SharedArrayBuffer` allocators, for worker offload or a WASM backend (this needs COOP/COEP) |
| `@oasys/oecs/reactive` | the reactive kernel, which has no dependencies (`signal`, `computed`, `effect`, and reactive collections) |
| `@oasys/oecs/reactive-sync` | the bridge from the ECS to the kernel — it publishes only the changed entities and columns |
| `@oasys/oecs/editor` | undo, redo, and field handles above the host write path |
| `@oasys/oecs/solid` | the SolidJS adapter (`solid-js` is an **optional** peer dependency) |
| `@oasys/oecs/primitives` | the data structures that oecs is built from (`BitSet`, `SparseSet`, and others) |
| `@oasys/oecs/internal` | an **unstable** surface for tools — codecs, ABI constants, memory inspectors, and development singletons; there are no semver guarantees |

The root also exports **`VERSION`**, which is the package version as a string constant that you can
read at run time (`import { VERSION } from "@oasys/oecs"`). It is a literal in the source, and not
a value that the build inserts. So a consumer of the raw source (JSR) sees the same value as a
consumer of the npm bundle.

## Pages

### Core

Read these pages in this order, to get a model that you can use.

1. [components](./components.md) — `registerComponent`, the field types, tags, callable
   definitions, and bundles
2. [entities](./entities.md) — create, destroy, enable, and disable; templates; and the `EntityID`
   codec
3. [queries](./queries.md) — `query`, the verbs that make a query more exact, `forEach` compared to
   `eachChunk`, and the archetype view
4. [systems](./systems.md) — `registerSystem`, `reads` and `writes`, the system context, and
   `ctx.commands`
5. [schedule](./schedule.md) — the seven phases, the order of systems, system sets, run conditions,
   and the frame loop
6. [resources](./resources.md) — typed global values
7. [events](./events.md) — send-and-forget messages, which the ECS clears in each frame
8. [refs](./refs.md) — cached field accessors for one entity (`ctx.ref` and `ctx.refRead`)
9. [change detection](./change-detection.md) — the change ticks and the `changed()` queries
10. [observers](./observers.md) — `onAdd`, `onRemove`, `onSet`, `onEnable`, and `onDisable`
11. [relations](./relations.md) — `(relation, target)` pairs, `ChildOf` and `IsA`, wildcards, and
    cleanup policies
12. [sparse storage](./sparse-storage.md) — components outside the identity, for rare data or data
    that changes frequently

### Determinism and stored state

13. [determinism](./determinism.md) — `deterministic: true`, `stateHash`, snapshot and restore, and
    replay of a command log
14. [memory](./memory.md) — the `memory` option that sets the size, and the storage profiles
15. [WASM backends](./wasm.md) — a shared `WebAssembly.Memory`, `ComputeBackend`, and the FFI ids
16. [parallel execution](./parallel.md) — the connections for shared memory and workers, and the
    contract of the sequential scheduler

### Integration with a host and a UI

17. [extensions overview](../EXTENSIONS.md) — how the optional entry points fit together in a real
    application
18. [the host write path](./host-write-seam.md) — how to queue typed writes from a host, a UI, or
    an editor
19. [reactive](./reactive.md) — the optional reactive UI connection (`reactive`, `reactive-sync`,
    and `solid`)
20. [editor](./editor.md) — undo, redo, and field handles
21. [traces](./tracing.md) — the frame trace and the dispatch trace (development builds only)

### Reference

22. [primitives](./primitives.md) — the data structures under `@oasys/oecs/primitives` that you can
    use again
23. [errors](./errors.md) — the `ECSError` taxonomy

<a id="dev-vs-prod--read-this-once"></a>

## Development and production — read this one time

A compile-time flag, `__DEV__`, controls each run-time check:

- the bounds and liveness checks;
- the detection of a system that you added two times;
- the validation at registration;
- the **system access checker**, which holds you to `reads` and `writes`.

The build tool **removes these checks from a production build**.

**Production is the default.** On npm, `@oasys/oecs` is the production build, with the guards
removed. A bundler in development mode selects the build with the guards automatically, through the
`development` export condition. As an alternative, import `@oasys/oecs/dev`. On JSR and Deno the
default is also production. Set `globalThis.__DEV__ = true` before the first import to turn the
guards on. The [Development guards and production builds](../PRODUCTION.md) guide has the full
matrix.

> [!IMPORTANT]
> When this documentation says that an operation "throws in development", that behavior is a
> **development aid, and not a production guarantee**. In a production build the guards are absent,
> and the same mistake *fails without a signal*. You then get an incorrect value, a `NaN`, or
> quiet corruption, and not an exception. Correct each violation while you develop. Do not depend
> on a production build to catch it. Cycle detection in the scheduler is the one check that is
> always active.
