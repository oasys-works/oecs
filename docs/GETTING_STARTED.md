# Getting Started

oecs is an archetype-based TypeScript ECS. Components are typed-array columns grouped by archetype; systems are plain functions that declare the component data they read and write, scheduled across lifecycle phases. This guide builds a small simulation end-to-end — components, resources, events, systems, scheduling, and change detection.

## 1. Install

```bash
pnpm add @oasys/oecs
```

## 2. Create a World

The `ECS` class (the "world") is the single entry point. It owns every entity, component, system, resource, and event channel.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const ecs = new ECS({
  fixedTimestep: 1 / 60,   // FIXED_UPDATE rate (default 1/60)
  maxFixedSteps: 4,        // cap fixed steps per update() to avoid spiral of death
  memory: { columnCapacity: 1024 },   // per-archetype initial column capacity
});
```

All options are optional — `new ECS()` uses sensible defaults.

## 3. Define Components

Each field maps to a dedicated typed-array column for cache-friendly iteration.

```ts
// Record syntax — per-field type control
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Health = ecs.registerComponent({ current: "i32", max: "i32" });

// Array shorthand — uniform type, defaults to "f64"
const Vel = ecs.registerComponent(["vx", "vy"] as const);

// Override the uniform type
const Flags = ecs.registerComponent(["a", "b"] as const, "u8");

// Tag — empty schema, participates in queries but stores no data
const IsEnemy = ecs.registerTag();
const Dead = ecs.registerTag();
```

Supported tags: `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, `"u32"`. `as const` on the array shorthand is required — without it TypeScript widens to `string[]` and per-field types are lost.

## 4. Define Resources

Resources are world-scoped singletons — time, input, configs, asset tables. Values can be any type: plain objects, `Map`, typed arrays, class instances. Keys are defined at module scope with `resourceKey<T>(name)` and registered once on the ecs.

```ts
import { resourceKey } from "@oasys/oecs";

const Time = resourceKey<{ delta: number; elapsed: number }>("Time");
const Score = resourceKey<{ value: number }>("Score");

ecs.resources.register(Time, { delta: 0, elapsed: 0 });
ecs.resources.register(Score, { value: 0 });

const time = ecs.resources.get(Time);           // { delta: number; elapsed: number }
ecs.resources.set(Score, { value: 100 });
ecs.resources.has(Time);                    // true
```

`registerResource` returns `void` — the key is the handle. Each key must be registered exactly once.

## 5. Define Events and Signals

Events are fire-and-forget messages that systems emit within a frame and other systems read in the same frame; they clear automatically at the end of every `ecs.update(dt)`. Use `eventKey<S>(name)` for data events — `S` is a **field → value-type record**, not a tuple of names — and `signalKey(name)` for zero-field signals, then register each key once with its field list.

```ts
import { eventKey, signalKey, type EntityID } from "@oasys/oecs";

// Schema is a record of field → value type; carrying the value type means
// branded fields (like EntityID) round-trip their brand through emit / read.
const DamageEvent = eventKey<{ target: EntityID; amount: number }>("Damage");
ecs.events.register(DamageEvent, ["target", "amount"]);   // field list defines column order

const GameOver = signalKey("GameOver");
ecs.events.registerSignal(GameOver);

ecs.events.emit(DamageEvent, { target: 42 as EntityID, amount: 10 });
ecs.events.emit(GameOver);

const dmg = ecs.events.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const t = dmg.target[i];   // typed EntityID — the brand survives emit → read
  const a = dmg.amount[i];
}
```

Inside systems, use `ctx.emit` / `ctx.read` (section 10). Event field values are numbers (including branded numbers like `EntityID`) — for richer payloads, store them on a sentinel entity and reference it by ID.

## 6. Spawn Entities

```ts
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 400, y: 300 });
ecs.addComponent(player, Health, { current: 100, max: 100 });

// addComponents resolves the final archetype once — cheaper when attaching several components
const enemy = ecs.spawn();
ecs.addComponents(enemy, [
  { def: Pos, values: { x: 100, y: 100 } },
  { def: Vel, values: { vx: 50, vy: 30 } },
  { def: Health, values: { current: 50, max: 50 } },
  { def: IsEnemy },
]);
```

Remove with `removeComponent` / `removeComponents`, check with `hasComponent`, destroy via `ecs.despawn(e)` (immediate — the entity is dead on the next line; from inside a system use `ctx.commands.despawn(e)`, which defers to the phase flush).

## 7. Write Systems

Systems are plain functions. A system that reads or writes component data uses the **config form** and declares its access up front: `reads` and `writes` are validated by a dev-mode access checker (tree-shaken out of production), so an undeclared column touch *throws* in development. `registerSystem` always returns a `SystemDescriptor`.

### Config form (the one you'll use for real work)

Capture the query once at module scope with `ecs.query(...)` and reference it inside `fn` — the config `fn` is `(ctx, dt)` and does **not** receive the query. Cached queries stay live as new archetypes appear. The mutable hot-path iterator is `eachChunk` + `cols.mut`.

```ts
const movers = ecs.query(Pos, Vel).without(Dead);

const moveSys = ecs.registerSystem({
  name: "move",
  reads: [Vel],           // read-only components
  writes: [Pos],          // writable components — a declared write implies a read
  queries: [[Pos, Vel]],  // optional lint: must be a subset of reads ∪ writes
  fn: (_ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y }   = cols.mut(Pos);    // whole component group; stamps Pos's change tick once
      const { vx, vy } = cols.read(Vel);   // read-only group; no tick bump
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});
```

- `reads` / `writes` are **mandatory** — pass empty arrays to say "touches no columns" explicitly. A declared write also authorizes `addComponent` on that column.
- `cols.mut(def)` / `cols.read(def)` resolve a whole component's field columns into a destructurable group. `mut` stamps the change tick (once, when called); `read` doesn't. Always loop to `count`, never a column's `.length`.
- Resources, sparse storage, and relations have their own declaration fields (`resourceReads`/`resourceWrites`, `sparseReads`/…, `relationReads`/…). See [systems](api/systems.md) for the full `SystemConfig`.

### Read-only query form

For a pass that only reads, `q.forEach((arch) => …)` hands you a read-only `ArchetypeView` — read columns with `arch.getColumnRead(def, field)`; there is no mutable column accessor on the view. Still declare `reads`. `for (const arch of q)` does **not** work.

```ts
const withHealth = ecs.query(Health);

const reportSys = ecs.registerSystem({
  reads: [Health],
  writes: [],
  fn: () => {
    withHealth.forEach((arch) => {
      const hp = arch.getColumnRead(Health, "current");
      for (let i = 0; i < arch.entityCount; i++) { /* read hp[i] */ }
    });
  },
});
```

To write one entity at a time instead of per chunk, take a mutable ref with `ctx.ref(def, id)` (section 10) — it stamps the component's change tick.

### Bare / builder forms — no declared access

Two overloads register with **empty** access declarations, so any component or resource touch inside them throws in dev. Use them only for glue that touches no ECS data (for example, bumping an external counter).

```ts
// Bare (ctx, dt) — no query.
ecs.registerSystem((ctx, dt) => { frameCount++; });

// Function + query builder — query resolved once at registration.
ecs.registerSystem(
  (q, ctx, dt) => { q.forEach((arch) => { /* read-only, no ctx component access */ }); },
  (qb) => qb.with(Pos, Vel).without(Dead),
);
```

> **Arity trap.** A 3-parameter function with the `queryFn` argument forgotten silently binds `q := ctx`, `dt := undefined`, and `NaN`s your math. In dev this throws `SYSTEM_FN_ARITY`.

### Lifecycle hooks

The config form also carries lifecycle hooks. `onAdded` runs inside the system's access span, so its access is checked too — declare what it spawns.

```ts
const spawner = ecs.registerSystem({
  name: "spawner",
  reads: [], writes: [],
  spawns: [[Pos]],          // onAdded creates entities carrying Pos
  fn(ctx, _dt) { /* every frame */ },
  onAdded(ctx) {           // once, during ecs.startup()
    const e = ctx.commands.spawn();
    ctx.addComponent(e, Pos, { x: 0, y: 0 });
  },
  onRemoved() { /* ecs.removeSystem(...) */ },
  dispose()    { /* ecs.dispose() */ },
});
```

## 8. Schedule Systems

Assign systems to phases. Phases run in a fixed order; within a phase you can declare ordering constraints.

```ts
ecs.addSystems(SCHEDULE.STARTUP, spawner);
ecs.addSystems(SCHEDULE.PRE_UPDATE, tickTime);
ecs.addSystems(SCHEDULE.UPDATE, moveSys);
```

| Phase           | Runs in           | When                                         |
| --------------- | ----------------- | -------------------------------------------- |
| `PRE_STARTUP`   | `ecs.startup()` | Once, before `STARTUP`                       |
| `STARTUP`       | `ecs.startup()` | Once                                         |
| `POST_STARTUP`  | `ecs.startup()` | Once, after `STARTUP`                        |
| `FIXED_UPDATE`  | `ecs.update()`  | Zero or more times at `fixedTimestep`       |
| `PRE_UPDATE`    | `ecs.update()`  | Every frame, first                           |
| `UPDATE`        | `ecs.update()`  | Every frame                                  |
| `POST_UPDATE`   | `ecs.update()`  | Every frame, last                            |

After each phase, `ctx.flush()` runs automatically so the next phase sees a consistent store.

### Ordering

Pass a `SystemEntry` with `before` / `after` arrays of `SystemDescriptor`.

```ts
ecs.addSystems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: physicsSys, ordering: { after: [moveSys] } },
  { system: renderSys,  ordering: { after: [physicsSys] } },
);
```

A cycle inside a phase throws `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` on the first run. Ordering applies only within the same phase — use different labels to sequence across phases.

## 9. Run the Loop

```ts
ecs.startup();           // PRE_STARTUP → STARTUP → POST_STARTUP, once

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  ecs.update(dt);        // FIXED_UPDATE (0+) → PRE_UPDATE → UPDATE → POST_UPDATE
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 10. Working Inside Systems

Every system receives a shared `SystemContext` (`ctx`) with deferred structural operations, per-entity accessors, events, resources, and change-detection ticks.

### Deferred structural changes

Structural operations inside a system buffer until the phase flush, keeping iterators valid. A deferred destruction inside `forEach` is safe — the entity stays visible in the current iteration and is removed at the flush.

```ts
ctx.commands.spawn();                   // immediate (new entity, no components)
ctx.addComponent(e, Pos, { x, y });   // deferred
ctx.removeComponent(e, Vel);          // deferred
ctx.commands.despawn(e);                 // deferred
ctx.disable(e);                       // deferred
ctx.enable(e);                        // deferred
```

Prefer the `ctx.commands` facade for deferred structural ops — `ctx.commands.spawn(...)` / `add` / `remove` / `despawn` do the same deferred thing but read unambiguously as "deferred" at the call site, where the bare `ctx.addComponent` is one keystroke from the *immediate* `ecs.addComponent`.

### `ref` vs `refRead`

Use `ctx.ref` / `ctx.refRead` for dot-syntax access to a single entity's fields.

```ts
const pos = ctx.refRead(Pos, entity);   // ReadonlyComponentRef — reads only
const vel = ctx.ref(Vel, entity);      // ComponentRef — writable, stamps change tick
vel.vx += 1;
```

`ctx.refRead` does not touch the change tick. `ctx.ref` stamps the component's change tick at the current `ctx.ecsTick` when you take the ref, regardless of whether you write through it — reach for it only at the point of mutation. Refs are valid until the next phase flush; do not hold one across `ctx.flush()` or a structural change that moves the entity between archetypes.

### Events and resources

```ts
ctx.emit(DamageEvent, { target: id, amount: 25 });
ctx.emit(GameOver);

const dmg = ctx.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i];
  const amount = dmg.amount[i];
}

const t = ctx.resource(Time);            // live reference, mutate in place
t.delta = dt;
t.elapsed += dt;
ctx.setResource(Score, { value: 0 });   // or replace the whole value
```

Readers are zero-copy views — iterate up to `reader.length`, do not slice.

### Change detection

Two `SystemContext` fields drive change detection:

- `ctx.ecsTick` — the current store write tick; the tick stamped by writes (`cols.mut`, `ctx.ref`, `ctx.setField`).
- `ctx.lastRunTick` — the tick this system's most recent dispatch started (0 on first run).

`query.changed(...defs)` returns a read-only `ChangedQuery` that iterates only archetypes where one of the listed components was written at or after `ctx.lastRunTick`. Iterate it with `forEach`:

```ts
const moved = ecs.query(Pos).changed(Pos);

const detector = ecs.registerSystem({
  reads: [Pos],
  writes: [],
  fn: () => {
    moved.forEach((arch) => {
      // Only archetypes whose Pos column was stamped since this system last ran.
    });
  },
});
```

Every component passed to `.changed(...)` must be in the query's include mask. Ticks are per `(archetype, component)` — touching one row flags the whole archetype for that component.

## 11. Query Composition

Queries refine by chaining; each method returns a new (cached) query.

```ts
const alive     = ecs.query(Pos).and(Health);                    // include Pos AND Health
const active    = ecs.query(Pos).and(Health).without(Dead);          // exclude Dead
const afflicted = ecs.query(Health).anyOf(Poison, Fire);        // at least one of
const targets   = ecs.query(Pos).and(Health).without(Shield).anyOf(IsEnemy, IsBoss);
```

Inside `registerSystem`, use `qb.with(...)` and chain the same way: `(qb) => qb.with(Pos, Vel).without(Dead)`. Identical filter sets resolve to the same cached `Query` instance, so `ecs.query(...)` is cheap ad-hoc.

## 12. Complete Example

Entities move, a damage handler applies HP deltas from queued events, a death system tags corpses, cleanup destroys them, and a `ChangedQuery` counts archetypes that moved this frame.

```ts
import {
  ECS,
  SCHEDULE,
  eventKey,
  resourceKey,
  type EntityID,
} from "@oasys/oecs";

const ecs = new ECS();

// --- Components ---
const Pos    = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel    = ecs.registerComponent(["vx", "vy"] as const);
const Health = ecs.registerComponent({ current: "i32", max: "i32" });
const Dead   = ecs.registerTag();

// --- Resource ---
const Time = resourceKey<{ delta: number; elapsed: number }>("Time");
ecs.resources.register(Time, { delta: 0, elapsed: 0 });

// --- Event ---
const Hit = eventKey<{ target: EntityID; damage: number }>("Hit");
ecs.events.register(Hit, ["target", "damage"]);

// --- Queries (captured once at module scope, live-updated) ---
const movers     = ecs.query(Pos, Vel).without(Dead);
const movedPos    = ecs.query(Pos).changed(Pos);
const withHealth  = ecs.query(Health).without(Dead);
const corpses     = ecs.query(Dead);

// --- Systems ---
const tickTime = ecs.registerSystem({
  name: "tickTime",
  reads: [], writes: [],
  resourceWrites: [Time],
  fn: (ctx, dt) => {
    const t = ctx.resource(Time);
    t.delta = dt;
    t.elapsed += dt;
  },
});

const moveSys = ecs.registerSystem({
  name: "move",
  reads: [Vel], writes: [Pos],
  fn: (_ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y }   = cols.mut(Pos);
      const { vx, vy } = cols.read(Vel);
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});

// Change-detection observer: count archetypes whose Pos moved this frame.
let movedArchetypesThisFrame = 0;
const observeMoved = ecs.registerSystem({
  name: "observeMoved",
  reads: [Pos], writes: [],
  fn: () => {
    movedArchetypesThisFrame = 0;
    movedPos.forEach(() => { movedArchetypesThisFrame++; });
  },
});

// Apply queued damage events via a mutable ref.
const applyDamage = ecs.registerSystem({
  name: "applyDamage",
  reads: [], writes: [Health],
  fn: (ctx) => {
    const hits = ctx.read(Hit);
    for (let i = 0; i < hits.length; i++) {
      const target = hits.target[i];
      if (!ctx.isAlive(target)) continue;     // guard stale handles
      const h = ctx.ref(Health, target);
      h.current -= hits.damage[i];
    }
  },
});

// Tag anything with hp <= 0 as Dead (deferred).
const markDead = ecs.registerSystem({
  name: "markDead",
  reads: [Health], writes: [Dead],   // writing Dead authorizes ctx.commands.add(_, Dead)
  fn: (ctx) => {
    withHealth.forEach((arch) => {
      const ids = arch.entityIds;
      const hp = arch.getColumnRead(Health, "current");
      for (let i = 0; i < arch.entityCount; i++) {
        if (hp[i] <= 0) ctx.commands.add(ids[i] as EntityID, Dead);
      }
    });
  },
});

// Deferred destruction of anything tagged Dead.
const cleanupDead = ecs.registerSystem({
  name: "cleanupDead",
  reads: [], writes: [],
  despawns: [Pos, Vel, Health, Dead],   // despawn removes every component — declare the superset
  fn: (ctx) => {
    corpses.forEach((arch) => {
      const ids = arch.entityIds;
      for (let i = 0; i < arch.entityCount; i++) {
        ctx.commands.despawn(ids[i] as EntityID);
      }
    });
  },
});

// --- Schedule ---
ecs.addSystems(SCHEDULE.PRE_UPDATE, tickTime);
ecs.addSystems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: observeMoved, ordering: { after: [moveSys] } },
  { system: applyDamage,  ordering: { after: [moveSys] } },
  { system: markDead,     ordering: { after: [applyDamage] } },
);
ecs.addSystems(SCHEDULE.POST_UPDATE, cleanupDead);

// --- Spawn ---
let first: EntityID = 0 as EntityID;
for (let i = 0; i < 100; i++) {
  const e = ecs.spawn();
  ecs.addComponents(e, [
    { def: Pos,    values: { x: Math.random() * 800, y: Math.random() * 600 } },
    { def: Vel,    values: { vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100 } },
    { def: Health, values: { current: 100, max: 100 } },
  ]);
  if (i === 0) first = e;
}

// Queue a damage event; readable on the first update() call.
ecs.events.emit(Hit, { target: first, damage: 40 });

// --- Run ---
ecs.startup();
ecs.update(1 / 60);
ecs.update(1 / 60);

console.log("moved archetypes:", movedArchetypesThisFrame);
console.log("alive entities:", ecs.entityCount);
```

## 13. Next Steps

- [Components](api/components.md), [Entities](api/entities.md), [Queries](api/queries.md), [Refs](api/refs.md)
- [Events](api/events.md), [Resources](api/resources.md), [Systems](api/systems.md), [Schedule](api/schedule.md)
- [Change Detection](api/change-detection.md) — tick model, `ChangedQuery`, archetype granularity.
- [Architecture](ARCHITECTURE.md) — internal design: store, archetypes, query cache.
- [Best Practices](BEST_PRACTICES.md) — performance tips, common pitfalls, idioms.
