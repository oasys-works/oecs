/**
 * The host write seam's EDITOR layer — layer 2 of the seam.
 *
 * Reified undo/redo + the inspector field-handle, built on the shipped typed
 * `HostCommandQueue`. Application policy, so it lives here in
 * `engine-extensions`, not engine core — and it pulls NO third-party / framework
 * dependency (the field-handle reads through a caller-supplied thunk).
 *
 *   - `Editor` — reified `EditorTransaction`s on undo/redo stacks, with
 *     transaction grouping; `undo()`/`redo()` enqueue the inverse/forward on the
 *     SAME bus, applied at the next schedule head (undo is just another command).
 *   - `fieldHandle` — pairs a reactive-channel read with a `setField` command, so
 *     an inspector field feels two-way while staying safe and undoable.
 *
 * Reachable as `@oasys/oecs/editor`. Pair it with
 * `@oasys/oecs/reactive-sync`'s `syncFieldsToMap` /
 * `syncSingletonToStruct` for the read channel the field-handle reads through.
 */
export { Editor, TransactionBuilder, type EditorTransaction, type FieldReader } from "./editor";
export { fieldHandle, type FieldHandle } from "./field_handle";
