# Resources

Resources are typed global singletons that don't belong to any entity -- time, input state, camera config, game settings.

## Registration

Register with a field tuple and required initial values:

```ts
const Time = world.register_resource(["delta", "elapsed"] as const, {
  delta: 0,
  elapsed: 0,
});

const Config = world.register_resource(["speed", "gravity"] as const, {
  speed: 200,
  gravity: 9.8,
});
```

Returns a `ResourceDef<F>` with phantom typing (same pattern as components and events).

## Reading

```ts
// Outside systems
const time = world.resource(Time);

// Inside systems
const time = ctx.resource(Time);
```

The `ResourceReader` exposes scalar values via property getters on `column[0]`:

```ts
time.delta;   // number (not an array)
time.elapsed; // number
```

The reader is a live view -- reads reflect the latest writes immediately.

## Writing

```ts
// Outside systems
world.set_resource(Time, { delta: dt, elapsed: total });

// Inside systems
ctx.set_resource(Time, { delta: dt, elapsed: total });
```

Resource writes are immediate (not deferred). Changes are visible to all subsequent reads in the same frame.

## Use Cases

- **Time** -- delta time, elapsed time, frame count
- **Input** -- mouse position, key states
- **Camera** -- viewport offset, zoom level
- **Config** -- game speed, gravity, difficulty settings

Resources are the right choice for data that exists once globally and doesn't belong to an entity. If the data is per-entity, use components instead.
