# Schedule

The schedule decides **when** each system runs. A system belongs to one **phase**. In each
phase, the engine sorts the systems topologically from their `before` and `after` constraints. The
startup phases run one time. The update phases run in each frame. The fixed-update phase runs at a
fixed timestep.

A world starts with seven phases. The set is open: `ecs.addPhase` adds one more slot to a loop.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

ecs.addSystems(SCHEDULE.UPDATE, move, collide);
ecs.startup();          // runs the startup phases one time
ecs.update(1 / 60);     // runs fixed-update (as necessary) and the update phases
```

## The seven built-in phases

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

## Adding a phase

`ecs.addPhase(name, config)` adds one slot to a loop and gives back a `Phase` handle. A plugin owns
its own slot that way. It no longer contends for insertion order inside a phase that the
application also writes to.

```ts
addPhase(name: string, config: PhaseConfig): Phase;

type PhaseLoop = "startup" | "fixed" | "update";

interface PhaseConfig {
  readonly loop: PhaseLoop;
  readonly before?: readonly SchedulePhase[];   // run before each of these
  readonly after?: readonly SchedulePhase[];    // run after each of these
}

interface Phase {
  readonly name: string;      // diagnostics and the frame trace
  readonly loop: PhaseLoop;
}

type SchedulePhase = SCHEDULE | Phase;       // either spelling, wherever a phase is taken
type PhaseName = SCHEDULE | (string & {});   // the name a frame trace event carries
```

`addPhase` is a setup call. Call it before the frame loop starts.

### The three loops

| `loop` | What drives it | Delta time |
| --- | --- | --- |
| `"startup"` | `ecs.startup()`, one time | `0` |
| `"fixed"` | the accumulator inside `ecs.update(dt)`, 0 to `maxFixedSteps` times | `fixedTimestep` |
| `"update"` | `ecs.update(dt)`, one time in each frame | the `dt` that you gave |

A phase belongs to one loop for its life. The loop decides the delta time that the phase receives,
and how often it runs. An empty phase runs an empty plan and a flush, the same as an empty built-in.
A fixed phase with no system leaves the accumulator asleep.

### The order between phases

`before` and `after` order the new phase against the other phases of the **same loop**. The engine
sorts each loop with Kahn's algorithm, and declaration order breaks a tie. That is the rule the
systems inside a phase already follow.

A target in another loop expands to nothing, the way an order target in another phase does. A phase
that names no neighbour runs after every phase declared before it. So it lands at the tail of
its loop.

The built-in seven keep their chain. `PRE_UPDATE` runs before `UPDATE`, and `UPDATE` runs before
`POST_UPDATE`. So a phase added `before: [SCHEDULE.UPDATE]` does not also jump ahead of
`PRE_UPDATE`.

The engine resolves the order at `addPhase`, and not in each frame.

### Either spelling names a phase

The seven built-ins have no handle. `SCHEDULE.UPDATE` names one directly, and `addSystems` takes
either spelling. So no call that you write today changes.

> [!NOTE]
> A phase has an identity of **object identity, and not of name**, the rule `systemSet` also
> follows. Two `addPhase("physics", …)` calls give two different phases. Keep the handle and use it
> again. The `name` is for diagnostics and for the frame trace.

### The two faults

`UNKNOWN_PHASE` says the phase is not a phase of this world. The cause is a name that no built-in
spells, or a handle that another world made. `CIRCULAR_PHASE_DEPENDENCY` says one loop's phase
order holds a cycle, so no run order exists.

Both throw in **each** build, and not in a development build alone. A handle from another world
would otherwise push systems into that world's list. A production build would then run them
nowhere.

### A plugin adds a phase

A plugin reaches `addPhase` through `host.world`, the bare world that its `install` receives. It
returns the handle on its facade, so an application can order its own systems against the slot.

```ts
import { ECS, SCHEDULE, type Phase, type Plugin, type PluginHost } from "@oasys/oecs";

interface PhysicsPlugin {
  readonly physics: { readonly phase: Phase };
}

function physics(): Plugin<PhysicsPlugin> {
  return {
    name: "physics",
    install(host: PluginHost): PhysicsPlugin {
      const phase = host.world.addPhase("physics", {
        loop: "update",
        after: [SCHEDULE.PRE_UPDATE],
        before: [SCHEDULE.UPDATE]
      });
      const integrate = host.world.registerSystem({ reads: [], writes: [], fn: () => {} });
      host.world.addSystems(phase, integrate);
      return { physics: { phase } };
    }
  };
}

const game = ECS.create({ plugins: [physics()] });
// Registered later, and into a phase that runs earlier. The phase order decides,
// and not the insertion order.
game.addSystems(SCHEDULE.PRE_UPDATE, game.registerSystem({ reads: [], writes: [], fn: () => {} }));
game.startup();
game.update(1 / 60); // PRE_UPDATE, then physics, then UPDATE
```

A frame trace names the phase by its `name`. So `phase` on a trace event is a `PhaseName` and not a
`SCHEDULE`. See [traces](./tracing.md).

`src/core/ecs/__tests__/integration/phase.test.ts` locks the order against the built-ins the phase
names, the identity rule, the three loops and both faults.

## The frame loop

**`ecs.startup()`**. Call this one time, after you connect the systems and the observers. It
prepares the archetypes, and runs the `onAdded` hook of each system. It then runs the three startup
phases, and clears each event that they emitted. So frame 1 does not see an old startup event.

**`ecs.update(dt)`**. This is one frame. It runs the fixed-update catch-up loop, then
`PRE_UPDATE`, `UPDATE`, and `POST_UPDATE`. Then it settles. The settle advances the change tick,
runs each plugin's settle hook, clears the events, and increases the frame tick. The observers
plugin dispatches its `onSet` callbacks in that hook.

**`ecs.flush()`**. This applies the buffered deferred structural operations now. You rarely need
it, because the phase boundaries and `update()` already flush.

### How to drive the loop: `FrameStepper`

`update(dt)` is the authoritative "run one frame" primitive. **`FrameStepper`** is an optional
driver above it, on the host side. You then do not write the `requestAnimationFrame` loop
yourself:

```ts
const stepper = new FrameStepper(ecs, {
  fixedDt: 1 / 60,   // the dt that step() uses when you give none (default 1/60)
  maxDt: 0.25,       // the limit on a raw browser-frame delta (default 0.25 s)
  autoStart: true,   // start the rAF loop immediately (default false)
});
stepper.play();               // tick on requestAnimationFrame
stepper.pause();              // stop. A manual step() continues to operate
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
addSystems(phase: SchedulePhase, ...entries: (SystemDescriptor | SystemEntry)[]): this;

interface SystemEntry {
  system: SystemDescriptor;
  ordering?: { before?: SystemOrderingTarget[]; after?: SystemOrderingTarget[] };
  runIf?: RunCondition | RunCondition[];   // joined with and to the conditions of each set
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

The effective gate of a member is an **and**. It combines its own conditions with the conditions of
each set that contains it. `configureSet` adds to the configuration, and its order against
`addSystems` is not important. You can configure the set before you add its members, or after.

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
  readonly resourceReads?: readonly ResourceKey<any>[];
}
// ConditionContext exposes only { ecsTick, getResource(key), hasResource(key) }, read-only.
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
runIfNot(cond: RunCondition): RunCondition;        // run exactly when `cond` would skip
runIfAll(...conds: RunCondition[]): RunCondition;  // each condition passes (&&)
runIfAny(...conds: RunCondition[]): RunCondition;  // one condition or more passes (||)
```

An empty argument list follows vacuous truth. `runIfAll()` always runs the system. `runIfAny()`
never runs it.

Each name takes the `runIf` prefix, because a combinator here gates a *system*. The bare `and`,
`or` and `not` belong to the [query engine](./queries.md), where they build an archetype
expression.

```ts
const notPaused = runIfResourceEq(PausedRes, false);
ecs.addSystems(SCHEDULE.UPDATE, { system: ai, runIf: runEveryNTicks(10) });
ecs.configureSet(physics, { runIf: notPaused });

// composed: run the ai less frequently, but only while the game is not paused
ecs.addSystems(SCHEDULE.UPDATE, { system: ai, runIf: runIfAll(notPaused, runEveryNTicks(10)) });
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
get fixedAlpha(): number;      // accumulator and fixedTimestep, the interpolation factor in [0, 1)
```

Each `update(dt)` call adds `dt` to an accumulator. It then runs `FIXED_UPDATE` one time for each
full `fixedTimestep` in that accumulator. That is 0 times for a small `dt`, and several times for a
large `dt`. A fixed system always sees a delta that is equal to `fixedTimestep`, and never the frame
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

- [systems](./systems.md), how to declare and write the systems that you schedule here
- [plugins](./plugins.md), how a plugin owns a phase of its own, through `host.world.addPhase`
- [resources](./resources.md), the state that `runIfResourceEq` gates on
- [determinism](./determinism.md), why a run condition must stay pure
