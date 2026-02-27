# Schedule

## Phases

Seven lifecycle phases execute in order:

```
Startup (once):          PRE_STARTUP → STARTUP → POST_STARTUP
Fixed update (per tick): FIXED_UPDATE
Update (per frame):      PRE_UPDATE  → UPDATE  → POST_UPDATE
```

| Phase | When | Use case |
|---|---|---|
| `PRE_STARTUP` | Once, before startup | Resource loading, allocation |
| `STARTUP` | Once | Initial entity spawning |
| `POST_STARTUP` | Once, after startup | Validation, index building |
| `FIXED_UPDATE` | Every tick (fixed dt) | Physics, simulation |
| `PRE_UPDATE` | Every frame, first | Input handling, time management |
| `UPDATE` | Every frame | Game logic, AI |
| `POST_UPDATE` | Every frame, last | Rendering, cleanup |

## Adding Systems

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, physicsSys);
world.add_systems(SCHEDULE.POST_UPDATE, renderSys);
```

## Ordering Constraints

Systems within a phase can declare before/after ordering:

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

Systems with ordering constraints are topologically sorted using Kahn's algorithm. Systems with no constraints run in registration order. Circular dependencies always throw (not tree-shaken in production).

## Fixed Timestep

`FIXED_UPDATE` runs at a configurable fixed timestep using an accumulator:

```ts
const world = new ECS({
  fixed_timestep: 1 / 50,   // 50 Hz (default: 1/60)
  max_fixed_steps: 4,        // spiral-of-death cap (default: 4)
});
```

On each `world.update(dt)`:

1. Accumulator += dt
2. Clamped to `max_fixed_steps * fixed_timestep` (prevents spiral of death)
3. While accumulator >= fixed_timestep: run FIXED_UPDATE, subtract timestep
4. Then run PRE_UPDATE → UPDATE → POST_UPDATE with the original dt

If no systems are registered in FIXED_UPDATE, the accumulator loop is skipped.

### Interpolation

`world.fixed_alpha` gives `accumulator / fixed_timestep` for rendering interpolation:

```ts
const alpha = world.fixed_alpha;
// Interpolate between previous and current fixed-step state
const rendered_x = prev_x + (curr_x - prev_x) * alpha;
```

### Runtime adjustment

```ts
world.fixed_timestep = 1 / 30; // change at runtime
```

## Deferred Flush

After all systems in a phase complete, `ctx.flush()` is called automatically:

1. Structural changes are applied (component adds first, then removes)
2. Destructions are applied

This ensures the next phase sees a consistent state.

## Removing Systems

```ts
world.remove_system(moveSys); // calls on_removed() hook
```

## Startup and Update

```ts
world.startup();    // runs PRE_STARTUP → STARTUP → POST_STARTUP
world.update(dt);   // runs fixed + variable phases
world.dispose();    // calls dispose() and on_removed() on all systems
```
