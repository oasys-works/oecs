# Determinism

> This page needs the **snapshots** plugin. Install it at construction:
>
> ```ts
> import { snapshots } from "@oasys/oecs/snapshots";
>
> const world = ECS.create({ plugins: [snapshots()] });
> ```
>
> A world built with `new ECS()` has none of it, and reaching for it is a compile error.
> `capture` and `restore` need it. `stateHash` and `deterministic` do not: they
> describe the world, and every world answers them.

> [!NOTE]
> **0.5.0, a grouped surface.** The determinism surface is the state digest with the snapshot and
> resume functions. It is on the **`ecs.snapshots`** facade. The members are
> `ecs.snapshots.stateHash()`, `ecs.snapshots.capture()`, `ecs.snapshots.restore(bytes)`,
> `ecs.snapshots.captureSparse()`, `restoreSparse()`, and the `ecs.snapshots.deterministic` flag.
> `capture` and `restore` were the flat `snapshot()` and `restoreInto()`. Version 0.5.0 **removed**
> the flat `ecs.*` forms of 0.4 and earlier.

A **deterministic** `ECS` guarantees that the same sequence of operations gives the same state,
**bit for bit**. This is true across storage types, heap or `SharedArrayBuffer`. It holds across
processes on the same architecture, and after a snapshot and a restore. That guarantee is the base
for lockstep multiplayer, replay, deterministic debugging, and save and load.

Determinism is **optional**, because it has a cost. The engine keeps a canonical order, and the
rule that permits integer columns only applies. A plain `ECS` keeps no canonical order, and it does
not expose the hash and snapshot surface.

```ts
const ecs = ECS.create({ deterministic: true, plugins: [snapshots()] });
const Pos = ecs.registerComponent(["x", "y"], "i32");   // integer columns, see the rule against floats

// …run the same history on two ECS instances…
ecs.snapshots.stateHash();   // the same number on both, at the same tick boundary
```

## How to turn it on

```ts
new ECS();                              // deterministic is false by default
new ECS({ deterministic: true });       // the flag, on a world with no plugins
ECS.create({ deterministic: true, plugins: [snapshots()] }); // the flag, and capture and restore
ecs.snapshots.deterministic;            // read the flag, a getter on the facade
```

The flag and the plugin are independent. The flag buys the canonical order. The plugin buys
`capture` and `restore`. `stateHash` needs the flag and no plugin.

The flag controls exactly the surface that has a canonical order: `stateHash`, `capture` and
`restore`, and `captureSparse` and `restoreSparse`. If you call one of them without the flag, you
get `DETERMINISM_DISABLED`. The invariants for memory safety, and the division into enabled and
disabled rows, are always active.

## `stateHash`

```ts
ecs.snapshots.stateHash(): number;
```

This is an FNV-1a-32 digest. The engine folds it over
`(archetype id, live row count, enabled count, live column bytes)` for each archetype in id order.
It then folds the sparse stores, in a canonical order of the entity index. It then folds the
forward target sets of the multi relations, in a canonical order. The digest is **independent of
the storage type**. A heap `ECS` and a `SharedArrayBuffer` `ECS` with the same history give the same
number. Its cost is proportional to the number of live entities and to the sparse membership. It is
not proportional to the capacity of the buffer.

> [!IMPORTANT]
> Compare two hashes **at a tick boundary only**, which is between two `update()` calls, or at a
> settle point on a phase boundary. For the second option, use [`ecs.setTrace`](./tracing.md). Its
> `phaseBoundary` hook is the safe point to read `stateHash()`, and to reduce a divergence to one
> phase. The digest is **opaque**. Never compare it against a literal that you wrote by hand,
> because the byte order and the exact fold are internal details, and not a contract for the wire.
> The digest is valid inside one architecture and one algorithm only.

## Snapshot and restore

```ts
ecs.snapshots.capture(): Uint8Array;           // capture the full live ECS
ecs.snapshots.restore(bytes: Uint8Array): void; // put a snapshot onto this live ECS
const ECS_SNAPSHOT_VERSION: number;  // this tags the format of the combined frame. Restore throws for a different version
class ECSRestoreError extends ECSError {}  // category SNAPSHOT_RESTORE_FAILED. The live ECS is unchanged
```

A snapshot captures three sections into one `Uint8Array` that is complete in itself:

- **dense**, the column bytes and the entity index
- **sparse**, the sparse components and the relations, in a canonical order
- **host bookkeeping**, the tick and the free list of recycled entities *in live order*. It also
  holds the count of live entities and the partition counts of each archetype.

Take a snapshot at a tick boundary.

> [!IMPORTANT]
> A snapshot does **not** capture the resources, the events, or the baselines of change detection.
> Set the resources again after a restore. The events are for one frame in any condition. Each
> `changed()` query sets its tick baseline to the start value.

### Restore fails safely

`restore` validates the incoming bytes **completely, before it touches the live backing**. It
checks:

- the magic number and the version
- the exact length of the frame
- the capacity of the entity index
- the set of archetypes
- the `(componentId, fieldId, typeTag)` identity of each column
- the bounds of each index.

Only then does it write. Each difference throws, and it **leaves the live
`ECS` unchanged**. Each section has its own error. `ECSRestoreError` covers the combined frame and
the host sections. `StoreRestoreError` covers the side of the dense column store.
`SparseRestoreError` covers the sparse side.

> [!WARNING]
> The conditions for a restore. The target `ECS` must:
> - have the **same registration of components and archetypes** as the snapshot, because the engine
>   rebuilds the graph from your registration code, and not from the bytes. To **prepare** the ECS,
>   register the same components and templates, and then run `startup()`. Its set of archetypes is
>   then stable
> - have the **same capacity of the entity index**, so give the same [`memory`](./memory.md)
>   options to both
> - be `{ deterministic: true }`.
>
> If you give it a snapshot of the column store alone, and not a full-world `capture()`, it fails
> with a clear error about the magic number.

## Record and replay

Each mutation from a host or a UI goes through one control point. So you can log the applied
commands for each tick, and then replay a full session deterministically. See the
[host write path](./host-write-seam.md#record--replay) for `HostCommandRecorder` and
`replayCommandLog`.

> [!TIP]
> On a deterministic `ECS`, `replayCommandLog(..., { hash: true })` gives the sequence of
> `stateHash` values for each tick. A replay of the same log from the same seed **must** reproduce
> that exact sequence, and that equality *is* the test of fidelity. With determinism off, a replay
> still reproduces the state structurally, but there is no hash to compare.

## What makes determinism fail

> [!WARNING]
> **Floats.** On a deterministic `ECS`, registration rejects an `f32` or `f64` column
> (`NON_DETERMINISTIC_COLUMN_TYPE`). IEEE-754 rounds differently in V8, Bun, and Zig, by one unit
> in the last place, which gives a quiet divergence in each tick. The array shorthand uses `"f64"`
> by default. So you **must** give an integer type:
> `ecs.registerComponent(["x", "y"], "i32")`. Use fixed-point numbers for fractional quantities,
> for example Q16.16.

You must avoid the other sources of divergence yourself:

- **`Math.random`, clock time, and network jitter.** Each input that is not part of the lockstep
  goes into the column bytes and makes the hash different. Give a deterministic seed to a random
  number generator, and store its state in a component.
- **The order of iteration and insertion.** The canonical order that the flag holds you to is what
  makes a replay reproduce the result. This includes the sparse indices, the sorted relation sets,
  and the order in which the engine uses the free list. Do not introduce a dependence on a
  different order.
- **Resources and events** are not part of the hash. Do not use them to carry simulation state that
  you must reproduce (see above).

## See also

- [memory](./memory.md), how to size two instances the same for a restore. It also covers the
  shared and heap storage that agree on the hash
- [the host write path](./host-write-seam.md), the command log that record and replay is built on
- [components](./components.md), the requirement for integer columns
- [traces](./tracing.md), `phaseBoundary`, to reduce a divergence to one phase
