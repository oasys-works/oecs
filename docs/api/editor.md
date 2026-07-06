# Editor

> **Optional.** `@oasys/oecs/editor` adds **undo/redo** and two-way **field handles** on top of the [host-write seam](./host-write-seam.md). It's for building editors and inspectors; a game runtime doesn't need it.

Every edit is reified as a transaction with a **forward** and an **inverse** command list. Undo enqueues the inverse on the same command bus; redo re-enqueues the forward. Undo is just another command — it applies at the next schedule head like any other host write.

```ts
import { Editor, fieldHandle } from "@oasys/oecs/editor";
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);
// readField: how the editor reads current values to build inverses (from your read channel)
const editor = new Editor(queue, (entityId, def, field) => ecs.getField(entityId, def, field));

editor.setField(player, Health, "hp", 50);   // enqueues forward + inverse; applies next tick
editor.undo();   // → true (enqueues the inverse)
editor.redo();   // → true
```

## `Editor`

```ts
class Editor {
  constructor(queue: HostCommandQueue, readField: FieldReader);

  // Each single-action method enqueues a one-command transaction and returns it:
  spawn(components: readonly SpawnEntry[], onSpawned?): EditorTransaction;
  despawn(entityId, restore: readonly SpawnEntry[]): EditorTransaction;       // restore = how to rebuild on undo
  setField<S>(entityId, def, field, value): EditorTransaction;
  add<S>(entityId, def, values: CompleteFieldValues<S>): EditorTransaction;   // bare verb (cf. ctx.commands.add)
  remove<S>(entityId, def, restore: CompleteFieldValues<S>): EditorTransaction;  // restore = values to re-add on undo
  disable(entityId): EditorTransaction;   enable(entityId): EditorTransaction;

  transaction(build: (tx: TransactionBuilder) => void): EditorTransaction;   // group many edits → one undo entry

  undo(): boolean;    // false if the undo stack is empty
  redo(): boolean;    // false if the redo stack is empty
  get canUndo(): boolean;   get canRedo(): boolean;   // allocation-free "would undo()/redo() do something"
  clear(): void;      // drop both stacks (does not touch the ECS)
  depths(): { undo: number; redo: number };
  onChange(cb: () => void): () => void;                // fires after every commit/undo/redo/clear; returns unsubscribe
  committedField(entityId, def, field): number | undefined; // read one committed slot through the constructor's FieldReader
  pendingField(entityId, def, field): number | undefined;   // optimistic, not-yet-committed value
}

type FieldReader = (entityId: EntityID, def: ComponentDef, field: string) => number | undefined;
interface EditorTransaction { readonly forward: readonly HostCommand[]; readonly inverse: readonly HostCommand[]; }
```

Group several edits into a **single** undo entry with `transaction`:

```ts
editor.transaction((tx) => {
  tx.setField(e, Pos, "x", 10)
    .setField(e, Pos, "y", 20)
    .add(e, Selected, {});
});
editor.undo();   // reverts all three at once
```

`TransactionBuilder` mirrors the single-action methods (`spawn`, `despawn`, `setField`, `add`, `remove`, `disable`, `enable`), each returning `this` to chain. You get it from `transaction`; you don't construct it.

For an "Undo (3)" / "Redo" affordance, subscribe with `onChange` instead of polling `depths()` per frame — callbacks fire synchronously after every commit, undo, redo, and clear; read `canUndo` / `canRedo` / `depths()` inside. `committedField` reads one committed `(entity, component, field)` slot through the `FieldReader` the editor was constructed with — it's the default read for `fieldHandle` when you pass no channel thunk.

> [!WARNING]
> **Entity identity is not preserved across despawn → undo.** The data round-trips (rebuilt from the `restore` you supplied), but the re-spawned entity gets a **fresh** `EntityID`. Don't hold an old id across an undo of its despawn.

> [!NOTE]
> `setField` inverses come from a per-`(entity, component, field)` shadow seeded via the `FieldReader` you passed (falling back to `0`). `pendingField` returns the editor's optimistic value before the read channel catches up, then self-resolves to `undefined`.

## Field handles

`fieldHandle` wraps one field as a two-way bound value — a read (reactive) plus an undoable write — ideal for an inspector input.

```ts
fieldHandle<S>(editor: Editor, entityId: EntityID, def: ComponentDef<S>, field: string & keyof S,
               read?: () => number | undefined): FieldHandle;   // omitted → falls back to editor.committedField

interface FieldHandle {
  readonly value: number | undefined;    // reactive read of the channel (tracked in a tracking scope)
  set(value: number): void;               // enqueue an undoable setField; applies next tick
  readonly pending: number | undefined;   // NON-reactive optimistic echo of the editor's shadow
}
```

`read` is a caller-supplied thunk into your [reactive read channel](./reactive.md), which keeps the handle framework-agnostic:

```ts
const hpHandle = fieldHandle(editor, player, Health, "hp", () => healthSync.map.get(player)?.hp);
// in a Solid input: value={hpHandle.value} onInput={(e) => hpHandle.set(+e.target.value)}
```

> [!NOTE]
> `pending` is an optimistic echo, not a substitute for `value` in a tracking scope — it does **not** subscribe. Bind UI display to `value`.

## See also

- [host-write seam](./host-write-seam.md) — the command bus undo/redo rides on
- [reactive](./reactive.md) — the read channel a `FieldHandle` reads from
