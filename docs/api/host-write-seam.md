# The host write path

> **Advanced and optional.** A plain `ECS` needs none of this. Use it when a write starts
> **outside** the schedule: in a UI, an editor, a development tool, a network handler, or a worker.

The problem: those callers run outside the schedule, but a write to the `ECS` during a frame, or
from a second thread, would corrupt the live iteration. The host write path solves it. It makes each
write from outside a **typed command**. It holds that command outside the schedule, and it applies
it at one approved point. The API calls this path a *seam*, as in `installHostCommandSeam`.

**The model:** A host puts typed `HostCommand` values into a `HostCommandQueue`. That is pure
buffering, and nothing touches the `ECS`. One approved **`exclusive`** apply system drains the
queue at the **head of a phase**: `PRE_STARTUP` for the initial values, and `PRE_UPDATE` in each
frame. It drains through one dispatch function, `applyHostCommand`, which issues the usual deferred
structural operations on `ctx`. The one exception is `setField`, which applies immediately during
the drain and sets the change tick. The structural writes then land at the usual flush at the end of
the phase, the observers run, and, if you connected it, the reactive bridge publishes one batched
commit.

```ts
import { SCHEDULE, installHostCommandSeam, spawnEntry } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);   // BEFORE your systems and startup()
ecs.addSystems(SCHEDULE.UPDATE, move);       // schedule your systems after you install the seam
ecs.startup();

// From your UI, editor, or network handler, at any time:
queue.add(entity, Health, { hp: 100 });
queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (id) => console.log("spawned", id));

ecs.update(1 / 60);   // the apply system drains the queue at PRE_UPDATE
```

## `installHostCommandSeam`

```ts
installHostCommandSeam(ecs: ECS, opts?: HostCommandSeamOptions): HostCommandQueue;

interface HostCommandSeamOptions {
  readonly schedules?: readonly SCHEDULE[];   // default [PRE_STARTUP, PRE_UPDATE]
  readonly name?: string;                      // default "host_command_apply"
  readonly ring?: HostCommandDispatcher;       // the optional SAB transport between threads
  readonly recorder?: HostCommandSink;         // the optional connection for record and replay
}
```

> [!WARNING]
> Call it **before** you add your own systems, and **before `startup()`**. The schedule has no
> reserved "first" position. Insertion order is what puts the apply system at the head of the
> phase. Also, the `PRE_STARTUP` drain runs only when the system exists before startup.

The equivalent function to remove it:

```ts
uninstallHostCommandSeam(ecs: ECS, queue: HostCommandQueue): boolean;
```

It removes the apply systems of the seam from the schedule, and it calls `clear` on each command
that is still in the buffer. The queue continues to operate as a buffer, but nothing drains it
until you install a new seam. It gives `false`, and does nothing, when
`installHostCommandSeam` on this world did not produce `queue`.

## `HostCommandQueue`

Each method **adds a command to the queue**. Nothing reaches the `ECS` until the apply system
drains.

```ts
spawn(components: readonly SpawnEntry[], onSpawned?: (entityId: EntityID) => void): this;
despawn(entityId): this;
add<S>(entityId, def, values: CompleteFieldValues<S>): this;   // a bare verb, in the grammar of a namespaced handle (compare ctx.commands.add)
remove(entityId, def): this;
setField<S>(entityId, def, field, value): this;
disable(entityId): this;   enable(entityId): this;
push(cmd: HostCommand): this;   // add command data that you built (the codec, replay, or editor path)
readonly pending: number;       // the number of commands in the buffer that are not applied
clear(): number;                // remove each buffered command WITHOUT applying it; gives how many
```

`clear` is for the removal of the edits in the queue, for example when a scene unloads. It does not
touch a command that already drained into the world.

> [!WARNING]
> **Do not add a component and then set a field on it in the same frame.** `setField` applies
> **immediately** at the drain, but a structural command (`spawn`, `add`, and the others) is
> **deferred** to the flush at the end of the phase. So `add(e, C)` and then
> `setField(e, C, …)` in one frame fails, because the add is still in the queue when the set runs.
> In development this throws a `COMPONENT_NOT_REGISTERED` error that tells you what to do. Carry
> the value in the `add` or in the `spawnEntry`, which take all the field values. As an
> alternative, call `setField` in the next frame.

> [!NOTE]
> `onSpawned` is the **only** way to learn the id of a new entity. From the point of view of the
> host, the create is deferred, so the id does not exist until the drain. The callback runs after
> the engine creates the id, and after it puts the component adds in the queue, but before those
> adds flush. A command that the callback adds to the queue runs at the *next* drain.

### `SpawnEntry`

```ts
spawnEntry<S>(def: ComponentDef<S>, values: CompleteFieldValues<S>): SpawnEntry;
interface SpawnEntry { readonly def: ComponentDef; readonly values: FieldValues<ComponentSchema>; }
```

> [!WARNING]
> **`spawnEntry` has a type that demands all the values.** Give each field, and use `0` for "the
> default". A tag takes `{}`. The shared write path for fields writes `0` in each absent field, if
> command data with no type reaches it. But the public TypeScript surface treats the values of a
> host command as complete (`CompleteFieldValues<S>`).

#### Why `spawnEntry`, and not a bundle?

In other places, "a definition and its values" is a
[bundle](./components.md#the-handle-is-callable--bundles), such as `Pos({ x: 1 })`. A bundle takes
**a subset of the values**, and the engine writes `0` in each absent field at the attach. The host
write path does not accept a bundle, by design. A `HostCommand` is plain data that you can
serialize. It can cross a thread or a wire, you can log it for replay, or you can put it on a stack
for undo. It is a record that a reader sees far from the place where you wrote it. Each attach path
writes `0` in an absent field (the `?? 0` in `writeFields`), so a partial entry would
still *operate*. What it loses is clarity: in the command as a record, "absent because I wanted
zero" and "absent because I forgot the field" then look the same. `spawnEntry` keeps the record
explicit at the type level, because it demands each field at the point where you still know what
the values must be. In-process code that wants the convenience of a bundle does not need the host
write path: use `ecs.spawnBundle(...)` or `ctx.commands.spawn(...)` directly.

## `HostCommand`

This is plain data that you can serialize. The same vocabulary drives the in-process queue and the
ring between threads, and both resolve through `applyHostCommand(ctx, cmd)`.

| `kind` | timing | carries |
| --- | --- | --- |
| `"spawn"` | deferred | `components`, and an optional `onSpawned` |
| `"despawn"` | deferred | `eid` |
| `"add_component"` | deferred | `eid`, `def`, `values` |
| `"remove_component"` | deferred | `eid`, `def` |
| `"set_field"` | **immediate** | `eid`, `def`, `field`, `value` |
| `"disable"` / `"enable"` | deferred | `eid` |

<a id="record--replay"></a>

## Record and replay

Each mutation crosses `applyHostCommand`. So a log of the applied commands for each tick, plus the
`dt` of each tick and a seed, is enough to replay a session. See [determinism](./determinism.md)
for the guarantee.

```ts
import { HostCommandRecorder, serializeCommandLog, deserializeCommandLog, replayCommandLog } from "@oasys/oecs";

const recorder = new HostCommandRecorder(seed);
const queue = installHostCommandSeam(ecs, { recorder });
// …run the session…
const log = recorder.log();                 // a live view — serialize it to make a copy
const json = serializeCommandLog(log);
```

```ts
class HostCommandRecorder implements HostCommandSink {
  constructor(seed?: number);
  readonly seed: number;
  log(): CommandLog;                         // a LIVE view, and not a copy
  snapshotLog(): CommandLog;                 // a stable deep copy — the safe default
}
interface CommandLog { readonly seed: number; readonly startup: readonly HostCommand[]; readonly ticks: readonly RecordedTick[]; }
interface RecordedTick { readonly tick: number; readonly dt: number; readonly commands: readonly HostCommand[]; }

replayCommandLog(ecs: ECS, queue: HostCommandQueue, log: CommandLog, opts?: { hash?: boolean }): ReplayResult;
interface ReplayResult { readonly startupCommands: number; readonly ticks: number; readonly stateHashes: readonly number[]; }
```

`deserializeCommandLog(json: string): CommandLog` parses the output of `serializeCommandLog` back
into a `CommandLog`. The entity ids travel as plain numbers. The engine makes each tagged component
definition into a callable handle again, from its serialized id. This is one more reason that the
world for the replay must register its components in the same order.

To replay a session: build a **new `ECS` that you did not start**, in the same way as the recorded
run. Give it the same components in the same order, the same systems, and the same `seed` from
`log.seed`. Install the seam, then give its `queue` to `replayCommandLog`. That function pushes the
commands from the initial phase, calls `startup()`, and then, for each tick, pushes the commands and
calls `update(dt)`. It does this also for an empty tick, because the `dt` drives the simulation.

> [!WARNING]
> **The recorder cannot record from `FIXED_UPDATE`.** A drain in a fixed step sees the fixed
> timestep, and not the frame `dt`, which then makes the replay different. If you call
> `installHostCommandSeam({ recorder })` with `FIXED_UPDATE` in `schedules`, it throws
> `INVALID_RECORDER_SCHEDULE`. Record from the variable update phases only.

> [!NOTE]
> `serializeCommandLog` throws `COMMAND_LOG_TAG_COLLISION` when the `values` map of a command has a
> field with the exact name `__component_def`, which is the reserved in-band tag for a definition.
> Give that field a different name. This keeps the JSON round trip complete, and it prevents
> corruption at the parse.

## The ring transport between threads (advanced)

For a write that comes from a **worker or from the wire**, a second transport decodes ring slots of
a fixed size into the same `applyHostCommand`. You supply the operation codes. oecs supplies the
mechanism and the codecs.

```ts
// The ring transport is a wire and ABI surface — @oasys/oecs/internal (no semver guarantees).
import { HostCommandDispatcher, ringSetFieldCodec, ringDespawnCodec, ringDisableCodec,
         ringEnableCodec, ringRemoveComponentCodec, HOST_COMMAND_PAYLOAD_BYTES } from "@oasys/oecs/internal";

const dispatcher = new HostCommandDispatcher()
  .onCommand(1, ringSetFieldCodec(Pos, "x"))      // decode → applyHostCommand
  .onCommand(2, ringDespawnCodec())
  .on(10, myRawSpawnUnitApplier);                  // a raw operation of your own

installHostCommandSeam(ecs, { ring: dispatcher }); // drains the ring at the head of each phase
```

Each `ring*Codec` holds its component and field inside the codec, because the payload of 15 bytes
does not carry them. There is deliberately **no ring codec for `spawn` or `add_component`**,
because field values of a variable width do not fit a slot of a fixed size. So those two commands
use the typed transport only. Exactly one dispatcher must drain each ring.

## See also

- [determinism](./determinism.md) — the guarantee of fidelity for a replay
- [editor](./editor.md) — undo and redo, which are built on this queue
- [reactive](./reactive.md) — the read side (ECS to UI) that pairs with this write side
- [systems](./systems.md) — `exclusive` systems, which the apply system is
