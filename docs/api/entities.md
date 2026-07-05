# Entities

An **entity** is an integer id (`EntityID`) — nothing more. It has no fields of its own; it's a key that components hang off of. You create one, attach components, and later destroy it.

```ts
const e = ecs.spawn();
ecs.addComponent(e, Pos, { x: 0, y: 0 });
ecs.addComponent(e, Vel, { vx: 1, vy: 0 });
ecs.isAlive(e);   // true
ecs.despawn(e);   // immediate — isAlive(e) is false on the next line
```

<a id="immediate-vs-deferred--the-one-thing-to-internalize"></a>

## Immediate vs deferred — the one thing to internalize

The receiver implies the mode. Everything on the host facade (`ecs.*`) applies **immediately**; structural ops inside a system (`ctx.commands.*`) are **deferred** to the phase flush:

| Operation | On `ecs` (host side) | On `ctx` / `ctx.commands` (inside a system) |
| --- | --- | --- |
| `spawn` | immediate (id returned now) | immediate id; bundle attaches land at the flush |
| `addComponent` / `removeComponent` | **immediate** | **deferred** to the phase flush |
| `despawn` | **immediate** | **deferred** to the phase flush |
| `disable` / `enable` | **immediate** | **deferred** to the phase flush |
| sparse & relation ops | immediate | immediate |

> [!IMPORTANT]
> Deferral inside systems is not a quirk — it's what keeps a live `forEach`/`eachChunk` loop from having entities move archetypes mid-iteration underneath it. Host-side mutations apply immediately (calling *any* immediate host structural mutator — `despawn`, `addComponent(s)`, `removeComponent(s)`, `batchAdd/RemoveComponent`, `disable`/`enable` — from *inside* a system body throws in dev, pointing at the `ctx.commands` equivalent), which cuts the other way on the host: a host-side `forEach`/`eachChunk` is live iteration, and structurally mutating an entity of an archetype you are walking throws `STRUCTURAL_DURING_ITERATION` in dev — collect ids during the walk, mutate after. Inside systems, structural ops live on [`ctx.commands`](./systems.md#ctxcommands--deferred-structural-ops), which is *always* deferred and reads that way at the call site.

Deferred work lands at the next **phase boundary** flush, or when you call `ecs.flush()` explicitly. See [schedule](./schedule.md).

Signatures for the host-side attach/detach surface — `addComponent`, `removeComponent`, the single-transition `addComponents`/`removeComponents`, and the whole-archetype `batchAddComponent`/`batchRemoveComponent` — live in [components → attach & detach](./components.md#attach--detach), along with `getField`/`tryGetField`.

## Creating entities

```ts
spawn(): EntityID;                                                           // empty entity
spawn<Defs>(template: Template<Defs>, overrides?: TemplateOverrides<Defs>): EntityID;
spawnMany<Defs>(template: Template<Defs>, count: number, overrides?: TemplateOverrides<Defs>): EntityID[];  // bulk
spawnBundle(...items: BundleOrDef[]): EntityID;                              // varargs bundles
```

- **`spawn()`** — an empty entity in the empty archetype. Add components afterward.
- **`spawn(template, overrides?)`** — land directly in a template's archetype with **zero archetype transitions**, applying optional per-field overrides.
- **`spawnMany(template, count, overrides?)`** — bulk-spawn `count` identical entities, with one optional shared `overrides` object applied to every row. Field writes are `O(columns)` (one `fill` per column), not `O(count × columns)`. Returns ids in spawn order.
- **`spawnBundle(...)`** — immediate host-side spawn from [bundles](./components.md#the-handle-is-callable--bundles): `ecs.spawnBundle(Pos({ x, y }), Vel({ vx: 1 }), IsEnemy)`. The host analog of `ctx.commands.spawn`; it currently applies each bundle through the normal immediate add path, so use templates when you need zero-transition spawns.

## Templates

A **template** resolves a component set + default values to a target archetype **once**, so every later spawn from it skips the per-component archetype transitions.

```ts
template<Defs>(entries: TemplateEntries<Defs>): Template<Defs>;

const Bullet = ecs.template([
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 0, vy: 0 } },
]);

const b = ecs.spawn(Bullet, { x: 5, y: 10 });   // flat per-field overrides
const swarm = ecs.spawnMany(Bullet, 500);   // 500 bullets, O(columns) writes
```

> [!TIP]
> Templates pay off for **multi-component** entities and **bulk** spawns. A single-component template is no faster than `spawn()` + `addComponent()`, which already bump-allocates into the target archetype. Registering templates up front also *prewarms* their archetypes — required if you plan to restore a [snapshot](./determinism.md) with `ecs.snapshots.restore`.

## Destroying entities

```ts
despawn(id: EntityID): void;   // IMMEDIATE on the host facade
isAlive(id: EntityID): boolean;
```

`despawn` destroys the entity immediately — `isAlive(id)` is `false` on the next line, matching the immediacy of every other host facade mutation. Inside a system, use `ctx.commands.despawn`, which defers to the phase flush (calling `ecs.despawn` from a system body throws in dev). `isAlive` is a **generational** check: a stale handle to a recycled slot, a retired slot, or an out-of-range id all read dead.

<a id="enable--disable"></a>

## Enable / disable

Disabling an entity hides it from queries **without** removing its data or changing its id.

```ts
disable(id: EntityID): this;        // immediate on the host facade; idempotent
enable(id: EntityID): this;         // immediate on the host facade; idempotent
isDisabled(id: EntityID): boolean;
```

A disabled entity keeps its components, relations, sparse data, and stable `EntityID`, but is skipped by default queries — it sits in the **disabled tail** of its archetype, so `arch.entityCount` excludes it. There's no archetype transition; toggling is a single row swap. Re-include disabled entities in a query with [`.includeDisabled()`](./queries.md).

> [!NOTE]
> A disabled entity must hold **at least one component** — a component-less entity has no archetype row to partition.

> [!WARNING]
> An **immediate** `ecs.disable()` / `ecs.enable()` fires **no** `onDisable`/`onEnable` [observer](./observers.md) — only the **deferred** `ctx.commands.disable()` / `ctx.commands.enable()` (which drain at the flush) do.

## The `EntityID` codec

An `EntityID` is a branded 31-bit number packing a **20-bit slot index** and an **11-bit generation**: `[generation:11][index:20]`. The generation is what makes stale handles detectable — recycling a slot bumps its generation, so an old id no longer matches.

You rarely touch the codec; it's exposed for snapshot/replication paths that decode handles from semi-trusted bytes. `getEntityIndex` is exported from the package root; the rest of the codec (`createEntityId`, `getEntityGeneration`, and the bounds constants) lives at **`@oasys/oecs/internal`** (unstable — no semver guarantees).

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
> `createEntityId` and `getEntityIndex` do **no** aliveness check — the generational guard is the caller's job. `createEntityId` throws on out-of-range args **in dev only**; in production the checks are gone and it silently wraps. Use `MAX_ENTITY_ID` to bounds-check any handle you decoded from a snapshot or `postMessage` before it indexes a slot. For normal code, get ids from `spawn` and never touch the codec.

> [!NOTE]
> `RETIRED_GENERATION` (2047) is a reserved tombstone. A slot that exhausts its 11-bit generation counter is **retired**, not recycled, which closes the ABA stale-handle window. Live generations only ever range `0..2046`.

## See also

- [components](./components.md) — what you attach to entities
- [systems](./systems.md) — the deferred `ctx.commands` write surface
- [queries](./queries.md) — `.includeDisabled()` and iteration
- [relations](./relations.md) — linking entities with `(relation, target)` pairs
