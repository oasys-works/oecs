# OECS

A fast, minimal archetype-based Entity Component System written in TypeScript.

- **Structure-of-Arrays (SoA)** — each component field is a contiguous typed array column (`Float64Array`, `Int32Array`, etc.), enabling cache-friendly inner loops.
- **Phantom-typed components** — `ComponentDef<{x:"f64",y:"f64"}>` is just a number at runtime, but enforces field names and types at compile time.
- **Batch iteration** — `for..of` over a query yields non-empty archetypes. Access SoA columns via `get_column()` and write the inner loop.
- **Single-entity refs** — `ctx.ref(Pos, entity)` gives you a cached accessor with prototype-backed getters/setters.
- **Resources** — typed global singletons (time, input, config) with live readers.
- **Events & signals** — fire-and-forget SoA channels, auto-cleared each frame.
- **Deferred structural changes** — add/remove component and destroy entity are buffered during system execution and flushed between phases.
- **Topological system ordering** — systems within a phase are sorted by before/after constraints using Kahn's algorithm.
- **Fixed timestep** — configurable fixed update loop with accumulator and interpolation alpha.

## Quick start

```ts
import { ECS, SCHEDULE } from "@oasys/oecs-typed2";

const world = new ECS();

// Record syntax — per-field type control
const Pos = world.register_component({ x: "f64", y: "f64" });

// Array shorthand — uniform type, defaults to "f64"
const Vel = world.register_component(["vx", "vy"] as const);

// Tags have no fields
const IsEnemy = world.register_tag();

// Resources are global singletons
const Time = world.register_resource(["delta", "elapsed"] as const, {
  delta: 0,
  elapsed: 0,
});

// Events are fire-and-forget messages
const Damage = world.register_event(["target", "amount"] as const);

// Create entities and attach components
const e = world.create_entity();
world.add_component(e, Pos, { x: 0, y: 0 });
world.add_component(e, Vel, { vx: 100, vy: 50 });
world.add_component(e, IsEnemy);

// Register a system with a typed query
const moveSys = world.register_system(
  (q, _ctx, dt) => {
    for (const arch of q) {
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      const vx = arch.get_column(Vel, "vx");
      const vy = arch.get_column(Vel, "vy");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    }
  },
  (qb) => qb.every(Pos, Vel),
);

// Schedule the system
world.add_systems(SCHEDULE.UPDATE, moveSys);

// Initialize
world.startup();

// Game loop
function frame(dt: number) {
  world.set_resource(Time, { delta: dt, elapsed: performance.now() / 1000 });
  world.update(dt);
}
```

## Components

Components map field names to typed array tags. All field values are `number`, but storage uses the specified typed array (`Float64Array`, `Int32Array`, etc.) for cache-friendly iteration.

```ts
// Record syntax — per-field type control
const Position = world.register_component({ x: "f64", y: "f64" });
const Health   = world.register_component({ current: "i32", max: "i32" });

// Array shorthand — all fields default to "f64"
const Vel      = world.register_component(["vx", "vy"] as const);

// Tags — no fields
const IsEnemy  = world.register_tag();
```

Supported typed array tags: `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, `"u32"`.

Add components individually or in batch (single archetype transition):

```ts
world.add_component(e, Position, { x: 10, y: 20 });
world.add_components(e, [
  { def: Position, values: { x: 10, y: 20 } },
  { def: Health, values: { current: 100, max: 100 } },
]);
```

See [docs/api/components.md](docs/api/components.md) for full API.

## Queries

Queries are live views over all archetypes matching a component mask.

```ts
const q = world.query(Position, Velocity);

// Iterate non-empty archetypes, access SoA columns, write the inner loop
for (const arch of q) {
  const px = arch.get_column(Position, "x");
  const py = arch.get_column(Position, "y");
  const vx = arch.get_column(Velocity, "vx");
  const vy = arch.get_column(Velocity, "vy");
  const n = arch.entity_count;
  for (let i = 0; i < n; i++) {
    px[i] += vx[i];
    py[i] += vy[i];
  }
}

// Chaining
const targets = world.query(Position).and(Health).not(Shield).or(IsEnemy, IsBoss);
```

See [docs/api/queries.md](docs/api/queries.md) for full API.

## Systems

Systems are plain functions registered with a query and scheduled into lifecycle phases.

```ts
// With a typed query
const moveSys = world.register_system(
  (q, ctx, dt) => { for (const arch of q) { /* ... */ } },
  (qb) => qb.every(Pos, Vel),
);

// Without a query
const logSys = world.register_system({
  fn(ctx, dt) { console.log("frame", dt); },
});
```

Inside systems, use `ctx` for deferred structural changes and per-entity access:

```ts
const e = ctx.create_entity();
ctx.add_component(e, Pos, { x: 0, y: 0 });
ctx.destroy_entity(someEntity);
ctx.remove_component(entity, Health);
```

See [docs/api/systems.md](docs/api/systems.md) for full API.

## Resources

Resources are typed global singletons — time, input state, camera config.

```ts
const Time = world.register_resource(["delta", "elapsed"] as const, {
  delta: 0, elapsed: 0,
});

// Write
world.set_resource(Time, { delta: dt, elapsed: total });

// Read — scalar values, not arrays
const time = world.resource(Time);
time.delta;   // number
time.elapsed; // number
```

See [docs/api/resources.md](docs/api/resources.md) for full API.

## Events & Signals

Events are fire-and-forget SoA channels, auto-cleared each frame.

```ts
// Data events carry fields
const Damage = world.register_event(["target", "amount"] as const);
ctx.emit(Damage, { target: entityId, amount: 50 });

const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) {
  dmg.target[i]; // number
  dmg.amount[i]; // number
}

// Signals carry no data — just a count
const OnReset = world.register_signal();
ctx.emit(OnReset);
if (ctx.read(OnReset).length > 0) { /* fired */ }
```

See [docs/api/events.md](docs/api/events.md) for full API.

## Refs

Refs provide cached single-entity field access — faster than `get_field`/`set_field` for repeated access.

```ts
const pos = ctx.ref(Pos, entity);
const vel = ctx.ref(Vel, entity);
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

See [docs/api/refs.md](docs/api/refs.md) for full API.

## Schedule

Seven lifecycle phases, executed in order:

| Phase | When | Use case |
|---|---|---|
| `PRE_STARTUP` | Once, before startup | Resource loading |
| `STARTUP` | Once | Initial entity spawning |
| `POST_STARTUP` | Once, after startup | Validation |
| `FIXED_UPDATE` | Every tick (fixed dt) | Physics, simulation |
| `PRE_UPDATE` | Every frame, first | Input handling |
| `UPDATE` | Every frame | Game logic |
| `POST_UPDATE` | Every frame, last | Rendering, cleanup |

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, physicsSys);
world.add_systems(SCHEDULE.POST_UPDATE, renderSys);

// Ordering constraints
world.add_systems(SCHEDULE.UPDATE, moveSys, {
  system: physicsSys,
  ordering: { after: [moveSys] },
});
```

See [docs/api/schedule.md](docs/api/schedule.md) for full API.

## Entity lifecycle

```ts
const e = world.create_entity();
world.is_alive(e); // true
world.destroy_entity_deferred(e); // deferred
world.flush();
world.is_alive(e); // false
```

Entity IDs are generational: destroying an entity increments its slot's generation, so stale IDs are detected as dead.

## Dev / Prod modes

`__DEV__` compile-time flags enable bounds checking, dead entity detection, and duplicate system detection. Circular dependency detection is always active (not tree-shaken). All other dev checks are tree-shaken in production builds.

## Development

```bash
pnpm install
pnpm test          # vitest in watch mode
pnpm bench         # run benchmarks
pnpm build         # vite library build
pnpm tsc --noEmit  # type check
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for internal design details.
