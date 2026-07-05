# Parallelism

> **Current contract.** oecs has shared-memory and worker/WASM integration seams today. The built-in schedule is still **sequential and deterministic**: systems run one at a time in each phase after topological ordering. Access declarations are enforced in dev today and are the metadata a future parallel scheduler would use.

There are two different ideas that are easy to blur:

- **Shared execution substrate** — columns can live in `SharedArrayBuffer` or shared `WebAssembly.Memory`, so a worker or WASM backend can see the same bytes.
- **Parallel schedule execution** — running independent systems at the same time. oecs does not do this yet; the public scheduler executes sequentially.

## What works today

### Shared backing

Use `memory.shared` when another thread needs to observe the store, or `memory.wasm` when the store should be a `WebAssembly.Memory`.

```ts
import { ECS } from "@oasys/oecs";

new ECS({ memory: { shared: {} } });                   // SharedArrayBuffer backing
new ECS({ memory: { wasm: { maximumPages: 4096 } } }); // shared WebAssembly.Memory
```

Browser builds need cross-origin isolation for either profile. Heap worlds need no isolation, but cannot be shared with workers or used as a WASM compute backend.

### Backend-routed systems

A system can run through a backend instead of its TypeScript closure:

```ts
const step = ecs.registerSystem({
  reads: [Input],
  writes: [Pos, Vel],
  queries: [[Pos, Vel]],
  backendHandle: stepHandle,
  fn: tsFallback,
});

ecs.attachBackend(myBackend);
```

The scheduler still reaches that system in normal phase order. The difference is only the body: `backend.run(stepHandle)` instead of `fn(ctx, dt)`.

### Cross-thread writes

Workers, dev tools, UI code, or network handlers should not mutate the ECS directly while a frame is running. Use the [host-write seam](./host-write-seam.md), which drains commands at a schedule head:

```ts
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(world);

// Any time, outside the schedule:
queue.setField(entity, Pos, "x", 10);

// Applied by the seam during update(), in a known place.
ecs.update(1 / 60);
```

For worker / wire data, `HostCommandDispatcher` decodes fixed-size ring slots into the same command apply path.

## How to write systems that are parallel-ready

Even though execution is sequential today, write systems as if their access declarations matter. They already do in dev builds, and they are the shape of safe parallelism later.

```ts
const integrate = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  fn: (ctx, dt) => { /* hot loop */ },
});
```

Rules of thumb:

- Declare every component, sparse component, relation, and resource the system reads or writes.
- Prefer narrow systems over broad `exclusive` systems.
- Use `ctx.commands` for structural changes during iteration; let the phase flush apply them.
- Keep run conditions deterministic and read-only.
- Keep off-schedule host / worker writes behind `installHostCommandSeam`.
- Keep backend systems honest: the TypeScript declaration must describe the memory the backend touches.

## `exclusive` means "runs alone" later

Today, `exclusive: true` is an access-check bypass for trusted engine or host machinery. Under a future parallel scheduler, the same flag would force that system to run alone.

```ts
const applyHostCommands = ecs.registerSystem({
  exclusive: true,
  reads: [],
  writes: [],
  fn: (ctx) => { /* may touch arbitrary ECS state */ },
});
```

Use it for global apply / load / debug work that genuinely cannot declare a bounded surface. Do not use it as a convenience escape hatch for normal gameplay systems.

## Ordering is still explicit

Sequential does not mean unordered. Within a phase, oecs topologically sorts `before` / `after` constraints, then uses insertion order as the deterministic tiebreaker.

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,
  { system: simulate, ordering: { after: [input] } },
  { system: renderPrep, ordering: { after: [simulate] } },
);
```

If two systems are independent, do not add an artificial ordering edge. That keeps the current graph clear and leaves room for future parallel execution.

## Determinism notes

The default scheduler is deterministic because it has one canonical order per phase. Backend code can preserve that property if it follows the same rules:

- Avoid wall-clock time, ambient randomness, and unordered iteration.
- Keep floating point out of `deterministic: true` component columns.
- Apply worker / host writes through the seam so they land at the same phase boundary each run.
- Keep backend writes within the declared system access surface.

## Not provided by oecs today

- No automatic work-stealing or multithreaded system scheduler.
- No built-in worker entrypoint.
- No bundled WASM module.
- No automatic conflict graph beyond the current dev access checker and schedule metadata.

Those omissions are intentional boundaries: the engine owns the store layout, schedule order, access declarations, and host-write transport; the consumer owns worker topology, backend compilation, and any domain-specific parallel kernels.

## See also

- [WASM backends](./wasm.md) — wiring shared memory and `ComputeBackend`
- [memory](./memory.md) — heap vs shared vs WASM storage profiles
- [systems](./systems.md) — access declarations and `exclusive`
- [schedule](./schedule.md) — phases, ordering, system sets, and run conditions
- [host-write seam](./host-write-seam.md) — safe off-schedule writes
