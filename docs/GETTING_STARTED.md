# Getting Started

oecs is an archetype-based TypeScript ECS. Components are typed-array columns grouped by archetype; systems are plain functions scheduled across lifecycle phases. This guide builds a small simulation end-to-end — components, resources, events, systems, scheduling, and change detection.

## 1. Install

```bash
pnpm add @oasys/oecs
```

## 2. Create a World

The `ECS` class (the "world") is the single entry point. It owns every entity, component, system, resource, and event channel.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const world = new ECS({
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
const Pos = world.registerComponent({ x: "f64", y: "f64" });
const Health = world.registerComponent({ current: "i32", max: "i32" });

// Array shorthand — uniform type, defaults to "f64"
const Vel = world.registerComponent(["vx", "vy"] as const);

// Override the uniform type
const Flags = world.registerComponent(["a", "b"] as const, "u8");

// Tag — empty schema, participates in queries but stores no data
const IsEnemy = world.registerTag();
const Dead = world.registerTag();
```

Supported tags: `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, `"u32"`. `as const` on the array shorthand is required — without it TypeScript widens to `string[]` and per-field types are lost.

## 4. Define Resources

Resources are world-scoped singletons — time, input, configs, asset tables. Values can be any type: plain objects, `Map`, typed arrays, class instances. Keys are defined at module scope with `resourceKey<T>(name)` and registered once on the world.

```ts
import { resourceKey } from "@oasys/oecs";

const Time = resourceKey<{ delta: number; elapsed: number }>("Time");
const Score = resourceKey<{ value: number }>("Score");

world.registerResource(Time, { delta: 0, elapsed: 0 });
world.registerResource(Score, { value: 0 });

const time = world.resource(Time);           // { delta: number; elapsed: number }
world.setResource(Score, { value: 100 });
world.hasResource(Time);                    // true
```

`registerResource` returns `void` — the key is the handle. Each key must be registered exactly once.

## 5. Define Events and Signals

Events are fire-and-forget messages that systems emit within a frame and other systems read in the same frame; they clear automatically at the end of every `world.update(dt)`. Use `eventKey<F>(name)` for data events and `signalKey(name)` for zero-field signals, then register each key once.

```ts
import { eventKey, signalKey } from "@oasys/oecs";

const DamageEvent = eventKey<readonly ["target", "amount"]>("Damage");
world.registerEvent(DamageEvent, ["target", "amount"] as const);

const GameOver = signalKey("GameOver");
world.registerSignal(GameOver);

world.emit(DamageEvent, { target: 42, amount: 10 });
world.emit(GameOver);

const dmg = world.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const t = dmg.target[i];
  const a = dmg.amount[i];
}
```

Inside systems, use `ctx.emit` / `ctx.read` (section 10). Event field values are numbers only — for richer payloads, store them on a sentinel entity and reference it by ID.

## 6. Spawn Entities

```ts
const player = world.createEntity();
world.addComponent(player, Pos, { x: 400, y: 300 });
world.addComponent(player, Health, { current: 100, max: 100 });

// addComponents walks the archetype graph once — cheaper when spawning
const enemy = world.createEntity();
world.addComponents(enemy, [
  { def: Pos, values: { x: 100, y: 100 } },
  { def: Vel, values: { vx: 50, vy: 30 } },
  { def: Health, values: { current: 50, max: 50 } },
  { def: IsEnemy },
]);
```

Remove with `removeComponent` / `removeComponents`, check with `hasComponent`, destroy via `world.destroyEntityDeferred(e)` (or `ctx.destroyEntity(e)` from a system).

## 7. Write Systems

Systems are plain functions. `registerSystem` has three forms and always returns a `SystemDescriptor`.

### With a query (most common)

The query is resolved once at registration. Use `qb.with(...)` to specify required components.

```ts
const moveSys = world.registerSystem(
  (q, ctx, dt) => {
    q.forEach((arch) => {
      const vx = arch.getColumnRead(Vel, "vx");
      const vy = arch.getColumnRead(Vel, "vy");
      const ids = arch.entityIds;
      for (let i = 0; i < arch.entityCount; i++) {
        const pos = ctx.ref(Pos, ids[i] as EntityID);
        pos.x += vx[i] * dt;
        pos.y += vy[i] * dt;
      }
    });
  },
  (qb) => qb.with(Pos, Vel),
);
```

- `q.forEach((arch) => ...)` iterates non-empty archetypes. `for (const arch of q)` does **not** work.
- Inside `forEach`, `arch` is a read-only `ArchetypeView`. Read columns with `arch.getColumnRead(def, field)`; there is no mutable column accessor on the view.
- To write, take a per-entity mutable ref with `ctx.ref(def, id)` and assign through it — that stamps the component's change tick.

### Bare function (no query)

For systems that only touch resources, events, or side effects.

```ts
const tickTime = world.registerSystem((ctx, dt) => {
  const t = ctx.resource(Time);
  t.delta = dt;
  t.elapsed += dt;
});
```

### Full config (lifecycle hooks)

```ts
const spawner = world.registerSystem({
  name: "spawner",
  fn(ctx, _dt) { /* every frame */ },
  onAdded(ctx) {           // once, during world.startup()
    const e = ctx.createEntity();
    ctx.addComponent(e, Pos, { x: 0, y: 0 });
  },
  onRemoved() { /* world.removeSystem(...) */ },
  dispose()    { /* world.dispose() */ },
});
```

## 8. Schedule Systems

Assign systems to phases. Phases run in a fixed order; within a phase you can declare ordering constraints.

```ts
world.addSystems(SCHEDULE.STARTUP, spawner);
world.addSystems(SCHEDULE.PRE_UPDATE, tickTime);
world.addSystems(SCHEDULE.UPDATE, moveSys);
```

| Phase           | Runs in           | When                                         |
| --------------- | ----------------- | -------------------------------------------- |
| `PRE_STARTUP`   | `world.startup()` | Once, before `STARTUP`                       |
| `STARTUP`       | `world.startup()` | Once                                         |
| `POST_STARTUP`  | `world.startup()` | Once, after `STARTUP`                        |
| `FIXED_UPDATE`  | `world.update()`  | Zero or more times at `fixedTimestep`       |
| `PRE_UPDATE`    | `world.update()`  | Every frame, first                           |
| `UPDATE`        | `world.update()`  | Every frame                                  |
| `POST_UPDATE`   | `world.update()`  | Every frame, last                            |

After each phase, `ctx.flush()` runs automatically so the next phase sees a consistent store.

### Ordering

Pass a `SystemEntry` with `before` / `after` arrays of `SystemDescriptor`.

```ts
world.addSystems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: physicsSys, ordering: { after: [moveSys] } },
  { system: renderSys,  ordering: { after: [physicsSys] } },
);
```

A cycle inside a phase throws `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` on the first run. Ordering applies only within the same phase — use different labels to sequence across phases.

## 9. Run the Loop

```ts
world.startup();           // PRE_STARTUP → STARTUP → POST_STARTUP, once

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  world.update(dt);        // FIXED_UPDATE (0+) → PRE_UPDATE → UPDATE → POST_UPDATE
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 10. Working Inside Systems

Every system receives a shared `SystemContext` (`ctx`) with deferred structural operations, per-entity accessors, events, resources, and change-detection ticks.

### Deferred structural changes

Structural operations inside a system buffer until the phase flush, keeping iterators valid. A deferred destruction inside `forEach` is safe — the entity stays visible in the current iteration and is removed at the flush.

```ts
ctx.createEntity();                   // immediate (new entity, no components)
ctx.addComponent(e, Pos, { x, y });   // deferred
ctx.removeComponent(e, Vel);          // deferred
ctx.destroyEntity(e);                 // deferred
```

### `ref` vs `refRead`

Use `ctx.ref` / `ctx.refRead` for dot-syntax access to a single entity's fields.

```ts
const pos = ctx.refRead(Pos, entity);   // ReadonlyComponentRef — reads only
const vel = ctx.ref(Vel, entity);      // ComponentRef — writable, stamps change tick
vel.vx += 1;
```

`ctx.refRead` does not touch the change tick. `ctx.ref` stamps `_changedTick[def] = worldTick` at creation, regardless of whether you write through it — reach for it only at the point of mutation. Refs are valid until the next phase flush; do not hold one across `ctx.flush()` or a structural change that moves the entity between archetypes.

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

Two `SystemContext` fields:

- `ctx.worldTick` — current world tick; the tick stamped by writes (e.g. `ctx.ref` mutations).
- `ctx.lastRunTick` — the tick this system's most recent dispatch started (0 on first run).

`q.changed(...defs)` iterates only archetypes where one of the listed components was written at or after `ctx.lastRunTick`:

```ts
const detector = world.registerSystem(
  (q, _ctx, _dt) => {
    q.changed(Pos).forEach((arch) => {
      // Only archetypes whose Pos column was stamped since this system last ran.
    });
  },
  (qb) => qb.with(Pos),
);
```

Every component passed to `.changed(...)` must be in the query's include mask. Ticks are per `(archetype, component)` — touching one row flags the whole archetype for that component.

## 11. Query Composition

Queries refine by chaining; each method returns a new (cached) query.

```ts
const alive     = world.query(Pos).and(Health);                    // include Pos AND Health
const active    = world.query(Pos).and(Health).without(Dead);          // exclude Dead
const afflicted = world.query(Health).anyOf(Poison, Fire);        // at least one of
const targets   = world.query(Pos).and(Health).without(Shield).anyOf(IsEnemy, IsBoss);
```

Inside `registerSystem`, use `qb.with(...)` and chain the same way: `(qb) => qb.with(Pos, Vel).without(Dead)`. Identical filter sets resolve to the same cached `Query` instance, so `world.query(...)` is cheap ad-hoc.

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

const world = new ECS();

// --- Components ---
const Pos    = world.registerComponent({ x: "f64", y: "f64" });
const Vel    = world.registerComponent(["vx", "vy"] as const);
const Health = world.registerComponent({ current: "i32", max: "i32" });
const Dead   = world.registerTag();

// --- Resource ---
const Time = resourceKey<{ delta: number; elapsed: number }>("Time");
world.registerResource(Time, { delta: 0, elapsed: 0 });

// --- Event ---
const Hit = eventKey<readonly ["target", "damage"]>("Hit");
world.registerEvent(Hit, ["target", "damage"] as const);

// --- Systems ---
const tickTime = world.registerSystem((ctx, dt) => {
  const t = ctx.resource(Time);
  t.delta = dt;
  t.elapsed += dt;
});

const moveSys = world.registerSystem(
  (q, ctx, dt) => {
    q.forEach((arch) => {
      const vx = arch.getColumnRead(Vel, "vx");
      const vy = arch.getColumnRead(Vel, "vy");
      const ids = arch.entityIds;
      for (let i = 0; i < arch.entityCount; i++) {
        const pos = ctx.ref(Pos, ids[i] as EntityID);
        pos.x += vx[i] * dt;
        pos.y += vy[i] * dt;
      }
    });
  },
  (qb) => qb.with(Pos, Vel).without(Dead),
);

// Change-detection observer: count archetypes whose Pos moved this frame.
let movedArchetypesThisFrame = 0;
const observeMoved = world.registerSystem(
  (q, _ctx, _dt) => {
    movedArchetypesThisFrame = 0;
    q.changed(Pos).forEach(() => { movedArchetypesThisFrame++; });
  },
  (qb) => qb.with(Pos),
);

// Apply queued damage events via a mutable ref.
const applyDamage = world.registerSystem((ctx, _dt) => {
  const hits = ctx.read(Hit);
  for (let i = 0; i < hits.length; i++) {
    const target = hits.target[i] as EntityID;
    if (!world.isAlive(target)) continue;     // guard stale handles
    const h = ctx.ref(Health, target);
    h.current -= hits.damage[i];
  }
});

// Tag anything with hp <= 0 as Dead (deferred).
const markDead = world.registerSystem(
  (q, ctx, _dt) => {
    q.forEach((arch) => {
      const ids = arch.entityIds;
      const hp = arch.getColumnRead(Health, "current");
      for (let i = 0; i < arch.entityCount; i++) {
        if (hp[i] <= 0) ctx.addComponent(ids[i] as EntityID, Dead);
      }
    });
  },
  (qb) => qb.with(Health).without(Dead),
);

// Deferred destruction of anything tagged Dead.
const cleanupDead = world.registerSystem(
  (q, ctx, _dt) => {
    q.forEach((arch) => {
      const ids = arch.entityIds;
      for (let i = 0; i < arch.entityCount; i++) {
        ctx.destroyEntity(ids[i] as EntityID);
      }
    });
  },
  (qb) => qb.with(Dead),
);

// --- Schedule ---
world.addSystems(SCHEDULE.PRE_UPDATE, tickTime);
world.addSystems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: observeMoved, ordering: { after: [moveSys] } },
  { system: applyDamage,  ordering: { after: [moveSys] } },
  { system: markDead,     ordering: { after: [applyDamage] } },
);
world.addSystems(SCHEDULE.POST_UPDATE, cleanupDead);

// --- Spawn ---
let first: EntityID = 0 as EntityID;
for (let i = 0; i < 100; i++) {
  const e = world.createEntity();
  world.addComponents(e, [
    { def: Pos,    values: { x: Math.random() * 800, y: Math.random() * 600 } },
    { def: Vel,    values: { vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100 } },
    { def: Health, values: { current: 100, max: 100 } },
  ]);
  if (i === 0) first = e;
}

// Queue a damage event; readable on the first update() call.
world.emit(Hit, { target: first, damage: 40 });

// --- Run ---
world.startup();
world.update(1 / 60);
world.update(1 / 60);

console.log("moved archetypes:", movedArchetypesThisFrame);
console.log("alive entities:", world.entityCount);
```

## 13. Next Steps

- [Components](api/components.md), [Entities](api/entities.md), [Queries](api/queries.md), [Refs](api/refs.md)
- [Events](api/events.md), [Resources](api/resources.md), [Systems](api/systems.md), [Schedule](api/schedule.md)
- [Change Detection](api/change-detection.md) — tick model, `ChangedQuery`, archetype granularity.
- [Architecture](ARCHITECTURE.md) — internal design: store, archetypes, query cache.
- [Best Practices](BEST_PRACTICES.md) — performance tips, common pitfalls, idioms.
