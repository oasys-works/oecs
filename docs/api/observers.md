# Observers

An **observer** runs a callback when a component is added, removed, changed, or when its entity is enabled/disabled. It's the push-based counterpart to polling with a [`changed()`](./change-detection.md) query: register once, get called at the right moment.

```ts
const handle = ecs.observe(Health, {
  access: { reads: [Health], writes: [], spawns: [[Corpse]] },  // declare what the callbacks touch
  onRemove: (entityId, ctx) => ctx.commands.spawn(Corpse({ /* … */ })),
});

handle.dispose();   // unregister when done (idempotent)
```

## `observe`

```ts
observe<S>(def: ComponentDef<S>, config: ObserverConfig): ObserverHandle;
interface ObserverHandle {
  dispose(): void;              // unregister; safe to call more than once
  [Symbol.dispose](): void;     // same, as TC39 explicit-resource-management sugar
}
```

The `Symbol.dispose` member makes the handle `using`-compatible — `using h = ecs.observe(C, { … })` unregisters automatically at scope exit.

The `config` shape decides which callbacks are allowed:

```ts
// Structural — add/remove/enable/disable:
interface StructuralObserverConfig {
  onAdd?: (entityId: EntityID, ctx: SystemContext) => void;
  onRemove?: (entityId: EntityID, ctx: SystemContext) => void;
  onDisable?: (entityId: EntityID, ctx: SystemContext) => void;
  onEnable?: (entityId: EntityID, ctx: SystemContext) => void;
  access?: Partial<SystemAccessDeclaration>;   // + the reads/writes/spawns the callbacks need
  yieldExisting?: boolean;
  name?: string;                               // diagnostic label in frame traces (observe-only)
}

// onSet, archetype-granular (the default) — one call per changed archetype-column:
interface ArchetypeSetObserverConfig extends /* the base above */ {
  onSet: (arch: ArchetypeView, ctx: SystemContext) => void;
  granularity?: "archetype";
}

// onSet, entity-granular — one call per changed entity:
interface EntitySetObserverConfig extends /* the base above */ {
  onSet: (entityId: EntityID, ctx: SystemContext) => void;
  granularity: "entity";
}
```

## When each callback fires

- **`onAdd` / `onRemove`** fire at the **structural-flush boundary** — after the deferred batch commits, so an observer never sees a torn, half-applied state. They loop to a fixed point, so cascades (an `onAdd` that adds another component) settle within the same flush.
- **`onDisable` / `onEnable`** fire at the same boundary, **once per net transition** across a drain (disable → enable → disable in one tick fires a single `onDisable`), for every component the entity carries.
- **`onSet`** fires at the post-update detection point (the tick tail):
  - *archetype-granular* (default) — `(arch, ctx)` per changed archetype-column, reusing the free change tick. You iterate `arch.entityCount` rows yourself.
  - *entity-granular* — `(entityId, ctx)` per changed entity, draining an opt-in per-row dirty list.

```ts
// React to every entity whose HexPos changed, precisely once each:
ecs.observe(HexPos, {
  access: { reads: [HexPos], writes: [] },
  granularity: "entity",
  onSet: (entityId, ctx) => reindexSpatial(entityId, ctx.getField(entityId, HexPos, "q")),
});
```

## Caveats

> [!IMPORTANT]
> **Declare `access`.** Callbacks run inside an access span; state they touch (reads, writes, `spawns`, `despawns`, resources) must be declared on the observer config, or it throws in dev. These declarations also drive the firing order (below), so a wrong declaration can silently reorder an observer relative to others.

> [!WARNING]
> **`onSet` is not a per-write hook** — it's *derived* change detection. Archetype grain reuses the change tick (free, but fires per changed archetype-column, so you get all its rows even if one changed). Entity grain fires exactly once per changed entity, but **registering it turns on per-row dirty tracking** for that component — a write-path cost. Choose by change density.

> [!WARNING]
> **Only deferred, in-schedule ops fire *structural* observers** (`onAdd` / `onRemove` / `onEnable` / `onDisable`). An *immediate* host-side `ecs.addComponent` / `ecs.disable` fires none of them — only the deferred `ctx.commands.add` / `ctx.commands.disable` (which drain at the flush) do. `onSet` is **not** gated by receiver: it is derived change detection (change ticks + the per-entity dirty list, scanned at the post-update detection point), so a host-side `ecs.setField` between frames is seen by `onSet` observers on the next `update()` exactly like `ctx.setField`. **This includes `ecs.despawn`** (immediate since 0.5.0): a host despawn fires no `onRemove` for the entity's components — nor for entities destroyed by a relation `delete`-policy cascade it triggers. Anything observer-driven (including the `@oasys/oecs/reactive-sync` bridges) only sees despawns that go through `ctx.commands.despawn` or the host-command seam. Register observers at build time, **before `startup()`**, so the archetypes they spawn into are prewarmed.

> [!WARNING]
> **Don't emit events from `onSet`** — it runs where events are about to be cleared (throws `OBSERVER_ONSET_EMIT` in dev). See [events](./events.md).

> [!NOTE]
> `yieldExisting: true` replays `onAdd` over the current **enabled** matches at registration — handy to seed a derived structure from entities that already exist (a disabled entity is skipped at seed). `dispose()` is idempotent and safe mid-flush.

> [!TIP]
> `name` labels the observer in the [frame trace](./tracing.md)'s `observer_fired` events — the same role a system's `name` plays. It is observe-only: it never touches `stateHash` or dispatch order. Unnamed observers fall back to `observer(<component debug name>)` when the component was registered with a `name`, else `observer(<cid>)`.

## Firing order (determinism)

When it matters — e.g. for [deterministic](./determinism.md) replay — observers fire in a stable order:

- **Across observers:** access-topological (a writer of `X` before readers of `X`, derived from each observer's declared `access`), tie-broken by component id then registration id. This is "glitch-free" ordering.
- **Within one observer:** ascending `EntityID`.
- **Within one structural round:** remove, then add, then disable, then enable — "leaving" edges before "entering" ones.

Observer state (like the change tick) is excluded from `stateHash` and snapshots but produced in canonical order, so replays reproduce it.

## See also

- [change detection](./change-detection.md) — the polling alternative and the shared tick
- [entities](./entities.md) — enable/disable, which `onDisable`/`onEnable` observe
- [relations](./relations.md) — cleanup policies are a related "react to structural change" mechanism
