# Parallel execution

> **The contract today.** oecs has connections for shared memory and for a worker or WASM backend
> now. But the supplied schedule is still **sequential and deterministic**: after the topological
> sort, the systems in each phase run one at a time. The engine holds you to the access
> declarations in development builds today, and those declarations are the data that a parallel
> scheduler would need later.

There are two different ideas here, and it is easy to confuse them:

- **Shared execution storage** — The columns can be in a `SharedArrayBuffer` or in a shared
  `WebAssembly.Memory`. So a worker or a WASM backend can see the same bytes.
- **Parallel execution of the schedule** — This runs independent systems at the same time. oecs
  does not do this yet, and the public scheduler runs the systems in sequence.

## What operates today

### Shared storage

Use `memory.shared` when a second thread must see the store. Use `memory.wasm` when the store must
be a `WebAssembly.Memory`.

```ts
import { ECS } from "@oasys/oecs";

new ECS({ memory: { shared: {} } });                   // SharedArrayBuffer storage
new ECS({ memory: { wasm: { maximumPages: 4096 } } }); // a shared WebAssembly.Memory
```

A browser build needs cross-origin isolation for both profiles. A heap world needs no isolation,
but you cannot share it with a worker, and you cannot use it with a WASM compute backend.

### Systems that a backend runs

A system can run through a backend, in place of its TypeScript closure:

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

The scheduler still reaches that system in the usual order of the phase. Only the body is
different: `backend.run(stepHandle)` in place of `fn(ctx, dt)`.

### Writes from a different thread

A worker, a development tool, UI code, or a network handler must not mutate the ECS directly while
a frame runs. Use the [host write path](./host-write-seam.md), which drains the commands at the
head of a phase:

```ts
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);

// At any time, outside the schedule:
queue.setField(entity, Pos, "x", 10);

// The host write path applies it during update(), at a known point.
ecs.update(1 / 60);
```

For data from a worker or from the wire, `HostCommandDispatcher` decodes ring slots of a fixed size
into the same command apply path.

## How to write systems that are ready for parallel execution

Execution is sequential today, but write each system as if its access declarations were important.
They already are important in development builds, and they are the shape of safe parallel execution
later.

```ts
const integrate = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  fn: (ctx, dt) => { /* the high-frequency loop */ },
});
```

Rules to follow:

- Declare each component, sparse component, relation, and resource that the system reads or writes.
- Use narrow systems. Do not use broad `exclusive` systems.
- Use `ctx.commands` for a structural change during iteration, and let the flush at the end of the
  phase apply it.
- Keep each run condition deterministic and read-only.
- Keep each write from a host or a worker that is outside the schedule behind
  `installHostCommandSeam`.
- Keep the backend systems honest: the TypeScript declaration must describe the memory that the
  backend touches.

## `exclusive` will mean "runs alone" later

Today, `exclusive: true` bypasses the access check, for engine or host code that you trust. Under a
parallel scheduler later, the same flag would make that system run alone.

```ts
const applyHostCommands = ecs.registerSystem({
  exclusive: true,
  reads: [],
  writes: [],
  fn: (ctx) => { /* may touch arbitrary ECS state */ },
});
```

Use it for global apply, load, or debug work that truly cannot declare a limited surface. Do not use
it as a convenient alternative for a usual gameplay system.

## The order is still explicit

Sequential does not mean unordered. Inside a phase, oecs sorts the `before` and `after` constraints
topologically. It then uses insertion order to break a tie, which keeps the result deterministic.

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,
  { system: simulate, ordering: { after: [input] } },
  { system: renderPrep, ordering: { after: [simulate] } },
);
```

If two systems are independent, do not add an order constraint between them. This keeps the current
graph clear, and it leaves space for parallel execution later.

## Notes on determinism

The default scheduler is deterministic, because it has one canonical order for each phase. Backend
code can keep that property if it follows the same rules:

- Do not use clock time, ambient random numbers, or unordered iteration.
- Keep floating-point numbers out of the component columns of a `deterministic: true` world.
- Apply each write from a worker or a host through the host write path, so that each one lands at
  the same phase boundary in each run.
- Keep each backend write inside the declared access surface of the system.

## What oecs does not supply today

- No automatic work-stealing scheduler, and no multithreaded system scheduler.
- No supplied entry point for a worker.
- No WASM module in the package.
- No automatic conflict graph, past the current development access checker and the schedule data.

These limits are intentional. The engine owns the store layout, the order of the schedule, the
access declarations, and the transport for host writes. You own the topology of your workers, the
compilation of your backend, and each parallel kernel that is specific to your problem.

## See also

- [WASM backends](./wasm.md) — how to connect shared memory and `ComputeBackend`
- [memory](./memory.md) — the heap, shared, and WASM storage profiles
- [systems](./systems.md) — the access declarations and `exclusive`
- [schedule](./schedule.md) — the phases, the order, system sets, and run conditions
- [the host write path](./host-write-seam.md) — safe writes from outside the schedule
