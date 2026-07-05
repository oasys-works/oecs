# Migrating oecs 0.4 → 0.5

0.5 unifies the lifecycle vocabulary and moves the secondary surfaces onto grouped facades. The
organizing rule: **the receiver implies the timing** — `ecs.*` is immediate, `ctx.commands.*` is
deferred to the phase flush. These are hard renames with **no deprecation aliases**, but they
cluster into a handful of mechanical rules:

1. **Lifecycle verbs** — `createEntity` → `spawn`, `createEntities` → `spawnMany`,
   `destroyEntity` → `despawn` — and host `despawn` is now **immediate**, not deferred (§1).
2. **Inside systems** — every bare deferred duplicate is removed (`ctx.createEntity`,
   `ctx.destroyEntity`, `ctx.addComponent`, `ctx.removeComponent`, `ctx.disable`, `ctx.enable`);
   deferred structural ops in a system body live only on `ctx.commands` (§2).
3. **Grouped facades** — 29 flat methods move onto `ecs.relations` / `ecs.events` /
   `ecs.resources` / `ecs.snapshots`, a few renaming in the move (`snapshot` → `capture`,
   `restoreInto` → `restore`, `resource` → `get`, …) (§3).
4. **`sourcesOf` argument order flipped** to `(entity, def)` — a silent behavior change at
   untyped call sites, the compiler catches typed ones (§4).
5. **Small renames** — `query.count()` → `query.entityCount` getter; `WorldRestoreError` →
   `ECSRestoreError`; `WORLD_SNAPSHOT_VERSION` → `ECS_SNAPSHOT_VERSION`; `DestroyEntityArg` →
   `DespawnArg` (§5).

Everything else — host component ops (`addComponent`, `getField`, `hasComponent`, …), queries,
iteration (`forEach` / `eachChunk`), sparse ops, observers, the schedule, and the system-side
data/event/resource surface (`ctx.emit`, `ctx.read`, `ctx.resource`, `ctx.ref`, `ctx.setField`,
`ctx.addSparse`, `ctx.addRelation`, …) — is unchanged. (Docs now spell the receiver
`const ecs = new ECS()` instead of `world`; that is prose only, your variable name is your own.)

---

## 1. Entity lifecycle — `spawn` / `despawn`, and host `despawn` is now immediate

| 0.4 | 0.5 |
| --- | --- |
| `ecs.createEntity()` | `ecs.spawn()` |
| `ecs.createEntity(template, overrides?)` | `ecs.spawn(template, overrides?)` |
| `ecs.createEntities(template, count)` | `ecs.spawnMany(template, count, overrides?)` |
| `ecs.destroyEntity(e)` *(deferred)* | `ecs.despawn(e)` — **now immediate** |
| `DestroyEntityArg` (type) | `DespawnArg` |

`ecs.spawnBundle(...)` keeps its name. `spawnMany` gains an optional third parameter — one
shared `TemplateOverrides<Defs>` object applied to every spawned row (contiguous batches use one
`fill` per overridden column).

> **The rename carries a semantic change.** In 0.4, host `destroyEntity` was *deferred* — the
> entity stayed alive until the next phase flush, even though host `addComponent` was immediate.
> In 0.5, host `despawn` is **immediate**: the entity is dead on the next line.

```ts
// 0.4 — destroyEntity was deferred to the phase flush
ecs.destroyEntity(e);
ecs.isAlive(e);   // still true here — death lands at the flush
ecs.flush();
ecs.isAlive(e);   // false

// 0.5 — despawn is immediate from the host
ecs.despawn(e);
ecs.isAlive(e);   // false, immediately
```

If your 0.4 code relied on the deferred window — destroy an entity, then keep reading it until
the flush — that code now reads a dead entity and dev-throws `ENTITY_NOT_ALIVE`. Reorder the
reads before the `despawn`, or use the explicitly deferred `ctx.commands.despawn` from inside a
system (§2).

Because an immediate destroy mid-iteration can invalidate rows a running query is walking,
**calling `ecs.despawn` from inside a system body throws in dev**, pointing you at
`ctx.commands.despawn`. The same dev guard covers every immediate host structural mutator —
`addComponent`/`addComponents`, `removeComponent`/`removeComponents`,
`batchAddComponent`/`batchRemoveComponent`, `disable`/`enable` — each pointing at its
`ctx.commands` equivalent. Host-side calls (setup, event handlers, between updates) are the
intended use.

---

## 2. Inside systems — `ctx.commands` is the only deferred surface

Every bare deferred duplicate on the context is gone — not just the lifecycle pair:

| 0.4 | 0.5 |
| --- | --- |
| `ctx.createEntity()` | `ctx.commands.spawn()` |
| `ctx.destroyEntity(e)` | `ctx.commands.despawn(e)` |
| `ctx.addComponent(e, def, values?)` | `ctx.commands.add(e, def, values)` — same complete-values typing — or the bundle form `ctx.commands.add(e, def({ … }))` |
| `ctx.removeComponent(e, def)` | `ctx.commands.remove(e, def)` |
| `ctx.disable(e)` | `ctx.commands.disable(e)` |
| `ctx.enable(e)` | `ctx.commands.enable(e)` |

`ctx.isDisabled(e)` stays on the context — it is an immediate *read*, not a buffered op. The
immediate sparse/relation ops (`ctx.addSparse`, `ctx.addRelation`, …) also stay: they cause no
archetype transition, which is the whole reason they are safe to apply mid-system.

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

`ctx.commands` (the Bevy-`Commands`-style facade from 0.4) keeps its verbs — `spawn` / `add` /
`remove` / `despawn` / `disable` / `enable`, all deferred to the phase flush — and `add` gains
the explicit complete-values shape (`ctx.commands.add(e, Pos, { x: 0, y: 0 })`) that the removed
`ctx.addComponent` carried, so the compile-checked attach path survives the move. The end state
declared in 0.4 is now real: **host verbs are immediate, `ctx.commands` verbs are deferred**,
with no third option.

---

## 3. Grouped facades — `ecs.relations` / `ecs.events` / `ecs.resources` / `ecs.snapshots`

29 flat methods moved off the `ECS` class onto four narrow facades. Each maps 1:1; a few rename
in the move (right-hand column). The hot path — component ops, queries, spawn/despawn, sparse
ops — stays flat by design, and the **system-side `ctx.*` names are unchanged** (`ctx.emit`,
`ctx.read`, `ctx.resource`, `ctx.setResource`, `ctx.addRelation`, `ctx.sourcesOf`, …).

### Relations (14)

| 0.4 | 0.5 |
| --- | --- |
| `ecs.registerRelation(opts?)` | `ecs.relations.register(opts?)` |
| `ecs.addRelation(src, def, tgt)` | `ecs.relations.add(src, def, tgt)` |
| `ecs.removeRelation(src, def, tgt?)` | `ecs.relations.remove(src, def, tgt?)` |
| `ecs.hasRelation(src, def)` | `ecs.relations.has(src, def)` |
| `ecs.targetOf(src, def)` | `ecs.relations.targetOf(src, def)` |
| `ecs.targetsOf(src, def)` | `ecs.relations.targetsOf(src, def)` |
| `ecs.sourcesOf(def, tgt)` | `ecs.relations.sourcesOf(tgt, def)` — **args swapped**, see §4 |
| `ecs.pairsOf(def)` | `ecs.relations.pairsOf(def)` |
| `ecs.sourcesOfAny(tgt)` | `ecs.relations.sourcesOfAny(tgt)` |
| `ecs.ancestorsOf(src, def)` | `ecs.relations.ancestorsOf(src, def)` |
| `ecs.rootOf(src, def)` | `ecs.relations.rootOf(src, def)` |
| `ecs.cascadeOf(root, def)` | `ecs.relations.cascadeOf(root, def)` |
| `ecs.relationCount` (getter) | `ecs.relations.count` (getter) |
| `ecs.compactRelations()` | `ecs.relations.compact()` |

The standalone preset helpers `registerChildOf(ecs)` / `registerIsA(ecs)` keep their names and
import path — they were never methods.

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

### Snapshots / determinism (6)

| 0.4 | 0.5 |
| --- | --- |
| `ecs.snapshot()` | `ecs.snapshots.capture()` |
| `ecs.restoreInto(bytes)` | `ecs.snapshots.restore(bytes)` |
| `ecs.snapshotSparse()` | `ecs.snapshots.captureSparse()` |
| `ecs.restoreSparse(bytes)` | `ecs.snapshots.restoreSparse(bytes)` |
| `ecs.stateHash()` | `ecs.snapshots.stateHash()` |
| `ecs.deterministic` (getter) | `ecs.snapshots.deterministic` (getter) |

Put together:

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

The facades mirror the compile-time typestate surface exactly (cardinality-stamped
`relations.register`, exclusive-only traversal on `targetOf` / `ancestorsOf` / `rootOf` /
`cascadeOf`). The facade classes are exported **type-only** (`ECSRelations`, `ECSEvents`,
`ECSResources`, `ECSSnapshots`); the runtime export list is unchanged.

---

## 4. `sourcesOf` argument order — `(def, tgt)` → `(tgt, def)`

`sourcesOf` was the one argument-order outlier on the relation surface — `targetOf(src, def)` /
`targetsOf(src, def)` / `sourcesOfAny(tgt)` all lead with the entity. 0.5 canonicalizes it to
`(entity, def)` on **both** `ecs.relations.sourcesOf` and the system-side `ctx.sourcesOf`:

```ts
// 0.4
const children = ecs.sourcesOf(ChildOf, parent);
const inCtx    = ctx.sourcesOf(ChildOf, parent);

// 0.5
const children = ecs.relations.sourcesOf(parent, ChildOf);
const inCtx    = ctx.sourcesOf(parent, ChildOf);
```

> **This is a silent behavior change at untyped call sites.** `RelationDef` and `EntityID` are
> both branded *numbers* at runtime, so an unmigrated `(def, tgt)` call reaching 0.5 through
> plain JS, an `any`, or a cast does **not** throw — it queries a nonsense (relation, entity)
> pair and returns wrong (typically empty) results. TypeScript flags the swap at typed call
> sites via the brands, but audit every `sourcesOf` caller rather than trusting a green build.

---

## 5. Small renames

- **`query.count()` → `query.entityCount`** — a getter, sitting beside the existing
  `archetypeCount` getter:

  ```ts
  // 0.4
  if (movers.count() === 0) return;

  // 0.5
  if (movers.entityCount === 0) return;
  ```

- **`WorldRestoreError` → `ECSRestoreError`** and **`WORLD_SNAPSHOT_VERSION` →
  `ECS_SNAPSHOT_VERSION`** — the last `World*`-prefixed exports join the `ECS*` vocabulary
  (`ECSOptions`, `ECSError`, …). Thrown by / tags for the `ecs.snapshots` surface (§3).
- **`DestroyEntityArg` → `DespawnArg`** — the `ctx.commands.despawn` parameter type follows the
  verb rename (§1).

---

## 6. New, opt-in surface (no migration required)

Additive — nothing in your 0.4 code needs these, but they retire common workarounds. Adopt as
useful:

- **`addComponent` bundle overload** — `ecs.addComponent(e, Pos({ x: 1 }))` accepts a callable
  bundle with the usual zero-fill semantics; the explicit `(e, def, values)` form stays
  complete-values, so a missing field there is still a compile error.
- **Total probes + `tryGetField`** — `hasComponent` / `hasSparse` / `relations.has` now return
  `false` for a dead entity instead of dev-throwing (a "has" probe is exactly the call you make
  to avoid dead entities); `ecs.tryGetField(e, def, field)` returns `undefined` for a dead
  entity or missing component.
- **`query.firstEntity()` / `query.singleEntity()`** — singleton reads (player, camera) without
  a hand-rolled `forEach` + capture; `singleEntity` dev-throws `QUERY_NOT_SINGLETON` on 0 or >1
  matches.
- **Host-side `ecs.refRead(def, e)`** — whole-component read-only view, parity with
  `ctx.refRead`.
- **Run-condition combinators** — `not()` / `allOf()` / `anyOf()` compose `RunCondition`s,
  merging the operands' declared read surfaces.
- **Editor change notification** — `editor.onChange(cb)` (fires on commit/undo/redo/clear) plus
  `canUndo` / `canRedo` getters; no more per-frame `depths()` polling.
- **`using` support** — `ObserverHandle` implements `Symbol.dispose`, so
  `using h = ecs.observe(Pos, { onAdd })` unsubscribes at scope exit.
- **Component debug names** — `registerComponent(schema, { name: "Pos" })` labels dev-mode
  errors `'Pos' (component 5)` instead of leaving you to count registration order.
- **Compile-time typestate** — the config-form `registerSystem` now infers `reads` / `writes`
  as literal types and narrows `ctx` to exactly the declared surface, so undeclared access is a
  *compile* error (the dev-mode runtime check remains as backstop). Query columns are typed by
  the query's terms, relation handles carry their cardinality (`RelationDef<"exclusive">` vs
  `"multi"`), and resource/event keys are invariant. Existing correct code compiles as-is;
  code that under-declared access now fails at compile time instead of at dev runtime.
- **Write-seam lifecycle** — `uninstallHostCommandSeam(world, queue)`,
  `HostCommandQueue.clear()`, `HostCommandDispatcher.off(opCode)`,
  `HostCommandRecorder.snapshotLog()`.
- **`VERSION` export** and a `"./package.json"` export.

---

## Quick checklist

Every 0.4 name below is grep-able; none has an alias in 0.5.

- [ ] `createEntity` → `spawn`; `createEntities` → `spawnMany` (§1).
- [ ] `destroyEntity` → `despawn` — then audit each host call site: despawn is now **immediate**,
      so nothing may read the entity between `despawn` and the old flush point (§1).
- [ ] `ctx.createEntity()` → `ctx.commands.spawn()`; `ctx.destroyEntity(e)` →
      `ctx.commands.despawn(e)` (§2).
- [ ] `registerRelation` / `addRelation` / `removeRelation` / `hasRelation` / `targetOf` /
      `targetsOf` / `pairsOf` / `sourcesOfAny` / `ancestorsOf` / `rootOf` / `cascadeOf` →
      `ecs.relations.*` (same trailing name, minus the `Relation` infix on the first four);
      `relationCount` → `relations.count`; `compactRelations()` → `relations.compact()` (§3).
- [ ] `registerEvent` → `events.register`; `registerSignal` → `events.registerSignal`;
      host `emit` / `read` → `events.emit` / `events.read` (§3).
- [ ] `registerResource` → `resources.register`; `resource` → `resources.get`; `setResource` →
      `resources.set`; `removeResource` → `resources.remove`; `hasResource` → `resources.has` (§3).
- [ ] `snapshot()` → `snapshots.capture()`; `restoreInto` → `snapshots.restore`;
      `snapshotSparse` → `snapshots.captureSparse`; `restoreSparse` → `snapshots.restoreSparse`;
      `stateHash` → `snapshots.stateHash`; `deterministic` → `snapshots.deterministic` (§3).
- [ ] `sourcesOf(def, tgt)` → `sourcesOf(tgt, def)` — **swap the arguments** at every call site,
      host and `ctx`; do not trust grep alone, the old order fails silently in untyped code (§4).
- [ ] `query.count()` → `query.entityCount` (getter — drop the parens) (§5).
- [ ] `WorldRestoreError` → `ECSRestoreError`; `WORLD_SNAPSHOT_VERSION` →
      `ECS_SNAPSHOT_VERSION`; `DestroyEntityArg` → `DespawnArg` (§5).
