# Schedule

The schedule decides **when** systems run. Systems live in one of seven **phases**; within a phase they're ordered topologically from `before`/`after` constraints. Startup phases run once; update phases run every frame; the fixed-update phase runs at a fixed timestep.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

ecs.addSystems(SCHEDULE.UPDATE, move, collide);
ecs.startup();          // runs the startup phases once
ecs.update(1 / 60);     // runs fixed-update (as needed) + the update phases
```

## The seven phases

```ts
enum SCHEDULE {
  PRE_STARTUP, STARTUP, POST_STARTUP,   // once, via startup()
  FIXED_UPDATE,                         // fixed timestep, inside update()
  PRE_UPDATE, UPDATE, POST_UPDATE,      // once per frame, via update()
}
```

| Phase | Runs | Delta time |
| --- | --- | --- |
| `PRE_STARTUP` → `STARTUP` → `POST_STARTUP` | once, in order, on `ecs.startup()` | `0` |
| `FIXED_UPDATE` | 0…`maxFixedSteps` times per `update()`, *before* the variable phases | `fixedTimestep` |
| `PRE_UPDATE` → `UPDATE` → `POST_UPDATE` | once per `ecs.update(dt)`, in order | the `dt` you passed |

> [!IMPORTANT]
> After every phase, deferred structural changes are **flushed** before the next phase begins. So a component `ctx.commands.add`-ed in `PRE_UPDATE` is visible to queries in `UPDATE`. Within a *single* phase, deferred changes are not yet applied.

## The frame loop

**`ecs.startup()`** — call once after wiring systems and observers. It prewarms archetypes, runs every system's `onAdded` hook, runs the three startup phases, and drains any events they emitted (so frame 1 doesn't see stale startup events).

**`ecs.update(dt)`** — one frame. It runs the fixed-update catch-up loop, then `PRE_UPDATE`/`UPDATE`/`POST_UPDATE`, then dispatches `onSet` observers, clears events, and bumps the tick.

**`ecs.flush()`** — force-apply buffered deferred structural ops right now (rarely needed; phase boundaries and `update()` already flush).

## Adding & ordering systems

```ts
addSystems(label: SCHEDULE, ...entries: (SystemDescriptor | SystemEntry)[]): this;

interface SystemEntry {
  system: SystemDescriptor;
  ordering?: { before?: OrderingTarget[]; after?: OrderingTarget[] };
  runIf?: RunCondition | RunCondition[];   // ANDed with any set conditions
  set?: SystemSet | SystemSet[];
}
// OrderingTarget = SystemDescriptor | SystemSet
```

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,                                              // bare descriptor
  { system: move, ordering: { after: [input] } },     // ordered
  { system: render, ordering: { after: [move] }, runIf: notPaused },
);
```

`before: [X]` puts this system before `X`; `after: [X]` after it. A `SystemSet` target expands to all its members.

> [!WARNING]
> **Ordering is phase-local.** An ordering target scheduled in a *different* phase is silently ignored (phases are already ordered relative to each other). A target scheduled in **no** phase — a typo, or a system you forgot to `addSystems` — is dropped with a dev-only warning (routed through `ECSOptions.onWarn`, default `console.warn`), and the constraint just vanishes; the system falls back to insertion-order tiebreak.

> [!WARNING]
> Adding the same descriptor to two phases throws `DUPLICATE_SYSTEM` in dev. Register a second system if you need the same logic in two phases.

### Topological ordering & cycles

Within each phase, systems are sorted by Kahn's algorithm over the `before`/`after` edges, with **insertion order as the deterministic tiebreaker**. The result is cached per phase and invalidated on changes.

> [!CAUTION]
> A cycle in the ordering constraints throws `CIRCULAR_SYSTEM_DEPENDENCY`, naming the phase. It's raised lazily on the first run/sort of that phase, not at `addSystems` time. This check is **always active**, even in production.

## System sets

A **system set** is a named group that shares a run condition and/or ordering, inherited by every member.

```ts
systemSet(name: string): SystemSet;
configureSet(set: SystemSet, config: { runIf?; before?; after? }): this;

const physics = systemSet("physics");
ecs.addSystems(SCHEDULE.FIXED_UPDATE, { system: integrate, set: physics });
ecs.addSystems(SCHEDULE.FIXED_UPDATE, { system: collide,   set: physics });
ecs.configureSet(physics, { runIf: notPaused, before: [render] });
```

A member's effective gate is the **AND** of its own conditions and every set it belongs to. `configureSet` is additive and order-independent with respect to `addSystems` — configure the set before or after adding members, either works.

> [!NOTE]
> Sets are identified by **object identity, not name** — two `systemSet("x")` calls are two different sets. Hold the handle and reuse it; `name` is only for diagnostics.

## Run conditions

A **run condition** is a per-tick gate: return `true` to run the system/set this tick, `false` to skip it.

```ts
interface RunCondition {
  readonly name: string;
  readonly evaluate: (ctx: ConditionContext) => boolean;
  readonly reads?: readonly ComponentDef[];
  readonly resourceReads?: readonly ResourceKey<unknown>[];
}
// ConditionContext exposes only { ecsTick, resource(key), hasResource(key) } — read-only.
```

Shipped built-ins:

```ts
runIfResourceEq<T>(key: ResourceKey<T>, expected: T): RunCondition;   // strict === (identity for objects)
runEveryNTicks(n: number, offset?: number): RunCondition;            // ticks offset, offset+n, offset+2n…
runIfAnyMatch(query: Query): RunCondition;                           // query.count() > 0
```

```ts
const notPaused = runIfResourceEq(PausedRes, false);
ecs.addSystems(SCHEDULE.UPDATE, { system: ai, runIf: runEveryNTicks(10) });
ecs.configureSet(physics, { runIf: notPaused });
```

> [!WARNING]
> A run condition **must be deterministic and read-only** — a pure function of `ECS` state, no wall-clock, no RNG, no mutation. It's evaluated in a reads-only access span; touching an undeclared resource or mutating anything throws in dev. A non-deterministic condition diverges `stateHash` across [deterministic](./determinism.md) peers.

> [!NOTE]
> When a condition returns `false`, the system's last-run tick does **not** advance — a skipped tick is indistinguishable from the system being absent that tick, which matters for [`changed()`](./change-detection.md) queries inside it.

> [!NOTE]
> `runIfAnyMatch` needs a **dense-only** query (`count()` rejects sparse/relation/hierarchy terms). Gate on sparse membership with a custom `evaluate` instead.

A schedule that uses no sets and no conditions runs a byte-for-byte fast path — you pay nothing for the feature until you use it.

## Fixed timestep

`FIXED_UPDATE` systems run on a fixed clock, decoupled from render frame rate — the standard setup for stable physics.

```ts
const ecs = new ECS({ fixedTimestep: 1 / 50, maxFixedSteps: 4 });
get fixedTimestep(): number;   set fixedTimestep(value: number);   // revalidates
get fixedAlpha(): number;      // accumulator / fixedTimestep — the render interpolation factor in [0, 1)
```

Each `update(dt)` adds `dt` to an accumulator and runs `FIXED_UPDATE` once per whole `fixedTimestep` it contains — 0 times for a small `dt`, several for a large one. Fixed systems always see delta `= fixedTimestep`, never the frame `dt`.

> [!WARNING]
> **`maxFixedSteps` is the spiral-of-death clamp** — it caps how many fixed steps one laggy frame runs, so a stall can't make each frame run ever-more catch-up steps and fall further behind. `fixedTimestep` must be finite and `> 0` (else `INVALID_FIXED_TIMESTEP`) and is revalidated by its setter. `maxFixedSteps` must be an integer `≥ 1` (else `INVALID_MAX_FIXED_STEPS`) and is set at construction.

> [!TIP]
> Use `ecs.fixedAlpha` to interpolate rendering between fixed steps: `renderPos = lerp(prevPos, pos, ecs.fixedAlpha)`.

## See also

- [systems](./systems.md) — declaring and writing the systems you schedule here
- [resources](./resources.md) — the state `runIfResourceEq` gates on
- [determinism](./determinism.md) — why run conditions must stay pure
