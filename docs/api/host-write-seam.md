# Host-write seam

> **Advanced / optional.** A plain `ECS` doesn't need any of this. Reach for it when writes originate **outside** the schedule — a UI, an editor, a dev tool, a network handler, a worker.

The problem: those callers run off-schedule, but writing to the `ECS` mid-frame (or from another thread) would corrupt live iteration. The seam solves it by making every outside write a **typed command** that is buffered off-schedule and applied at one blessed point.

**The model:** a host enqueues typed `HostCommand`s into a `HostCommandQueue` (pure buffering — nothing touches the `ECS`). A single blessed **`exclusive`** apply system drains the queue at the **schedule head** (`PRE_STARTUP` for seed-time, `PRE_UPDATE` each frame) through one dispatch, `applyHostCommand`, which issues the normal deferred `ctx` ops. Every outside write thus lands at the usual phase-tail flush, observers fire, and (if wired) the reactive bridge publishes one batched commit.

```ts
import { installHostCommandSeam, spawnEntry } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);   // BEFORE your systems and startup()
ecs.addSystems(/* your systems */);
ecs.startup();

// From your UI / editor / network handler, any time:
queue.addComponent(entity, Health, { hp: 100 });
queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (id) => console.log("spawned", id));

ecs.update(1 / 60);   // the apply system drains the queue at PRE_UPDATE
```

## `installHostCommandSeam`

```ts
installHostCommandSeam(ecs: ECS, opts?: HostCommandSeamOptions): HostCommandQueue;

interface HostCommandSeamOptions {
  readonly schedules?: readonly SCHEDULE[];   // default [PRE_STARTUP, PRE_UPDATE]
  readonly name?: string;                      // default "host_command_apply"
  readonly ring?: HostCommandDispatcher;       // opt-in SAB cross-thread transport
  readonly recorder?: HostCommandSink;         // opt-in record/replay tap
}
```

> [!WARNING]
> Call it **before** adding your own systems and **before `startup()`**. The schedule has no dedicated "first" slot — insertion order is what places the apply system at the phase head, and the `PRE_STARTUP` drain only fires if the system exists before startup.

## `HostCommandQueue`

Every method **enqueues** — nothing reaches the `ECS` until the apply system drains.

```ts
spawn(components: readonly SpawnEntry[], onSpawned?: (eid: EntityID) => void): void;
despawn(eid): void;
addComponent<S>(eid, def, values: FieldValues<S>): void;
removeComponent(eid, def): void;
setField<S>(eid, def, field, value): void;
disable(eid): void;   enable(eid): void;
push(cmd: HostCommand): void;   // enqueue pre-built command data (codec / replay / editor path)
pending(): number;              // buffered-but-unapplied count
```

> [!WARNING]
> **Don't add-then-set in the same frame.** `setField` is applied **immediately** at the drain, but structural commands (`spawn`/`addComponent`/…) are **deferred** to the phase flush. So `addComponent(e, C)` then `setField(e, C, …)` in one frame fails — the add is still pending when the set runs (dev throws an actionable `COMPONENT_NOT_REGISTERED`). Carry the value in the `addComponent`/`spawnEntry` (which take complete field values), or `setField` next frame.

> [!NOTE]
> `onSpawned` is the **only** way to learn a spawned id — the create is deferred, so the id doesn't exist until the drain. Commands a `onSpawned` callback enqueues run on the *next* drain, keeping one frame's work within one tick.

### `SpawnEntry`

```ts
spawnEntry<S>(def: ComponentDef<S>, values: FieldValues<S>): SpawnEntry;
interface SpawnEntry { readonly def: ComponentDef; readonly values: FieldValues<ComponentSchema>; }
```

> [!WARNING]
> **`spawnEntry` values must be complete** — the deferred add writes exactly the fields you give and does **not** zero-default omitted ones (unlike a [bundle](./components.md) or [template](./entities.md)). An omitted `f64` field reads back `NaN`. Pass every field (`0` for "default"); a tag takes `{}`.

## `HostCommand`

Plain, serializable data — the same vocabulary drives both the in-process queue and the cross-thread ring, and both resolve through `applyHostCommand(ctx, cmd)`.

| `kind` | timing | carries |
| --- | --- | --- |
| `"spawn"` | deferred | `components`, optional `onSpawned` |
| `"despawn"` | deferred | `eid` |
| `"add_component"` | deferred | `eid`, `def`, `values` |
| `"remove_component"` | deferred | `eid`, `def` |
| `"set_field"` | **immediate** | `eid`, `def`, `field`, `value` |
| `"disable"` / `"enable"` | deferred | `eid` |

## Record & replay

Because every mutation crosses `applyHostCommand`, logging the applied commands per tick + each tick's `dt` + a seed is enough to replay a session. See [determinism](./determinism.md) for the guarantee.

```ts
import { HostCommandRecorder, serializeCommandLog, deserializeCommandLog, replayCommandLog } from "@oasys/oecs";

const recorder = new HostCommandRecorder(seed);
const queue = installHostCommandSeam(ecs, { recorder });
// …run the session…
const log = recorder.log();                 // live view — serialize to snapshot it
const json = serializeCommandLog(log);
```

```ts
class HostCommandRecorder implements HostCommandSink {
  constructor(seed?: number);
  readonly seed: number;
  log(): CommandLog;                         // LIVE view, not a copy
}
interface CommandLog { readonly seed: number; readonly startup: readonly HostCommand[]; readonly ticks: readonly RecordedTick[]; }
interface RecordedTick { readonly tick: number; readonly dt: number; readonly commands: readonly HostCommand[]; }

replayCommandLog(ecs: ECS, queue: HostCommandQueue, log: CommandLog, opts?: { hash?: boolean }): ReplayResult;
interface ReplayResult { readonly startupCommands: number; readonly ticks: number; readonly stateHashes: readonly number[]; }
```

To replay: build a **fresh, not-yet-started** `ECS` identically to the recorded run (same components in the same order, same systems, same `seed` from `log.seed`), install the seam, then hand its `queue` to `replayCommandLog`. It pushes the seed-time commands, calls `startup()`, then per tick pushes commands and calls `update(dt)` — even empty ticks, because `dt` drives the sim.

> [!WARNING]
> **The recorder cannot record from `FIXED_UPDATE`** — a fixed-step drain sees the fixed timestep, not the frame `dt`, which diverges on replay. `installHostCommandSeam({ recorder })` with `FIXED_UPDATE` in `schedules` throws `INVALID_RECORDER_SCHEDULE`. Record from variable-update phases only.

> [!NOTE]
> `serializeCommandLog` throws `COMMAND_LOG_TAG_COLLISION` if a command's `values` map owns a field literally named `__component_def` (the reserved in-band def tag) — rename that field. This keeps the JSON round-trip lossless rather than corrupting on parse.

## Cross-thread ring transport (advanced)

For writes coming from a **worker or the wire**, a second transport decodes fixed-size ring slots into the same `applyHostCommand`. You supply the opcodes; oecs ships the mechanism and codecs.

```ts
import { HostCommandDispatcher, ringSetFieldCodec, ringDespawnCodec, ringDisableCodec,
         ringEnableCodec, ringRemoveComponentCodec, HOST_COMMAND_PAYLOAD_BYTES } from "@oasys/oecs";

const dispatcher = new HostCommandDispatcher()
  .onCommand(1, ringSetFieldCodec(Pos, "x"))      // decode → applyHostCommand
  .onCommand(2, ringDespawnCodec())
  .on(10, myRawSpawnUnitApplier);                  // raw consumer op

installHostCommandSeam(ecs, { ring: dispatcher }); // drains the ring at each schedule head
```

Each `ring*Codec` binds its component/field into the codec (they aren't carried in the 15-byte payload). There is deliberately **no `spawn`/`add_component` ring codec** — variable-width field values don't fit a fixed slot, so those two are typed-transport-only. Exactly one dispatcher should drain a given ring.

## See also

- [determinism](./determinism.md) — the replay fidelity guarantee
- [editor](./editor.md) — undo/redo built on this queue
- [reactive](./reactive.md) — the read side (ECS → UI) that pairs with this write side
- [systems](./systems.md) — `exclusive` systems, which the apply system is
