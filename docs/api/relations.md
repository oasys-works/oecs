# Relations

A **relation** links two entities as a `(relation, target)` pair on a **source** entity — `addRelation(child, ChildOf, parent)`. Relations model hierarchies (scene graphs, bone trees), ownership, targeting ("this turret aims at that ship"), and instance-of links, with queries in both directions and configurable cleanup when a target dies.

Relations are stored in [sparse storage](./sparse-storage.md), so adding/removing one causes **no archetype transition** and consumes **no** dense-identity bit. All relation operations are **immediate** (not deferred) — they're safe mid-tick precisely because no dense row moves.

```ts
import { registerChildOf } from "@oasys/oecs";
const ChildOf = registerChildOf(ecs);           // built-in preset — a free function (see below)

const parent = ecs.createEntity();
const child  = ecs.createEntity();
ecs.addRelation(child, ChildOf, parent);

ecs.targetOf(child, ChildOf);      // parent
ecs.sourcesOf(ChildOf, parent);    // [child, …] — everyone whose parent is `parent`
```

## Registering a relation

```ts
registerRelation(opts?: RelationOptions): RelationDef;

interface RelationOptions {
  readonly exclusive?: boolean;   // one target per source (the default)
  readonly multi?: boolean;       // a target SET per source
  readonly onDeleteTarget?: "delete" | "clear" | "orphan";   // cleanup policy; default "orphan"
}
```

A relation is **exclusive** by default — one target per source, and a new `addRelation` **replaces** the old target. Pass `{ multi: true }` for a target *set* per source.

> [!WARNING]
> `exclusive` and `multi` are mutually exclusive — passing both throws. Choose one.

## Mutating relations

```ts
addRelation(src, def, tgt): this;          // exclusive replaces; multi adds to the set
removeRelation(src, def, tgt?): this;       // multi: omit tgt to remove ALL of src's targets
hasRelation(src, def): boolean;
```

> [!WARNING]
> On an **exclusive** relation, `addRelation` silently overwrites the previous target — there's no "already has a target" error. Both `src` and `tgt` must be alive (throws `ENTITY_NOT_ALIVE` in dev otherwise).

## Reading relations

```ts
targetOf(src, def): EntityID | undefined;   // single target (exclusive relations)
targetsOf(src, def): EntityID[];            // all targets, ascending by id
sourcesOf(def, tgt): EntityID[];            // reverse index: sources pointing at tgt, ascending
pairsOf(def): [EntityID, EntityID][];       // every (source, target) pair — the (R, *) wildcard, cold
sourcesOfAny(tgt): [RelationDef, EntityID][];  // every (relation, source) at tgt — the (*, T) wildcard, cold
```

- `targetOf` is for exclusive relations; on a multi relation it **throws `RELATION_MODE_MISMATCH` in dev** (and returns `undefined` in production) — use `targetsOf` for multi.
- `sourcesOf` is the workhorse reverse query — "who points at me?".

## Relation query terms

Compose relations into [queries](./queries.md). Because relation members scatter across archetypes, these queries iterate via `forEachEntity` / `forEachRelatedTo`, not the dense `forEach`/`eachChunk`.

```ts
withRelation(...defs): Query<Defs>;     // (R, *) — sources holding ANY target under R
withoutRelation(...defs): Query<Defs>;  // exclude them
forEachRelatedTo(target, cb): void;     // (*, T) — every source related to `target` under ANY relation
hierarchy(relation, maxDepth?): Query<Defs>;   // reorder matches into parent-before-child depth order
```

```ts
// "Every enemy that is a child of something" — (R, *):
ecs.query(Enemy).withRelation(ChildOf).forEachEntity((e) => { /* … */ });

// "Everyone targeting this boss" — (*, T):
bossQuery.forEachRelatedTo(boss, (attacker) => { /* … */ });
```

> [!IMPORTANT]
> **Wildcard queries require authorization** in the system's declarations, checked at iteration:
> - `withRelation(R)` needs `relationReads: [R]`.
> - `forEachRelatedTo` (the `(*, T)` wildcard) reads every relation's reverse index, so it needs `relationReads: [ANY_RELATION]` — plus `[R]` for any `withRelation(R)` you compose. `ANY_RELATION` does **not** subsume specific reads.
>
> These checks only fire *inside a system*; the same query run from host code skips them.

`hierarchy(relation, maxDepth?)` reorders the matched set into depth order (roots first, parents before children) over an **exclusive** relation, optionally dropping entities deeper than `maxDepth` (`HIERARCHY_UNBOUNDED` = no limit). It reorders and depth-limits; it doesn't change *which* entities match. Iterate with `forEachEntity`.

## Traversal helpers

For exclusive parent-chains (hierarchies), three eager helpers:

```ts
ancestorsOf(src, def): EntityID[];   // [src, parent, …, root] — nearest first
rootOf(src, def): EntityID;          // the chain root (src itself if it has no target)
cascadeOf(root, def): EntityID[];    // the subtree incl. root, breadth-first (parents before children)
```

> [!WARNING]
> Traversal is **exclusive-only** — a multi relation throws. A cycle throws `RELATION_CYCLE` in dev (never a hang).

## Built-in relations

Two presets over `registerRelation`, each fixing a cardinality and a cleanup default. Both are always exclusive.

```ts
import { registerChildOf, registerIsA } from "@oasys/oecs";
// Free functions — they take the ECS as their first argument (not methods on it):
registerChildOf(ecs: ECS, opts?: BuiltinRelationOptions): RelationDef;   // ChildOf(child → parent); default "delete"
registerIsA(ecs: ECS, opts?: BuiltinRelationOptions): RelationDef;       // IsA(instance → exemplar); default "clear"
interface BuiltinRelationOptions { readonly onDeleteTarget?: OnDeleteTarget }
```

- **`registerChildOf`** — hierarchy links. Its default `"delete"` policy means destroying a parent **cascade-destroys the whole subtree**.
- **`registerIsA`** — instance-of links. Records the link only; there is **no component inheritance** — an instance doesn't gain the exemplar's components. Its default `"clear"` drops the link but keeps instances alive when an exemplar is destroyed.

> [!CAUTION]
> `registerChildOf`'s default is a **cascading destroy**. Spawn a subtree, destroy the root, and everything under it is destroyed too. Pass `{ onDeleteTarget: "clear" }` to let children survive as new roots, or `"orphan"` to leave a dangling `targetOf`.

## Cleanup policies

`onDeleteTarget` decides what happens to a relation's **sources** when one of its **targets** is destroyed:

| Policy | Effect |
| --- | --- |
| `"delete"` | cascade — destroy every source too, recursively (`ChildOf` default) |
| `"clear"` | remove the relation from every source; sources survive (`IsA` default) |
| `"orphan"` | leave the link dangling; reads stay safe but `targetOf` returns a dead handle (the overall default) |

> [!WARNING]
> **`orphan` leaks the reverse index.** Under `orphan`, a destroyed target's reverse entries linger until each source re-targets or dies — a long-lived source that orphan-points at a churn of short-lived targets grows the reverse index unbounded, and `targetOf` returns a **dead handle** rather than `undefined`. Call `ecs.compactRelations()` (returns the count reclaimed) at scene/snapshot boundaries to drop reverse entries for destroyed targets. It changes no observable state and doesn't affect `stateHash`.

## Types & constants

```ts
type RelationDef;                 // the handle registerRelation returns
type OnDeleteTarget = "delete" | "clear" | "orphan";
const ANY_RELATION: RelationDef;  // authorization sentinel for (*, T) queries — list in relationReads
const HIERARCHY_UNBOUNDED: number; // = +Infinity, the default hierarchy maxDepth
```

## See also

- [sparse storage](./sparse-storage.md) — the mechanism relations are built on
- [queries](./queries.md) — how the relation terms fit the query verbs
- [systems](./systems.md) — `relationReads`/`relationWrites` declarations
- [determinism](./determinism.md) — relation targets are captured in snapshots in canonical order
