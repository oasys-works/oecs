# Observers

An **observer** runs a callback when a component is added, removed, or changed, or when its entity
is enabled or disabled. It is the push equivalent of a [`changed()`](./change-detection.md) query,
which you must poll. You register the observer one time, and the ECS calls you at the correct
moment.

```ts
const handle = ecs.observe(Health, {
  access: { reads: [Health], writes: [], spawns: [[Corpse]] },  // declare what the callbacks touch
  onRemove: (entityId, ctx) => ctx.commands.spawn(Corpse({ /* … */ })),
});

handle.dispose();   // remove the registration when you are finished (you can call it again safely)
```

## `observe`

```ts
observe<S>(def: ComponentDef<S>, config: ObserverConfig): ObserverHandle;
interface ObserverHandle {
  dispose(): void;              // remove the registration; safe to call more than one time
  [Symbol.dispose](): void;     // the same, in the TC39 explicit-resource-management form
}
```

The `Symbol.dispose` member makes the handle compatible with `using`. So `using h = ecs.observe(C, { … })` removes the registration automatically at the end of the scope.

The shape of `config` decides which callbacks are permitted:

```ts
// Structural — add/remove/enable/disable:
interface StructuralObserverConfig {
  onAdd?: (entityId: EntityID, ctx: SystemContext) => void;
  onRemove?: (entityId: EntityID, ctx: SystemContext) => void;
  onDisable?: (entityId: EntityID, ctx: SystemContext) => void;
  onEnable?: (entityId: EntityID, ctx: SystemContext) => void;
  access?: Partial<SystemAccessDeclaration>;   // and the reads/writes/spawns that the callbacks need
  yieldExisting?: boolean;
  name?: string;                               // a label in frame traces (for observation only)
}

// onSet, archetype granularity (the default) — one call for each archetype column that changed:
interface ArchetypeSetObserverConfig extends /* the base above */ {
  onSet: (arch: ArchetypeView, ctx: SystemContext) => void;
  granularity?: "archetype";
}

// onSet, entity granularity — one call for each entity that changed:
interface EntitySetObserverConfig extends /* the base above */ {
  onSet: (entityId: EntityID, ctx: SystemContext) => void;
  granularity: "entity";
}
```

## When each callback runs

- **`onAdd` and `onRemove`** run at the **structural flush boundary**, after the deferred batch is
  committed. So an observer never sees a state that is only partially applied. They repeat until
  they reach a fixed point, so a cascade settles in the same flush. A cascade is an `onAdd` that
  adds a second component.
- **`onDisable` and `onEnable`** run at the same boundary, **one time for each net transition**
  across a drain. A disable, then an enable, then a disable in one tick runs one `onDisable`. They
  run for each component that the entity carries.
- **`onSet`** runs at the detection point after the update, which is the end of the tick:
  - *Archetype granularity* (the default) gives `(arch, ctx)` for each archetype column that
    changed. It uses the change tick, which costs nothing more. You iterate the `arch.entityCount`
    rows yourself.
  - *Entity granularity* gives `(entityId, ctx)` for each entity that changed. It reads an optional
    dirty list that has one entry for each row.

```ts
// React to each entity whose HexPos changed, exactly one time for each entity:
ecs.observe(HexPos, {
  access: { reads: [HexPos], writes: [] },
  granularity: "entity",
  onSet: (entityId, ctx) => reindexSpatial(entityId, ctx.getField(entityId, HexPos, "q")),
});
```

## Points to note

> [!IMPORTANT]
> **Declare `access`.** The callbacks run inside an access span. You must declare the state that
> they touch (reads, writes, `spawns`, `despawns`, and resources) on the observer config, or the
> observer throws in development. These declarations also set the order in which the observers run
> (see below). So an incorrect declaration can change that order with no signal.

> [!WARNING]
> **`onSet` is not a hook on each write.** It is *derived* change detection. Archetype granularity
> uses the change tick, which costs nothing more, but it runs one time for each archetype column
> that changed. So you receive each row of that archetype, even when only one row changed. Entity
> granularity runs exactly one time for each entity that changed, but **registration of it turns on
> a dirty list for each row** of that component, which has a cost on the write path. Select the
> granularity by the density of the changes.

> [!WARNING]
> **Only deferred operations in the schedule run a *structural* observer** (`onAdd`, `onRemove`,
> `onEnable`, and `onDisable`). An *immediate* call on the host, such as `ecs.addComponent` or
> `ecs.disable`, runs none of them. Only the deferred `ctx.commands.add` and `ctx.commands.disable`
> run them, because those drain at the flush.
>
> `onSet` is **not** controlled by the receiver. It is derived change detection: the change ticks,
> and the dirty list for each entity, which the engine reads at the detection point after the
> update. So an `ecs.setField` call on the host between two frames reaches the `onSet` observers
> at the next `update()`, exactly as `ctx.setField` does.
>
> **This includes `ecs.despawn`**, which is immediate since 0.5.0. A despawn on the host runs no
> `onRemove` for the components of the entity. It also runs none for the entities that a relation
> cascade with the `delete` policy destroys as a result. Anything that an observer drives, which
> includes the `@oasys/oecs/reactive-sync` bridges, sees only a despawn that goes through
> `ctx.commands.despawn` or through the host command path.
>
> Register the observers at build time, **before `startup()`**, so that the engine prepares the
> archetypes that they create entities in.

> [!WARNING]
> **Do not emit an event from `onSet`.** It runs where the engine is about to clear the events, and
> it throws `OBSERVER_ONSET_EMIT` in development. See [events](./events.md).

> [!NOTE]
> `yieldExisting: true` runs `onAdd` again over the current **enabled** matches at registration.
> This is useful to give initial values to a derived structure from the entities that already
> exist. A disabled entity is not part of that first pass. `dispose()` is safe to call more than
> one time, and it is safe during a flush.

> [!TIP]
> `name` labels the observer in the `observer_fired` events of the
> [frame trace](./tracing.md). This is the same role that the `name` of a system has. It is for
> observation only: it never changes `stateHash` or the dispatch order. An observer with no name
> uses `observer(<component debug name>)` when you registered the component with a `name`, and
> `observer(<cid>)` in each other condition.

## The order in which observers run (determinism)

When the order is important, for example for [deterministic](./determinism.md) replay, the
observers run in a stable order:

- **Across observers:** the order is topological on the access. A writer of `X` runs before a
  reader of `X`, and the engine derives this from the declared `access` of each observer. A tie
  breaks first on the component id, and then on the registration id. This is a "glitch-free" order.
- **Inside one observer:** the order is ascending `EntityID`.
- **Inside one structural round:** the order is remove, then add, then disable, then enable. The
  edges that leave come before the edges that enter.

`stateHash` and snapshots do not include observer state, such as the change tick. But the engine
produces that state in a canonical order, so a replay reproduces it.

## See also

- [change detection](./change-detection.md) — the polling alternative and the tick that both use
- [entities](./entities.md) — enable and disable, which `onDisable` and `onEnable` observe
- [relations](./relations.md) — the cleanup policies, which are a related mechanism that reacts to
  a structural change
