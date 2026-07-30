# Getting started

oecs is an archetype-based ECS for TypeScript. A component is a set of typed-array columns, grouped
by archetype. A system is a plain function. It declares the component data that it reads and
writes, and the schedule runs it in one of the lifecycle phases. This guide builds a small
simulation from start to end: components, resources, events, systems, the schedule, and change
detection.

## 1. Install

```bash
pnpm add @oasys/oecs
```

## 2. Create a world

The `ECS` class, which this guide calls the "world", is the one entry point. It owns each entity,
component, system, resource, and event channel.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const ecs = new ECS({
  fixedTimestep: 1 / 60,   // the rate of FIXED_UPDATE (default 1/60)
  maxFixedSteps: 4,        // the limit on fixed steps in one update(), to prevent the spiral of death
  memory: { columnCapacity: 1024 },   // the initial column capacity of each archetype
});
```

Each option is optional. `new ECS()` uses good default values.

## 3. Define the components

Each field becomes its own typed-array column, which makes iteration use the cache well.

```ts
// Record syntax — you control the type of each field
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Health = ecs.registerComponent({ current: "i32", max: "i32" });

// Array shorthand — one type for each field, "f64" by default
const Vel = ecs.registerComponent(["vx", "vy"] as const);

// Change the type of the shorthand
const Flags = ecs.registerComponent(["a", "b"] as const, "u8");

// Tag — an empty schema; it is part of a query, but it stores no data
const IsEnemy = ecs.registerTag();
const Dead = ecs.registerTag();
```

The available tags are `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, and `"u32"`.
`as const` on the array shorthand is optional for a literal that you write in place, because the
overload uses a `const` type parameter and so keeps the type of each field in both conditions. It
is necessary only when you build the field list in a separate variable, which TypeScript otherwise
makes as general as `string[]`.

## 4. Define the resources

A resource is a value with the scope of the world: time, input, configuration, or an asset table.
The value can have any type: a plain object, a `Map`, a typed array, or an instance of a class.
Define each key at module scope with `resourceKey<T>(name)`, and register it one time on the ECS.

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

`ecs.resources.register` gives `void`, because the key is the handle. Register each key exactly one
time.

## 5. Define the events and the signals

An event is a send-and-forget message. A system emits it inside a frame, and other systems read it
in the same frame. The engine clears each event automatically at the end of each `ecs.update(dt)`.
Use `eventKey<S>(name)` for an event with data. `S` is a **record of field to value type**, and not
a tuple of names. Use `signalKey(name)` for a signal with no field. Then register each key one
time, with its list of fields.

```ts
import { eventKey, signalKey, type EntityID } from "@oasys/oecs";

// The schema is a record of field to value type. Because it carries the value type,
// a field with a brand, such as EntityID, keeps that brand through emit and read.
const DamageEvent = eventKey<{ target: EntityID; amount: number }>("Damage");
ecs.events.register(DamageEvent, ["target", "amount"]);   // the field list sets the column order

const GameOver = signalKey("GameOver");
ecs.events.registerSignal(GameOver);

ecs.events.emit(DamageEvent, { target: 42 as EntityID, amount: 10 });
ecs.events.emit(GameOver);

const dmg = ecs.events.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const t = dmg.target[i];   // a typed EntityID — the brand survives emit → read
  const a = dmg.amount[i];
}
```

In a system, use `ctx.emit` and `ctx.read` (section 10). The value of an event field is a number,
and this includes a number with a brand such as `EntityID`. For richer data, store it on an entity
that you keep for that purpose, and refer to that entity by its id.

## 6. Create the entities

```ts
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 400, y: 300 });
ecs.addComponent(player, Health, { current: 100, max: 100 });

// addComponents finds the final archetype one time — this costs less when you attach several components
const enemy = ecs.spawn();
ecs.addComponents(
  enemy,
  Pos({ x: 100, y: 100 }),
  Vel({ vx: 50, vy: 30 }),
  Health({ current: 50, max: 50 }),
  IsEnemy,
);
```

To remove components, use `removeComponent` or `removeComponents`. To test for a component, use
`hasComponent`. To destroy an entity, use `ecs.despawn(e)`, which is immediate: the entity is dead
on the next line. In a system, use `ctx.commands.despawn(e)`, which defers to the flush at the end
of the phase.

## 7. Write the systems

A system is a plain function. A system that reads or writes component data uses the **config form**,
and it declares its access at the start. A development-mode access checker holds you to `reads` and
`writes`, and the build tool removes that checker from a production build. So a touch of a column
that you did not declare *throws* while you develop. `registerSystem` always gives a
`SystemDescriptor`.

### The config form (the form for real work)

Capture the query one time at module scope with `ecs.query(...)`, then refer to it inside `fn`. The
`fn` of the config form is `(ctx, dt)`, and it does **not** receive the query. A cached query stays
live as new archetypes appear. The iteration function for the high-frequency loop that writes is
`eachChunk` with `cols.mut`.

```ts
const movers = ecs.query(Pos, Vel).without(Dead);

const moveSys = ecs.registerSystem({
  name: "move",
  reads: [Vel],           // read-only components
  writes: [Pos],          // writable components — a declared write also gives read access
  queries: [[Pos, Vel]],  // an optional check: this must be a subset of reads ∪ writes
  fn: (_ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y }   = cols.mut(Pos);    // the full component group; sets the change tick of Pos one time
      const { vx, vy } = cols.read(Vel);   // a read-only group; no change to the tick
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});
```

- `reads` and `writes` are **necessary**. Give empty arrays to say "this system touches no columns"
  explicitly. A declared write also authorizes `addComponent` on that column.
- `cols.mut(def)` and `cols.read(def)` resolve each field column of one component into a group that
  you can destructure. `mut` sets the change tick one time, when you call it. `read` does not. Always
  loop to `count`, and never to the `.length` of a column.
- Resources, sparse storage, and relations have their own declaration fields: `resourceReads` and
  `resourceWrites`, `sparseReads` and the equivalent, and `relationReads` and the equivalent. See
  [systems](api/systems.md) for the full `SystemConfig`.

### The form for a read-only query

For a pass that only reads, `q.forEach((arch) => …)` gives you a read-only `ArchetypeView`. Read a
column with `arch.getColumnRead(def, field)`. The view has no accessor for a mutable column. You
must still declare `reads`. `for (const arch of q)` does **not** operate.

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

To write one entity at a time, and not a full chunk, take a mutable ref with `ctx.ref(def, id)`
(section 10). It sets the change tick of the component.

### The bare and builder forms — no declared access

Two overloads register with **empty** access declarations. So each touch of a component or a
resource inside them throws while you develop. Use them only for connection code that touches no
ECS data, for example an increase to an external counter.

```ts
// Bare (ctx, dt) — no query.
ecs.registerSystem((ctx, dt) => { frameCount++; });

// A function with a query builder — the engine resolves the query one time, at registration.
ecs.registerSystem(
  (q, ctx, dt) => { q.forEach((arch) => { /* read-only, no component access through ctx */ }); },
  (qb) => qb.with(Pos, Vel).without(Dead),
);
```

> **A risk with the number of parameters.** A function with three parameters, and with the `queryFn`
> argument absent, binds `q` to `ctx` and `dt` to `undefined` with no signal, and your calculations
> then give `NaN`. In development this throws `SYSTEM_FN_ARITY`.

### The lifecycle hooks

The config form also carries the lifecycle hooks. `onAdded` runs inside the access span of the
system, so the engine checks its access also. Declare what it creates.

```ts
const spawner = ecs.registerSystem({
  name: "spawner",
  reads: [], writes: [],
  spawns: [[Pos]],          // onAdded creates entities that carry Pos
  fn(ctx, _dt) { /* each frame */ },
  onAdded(ctx) {           // one time, during ecs.startup()
    const e = ctx.commands.spawn();
    ctx.commands.add(e, Pos, { x: 0, y: 0 });
  },
  onRemoved() { /* ecs.removeSystem(...) */ },
  dispose()    { /* ecs.dispose() */ },
});
```

## 8. Put the systems in the schedule

Give each system to a phase. The phases run in a fixed order. Inside a phase, you can declare
constraints on the order.

```ts
ecs.addSystems(SCHEDULE.STARTUP, spawner);
ecs.addSystems(SCHEDULE.PRE_UPDATE, tickTime);
ecs.addSystems(SCHEDULE.UPDATE, moveSys);
```

| Phase           | Runs in           | When                                         |
| --------------- | ----------------- | -------------------------------------------- |
| `PRE_STARTUP`   | `ecs.startup()` | one time, before `STARTUP`                   |
| `STARTUP`       | `ecs.startup()` | one time                                     |
| `POST_STARTUP`  | `ecs.startup()` | one time, after `STARTUP`                    |
| `FIXED_UPDATE`  | `ecs.update()`  | zero times or more, at `fixedTimestep`       |
| `PRE_UPDATE`    | `ecs.update()`  | each frame, first                            |
| `UPDATE`        | `ecs.update()`  | each frame                                   |
| `POST_UPDATE`   | `ecs.update()`  | each frame, last                             |

After each phase, `ctx.flush()` runs automatically. So the next phase sees a consistent store.

### The order of the systems

Give a `SystemEntry` with `before` and `after` arrays of `SystemDescriptor` values.

```ts
ecs.addSystems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: physicsSys, ordering: { after: [moveSys] } },
  { system: renderSys,  ordering: { after: [physicsSys] } },
);
```

A cycle inside a phase throws `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` at the first run. An order
applies inside one phase only. To put systems in sequence across phases, use different phase
labels.

## 9. Run the loop

```ts
ecs.startup();           // PRE_STARTUP → STARTUP → POST_STARTUP, one time

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  ecs.update(dt);        // FIXED_UPDATE (0 or more) → PRE_UPDATE → UPDATE → POST_UPDATE
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 10. Work inside a system

Each system receives one `SystemContext` (`ctx`). It gives you the deferred structural operations,
the accessors for one entity, the events, the resources, and the ticks for change detection.

### Deferred structural changes

A structural operation inside a system stays in a buffer until the flush at the end of the phase.
So the iterators stay correct. A deferred destroy inside `forEach` is safe: the entity stays
visible in the current iteration, and the engine removes it at the flush.

```ts
ctx.commands.spawn();                     // the id is immediate; the component attaches are deferred
ctx.commands.add(e, Pos, { x, y });       // deferred — all values (checked at compile time)
ctx.commands.add(e, Pos({ x }));          // deferred — the bundle form; an absent field becomes zero
ctx.commands.remove(e, Vel);              // deferred
ctx.commands.despawn(e);                  // deferred
ctx.commands.disable(e);                  // deferred
ctx.commands.enable(e);                   // deferred
```

`ctx.commands` is the *only* deferred surface. Each structural operation inside a system goes
through it. So "on `ctx.commands`" and "deferred to the flush at the end of the phase" have the
same meaning. Data writes, which are `ctx.setField` and `ctx.ref`, stay immediate. They touch the
values in a column, and never the membership of an archetype.

### `ref` compared to `refRead`

Use `ctx.ref` and `ctx.refRead` to read and write the fields of one entity with dot syntax.

```ts
const pos = ctx.refRead(Pos, entity);   // ReadonlyComponentRef — reads only
const vel = ctx.ref(Vel, entity);      // ComponentRef — writable, and it sets the change tick
vel.vx += 1;
```

`ctx.refRead` does not touch the change tick. `ctx.ref` sets the change tick of the component to
the current `ctx.ecsTick` when you take the ref, and it does this whether or not you write through
the ref. So, take it only at the point where you mutate. A ref stays valid until the next flush
at the end of a phase. Do not hold one across `ctx.flush()`, or across a structural change that
moves the entity to a different archetype.

### Events and resources

```ts
ctx.emit(DamageEvent, { target: id, amount: 25 });
ctx.emit(GameOver);

const dmg = ctx.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i];
  const amount = dmg.amount[i];
}

const t = ctx.getResource(Time);         // a live reference; mutate it in place
t.delta = dt;
t.elapsed += dt;
ctx.setResource(Score, { value: 0 });   // or replace the full value
```

A reader is a view with no copy. Iterate to `reader.length`. Do not use `slice`.

### Change detection

Two fields of the `SystemContext` drive change detection:

- `ctx.ecsTick` — the current write tick of the store. This is the tick that a write sets:
  `cols.mut`, `ctx.ref`, and `ctx.setField`.
- `ctx.lastRunTick` — the tick at which the most recent dispatch of this system started. It is 0 at
  the first run.

`query.changed(...defs)` gives a read-only `ChangedQuery`. It iterates only the archetypes in which
the engine wrote one of the listed components at or after `ctx.lastRunTick`. Iterate it with
`forEach`:

```ts
const moved = ecs.query(Pos).changed(Pos);

const detector = ecs.registerSystem({
  reads: [Pos],
  writes: [],
  fn: () => {
    moved.forEach((arch) => {
      // Only the archetypes whose Pos column has a tick from after the last run of this system.
    });
  },
});
```

Each component that you give to `.changed(...)` must be in the include mask of the query. A tick
belongs to an `(archetype, component)` pair. So a touch of one row marks the full archetype for
that component.

## 11. Query composition

To make a query more exact, chain the methods. Each method gives a new query, and the engine caches
it.

```ts
const alive     = ecs.query(Pos).and(Health);                    // include Pos AND Health
const active    = ecs.query(Pos).and(Health).without(Dead);          // remove Dead
const afflicted = ecs.query(Health).anyOf(Poison, Fire);        // a minimum of one of these
const targets   = ecs.query(Pos).and(Health).without(Shield).anyOf(IsEnemy, IsBoss);
```

Inside `registerSystem`, use `qb.with(...)` and chain in the same way:
`(qb) => qb.with(Pos, Vel).without(Dead)`. An identical set of filters resolves to the same cached
`Query` instance. So an `ecs.query(...)` call that you write in place has a low cost.

## 12. A complete example

The entities move. A damage system applies the changes to health from the events in the queue. A
death system marks the dead entities. A cleanup system destroys them. A `ChangedQuery` counts the
archetypes that moved in this frame.

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

// --- Queries (captured one time at module scope; the store keeps them current) ---
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
    const t = ctx.getResource(Time);
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

// Change detection: count the archetypes whose Pos moved in this frame.
let movedArchetypesThisFrame = 0;
const observeMoved = ecs.registerSystem({
  name: "observeMoved",
  reads: [Pos], writes: [],
  fn: () => {
    movedArchetypesThisFrame = 0;
    movedPos.forEach(() => { movedArchetypesThisFrame++; });
  },
});

// Apply the damage events in the queue through a mutable ref.
const applyDamage = ecs.registerSystem({
  name: "applyDamage",
  reads: [], writes: [Health],
  fn: (ctx) => {
    const hits = ctx.read(Hit);
    for (let i = 0; i < hits.length; i++) {
      const target = hits.target[i];
      if (!ctx.isAlive(target)) continue;     // protect against a stale handle
      const h = ctx.ref(Health, target);
      h.current -= hits.damage[i];
    }
  },
});

// Mark each entity with hp <= 0 as Dead (deferred).
const markDead = ecs.registerSystem({
  name: "markDead",
  reads: [Health], writes: [Dead],   // a write of Dead authorizes ctx.commands.add(_, Dead)
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

// Deferred destruction of each entity that carries Dead.
const cleanupDead = ecs.registerSystem({
  name: "cleanupDead",
  reads: [], writes: [],
  despawns: [Pos, Vel, Health, Dead],   // despawn removes each component — declare the full set
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

// --- Create the entities ---
let first: EntityID = 0 as EntityID;
for (let i = 0; i < 100; i++) {
  const e = ecs.spawn();
  ecs.addComponents(
    e,
    Pos({ x: Math.random() * 800, y: Math.random() * 600 }),
    Vel({ vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100 }),
    Health({ current: 100, max: 100 }),
  );
  if (i === 0) first = e;
}

// --- Run ---
ecs.startup();

// Emit a damage event AFTER startup(). startup() clears each event channel at
// its end, so an event from before it would never reach the first update().
ecs.events.emit(Hit, { target: first, damage: 40 });
ecs.update(1 / 60);
ecs.update(1 / 60);

console.log("moved archetypes:", movedArchetypesThisFrame);
console.log("alive entities:", ecs.entityCount);
```

## 13. Next steps

- [Components](api/components.md), [Entities](api/entities.md), [Queries](api/queries.md),
  [Refs](api/refs.md)
- [Events](api/events.md), [Resources](api/resources.md), [Systems](api/systems.md),
  [Schedule](api/schedule.md)
- [Change detection](api/change-detection.md) — the tick model, `ChangedQuery`, and the level of
  detail of an archetype.
- [Architecture](ARCHITECTURE.md) — the internal design: the store, the archetypes, and the query
  cache.
- [Best practices](BEST_PRACTICES.md) — performance advice, frequent errors, and idioms.
