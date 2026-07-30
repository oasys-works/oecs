# Traces

> **Development builds only.** The compile-time `__DEV__` flag controls both tracers, and the build
> tool **removes them completely from a production build**. So they cost nothing in a release
> build. They answer different questions. `FrameTrace` shows the sequence of causes and effects in
> **one frame**. `dispatchTrace` collects **counts** across the full process.

## The frame trace — what happened in this frame

Attach a sink. The engine then emits ordered events inside each `update(dt)` call:

- which systems ran, in each phase, in topological order;
- the structural commands that each one put in the queue;
- the flush boundaries;
- the observers that ran;
- the emissions and the reads of events.

```ts
import { FrameTraceRecorder } from "@oasys/oecs";

const recorder = new FrameTraceRecorder();
ecs.setTrace(recorder);        // does nothing in a production build
ecs.update(1 / 60);
recorder.frames();             // readonly FrameTrace[] — one for each update(), in order
recorder.reset();              // remove the captured frames
ecs.setTrace(null);            // detach
```

```ts
setTrace(sink: FrameTraceSink | null): void;

interface FrameTraceSink {
  tickBegin(tick, dt): void;   tickEnd(tick): void;
  systemStart(system, phase): void;   systemEnd(system): void;
  commandQueued(op: StructuralOp, entity, component: number | null): void;
  flushBegin(phase): void;   flushEnd(phase): void;
  phaseBoundary(phase): void;
  observerFired(op: ObserverOp, component, entity, observer): void;
  eventEmitted(key): void;   eventRead(key, count): void;
}
type StructuralOp = "spawn" | "despawn" | "add" | "remove" | "enable" | "disable";
type ObserverOp   = "add" | "remove" | "set" | "enable" | "disable";
```

`FrameTraceRecorder` is the sink that oecs supplies. It captures each frame as a flat `FrameTrace`
that you can serialize to JSON, with string names and numeric ids. So you can send it to a
renderer in a browser:

```ts
interface FrameTrace { readonly tick: number; readonly dt: number; readonly events: FrameTraceEvent[]; }
// FrameTraceEvent is a discriminated union: system_start | system_end | command_queued |
// flush_begin | flush_end | observer_fired | event_emitted | event_read
```

> [!TIP]
> **`phaseBoundary` is the point at which you can find a divergence in
> [determinism](./determinism.md).** Write your own `FrameTraceSink`, and read
> `ecs.snapshots.stateHash()` inside `phaseBoundary(phase)`. That hook runs one time for each
> phase, immediately after the flush of that phase, and it is the one safe point at which to read
> the hash. Compare the hashes for each phase between two peers, and you can reduce a divergence to
> one phase. The supplied `FrameTraceRecorder` does nothing in `phaseBoundary`, because it holds no
> reference to an `ECS` and so cannot read the hash.

> [!NOTE]
> The `POST_UPDATE` boundary runs **before** the `onSet` dispatch and the event clear at the end of
> the tick. So, for an `ECS` with `onSet` observers, the final hash for the tick can be different
> from the hash at the `POST_UPDATE` phase. For an `ECS` with no `onSet` observer, the two agree
> exactly. `observerFired` uses `entity === -1` for an `onSet` observer with archetype
> granularity. The `observer` field carries the `name` from the config of the observer. When there
> is no name, it uses `observer(<component debug name>)`, and then `observer(<cid>)`. See
> [observers](./observers.md). A sink must have no effect on the `ECS`, because this connection
> observes only.

## The dispatch trace — counts across the process

This is a global object. It collects the **counts** of the dispatches of events, resources, and
actions, by call site. It is a profile of *how frequently* a channel runs, and not of the order.

```ts
import { dispatchTrace } from "@oasys/oecs/internal"; // an unstable surface for tools

dispatchTrace.isActive();    // the run-time half of the gate: the VISUAL_INTEL_TRACE environment variable (the call sites check __DEV__)
dispatchTrace.snapshot();    // DispatchTraceSnapshot — deterministic, sorted, and serializable to JSON
dispatchTrace.reset();
```

```ts
interface DispatchTraceEntry { readonly key: string | number; readonly file: string; readonly count: number; }
interface DispatchTraceSnapshot {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly channels: {
    readonly "ecs-events": Record<"emit" | "read", DispatchTraceEntry[]>;
    readonly actions: Record<"send_action" | "handle_action", DispatchTraceEntry[]>;
    readonly resources: Record<"read" | "write" | "register" | "remove", DispatchTraceEntry[]>;
  };
}
```

> [!NOTE]
> **There are two gates.** The compile-time `__DEV__` flag removes each call site from a production
> build. At run time, the trace stays inactive unless `VISUAL_INTEL_TRACE` is `"1"` or `"true"`. It
> is in memory only, so it is safe in a browser and it uses no file system. It finds the call sites
> from stack traces, and it caches the result for each line. Compare it with `FrameTrace`, which
> belongs to one `ECS` and which keeps the order.

## See also

- [determinism](./determinism.md) — how to use `phaseBoundary` with `stateHash` to find a
  divergence
- [systems](./systems.md) · [observers](./observers.md) — the objects that a frame trace reports on
