# OECS

A fast, minimal archetype-based Entity Component System written in TypeScript.

- **Zero-copy archetype transitions** — component data is indexed by entity, not archetype row. Moving between archetypes copies only the relevant column data.
- **Structure-of-Arrays (SoA)** — each component field is a contiguous `number[]` column, enabling tight inner loops.
- **Phantom-typed components** — `ComponentDef<["x", "y"]>` is just a number at runtime, but enforces field names at compile time.
- **Batch iteration** — `query.each()` calls your function once per archetype with column arrays and entity count. You write the inner loop.
- **Deferred structural changes** — add/remove component and destroy entity are buffered during system execution and flushed between phases.
- **Topological system ordering** — systems within a phase are sorted by before/after constraints using Kahn's algorithm.

## Quick start

```ts
import { World, SCHEDULE } from "oecs";

const world = new World();

// Define components as field-name arrays
const Pos = world.register_component(["x", "y"] as const);
const Vel = world.register_component(["vx", "vy"] as const);

// Tags have no fields
const IsEnemy = world.register_tag();

// Create entities and attach components
const e = world.create_entity();
world.add_component(e, Pos, { x: 0, y: 0 });
world.add_component(e, Vel, { vx: 100, vy: 50 });
world.add_component(e, IsEnemy);

// Register a system with a typed query
const moveSys = world.register_system(
  (q, _ctx, dt) => {
    q.each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i] * dt;
        pos.y[i] += vel.vy[i] * dt;
      }
    });
  },
  (qb) => qb.every(Pos, Vel),
);

// Schedule the system
world.add_systems(SCHEDULE.UPDATE, moveSys);

// Initialize
world.startup();

// Game loop
function frame(dt: number) {
  world.update(dt);
}
```

## Components

Components are defined as readonly string arrays of field names. All field values are `number`.

```ts
const Position = world.register_component(["x", "y"] as const);
const Health   = world.register_component(["current", "max"] as const);
const IsEnemy  = world.register_tag(); // no fields
```

The `as const` is required so TypeScript infers the literal tuple type `["x", "y"]` instead of `string[]`. This enables type-safe field access throughout the API.

### Adding components

```ts
const e = world.create_entity();

// Data components require a values object
world.add_component(e, Position, { x: 10, y: 20 });
world.add_component(e, Health, { current: 100, max: 100 });

// Tags require no values
world.add_component(e, IsEnemy);

// Add multiple at once (single archetype transition)
world.add_components(e, [
  { def: Position, values: { x: 10, y: 20 } },
  { def: Health, values: { current: 100, max: 100 } },
]);
```

### Removing and checking components

```ts
world.remove_component(e, Health);
world.has_component(e, IsEnemy); // true
```

## Queries

Queries are live views over all archetypes matching a component mask. They update automatically as new archetypes are created.

### Batch iteration with `each()`

`each()` calls your function once per matching archetype, passing column-group objects and the entity count. You write the inner loop.

```ts
const q = world.query(Position, Velocity);

q.each((pos, vel, n) => {
  // pos.x, pos.y, vel.vx, vel.vy are all number[]
  // n is the entity count in this archetype
  for (let i = 0; i < n; i++) {
    pos.x[i] += vel.vx[i];
    pos.y[i] += vel.vy[i];
  }
});
```

### Query chaining

```ts
// Extend required components
const q = world.query(Position).and(Velocity);

// Exclude archetypes that have a component
const alive = world.query(Position).not(Dead);

// Require at least one of these
const damaged = world.query(Health).or(Poison, Fire);

// Combine
const targets = world.query(Position).and(Health).not(Shield).or(IsEnemy, IsBoss);
```

### Manual iteration

For dynamic component access, iterate archetypes directly:

```ts
for (const arch of world.query(Position)) {
  const px = arch.get_column(Position, "x");
  const py = arch.get_column(Position, "y");
  const count = arch.entity_count;

  for (let i = 0; i < count; i++) {
    px[i] += 1;
    py[i] += 1;
  }
}
```

## Systems

Systems are plain functions registered with a query and scheduled into lifecycle phases.

### Registration

Two registration styles:

```ts
// Style 1: Function + query builder (typed, preferred)
const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i] * dt;
        pos.y[i] += vel.vy[i] * dt;
      }
    });
  },
  (qb) => qb.every(Pos, Vel),
);

// Style 2: Config object (for systems that don't need a query)
const logSys = world.register_system({
  fn(ctx, dt) {
    console.log("frame", dt);
  },
});
```

### Deferred operations

Inside systems, use `ctx` (SystemContext) for structural changes. These are buffered and applied between phases.

```ts
const spawnSys = world.register_system({
  fn(ctx, _dt) {
    const e = ctx.create_entity();
    ctx.add_component(e, Position, { x: 0, y: 0 });
    ctx.destroy_entity(someOtherEntity);
    ctx.remove_component(anotherEntity, Health);
    // Changes are applied after all systems in this phase complete
  },
});
```

### Per-entity field access

For reading/writing individual entity fields (not batch):

```ts
const damageSys = world.register_system({
  fn(ctx, _dt) {
    const hp = ctx.get_field(Health, targetEntity, "current");
    ctx.set_field(Health, targetEntity, "current", hp - 10);
  },
});
```

## Schedule

Six lifecycle phases, executed in order:

| Phase | When | Use case |
|---|---|---|
| `PRE_STARTUP` | Once, before startup | Resource loading, allocation |
| `STARTUP` | Once | Initial entity spawning |
| `POST_STARTUP` | Once, after startup | Validation, index building |
| `PRE_UPDATE` | Every frame, first | Input handling, time management |
| `UPDATE` | Every frame | Game logic, physics, AI |
| `POST_UPDATE` | Every frame, last | Rendering, cleanup |

Deferred changes are flushed automatically after each phase.

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, physicsSys);
world.add_systems(SCHEDULE.POST_UPDATE, renderSys);
```

### Ordering constraints

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, {
  system: physicsSys,
  ordering: { after: [moveSys] },
});

world.add_systems(SCHEDULE.UPDATE, {
  system: aiSys,
  ordering: { before: [moveSys] },
});
```

Systems with ordering constraints are topologically sorted. Systems with no constraints run in registration order.

## Entity lifecycle

```ts
const e = world.create_entity();

world.is_alive(e); // true

world.destroy_entity(e); // deferred
world.flush();           // apply now

world.is_alive(e); // false
```

Entity IDs are generational: destroying an entity increments its slot's generation, so stale IDs are safely detected as dead.

## Lifecycle hooks

Systems can define lifecycle hooks:

```ts
const sys = world.register_system({
  fn(ctx, dt) { /* runs every frame */ },

  on_added(store) {
    // Called once during world.startup()
  },

  on_removed() {
    // Called when system is unregistered via world.remove_system()
  },

  dispose() {
    // Called during world.dispose()
  },
});
```

## Dev / Prod modes

The codebase uses `__DEV__` compile-time flags. In development builds, you get:

- Bounds checking on entity IDs
- Validation on branded type construction
- Duplicate system detection
- Circular dependency detection
- Helpful error messages with context

All dev-only checks are tree-shaken in production builds.

## Development

```bash
pnpm install
pnpm test          # vitest in watch mode
pnpm bench         # run benchmarks
pnpm build         # vite library build
pnpm tsc --noEmit  # type check
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a thorough explanation of the internal design.
