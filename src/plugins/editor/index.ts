/**
 * The host write seam's editor layer, layer 2 of the seam.
 *
 * Reified undo and redo, and the inspector field handle, built on the shipped
 * typed `HostCommandQueue`. Undo and redo are application policy, so this is a
 * plugin and not part of the world core. It pulls no third-party dependency,
 * because the field handle reads through a caller-supplied thunk.
 *
 *   - `Editor`, reified `EditorTransaction`s on undo and redo stacks, with
 *     transaction grouping. `undo()` and `redo()` enqueue the inverse and forward on the
 *     same bus, applied at the next schedule head (undo is only another command).
 *   - `fieldHandle`, pairs a read of a live channel with a `setField` command, so
 *     an inspector field feels two-way while staying safe and undoable.
 *
 * Reachable as `@oasys/oecs/editor`. Pair it with `@oasys/oecs/solid`, whose
 * `ecs.solid.component` and `ecs.solid.singleton` views are the read side the
 * field handle reads through.
 */
export { Editor, TransactionBuilder, type EditorTransaction, type FieldReader } from "./editor";
export { fieldHandle, type FieldHandle } from "./field_handle";
