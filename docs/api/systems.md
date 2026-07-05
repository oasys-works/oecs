# Systems

A **system** is a plain function that runs over queries each frame. You register it, declare what it `reads` and `writes`, and add it to a [schedule](./schedule.md) phase. The function receives a **`SystemContext`** (`ctx`) — its window onto the `ECS` — and the frame's delta time.

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

ecs.addSystems(SCHEDULE.UPDATE, move);   // registration ≠ scheduling — do both
```

> [!IMPORTANT]
> `registerSystem` returns a handle but does **not** schedule anything. You must also call `ecs.addSystems(phase, descriptor)` (see [schedule](./schedule.md)) or the system never runs.

## `registerSystem` — three forms

```ts
// 1. Config form — the one you'll use for real work.
registerSystem(config: SystemConfig): SystemDescriptor;

// 2. Bare function — no query, NO declared access.
registerSystem(fn: (ctx, dt) => void): SystemDescriptor;

// 3. Function + query builder — query resolved once at registration.
registerSystem<Defs>(
  fn: (q: Query<Defs>, ctx, dt) => void,
  queryFn: (qb: QueryBuilder) => Query<Defs>,
): SystemDescriptor;
```

> [!WARNING]
> The **bare** and **function + builder** forms register with **empty access declarations**. Any component/resource/relation access they attempt throws in dev (they touch nothing, by declaration). They're only for trivial glue that touches no ECS state — for example, bumping an external counter. Real work that reads/writes ECS data uses the **config form** so the access checker can protect you.

> [!WARNING]
> **Arity trap.** A bare 3-parameter function is almost certainly the `(q, ctx, dt)` builder form with the second `queryFn` argument forgotten — which would silently bind `q := ctx`, `dt := undefined` and `NaN` your math. In dev this throws `SYSTEM_FN_ARITY`. In prod the guard is gone; get the second argument right.

## `SystemConfig`

```ts
interface SystemConfig {
  fn: (ctx: SystemContext, dt: number) => void;   // required — the update body

  // --- Access declarations (dev-checked) ---
  reads:  readonly ComponentDef[];                // required (empty = "touches no columns")
  writes: readonly ComponentDef[];                // required; a write implies a read
  spawns?:    readonly (readonly ComponentDef[] | Template)[];
  despawns?:  readonly (ComponentDef | Template)[];
  transitions?: readonly SystemTransition[];      // mid-tick add/remove sets
  resourceReads?:  readonly ResourceKey<any>[];
  resourceWrites?: readonly ResourceKey<any>[];
  sparseReads?:   readonly SparseComponentDef[];
  sparseWrites?:  readonly SparseComponentDef[];
  relationReads?:  readonly RelationDef[];        // include ANY_RELATION for forEachRelatedTo
  relationWrites?: readonly RelationDef[];
  queries?: readonly (readonly ComponentDef[])[]; // one entry per closed-over / builder query — lint only

  // --- Optional ---
  name?: string;                                  // diagnostics
  exclusive?: boolean;                            // full-access bypass (see below)
  backendHandle?: BackendSystemHandle;            // route body to a compute backend
  onAdded?: (ctx) => void;                        // once, during startup()
  onRemoved?: () => void;                         // on removeSystem
  dispose?: () => void;                           // on ecs.dispose()
}
```

Key rules the access checker enforces (dev only):

- **`reads`/`writes` are mandatory** — pass empty arrays to say "this system touches no columns" explicitly. Every other declaration field defaults to empty.
- **A write implies a read**, and authorizes `addComponent` on that column.
- **`despawn` removes every component** on the entity — declare the superset in `despawns`.
- **Sparse and relation ids live in separate id spaces.** Declare them in `sparse*`/`relation*`, never in `reads`/`writes`.
- **`queries`** is a *lint*, not a runtime term: at registration it checks `queries ⊆ reads ∪ writes` and throws `QUERY_ACCESS_UNDECLARED` if you query a component you didn't declare. It can't catch a component missing from *both*, so keep it mirroring your closed-over `ecs.query(...)` terms or the query-builder terms you pass to `registerSystem`.

### Compile-time enforcement

The config form doesn't just feed the dev-mode runtime checker. `registerSystem` infers your declaration lists as literal types and hands `fn` / `onAdded` a `SystemContext` **narrowed to exactly what you declared** — undeclared access fails to *compile*, with the missing declaration named in the error:

```ts
const sys = ecs.registerSystem({
  reads: [Pos],
  writes: [Vel],
  fn(ctx) {
    ctx.setField(e, Vel, "vx", 1);   // ✓ declared write
    ctx.getField(e, Pos, "x");       // ✓ declared read
    ctx.getField(e, Vel, "vy");      // ✓ a write implies a read

    ctx.setField(e, Pos, "x", 1);
    // ✗ compile error: […, "component is not declared in this system's writes", …]
    ctx.commands.despawn(e);
    // ✗ compile error: "this system declares no despawns — despawn is not permitted"
  },
});
```

Every rule in the list above is mirrored: `add` is authorized by `writes ∪ spawns ∪ transitions.add` (Templates included), `remove` by `despawns ∪ transitions.remove`, destroy requires a non-empty `despawns`, write-implies-read holds for the sparse/relation/resource terms, and the `queries ⊆ reads ∪ writes` lint runs at compile time too.

The compiler is the first line, not a replacement — keep dev-mode runtime checks on. They still catch what structural typing can't:

- Two components with **identical schemas** are interchangeable to the compiler.
- Two resource keys carrying the same value type are interchangeable.
- Relations are one nominal type — the compiler only distinguishes "declared *some* relation access" from "declared none".
- A dynamically-built config (a value typed `SystemConfig`) registers with a permissive context.

**Escape hatch:** annotate the context parameter — `fn(ctx: SystemContext) { … }` — to opt one system out of narrowing (the runtime checker still applies). This is how tests that deliberately violate their declaration assert the dev throw. Helper functions can keep taking a bare `SystemContext`; every narrowed context is assignable to it.

### `exclusive` systems

```ts
ecs.registerSystem({ exclusive: true, reads: [], writes: [], fn: (ctx) => { /* anything */ } });
```

`exclusive: true` grants **full `ECS` access** for the system's whole run — every access check passes, `reads`/`writes` may be empty, and `ctx` stays the permissive `SystemContext` at the type level (no compile-time narrowing). Use it sparingly for systems that genuinely touch everything: the [host-command apply system](./host-write-seam.md), save/load, debug tooling. The schedule is sequential today, so this is purely the access-bypass grant.

### `SystemTransition`

```ts
interface SystemTransition {
  readonly whenHas: readonly ComponentDef[];   // entities with all of these...
  readonly add?: readonly ComponentDef[];       // ...may gain these
  readonly remove?: readonly ComponentDef[];    // ...may lose these
}
```

Declares an archetype transition a system performs mid-tick, so the access checker allows the add/remove and the target archetypes are prewarmed.

## The system context (`ctx`)

`ctx` is a `SystemContext` — the only handle a system gets. It splits cleanly into **deferred** structural ops (buffered to the phase flush, so iteration stays safe) and **immediate** reads/writes.

### Component reads & writes (immediate)

```ts
ref<S>(def, entityId): ComponentRef<S>;         // mutable cached accessor — bumps the change tick
refRead<S>(def, entityId): ReadonlyComponentRef<S>;   // read-only — no tick bump
getField<S>(entityId, def, field): number;
setField<S>(entityId, def, field, value): void; // writes + bumps the change tick
updateField<S>(entityId, def, field, fn): number;     // read-modify-write; returns the new value
markChanged(entityId, def): void;               // manually flag a per-entity onSet (hot raw loops)
```

See [refs](./refs.md) for `ref`/`refRead`, and [change detection](./change-detection.md) for what "bumps the tick" means.

<a id="ctxcommands--deferred-structural-ops"></a>

### `ctx.commands` — deferred structural ops

```ts
ctx.commands.spawn(...items: BundleOrDef[]): EntityID;   // create immediate, attaches deferred
ctx.commands.add(entityId, ...items): this;
ctx.commands.remove(entityId, def): this;
ctx.commands.despawn(entityId): this;
ctx.commands.disable(entityId): this;
ctx.commands.enable(entityId): this;
```

> [!TIP]
> Prefer `ctx.commands.*` over the bare `ctx.addComponent` / `ctx.removeComponent`. They do the same deferred thing, but `ctx.commands` reads unambiguously as "deferred" at the call site — where the bare `ctx.addComponent` is one keystroke from the *immediate* `ecs.addComponent`. Spawn and despawn live **only** on `ctx.commands`. Build entities from [bundles](./components.md#the-handle-is-callable--bundles): `ctx.commands.spawn(Pos({ x, y }), Vel({ vx: 1 }), IsEnemy)`.

> [!NOTE]
> `ctx.commands.spawn` returns the new id **immediately** (the create isn't deferred), but the components attach at the flush. A query later in the *same phase* can observe the entity half-built. To learn a spawned id after its data lands, spawn from the [host-write seam](./host-write-seam.md) with an `onSpawned` callback instead.

### The rest of `ctx`

```ts
isAlive(id): boolean;            hasComponent(id, def): boolean;   isDisabled(id): boolean;
disable(id): this;               enable(id): this;
addComponent(id, def, values?): this;    removeComponent(id, def): this;   // bare deferred ops (prefer ctx.commands)

// Sparse & relation ops — IMMEDIATE (see sparse-storage.md / relations.md)
addSparse / removeSparse / hasSparse / getSparseField / setSparseField
addRelation / removeRelation / targetOf / targetsOf / sourcesOf / hasRelation

// Events & resources (see events.md / resources.md)
emit(key, values?): void;   read(key): EventReader;
resource(key): T;   setResource(key, value): void;   removeResource(key): void;   hasResource(key): boolean;

get ecsTick(): number;   // current store write tick
flush(): void;           // force-apply buffered structural ops now
```

> [!WARNING]
> Every sparse/relation op on `ctx` is **immediate**. `ctx.addComponent`/`removeComponent`, `ctx.disable`/`ctx.enable`, and all of `ctx.commands` are **deferred**. This mirror-with-different-timing is intentional (see [entities](./entities.md#immediate-vs-deferred--the-one-thing-to-internalize)); when in doubt, reach for `ctx.commands`.

## Lifecycle hooks

- **`onAdded(ctx)`** — runs once during `ecs.startup()`, inside the system's access span (so its access *is* checked). Use it to spawn initial entities or seed resources.
- **`onRemoved()`** — runs when you `ecs.removeSystem(descriptor)`.
- **`dispose()`** — runs on `ecs.dispose()`.

## `SystemDescriptor`

`registerSystem` returns a frozen `SystemDescriptor` — the identity handle. Use it (by object identity) to schedule the system, to order it relative to others, and to remove it:

```ts
ecs.addSystems(SCHEDULE.UPDATE, move);
ecs.addSystems(SCHEDULE.UPDATE, { system: render, ordering: { after: [move] } });
ecs.removeSystem(move);
```

## Compute backend (advanced)

If the system carries a `backendHandle` **and** a [compute backend](./memory.md#compute-backend) is attached via `ecs.attachBackend(...)`, the schedule runs `backend.run(handle)` **instead of** `fn`. Still declare `reads`/`writes` accurately — they authorize the shared-memory columns the backend touches. With no backend attached, `fn` runs as the pure-TS fallback.

## See also

- [schedule](./schedule.md) — phases, ordering, system sets, run conditions, the frame loop
- [queries](./queries.md) — the iteration terminals a system body uses
- [refs](./refs.md) · [change detection](./change-detection.md) — the mutation surface and the tick
- [WASM backends](./wasm.md) · [parallelism](./parallel.md) — backend-routed systems and parallel-ready access declarations
- [host-write seam](./host-write-seam.md) — feeding writes in from outside the schedule
