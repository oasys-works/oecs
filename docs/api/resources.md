# Resources

> [!NOTE]
> **0.5.0 — a grouped surface.** Registration of a resource, and access to it, are on the
> **`ecs.resources`** facade: `ecs.resources.register(Time, {...})`, `ecs.resources.get(Time)`,
> `ecs.resources.set(Time, v)`, `ecs.resources.remove(Time)`, and `ecs.resources.has(Time)`.
> Version 0.5.0 **removed** the flat `ecs.*` forms of 0.4 and earlier.

A **resource** is a typed global value. There is one value for each `ECS`, and a symbol is its key.
Use a resource for state that does not belong to an entity: the input state, the camera, the game
clock, configuration flags, or the seed of a random number generator.

```ts
import { resourceKey } from "@oasys/oecs";

// 1. Make a key at module scope — the type travels with the key.
const Time = resourceKey<{ delta: number; elapsed: number }>("Time");

// 2. Register it with an initial value.
ecs.resources.register(Time, { delta: 0, elapsed: 0 });

// 3. Read it or write it from anywhere.
const t = ecs.resources.get(Time);   // t.delta and t.elapsed have types
ecs.resources.set(Time, { delta: 1 / 60, elapsed: t.elapsed + 1 / 60 });
```

## Keys

```ts
resourceKey<T>(name: string): ResourceKey<T>;
type ResourceKey<T> = symbol & { readonly [__resourceValue]: (value: T) => T };
```

The phantom slot has a **function type on purpose**. That type makes `T` invariant. A key
authorizes a read and a write, so you must not be able to assign a key with one `T` to a key with a
different `T`.

`resourceKey` makes a unique symbol that carries the value type `T`. The `name` is for diagnostics
only. The identity of the symbol gives uniqueness, and the string does not. So two
`resourceKey("Time")` calls give two different keys. Make each key **one time, at module scope**,
and import it wherever you need the resource.

## Methods

On the host, each function is on the **`ecs.resources`** facade. In a system, the four accessors
are methods on `ctx`. There is no registration form on `ctx`, because registration is a host
operation that you do at setup time.

```ts
// Host — the ecs.resources facade:
register<T>(key: ResourceKey<T>, value: T): void;
get<T>(key: ResourceKey<T>): T;
set<T>(key: ResourceKey<T>, value: T): void;
remove<T>(key: ResourceKey<T>): void;
has<T>(key: ResourceKey<T>): boolean;

// In a system — on ctx:
getResource<T>(key: ResourceKey<T>): T;
setResource<T>(key: ResourceKey<T>, value: T): void;
removeResource<T>(key: ResourceKey<T>): void;
hasResource<T>(key: ResourceKey<T>): boolean;
```

The two surfaces follow two conventions on purpose. The **flat `ctx`** surface puts the noun in
each accessor name: `getResource`, `setResource`, `removeResource`, and `hasResource`. This agrees
with `getField`, `setField`, and `hasComponent`. The **grouped `ecs.resources`** facade removes the
noun and uses `get`, `set`, `remove`, and `has`, because the receiver already gives the noun.

On `ctx`, the type of the key parameter is also limited to the declared access of the system.
`ctx.getResource` accepts only a key in `resourceReads`. `ctx.setResource` and
`ctx.removeResource` accept only a key in `resourceWrites`. A key that you did not declare is a
compile error, and the development-mode access check supports the same rule.

In a system, you must **declare** resource access, and the engine **checks** it. List the key in
`resourceReads` to read it, and in `resourceWrites` to write it.

```ts
ecs.registerSystem({
  reads: [], writes: [],
  resourceReads: [Time], resourceWrites: [Score],
  fn: (ctx) => {
    const t = ctx.getResource(Time);
    ctx.setResource(Score, ctx.getResource(Score) + t.delta);
  },
});
```

## Points to note

> [!WARNING]
> **Register one time.** If you register a key that is already live, it throws
> `RESOURCE_ALREADY_REGISTERED`. `ecs.resources.remove` releases the key, so that you can register
> it again. A resource has a present or absent state, and not only a value.

> [!NOTE]
> The access check treats removal (`ecs.resources.remove` or `ctx.removeResource`) as a **write**,
> so declare it in `resourceWrites`. Removal also **fails safely for a key that is absent**: it
> throws, and it does not do nothing quietly.

> [!IMPORTANT]
> **`stateHash`, snapshot, and restore do not include resources.** A change to a resource never
> changes the [determinism](./determinism.md) digest, and a resource does **not** survive
> `ecs.snapshots.capture()` and `restore()` (this is the scope of v1). If a resource holds
> simulation state that you must reproduce, move it into a component, or set it again after a
> restore.

## See also

- [events](./events.md) — the other channel for data that is not on an entity (it is for one frame,
  and it is not persistent)
- [schedule](./schedule.md) — `runIfResourceEq` gates a system on the value of a resource
- [determinism](./determinism.md) — why the state hash does not include resources
