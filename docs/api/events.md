# Events

An **event** is a fire-and-forget message with a typed payload. Systems `emit` them and other systems `read` them within the same frame. Events are stored struct-of-arrays (one column per field) and **cleared at the end of every `update()`** — they exist for exactly one frame.

```ts
import { eventKey, signalKey, type EntityID } from "@oasys/oecs";

// A typed event and a payload-less signal, minted at module scope.
const Contact = eventKey<{ a: EntityID; b: EntityID }>("Contact");
const Jumped  = signalKey("Jumped");

ecs.registerEvent(Contact, ["a", "b"]);   // enumerate fields (defines column order)
ecs.registerSignal(Jumped);
```

## Emitting & reading

`emit` and `read` are identical on `ecs` and on `ctx`:

```ts
emit(key: SignalKey): void;                     // signal — no payload
emit<S>(key: EventKey<S>, values: S): void;     // event — full payload
read<S>(key: EventKey<S>): EventReader<S>;
```

The reader is an SoA view: one read-only column array per field, plus a live `length`.

```ts
// producer system:
ctx.emit(Contact, { a: e1, b: e2 });
ctx.emit(Jumped);

// consumer system (same frame):
const hits = ctx.read(Contact);
for (let i = 0; i < hits.length; i++) {
  const a = hits.a[i];   // typed as EntityID — the brand survives emit → read
  const b = hits.b[i];
}
const jumps = ctx.read(Jumped).length;   // a signal carries only its count
```

```ts
type EventReader<S> = { length: number } & { readonly [K in keyof S]: ReadonlyArray<S[K]> };
```

## Keys & schemas

```ts
eventKey<S extends EventSchema>(name: string): EventKey<S>;
signalKey(name: string): SignalKey;
type EventSchema = Readonly<Record<string, number>>;   // field → value-type map
```

A `SignalKey` is a distinct zero-field event — the type system stops you passing a payload to a signal or reading a signal's absent columns.

> [!TIP]
> Declare the schema as a **type literal**, not an `interface`: `eventKey<{ a: EntityID }>("…")` works, but an `interface` fails the `EventSchema` constraint (interfaces lack the implicit index signature that literals get).

> [!TIP]
> **Branded number fields round-trip.** A field typed `EntityID` (or any branded number) reads back branded from the `EventReader` with no cast — the brand is compile-time only, so at runtime it's just a `number` in a typed column.

## Lifetime

> [!IMPORTANT]
> **Events live exactly one frame.** `ecs.update()` clears every channel as its final act, so an event emitted this frame is readable only this frame. Same-frame cross-system reads work; there is no cross-frame delivery. (`startup()` also drains events its phases emit, so frame 1 never sees stale startup events.) If you need durable state, use a [resource](./resources.md) or a component.

> [!WARNING]
> **Do not emit from an `onSet` [observer](./observers.md).** `onSet` runs at the tick tail, inside the window where events are about to be cleared — an emission there would be wiped before any reader sees it and would break snapshot/restore. In dev this throws `OBSERVER_ONSET_EMIT`; emit from a normal system instead.

> [!NOTE]
> The `EventReader` columns are the **live** backing arrays, read-only by type only. A cast can write through them, but that corrupts the channel — don't. Events, like resources, sit outside `stateHash` and snapshots (they're a per-frame scheduling artifact).

## See also

- [systems](./systems.md) — where you emit and read
- [observers](./observers.md) — the `onSet`/`onAdd` callbacks (and why they can't emit)
- [resources](./resources.md) — durable global state, in contrast to per-frame events
