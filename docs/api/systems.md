# Systems

A **system** is a plain function that runs over queries in each frame. You register it, you declare
what it `reads` and `writes`, and you add it to a phase of the [schedule](./schedule.md). The
function receives a **`SystemContext`** (`ctx`), which is its window into the `ECS`, and the delta
time of the frame.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";
const ecs = new ECS();

const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent(["vx", "vy"] as const);
const movers = ecs.query(Pos, Vel);

const move = ecs.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);
      const { vx, vy } = cols.read(Vel);
      for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
    });
  },
});

ecs.addSystems(SCHEDULE.UPDATE, move);   // registration is not scheduling — do both
```

> [!IMPORTANT]
> `registerSystem` gives you a handle, but it schedules **nothing**. You must also call
> `ecs.addSystems(phase, descriptor)` (see [schedule](./schedule.md)). If you do not, the system
> never runs.

## `registerSystem` — three forms

```ts
// 1. Config form — the form for real work.
registerSystem(config: SystemConfig): SystemDescriptor;

// 2. Function alone — no query, NO declared access.
registerSystem(fn: (ctx, dt) => void): SystemDescriptor;

// 3. Function with a query builder — the query is resolved one time, at registration.
registerSystem<Defs>(
  fn: (q: Query<Defs>, ctx, dt) => void,
  queryFn: (qb: QueryBuilder) => Query<Defs>,
): SystemDescriptor;
```

> [!WARNING]
> The **function alone** form and the **function with a builder** form register with **empty access
> declarations**. Each attempt to touch a component, a resource, or a relation in them throws in
> development, because they declare that they touch nothing. Use them only for small connection
> code that touches no ECS state, such as an increase to an external counter. For real work that
> reads or writes ECS data, use the **config form**, so that the access checker can protect you.

> [!WARNING]
> **A risk with the number of parameters.** A function alone with three parameters is almost
> certainly the `(q, ctx, dt)` builder form, with the second `queryFn` argument absent. That
> mistake binds `q` to `ctx` and `dt` to `undefined`, and your calculations then give `NaN`. In
> development this throws `SYSTEM_FN_ARITY`. In production the guard is absent, so give the second
> argument correctly.

## `SystemConfig`

```ts
interface SystemConfig {
  fn?: (ctx: SystemContext, dt: number) => void;  // the update body — required unless backendHandle is set
                                                  // (one of the two, DEV-enforced; see compute backends below)

  // --- Access declarations (checked in development) ---
  reads:  readonly ComponentDef[];                // required (empty = "touches no columns")
  writes: readonly ComponentDef[];                // required; a write also gives read access
  spawns?:    readonly (readonly ComponentDef[] | Template)[];
  despawns?:  readonly (ComponentDef | Template)[];
  transitions?: readonly SystemTransition[];      // add/remove sets during a tick
  resourceReads?:  readonly ResourceKey<any>[];
  resourceWrites?: readonly ResourceKey<any>[];
  sparseReads?:   readonly SparseComponentDef[];
  sparseWrites?:  readonly SparseComponentDef[];
  relationReads?:  readonly RelationDef[];        // include ANY_RELATION for forEachRelatedTo
  relationWrites?: readonly RelationDef[];
  queries?: readonly (readonly ComponentDef[])[]; // one entry for each closed-over / builder query — a check only

  // --- Optional ---
  name?: string;                                  // diagnostics
  exclusive?: boolean;                            // full-access bypass (see below)
  backendHandle?: BackendSystemHandle;            // send the body to a compute backend
  onAdded?: (ctx) => void;                        // one time, during startup()
  onRemoved?: () => void;                         // on removeSystem
  dispose?: () => void;                           // on ecs.dispose()
}
```

The access checker holds you to these rules (in development only):

- **`reads` and `writes` are necessary.** Give empty arrays to say "this system touches no columns"
  explicitly. Each other declaration field is empty by default.
- **A write also gives read access**, and it authorizes `addComponent` on that column.
- **`despawn` removes each component** on the entity. Declare the full set in `despawns`.
- **Sparse ids and relation ids are in separate id spaces.** Declare them in the `sparse*` and
  `relation*` fields. Never declare them in `reads` or `writes`.
- **`queries`** is a *check*, and not a run-time term. At registration it tests that
  `queries ⊆ reads ∪ writes`, and it throws `QUERY_ACCESS_UNDECLARED` if you query a component that
  you did not declare. It cannot find a component that is absent from *both* lists. So keep it
  equal to the terms of your closed-over `ecs.query(...)` calls, or to the terms of the query
  builder that you give to `registerSystem`.

### Compile-time enforcement

The config form does more than supply the development-mode checker. `registerSystem` reads your
declaration lists as literal types, and it gives `fn` and `onAdded` a `SystemContext` that is
**limited to exactly what you declared**. So access that you did not declare does not *compile*,
and the error names the declaration that is absent:

```ts
const sys = ecs.registerSystem({
  reads: [Pos],
  writes: [Vel],
  fn(ctx) {
    ctx.setField(e, Vel, "vx", 1);   // ✓ a declared write
    ctx.getField(e, Pos, "x");       // ✓ a declared read
    ctx.getField(e, Vel, "vy");      // ✓ a write also gives read access

    ctx.setField(e, Pos, "x", 1);
    // ✗ compile error: […, "component is not declared in this system's writes", …]
    ctx.commands.despawn(e);
    // ✗ compile error: "this system declares no despawns — despawn is not permitted"
  },
});
```

The compiler applies each rule in the list above. `writes ∪ spawns ∪ transitions.add` authorizes
`add`, and templates are part of that union. `despawns ∪ transitions.remove` authorizes `remove`. A
destroy operation requires a `despawns` list that is not empty. The rule that a write also gives
read access applies to the sparse, relation, and resource terms. The check
`queries ⊆ reads ∪ writes` also runs at compile time.

The compiler is the first line of defence, and not a replacement. Keep the development-mode
run-time checks on. They find the errors that the type system cannot:

- Two components with **identical schemas** are equivalent to the compiler.
- Two resource keys that carry the same value type are equivalent.
- Relations are one nominal type. The compiler only knows the difference between "declares *some*
  relation access" and "declares none".
- A config that you build dynamically (a value with the `SystemConfig` type) registers with a
  permissive context.

**An alternative:** add a type to the context parameter — `fn(ctx: SystemContext) { … }` — to
remove the limits from one system. The run-time checker still applies. This is how a test that
violates its own declaration on purpose asserts the development throw. A helper function can
continue to take a plain `SystemContext`, because you can assign each limited context to it.

### `exclusive` systems

```ts
ecs.registerSystem({ exclusive: true, reads: [], writes: [], fn: (ctx) => { /* anything */ } });
```

`exclusive: true` gives **full `ECS` access** for the full run of the system. Each access check
passes, `reads` and `writes` can be empty, and `ctx` stays the permissive `SystemContext` at the
type level, with no compile-time limits. Use it only for the systems that truly touch everything:
the [apply system for host commands](./host-write-seam.md), save and load, and debug tools. The
schedule is sequential today, so this flag is only the grant that bypasses the access check.

### `SystemTransition`

```ts
interface SystemTransition {
  readonly whenHas: readonly ComponentDef[];   // entities with all of these...
  readonly add?: readonly ComponentDef[];       // ...may gain these
  readonly remove?: readonly ComponentDef[];    // ...may lose these
}
```

This declares an archetype transition that a system does during a tick. The access checker then
permits the add and the remove, and the engine prepares the target archetypes.

## The system context (`ctx`)

`ctx` is a `SystemContext`, and it is the only handle that a system receives. It divides into
**deferred** structural operations, which the engine holds until the flush at the end of the phase
so that iteration stays safe, and **immediate** reads and writes.

### Reads and writes of components (immediate)

```ts
ref<S>(def, entityId): ComponentRef<S>;         // a mutable cached accessor — sets the change tick
refRead<S>(def, entityId): ReadonlyComponentRef<S>;   // read-only — no change to the tick
getField<S>(entityId, def, field): number;
tryGetField<S>(entityId, def, field): number | undefined; // total: dead/missing → undefined
setField<S>(entityId, def, field, value): void; // writes and sets the change tick
updateField<S>(entityId, def, field, fn): number;     // read, modify, write; gives the new value
markChanged(entityId, def): void;               // mark one entity for onSet by hand (raw loops)
```

See [refs](./refs.md) for `ref` and `refRead`, and [change detection](./change-detection.md) for
the meaning of "sets the change tick".

<a id="ctxcommands--deferred-structural-ops"></a>

### `ctx.commands` — deferred structural operations

```ts
ctx.commands.spawn(...items: BundleOrDef[]): EntityID;   // the create is immediate, the attaches are deferred
ctx.commands.add(entityId, ...items: BundleOrDef[]): this;   // a bundle writes 0 in each absent field
ctx.commands.add(entityId, def, values): this;               // all values, explicit (checked at compile time)
ctx.commands.remove(entityId, def): this;
ctx.commands.despawn(entityId): this;
ctx.commands.disable(entityId): this;
ctx.commands.enable(entityId): this;
```

> [!TIP]
> `ctx.commands` is the **only** deferred surface. Version 0.5.0 removed the equivalent bare
> functions `ctx.addComponent`, `ctx.removeComponent`, `ctx.disable`, and `ctx.enable`. So a
> deferred operation always reads as one at the call site. Build entities from
> [bundles](./components.md#the-handle-is-callable--bundles):
> `ctx.commands.spawn(Pos({ x, y }), Vel({ vx: 1 }), IsEnemy)`.

> [!NOTE]
> `ctx.commands.spawn` gives you the new id **immediately**, because the create is not deferred.
> But the components attach at the flush. So a query later in the *same phase* can see the entity
> only partially built. To learn the id of a new entity after its data is present, use the
> [host write path](./host-write-seam.md) with an `onSpawned` callback instead.

### The remainder of `ctx`

```ts
isAlive(id): boolean;            hasComponent(id, def): boolean;   isDisabled(id): boolean;

// Sparse and relation operations — IMMEDIATE (see sparse-storage.md / relations.md)
addSparse / removeSparse / hasSparse / getSparseField / setSparseField
addRelation / removeRelation / targetOf / targetsOf / sourcesOf / hasRelation

// Events and resources (see events.md / resources.md)
emit(key, values?): void;   read(key): EventReader;
resource(key): T;   setResource(key, value): void;   removeResource(key): void;   hasResource(key): boolean;

get ecsTick(): number;   // the current write tick of the store
flush(): void;           // apply the buffered structural operations now
```

> [!WARNING]
> Each sparse and relation operation on `ctx` is **immediate**. There is no archetype transition,
> so it is safe during a system. Each operation on `ctx.commands` is **deferred**. This difference
> in timing is intentional (see
> [entities](./entities.md#immediate-vs-deferred--the-one-thing-to-internalize)).

## Lifecycle hooks

- **`onAdded(ctx)`** runs one time during `ecs.startup()`, inside the access span of the system.
  So the engine *does* check its access. Use it to create the first entities, or to give
  resources their initial values.
- **`onRemoved()`** runs when you call `ecs.removeSystem(descriptor)`.
- **`dispose()`** runs on `ecs.dispose()`.

## `SystemDescriptor`

`registerSystem` gives you a frozen `SystemDescriptor`, which is the identity handle. Use it, by
object identity, to schedule the system, to set its order against other systems, and to remove it:

```ts
ecs.addSystems(SCHEDULE.UPDATE, move);
ecs.addSystems(SCHEDULE.UPDATE, { system: render, ordering: { after: [move] } });
ecs.removeSystem(move);
```

## Compute backend (advanced)

If the system carries a `backendHandle` **and** you attached a
[compute backend](./memory.md#compute-backend) with `ecs.attachBackend(...)`, the schedule runs
`backend.run(handle)` **in place of** `fn`. Continue to declare `reads` and `writes` correctly,
because they authorize the shared-memory columns that the backend touches. If you attach no
backend, `fn` runs as the pure-TypeScript alternative.

## See also

- [schedule](./schedule.md) — the phases, the order of systems, system sets, run conditions, and
  the frame loop
- [queries](./queries.md) — the terminal functions that a system body uses
- [refs](./refs.md) · [change detection](./change-detection.md) — the mutation surface and the tick
- [WASM backends](./wasm.md) · [parallel execution](./parallel.md) — systems that a backend runs,
  and access declarations that are ready for parallel execution
- [the host write path](./host-write-seam.md) — how to send writes in from outside the schedule
