# Events

## Data Events

Events carry typed fields in SoA layout. Register with a field tuple, emit with a values object, read via the reader.

```ts
const Damage = world.register_event(["target", "amount"] as const);
```

### Emitting

```ts
// Outside systems
world.emit(Damage, { target: entityId, amount: 50 });

// Inside systems
ctx.emit(Damage, { target: entityId, amount: 50 });
```

### Reading

```ts
const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i]; // number
  const amount = dmg.amount[i]; // number
}
```

The reader's field properties (`target`, `amount`) are the actual backing `number[]` columns -- reads are zero-copy.

## Signals

Signals are zero-field events -- they carry no data, just a count of how many times they were emitted.

```ts
const OnReset = world.register_signal();

// Emit
ctx.emit(OnReset);

// Read -- check count
const r = ctx.read(OnReset);
if (r.length > 0) {
  // signal fired this frame
}
```

Signals are much faster than data events (~14x) since they only increment a counter with no column pushes.

## Lifecycle

Events are auto-cleared at the end of each `world.update()` call, after all phases have run. Events emitted during a frame are visible to all subsequent systems in the same frame, then discarded.

```
world.update(dt)
  → run FIXED_UPDATE phases
  → run PRE_UPDATE phase     ← systems can emit events
  → run UPDATE phase         ← systems can read events emitted earlier this frame
  → run POST_UPDATE phase    ← last chance to read events
  → clear all events         ← events gone before next frame
```

## Phantom Typing

`EventDef<F>` follows the same phantom-typing pattern as `ComponentDef<F>` -- a branded `EventID` at runtime, carrying the field tuple `F` at compile time. This makes `emit()` and `read()` type-safe.
