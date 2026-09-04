/**
 * The host write seam's editor layer, layer 2 of the seam.
 *
 * Reified undo and redo + the inspector field-handle, built on the shipped typed
 * `HostCommandQueue`. Application policy, so it lives here in
 * `engine-extensions`, not engine core, and it pulls no third-party / framework
 * dependency (the field-handle reads through a caller-supplied thunk).
 *
 *   - `Editor`, reified `EditorTransaction`s on undo and redo stacks, with
 *     transaction grouping. `undo()` and `redo()` enqueue the inverse and forward on the
 *     same bus, applied at the next schedule head (undo is only another command).
 *   - `fieldHandle`, pairs a reactive-channel read with a `setField` command, so
 *     an inspector field feels two-way while staying safe and undoable.
 *
 * Reachable as `@oasys/oecs/editor`. Pair it with
 * `@oasys/oecs/reactive-sync`'s `syncFieldsToMap` /
 * `syncSingletonToStruct` for the read channel the field-handle reads through.
 */
export { Editor, TransactionBuilder, type EditorTransaction, type FieldReader } from "./editor";
export { fieldHandle, type FieldHandle } from "./field_handle";
