# Editor

> **Optional.** `@oasys/oecs/editor` adds **undo and redo**, and **field handles** that operate in
> two directions, above the [host write path](./host-write-seam.md). It is for editors and
> inspectors. A game at run time does not need it.

The editor makes each edit into a transaction with a **forward** list of commands and an
**inverse** list. Undo puts the inverse list on the same command queue. Redo puts the forward list
on it again. So an undo is only one more command: it applies at the head of the next phase, as
each other write from the host does.

```ts
import { Editor, fieldHandle } from "@oasys/oecs/editor";
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);
// readField: how the editor reads the current values to build an inverse (from your read channel)
const editor = new Editor(queue, (entityId, def, field) => ecs.getField(entityId, def, field));

editor.setField(player, Health, "hp", 50);   // adds the forward and inverse commands; applies in the next tick
editor.undo();   // → true (adds the inverse commands)
editor.redo();   // → true
```

## `Editor`

```ts
class Editor {
  constructor(queue: HostCommandQueue, readField: FieldReader);

  // Each single-action method adds a transaction of one command, and gives it back:
  spawn(components: readonly SpawnEntry[], onSpawned?): EditorTransaction;
  despawn(entityId, restore: readonly SpawnEntry[]): EditorTransaction;       // restore = how to build it again on undo
  setField<S>(entityId, def, field, value): EditorTransaction;
  add<S>(entityId, def, values: CompleteFieldValues<S>): EditorTransaction;   // a bare verb (compare ctx.commands.add)
  remove<S>(entityId, def, restore: CompleteFieldValues<S>): EditorTransaction;  // restore = the values to add again on undo
  disable(entityId): EditorTransaction;   enable(entityId): EditorTransaction;

  transaction(build: (tx: TransactionBuilder) => void): EditorTransaction;   // group many edits → one undo entry

  undo(): boolean;    // false when the undo stack is empty
  redo(): boolean;    // false when the redo stack is empty
  get canUndo(): boolean;   get canRedo(): boolean;   // "would undo()/redo() do something", with no allocation
  clear(): void;      // remove both stacks (this does not touch the ECS)
  depths(): { undo: number; redo: number };
  onChange(cb: () => void): () => void;                // runs after each commit, undo, redo, and clear; gives an unsubscribe function
  committedField(entityId, def, field): number | undefined; // read one committed slot through the FieldReader of the constructor
  pendingField(entityId, def, field): number | undefined;   // the optimistic value that is not yet committed
}

type FieldReader = (entityId: EntityID, def: ComponentDef, field: string) => number | undefined;
interface EditorTransaction { readonly forward: readonly HostCommand[]; readonly inverse: readonly HostCommand[]; }
```

To group several edits into a **single** undo entry, use `transaction`:

```ts
editor.transaction((tx) => {
  tx.setField(e, Pos, "x", 10)
    .setField(e, Pos, "y", 20)
    .add(e, Selected, {});
});
editor.undo();   // reverses all three at the same time
```

`TransactionBuilder` has the same methods as the single actions (`spawn`, `despawn`, `setField`,
`add`, `remove`, `disable`, and `enable`). Each one gives `this`, so that you can chain them. You
get the builder from `transaction`. You do not construct it.

For an "Undo (3)" or "Redo" control, subscribe with `onChange`. Do not poll `depths()` in each
frame. The callbacks run synchronously after each commit, undo, redo, and clear. Read `canUndo`,
`canRedo`, or `depths()` inside the callback. `committedField` reads one committed
`(entity, component, field)` slot through the `FieldReader` that you gave to the constructor. It is
the default read for `fieldHandle` when you give no read function.

> [!WARNING]
> **A despawn, and then an undo, does not keep the identity of the entity.** The data returns,
> because the editor builds it again from the `restore` list that you supplied. But the new entity
> gets a **new** `EntityID`. Do not keep an old id across an undo of its despawn.

> [!NOTE]
> The inverse of a `setField` comes from a shadow value for each `(entity, component, field)` slot.
> The editor gets the first shadow value through the `FieldReader` that you gave it, and it uses
> `0` when that read gives nothing. `pendingField` gives the optimistic value of the editor before
> the read channel is current. It then gives `undefined` again by itself.

## Field handles

`fieldHandle` makes one field into a value that operates in two directions: a reactive read, and a
write that you can undo. This is correct for an input in an inspector.

```ts
fieldHandle<S>(editor: Editor, entityId: EntityID, def: ComponentDef<S>, field: string & keyof S,
               read?: () => number | undefined): FieldHandle;   // absent → it uses editor.committedField

interface FieldHandle {
  readonly value: number | undefined;    // a reactive read of the channel (tracked in a tracking scope)
  set(value: number): void;               // adds a setField that you can undo; applies in the next tick
  readonly pending: number | undefined;   // a NON-reactive optimistic copy of the shadow value of the editor
}
```

`read` is a function that you supply, and it reads from your
[reactive read channel](./reactive.md). So the handle does not depend on a framework:

```ts
const hpHandle = fieldHandle(editor, player, Health, "hp", () => healthSync.map.get(player)?.hp);
// in a Solid input: value={hpHandle.value} onInput={(e) => hpHandle.set(+e.target.value)}
```

> [!NOTE]
> `pending` is an optimistic copy. It is not a replacement for `value` in a tracking scope, because
> it does **not** subscribe. Bind the UI display to `value`.

## See also

- [the host write path](./host-write-seam.md) — the command queue that undo and redo use
- [reactive](./reactive.md) — the read channel that a `FieldHandle` reads from
