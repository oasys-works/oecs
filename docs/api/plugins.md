# Writing a plugin

Write a plugin when a subsystem must cost nothing on a world that does not use it. Relations,
events, snapshots, observers and workers are plugins, and a plugin of your own uses the same seams.
Import `Plugin`, `PluginHost`, `PluginsOf` and `ChangeFeed` from `@oasys/oecs`.

## What a plugin is

A plugin builds a service, wires it into the world, and returns the facade the world gains.

```ts
import type { Plugin, PluginHost } from "@oasys/oecs";

export interface SpatialPlugin {
  readonly spatial: { near(x: number, y: number): number[] };
}

export function spatial(): Plugin<SpatialPlugin> {
  return {
    name: "spatial",
    install(host: PluginHost): SpatialPlugin {
      // build the service from the host, then hand back the facade
      return { spatial: { near: () => [] } };
    }
  };
}
```

`ECS.create` walks the plugin list in order. It calls `install` once for each plugin, then copies
the returned facade onto the world. The returned world type is the world intersected with every
facade. So a member the list never installed is a compile error and not a fault at run time.
`PluginsOf` is the type of the surface a plugin list adds.

Installing is a cold path. It runs once, at construction. No component exists yet at that point. A
plugin that watches a component takes it later, through its own facade.

## The host

`install` receives one `PluginHost`. Every seam the world offers a plugin is a member of it. There
are nine, and **every one is open to any plugin**. Each hook point is named for what it hooks, and
never for the plugin that ships it. The two named slots, `installObservers` and `installWorkers`,
are gone. The observers plugin now uses `onSettle` and `onPrewarm`. The workers plugin now uses
`memory`, `onDispose` and `installRoute`.

| Member | What it is for | The cost |
| --- | --- | --- |
| `store` | the internal store, where the subsystem install seams live | no compatibility promise, it moves between releases |
| `world` | the bare world, for a system, a phase, a field read, a cursor or a resource | a plain reference, taken once |
| `changes` | the store's change feed, typed to what a consumer may touch | see [the change feed](#the-change-feed) |
| `context` | the one system context an observer callback receives | shared with the schedule, so a callback sees the access span a system sees |
| `memory` | where the world's bytes are, for a worker or a WASM module | three fields, read at attach time |
| `onSettle(fn)` | run `fn` at the tail of every `update()`, after every system and flush | one call for each hook, for each frame |
| `onPrewarm(fn)` | contribute the access shapes that `startup()` folds into the archetype closure | read one time, at startup |
| `onDispose(fn)` | run `fn` when the world goes away | one call for each hook, at `ecs.dispose()` |
| `installRoute(planner)` | claim the body of the systems this plugin routes | see [the system dispatch route](#the-system-dispatch-route) |

`host.world` carries no facade of any plugin, including the one installing. Take it to register a
system, register a component, add a phase, read a field, build a cursor or reach a resource.

`host.store` is the internal store. It carries no compatibility promise, and a release may change
it. Reach for it when the seam you need has no world-level form.

`onPrewarm(fn)` returns `SystemDescriptor` values, and `startup()` folds their declared access into
the archetype closure. A callback that spawns or transitions then gets its target archetype planted
in advance, rather than first-touched in the middle of a tick. The observers plugin uses it for the
observers a world registered before startup.

`onDispose(fn)` is where a plugin ends a thread, a timer or a socket. Hooks run in install order.

`host.memory` names where the bytes are, for a plugin that hands them to a reader outside the
world.

| Field | What it holds |
| --- | --- |
| `backing` | the `WebAssembly.Memory`, the `SharedArrayBuffer`, or `null` on any other backing |
| `backingSource` | what `memory.backing` resolved to, so a refusal can name it |
| `storeBase` | the byte offset of the store header inside the backing |

The memory travels, and not its current buffer. The two grow differently, and a reader survives
both.

`storeOnlyHost(store)`, on `@oasys/oecs/internal`, builds a host around a bare store. `store` and
`changes` are both the store, so the change feed works. Every world-level member throws
`PLUGIN_NOT_INSTALLED`, because a bare store has no world, no schedule tail and no memory plan.

## The system dispatch route

A route claims the body of a system and runs its own work in place of that body. The workers plugin
is one, and a plugin of yours uses the same seam. The world holds **one** route, so a second
`installRoute` throws `PLUGIN_ALREADY_INSTALLED`.

```ts
import type { SystemConfig, SystemContext } from "@oasys/oecs";

interface SystemRoutePlanner {
  // Build what one routed dispatch reads. `undefined` leaves the system on its `fn`.
  plan(config: SystemConfig): object | undefined;
}

interface RouteControl {
  route(dispatch: RouteDispatch | null): void;   // null puts every claimed system back
}

interface RouteDispatch {
  // True means this route ran the body. False falls back to the system's own `fn`.
  run(plan: object, ctx: SystemContext, deltaTime: number, runTick: number): boolean;
}
```

The world asks the planner about **every** system it registers. A planner that has nothing to say
about one answers `undefined`. The world freezes what the planner built onto the descriptor and
never looks inside it, so the shape of the plan belongs to the plugin. The plugin validates its own
config there, which is why a world without the plugin validates none.

`installRoute` gives back a `RouteControl`. Call `route(dispatch)` to turn the route on, and
`route(null)` to turn it off. Both are cold calls, and neither belongs in a frame.

> [!NOTE]
> `SystemRoutePlanner`, `RouteControl`, `RouteDispatch` and `PluginMemory` are structural, and the
> package root exports all four as types. A plugin satisfies the planner by declaring `plan`, and
> it holds the control and the memory by inference. Import a name when you want the compiler to
> check the shape.

The route stays one typed slot and not a keyed registry. The schedule hoists it once for each phase
and reads one opaque plan for each dispatch. A keyed read on that path is far slower on a schedule
of short bodies, and `bench/` holds the comparison. The registration is keyed and cold, so a third
party reaches the same slot the first party does.

```ts
import { ECS, type Plugin, type PluginHost, type SystemConfig } from "@oasys/oecs";

interface DetourPlugin {
  readonly detour: { ran: number };
}

function detour(): Plugin<DetourPlugin> {
  return {
    name: "detour",
    install(host: PluginHost): DetourPlugin {
      const service = { ran: 0 };
      // The planner. It claims every system whose name starts with `detour.`.
      const control = host.installRoute({
        plan: (config: SystemConfig) =>
          config.name?.startsWith("detour.") === true ? { label: config.name } : undefined
      });
      // The dispatch. True means this route ran the body.
      control.route({
        run: () => {
          service.ran++;
          return true;
        }
      });
      host.onDispose(() => control.route(null));
      return { detour: service };
    }
  };
}

const world = ECS.create({ plugins: [detour()] });
world.detour.ran; // how many claimed dispatches the route took
```

`src/core/ecs/__tests__/integration/third_party_plugin.test.ts` writes a route in its own body,
claims one system, and holds the world to the second-route refusal.

## A phase of your own

`host.world.addPhase(name, { loop, before, after })` gives the plugin one slot in the schedule. The
plugin then owns its order, instead of contending for insertion order inside a phase the
application also writes to. Return the handle on the facade, so an application can order its own
systems against the slot. [schedule](./schedule.md) documents `addPhase`, the three loops, the order
between phases and the two faults.

## The rules

Name the plugin after the subpath you publish and the factory you export. The missing-plugin
fault names both. It tells the caller to write `ECS.create({ plugins: [spatial()] })`, imported from
`@oasys/oecs/spatial`. A name that matches neither sends the reader to an import that does not
exist.

`requires` names the plugins this one reads through. `ECS.create` walks the plugin list in
order, so a dependency comes earlier in the list. A dependency behind it, or absent, throws
`PLUGIN_NOT_INSTALLED` at construction, and the message names the plugin that asked.

One install per name. A list that holds one name twice throws `PLUGIN_ALREADY_INSTALLED`.

A facade key must not name a member the world already carries. `Object.assign` overwrites it without
a word, and the world loses a method it needs. A development build checks each key and throws
`PLUGIN_SURFACE_COLLISION`. Rename the member the plugin adds. The five reserved slots,
`relations`, `events`, `observe`, `snapshots` and `workers`, are the exception, because a plugin is
meant to fill them.

A bare world declares those five slots. A JavaScript caller who reaches for one gets a fault that
names the import. A bare world declares no slot for a plugin of your own. So TypeScript is the
only guard there, and a JavaScript caller reads `undefined` instead of a fault. Document the import,
and expect the type to carry the rule.

See [errors](./errors.md) for the three codes.

## The change feed

The store records what changed and hands it to more than one consumer. A consumer asks for a grain,
then drains what the store recorded. `host.changes` is that feed, and `ChangeFeed` names the type.

### What the store records

- **Structural batches**, one for each round of an observed flush. Adds, removes, disables and
  enables, as flat parallel arrays.
- **The row grain of a dense component**, a row tick plane plus a dirty list. A by-id write stamps
  the row and lists the entity. A chunk loop that takes the tick column stamps rows and lists
  nothing. The next drain scans the plane instead.
- **The archetype grain**, the per-archetype change tick the store already keeps.
- **The row grain of a sparse component**, one tick for each member.

The row grain costs the write path. Asking for it turns on the tick plane and the dirty list of that
component. Every by-id write to it then pays. The sparse row grain costs the sparse write path the
same way. The archetype grain costs no write path at all, because it reuses a tick the store already
stamps. Its read costs one compare for each archetype that holds the component.

### How a consumer asks

```ts
host.changes.configureObservation("spatial", cid, {
  add: true,
  remove: true,
  disable: false,
  enable: false,
  set: true
});
host.changes.configureSparseObservation("spatial", sid, true);
```

The first argument is the consumer name. Pass the plugin name. The flag record is an
`ObservationFlags`, one boolean for each hook. The store keeps one record for each consumer, then
merges every record by OR. So one consumer never takes a flag away from another. An all-false ask is
the same as never asking, and it is how a consumer leaves the feed.

### How a consumer drains

`drainSet(cid, run)` returns the rows recorded for a dense component since the last drain.
`drainSparseSet(sid, run)` returns the members recorded for a sparse component, in member order.
`run` is the change tick of this pass, and it memoizes the drain. Two calls at one run return the
same object. So a second consumer never takes the records away from the first.

`DrainResult` holds two arrays, and they carry different guarantees.

- `scanned` rows are alive, members and enabled by construction. Act on each one with no check.
- `listed` entities need a check. One may repeat, and one may have died, left the component or been
  disabled since its record.

Both arrays belong to the store, and the next drain reuses them. Copy whatever you keep past the
call. A consumer may also sort, dedupe or truncate them in place, and the observer registry does
exactly that. A later consumer of one run sees the arrays as the earlier consumer left them. Plan
around it.

Three more members read the world without draining anything.

- `forEachChangedArchetype(cid, baseline, cb)` visits every non-empty archetype whose column changed
  after `baseline`, in canonical order. This is the archetype grain.
- `collectEnabledWith(cid)` returns every live enabled entity that holds the component. It allocates
  and it walks every row, so seed with it and do not poll it.
- `isAlive`, `isDisabled` and `hasComponent` are the three checks a `listed` entity needs.

### The structural hooks

`addStructuralHook(fn)` takes one round's structural events. `fn` receives a
`StructuralObserverEvents`, the adds, removes, disables and enables of that round. Every hook runs on
each round of the observed flush, in install order. The batch is store-owned scratch, and the next
round overwrites it. Read it during the call, and copy whatever you keep.

### The settle point

`onSettle(fn)` runs `fn` at the tail of every `update()`, after every system and every flush of the
frame. Hooks run in install order. The `run` argument is the change tick of the detection point, and
it sits above every stamp the frame made. So a drain at that run takes the whole frame.

`src/core/ecs/__tests__/unit/change_feed.test.ts` locks the merge, the memo and both hook orders.

## The observer registry is one consumer

`ecs.observe` is the observers plugin reading the same feed. The registry asks for the flags its
live observers need, keyed by the name `observers`. It drains at settle like any other consumer.

It adds four things on top of the feed.

- **Access-topological order across observers.** A writer of a component runs before a reader of it,
  which makes a cascade glitch-free.
- **Canonical entity order inside one observer**, through a radix pass on the entity index.
- **An access span for each callback**, built from the observer's declared `access`. The access
  checker holds a callback the way it holds a system.
- **`yieldExisting`**, which replays `onAdd` over the current enabled matches at registration.

Build on `ecs.observe` when you want a per-entity callback and that order. Build on the feed when you
want the whole batch at once. Build on the feed too when you keep your own index. The per-callback
dispatch is then a cost you do not need. See [observers](./observers.md).

## Two tiers of authoring

**On the public world API alone.** Take `host.world` and use it the way an application does. Register
systems, register components, hold resources, and call `ecs.observe` when the plugin list installs
the observers plugin ahead of you. Name `observers` in `requires` for that. This tier survives a
release, because every seam it touches is public surface.

**On the change feed.** Take `host.changes` when you need what changed and not a callback for each
change. This tier is public surface too, and `ChangeFeed` names it. `host.store` is the tier below
both, and it has no compatibility promise.

The solid plugin, in `src/plugins/solid/solid.ts`, is the worked consumer of the feed. It
drains `changes`, reads each row through `world.cursorRead`, publishes on `onSettle`, and takes its
structural events through `addStructuralHook`.

## A worked example

This plugin counts what changed for the components a caller watches, once for each frame.

```ts
import type {
  Plugin,
  PluginHost,
  ComponentHandle,
  EntityID,
  ObservationFlags
} from "@oasys/oecs";

const ROW_GRAIN: ObservationFlags = {
  add: false,
  remove: false,
  disable: false,
  enable: false,
  set: true
};

export interface ChangeCounterPlugin {
  readonly changeCounter: {
    watch(def: ComponentHandle): void;
    lastFrame(): number;
  };
}

export function changeCounter(): Plugin<ChangeCounterPlugin> {
  return {
    name: "change-counter",
    install(host: PluginHost): ChangeCounterPlugin {
      const watched: ComponentHandle[] = [];
      let count = 0;
      host.onSettle((run: number): void => {
        count = 0;
        for (let w = 0; w < watched.length; w++) {
          const def = watched[w];
          const drained = host.changes.drainSet(def.id as number, run);
          // A scanned row is alive, a member and enabled by construction.
          count += drained.scanned.length;
          const listed = drained.listed;
          for (let i = 0; i < listed.length; i++) {
            const eid: EntityID = listed[i];
            if (!host.changes.isAlive(eid)) continue;
            if (host.changes.isDisabled(eid)) continue;
            if (host.changes.hasComponent(eid, def)) count++;
          }
        }
      });
      return {
        changeCounter: {
          watch(def: ComponentHandle): void {
            // The row grain. Every by-id write to this component now pays for it.
            host.changes.configureObservation("change-counter", def.id as number, ROW_GRAIN);
            watched.push(def);
          },
          lastFrame: () => count
        }
      };
    }
  };
}
```

The install takes no component, because no component exists at construction. `watch` makes the ask
later, and the settle hook installed at construction drains every watched component.

`listed` may repeat an entity, so this counts records and not distinct rows. Sort and dedupe the
array when you need distinct rows.

## A plugin from outside the package, end to end

Nothing below imports a path inside `@oasys/oecs`. It is the whole shape: a factory, a
`requires`, a component the plugin registers for itself, a change-feed ask, a settle hook, and one
facade key. `src/core/ecs/__tests__/integration/third_party_plugin.test.ts` runs this shape and
holds `ECS.create` to each of its refusals.

```ts
import { ECS } from "@oasys/oecs";
import type { ChangeFeed, ComponentDef, EntityID, Plugin, PluginHost } from "@oasys/oecs";
import { relations } from "@oasys/oecs/relations";

/** The surface the world gains. One key, and it names the plugin. */
export interface AuditPlugin {
  readonly audit: Audit;
}

/** Records which rows of its own component changed, once for each frame. */
export class Audit {
  public readonly seen: EntityID[] = [];

  constructor(
    private readonly _changes: ChangeFeed,
    /** The component this plugin registered for itself. */
    public readonly def: ComponentDef<{ note: "i32" }>
  ) {}

  public drain(run: number): void {
    const result = this._changes.drainSet(this.def.id, run);
    for (const id of result.scanned) this.seen.push(id);
    for (const id of result.listed) this.seen.push(id);
  }
}

export function audit(): Plugin<AuditPlugin> {
  return {
    name: "audit",
    // The list is walked in order, so relations comes first or this throws.
    requires: ["relations"],
    install(host: PluginHost): AuditPlugin {
      // The bare world. Register components and systems through it.
      const def = host.world.registerComponent({ note: "i32" }, { name: "audit.Note" });
      const service = new Audit(host.changes, def);
      // The row grain, keyed by this plugin's name. The store merges every
      // consumer's ask, so this never takes a flag from another consumer.
      host.changes.configureObservation("audit", def.id, {
        add: false,
        remove: false,
        disable: false,
        enable: false,
        set: true
      });
      // The tail of every update(), after every system and flush of the frame.
      host.onSettle((run) => service.drain(run));
      return { audit: service };
    }
  };
}

const world = ECS.create({ plugins: [relations(), audit()] });
const e = world.spawn();
world.addComponent(e, world.audit.def, { note: 1 });
world.flush();
world.startup();
world.update(1 / 60);
world.audit.seen; // the rows the frame changed
```

`world.audit` is typed, because `ECS.create` intersects the world with the facades its plugins
contribute. Drop `audit()` from the list and the last line is a compile error.

Three mistakes throw at construction, and each message names the plugin. Two `audit()` in one list
throw `PLUGIN_ALREADY_INSTALLED`. `audit()` before `relations()` throws `PLUGIN_NOT_INSTALLED`. A
facade key that names a member the world already carries, `spawn` for instance, throws
`PLUGIN_SURFACE_COLLISION` in a development build.

## What this page does not cover

- **No per-phase hook.** The lifecycle hooks are settle, prewarm, dispose and the structural
  rounds. To run at a point of your own inside a frame, add a phase with `host.world.addPhase` and
  register a system into it.
- **No install-time startup hook.** Register a system in a startup phase through `host.world`
  instead.
- **No snapshot participation.** `capture` and `restore` carry the store's own state. A plugin
  that holds state outside the store serializes it itself.
- **No uninstall.** A plugin lives as long as the world. A consumer leaves the change feed with
  an all-false ask, and that is the only way back.
