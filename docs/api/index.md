# oecs API reference

`@oasys/oecs` is a **determinism-capable, archetype-based Entity Component System for TypeScript** — pure TypeScript, zero-dependency, and runs over a single plain `ArrayBuffer` by default (no `SharedArrayBuffer`, no COOP/COEP).

This reference documents the **0.5** public surface in full. Every signature here is checked against source. If you are new, read the pages in the order below; if you know ECS already, jump to what you need.

> Examples name the instance `ecs` (`const ecs = new ECS()`). Methods are camelCase; type and handle names are PascalCase (`ECS`, `Pos`, `EntityID`); constants are `SCREAMING_SNAKE` (`SCHEDULE.UPDATE`).

## The mental model in 90 seconds

- An **entity** is just an integer id (`EntityID`) — no object, no data.
- A **component** is a typed struct-of-arrays. `registerComponent({ x: "f64", y: "f64" })` returns a handle (`Pos`); the data lives in packed typed-array columns, never in per-entity objects.
- Entities with the **same set of components** share an **archetype** (one contiguous block of columns). This is why iteration is a tight loop over arrays — the "archetype" in the name.
- A **query** (`ecs.query(Pos, Vel)`) is a **live, cached** view of every archetype that matches. New matching archetypes are pushed in automatically; you build it once and reuse it.
- A **system** is a plain function that runs over queries each frame. It declares the components it `reads`/`writes` (checked in dev builds).
- The **schedule** runs systems across seven phases (`startup` once; `update` phases every frame; `fixedUpdate` at a fixed timestep).

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
    movers.eachChunk((cols, count) => {                    // mutable hot loop
      const { x, y } = cols.mut(Pos);                      // stamps Pos's change tick
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
ecs.getField(e, Pos, "x"); // ≈ 1.667
```

## Entry points

oecs ships several import paths. The core is `@oasys/oecs`; the rest are opt-in and cost nothing until imported.

| Import | What it is |
| --- | --- |
| `@oasys/oecs` | the ECS — pure-TS heap profile by default |
| `@oasys/oecs/shared` | opt-in `SharedArrayBuffer` allocators for worker offload / a WASM backend (needs COOP/COEP) |
| `@oasys/oecs/reactive` | zero-dependency reactive kernel (`signal`/`computed`/`effect`, reactive collections) |
| `@oasys/oecs/reactive-sync` | ECS→reactive bridge — publishes only dirty entities/columns |
| `@oasys/oecs/editor` | undo/redo + field-handle layer over the host-write seam |
| `@oasys/oecs/solid` | SolidJS adapter (`solid-js` is an **optional** peer dependency) |
| `@oasys/oecs/primitives` | the standalone data structures oecs is built on (`BitSet`, `SparseSet`, …) |
| `@oasys/oecs/internal` | **unstable** tooling surface — codecs, ABI constants, memory inspectors, dev singletons; no semver guarantees |

The root also exports **`VERSION`** — the package version as a string constant, readable at runtime (`import { VERSION } from "@oasys/oecs"`). It's a source literal, not a build-time injection, so raw-source (JSR) consumers see the same value as the npm bundle.

## Pages

### Core

Read these in order for a working mental model.

1. [components](./components.md) — `registerComponent`, field types, tags, callable defs, bundles
2. [entities](./entities.md) — create / destroy / enable / disable, templates, the `EntityID` codec
3. [queries](./queries.md) — `query`, refine verbs, `forEach` vs `eachChunk`, the archetype view
4. [systems](./systems.md) — `registerSystem`, `reads`/`writes`, the system context, `ctx.commands`
5. [schedule](./schedule.md) — the seven phases, ordering, system sets, run conditions, the frame loop
6. [resources](./resources.md) — typed global singletons
7. [events](./events.md) — fire-and-forget messages, cleared each frame
8. [refs](./refs.md) — cached single-entity field accessors (`ctx.ref` / `ctx.refRead`)
9. [change detection](./change-detection.md) — change ticks and `changed()` queries
10. [observers](./observers.md) — `onAdd` / `onRemove` / `onSet` / `onEnable` / `onDisable`
11. [relations](./relations.md) — `(relation, target)` pairs, `ChildOf` / `IsA`, wildcards, cleanup policies
12. [sparse storage](./sparse-storage.md) — out-of-identity components for churny / rare data

### Determinism & persistence

13. [determinism](./determinism.md) — `deterministic: true`, `stateHash`, snapshot / restore, command-log replay
14. [memory](./memory.md) — the `memory` sizing surface and storage profiles
15. [WASM backends](./wasm.md) — shared `WebAssembly.Memory`, `ComputeBackend`, and FFI ids
16. [parallelism](./parallel.md) — shared-memory / worker seams and the sequential scheduler contract

### Host & UI integration

17. [extensions overview](../EXTENSIONS.md) — how optional entry points compose in real apps
18. [host-write seam](./host-write-seam.md) — enqueue typed writes from a host / UI / editor
19. [reactive](./reactive.md) — the optional reactive UI seam (`reactive`, `reactive-sync`, `solid`)
20. [editor](./editor.md) — undo/redo + field handles
21. [tracing](./tracing.md) — per-frame trace and dispatch trace (dev-only)

### Reference

22. [primitives](./primitives.md) — the reusable data structures under `@oasys/oecs/primitives`
23. [errors](./errors.md) — the `ECSError` taxonomy

<a id="dev-vs-prod--read-this-once"></a>

## Dev vs prod — read this once

A compile-time `__DEV__` flag gates every runtime check: bounds and liveness checks, duplicate-system detection, registration validation, and the **system access checker** (`reads`/`writes` enforcement). These are **tree-shaken out of production builds**.

**Production is the default.** `@oasys/oecs` (npm) is the stripped production build; dev-mode bundlers auto-select the guards-on build via the `development` export condition, or import `@oasys/oecs/dev`. On JSR/Deno the default is also production — set `globalThis.__DEV__ = true` before the first import to enable the guards. The [Development guards & production builds](../PRODUCTION.md) guide has the full matrix.

> [!IMPORTANT]
> Everything documented as "throws in dev" is a **development tripwire, not a production guarantee**. In a production build those guards are gone and the same mistake *fails open* — a wrong value, a `NaN`, or silent corruption instead of an exception. Fix violations in dev; do not rely on them being caught in prod. The scheduler's cycle detection is the one check that is always active.
