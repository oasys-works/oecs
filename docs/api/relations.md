# Relations

> [!NOTE]
> **0.5.0 — a grouped surface.** The registration, mutation, reads, wildcards, traversal, and
> compaction of a relation are on the **`ecs.relations`** facade: `ecs.relations.register()`,
> `ecs.relations.add(child, ChildOf, parent)`, `ecs.relations.targetOf(child, ChildOf)`,
> `ecs.relations.ancestorsOf(...)`, and `ecs.relations.compact()`. Also, `relationCount` is
> `ecs.relations.count`, `hasRelation` is `ecs.relations.has`, and `compactRelations` is
> `ecs.relations.compact`. Version 0.5.0 **removed** the flat `ecs.*` forms of 0.4 and earlier.

A **relation** links two entities as a `(relation, target)` pair on a **source** entity:
`ecs.relations.add(child, ChildOf, parent)`. Relations model hierarchies (scene graphs and bone
trees), ownership, targets ("this turret aims at that ship"), and instance-of links. You can query
them in both directions, and you can configure the cleanup when a target is destroyed.

The engine keeps a relation in [sparse storage](./sparse-storage.md). So an add or a remove
causes **no archetype transition**, and it uses **no** bit of the dense identity. Each relation
operation is **immediate**, and not deferred. They are safe during a tick for exactly that reason:
no dense row moves.

```ts
import { registerChildOf } from "@oasys/oecs";
const ChildOf = registerChildOf(ecs);           // a supplied preset — a free function (see below)

const parent = ecs.spawn();
const child  = ecs.spawn();
ecs.relations.add(child, ChildOf, parent);

ecs.relations.targetOf(child, ChildOf);      // parent
ecs.relations.sourcesOf(parent, ChildOf);    // [child, …] — each entity whose parent is `parent`
```

## How to register a relation

```ts
ecs.relations.register(opts?: RelationOptions): RelationDef;
// The overloads put the cardinality into the type of the handle when the options are
// known statically: RelationDef<"exclusive"> (the default) or RelationDef<"multi">.

type RelationOptions =
  | { readonly exclusive?: true; readonly multi?: false;
      readonly onDeleteTarget?: OnDeleteTarget }    // one target for each source (the default)
  | { readonly multi: true; readonly exclusive?: false;
      readonly onDeleteTarget?: OnDeleteTarget };   // a SET of targets for each source
// onDeleteTarget: "delete" | "clear" | "orphan" — the cleanup policy; the default is "orphan"
```

A relation is **exclusive** by default: there is one target for each source, and a new `add`
**replaces** the old target. Give `{ multi: true }` for a *set* of targets for each source.

> [!WARNING]
> You must not set `exclusive` and `multi` together. The discriminated union makes
> `{ exclusive: true, multi: true }` a **compile error**, and it also throws at run time for a
> caller in JavaScript. Select one.

## How to mutate relations

Each function is on the `ecs.relations` facade:

```ts
add(src, def, tgt): this;          // exclusive replaces the target; multi adds to the set
remove(src, def, tgt?): this;      // multi: give no tgt to remove ALL the targets of src
has(src, def): boolean;
```

> [!WARNING]
> On an **exclusive** relation, `add` writes over the earlier target with no signal. There is no
> "this source already has a target" error. Both `src` and `tgt` must be alive, or it throws
> `ENTITY_NOT_ALIVE` in development.

## How to read relations

```ts
targetOf(src, def): EntityID | undefined;   // one target (an exclusive relation)
targetsOf(src, def): EntityID[];            // each target, ascending by id
sourcesOf(tgt, def): EntityID[];            // the reverse index: the sources that point at tgt, ascending
pairsOf(def): [EntityID, EntityID][];       // each (source, target) pair — the (R, *) wildcard, low frequency
sourcesOfAny(tgt): [RelationDef, EntityID][];  // each (relation, source) at tgt — the (*, T) wildcard, low frequency
```

- `targetOf` is for an exclusive relation, and the compiler holds you to that.
  `ecs.relations.register` puts the cardinality into the type of the handle
  (`RelationDef<"exclusive">` or `RelationDef<"multi">`). So `targetOf(src, aMultiRelation)` is a
  **compile error**. The development-mode throw `RELATION_MODE_MISMATCH` remains as the alternative
  protection for a relation that you register dynamically, because its handle carries the
  `RelationDef` union with no cardinality. For a multi relation, use `targetsOf`.
- `sourcesOf` is the primary reverse query: "which entities point at me?".

## Query terms for relations

You can compose a relation into a [query](./queries.md). The members of a relation are distributed
across the archetypes. So these queries iterate with `forEachEntity` or `forEachRelatedTo`, and
not with the dense `forEach` or `eachChunk`.

```ts
withRelation(...defs): Query<Defs>;     // (R, *) — sources that hold ANY target under R
withoutRelation(...defs): Query<Defs>;  // remove those sources
forEachRelatedTo(target, cb): void;     // (*, T) — each source related to `target` under ANY relation
hierarchy(relation, maxDepth?): Query<Defs>;   // put the matches in parent-before-child depth order
```

```ts
// "Each enemy that is a child of something" — (R, *):
ecs.query(Enemy).withRelation(ChildOf).forEachEntity((e) => { /* … */ });

// "Each entity that targets this boss" — (*, T):
bossQuery.forEachRelatedTo(boss, (attacker) => { /* … */ });
```

> [!IMPORTANT]
> **A wildcard query needs authorization** in the declarations of the system. The engine checks
> that authorization at iteration:
> - `withRelation(R)` needs `relationReads: [R]`.
> - `forEachRelatedTo` (the `(*, T)` wildcard) reads the reverse index of each relation. So it
>   needs `relationReads: [ANY_RELATION]`, plus `[R]` for each `withRelation(R)` that you compose.
>   `ANY_RELATION` does **not** include the specific reads.
>
> These checks apply *inside a system* only. The same query from host code does not do them.

`hierarchy(relation, maxDepth?)` puts the matched set in depth order over an **exclusive** relation:
the roots first, and each parent before its children. It can also remove each entity deeper than
`maxDepth` (`HIERARCHY_UNBOUNDED` means no limit). Apart from that optional depth limit, it does
not require an entity to carry the relation. An entity with no parent in that relation is a root at
depth 0, and it is still part of the result. Iterate with `forEachEntity`.

## Traversal helpers

For exclusive parent chains (hierarchies), there are three helpers that calculate the full result
immediately:

```ts
ancestorsOf(src, def): EntityID[];   // [src, parent, …, root] — the nearest first
rootOf(src, def): EntityID;          // the root of the chain (src itself when it has no target)
cascadeOf(root, def): EntityID[];    // the subtree with the root, breadth first (parents before children)
```

> [!WARNING]
> Traversal operates on an **exclusive relation only**. The helpers accept only
> `RelationDef<"exclusive">`. So a multi relation that you register statically is a compile
> error, and a multi relation that you register dynamically throws in development. A cycle throws
> `RELATION_CYCLE` in development, and it never stops the program.

## The supplied relations

There are two presets over `ecs.relations.register`. Each one sets a cardinality and a default
cleanup policy. Both are always exclusive.

```text
import { registerChildOf, registerIsA } from "@oasys/oecs";
// Free functions — the ECS is their first argument (they are not methods on it):
registerChildOf(ecs: ECS, opts?: BuiltinRelationOptions): RelationDef<"exclusive">;   // ChildOf(child → parent); default "delete"
registerIsA(ecs: ECS, opts?: BuiltinRelationOptions): RelationDef<"exclusive">;       // IsA(instance → exemplar); default "clear"
interface BuiltinRelationOptions { readonly onDeleteTarget?: OnDeleteTarget }
```

- **`registerChildOf`** makes hierarchy links. Its default policy of `"delete"` means that a
  destroyed parent **destroys the full subtree**.
- **`registerIsA`** makes instance-of links. It records the link only. There is **no inheritance of
  components**: an instance does not get the components of its exemplar. Its default of `"clear"`
  removes the link, but it keeps the instances alive when you destroy an exemplar.

> [!CAUTION]
> The default of `registerChildOf` **destroys the subtree**. If you create a subtree and then
> destroy its root, the engine destroys each entity below it also. Give
> `{ onDeleteTarget: "clear" }` to let the children continue as new roots, or `"orphan"` to leave a
> `targetOf` that points at a dead entity.

## Cleanup policies

`onDeleteTarget` decides what happens to the **sources** of a relation when one of its **targets**
is destroyed:

| Policy | Effect |
| --- | --- |
| `"delete"` | cascade — destroy each source also, and repeat down the tree (the `ChildOf` default) |
| `"clear"` | remove the relation from each source; the sources continue (the `IsA` default) |
| `"orphan"` | leave the link; reads stay safe, but `targetOf` gives a handle to a dead entity (the overall default) |

> [!WARNING]
> **`orphan` lets the reverse index grow.** Under `orphan`, the reverse entries of a destroyed
> target stay until each source points at a different target or is destroyed. So a source with a
> long life, which points at many targets with short lives under `orphan`, makes the reverse index
> grow without a limit. Also, `targetOf` gives a **handle to a dead entity**, and not `undefined`.
> Call `ecs.relations.compact()` at a scene or snapshot boundary to remove the reverse entries of
> the destroyed targets. It gives the number that it reclaimed, it changes no observable state, and
> it does not change `stateHash`.

## Types and constants

```ts
type RelationDef<C extends RelationCardinality = RelationCardinality>;  // the handle from ecs.relations.register
type RelationCardinality = "exclusive" | "multi";  // the type parameter behind RelationDef<"exclusive"> / RelationDef<"multi">
type RelationID;                  // the branded numeric id space behind RelationDef (registration order; separate from ComponentID)
type OnDeleteTarget = "delete" | "clear" | "orphan";
const ANY_RELATION: RelationDef;  // the authorization value for (*, T) queries — list it in relationReads
const HIERARCHY_UNBOUNDED: number; // = +Infinity, the default maxDepth of hierarchy
```

## See also

- [sparse storage](./sparse-storage.md) — the mechanism that relations are built on
- [queries](./queries.md) — how the relation terms fit the query verbs
- [systems](./systems.md) — the `relationReads` and `relationWrites` declarations
- [determinism](./determinism.md) — a snapshot records the relation targets in a canonical order
