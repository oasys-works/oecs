# Systems

## Registration

Three registration styles:

### Bare function (no query, no lifecycle hooks)

```ts
const logSys = world.register_system((ctx, dt) => {
  console.log("frame", dt);
});
```

### With a typed query

```ts
const moveSys = world.register_system(
  (q, ctx, dt) => {
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
```

The query is resolved once at registration time and captured in the closure. Each frame, the schedule calls your function with the pre-resolved query.

### Full config (for lifecycle hooks)

```ts
const sys = world.register_system({
  fn(ctx, dt) { /* runs every frame */ },
  on_added(ctx) { /* once at startup */ },
});
```

All styles return a `SystemDescriptor` used for scheduling and ordering.

## SystemContext

Inside systems, `ctx` provides deferred structural changes and per-entity access.

### Entity operations

```ts
const e = ctx.create_entity();           // immediate
ctx.destroy_entity(e);                   // deferred until flush
```

### Component operations (deferred)

```ts
ctx.add_component(e, Pos, { x: 0, y: 0 }); // deferred
ctx.add_component(e, IsEnemy);               // deferred (tag)
ctx.remove_component(e, Vel);                // deferred
```

All structural changes are buffered and applied after the current phase completes, preventing iterator invalidation.

### Per-entity field access

```ts
// Direct field access (lookups archetype + row each call)
const hp = ctx.get_field(entity, Health, "current");
ctx.set_field(entity, Health, "current", hp - 10);

// Cached ref (lookups once, then getter/setter access)
const pos = ctx.ref(Pos, entity);
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

### Events

```ts
ctx.emit(Damage, { target: entityId, amount: 50 });
ctx.emit(OnReset); // signal

const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) {
  dmg.target[i]; // number
}
```

### Resources

```ts
const time = ctx.resource(Time);
time.delta; // number

ctx.set_resource(Time, { delta: dt, elapsed: total });
```

### Flush

```ts
ctx.flush(); // apply all deferred changes now
```

Flush is called automatically after each schedule phase. Manual flush is useful when you need structural changes to take effect within a system.

## Lifecycle Hooks

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
