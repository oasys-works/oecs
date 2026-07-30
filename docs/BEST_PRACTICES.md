# Best practices (v0.5)

This is practical advice for work with oecs: the patterns that agree with the design of the engine,
the compromises that they cause, and the errors that occur if you ignore them.

This document does **not** repeat the API reference, and it does not describe the internal parts.
For those, see:

- The API reference: [`docs/api/`](./api/) — one page for each subsystem, with an index at
  [`api/index.md`](./api/index.md).
- The internal parts: [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the data layout, the flush model,
  the rules for cache invalidation, and the column store.

The examples name the instance `ecs`, and they use the 0.5 surface: camelCase methods, the config
form of `registerSystem`, `eachChunk`, and `ctx.ref`. The canonical example that compiles is the
quick start in the README. The canonical reference for "does this truly operate" is
`src/core/ecs/__tests__/` (see [§20](#20-tests)).

## Contents

1. [Design the components](#1-design-the-components)
2. [Dense storage or sparse storage](#2-dense-storage-or-sparse-storage)
3. [Keys at module scope](#3-keys-at-module-scope)
4. [Declare the system access](#4-declare-the-system-access)
5. [Queries](#5-queries)
6. [Read columns and write columns](#6-read-columns-and-write-columns)
7. [Immediate and deferred structural operations](#7-immediate-and-deferred-structural-operations)
8. [System order, sets, and run conditions](#8-system-order-sets-and-run-conditions)
9. [Change detection](#9-change-detection)
10. [Observers](#10-observers)
11. [The lifecycle of an entity](#11-the-lifecycle-of-an-entity)
12. [Relations](#12-relations)
13. [Events and signals](#13-events-and-signals)
14. [Resources](#14-resources)
15. [Determinism](#15-determinism)
16. [The host write path and the editor](#16-the-host-write-path-and-the-editor)
17. [Memory size](#17-memory-size)
18. [The reactive UI connection](#18-the-reactive-ui-connection)
19. [Use the type primitives directly](#19-use-the-type-primitives-directly)
20. [Tests](#20-tests)
21. [Patterns to avoid](#21-patterns-to-avoid)

---

## 1. Design the components

### Use many small components, and not one large component

The exact set of components on an entity is the key of its archetype, and a query filters on
component masks. Both facts are in favour of small components with one purpose:

- **A query becomes more selective.** A system that needs `Pos` alone writes `ecs.query(Pos)`, and
  it iterates each entity with a position, whatever else those entities hold. If you put `Pos`
  inside a large `Transform { x, y, rotation, scale, parent, … }` component, each loop that touches
  the position pulls all those columns with it.
- **An archetype becomes specialized.** If you add a marker, for example `Frozen`, the engine makes
  a new archetype. A system that acts on frozen entities alone then iterates those rows alone. As a
  `Transform.frozen` field, the same marker makes each consumer branch inside the loop.
- **A partial write sets fewer ticks.** A change tick belongs to an `(archetype, component)` pair.
  A touch of `Pos` sets the tick of `Pos`, and not of `Vel` or `Health`. A large component starts
  each `changed()` observer for a change that it does not need.

```ts
// Good — each component has one responsibility
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent(["vx", "vy"] as const);
const Health = ecs.registerComponent({ current: "i32", max: "i32" });

// Avoid — one large component makes each consumer see each field
const Entity = ecs.registerComponent({ x: "f64", y: "f64", vx: "f64", vy: "f64", hp: "i32" });
```

The opposite risk is **archetype fragmentation**. Each unique combination is a different archetype,
and three independent boolean tags give a maximum of 2³ = 8 archetypes, of which many are almost
empty. When the combinations are numerous and sparse, put the related flags into one `u8` field, or
move a flag that is rare or that changes frequently to
[sparse storage](#2-dense-storage-or-sparse-storage).

### Select the smallest typed-array tag that is sufficient

A column is a concrete typed array. A narrow type makes the memory more dense, and it uses the
cache better.

| Data | Tag |
| --- | --- |
| Physics positions and velocities | `"f64"` |
| Pixel coordinates and small real numbers | `"f32"` |
| Health, counters, and signed integers | `"i32"` |
| Tile indices and small counts | `"u16"` |
| Flags and small enumerations | `"u8"` |

Use the array shorthand when each field has the same type, which is `"f64"` by default. Keep
`as const`. Without it, TypeScript makes the field names as general as `string[]`, and you then
lose the type of each field on `addComponent`, `getField`, the columns, and the refs.

```ts
const Vel = ecs.registerComponent(["vx", "vy"] as const);           // all f64
const Flags = ecs.registerComponent(["a", "b", "c"] as const, "u8"); // all u8
```

There is **no field type for a boolean, a string, or a 64-bit integer**. Each field is a JS
`number`. Model a flag as a tag or as a `u8`. Model an enumeration as a small integer. Keep each
string in a resource, or in a related table with an `EntityID` key.

### Use a tag for a classification, and the callable form for a bundle

A tag (`registerTag()`) is a component with no field. It is the clearest way to say "this entity is
a kind of X", and the engine uses paths that skip the column work.

```ts
const IsEnemy = ecs.registerTag();
const Frozen = ecs.registerTag();

const enemies = ecs.query(Pos, Health).and(IsEnemy);
const thawed = ecs.query(Health).without(Frozen);
```

A `ComponentDef` is **callable**. `Pos({ x: 10, y: 20 })` gives a bundle, and the spawn and add
functions that take a variable number of arguments accept a bundle. This is the direct way to write
an entity with several components, and it is the *typed* attach path for a subset of the values,
because the engine writes `0` in each absent field.

```ts
const e = ecs.spawnBundle(Pos({ x: 10, y: 20 }), Vel({ vx: 1 }), IsEnemy);
```

The typed overload `ecs.addComponent(e, Pos, values)` demands the **complete** `FieldValues<S>`,
which is each field. There you must give `0` explicitly, or use a bundle.

---

## 2. Dense storage or sparse storage

A dense component is part of the archetype identity. An add or a remove moves the entity to a new
archetype, and it copies the **full** payload row of that entity. A sparse component
(`registerSparseComponent` or `registerSparseTag`) is outside the identity. An add or a remove is a
flat insert or delete in a sparse set, with no transition, no row copy, and no use of a bit of the
dense identity.

| Use **sparse** for | Use **dense** for |
| --- | --- |
| data that is present on a small part of the entities | data that is present on most matching entities |
| flags or values that change constantly | stable structural identity |
| cooldowns, temporary markers, relation targets | anything that you iterate in a high-frequency column loop |
| a way past the **limit of 128 dense components** | — |

```ts
const Cooldown = ecs.registerSparseComponent({ ready: "u32" });
ecs.addSparse(e, Cooldown, { ready: 90 });   // immediate, and no archetype change
```

The cost: sparse membership is not in the archetype mask. So a plain dense query does not see it,
and it has no span of columns in struct-of-arrays form. Filter with `withSparse` or
`withoutSparse`, and iterate with `forEachEntity`:

```ts
ecs.query(Unit).withSparse(Cooldown).forEachEntity((e) => {
  const ready = ecs.getSparseField(e, Cooldown, "ready");
});
```

> [!WARNING]
> The **budget of 128 dense slots is an absolute limit**. Each `registerComponent` or `registerTag`
> call uses one bit of the archetype mask, and the 129th call throws
> `COMPONENT_LIMIT_EXCEEDED`. Data that is rare, that changes frequently, or that would exceed the
> budget belongs in sparse storage, which has no limit.

Sparse operations apply immediately. So, if you mutate the sparse membership that *drives* a
`forEachEntity` walk, the live key array moves below you. Hold such changes in a buffer, and apply
them after the loop.

---

## 3. Keys at module scope

`eventKey`, `signalKey`, and `resourceKey` each make a new symbol at each call. The identity
survives across registrations only when the key is one `const` at module scope:

```ts
// keys.ts
import { eventKey, signalKey, resourceKey, type EntityID } from "@oasys/oecs";

export const DamageEvent = eventKey<{ target: EntityID; amount: number }>("Damage");
export const GameOver = signalKey("GameOver");
export const Time = resourceKey<{ delta: number; elapsed: number }>("Time");
```

Then import the key at each place where you emit, read, or use the resource:

```ts
ecs.events.register(DamageEvent, ["target", "amount"]);
ecs.events.registerSignal(GameOver);
ecs.resources.register(Time, { delta: 0, elapsed: 0 });
```

A `resourceKey("Time")` call inside a function body would give a new symbol at each call, and two
call sites would not see the same resource. Module scope also documents the ownership: this key is
here, you register it one time, and you import it elsewhere. A second registration throws clearly:
`RESOURCE_ALREADY_REGISTERED` or `EVENT_ALREADY_REGISTERED`.

> [!TIP]
> You can declare an event schema as a type literal **or** as an interface. The `EventShape<S>`
> constraint is homomorphic (`{ readonly [K in keyof S]: number }`), so it needs no implicit index
> signature.

---

## 4. Declare the system access

Real work belongs in the **config form** of `registerSystem`, which declares the components that the
system touches. A development-mode access checker holds you to those declarations, and the build
tool removes the checker from a production build. So a system that reads or writes something that
it did not declare throws while you develop. This finds a full class of "I forgot that this system
also touches Health" errors before you ship. These guards are **off by default**, because
production is the default build. See
[Development guards and production builds](PRODUCTION.md) for how to turn them on while you
develop: on npm, use `@oasys/oecs/dev` or a bundler in development mode; on Deno, set
`globalThis.__DEV__ = true`.

```ts
const movers = ecs.query(Pos, Vel);

const move = ecs.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],          // a write also gives read access, and it authorizes addComponent(Pos)
  queries: [[Pos, Vel]],  // a check: each component that you query must be in reads ∪ writes
  fn: (ctx, dt) => {
    movers.eachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);
      const { vx, vy } = cols.read(Vel);
      for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
    });
  },
});
```

The rules to remember:

- **`reads` and `writes` are necessary.** Give empty arrays to say "this system touches no columns"
  explicitly. Each other declaration field is empty by default.
- **A write also gives read access**, and it authorizes `addComponent` on that column.
- **`despawn` removes each component.** Declare the full set in `despawns`.
- **Sparse ids and relation ids are separate id spaces.** Declare them in `sparseReads` and
  `sparseWrites`, and in `relationReads` and `relationWrites`. Never declare them in `reads` or
  `writes`.
- **`queries` is a check at registration**, and not a run-time term. It tests
  `queries ⊆ reads ∪ writes`. Keep it equal to the terms of your closed-over `ecs.query(...)` calls,
  or to the terms of the query builder that you give to `registerSystem`.
- **The compiler also checks the declarations.** The config form gives `ctx` a type that is limited
  to the declared access surface. So a read, write, add, or destroy that you did not declare is a
  compile error, before it is a development-mode throw (see
  [systems — compile-time enforcement](./api/systems.md#compile-time-enforcement)). To remove those
  limits from one system, add a type to the parameter: `fn(ctx: SystemContext)`.

> [!WARNING]
> The **function alone** form and the **function with a query builder** form register with *empty*
> access. So each attempt to touch a component, a resource, or a relation throws while you
> develop. Use them only for small systems that need no access, for example an increase to an
> external counter. Use `exclusive: true` rarely, and only for a system that truly touches
> everything: the apply system for host commands, save and load, or a debug tool. That flag gives
> full access and bypasses each check.

---

## 5. Queries

### A narrow filter is better than a broad filter plus a test

Use the narrowest include set that expresses what the system needs. `ecs.query(A, B)` agrees with
each archetype that has *a minimum of* `A` and `B`. Make it more exact with `without`, `anyOf`,
`optional`, `changed`, `withSparse`, or `withRelation`. Each verb gives a new **cached** query, and
the engine remembers each composition. So equivalent filters give the same instance. There is one
exception: a `changed(A, B)` call with several arguments makes a new `ChangedQuery`, but the engine
caches a `changed` call with one argument.

```ts
ecs.query(Pos)
  .and(Vel)             // require Vel also
  .without(Frozen)      // remove the frozen entities
  .anyOf(Player, NPC);  // and be a Player OR an NPC
```

Do not iterate each entity with `Pos` and then make a `has(Vel)` test in the loop. Write a query for
`(Pos, Vel)` instead. The query does the selection one time, in the archetype, and the loop then
makes no test for each row.

### Build a query one time, and hold it in a closure

Declare a query with `ecs.query(...)` at setup, and capture it in the closure of the system. The
store continues to add each newly matching archetype to it, so it never becomes out of date. You
also pay nothing to build the mask in each frame:

```ts
const movers = ecs.query(Pos, Vel);   // live and cached — build it one time
const move = ecs.registerSystem({ reads: [Pos, Vel], writes: [Pos], fn: () => movers.eachChunk(/* … */) });
```

The `registerSystem(fn, qb => qb.with(...))` builder form is equivalent, but the closure form puts
the query beside the system and reads more clearly. An `ecs.query(...)` call that you write in
place is still cached, because equivalent filters give the same instance.

### Select the correct terminal function

| Terminal | Callback | Can it mutate? | Use it for |
| --- | --- | --- | --- |
| `forEach` | a read-only `ArchetypeView` | no | how to read columns |
| `eachChunk` | a mutable `cols` and a `count` | **yes** | the high-frequency loop that writes |
| `forEachEntity` | one `EntityID` | through `ctx` | a query with a sparse, relation, or hierarchy term |

`forEach`, `eachChunk`, and `entityCount` are for a **dense query only**. A query that carries a
sparse, relation, or hierarchy term throws `SPARSE_QUERY_DENSE_PATH` in development, because there
is no span of columns. For those, use `forEachEntity` or `forEachRelatedTo`.

> [!WARNING]
> **Always loop to `arch.entityCount`. Never loop to the `.length` of a column.** The raw buffer
> includes the free capacity and the disabled rows after the live count. A loop to `.length` reads
> incorrect data. `entityCount` is the number of enabled rows. The `count` parameter of `eachChunk`
> exists to remove this risk.

---

## 6. Read columns and write columns

The name of the accessor shows the ability to mutate. Each mutable accessor **sets the change tick
immediately**: at the moment that you get it, before any write, and also if you never write. This
is what keeps `changed()` conservative. So, use the read-only variant each time that you only
read. This avoids an incorrect change detection, *and* it shows your intention.

| | Sets the tick | Read-only, no change to the tick |
| --- | --- | --- |
| The high-frequency column loop | `cols.mut(def)` | `cols.read(def)` |
| Many entities by id | `ctx.cursor(def)` | `ctx.cursorRead(def)` |
| One entity by id | `ctx.ref(def, e)` | `ctx.refRead(def, e)` |
| One field | `ctx.setField` / `ctx.updateField` | `ctx.getField` |

Each accessor above is also on the host facade, with the same name: `ecs.cursor`, `ecs.refRead`,
`ecs.getField`. Use the `ctx` form in a system, because it makes the check against the declared
access (see [§4](#4-declare-the-system-access)).

### `eachChunk` for the high-frequency loop that writes

```ts
movers.eachChunk((cols, count) => {
  const { x, y } = cols.mut(Pos);     // writable columns; sets the tick of Pos one time
  const { vx, vy } = cols.read(Vel);  // read-only; no change to the tick
  for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
});
```

Destructure `cols.mut(Pos)` immediately. The engine caches the group object for each
`(archetype, component)` pair, and it refreshes that object in place at the next call. So do not
keep the group object between iterations.

### `ctx.ref` and `ctx.refRead` for low-frequency paths that touch one entity

Use a ref when the high-frequency column loop is not correct: a reaction to one event, a touch of a
specific entity by id, or an occasional write to a different entity. The cost to create a ref is
small (one `Object.create` over a cached prototype), and each field access is one index operation
on a typed array.

```ts
// Read-only: no change to the tick
const pos = ctx.refRead(Pos, player);
ctx.emit(LogPos, { x: pos.x, y: pos.y });

// Mutable: sets the tick of Pos at creation, also if you never write
const pos = ctx.ref(Pos, player);
pos.x += vel.vx * dt;
```

> [!WARNING]
> **A ref does not survive an archetype transition.** It is safe to hold across the immediate reads
> and writes inside a system, because structural changes are deferred and the entity cannot move
> until the flush at the end of the phase. But when the entity gains or loses a component, its row
> moves. Create the ref again. A ref *is* safe across a growth of the column, because it reads the
> live column backing, which refreshes in place.

### `ctx.cursor` and `ctx.cursorRead` for many entities by id

A ref is correct for **one** entity. But a loop over a list of ids makes one ref for each entity,
and then discards it. That allocation is the largest part of the cost.

A cursor is the same accessor with the allocation outside the loop. You make it one time, and then
you point it again at each entity:

```ts
const p = ctx.cursor(Pos);
for (let i = 0; i < hits.length; i++) {
  p.at(hits[i]);            // point the cursor at this entity
  p.x += p.y * dt;          // read and write the fields of hits[i]
}
```

`at()` finds the archetype and the row one time. Each field access after that is one index
operation on a typed array. Thus a cursor becomes better as the number of fields increases.

Make the cursor **outside** the loop. A cursor that you make inside the loop keeps the allocation
that a cursor must remove.

A cursor is also **safer than a ref that you keep**, and not more dangerous. `at()` finds the
archetype and the row again at each call. Thus a structural change between two `at()` calls cannot
make the cursor read a different entity. Only the interval between one `at()` and the field
accesses after it must have no structural change.

`at()` returns the cursor. So a single read stays one expression: `ecs.cursorRead(Pos).at(e).x`.
But in a loop, call `at()` as a statement, and then read the fields. That is the form with no
allocation.

A component with a field that has the name `at` cannot use a cursor, because the name is the same
as the `at(entity)` method. The engine throws an error when you make the cursor. Use `getField` or
a ref for that component, or give the field a different name.

### Select the accessor for access by id

The three accessors have different costs. This is the order for access by id, from the fastest to
the slowest:

1. `cursorRead` and `cursor`
2. `refRead` and `ref`
3. `getField` and `setField`

Measure the difference on your machine with `node bench/run.mjs access/`. Do not use a value from
one run as an absolute quantity. Compare the paths against each other.

Read the result like this:

- **`getField` pays for each field.** It finds the archetype, the row *and the name of the field* at
  each call. Thus two fields cost almost two times one field.
- **`refRead` pays one time for each entity.** The lookup occurs when you make the ref. Thus more
  fields cost almost nothing more. But the allocation makes one field as expensive as `getField`.
- **A cursor pays one time for each entity, and it allocates nothing.** It is the fastest of the
  three at one field. Its advantage becomes larger with each added field.

So use this rule:

| Your access | Use |
| --- | --- |
| The set of entities is a query | `eachChunk` — see below |
| A loop over ids, or repeated access by id | `ctx.cursor` / `ctx.cursorRead` |
| One entity, more than one field, one time | `ctx.ref` / `ctx.refRead` |
| One entity, one field, one time | `ctx.getField` / `ctx.setField` |
| Only a test for membership | `ecs.hasComponent` |
| Only a test that the entity is alive | `ecs.isAlive` |

`hasComponent` and `isAlive` read no field. Thus they are cheaper than each accessor above. Do not
make a ref or a cursor only to find out that an entity has a component.

### A query is faster than access by id, and much faster

A cursor removes the allocation. It does **not** remove the operation to find the archetype and the
row, because that operation is what access by id means. A column loop has no such operation at all.

This is the order for iteration, from the fastest to the slowest:

1. `eachChunk`
2. `forEachEntity`
3. `cursorRead`
4. `getField`

A column loop is much faster than the fastest access by id. Against `getField`, the difference is
larger again. Measure the difference on your machine with `node bench/run.mjs iter/`.

So the first question is always "can a query give me this set of entities?" Use a cursor only when
the answer is no: a list of ids from the host, a reaction to an event that names an entity, or a
relation target.

This is a compromise in the design, and not a defect. oecs puts the rows together in each
archetype, and that is why the column loop is fast. A library that uses the entity id as the index
into its arrays gives the opposite result: access by id is faster, but its memory is in proportion
to the highest entity id, and not to the number of entities that are alive. Refer to
`bench/vs/README.md`.

`ReadonlyColumn`, `ReadonlyComponentRef` and `ReadonlyComponentCursor` are limits at compile time
only. A type cast can write through them, but such a write does not set the change tick, and change
detection then becomes incorrect with no signal. Do not do it. To mutate the result of a query, use
`eachChunk`, or write one entity at a time through `ctx.ref`, `ctx.cursor` or `ctx.setField`.

---

## 7. Immediate and deferred structural operations

The most important rule about timing: the receiver tells you the mode. Each operation on the host
facade (`ecs.*`) is **immediate**. A structural operation inside a system is on `ctx.commands.*`,
and it is **deferred** to the flush at the end of the phase.

| Operation | On `ecs` (the host) | On `ctx.commands` (in a system) |
| --- | --- | --- |
| `spawn` | immediate | immediate (the id now; the bundles attach at the flush) |
| `addComponent` / `removeComponent` | **immediate** | `add` / `remove` — **deferred** to the flush at the end of the phase |
| `despawn` | **immediate** | **deferred** to the flush at the end of the phase |
| `disable` / `enable` | immediate | deferred |
| sparse and relation operations (`ctx.addSparse`, `ctx.addRelation`, …) | immediate | immediate (no archetype transition — they are on `ctx` directly) |

Deferral inside a system is what stops an entity from moving to a different archetype during a live
`forEach` or `eachChunk` loop. On the host, each mutation applies immediately:
`ecs.despawn(e); ecs.isAlive(e)` gives `false` on the next line.

Two guards protect these rules in development:

- A call to an immediate host mutator from *inside* a system body throws, and it names the
  `ctx.commands` equivalent. The mutators are `ecs.despawn`, `ecs.addComponent` and
  `ecs.addComponents`, `ecs.removeComponent` and `ecs.removeComponents`, `ecs.batchAddComponent`
  and `ecs.batchRemoveComponent`, and `ecs.disable` and `ecs.enable`. During a system, these
  operations can move a row that a running query is walking, and the observers do not see them.
- A query walk on the host is also live iteration. If you despawn an entity, or mutate it
  structurally in another way, in an archetype that you walk in a host `forEach` or `eachChunk`, it
  throws `STRUCTURAL_DURING_ITERATION`. Collect the ids during the walk, and mutate after it.

**Inside a system, `ctx.commands` is the only deferred surface.** Version 0.5.0 removed the
equivalent bare functions `ctx.addComponent`, `ctx.removeComponent`, `ctx.disable`, and
`ctx.enable`, together with `ctx.createEntity` and `ctx.destroyEntity`. So a deferred operation
always reads as one at the call site:

```ts
ctx.commands.spawn(Pos({ x, y }), Vel({ vx: 1 }), IsEnemy);
ctx.commands.add(entity, Frozen);
ctx.commands.add(entity, Pos, { x: 0, y: 0 }); // all values, explicit (checked at compile time)
ctx.commands.despawn(entity);
```

Note that `ctx.commands.spawn` gives the new id immediately, because the create is not deferred.
But the components attach at the flush. So a query later in the *same* phase can see the entity
only partially built. To learn the id of a new entity after its data is present, create it from the
[host write path](#16-the-host-write-path-and-the-editor) with an `onSpawned` callback.

### One flush boundary, and not many

Each dense structural change costs one archetype move. When you build an entity with known default
values, use a template, so that the entity lands directly in the target archetype:

```ts
const Enemy = ecs.template(
  Pos({ x: 0, y: 0 }),
  Vel({ vx: 1, vy: 2 }),
  Health({ current: 100, max: 100 }),
);

const e = ecs.spawn(Enemy);
```

For an entity that exists, use `ecs.addComponents(e, ...bundles)` to find the final set of
components one time, instead of a chain of add operations. It uses the same grammar of callable
bundles as `template` and `spawnBundle`. `spawnBundle(...)` is still useful for its ergonomics, but
today it applies each bundle through the usual immediate add path.

For a change to a full archetype, for example "each entity with `Frozen` gets `Slow`", use
`ecs.batchAddComponent(arch.id, Def)` or `batchRemoveComponent`. They take an `ArchetypeID`, and
they move a region of columns in bulk with `TypedArray.set`, instead of one move for each entity.

---

## 8. System order, sets, and run conditions

### Express a real dependency with `before` and `after`

Inside a phase, the engine sorts the systems topologically from the `before` and `after`
constraints, and it uses insertion order to break a tie deterministically. Always encode a real
data dependency as a constraint. Never depend on a phase boundary between two systems that are not
related:

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,
  { system: move, ordering: { after: [input] } },
  { system: collide, ordering: { after: [move] } },
);
```

If A must see the writes of B in this frame, put them in the same phase, and give A `after: [B]`. A
cycle throws `CIRCULAR_SYSTEM_DEPENDENCY` at the first sort of that phase. This check is **never**
removed from a production build, so design your order as a directed acyclic graph.

> [!WARNING]
> **An order applies inside one phase only.** The engine ignores a target that you scheduled in a
> different phase. It also removes a constraint whose target is in *no* phase, and it gives a
> warning in development. A target in no phase is the result of a spelling error, or of a system
> that you did not give to `addSystems`. Also, `registerSystem` does not schedule. You must call
> `addSystems(phase, descriptor)`.

### Group with a system set, and gate with a run condition

A `systemSet` shares a run condition, an order, or both, across its members. `configureSet` adds to
the configuration, and its order against `addSystems` is not important:

```ts
const physics = systemSet("physics");
ecs.addSystems(SCHEDULE.FIXED_UPDATE, { system: integrate, set: physics }, { system: collide, set: physics });
ecs.configureSet(physics, { runIf: notPaused, before: [render] });
```

A run condition is a gate for each tick. It is a pure, read-only function of the ECS state:
`runIfResourceEq`, `runEveryNTicks`, `runIfAnyMatch`, or one that you write. The effective gate of
a member is the AND of its own conditions and of the conditions of each set that contains it.

> [!WARNING]
> A run condition **must be deterministic and must only read**. It must use no clock time, no random
> numbers, and no mutation. It runs in an access span that permits reads only, and an undeclared
> read or any mutation throws in development. A system that does not run does **not** increase its
> last-run tick. So it still sees each change from the period in which it did not run, and it
> misses nothing. A schedule with no set and no condition runs a byte-for-byte fast path, so the
> feature costs nothing until you use it.

### Give each system one purpose

One observable effect for each system makes the order easy to understand, and it keeps change
detection clean. A system that depends on the writes of `move` then needs only `after: [move]`, and
not a full phase of systems that are not related.

---

## 9. Change detection

### Poll with `changed()`

Build a query that includes the component that you watch. Then call `.changed(...)`, and put the
reader `after` the writer, so that the tick of the writer is visible:

```ts
const moved = ecs.query(Pos).changed(Pos);
const sync = ecs.registerSystem({
  reads: [Pos], writes: [],
  fn: () => moved.forEach((arch) => {
    const x = arch.getColumnRead(Pos, "x");
    for (let i = 0; i < arch.entityCount; i++) pushToRenderer(arch.entityIds[i], x[i]);
  }),
});
ecs.addSystems(SCHEDULE.UPDATE, writer, { system: sync, ordering: { after: [writer] } });
```

`changed()` composes: `ecs.query(Pos).changed(Pos).without(Dead)` operates, and the order of the
verbs is not important.

### Know the risks at the first run, and the level of detail

The last-run tick of a system is 0 until it runs one time. So, at the **first dispatch**, each
non-empty matching archetype looks changed, and a `changed()` query gives you everything. If that is
not what you want, test `ctx.lastRunTick === 0`.

**The level of detail is the archetype, and not the row.** If one entity in an archetype of 1000
rows writes `Pos`, the full archetype becomes changed, and the query gives you all 1000 rows.
`changed()` tells you *which archetypes to examine*, and not *which rows changed*.

Also, **an archetype transition sets the tick of each component on the destination**. So a
watcher on `changed(Pos)` runs when an entity gains `Frozen`, if both archetypes include `Pos`. If
you must tell the difference between "a write to a field" and "an arrival from a transition", track
it yourself.

### The engine does not track a tick for a resource

`ctx.setResource` writes to a plain map with no version. So `changed()` cannot observe it. If a
system must react to a change of a resource, emit an event beside the write, or keep a version
counter inside the value of the resource.

---

## 10. Observers

An observer is the push equivalent of a `changed()` query, which you must poll. You register it one
time, and the ECS calls you at the correct moment. Use an observer where you would otherwise poll
in each frame, or where you need exact information **for each entity**, which the archetype level of
detail of `changed()` cannot give.

```ts
const handle = ecs.observe(Health, {
  access: { reads: [Health], writes: [], spawns: [[Corpse]] },  // the callbacks run in an access span
  onRemove: (entityId, ctx) => ctx.commands.spawn(Corpse()),
});
handle.dispose();   // you can call this again safely
```

Select the level of detail deliberately:

- **`onAdd`, `onRemove`, `onDisable`, and `onEnable`** run at the structural flush boundary, after
  the batch is committed. They repeat until they reach a fixed point, so a cascade settles.
- **`onSet` with archetype granularity** (the default) uses the change tick, which costs nothing
  more. You get `(arch, ctx)` for each archetype column that changed, and you iterate the rows.
- **`onSet` with entity granularity** (`granularity: "entity"`) gives `(entityId, ctx)` for each
  entity that changed. But **registration of it turns on a dirty list for each row** of that
  component, which has a cost on the write path. Select it only when the changes are sparse enough
  that the exact information for each entity is better than an examination of the full archetype.

> [!WARNING]
> **Declare `access`.** The callbacks run in an access span, and the declarations also set the
> order in which the observers run. So an incorrect declaration can change that order with no
> signal.
>
> **Register each observer before `startup()`**, so that the engine prepares the archetypes that
> they create entities in.
>
> **Only deferred operations in the schedule run a *structural* observer.** `onAdd`, `onRemove`,
> `onEnable`, and `onDisable` drain at the flush. An immediate `ecs.addComponent` or `ecs.disable`
> call on the host runs none of them. Only the deferred `ctx.commands.add` and
> `ctx.commands.disable` run them.
>
> `onSet` is the exception. It is *derived* change detection: the change ticks and the dirty list,
> which the engine reads at the detection point after the update. So it does not depend on the
> receiver, and an `ecs.setField` call on the host between two frames reaches the `onSet` observers
> at the next `update()`, exactly as `ctx.setField` does.
>
> **Do not emit an event from `onSet`.** It runs at the end of the tick, where the engine is about
> to clear the events, and it throws `OBSERVER_ONSET_EMIT` in development. To make a detected
> change into an event for the next tick, emit it from a usual system that reads the dirty list.

If you write a component through the **raw** mutable column, and not through `setField` or `ref`,
an `onSet` observer with entity granularity does not see it, unless you call
`ctx.markChanged(entity, def)` in the loop.

---

## 11. The lifecycle of an entity

### A handle is a packed integer, and not a pointer

An `EntityID` contains `[generation:11][index:20]`. When you destroy an entity, the engine increases
the generation of the slot, or it retires the slot. So a stale handle fails `isAlive`. In
development, a stale handle in `getField`, `ref`, `addComponent`, or a similar function throws
`ENTITY_NOT_ALIVE`. In production those guards are absent, so a dead handle points quietly at
whatever is now in the slot, which the engine can have recycled.

### Check a handle again if you keep it between frames

You must test an entity id from an event, a closure, a resource, or a plain variable with `isAlive`
before you use it:

```ts
if (ecs.isAlive(target)) {
  const hp = ctx.getField(target, Health, "current");
  ctx.setField(target, Health, "current", hp - damage);
}
```

An id that you get inside `forEach`, `eachChunk`, or `forEachEntity` is alive for that callback,
because iteration never gives a dead row.

### Disable to hide, and destroy to remove

`disable` hides an entity from the queries, and it does **not** remove the data of the entity or
change its id. The entity stays in the disabled part at the end of its archetype, which is one row
swap and no transition. Query iteration and `entityCount` of the archetype do not count it. Note
that `ecs.entityCount` at the level of the world counts each entity that is alive, so it does
include a disabled entity. Use `disable` instead of a destroy and a new create, for an entity that
goes in and out of play, such as a bullet from a pool or a unit that you paused. To include such
entities again, use `.includeDisabled()`. A disabled entity must hold one component or more. Note
also that an *immediate* `ecs.disable` or `ecs.enable` call runs no observer. Only the deferred
`ctx.commands.disable` and `ctx.commands.enable` do.

### Templates for bulk creation

A template resolves a set of components and their default values to a target archetype **one time**.
So each later create skips the transitions for each component, and it lands directly in the
archetype:

```ts
const Bullet = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 0, vy: 0 }));
const b = ecs.spawn(Bullet, { x: 5, y: 10 });   // replacement values for each field
const swarm = ecs.spawnMany(Bullet, 500);          // O(columns) writes, and not O(500 × columns)
```

A template gives a benefit for an entity with several components, and for bulk creation. It also
prepares its archetypes, which is necessary before you restore a snapshot with
`ecs.snapshots.restore`. A template with one component gives no benefit, because `spawn()` with
`addComponent()` already allocates the row directly in the target archetype.

---

## 12. Relations

A relation links two entities as a `(relation, target)` pair. Use it for hierarchies, ownership,
targets, and instance-of links. Relations are built on sparse storage. So they cause no archetype
transition, they use no bit of the dense identity, and each relation operation is **immediate**.

```ts
import { registerChildOf } from "@oasys/oecs";
const ChildOf = registerChildOf(ecs);        // a supplied preset — a free function
ecs.relations.add(child, ChildOf, parent);
ecs.relations.targetOf(child, ChildOf);                 // parent
ecs.relations.sourcesOf(parent, ChildOf);               // [child, …] — the reverse "who points at me"
```

- **A relation is exclusive by default**: one target for each source, and a new `ecs.relations.add`
  call replaces the old target with no signal. Give `{ multi: true }` for a *set* of targets. Use
  `targetsOf` for a multi relation, and `targetOf` for an exclusive relation, because `targetOf`
  throws for a multi relation in development.
- **Compose a relation into a query** with `withRelation` or `withoutRelation`, which is the
  `(R, *)` term, and iterate with `forEachEntity`. `forEachRelatedTo(target, cb)` is the `(*, T)`
  wildcard. A wildcard query needs authorization: `relationReads: [R]`, or `[ANY_RELATION]` for
  `forEachRelatedTo`.
- **Traverse** an exclusive chain with `ancestorsOf`, `rootOf`, or `cascadeOf`. A cycle throws
  `RELATION_CYCLE` in development, and it never stops the program.

> [!CAUTION]
> **`registerChildOf` destroys the subtree by default** (`onDeleteTarget: "delete"`). If you destroy
> a parent, the full subtree goes with it. Give `{ onDeleteTarget: "clear" }` to let the children
> continue as new roots, or `"orphan"` to leave a `targetOf` that points at a dead entity.
> `registerIsA` uses `"clear"` by default, and it records the link only. There is **no inheritance
> of components**.

> [!WARNING]
> **`orphan` lets the reverse index grow.** The reverse entries of a destroyed target stay until
> each source points at a different target or is destroyed, and `targetOf` gives a *dead handle*
> instead of `undefined`. Call `ecs.relations.compact()` at a scene or snapshot boundary to remove
> them. It changes no observable state, and it does not change `stateHash`.

---

## 13. Events and signals

An event and a signal share one lifetime. You emit it during one `update()` call, each later system
in that call sees it, and the engine clears it before the next call. The difference is the payload:

```ts
import { eventKey, signalKey, type EntityID } from "@oasys/oecs";

// A structured event — you need data for each emission:
export const Damage = eventKey<{ target: EntityID; amount: number }>("Damage");
ecs.events.register(Damage, ["target", "amount"]);
ctx.emit(Damage, { target: e, amount: 50 });
const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) applyDamage(dmg.target[i], dmg.amount[i]);

// A signal — you need only "did this happen":
export const OnPause = signalKey("OnPause");
ecs.events.registerSignal(OnPause);
ctx.emit(OnPause);
if (ctx.read(OnPause).length > 0) { /* the game is paused */ }
```

A number field with a brand, such as `EntityID`, comes back from the reader with its brand, and you
need no cast. An event exists for exactly one frame. For persistent state, use a resource or a
component, and not an event that you emit again. Do not emit from an `onSet` observer (see
[§10](#10-observers)).

---

## 14. Resources

A resource is the correct place for a value with the scope of a frame or of the world:

- the time and the delta;
- the state of the input;
- the transform of a camera;
- the configuration;
- the seed of a random number generator.

Make the key at module scope, register it with an initial value, and read or write it anywhere.

```ts
const advanceTime = ecs.registerSystem({
  reads: [], writes: [], resourceReads: [Time], resourceWrites: [Time],
  fn: (ctx, dt) => { const t = ctx.getResource(Time); t.delta = dt; t.elapsed += dt; },
});
```

Inside a system, you declare resource access and the engine checks it, through `resourceReads` and
`resourceWrites`. Each read of a resource gives the same reference. So, to change an object
resource, mutate it through `ctx.getResource(key)`, and use `ctx.setResource` only to replace the
full value. `ctx.removeResource` releases the key for a new registration, and it fails safely for a
key that is absent.

A resource is the *incorrect* tool for data that belongs to an entity, because a resource is not
filterable, not iterable, and has no tick. Use a component instead. A resource is also incorrect as
a false single entity that carries a `GlobalState` component. Also, `stateHash`, snapshot, and
restore **do not include resources**. So, state that affects the simulation and that you must
reproduce must be in a component, or you must set it again after a restore.

---

## 15. Determinism

Determinism is optional (`new ECS({ deterministic: true })`), because it has a small cost: a
canonical order, and a rule that permits integer columns only. In exchange it gives lockstep
multiplayer, replay, deterministic debugging, and save and load. The flag controls `stateHash`,
`capture` and `restore`, and the sparse functions `captureSparse` and `restoreSparse`. Each of them
throws `DETERMINISM_DISABLED` when the flag is off.

If you need determinism:

- **Use integer columns.** Registration rejects a float column
  (`NON_DETERMINISTIC_COLUMN_TYPE`), because IEEE-754 rounds differently in different engines. The
  array shorthand uses `"f64"` by default, so give an explicit integer type:
  `ecs.registerComponent(["x", "y"], "i32")`. Represent a fraction as a fixed-point number.
- **Give a deterministic seed to each random number generator**, and store its state in a
  component. Keep each input that is not part of the lockstep, such as clock time or network
  jitter, out of the column bytes.
- **Compare two `stateHash` values at a tick boundary only**, which is between two `update()`
  calls, or at a settle point on a phase boundary. The phase boundary is a hook on a
  `FrameTraceSink` that you attach with `ecs.setTrace`, and not an API that you call. Note that the
  `POST_UPDATE` boundary runs before the `onSet` dispatch and the event clear at the end of the
  tick, so its hash can be different from the hash for the tick. The digest is opaque. Never
  compare it against a literal that you wrote by hand.
- **Give both instances the same size** before `ecs.snapshots.restore`, and register the same
  components and templates in the same order. The restore validates completely and fails safely
  before it touches the live state, but only when the set of archetypes and the capacity of the
  entity index of the target agree. Set the resources again after a restore, because the snapshot
  does not capture them.

Each mutation from a host or a UI crosses one control point. So `replayCommandLog(..., { hash: true })` gives the sequence of `stateHash` values for each tick. A
replay of the same log must reproduce that sequence, and that equality *is* the test of fidelity.

---

## 16. The host write path and the editor

A write that starts **outside** the schedule, in a UI, an editor, a network handler, or a worker,
must not touch the ECS during a frame. The host write path makes each such write into a typed
command, and it applies each one at one approved point.

```ts
import { SCHEDULE, installHostCommandSeam, spawnEntry } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);   // BEFORE your systems and startup()
ecs.addSystems(SCHEDULE.UPDATE, move);       // schedule your systems after you install it
ecs.startup();

queue.add(entity, Health, { hp: 100 });
queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (id) => console.log("spawned", id));
ecs.update(1 / 60);   // the apply system drains the queue at PRE_UPDATE
```

> [!WARNING]
> Install the path **before** you add your own systems, and **before `startup()`**, because
> insertion order is what puts the apply system at the head of the phase.
>
> The type of the values in `spawnEntry` demands **all** the fields. Give each field, although the
> shared write path writes `0` in an absent field of command data that has no type.
>
> **Do not add a component and then set a field on it in the same frame.** `setField` applies
> immediately at the drain, but a structural command defers to the flush at the end of the phase.
> So `add(e, C)` and then `setField(e, C, …)` fails. Carry the value in the `add` or in the
> `spawnEntry`, or set the field in the next frame.
>
> `onSpawned` is the only way to learn the id of a new entity.

The **editor** layer (`@oasys/oecs/editor`) adds undo, redo, and field handles that operate in two
directions, above this queue. Each edit is a transaction with a forward list of commands and an
inverse list, and an undo is only one more command on the same queue. Note that a despawn and then
an undo returns the *data*, but it creates the entity again with a **new `EntityID`**. Do not keep
an old id across an undo of its despawn.

---

## 17. Memory size

The default needs no configuration. It is a heap `ArrayBuffer` reserved fixed at a limit of 256
MiB, and a page that you do not touch costs no resident memory. It needs no `SharedArrayBuffer`,
and no cross-origin isolation. Use the `memory` option only to set the size deliberately, or to
change the storage.

```ts
new ECS();                                              // the heap default
new ECS({ memory: { budget: { entities: 50_000 } } }); // set the size from an entity budget
new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });   // an explicit byte limit
new ECS({ memory: { shared: {} } });                   // SharedArrayBuffer (workers / WASM)
```

> [!TIP]
> **`budget` is the arm to select.** Give it a number of entities, and it derives the column
> capacity, the reservation of the entity index, the byte limit, and the words of a limit error in
> your terms. A value of `entities` more than 2^20 throws.

The byte limit is an **absolute limit**. If you exceed it, it throws `STORE_CAP_EXCEEDED`, and
there is no alternative that grows past it. Also, the engine reserves the region of the entity index
immediately at construction, which is about 12 MiB at the default limit. So a limit that
is too small fails *at construction*, and not later. Set the limit to your actual peak. To examine
the result of the `memory` option, read `ecs.memoryPlan`, which carries a `derivation` trace that a
person can read. The shared and WASM allocators are behind `@oasys/oecs/shared`, and they throw
`SabUnavailableError` when `SharedArrayBuffer` is absent. Either serve the page with cross-origin
isolation, or stay on the heap profile, which needs neither header.

---

## 18. The reactive UI connection

The ECS does not depend on a framework, and it never imports a UI library. The reactive part is
three optional entry points. They bring ECS state into a reactive UI, and the UI makes no full
render in each frame. The three entry points are `@oasys/oecs/reactive`, which is the signals
kernel; `@oasys/oecs/reactive-sync`, which is the bridge from the ECS, and which publishes only the
changed entities and columns; and `@oasys/oecs/solid`, which is the SolidJS adapter.

```ts
import { syncComponentToMap, shallow, batchedUpdate } from "@oasys/oecs/reactive-sync";

const positions = syncComponentToMap(ecs, Pos, (row) => ({ x: row.field("x"), y: row.field("y") }), { eq: shallow });
batchedUpdate(ecs, 1 / 60);   // = batch(() => ecs.update(dt)) — one tick, one UI flush
```

> [!WARNING]
> **Give `eq: shallow`, or a scalar projection, when the values are objects.** Under the default
> `Object.is`, a projection that gives a new object in each tick compares as unequal each time, and
> it starts each subscriber in each frame. This is the most frequent error with `reactive-sync`.
> **Key a Solid `<For>` on the stable `EntityID`**, and never on a value object that changes in each
> tick.

If a projection reads a *second* component, the result becomes out of date. Use `syncJoinToMap`,
which subscribes to each definition. Wrap each tick in `batchedUpdate`, so that the publications of
a full frame go together into one UI flush.

---

## 19. Use the type primitives directly

`@oasys/oecs/primitives` exports `BitSet`, `SparseSet`, `SparseMap<V>`, the `GrowableTypedArray`
family, `BinaryHeap<T>`, and `topologicalSort`. These are the same primitives that the ECS uses
internally, for the archetype masks, the sparse stores, the columns, and the queue of ready systems
in the scheduler. Use them when:

- you need a set with integer keys and O(1) operations, for example the entities that you saw in
  this frame — use `SparseSet`;
- you need a priority queue, for example for A* or for a timeline of events — use `BinaryHeap<T>`
  with a `CompareFn<T>`;
- you need a numeric buffer that grows, to give to WebGL or WebGPU, or to copy in bulk with
  `TypedArray.set()` — use `GrowableFloat32Array`, `GrowableInt32Array`, or a similar class;
- you need a dense bit mask with `contains` and `overlaps` — use `BitSet`.

An append that causes growth makes `buf` and `view()` of a growable array invalid. Read the
reference again after an append, and do not keep it.

---

## 20. Tests

`src/core/ecs/__tests__/` is the canonical reference for usage. It has this structure:

- `integration/` — each file exercises one subsystem from start to end, against a real `ECS`:
  `query.test.ts`, `change_detection.test.ts`, `commands.test.ts`, `each_chunk.test.ts`,
  `observers.test.ts`, `relations*.test.ts`, `sparse_query.test.ts`, `run_condition.test.ts`,
  `bundles.test.ts`, and others.
- `unit/` — one mechanism in each file: `archetype.test.ts`, `store_state_hash.test.ts`,
  `host_commands.test.ts`, `command_log.test.ts`, `deterministic_column_guard.test.ts`,
  `disable.test.ts`, `template.test.ts`, `world_resume.test.ts`, and others.
- `limits/` — scale and long runs: `entity_scale.test.ts`, `component_count_cap.test.ts`,
  `lifecycle_soak.test.ts`, and others.
- `breakage/` — the invariants that must not change: `destroy_mid_iteration.test.ts`,
  `structural_mid_system.test.ts`, `deferred_ordering.test.ts`, `query_cache_coherence.test.ts`,
  and others.

Write tests for your own code in the integration style: construct a world, register what you need,
drive it with `ecs.update(dt)`, and assert on the state that you can observe. A mock of
`SystemContext` or of the store fixes the internal parts in place. It also misses the errors across
subsystems that truly occur:

- the order of a flush;
- the propagation of a change tick;
- a ref that becomes invalid after a transition;
- the order in which the observers run.

The API has a low enough cost to construct in a test. When a test fails, read the matching integration test for that
subsystem. If the invariant that you depend on is not asserted there, it can be absent.

---

## 21. Patterns to avoid

**Do not iterate past `arch.entityCount`.** A column has a buffer that doubles in size, and its raw
`.length` is more than the live count and covers the disabled rows. Always loop to
`arch.entityCount`, or use the `count` of `eachChunk`. Read `arch.getColumnRead(...)` one time for
each archetype. The reference is stable for the callback, but not between frames.

**Do not use `cols.mut` or `ctx.ref` when you only read.** Both set the change tick when you get
them, before any write. A read through a mutable accessor then starts each `changed()` observer for
nothing. Use `cols.read` or `ctx.refRead`.

**Do not cast `ReadonlyColumn` or `ReadonlyComponentRef` to write.** The read-only marker is how the
compiler holds you to "this system reads `Pos` only", which keeps the `changed(Pos)` observers
correct. A write through a cast does not set the tick, and change detection then becomes incorrect
with no signal. Mutate through `eachChunk`, or through `ctx.ref` at the point where you mutate.

**Do not call an immediate `ecs.*` structural operation from inside a system.**
`ecs.addComponent` and `ecs.disable` bypass the deferred buffer, and they can move an archetype
membership during iteration. Inside a system, use `ctx.commands`.

**Do not add a component and then set a field on it, in one frame, across the host write path.**
`setField` drains immediately, and a structural command defers to the flush at the end of the
phase. Carry the value in the `add` or in the `spawnEntry`, or set the field in the next frame.

**Do not store a ref in a plain object.** A ref caches the position of the row of the entity, which
is the archetype and the row, and it reads the columns live. The next `addComponent` or `despawn`
call can move the entity away from that cached position. Build each ref again in each frame,
because the cost is almost zero. A cursor has no such risk, because `at()` finds the position again
at each call — but a cursor between frames is still a risk, because the component can go away from
the entity.

**Do not use `getField` in a loop over many entities.** It finds the archetype, the row and the
name of the field at each call. A cursor that you make outside the loop does that one time for each
entity. Thus the cursor is much faster at one field, and its advantage becomes larger with each
added field. Refer to [§6](#6-read-columns-and-write-columns).

**Do not make a cursor inside the loop that uses it.** `ecs.cursor(def)` allocates. A cursor that
you make for each entity has the same cost as a ref, and it gives you no advantage. Make the cursor
one time, and then call `at()` in the loop.

**Do not use a resource or a `Map<EntityID, …>` as storage for each entity.** That is a poor
reimplementation of component storage. You lose the co-location in an archetype, the query filters,
the iteration in struct-of-arrays form, and change detection, and you leave data for each destroyed
entity. If the data belongs to an entity, it is a component, or a sparse component.

**Do not emit an event from an `onSet` observer.** It runs at the end of the tick, where the engine
is about to clear the events. The emission is lost, and it makes a snapshot incorrect. It throws in
development. Emit from a usual system in the next tick.

**Do not use a float column on a deterministic ECS.** Registration rejects it. Use an integer and a
fixed-point representation.

**Do not register a dense component for data that is rare or that changes frequently.** Each add
and each remove copies the full payload row, and it uses one of the 128 identity bits. Use sparse
storage.
