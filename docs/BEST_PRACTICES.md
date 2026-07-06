# Best Practices (v0.5)

Practical guidance for building with oecs: patterns that work with the engine's grain, the trade-offs they imply, and the pitfalls that bite if ignored.

This document does **not** repeat the API reference or describe internals. For those, see:

- API reference: [`docs/api/`](./api/) — one page per subsystem, indexed by [`api/index.md`](./api/index.md).
- Internals: [`ARCHITECTURE.md`](./ARCHITECTURE.md) — data layout, the flush model, cache-invalidation rules, the column store.

Examples name the instance `ecs` and use the 0.5 surface (camelCase methods, the config-form `registerSystem`, `eachChunk`, `ctx.ref`). The canonical compiling example is the README quick-start; `src/core/ecs/__tests__/` is the canonical "does this actually work" reference (see [§20](#20-testing)).

## Contents

1. [Designing components](#1-designing-components)
2. [Dense vs sparse storage](#2-dense-vs-sparse-storage)
3. [Keys at module scope](#3-keys-at-module-scope)
4. [Declaring system access](#4-declaring-system-access)
5. [Querying](#5-querying)
6. [Reading vs writing columns](#6-reading-vs-writing-columns)
7. [Immediate vs deferred structural ops](#7-immediate-vs-deferred-structural-ops)
8. [System ordering, sets, and run conditions](#8-system-ordering-sets-and-run-conditions)
9. [Change detection](#9-change-detection)
10. [Observers](#10-observers)
11. [Entity lifecycle](#11-entity-lifecycle)
12. [Relations](#12-relations)
13. [Events vs signals](#13-events-vs-signals)
14. [Resources](#14-resources)
15. [Determinism](#15-determinism)
16. [The host-write seam and editor](#16-the-host-write-seam-and-editor)
17. [Memory sizing](#17-memory-sizing)
18. [The reactive UI seam](#18-the-reactive-ui-seam)
19. [Using type primitives directly](#19-using-type-primitives-directly)
20. [Testing](#20-testing)
21. [Anti-patterns](#21-anti-patterns)

---

## 1. Designing components

### Prefer many small components over one fat component

Archetypes are keyed by the exact set of components on an entity, and queries filter on component masks — both favour small, focused components:

- **Query selectivity.** A system that needs only `Pos` writes `ecs.query(Pos)` and iterates every entity with a position, regardless of what else they have. Bundle `Pos` into a fat `Transform { x, y, rotation, scale, parent, … }` and you drag all those columns through every loop that touches position.
- **Archetype specialisation.** Adding a marker (e.g. `Frozen`) produces a new archetype; systems that act only on frozen entities iterate just those rows. As a `Transform.frozen` field it forces every consumer to branch in the inner loop.
- **Partial writes stamp fewer ticks.** Change ticks are per `(archetype, component)`. Touching `Pos` stamps `Pos` — not `Vel`, not `Health`. A fat component wakes `changed()` observers for changes they don't care about.

```ts
// Good — one responsibility each
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent(["vx", "vy"] as const);
const Health = ecs.registerComponent({ current: "i32", max: "i32" });

// Avoid — one fat component forces every consumer to see every field
const Entity = ecs.registerComponent({ x: "f64", y: "f64", vx: "f64", vy: "f64", hp: "i32" });
```

The counterpoint is **archetype fragmentation**: every unique combination is a distinct archetype, and three independent boolean tags yield up to 2³ = 8 archetypes, many nearly empty. When combinations are large and sparse, pack related flags into a single `u8` field, or move rare/churny flags to [sparse storage](#2-dense-vs-sparse-storage).

### Pick the narrowest typed-array tag that fits

Columns are concrete typed arrays; narrow types mean denser memory and better cache use.

| Data | Tag |
| --- | --- |
| Physics positions, velocities | `"f64"` |
| Pixel coordinates, small reals | `"f32"` |
| Health, counters, signed integers | `"i32"` |
| Tile indices, small counts | `"u16"` |
| Flags, small enums | `"u8"` |

Use the array shorthand when every field shares a type (default `"f64"`), and keep `as const` — without it TypeScript widens the field names to `string[]` and you lose per-field inference on `addComponent`, `getField`, columns, and refs.

```ts
const Vel = ecs.registerComponent(["vx", "vy"] as const);           // all f64
const Flags = ecs.registerComponent(["a", "b", "c"] as const, "u8"); // all u8
```

There is **no boolean, string, or 64-bit-integer field type** — every field is a JS `number`. Model a flag as a tag or `u8`, an enum as a small integer, and keep strings in a resource or a side table keyed by `EntityID`.

### Use tags for classification, and the callable form for bundles

A tag (`registerTag()`) is a component with no fields — the cleanest way to express "this entity is a kind of X", and it takes column-free fast paths.

```ts
const IsEnemy = ecs.registerTag();
const Frozen = ecs.registerTag();

const enemies = ecs.query(Pos, Health).and(IsEnemy);
const thawed = ecs.query(Health).without(Frozen);
```

A `ComponentDef` is **callable** — `Pos({ x: 10, y: 20 })` produces a bundle, and the varargs spawn/add paths take bundles. This is the ergonomic way to spell a multi-component entity, and it's the *typed* attach path for partial values: omitted fields zero-fill.

```ts
const e = ecs.spawnBundle(Pos({ x: 10, y: 20 }), Vel({ vx: 1 }), IsEnemy);
```

The typed `ecs.addComponent(e, Pos, values)` overload demands the **complete** `FieldValues<S>` (every field); provide `0` explicitly there, or use a bundle.

---

## 2. Dense vs sparse storage

Dense components live in the archetype identity: adding or removing one moves the entity to a new archetype, copying its **entire** payload row. A sparse component (`registerSparseComponent` / `registerSparseTag`) lives *outside* identity — add/remove is a flat sparse-set insert/delete with no transition, no row copy, and no dense-identity bit consumed.

| Use **sparse** for | Use **dense** for |
| --- | --- |
| data present on a small fraction of entities | data present on most matching entities |
| flags/values that flip on and off constantly | stable structural identity |
| cooldowns, transient markers, relation targets | anything iterated in a hot column loop |
| escaping the **128-component dense cap** | — |

```ts
const Cooldown = ecs.registerSparseComponent({ ready: "u32" });
ecs.addSparse(e, Cooldown, { ready: 90 });   // immediate, no archetype change
```

The cost: sparse membership isn't in the archetype mask, so it's invisible to a plain dense query and has no SoA span. Filter with `withSparse`/`withoutSparse` and iterate with `forEachEntity`:

```ts
ecs.query(Unit).withSparse(Cooldown).forEachEntity((e) => {
  const ready = ecs.getSparseField(e, Cooldown, "ready");
});
```

> [!WARNING]
> The **128-slot dense budget is a hard cap** — each `registerComponent`/`registerTag` claims one archetype-mask bit and the 129th throws `COMPONENT_LIMIT_EXCEEDED`. Rare, churny, or budget-blowing data belongs in sparse storage, which is uncapped.

Because sparse ops apply immediately, mutating the *driving* sparse membership during a `forEachEntity` walk shifts the live key array under you — buffer such edits and apply them after the loop.

---

## 3. Keys at module scope

`eventKey`, `signalKey`, and `resourceKey` each mint a fresh symbol on every call. Identity only survives across registrations if the key is a single module-scope `const`:

```ts
// keys.ts
import { eventKey, signalKey, resourceKey, type EntityID } from "@oasys/oecs";

export const DamageEvent = eventKey<{ target: EntityID; amount: number }>("Damage");
export const GameOver = signalKey("GameOver");
export const Time = resourceKey<{ delta: number; elapsed: number }>("Time");
```

Then import the key everywhere you emit, read, or access the resource:

```ts
ecs.events.register(DamageEvent, ["target", "amount"]);
ecs.events.registerSignal(GameOver);
ecs.resources.register(Time, { delta: 0, elapsed: 0 });
```

`resourceKey("Time")` inside a function body would produce a new symbol per call, and two sites would not see the same resource. Module scope also documents ownership: this key lives here, register it once, import it elsewhere. Duplicate registration throws loudly (`RESOURCE_ALREADY_REGISTERED`, `EVENT_ALREADY_REGISTERED`).

> [!TIP]
> Event schemas can be declared as type literals **or** interfaces — the `EventShape<S>` constraint is homomorphic (`{ readonly [K in keyof S]: number }`), so no implicit index signature is required.

---

## 4. Declaring system access

Real work goes in the **config form** of `registerSystem`, which declares the components the system touches. A dev-mode access checker (tree-shaken from production) enforces those declarations, so a system that reads or writes something it didn't declare throws in dev — catching a whole class of "I forgot this system also touches Health" bugs before they ship.

```ts
const movers = ecs.query(Pos, Vel);

const move = ecs.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],          // a write implies a read, and authorizes addComponent(Pos)
  queries: [[Pos, Vel]],  // lint: every queried component must be in reads ∪ writes
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);
      const { vx, vy } = cols.read(Vel);
      for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
    });
  },
});
```

Rules worth internalizing:

- **`reads`/`writes` are mandatory** — pass empty arrays to say "touches no columns" explicitly. Every other declaration field defaults to empty.
- **A write implies a read** and authorizes `addComponent` on that column.
- **`despawn` removes every component** — declare the superset in `despawns`.
- **Sparse and relation ids are separate id spaces** — declare them in `sparseReads`/`sparseWrites` and `relationReads`/`relationWrites`, never in `reads`/`writes`.
- **`queries` is a registration-time lint**, not a runtime term: it checks `queries ⊆ reads ∪ writes`. Keep it mirroring your closed-over `ecs.query(...)` terms or the query-builder terms you pass to `registerSystem`.
- **Declarations are compile-time-checked too.** The config form types `ctx` to the declared access surface, so an undeclared read/write/add/destroy is a compile error before it's a dev-mode throw (see [systems — compile-time enforcement](./api/systems.md#compile-time-enforcement)). Annotate `fn(ctx: SystemContext)` to opt a system out of the narrowing.

> [!WARNING]
> The **bare-function** and **function + query-builder** overloads register with *empty* access — any component/resource/relation access they attempt throws in dev. They're only for trivial no-access systems, such as bumping an external counter. Use `exclusive: true` sparingly, for systems that genuinely touch everything (the host-command apply system, save/load, debug tooling) — it grants full access and bypasses every check.

---

## 5. Querying

### Narrow filters beat broad-plus-filter

Prefer the narrowest include set that expresses what the system needs. `ecs.query(A, B)` matches every archetype with *at least* `A` and `B`; refine with `without`, `anyOf`, `optional`, `changed`, `withSparse`/`withRelation`. Each verb returns a new **cached** query, and composition is memoized, so equivalent filters are the same instance (the one exception: multi-arg `changed(A, B)` mints a fresh `ChangedQuery`; single-arg `changed` is cached).

```ts
ecs.query(Pos)
  .and(Vel)             // require Vel too
  .without(Frozen)      // drop frozen entities
  .anyOf(Player, NPC);  // and be a Player OR an NPC
```

Iterating everything with `Pos` and branching on `has(Vel)` in the loop is slower and noisier than just querying `(Pos, Vel)`.

### Build queries once and close over them

Declare a query with `ecs.query(...)` at setup and capture it in the system's closure. The store keeps pushing newly-matching archetypes into it, so it never goes stale, and you pay no per-frame mask construction:

```ts
const movers = ecs.query(Pos, Vel);   // live, cached — build once
const move = ecs.registerSystem({ reads: [Pos, Vel], writes: [Pos], fn: () => movers.eachChunk(/* … */) });
```

The `registerSystem(fn, qb => qb.with(...))` builder overload is equivalent, but the closed-over form co-locates the query with the system and reads more clearly. Ad-hoc `ecs.query(...)` calls are still cached (equivalent filters return the same instance).

### Pick the right terminal

| Terminal | Callback | Mutate? | Use for |
| --- | --- | --- | --- |
| `forEach` | read-only `ArchetypeView` | no | reading columns |
| `eachChunk` | mutable `cols` + `count` | **yes** | the mutating hot loop |
| `forEachEntity` | one `EntityID` | via `ctx` | any query with a sparse / relation / hierarchy term |

`forEach`, `eachChunk`, and `entityCount` are **dense-only** — a query carrying a sparse, relation, or hierarchy term throws `SPARSE_QUERY_DENSE_PATH` in dev, because there's no column span. Use `forEachEntity` (or `forEachRelatedTo`) for those.

> [!WARNING]
> **Always loop to `arch.entityCount`, never a column's `.length`.** The raw buffer includes capacity and disabled rows past the live count; iterating `.length` reads garbage. `entityCount` is the enabled-row count. The `eachChunk` `count` parameter exists precisely to remove this trap.

---

## 6. Reading vs writing columns

Mutability is encoded in the accessor name, and the mutable ones **stamp the change tick eagerly** — the moment you acquire them, before any write, and even if you never write. That's what keeps `changed()` conservative. So reach for the read-only variant whenever you're only reading, both to avoid false change-detection *and* to signal intent.

| | Bumps the tick | Read-only, no bump |
| --- | --- | --- |
| Hot column loop | `cols.mut(def)` | `cols.read(def)` |
| One entity by id | `ctx.ref(def, e)` | `ctx.refRead(def, e)` |
| One field | `ctx.setField` / `ctx.updateField` | `ctx.getField` |

### `eachChunk` for the mutating hot loop

```ts
movers.eachChunk((cols, count) => {
  const { x, y } = cols.mut(Pos);     // writable columns; stamps Pos once
  const { vx, vy } = cols.read(Vel);  // read-only; no bump
  for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
});
```

Destructure `cols.mut(Pos)` immediately — the group object is cached per `(archetype, component)` and refreshed in place on the next call, so don't stash it across iterations.

### `ctx.ref` / `ctx.refRead` for cold, per-entity paths

Reach for a ref when the hot column loop doesn't fit: reacting to a single event, touching a specific entity by id, an occasional cross-entity write. Creating one is cheap (one `Object.create` over a cached prototype); each field access is a single typed-array index.

```ts
// Read-only: no tick bump
const pos = ctx.refRead(Pos, player);
ctx.emit(LogPos, { x: pos.x, y: pos.y });

// Mutable: stamps Pos at creation, even if you never assign
const pos = ctx.ref(Pos, player);
pos.x += vel.vx * dt;
```

> [!WARNING]
> **A ref does not survive an archetype transition.** It's safe to hold across immediate reads/writes within a system (structural changes are deferred, so the entity can't move until the phase flush), but once the entity gains or loses a component its row moves — re-create the ref. Refs *are* grow-safe: they read the live column backing, which refreshes in place across a grow.

`ReadonlyColumn` / `ReadonlyComponentRef` are compile-time barriers only — a cast can write through them, but that skips the change-tick bump and silently desyncs change detection. Don't. To mutate a query result, use `eachChunk` or write per entity through `ctx.ref` / `ctx.setField`.

---

## 7. Immediate vs deferred structural ops

The single most important timing rule: the receiver implies the mode. Everything on the host facade (`ecs.*`) is **immediate**; structural ops inside a system live on `ctx.commands.*` and are **deferred** to the phase flush.

| Operation | On `ecs` (host side) | On `ctx.commands` (inside a system) |
| --- | --- | --- |
| `spawn` | immediate | immediate (id now; bundle attaches at the flush) |
| `addComponent` / `removeComponent` | **immediate** | `add` / `remove` — **deferred** to the phase flush |
| `despawn` | **immediate** | **deferred** to the phase flush |
| `disable` / `enable` | immediate | deferred |
| sparse & relation ops (`ctx.addSparse`, `ctx.addRelation`, …) | immediate | immediate (no archetype transition — live on `ctx` directly) |

Deferral inside systems is what keeps a live `forEach`/`eachChunk` loop from having entities move archetypes mid-iteration. Host-side, every mutation applies immediately — `ecs.despawn(e); ecs.isAlive(e)` is `false` on the next line. Calling an immediate host structural mutator from *inside* a system body throws in dev — `ecs.despawn`, `ecs.addComponent`/`addComponents`, `ecs.removeComponent`/`removeComponents`, `ecs.batchAddComponent`/`batchRemoveComponent`, `ecs.disable`/`ecs.enable` — pointing you at the `ctx.commands` equivalent. (Mid-system these ops can move rows a running query is walking, and they are invisible to observers.) Host-side query walks are live iteration too: despawning (or otherwise structurally mutating) an entity of an archetype you are walking in a host `forEach`/`eachChunk` throws `STRUCTURAL_DURING_ITERATION` in dev — collect the ids during the walk and mutate after it.

**Inside a system, `ctx.commands` is the only deferred surface.** The bare `ctx.addComponent` / `ctx.removeComponent` / `ctx.disable` / `ctx.enable` duplicates were removed in 0.5.0 (with `ctx.createEntity` / `ctx.destroyEntity`), so a deferred op always reads as one at the call site:

```ts
ctx.commands.spawn(Pos({ x, y }), Vel({ vx: 1 }), IsEnemy);
ctx.commands.add(entity, Frozen);
ctx.commands.add(entity, Pos, { x: 0, y: 0 }); // explicit complete values (compile-checked)
ctx.commands.despawn(entity);
```

Note `ctx.commands.spawn` returns the new id immediately (the create isn't deferred) but the components attach at the flush — a query later in the *same* phase can observe the entity half-built. To learn a spawned id after its data lands, spawn from the [host-write seam](#16-the-host-write-seam-and-editor) with an `onSpawned` callback.

### One flush boundary over many

Every dense structural change costs an archetype move. When building an entity with known defaults, prefer a template so it lands directly in the target archetype:

```ts
const Enemy = ecs.template([
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: Health, values: { current: 100, max: 100 } },
]);

const e = ecs.spawn(Enemy);
```

For an existing entity, use `ecs.addComponents(e, [...])` to resolve the final component set once instead of walking an add-then-add chain. `spawnBundle(...)` is still useful ergonomically, but today it applies each bundle through the normal immediate add path.

For whole-archetype changes ("every entity with `Frozen` gets `Slow`"), use `ecs.batchAddComponent(arch.id, Def)` / `batchRemoveComponent` (they take an `ArchetypeID`), which bulk-move a column region via `TypedArray.set` instead of per-entity moves.

---

## 8. System ordering, sets, and run conditions

### Express real dependencies with `before` / `after`

Within a phase, systems are topologically sorted from `before`/`after` constraints, with insertion order as a deterministic tiebreaker. Always encode a real data dependency as a constraint — never lean on a phase boundary between unrelated systems:

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,
  { system: move, ordering: { after: [input] } },
  { system: collide, ordering: { after: [move] } },
);
```

If A must see B's writes this frame, put them in the same phase with `after: [B]`. Cycles throw `CIRCULAR_SYSTEM_DEPENDENCY` on the first sort of that phase — this check is **never** stripped in production, so design your ordering as a DAG.

> [!WARNING]
> **Ordering is phase-local.** A target scheduled in a different phase is silently ignored; a target scheduled in *no* phase (a typo, or a system you forgot to `addSystems`) is dropped with a dev-only warning and the constraint just vanishes. And `registerSystem` does not schedule — you must also `addSystems(phase, descriptor)`.

### Group with system sets; gate with run conditions

A `systemSet` shares a run condition and/or ordering across its members. `configureSet` is additive and order-independent with respect to `addSystems`:

```ts
const physics = systemSet("physics");
ecs.addSystems(SCHEDULE.FIXED_UPDATE, { system: integrate, set: physics }, { system: collide, set: physics });
ecs.configureSet(physics, { runIf: notPaused, before: [render] });
```

A run condition is a per-tick gate — a pure, read-only function of ECS state (`runIfResourceEq`, `runEveryNTicks`, `runIfAnyMatch`, or your own). A member's effective gate is the AND of its own conditions and every set it belongs to.

> [!WARNING]
> A run condition **must be deterministic and read-only** — no wall-clock, no RNG, no mutation; it runs in a reads-only access span (undeclared reads or any mutation throw in dev). A skipped system does **not** advance its last-run tick, so it still sees everything that changed while it was paused — nothing is missed across a gated pause. A schedule that uses no sets and no conditions runs a byte-for-byte fast path; you pay nothing for the feature until you use it.

### Keep systems single-purpose

One observable effect per system makes ordering easy to reason about and change detection clean: an observer that depends on `move`'s writes needs only `after: [move]`, not a whole phase of unrelated systems.

---

## 9. Change detection

### Poll with `changed()`

Stand up a query including the watched component, then call `.changed(...)` and order the reader `after` the writer so the writer's tick is visible:

```ts
const moved = ecs.query(Pos).changed(Pos);
const sync = ecs.registerSystem({
  reads: [Pos], writes: [],
  fn: () => moved.forEach((arch) => {
    const x = arch.getColumnRead(Pos, "x");
    for (let i = 0; i < arch.entityCount; i++) pushToRenderer(arch.entityIds[i], x[i]);
  }),
});
ecs.addSystems(SCHEDULE.UPDATE, writer, { system: sync, ordering: { after: [writer] } });
```

`changed()` composes — `ecs.query(Pos).changed(Pos).without(Dead)` works, order-independently.

### Know the first-run and granularity traps

A system's last-run tick is 0 until it runs once, so on the **first dispatch** every non-empty matching archetype looks changed and a `changed()` query fires for everything. If that's not what you want, guard on `ctx.lastRunTick === 0`.

**Granularity is per archetype, not per row.** If one entity in a 1000-row archetype writes `Pos`, the whole archetype trips as changed and the query hands you all 1000 rows. `changed()` tells you *which archetypes to look at*, not *which rows changed*.

Also: **archetype transitions stamp the destination for every component on it** — a watcher on `changed(Pos)` fires when an entity gains `Frozen`, if both archetypes include `Pos`. If you must distinguish "field write" from "transition arrival", track it explicitly.

### Resources aren't tick-tracked

`ctx.setResource` writes to a plain map with no versioning; `changed()` can't observe it. If a system must react to a resource change, emit an event alongside the write, or keep a version counter inside the resource value.

---

## 10. Observers

An observer is the push-based counterpart to polling with `changed()`: register once, get called at the right moment. Reach for it when you'd otherwise poll every frame, or when you need **per-entity** precision that `changed()`'s archetype granularity can't give.

```ts
const handle = ecs.observe(Health, {
  access: { reads: [Health], writes: [], spawns: [[Corpse]] },  // callbacks run in an access span
  onRemove: (eid, ctx) => ctx.commands.spawn(Corpse()),
});
handle.dispose();   // idempotent
```

Choose the grain deliberately:

- **`onAdd` / `onRemove` / `onDisable` / `onEnable`** fire at the structural-flush boundary, after the batch commits, looping to a fixed point so cascades settle.
- **`onSet` archetype-granular** (the default) reuses the free change tick — `(arch, ctx)` per changed archetype-column; you iterate the rows.
- **`onSet` entity-granular** (`granularity: "entity"`) gives `(eid, ctx)` per changed entity, but **registering it turns on per-row dirty tracking** for that component — a write-path cost. Pick it only when changes are sparse enough that per-entity precision beats sweeping the archetype.

> [!WARNING]
> **Declare `access`** — callbacks run in an access span, and the declarations also drive firing order, so a wrong one can silently reorder the observer. **Register observers before `startup()`** so the archetypes they spawn into are prewarmed. **Only deferred, in-schedule ops fire *structural* observers** (`onAdd`/`onRemove`/`onEnable`/`onDisable` drain at the flush) — an immediate host-side `ecs.addComponent` / `ecs.disable` fires none of them; only the deferred `ctx.commands.add` / `ctx.commands.disable` do. `onSet` is the exception: it is *derived* change detection (change ticks + the dirty list, scanned at the post-update detection point), so it is receiver-blind — a host-side `ecs.setField` between frames is seen by `onSet` observers on the next `update()` exactly like `ctx.setField`. And **do not emit events from `onSet`** — it runs at the tick tail where events are about to be cleared (throws `OBSERVER_ONSET_EMIT` in dev); bridge a detected change to a next-tick event from a normal system reading the dirty list.

If you write a component through the **raw** mutable column (not `setField`/`ref`), an entity-granular `onSet` won't see it unless you call `ctx.markChanged(entity, def)` in the loop.

---

## 11. Entity lifecycle

### Handles are packed integers, not pointers

An `EntityID` packs `[generation:11][index:20]`. Destroying an entity bumps the slot's generation (or retires the slot), so a stale handle fails `isAlive`. In dev, a stale handle to `getField`/`ref`/`addComponent`/etc. throws `ENTITY_NOT_ALIVE`; in production those guards are gone, so a dead handle silently targets whatever now lives in the (possibly-recycled) slot.

### Revalidate handles stored across frames

Entity ids held in events, closures, resources, or plain variables must be re-checked with `isAlive` before use:

```ts
if (ecs.isAlive(target)) {
  const hp = ctx.getField(target, Health, "current");
  ctx.setField(target, Health, "current", hp - damage);
}
```

Ids obtained inside `forEach`/`eachChunk`/`forEachEntity` are implicitly alive for that callback — iteration never yields dead rows.

### Disable to hide, destroy to remove

`disable` hides an entity from queries **without** removing its data or changing its id — it sits in the disabled tail of its archetype (a single row swap, no transition), and query iteration / the archetype's `entityCount` exclude it (the world-level `ecs.entityCount` counts alive entities, so it still includes disabled ones). Prefer it over destroy-and-respawn for entities that toggle in and out of play (a pooled bullet, a paused unit); re-include them with `.includeDisabled()`. A disabled entity must hold at least one component. Note that an *immediate* `ecs.disable`/`ecs.enable` fires no observer — only the deferred `ctx.commands.disable`/`ctx.commands.enable` do.

### Templates for bulk spawns

A template resolves a component set + defaults to a target archetype **once**, so every later spawn skips the per-component transitions and lands directly in the archetype:

```ts
const Bullet = ecs.template([{ def: Pos, values: { x: 0, y: 0 } }, { def: Vel, values: { vx: 0, vy: 0 } }]);
const b = ecs.spawn(Bullet, { x: 5, y: 10 });   // per-field overrides
const swarm = ecs.spawnMany(Bullet, 500);          // O(columns) writes, not O(500 × columns)
```

Templates pay off for multi-component and bulk spawns (and prewarm their archetypes — required before restoring a snapshot with `ecs.snapshots.restore`). A single-component template is no faster than `spawn()` + `addComponent()`.

---

## 12. Relations

Relations link two entities as a `(relation, target)` pair — hierarchies, ownership, targeting, instance-of. They're built on sparse storage, so they cause no archetype transition, consume no dense-identity bit, and all relation ops are **immediate**.

```ts
import { registerChildOf } from "@oasys/oecs";
const ChildOf = registerChildOf(ecs);        // built-in preset, a free function
ecs.relations.add(child, ChildOf, parent);
ecs.relations.targetOf(child, ChildOf);                 // parent
ecs.relations.sourcesOf(parent, ChildOf);               // [child, …] — the reverse "who points at me"
```

- **Exclusive by default** (one target per source; a new `ecs.relations.add` silently replaces the old target). Pass `{ multi: true }` for a target *set*; use `targetsOf` for multi, `targetOf` for exclusive (it throws on a multi relation in dev).
- **Compose into queries** with `withRelation`/`withoutRelation` (the `(R, *)` term) and iterate with `forEachEntity`; `forEachRelatedTo(target, cb)` is the `(*, T)` wildcard. Wildcard queries need authorization: `relationReads: [R]`, or `[ANY_RELATION]` for `forEachRelatedTo`.
- **Traverse** exclusive chains with `ancestorsOf` / `rootOf` / `cascadeOf` (a cycle throws `RELATION_CYCLE` in dev, never a hang).

> [!CAUTION]
> **`registerChildOf` defaults to a cascading destroy** (`onDeleteTarget: "delete"`) — destroy a parent and the whole subtree goes with it. Pass `{ onDeleteTarget: "clear" }` to let children survive as new roots, or `"orphan"` to leave a dangling `targetOf`. `registerIsA` defaults to `"clear"` and records the link only — **there is no component inheritance**.

> [!WARNING]
> **`orphan` leaks the reverse index** — a destroyed target's reverse entries linger until each source re-targets or dies, and `targetOf` returns a *dead handle* rather than `undefined`. Call `ecs.relations.compact()` at scene/snapshot boundaries to reclaim them; it changes no observable state and doesn't affect `stateHash`.

---

## 13. Events vs signals

Events and signals share one lifecycle — emit during one `update()`, visible to every later system in that call, cleared before the next. The difference is payload:

```ts
import { eventKey, signalKey, type EntityID } from "@oasys/oecs";

// Structured event — you need per-emit data:
export const Damage = eventKey<{ target: EntityID; amount: number }>("Damage");
ecs.events.register(Damage, ["target", "amount"]);
ctx.emit(Damage, { target: e, amount: 50 });
const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) applyDamage(dmg.target[i], dmg.amount[i]);

// Signal — you only need "did this happen":
export const OnPause = signalKey("OnPause");
ecs.events.registerSignal(OnPause);
ctx.emit(OnPause);
if (ctx.read(OnPause).length > 0) { /* paused */ }
```

Branded number fields (like `EntityID`) round-trip through the reader with no cast. Events live exactly one frame — for durable state use a resource or a component, not an event you re-emit. Don't emit from an `onSet` observer (see [§10](#10-observers)).

---

## 14. Resources

Resources are the right home for frame- or world-scoped singletons: time/delta, input snapshots, camera transforms, config, an RNG seed. Mint the key at module scope, register with an initial value, read/write anywhere.

```ts
const advanceTime = ecs.registerSystem({
  reads: [], writes: [], resourceReads: [Time], resourceWrites: [Time],
  fn: (ctx, dt) => { const t = ctx.resource(Time); t.delta = dt; t.elapsed += dt; },
});
```

Inside a system, resource access is declared and checked (`resourceReads` / `resourceWrites`). Resources return the same reference on every read — mutate an object resource through `ctx.resource(key)` and use `ctx.setResource` only to swap the whole value. `ctx.removeResource` frees the key for re-registration and fails closed on a missing key.

When they're the *wrong* tool: per-entity data (use components — resources aren't filterable, iterable, or tick-tracked), or a fake singleton entity carrying a `GlobalState` component. And resources are **excluded from `stateHash` and snapshot/restore** — sim-affecting state you need to reproduce must live in a component or be re-seeded after restore.

---

## 15. Determinism

Determinism is opt-in (`new ECS({ deterministic: true })`) because it costs a little — canonical ordering and an integer-only column rule — and buys lockstep multiplayer, replay, deterministic debugging, and save/load. The flag gates `stateHash`, `capture`/`restore`, and the sparse variants `captureSparse`/`restoreSparse` (each throws `DETERMINISM_DISABLED` when off).

If you need it:

- **Use integer columns.** Float columns are rejected at registration (`NON_DETERMINISTIC_COLUMN_TYPE`) because IEEE-754 rounds differently across engines. Since the array shorthand defaults to `"f64"`, pass an explicit integer type — `ecs.registerComponent(["x", "y"], "i32")` — and represent fractions as fixed-point.
- **Seed RNG deterministically** and store its state in a component; keep all non-lockstep input (wall-clock, network jitter) out of column bytes.
- **Compare `stateHash` only at a tick boundary** (between `update()` calls) or a `phaseBoundary` settle point (a `FrameTraceSink` hook attached via `ecs.setTrace`, not a callable API — and note the POST_UPDATE boundary fires before the tick-tail `onSet` dispatch and event clear, so its hash can differ from the per-tick hash). The digest is opaque — never compare it against a hard-coded literal.
- **Size both instances identically** before `ecs.snapshots.restore` and register the same components/templates in the same order; restore validates completely and fails closed before touching live state, but only if the target's archetype set and entity-index capacity match. Re-seed resources after a restore (they aren't captured).

Because every host/UI mutation crosses one apply chokepoint, `replayCommandLog(..., { hash: true })` returns the per-tick `stateHash` sequence — replaying the same log must reproduce it, and that equality *is* the fidelity check.

---

## 16. The host-write seam and editor

Writes that originate **outside** the schedule — a UI, editor, network handler, or worker — must not touch the ECS mid-frame. The seam turns every outside write into a typed command applied at one blessed point.

```ts
import { SCHEDULE, installHostCommandSeam, spawnEntry } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);   // BEFORE your systems and startup()
ecs.addSystems(SCHEDULE.UPDATE, move);       // schedule your systems after installing the seam
ecs.startup();

queue.addComponent(entity, Health, { hp: 100 });
queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (id) => console.log("spawned", id));
ecs.update(1 / 60);   // the apply system drains the queue at PRE_UPDATE
```

> [!WARNING]
> Install the seam **before** adding your own systems and **before `startup()`** — insertion order is what places the apply system at the phase head. `spawnEntry` values are typed as **complete** `FieldValues<S>`; pass every field even though the shared write path zero-fills omitted fields in untyped command data. And **don't add-then-set in the same frame**: `setField` applies immediately at the drain while structural commands are deferred to the phase flush, so `addComponent(e, C)` then `setField(e, C, …)` fails — carry the value in the `addComponent`/`spawnEntry`, or set it next frame. `onSpawned` is the only way to learn a spawned id.

The **editor** layer (`@oasys/oecs/editor`) adds undo/redo and two-way field handles on top of this queue — every edit is a transaction of forward + inverse commands, and undo is just another command on the same bus. Note that despawn → undo round-trips the *data* but re-spawns with a **fresh `EntityID`**; don't hold an old id across an undo of its despawn.

---

## 17. Memory sizing

The default needs no configuration — a growable heap `ArrayBuffer` capped at 256 MiB, no `SharedArrayBuffer`, no cross-origin isolation. Reach for the `memory` option only to size deliberately or switch backing.

```ts
new ECS();                                              // heap default
new ECS({ memory: { budget: { entities: 50_000 } } }); // size from an entity budget
new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });   // explicit byte cap
new ECS({ memory: { shared: {} } });                   // SharedArrayBuffer (workers / WASM)
```

> [!TIP]
> **`budget` is the arm to reach for** — give it an entity count and it derives column capacity, entity-index reservation, byte cap, and cap-error wording in your terms. `entities > 2^20` throws.

The byte cap is a **hard ceiling** — exceeding it throws `STORE_CAP_EXCEEDED` with no grow-beyond fallback. And because the entity-index region is reserved eagerly at construction (≈12 MiB at the default cap), an unreasonably small cap fails *at construction*, not later — size it to your actual peak. Inspect what `memory` resolved to via `ecs.memoryPlan` (it carries a human-readable `derivation` trace). The shared/WASM allocators live behind `@oasys/oecs/shared` and throw `SabUnavailableError` if `SharedArrayBuffer` is absent — serve cross-origin-isolated, or stay on heap (which needs neither).

---

## 18. The reactive UI seam

The ECS is framework-agnostic and never pulls a UI library. The reactive stack is three opt-in entry points that bridge ECS state into a reactive UI *without* re-rendering everything each frame: `@oasys/oecs/reactive` (the signals kernel), `@oasys/oecs/reactive-sync` (the ECS → reactive bridge, publishing only dirty entities/columns), and `@oasys/oecs/solid` (the SolidJS adapter).

```ts
import { syncComponentToMap, shallow, batchedUpdate } from "@oasys/oecs/reactive-sync";

const positions = syncComponentToMap(ecs, Pos, (row) => ({ x: row.field("x"), y: row.field("y") }), { eq: shallow });
batchedUpdate(ecs, 1 / 60);   // = batch(() => ecs.update(dt)) — one tick, one coalesced UI flush
```

> [!WARNING]
> **Pass `eq: shallow` (or a scalar projection) for object values** — under the default `Object.is`, a projection that returns a fresh object each tick compares unequal every time and wakes every subscriber every frame. This is the single most common reactive-sync mistake. **Key a Solid `<For>` on the stable `EntityID`**, never on a per-tick value object.

Reading a *second* component inside a projection goes stale — use `syncJoinToMap`, which subscribes all defs. Wrap ticks in `batchedUpdate` so a whole frame's publishes coalesce into one UI flush.

---

## 19. Using type primitives directly

`BitSet`, `SparseSet`, `SparseMap<V>`, the `GrowableTypedArray` family, `BinaryHeap<T>`, and `topologicalSort` are exported from `@oasys/oecs/primitives`. These are the same primitives the ECS uses internally (archetype masks, sparse stores, columns, the scheduler ready queue). Reach for them when:

- you need an O(1) integer-keyed set (entities seen this frame) — `SparseSet`;
- a priority queue (A*, an event timeline) — `BinaryHeap<T>` with a `CompareFn<T>`;
- a growable numeric buffer to hand to WebGL/WebGPU or batch-copy with `TypedArray.set()` — `GrowableFloat32Array` / `GrowableInt32Array` / etc.;
- a dense bitmask with `contains` / `overlaps` — `BitSet`.

`buf`/`view()` on a growable array are invalidated by any append that triggers a grow — re-fetch after appending, don't cache across.

---

## 20. Testing

`src/core/ecs/__tests__/` is the canonical usage reference. It's organized as:

- `integration/` — each file exercises one subsystem end-to-end against a real `ECS` (`query.test.ts`, `change_detection.test.ts`, `commands.test.ts`, `each_chunk.test.ts`, `observers.test.ts`, `relations*.test.ts`, `sparse_query.test.ts`, `run_condition.test.ts`, `bundles.test.ts`, …).
- `unit/` — focused mechanics (`archetype.test.ts`, `store_state_hash.test.ts`, `host_commands.test.ts`, `command_log.test.ts`, `deterministic_column_guard.test.ts`, `disable.test.ts`, `template.test.ts`, `world_resume.test.ts`, …).
- `limits/` — scale and soak (`entity_scale.test.ts`, `component_count_cap.test.ts`, `lifecycle_soak.test.ts`, …).
- `breakage/` — the invariants that must not regress (`destroy_mid_iteration.test.ts`, `structural_mid_system.test.ts`, `deferred_ordering.test.ts`, `query_cache_coherence.test.ts`, …).

Prefer integration-style tests for your own code: construct a world, register what you need, drive `ecs.update(dt)`, and assert on observable state. Mocking `SystemContext` or the store fossilises internals and misses the cross-subsystem bugs that actually bite — flush ordering, change-tick propagation, ref invalidation after transitions, observer firing order. The API is cheap enough to stand up in a test. When a test fails, read the matching integration test for that subsystem; if the invariant you're relying on isn't asserted there, it may not exist.

---

## 21. Anti-patterns

**Iterating past `arch.entityCount`.** Columns are backed by doubling buffers whose raw `.length` exceeds the live count and spans disabled rows — always loop to `arch.entityCount` (or use `eachChunk`'s `count`). Hoist `arch.getColumnRead(...)` once per archetype; the reference is stable for the callback but not across frames.

**Using `cols.mut` / `ctx.ref` when you're only reading.** Both stamp the change tick at acquisition, before any write — a read-through-mutable wakes every `changed()` observer for nothing. Use `cols.read` / `ctx.refRead`.

**Casting `ReadonlyColumn` / `ReadonlyComponentRef` to write.** The readonly marker is how the compiler enforces "this system only reads Pos" so `changed(Pos)` observers stay correct — and a cast-write skips the tick bump, silently desyncing change detection. Mutate through `eachChunk` or `ctx.ref` at the point of mutation.

**Calling immediate `ecs.*` structural ops from inside a system.** `ecs.addComponent` / `ecs.disable` bypass the deferred buffer and can shuffle archetype membership mid-iteration. Inside a system, use `ctx.commands`.

**Add-then-set across the host seam in one frame.** `setField` drains immediately, structural commands defer to the phase flush — carry values in the `addComponent`/`spawnEntry`, or set next frame.

**Storing refs in plain objects.** A ref caches the entity's row location (archetype + row) and reads the columns live; the next `addComponent`/`despawn` can move the entity out from under that cached location. Rebuild refs each frame — it's near-free.

**Using resources or a `Map<EntityID, …>` as per-entity storage.** That re-implements component storage, poorly — you lose archetype co-location, query filtering, SoA iteration, change detection, and you orphan destroyed entities. If it's per-entity, it's a component (or a sparse component).

**Emitting an event from an `onSet` observer.** It runs at the tick tail where events are about to be cleared — the emission is dropped and breaks snapshot determinism (throws in dev). Bridge to a next-tick event from a normal system.

**Float columns on a deterministic ECS.** Rejected at registration — use integers and fixed-point.

**Registering a churny or rarely-present component as dense.** Every add/remove copies the whole payload row and burns one of the 128 identity bits. Use sparse storage.
