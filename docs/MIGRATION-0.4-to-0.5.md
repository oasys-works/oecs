# Migration from oecs 0.4 to 0.5

Version 0.5 makes the vocabulary for the lifecycle uniform, and it moves the secondary surfaces onto
grouped facades. The organizing rule is that **the receiver tells you the timing**: `ecs.*` is
immediate, and `ctx.commands.*` is deferred to the flush at the end of the phase. These are
breaking renames, and there is **no alias for an old name**. But they group into a small number of
mechanical rules:

1. **The lifecycle verbs** — `createEntity` becomes `spawn`, `createEntities` becomes `spawnMany`,
   and `destroyEntity` becomes `despawn`. Also, `despawn` on the host is now **immediate**, and not
   deferred (§1).
2. **Inside a system** — Each bare deferred function is removed: `ctx.createEntity`,
   `ctx.destroyEntity`, `ctx.addComponent`, `ctx.removeComponent`, `ctx.disable`, and `ctx.enable`.
   In a system body, a deferred structural operation is on `ctx.commands` alone (§2).
3. **Grouped facades** — 29 flat methods move onto `ecs.relations`, `ecs.events`, `ecs.resources`,
   and `ecs.snapshots`. A small number change their name in the move: `snapshot` becomes `capture`,
   `restoreInto` becomes `restore`, `resource` becomes `get`, and others (§3).
4. **The argument order of `sourcesOf` changed** to `(entity, def)`. At a call site with no types
   this is a quiet change of behavior. The compiler finds a call site that has types (§4).
5. **Small renames, and the division of the internal parts** — `query.count()` becomes the
   `query.entityCount` getter. `WorldRestoreError` becomes `ECSRestoreError`.
   `WORLD_SNAPSHOT_VERSION` becomes `ECS_SNAPSHOT_VERSION`. The `export *` at the root became a
   selected list, and the internal parts (`HostCommandDispatcher`, the ring codecs,
   `resolveECSMemory`, and others) moved to `@oasys/oecs/internal` (§5).

Everything else did not change. That includes:

- the component operations on the host (`addComponent`, `getField`, `hasComponent`, and others);
- the queries, and the iteration (`forEach` and `eachChunk`);
- the sparse operations;
- the observers. Their API did not change, but see §1: an immediate `despawn` on the host no longer
  runs `onRemove`;
- the schedule;
- the data, event, and resource surface on the system side (`ctx.emit`, `ctx.read`, `ctx.resource`,
  `ctx.ref`, `ctx.setField`, `ctx.addSparse`, `ctx.addRelation`, and others).

The documentation now names the
receiver `const ecs = new ECS()` instead of `world`. That is prose alone, and the name of your
variable is your decision.

---

## 1. The lifecycle of an entity — `spawn` and `despawn`, and `despawn` on the host is now immediate

| 0.4 | 0.5 |
| --- | --- |
| `ecs.createEntity()` | `ecs.spawn()` |
| `ecs.createEntity(template, overrides?)` | `ecs.spawn(template, overrides?)` |
| `ecs.createEntities(template, count)` | `ecs.spawnMany(template, count, overrides?)` |
| `ecs.destroyEntity(e)` *(deferred)* | `ecs.despawn(e)` — **now immediate** |

`ecs.spawnBundle(...)` keeps its name. `spawnMany` gains an optional third parameter: one shared
`TemplateOverrides<Defs>` object that applies to each row that it creates. For an adjacent batch,
it uses one `fill` call for each column that you replaced.

> **The rename carries a change of behavior.** In 0.4, `destroyEntity` on the host was *deferred*.
> The entity stayed alive until the next flush at the end of a phase, although `addComponent` on
> the host was immediate. In 0.5, `despawn` on the host is **immediate**: the entity is dead on the
> next line.

```ts
// 0.4 — destroyEntity was deferred to the flush at the end of the phase
ecs.destroyEntity(e);
ecs.isAlive(e);   // still true here — the death happens at the flush
ecs.flush();
ecs.isAlive(e);   // false

// 0.5 — despawn from the host is immediate
ecs.despawn(e);
ecs.isAlive(e);   // false, immediately
```

If your 0.4 code depended on the deferred period, and destroyed an entity and then continued to
read it until the flush, that code now reads a dead entity and throws `ENTITY_NOT_ALIVE` in
development. Move the reads before the `despawn` call, or use `ctx.commands.despawn` from inside a
system, which is explicitly deferred (§2).

An immediate destroy during iteration can make the rows that a running query walks invalid. So **a call to `ecs.despawn` from inside a system body throws in development**, and it names
`ctx.commands.despawn`. The same development guard covers each immediate structural mutator on the
host: `addComponent` and `addComponents`, `removeComponent` and `removeComponents`,
`batchAddComponent` and `batchRemoveComponent`, and `disable` and `enable`. Each message names its
`ctx.commands` equivalent. A call from the host, in your setup code, an event handler, or between
two updates, is the correct use.

The change to immediate also changes what an observer sees. An observer runs only for a
**deferred** operation. So a `despawn` call on the host no longer reaches `onRemove`. In 0.4, the
deferred destroy on the host drained through the flush, and it sent `onRemove` as each other remove
did. Anything that depends on `onRemove`, and this includes the map bridges in `reactive-sync`, does
not see an entity that the host destroyed. Where that is important, destroy the entity through
`ctx.commands.despawn` or through the host command path.

---

## 2. Inside a system — `ctx.commands` is the only deferred surface

Each bare deferred function on the context is gone, and not only the pair for the lifecycle:

| 0.4 | 0.5 |
| --- | --- |
| `ctx.createEntity()` | `ctx.commands.spawn()` |
| `ctx.destroyEntity(e)` | `ctx.commands.despawn(e)` |
| `ctx.addComponent(e, def, values?)` | `ctx.commands.add(e, def, values)` — with the same demand for all values — or the bundle form `ctx.commands.add(e, def({ … }))` |
| `ctx.removeComponent(e, def)` | `ctx.commands.remove(e, def)` |
| `ctx.disable(e)` | `ctx.commands.disable(e)` |
| `ctx.enable(e)` | `ctx.commands.enable(e)` |

`ctx.isDisabled(e)` stays on the context, because it is an immediate *read*, and not an operation
in a buffer. The immediate sparse and relation operations (`ctx.addSparse`, `ctx.addRelation`, and
others) also stay. They cause no archetype transition, which is the full reason that they are safe
to apply during a system.

```ts
// 0.4
const cleanup = ecs.registerSystem({
  reads: [Health],
  writes: [],
  fn: (ctx) => {
    dead.forEach((arch) => {
      for (const e of arch.entityIds) ctx.destroyEntity(e);
    });
  },
});

// 0.5
const cleanup = ecs.registerSystem({
  reads: [Health],
  writes: [],
  fn: (ctx) => {
    dead.forEach((arch) => {
      for (const e of arch.entityIds) ctx.commands.despawn(e);
    });
  },
});
```

`ctx.commands`, which is the facade in the style of the Bevy `Commands` type and which 0.4
introduced, keeps its verbs: `spawn`, `add`, `remove`, `despawn`, `disable`, and `enable`. Each one
is deferred to the flush at the end of the phase. `add` gains the explicit shape that demands all
the values (`ctx.commands.add(e, Pos, { x: 0, y: 0 })`), which the removed `ctx.addComponent`
carried. So the attach path that the compiler checks survives the move. The end state that 0.4
declared is now real: **a verb on the host is immediate, and a verb on `ctx.commands` is deferred**,
and there is no third option.

---

## 3. Grouped facades — `ecs.relations`, `ecs.events`, `ecs.resources`, and `ecs.snapshots`

29 flat methods moved off the `ECS` class, onto four narrow facades. Each one maps one to one, and a
small number change their name in the move, which the right column shows. The high-frequency path,
which is the component operations, the queries, spawn and despawn, and the sparse operations, stays
flat by design. The **names on the system side, on `ctx.*`, did not change** (`ctx.emit`,
`ctx.read`, `ctx.resource`, `ctx.setResource`, `ctx.addRelation`, `ctx.sourcesOf`, and others).

### Relations (14)

| 0.4 | 0.5 |
| --- | --- |
| `ecs.registerRelation(opts?)` | `ecs.relations.register(opts?)` |
| `ecs.addRelation(src, def, tgt)` | `ecs.relations.add(src, def, tgt)` |
| `ecs.removeRelation(src, def, tgt?)` | `ecs.relations.remove(src, def, tgt?)` |
| `ecs.hasRelation(src, def)` | `ecs.relations.has(src, def)` |
| `ecs.targetOf(src, def)` | `ecs.relations.targetOf(src, def)` |
| `ecs.targetsOf(src, def)` | `ecs.relations.targetsOf(src, def)` |
| `ecs.sourcesOf(def, tgt)` | `ecs.relations.sourcesOf(tgt, def)` — **the arguments changed places**; see §4 |
| `ecs.pairsOf(def)` | `ecs.relations.pairsOf(def)` |
| `ecs.sourcesOfAny(tgt)` | `ecs.relations.sourcesOfAny(tgt)` |
| `ecs.ancestorsOf(src, def)` | `ecs.relations.ancestorsOf(src, def)` |
| `ecs.rootOf(src, def)` | `ecs.relations.rootOf(src, def)` |
| `ecs.cascadeOf(root, def)` | `ecs.relations.cascadeOf(root, def)` |
| `ecs.relationCount` (getter) | `ecs.relations.count` (getter) |
| `ecs.compactRelations()` | `ecs.relations.compact()` |

The preset helpers `registerChildOf(ecs)` and `registerIsA(ecs)` keep their names and their import
path, because they were never methods.

### Events (4)

| 0.4 | 0.5 |
| --- | --- |
| `ecs.registerEvent(key, fields)` | `ecs.events.register(key, fields)` |
| `ecs.registerSignal(key)` | `ecs.events.registerSignal(key)` |
| `ecs.emit(key, values?)` | `ecs.events.emit(key, values?)` |
| `ecs.read(key)` | `ecs.events.read(key)` |

### Resources (5)

| 0.4 | 0.5 |
| --- | --- |
| `ecs.registerResource(key, value)` | `ecs.resources.register(key, value)` |
| `ecs.resource(key)` | `ecs.resources.get(key)` |
| `ecs.setResource(key, value)` | `ecs.resources.set(key, value)` |
| `ecs.removeResource(key)` | `ecs.resources.remove(key)` |
| `ecs.hasResource(key)` | `ecs.resources.has(key)` |

### Snapshots and determinism (6)

| 0.4 | 0.5 |
| --- | --- |
| `ecs.snapshot()` | `ecs.snapshots.capture()` |
| `ecs.restoreInto(bytes)` | `ecs.snapshots.restore(bytes)` |
| `ecs.snapshotSparse()` | `ecs.snapshots.captureSparse()` |
| `ecs.restoreSparse(bytes)` | `ecs.snapshots.restoreSparse(bytes)` |
| `ecs.stateHash()` | `ecs.snapshots.stateHash()` |
| `ecs.deterministic` (getter) | `ecs.snapshots.deterministic` (getter) |

Together:

```ts
// 0.4
const ChildOf = ecs.registerRelation({ exclusive: true, onDeleteTarget: "delete" });
ecs.addRelation(child, ChildOf, parent);
ecs.registerResource(Clock, { ms: 0 });
ecs.setResource(Clock, { ms: 16 });
ecs.emit(Damage, { target: e, amount: 5 });
const bytes = ecs.snapshot();
ecs.restoreInto(bytes);

// 0.5
const ChildOf = ecs.relations.register({ exclusive: true, onDeleteTarget: "delete" });
ecs.relations.add(child, ChildOf, parent);
ecs.resources.register(Clock, { ms: 0 });
ecs.resources.set(Clock, { ms: 16 });
ecs.events.emit(Damage, { target: e, amount: 5 });
const bytes = ecs.snapshots.capture();
ecs.snapshots.restore(bytes);
```

The facades are the exact mirror image of the compile-time surface. `relations.register` puts the
cardinality into the type, and `targetOf`, `ancestorsOf`, `rootOf`, and `cascadeOf` accept an
exclusive relation alone. The facade classes are exported as **types alone** (`ECSRelations`,
`ECSEvents`, `ECSResources`, and `ECSSnapshots`), and the facades add no run-time export. But the
list of run-time exports at the root did change in 0.5.0; see §5.

---

## 4. The argument order of `sourcesOf` — from `(def, tgt)` to `(tgt, def)`

`sourcesOf` was the one function on the relation surface with a different argument order.
`targetOf(src, def)`, `targetsOf(src, def)`, and `sourcesOfAny(tgt)` each start with the entity.
Version 0.5 makes the order `(entity, def)` on **both** `ecs.relations.sourcesOf` and the
`ctx.sourcesOf` function on the system side:

```ts
// 0.4
const children = ecs.sourcesOf(ChildOf, parent);
const inCtx    = ctx.sourcesOf(ChildOf, parent);

// 0.5
const children = ecs.relations.sourcesOf(parent, ChildOf);
const inCtx    = ctx.sourcesOf(parent, ChildOf);
```

> **At a call site with no types, this is a quiet change of behavior.** `RelationDef` and `EntityID`
> are both branded *numbers* at run time. So a call in the old `(def, tgt)` order that reaches
> 0.5 through plain JavaScript, an `any` type, or a cast does **not** throw. It queries a
> `(relation, entity)` pair that has no meaning, and it gives an incorrect result, which is usually
> empty. The brands let TypeScript find the change at a call site that has types. But examine each
> caller of `sourcesOf`, and do not trust a build that reports no error.

---

## 5. Small renames

- **`query.count()` becomes `query.entityCount`**, which is a getter beside the `archetypeCount`
  getter that exists:

  ```ts
  // 0.4
  if (movers.count() === 0) return;

  // 0.5
  if (movers.entityCount === 0) return;
  ```

- **`WorldRestoreError` becomes `ECSRestoreError`**, and **`WORLD_SNAPSHOT_VERSION` becomes
  `ECS_SNAPSHOT_VERSION`**. The last exports with the `World` prefix join the `ECS` vocabulary
  (`ECSOptions`, `ECSError`, and others). The `ecs.snapshots` surface throws the error, and the
  constant tags its format (§3).
- **The root exports are now a selected list, and the internal parts moved to
  `@oasys/oecs/internal`.** The `export *` of 0.4 became an explicit list. The internal parts that
  it made public now import from `@oasys/oecs/internal`, which is unstable and has no semver
  guarantees: `HostCommandDispatcher`, the codecs of the ring transport, `resolveECSMemory`, the
  codec for a packed `EntityID`, `accessCheck`, and `dispatchTrace`. `getEntityIndex` stays at the
  root.

---

## 6. New, optional surface (you must migrate nothing)

These additions are optional. Your 0.4 code needs none of them, but they replace some frequent
workarounds. Use them as they help you:

- **A bundle overload for `addComponent`** — `ecs.addComponent(e, Pos({ x: 1 }))` accepts a
  callable bundle, and the engine writes `0` in each absent field, as usual. The explicit
  `(e, def, values)` form still demands each value, so an absent field there is still a compile
  error.
- **Total probes and `tryGetField`** — `hasComponent`, `hasSparse`, and `relations.has` now give
  `false` for an entity that is not alive, and they do not throw in development. A "has" probe is
  exactly the call that you make to avoid a dead entity. `ecs.tryGetField(e, def, field)` gives
  `undefined` for an entity that is not alive, or for a component that is absent.
- **`query.firstEntity()` and `query.singleEntity()`** — These read one entity, such as the player
  or the camera, without a `forEach` call and a capture that you write. `singleEntity` throws
  `QUERY_NOT_SINGLETON` in development when the number of matches is 0 or more than 1.
- **`ecs.refRead(def, e)` on the host** — a read-only view of a full component, equal to
  `ctx.refRead`.
- **Combinators for a run condition** — `not()`, `allOf()`, and `anyOf()` compose `RunCondition`
  values, and they join the read surfaces that the operands declared.
- **Notification of a change in the editor** — `editor.onChange(cb)` runs on each commit, undo,
  redo, and clear, and the `canUndo` and `canRedo` getters exist. So you no longer poll
  `depths()` in each frame.
- **Support for `using`** — `ObserverHandle` implements `Symbol.dispose`. So   `using h = ecs.observe(Pos, { onAdd })` removes the subscription at the end of the scope.
- **Debug names for a component** — `registerComponent(schema, { name: "Pos" })` labels a
  development error `'Pos' (component 5)`, so that you do not count the order of registration.
- **Compile-time types from the declarations** — The config form of `registerSystem` now reads
  `reads` and `writes` as literal types, and it limits `ctx` to exactly the surface that you
  declared. So access that you did not declare is a *compile* error, and the development-mode
  run-time check remains as the second line of defence. The type of a query column comes from the
  terms of the query. A relation handle carries its cardinality (`RelationDef<"exclusive">` or
  `RelationDef<"multi">`). A resource key and an event key are invariant. Code that was already
  correct compiles with no change. Code that declared too little access now fails at compile time,
  instead of at run time in development.
- **The lifecycle of the write path** — `uninstallHostCommandSeam(world, queue)`,
  `HostCommandQueue.clear()`, `HostCommandDispatcher.off(opCode)` (the dispatcher class now imports
  from `@oasys/oecs/internal`, §5), and `HostCommandRecorder.snapshotLog()`.
- **A `VERSION` export**, and a `"./package.json"` export.

---

## A quick checklist

You can find each 0.4 name below with a text search. None of them has an alias in 0.5.

- [ ] `createEntity` → `spawn`; `createEntities` → `spawnMany` (§1).
- [ ] `destroyEntity` → `despawn`. Then examine each call site on the host, because `despawn` is now
      **immediate**: nothing may read the entity between the `despawn` call and the old flush point
      (§1).
- [ ] `ctx.createEntity()` → `ctx.commands.spawn()`; `ctx.destroyEntity(e)` →
      `ctx.commands.despawn(e)` (§2).
- [ ] `registerRelation`, `addRelation`, `removeRelation`, `hasRelation`, `targetOf`, `targetsOf`,
      `pairsOf`, `sourcesOfAny`, `ancestorsOf`, `rootOf`, and `cascadeOf` → `ecs.relations.*` (the
      same name at the end, without the `Relation` part in the first four); `relationCount` →
      `relations.count`; `compactRelations()` → `relations.compact()` (§3).
- [ ] `registerEvent` → `events.register`; `registerSignal` → `events.registerSignal`; `emit` and
      `read` on the host → `events.emit` and `events.read` (§3).
- [ ] `registerResource` → `resources.register`; `resource` → `resources.get`; `setResource` →
      `resources.set`; `removeResource` → `resources.remove`; `hasResource` → `resources.has` (§3).
- [ ] `snapshot()` → `snapshots.capture()`; `restoreInto` → `snapshots.restore`; `snapshotSparse` →
      `snapshots.captureSparse`; `restoreSparse` → `snapshots.restoreSparse`; `stateHash` →
      `snapshots.stateHash`; `deterministic` → `snapshots.deterministic` (§3).
- [ ] `sourcesOf(def, tgt)` → `sourcesOf(tgt, def)`. **Change the places of the arguments** at each
      call site, on the host and on `ctx`. Do not trust a text search alone, because the old order
      fails with no signal in code that has no types (§4).
- [ ] `query.count()` → `query.entityCount` (a getter — remove the parentheses) (§5).
- [ ] `WorldRestoreError` → `ECSRestoreError`; `WORLD_SNAPSHOT_VERSION` → `ECS_SNAPSHOT_VERSION`
      (§5).
- [ ] Each import from the root of `HostCommandDispatcher`, a ring codec, `resolveECSMemory`, the
      codec for a packed `EntityID`, `accessCheck`, or `dispatchTrace` → `@oasys/oecs/internal`
      (§5).
- [ ] Examine each `onRemove` observer, and each `reactive-sync` bridge, for an entity that the host
      destroyed. An immediate `despawn` no longer runs `onRemove` (§1).
