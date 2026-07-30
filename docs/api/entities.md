# Entities

An **entity** is an integer id (`EntityID`) and nothing more. It has no fields of its own. It is a
key, and components attach to it. You create an entity, you attach components, and later you
destroy it.

```ts
const e = ecs.spawn();
ecs.addComponent(e, Pos, { x: 0, y: 0 });
ecs.addComponent(e, Vel, { vx: 1, vy: 0 });
ecs.isAlive(e);   // true
ecs.despawn(e);   // immediate — isAlive(e) is false on the next line
```

<a id="immediate-vs-deferred--the-one-thing-to-internalize"></a>

## Immediate and deferred — the most important rule

The receiver tells you the timing. Each operation on the host facade (`ecs.*`) applies
**immediately**. Each structural operation in a system (`ctx.commands.*`) is **deferred** to the
flush at the end of the phase.

| Operation | On `ecs` (the host) | On `ctx` or `ctx.commands` (in a system) |
| --- | --- | --- |
| `spawn` | immediate (you get the id now) | the id is immediate; the bundles attach at the flush |
| `addComponent` / `removeComponent` | **immediate** | **deferred** to the flush at the end of the phase |
| `despawn` | **immediate** | **deferred** to the flush at the end of the phase |
| `disable` / `enable` | **immediate** | **deferred** to the flush at the end of the phase |
| sparse and relation operations | immediate | immediate |

> [!IMPORTANT]
> Deferral in a system is not an accident. It is the mechanism that prevents an entity from moving
> to a different archetype during a live `forEach` or `eachChunk` loop. In a system, the structural
> operations are on [`ctx.commands`](./systems.md#ctxcommands--deferred-structural-ops). They are
> *always* deferred, and the call site reads that way.
>
> Two dev-mode guards protect the immediate host operations:
>
> - If you call an immediate host mutator from **inside** a system body, it throws, and the message
>   names the `ctx.commands` equivalent. This covers `spawn`, `spawnBundle`, `spawnMany`,
>   `despawn`, `addComponent`, `addComponents`, `removeComponent`, `removeComponents`,
>   `batchAddComponent`, `batchRemoveComponent`, `disable`, and `enable`.
> - A `forEach` or `eachChunk` walk on the host is also live iteration. If you structurally mutate
>   an entity of an archetype that you walk, it throws `STRUCTURAL_DURING_ITERATION`. Collect the
>   ids during the walk, then mutate after it.

Deferred work applies at the next **phase boundary** flush, or when you call `ecs.flush()`
yourself. See [schedule](./schedule.md).

The signatures of the attach and detach surface on the host are in
[components → attach and detach](./components.md#attach--detach), together with `getField` and
`tryGetField`. They are `addComponent`, `removeComponent`, the single-transition `addComponents`
and `removeComponents`, and the full-archetype `batchAddComponent` and `batchRemoveComponent`.

## How to create entities

```ts
spawn(): EntityID;                                                           // empty entity
spawn<Defs>(template: Template<Defs>, overrides?: TemplateOverrides<Defs>): EntityID;
spawnMany<Defs>(template: Template<Defs>, count: number, overrides?: TemplateOverrides<Defs>): EntityID[];  // bulk
spawnBundle(...items: BundleOrDef[]): EntityID;                              // bundles as varargs
```

- **`spawn()`** gives you an empty entity in the empty archetype. Add the components after it.
- **`spawn(template, overrides?)`** puts the entity directly in the archetype of the template, with
  **no archetype transition**. It applies the optional replacement values for each field.
- **`spawnMany(template, count, overrides?)`** creates `count` identical entities. One optional
  `overrides` object applies to each row. The cost of the field writes is `O(columns)`, which is
  one `fill` for each column, and not `O(count × columns)`. It gives the ids in the order of
  creation.
- **`spawnBundle(...)`** is an immediate spawn on the host from
  [bundles](./components.md#the-handle-is-callable--bundles):
  `ecs.spawnBundle(Pos({ x, y }), Vel({ vx: 1 }), IsEnemy)`. It is the host equivalent of
  `ctx.commands.spawn`. Today it applies each bundle through the usual immediate add path. So you
  must use a template when you need a spawn with no transition.

## Templates

A **template** resolves a set of components and their default values to one target archetype
**one time**. Each later spawn from that template then does no archetype transition for each
component.

```ts
template<Items extends readonly BundleOrDef[]>(...items: StrictBundles<Items>): Template<DefsOf<Items>>;

const Bullet = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 0, vy: 0 }));

const b = ecs.spawn(Bullet, { x: 5, y: 10 });   // flat replacement values for each field
const swarm = ecs.spawnMany(Bullet, 500);   // 500 bullets, O(columns) writes
```

> [!TIP]
> Templates give a benefit for entities with **several components**, and for **bulk** spawns. A
> template with one component gives no benefit, because `spawn()` with `addComponent()` already
> allocates the row directly in the target archetype. Registration of your templates at the start
> also *prepares* their archetypes. This preparation is necessary before you restore a
> [snapshot](./determinism.md) with `ecs.snapshots.restore`.

## How to destroy entities

```ts
despawn(id: EntityID): void;   // IMMEDIATE on the host facade
isAlive(id: EntityID): boolean;
```

`despawn` destroys the entity immediately. `isAlive(id)` is `false` on the next line, which agrees
with each other mutation on the host facade. In a system, use `ctx.commands.despawn`, which defers
to the flush at the end of the phase. A call to `ecs.despawn` in a system body throws in
development. `isAlive` is a check of the **generation**. It reads as not alive for a stale handle
to a recycled slot, for a retired slot, and for an id that is out of range.

<a id="enable--disable"></a>

## Enable and disable

If you disable an entity, queries do not see it, but it keeps its data and its id.

```ts
disable(id: EntityID): this;        // immediate on the host facade; you can call it again safely
enable(id: EntityID): this;         // immediate on the host facade; you can call it again safely
isDisabled(id: EntityID): boolean;
```

A disabled entity keeps its components, its relations, its sparse data, and its stable `EntityID`.
Default queries skip it. It stays in the **disabled part** at the end of its archetype, so
`arch.entityCount` does not count it. There is no archetype transition, because a change of state
is one row swap. To include disabled entities in a query, use
[`.includeDisabled()`](./queries.md).

> [!NOTE]
> A disabled entity must hold **one component or more**. An entity with no component has no
> archetype row to divide.

> [!WARNING]
> An **immediate** `ecs.disable()` or `ecs.enable()` runs **no** `onDisable` or `onEnable`
> [observer](./observers.md). Only the **deferred** `ctx.commands.disable()` and
> `ctx.commands.enable()` run them, because they apply at the flush.

## The `EntityID` codec

An `EntityID` is a 31-bit number with a brand. It contains a **20-bit slot index** and an **11-bit
generation**, in the layout `[generation:11][index:20]`. The generation is what makes a stale
handle detectable, because a recycled slot increases its generation. An old id then does not agree
with the slot.

You rarely use the codec. It is public for the snapshot and replication paths, which decode handles
from bytes that they do not fully trust. The package root exports `getEntityIndex`. The remainder
of the codec (`createEntityId`, `getEntityGeneration`, and the bounds constants) is at
**`@oasys/oecs/internal`**, which is unstable and has no semver guarantees.

```ts
getEntityIndex(id: EntityID): number;                     // low 20 bits (dense slot)
getEntityGeneration(id: EntityID): number;                // high 11 bits
createEntityId(index: number, generation: number): EntityID;   // pack (inverse of the above)

const MAX_INDEX = 1_048_575;        // 2^20 − 1
const MAX_GENERATION = 2047;        // 2^11 − 1
const RETIRED_GENERATION = 2047;    // tombstone — never issued to a live entity
const MAX_LIVE_GENERATION = 2046;
const MAX_ENTITY_ID = 0x7FFFFFFF;   // largest valid packed id
```

> [!WARNING]
> `createEntityId` and `getEntityIndex` do **no** liveness check. The generation check is your
> task. `createEntityId` throws for an argument that is out of range **in development only**. In
> production those checks are absent, and the value wraps quietly. Use `MAX_ENTITY_ID` to check the
> bounds of each handle that you decoded from a snapshot or from `postMessage`, before it indexes a
> slot. In normal code, get each id from `spawn` and never use the codec.

> [!NOTE]
> `RETIRED_GENERATION` (2047) is a reserved tombstone. A slot that uses all of its 11-bit
> generation counter is **retired**, and not recycled. This closes the ABA problem for a stale
> handle. A live generation is always in the range 0 to 2046.

## See also

- [components](./components.md) — what you attach to an entity
- [systems](./systems.md) — the deferred write surface, `ctx.commands`
- [queries](./queries.md) — `.includeDisabled()` and iteration
- [relations](./relations.md) — how to link entities with `(relation, target)` pairs
