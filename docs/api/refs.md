# Refs and cursors

A **ref** is a cached accessor for the component of one entity. It is a small object, and its
properties read and write the fields of that entity. A
[**cursor**](#cursors--many-entities-by-id) is the same accessor, created one time and then pointed
at each of many entities in turn. Use a cursor when you walk a list of ids.

Use a ref on a **low-frequency path that touches one entity**, where the
[`eachChunk`](./queries.md#eachchunk--mutable-hot-path) column loop is not correct:

- a reaction to one event;
- a change to a specific entity, by id;
- an occasional write to a different entity.

```ts
const pos = ctx.ref(Pos, entity);      // mutable
const vel = ctx.refRead(Vel, entity);  // read-only
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

## `ref` compared to `refRead`

```ts
ref<S>(def: ComponentDef<S>, entityId: EntityID): ComponentRef<S>;          // mutable
refRead<S>(def: ComponentDef<S>, entityId: EntityID): ReadonlyComponentRef<S>;  // read-only

type ComponentRef<S>         = { -readonly [K in keyof S]: number };  // get and set
type ReadonlyComponentRef<S> = {  readonly [K in keyof S]: number };  // get only
```

`ctx.ref` gives you a mutable ref. `ctx.refRead` gives you a read-only ref. The name shows the
ability to mutate, and there is no `refMut`.

> [!NOTE]
> **Why the definition comes first.** `ref` and `refRead` are the single-entity members of the
> **column-cursor family**, and not of the entity-accessor family. They are the equivalent, outside
> iteration, of the cursors inside a loop:
> [`cols.mut(def)` and `cols.read(def)`](./queries.md#eachchunk--mutable-hot-path). All four share
> the same rule (the mutable name has no suffix, and the read-only name has the `Read` suffix)
> *and* the same argument order (the definition comes first). So `ctx.ref(Pos, e)` reads as "a
> cursor onto `Pos`, for entity `e`", which agrees with `cols.mut(Pos)`. That order is
> deliberately different from the entity-first order of `getField(e, def, field)`, because those
> functions are in a different family. A `getField` call is a reader that you pay for at each
> access. You create a ref one time and use it again.

The accessor finds the archetype, the row, and the columns **one time, when you create it**. Each
later read or write of a field is then one index operation on a typed array. To create a ref, the
engine makes one `Object.create` call over a cached prototype.

> [!IMPORTANT]
> **`ctx.ref` sets the change tick of the component immediately, when you create the ref.** It does
> this before you write anything, and also if you never write. This marks the component as changed
> on that archetype for this tick, which is what a [`changed(def)`](./change-detection.md) query
> uses. If you only read, use **`ctx.refRead`**. It does not set the tick, so you do not cause an
> incorrect change detection, and you also show your intention.

## Points to note

> [!WARNING]
> **A ref does not survive an archetype transition.** You can hold it across the immediate reads
> and writes in a system. Structural changes are deferred, so the entity cannot move to a different
> archetype until the flush at the end of the phase. But when the entity gains or loses a
> component, its row moves. Create the ref again after that. A ref *is* safe across a growth of the
> column, because it reads the live column backing, and a column that grows refreshes in place.

> [!WARNING]
> **A ref on the host becomes incorrect immediately.** The protection above applies to `ctx` only.
> A mutation on the host applies *immediately*. So a ref from `ecs.refRead(Pos, e)` is valid only
> until the next structural mutation. Any `ecs.addComponent`, `ecs.removeComponent`, or
> `ecs.despawn` call, on *any* entity in the archetype, can swap the rows. The old ref then reads
> the data of **a different entity**, with no signal. Use `ecs.refRead` as an immediate read in one
> expression, and create the ref again after each structural change.

> [!WARNING]
> `ReadonlyComponentRef` is a **limit at compile time, and not at run time**. Its accessor shares a
> prototype with the mutable ref, so a type cast can write through it. Worse, such a write does not
> set the change tick that `ref()` sets, and change detection then becomes incorrect with no
> signal. Use `refRead` as truly read-only.

> [!NOTE]
> In development, `ref` does a write access check, so declare the component in `writes`. `refRead`
> does a read check, so declare it in `reads`. Both throw `ENTITY_NOT_ALIVE` for a handle to an
> entity that is not alive.

## Cursors — many entities, by id

A ref is created for one entity. When you have a **list of ids** to walk, you pay that creation
again for each entity, and the loop then discards each ref that it created. A **cursor** is the same
accessor with the creation lifted out of the loop. You create it one time, and then you point it at
each entity with `at`:

```ts
const p = ctx.cursor(Pos);          // create one time
for (let i = 0; i < ids.length; i++) {
  p.at(ids[i]);                     // point it, no allocation
  p.x += p.y * dt;                  // reads and writes ids[i]
}
```

```ts
cursor<S>(def: ComponentDef<S>): ComponentCursor<S>;              // mutable
cursorRead<S>(def: ComponentDef<S>): ReadonlyComponentCursor<S>;  // read-only

type ComponentCursor<S>         = { -readonly [K in keyof S]: number } & { at(e: EntityID): this };
type ReadonlyComponentCursor<S> = {  readonly [K in keyof S]: number } & { at(e: EntityID): this };
```

The same rules as the rest of the family hold: the definition comes first, the mutable name has no
suffix, and the read-only name has the `Read` suffix. `at` returns the cursor, so a single read
stays one expression — `ecs.cursor(Pos).at(e).x` — but in a loop, call it as a statement.

What a cursor does, against the other ways to read by id:

| access | what each entity costs |
| --- | --- |
| `cursor.at(e)` then read | `at` writes the archetype, the offset, and the row. Then each field is one index operation. |
| `refRead(def, e)` then read | The engine creates an accessor for the entity. Then each field is one index operation. |
| `getField(e, def, field)` | The engine resolves the entity **and** looks up the field name, on each call. |

`at` resolves the entity one time, however many fields you then read. A cursor also resolves the
position of each field when you create the cursor. So a read does not look up the field name at
all, and a cursor helps even when you read a single field.

> [!NOTE]
> **A cursor is safer than a ref that you hold, and not more dangerous.** It resolves the archetype
> and the row again on each `at`, so a structural change between two `at` calls cannot make it read
> a different entity. Only the window between one `at` and the reads that follow it has to be free
> of structural change. A cursor also **follows an entity that changes archetype**, which a ref
> cannot do.

> [!IMPORTANT]
> `ctx.cursor` sets the change tick on each `at`, in the same way and for the same reason that
> `ctx.ref` sets it when you create a ref. Use **`ctx.cursorRead`** when you only read.
> `ReadonlyComponentCursor` is a limit at compile time only, exactly as `ReadonlyComponentRef` is.

> [!WARNING]
> You cannot read a component with a field named `at` through a cursor, because that name is the
> same as the method of the cursor. Creation of the cursor throws, and the message says so. Use
> `getField` or a ref for that component, or rename the field.

A cursor removes the allocation. It does not remove the entity → archetype → row resolution, which
is what dense packing costs. So a query is still the better tool when a query can express the set,
because an [`eachChunk`](./queries.md#eachchunk--mutable-hot-path) column walk resolves nothing for
each row. Use a cursor when the set of entities comes from somewhere else: a list of ids, the
payload of an event, or the result of a spatial query.

## What to use, and when

| Situation | Use |
| --- | --- |
| Mutate many entities of one archetype, in each frame | the [`eachChunk`](./queries.md#eachchunk--mutable-hot-path) column loop |
| Read many entities, in each frame | the [`forEach`](./queries.md#foreach--read-only) column loop |
| Touch **many** entities by id, from a list a query cannot express | `ctx.cursor` or `ctx.cursorRead` |
| Touch one entity by id, or a low-frequency path | `ctx.ref` or `ctx.refRead` |
| One field, one entity, one time | `ctx.getField` or `ctx.setField` |

## See also

- [change detection](./change-detection.md) — the meaning of "sets the change tick", and how
  `changed()` uses it
- [queries](./queries.md) — the column loops for high-frequency paths
- [systems](./systems.md) — the full `ctx` surface
