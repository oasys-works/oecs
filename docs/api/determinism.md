# Determinism

> [!NOTE]
> **0.5.0 — grouped surface.** The determinism surface (state digest + world snapshot/resume) live on the **`ecs.snapshots`** facade — `ecs.snapshots.stateHash()`, `ecs.snapshots.capture()` / `ecs.snapshots.restore(bytes)` (the flat `snapshot()`/`restoreInto()`), `ecs.snapshots.captureSparse()` / `restoreSparse()`, and the `ecs.snapshots.deterministic` flag. The pre-0.5 flat `ecs.*` forms were **removed** in 0.5.0.

A **deterministic** `ECS` guarantees that the same sequence of operations produces the same state, **bit-for-bit** — across backings (heap vs `SharedArrayBuffer`), across processes on the same architecture, and after a snapshot round-trip. That's the foundation for lockstep multiplayer, replay, deterministic debugging, and save/load.

Determinism is **opt-in** because it costs a little (canonical ordering, an integer-only column rule). A plain `ECS` runs faster and doesn't expose the hash/snapshot surface.

```ts
const ecs = new ECS({ deterministic: true });
const Pos = ecs.registerComponent(["x", "y"], "i32");   // integer columns — see the float ban

// …run identical history on two ECS instances…
ecs.snapshots.stateHash();   // same number on both, at the same tick boundary
```

## Turning it on

```ts
new ECS({ deterministic: true });   // default false
get deterministic(): boolean;
```

The flag gates exactly the canonical-ordering surface: `stateHash`, `snapshot`/`restoreInto`, `snapshotSparse`/`restoreSparse`. Call any of them without it and you get `DETERMINISM_DISABLED`. Memory-safety invariants and the enabled/disabled partition are always on regardless.

## `stateHash`

```ts
stateHash(): number;
```

An FNV-1a-32 digest folded over `(archetype id, live row count, enabled count, live column bytes)` for every archetype in id order, then over sparse stores in canonical entity-index order, then over multi-relation forward target sets in canonical order. It is **backing-agnostic** — a heap `ECS` and a `SharedArrayBuffer` `ECS` with identical history produce the same number — and its cost scales with live entity count / sparse membership, not buffer capacity.

> [!IMPORTANT]
> Compare hashes **only at a tick boundary** (between `update()` calls) or at a phase-boundary settle point (via [`ecs.setTrace`](./tracing.md), whose `phaseBoundary` hook is the safe seam to read `stateHash()` and bisect a divergence to one phase). The digest is **opaque** — never compare it against a hard-coded literal; endianness and the exact fold are implementation details, not a wire contract. It's valid only within one architecture/algorithm.

## Snapshot & restore

```ts
snapshot(): Uint8Array;              // capture the full live ECS
restoreInto(bytes: Uint8Array): void; // mount a snapshot onto this live ECS
const ECS_SNAPSHOT_VERSION: number;
class ECSRestoreError extends Error {}
```

A snapshot captures three sections into one self-contained `Uint8Array`: **dense** column bytes + the entity index, **sparse** components + relations (canonical order), and **host bookkeeping** (the tick, the entity recycle free-list *in live order*, alive count, per-archetype partition counts). Take it at a tick boundary.

> [!IMPORTANT]
> A snapshot does **not** capture resources, events, or change-detection baselines. Re-seed resources after a restore; events are per-frame anyway; `changed()` queries reset their tick baseline.

### Fail-closed restore

`restoreInto` validates the incoming bytes **completely, before touching the live backing** — magic/version, exact frame length, entity-index capacity, the archetype set, each column's `(componentId, fieldId, typeTag)` field identity, and index bounds. Only then does it overwrite. Any mismatch throws (`ECSRestoreError` on the dense side, `SparseRestoreError` on the sparse side) and **leaves the live `ECS` untouched**.

> [!WARNING]
> Restore preconditions — the target `ECS` must:
> - be built with the **same component/archetype registration** as the snapshot (the graph is rebuilt from your registration code, not the bytes) — **prewarm** it (register the same components/templates, run `startup()`) so its archetype set is stable;
> - have the **same entity-index capacity** — size both with the same [`memory`](./memory.md) options;
> - be `{ deterministic: true }`.
>
> Feeding a bare column-store snapshot (not a full-`ECS` `snapshot()`) fails with a clear magic error.

## Record & replay

Because every mutation from a host/UI crosses one apply chokepoint, you can log the applied commands per tick and replay a whole session deterministically. See the [host-write seam](./host-write-seam.md#record--replay) for `HostCommandRecorder` / `replayCommandLog`.

> [!TIP]
> On a deterministic `ECS`, `replayCommandLog(..., { hash: true })` returns the per-tick `stateHash` sequence. Replaying the same log from the same seed **must** reproduce that exact sequence — that equality *is* the fidelity check. With determinism off, replay still reproduces state structurally, but there's no hash to compare.

## What breaks determinism

> [!WARNING]
> **Floats.** On a deterministic `ECS`, registering an `f32`/`f64` column is rejected at registration (`NON_DETERMINISTIC_COLUMN_TYPE`) — IEEE-754 rounds differently across V8/Bun/Zig by a ULP, a silent per-tick divergence. Because the array shorthand defaults to `"f64"`, you **must** pass an integer type: `ecs.registerComponent(["x", "y"], "i32")`. Represent fractional quantities as fixed-point (e.g. Q16.16).

Other divergence sources, all on you to avoid:

- **`Math.random`, wall-clock, network jitter** — any non-lockstep input folds into column bytes and diverges the hash. Seed an RNG deterministically and store its state in a component.
- **Iteration / insertion order** — the canonical ordering the flag enforces (sparse indices, sorted relation sets, free-list reuse order) *is* what makes replay reproduce; don't reintroduce order-dependence.
- **Resources & events** are excluded from the hash — don't rely on them to carry reproducible sim state (see above).

## See also

- [memory](./memory.md) — sizing both instances identically for restore; the shared/heap backings that agree on the hash
- [host-write seam](./host-write-seam.md) — the command log that record/replay is built on
- [components](./components.md) — the integer-column requirement
- [tracing](./tracing.md) — `phaseBoundary` for bisecting a divergence
