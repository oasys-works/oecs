# Resources

> [!NOTE]
> **0.5.0 — grouped surface.** Resource registration and access live on the **`ecs.resources`** facade — `ecs.resources.register(Time, {...})`, `ecs.resources.get(Time)`, `ecs.resources.set(Time, v)`, `ecs.resources.remove(Time)`, `ecs.resources.has(Time)`. The pre-0.5 flat `ecs.*` forms were **removed** in 0.5.0.

A **resource** is a typed global singleton — one value per `ECS`, keyed by a symbol. Use it for state that isn't per-entity: the input snapshot, the camera, the game clock, config flags, an RNG seed.

```ts
import { resourceKey } from "@oasys/oecs";

// 1. Mint a key at module scope — the type travels with the key.
const Time = resourceKey<{ delta: number; elapsed: number }>("Time");

// 2. Register it with an initial value.
ecs.resources.register(Time, { delta: 0, elapsed: 0 });

// 3. Read / write anywhere.
const t = ecs.resources.get(Time);   // t.delta and t.elapsed are typed
ecs.resources.set(Time, { delta: 1 / 60, elapsed: t.elapsed + 1 / 60 });
```

## Keys

```ts
resourceKey<T>(name: string): ResourceKey<T>;
type ResourceKey<T> = symbol & { readonly __phantom: T };
```

`resourceKey` mints a unique symbol carrying the value type `T`. The `name` is for diagnostics only — uniqueness comes from the symbol's identity, not the string, so two `resourceKey("Time")` calls are two different keys. Mint each key **once, at module scope**, and import it wherever you need the resource.

## Methods

`registerResource` is an `ECS` method only (setup-time). The four accessors exist on **both** `ecs` and `ctx` (inside a system):

```ts
// ECS only:
registerResource<T>(key: ResourceKey<T>, value: T): void;

// On both `ecs` and `ctx`:
resource<T>(key: ResourceKey<T>): T;              // the getter (there is no "getResource")
setResource<T>(key: ResourceKey<T>, value: T): void;
removeResource<T>(key: ResourceKey<T>): void;
hasResource<T>(key: ResourceKey<T>): boolean;
```

Inside a system, resource access is **declared and checked**: list the key in `resourceReads` to read it, `resourceWrites` to write it.

```ts
ecs.registerSystem({
  reads: [], writes: [],
  resourceReads: [Time], resourceWrites: [Score],
  fn: (ctx) => {
    const t = ctx.resource(Time);
    ctx.setResource(Score, ctx.resource(Score) + t.delta);
  },
});
```

## Caveats

> [!WARNING]
> **Register-once.** Registering a key that's already live throws `RESOURCE_ALREADY_REGISTERED`. `removeResource` frees the key so it can be registered again — resources model a present/absent axis, not just a value.

> [!NOTE]
> `removeResource` is access-checked as a **write** (declare it in `resourceWrites`) and **fails closed on a missing key** — removing a key that isn't registered throws rather than silently no-op'ing.

> [!IMPORTANT]
> **Resources are excluded from `stateHash` and from snapshot/restore.** Mutating a resource never perturbs the [determinism](./determinism.md) digest, and resources do **not** survive `snapshot()`/`restoreInto()` (v1 scope). If a resource holds sim-affecting state you need to reproduce, fold it into a component or re-seed it after restore.

## See also

- [events](./events.md) — the other non-entity communication channel (per-frame, not persistent)
- [schedule](./schedule.md) — `runIfResourceEq` gates systems on a resource value
- [determinism](./determinism.md) — why resources sit outside the state hash
