# Events

> [!NOTE]
> **0.5.0 — a grouped surface.** On the host, the registration, emission, and reading of an event
> are on the **`ecs.events`** facade: `ecs.events.register(Damage, ["amount"])`,
> `ecs.events.registerSignal(Ping)`, `ecs.events.emit(Damage, {...})`, and
> `ecs.events.read(Damage)`. In a system, `ctx.emit` and `ctx.read` have not changed. Version 0.5.0
> **removed** the flat `ecs.*` forms of 0.4 and earlier.

An **event** is a send-and-forget message with a typed payload. One system emits it with `emit`,
and other systems read it with `read` in the same frame. The engine stores events as a
struct-of-arrays, with one column for each field. It **clears them at the end of each `update()`**,
so an event exists for exactly one frame.

```ts
import { eventKey, signalKey, type EntityID } from "@oasys/oecs";

// A typed event and a signal with no payload, both made at module scope.
const Contact = eventKey<{ a: EntityID; b: EntityID }>("Contact");
const Jumped  = signalKey("Jumped");

ecs.events.register(Contact, ["a", "b"]);   // list the fields (this sets the order of the columns)
ecs.events.registerSignal(Jumped);
```

## How to emit and read

On the host these functions are on the facade: `ecs.events.emit` and `ecs.events.read`. In a system
they are `ctx.emit` and `ctx.read`. The shapes are the same in both places:

```ts
emit(key: SignalKey): void;                     // signal — no payload
emit<S>(key: EventKey<S>, values: S): void;     // event — the full payload
read<S>(key: EventKey<S>): EventReader<S>;
```

The reader is a struct-of-arrays view. It has one read-only column array for each field, and a live
`length`.

```ts
// the producer system:
ctx.emit(Contact, { a: e1, b: e2 });
ctx.emit(Jumped);

// a consumer system (the same frame):
const hits = ctx.read(Contact);
for (let i = 0; i < hits.length; i++) {
  const a = hits.a[i];   // typed as EntityID — the brand survives emit → read
  const b = hits.b[i];
}
const jumps = ctx.read(Jumped).length;   // a signal carries only its count
```

```ts
type EventReader<S> = { readonly length: number } & { readonly [K in keyof S]: ReadonlyArray<S[K]> };
```

## Keys and schemas

```ts
eventKey<S extends EventShape<S>>(name: string): EventKey<S>;
signalKey(name: string): SignalKey;
type EventShape<S> = { readonly [K in keyof S]: number };  // the rule: each field is a number
type EventSchema = Readonly<Record<string, number>>;       // the default field → value-type map, with types removed
```

A `SignalKey` is a separate kind of event with no field. The type system stops you if you give a
payload to a signal, or if you read the columns that a signal does not have.

> [!TIP]
> Declare the schema as a **type literal or an `interface`**. Both operate correctly. The
> `EventShape<S>` rule is homomorphic: it tests that each property is a number, and it does not
> require an index signature. So a schema that you declare with `interface` is acceptable, even
> though it does not have the implicit index signature that a literal has. Each field must be a
> `number`, and this includes a number with a brand (see below).

> [!TIP]
> **A number field with a brand keeps its brand.** A field with the `EntityID` type, or any other
> branded number type, reads back from the `EventReader` with its brand, and you need no cast. The
> brand exists at compile time only. At run time the value is a `number` in a typed column.

## The lifetime of an event

> [!IMPORTANT]
> **An event exists for exactly one frame.** `ecs.update()` clears each channel as its final
> action. So you can read an event in the frame in which it was emitted, and in no other frame. A
> read across systems in the same frame operates correctly, but there is no delivery across frames.
> `startup()` also clears the events that its phases emit, so frame 1 never sees an old startup
> event. If you need persistent state, use a [resource](./resources.md) or a component.

> [!WARNING]
> **Do not emit from an `onSet` [observer](./observers.md).** `onSet` runs at the end of the tick,
> inside the window in which the engine is about to clear the events. An emission there would be
> removed before a reader saw it, and it would make snapshot and restore incorrect. In development
> this throws `OBSERVER_ONSET_EMIT`. Emit from a normal system instead.

> [!NOTE]
> The columns of the `EventReader` are the **live** backing arrays, and their read-only state is at
> the type level only. A type cast can write through them, but a write of that type corrupts the
> channel. Do not do it. `stateHash` and snapshots do not include events, and they do not include
> resources, because both are artifacts of one frame of the schedule.

## See also

- [systems](./systems.md) — where you emit and read
- [observers](./observers.md) — the `onSet` and `onAdd` callbacks, and why they cannot emit
- [resources](./resources.md) — persistent global state, in contrast to an event for one frame
