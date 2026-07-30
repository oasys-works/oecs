# Schedule

The schedule decides **when** each system runs. A system belongs to one of seven **phases**. In each
phase, the engine sorts the systems topologically from their `before` and `after` constraints. The
startup phases run one time. The update phases run in each frame. The fixed-update phase runs at a
fixed timestep.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

ecs.addSystems(SCHEDULE.UPDATE, move, collide);
ecs.startup();          // runs the startup phases one time
ecs.update(1 / 60);     // runs fixed-update (as necessary) and the update phases
```

## The seven phases

```ts
enum SCHEDULE {
  PRE_STARTUP, STARTUP, POST_STARTUP,   // one time, through startup()
  FIXED_UPDATE,                         // a fixed timestep, inside update()
  PRE_UPDATE, UPDATE, POST_UPDATE,      // one time in each frame, through update()
}
```

| Phase | When it runs | Delta time |
| --- | --- | --- |
| `PRE_STARTUP` → `STARTUP` → `POST_STARTUP` | one time, in this order, on `ecs.startup()` | `0` |
| `FIXED_UPDATE` | 0 to `maxFixedSteps` times in each `update()`, *before* the variable phases | `fixedTimestep` |
| `PRE_UPDATE` → `UPDATE` → `POST_UPDATE` | one time in each `ecs.update(dt)`, in this order | the `dt` that you gave |

> [!IMPORTANT]
> After each phase, the engine **flushes** the deferred structural changes before the next phase
> starts. So a component that `ctx.commands.add` added in `PRE_UPDATE` is visible to the queries
> in `UPDATE`. Inside one phase, the deferred changes are not yet applied.

## The frame loop

**`ecs.startup()`** — Call this one time, after you connect the systems and the observers. It
prepares the archetypes, runs the `onAdded` hook of each system, runs the three startup phases, and
clears each event that they emitted. So frame 1 does not see an old startup event.

**`ecs.update(dt)`** — This is one frame. It runs the fixed-update catch-up loop, then
`PRE_UPDATE`, `UPDATE`, and `POST_UPDATE`. Then it dispatches the `onSet` observers, clears the
events, and increases the tick.

**`ecs.flush()`** — This applies the buffered deferred structural operations now. You rarely need
it, because the phase boundaries and `update()` already flush.

### How to drive the loop: `FrameStepper`

`update(dt)` is the authoritative "run one frame" primitive. **`FrameStepper`** is an optional
driver above it, on the host side, so that you do not write the `requestAnimationFrame` loop
yourself:

```ts
const stepper = new FrameStepper(ecs, {
  fixedDt: 1 / 60,   // the dt that step() uses when you give none (default 1/60)
  maxDt: 0.25,       // the limit on a raw browser-frame delta (default 0.25 s)
  autoStart: true,   // start the rAF loop immediately (default false)
});
stepper.play();               // tick on requestAnimationFrame
stepper.pause();              // stop; a manual step() continues to operate
stepper.toggle();
stepper.step();               // advance exactly one frame (debuggers, tests, editors)
stepper.stepFrames(10);       // replay a paused simulation
```

`maxDt` limits each raw rAF delta **before** it reaches `update()`. A tab in the background stops
rAF. Without the limit, the first frame after the tab returns would carry the full period of
suspension as one delta. `maxFixedSteps` would still bound it, but the result would be a burst of
steps. The first frame after `play()` uses `fixedDt`, because there is no earlier timestamp. The
stepper trusts an explicit `step(dt)` delta, and does not limit it. A host that is not a browser,
and a test, can supply `requestFrame` and `cancelFrame`. A validation failure throws
`INVALID_FRAME_STEP`. At run time the stepper exposes `isRunning`, the settable properties
`fixedDt` and `maxDt`, and `dispose()`.

## How to add systems and set their order

```ts
addSystems(label: SCHEDULE, ...entries: (SystemDescriptor | SystemEntry)[]): this;

interface SystemEntry {
  system: SystemDescriptor;
  ordering?: { before?: SystemOrderingTarget[]; after?: SystemOrderingTarget[] };
  runIf?: RunCondition | RunCondition[];   // joined with AND to the conditions of each set
  set?: SystemSet | SystemSet[];
}
// SystemOrderingTarget = SystemDescriptor | SystemSet
```

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,                                              // a descriptor alone
  { system: move, ordering: { after: [input] } },     // with an order
  { system: render, ordering: { after: [move] }, runIf: notPaused },
);
```

`before: [X]` puts this system before `X`. `after: [X]` puts it after `X`. A `SystemSet` target
expands to each of its members.

> [!WARNING]
> **An order applies inside one phase only.** The engine ignores an order target that you scheduled
> in a *different* phase, because the phases already have an order. If a target is in **no** phase,
> because of a spelling error or because you did not call `addSystems`, the engine removes the
> constraint and gives a warning in development. The warning goes through `ECSOptions.onWarn`,
> which is `console.warn` by default. The system then uses the insertion order to break the tie.

> [!WARNING]
> If you add the same descriptor to two phases, it throws `DUPLICATE_SYSTEM` in development.
> Register a second system if you need the same logic in two phases.

### Topological order and cycles

In each phase, the engine sorts the systems with Kahn's algorithm over the `before` and `after`
edges. **Insertion order breaks a tie, which keeps the result deterministic.** The engine caches
the result for each phase, and it clears the cache on a change.

> [!CAUTION]
> A cycle in the order constraints throws `CIRCULAR_SYSTEM_DEPENDENCY`, and the message names the
> phase. The engine raises it at the first run or sort of that phase, and not at the time of
> `addSystems`. This check is **always active**, and it is present in production also.

## System sets

A **system set** is a named group. Its members share a run condition, an order, or both.

```ts
systemSet(name: string): SystemSet;
configureSet(set: SystemSet, config: { runIf?; before?; after? }): this;

const physics = systemSet("physics");
ecs.addSystems(SCHEDULE.FIXED_UPDATE, { system: integrate, set: physics });
ecs.addSystems(SCHEDULE.FIXED_UPDATE, { system: collide,   set: physics });
ecs.configureSet(physics, { runIf: notPaused, before: [render] });
```

The effective gate of a member is the **AND** of its own conditions and the conditions of each set
that contains it. `configureSet` adds to the configuration, and its order against `addSystems` is
not important. You can configure the set before you add its members, or after.

> [!NOTE]
> A set has an identity of **object identity, and not of name**. Two `systemSet("x")` calls give two
> different sets. Keep the handle and use it again. The `name` is for diagnostics only.

## Run conditions

A **run condition** is a gate for each tick. Give `true` to run the system or the set in this tick.
Give `false` to skip it.

```ts
interface RunCondition {
  readonly name: string;
  readonly evaluate: (ctx: ConditionContext) => boolean;
  readonly reads?: readonly ComponentDef[];
  readonly resourceReads?: readonly ResourceKey<unknown>[];
}
// ConditionContext exposes only { ecsTick, resource(key), hasResource(key) } — read-only.
```

The supplied conditions are:

```ts
runIfResourceEq<T>(key: ResourceKey<T>, expected: T): RunCondition;   // strict === (identity for objects)
runEveryNTicks(n: number, offset?: number): RunCondition;            // ticks offset, offset+n, offset+2n…
runIfAnyMatch(query: Query): RunCondition;                           // query.entityCount > 0
```

The combinators compose conditions, so that you do not write closures yourself. Each combinator
joins the declared `reads` and `resourceReads` of its operands, so that `accessCheck` continues to
see each edge. It also builds its `name` from the operands. Evaluation stops at the first decisive
operand, in argument order, as `&&` and `||` do:

```ts
not(cond: RunCondition): RunCondition;          // run exactly when `cond` would skip
allOf(...conds: RunCondition[]): RunCondition;  // each condition passes (&&)
anyOf(...conds: RunCondition[]): RunCondition;  // one condition or more passes (||)
```

An empty argument list follows vacuous truth. `allOf()` always runs the system. `anyOf()` never
runs it.

This `anyOf` gates *systems*. It has no relation to the [`Query.anyOf`](./queries.md) filter verb.

```ts
const notPaused = runIfResourceEq(PausedRes, false);
ecs.addSystems(SCHEDULE.UPDATE, { system: ai, runIf: runEveryNTicks(10) });
ecs.configureSet(physics, { runIf: notPaused });

// composed: run the AI less frequently, but only while the game is not paused
ecs.addSystems(SCHEDULE.UPDATE, { system: ai, runIf: allOf(notPaused, runEveryNTicks(10)) });
```

> [!WARNING]
> A run condition **must be deterministic and must only read**. It must be a pure function of the
> `ECS` state, with no clock time, no random numbers, and no mutation. The engine evaluates it in
> an access span that permits reads only. If it touches a resource that you did not declare, or if
> it mutates anything, it throws in development. A condition that is not deterministic makes the
> `stateHash` different between [deterministic](./determinism.md) peers.

> [!NOTE]
> When a condition gives `false`, the last-run tick of the system does **not** increase. So a tick
> that the system skips is equivalent to a tick in which the system is absent. This is important for
> the [`changed()`](./change-detection.md) queries inside it.

> [!NOTE]
> `runIfAnyMatch` needs a query that is **dense only**, because `entityCount` rejects a sparse,
> relation, or hierarchy term. To gate on sparse membership, write your own `evaluate` function
> instead.

A schedule with no set and no condition runs a byte-for-byte fast path. The feature has no cost
until you use it.

## The fixed timestep

`FIXED_UPDATE` systems run on a fixed clock, independent of the frame rate of the display. This is
the usual configuration for stable physics.

```ts
const ecs = new ECS({ fixedTimestep: 1 / 50, maxFixedSteps: 4 });
get fixedTimestep(): number;   set fixedTimestep(value: number);   // validates again
get fixedAlpha(): number;      // accumulator / fixedTimestep — the interpolation factor in [0, 1)
```

Each `update(dt)` call adds `dt` to an accumulator. It then runs `FIXED_UPDATE` one time for each
full `fixedTimestep` in that accumulator: 0 times for a small `dt`, and several times for a large
`dt`. A fixed system always sees a delta that is equal to `fixedTimestep`, and never the frame
`dt`.

> [!WARNING]
> **`maxFixedSteps` is the limit that prevents the spiral of death.** It limits the number of fixed
> steps that one slow frame runs. So one stop cannot make each frame run more and more catch-up
> steps and fall further behind. `fixedTimestep` must be finite and more than 0, or it throws
> `INVALID_FIXED_TIMESTEP`, and its setter validates it again. `maxFixedSteps` must be an integer
> of 1 or more, or it throws `INVALID_MAX_FIXED_STEPS`, and you set it at construction.

> [!TIP]
> Use `ecs.fixedAlpha` to interpolate the display between two fixed steps:
> `renderPos = lerp(prevPos, pos, ecs.fixedAlpha)`.

## See also

- [systems](./systems.md) — how to declare and write the systems that you schedule here
- [resources](./resources.md) — the state that `runIfResourceEq` gates on
- [determinism](./determinism.md) — why a run condition must stay pure
