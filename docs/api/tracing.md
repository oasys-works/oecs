# Tracing

> **Dev-only.** Both tracers are gated by the compile-time `__DEV__` flag and **tree-shaken to nothing in production** — zero cost in a release build. They answer different questions: `FrameTrace` reconstructs the causal sequence of **one frame**; `dispatchTrace` aggregates **counts** across the whole process.

## Frame trace — what happened this frame

Attach a sink and the engine emits ordered events inside each `update(dt)`: which systems ran (per phase, in topological order), the structural commands each queued, flush boundaries, observer firings, event emits/reads.

```ts
import { FrameTraceRecorder } from "@oasys/oecs";

const recorder = new FrameTraceRecorder();
ecs.setTrace(recorder);        // no-op in a production build
ecs.update(1 / 60);
recorder.frames();             // readonly FrameTrace[] — one per update(), in order
recorder.reset();              // drop captured frames
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

`FrameTraceRecorder` is the shipped sink; it captures each frame as a flat, JSON-serializable `FrameTrace` (string names + numeric ids) you can stream to a browser renderer:

```ts
interface FrameTrace { readonly tick: number; readonly dt: number; readonly events: FrameTraceEvent[]; }
// FrameTraceEvent is a discriminated union: system_start | system_end | command_queued |
// flush_begin | flush_end | observer_fired | event_emitted | event_read
```

> [!TIP]
> **`phaseBoundary` is the seam for bisecting a [determinism](./determinism.md) divergence.** Implement your own `FrameTraceSink` and read `ecs.stateHash()` inside `phaseBoundary(phase)` — it fires once per phase, right after that phase's flush, the one safe point to hash. Diff the per-phase hashes between two peers to pin a divergence to a single phase. (The built-in `FrameTraceRecorder` no-ops `phaseBoundary`, since it holds no `ECS` reference to hash.)

> [!NOTE]
> The `POST_UPDATE` boundary fires **before** the tick-tail `onSet` dispatch and event clear, so for an `ECS` with `onSet` observers the final per-tick hash may differ from the `POST_UPDATE` phase hash; one without them reconciles exactly. `observerFired` uses `entity === -1` for archetype-granular `onSet`. Sinks must be side-effect-free with respect to the `ECS` — the seam only observes.

## Dispatch trace — counts across the process

A global singleton that aggregates event/resource/action dispatch **counts** by call site — a profiling view of *how often* channels fire, not the order.

```ts
import { dispatchTrace } from "@oasys/oecs/internal"; // unstable tooling surface

dispatchTrace.isActive();    // gated by __DEV__ AND the VISUAL_INTEL_TRACE env var
dispatchTrace.snapshot();    // DispatchTraceSnapshot — deterministic, sorted, JSON-serializable
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
> **Double gate:** compile-time `__DEV__` removes every call site in production, and at runtime it stays inert unless `VISUAL_INTEL_TRACE` is `"1"`/`"true"`. It's in-memory only (browser-safe, no filesystem) and resolves call sites from stack traces (cached per line). Contrast with `FrameTrace`, which is per-`ECS` and ordered.

## See also

- [determinism](./determinism.md) — using `phaseBoundary` + `stateHash` to bisect a divergence
- [systems](./systems.md) · [observers](./observers.md) — the entities a frame trace reports on
