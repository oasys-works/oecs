/**
 * fieldHandle, the inspector field handle, the two-way sugar that sits
 * back-to-back with a live read channel.
 *
 * An inspector field is a read through a live channel, such as a
 * `@oasys/oecs/solid` view, and a write through a `setField` host command.
 * {@link fieldHandle} pairs them: `handle.value` reads the channel, and
 * `handle.set(v)` enqueues a `setField` via the {@link Editor}, so the field
 * feels two-way while staying safe (the write applies at the drain point, never
 * from the callback) and undoable (it is a reified editor command on the bus).
 *
 * The read side is a caller-supplied thunk, not an import of one channel: the
 * handle names no UI framework, and the caller wires it to whatever channel it
 * already has, `() => view.cell(entityId)()?.x` for one. Read it inside a
 * tracking scope, a Solid `createMemo` or a `<For>` row body, and the handle's
 * value tracks that channel. The write lands on the next tick, because the bus
 * drains at the schedule head, and the same channel then publishes the new
 * value.
 */
import type { ComponentDef, ComponentSchema, EntityID } from "../../core/ecs";
import type { Editor } from "./editor";

/**
 * A two-way handle on one `(entity, component, field)` slot. `value` reads the
 * live channel, tracked when read inside a tracking scope. `set` enqueues an
 * undoable `setField` command via the editor.
 */
export interface FieldHandle {
	/**
	 * The field's current value through the live read channel, `undefined`
	 * until the channel has it (e.g. before the spawn's first commit). Read inside
	 * a tracking scope to subscribe to the channel. The value reflects the last
	 * committed tick, so a fresh `set` shows up on the next tick.
	 */
	readonly value: number | undefined;
	/** Enqueue an undoable `setField` for this slot. Applied at the next tick. */
	set(value: number): void;
	/**
	 * The editor's pending (not-yet-committed) value for this slot, or `undefined`
	 * if none, an untracked read of the editor shadow, for an optimistic echo
	 * between the `set` and its commit. Self-resolves to `undefined` once the read
	 * channel catches up, so it does not outlive the edit. It does not subscribe,
	 * so it is no substitute for `value` inside a tracking scope. `value` is the
	 * source of truth.
	 */
	readonly pending: number | undefined;
}

/**
 * Build a {@link FieldHandle} for one `(entityId, def, field)` slot. `read` is the
 * tracked read of the live channel for this field, for example
 * `() => view.cell(entityId)()?.x`. `set` routes through `editor.setField`, so the
 * edit is queued, batched, and undoable.
 *
 * `read` is optional: omitted, the handle reads through the editor's own
 * committed-channel reader (`editor.committedField`). That default is correct
 * but untracked, so pass the channel thunk when the handle's `value` must
 * subscribe inside a tracking scope.
 */
export function fieldHandle<S extends ComponentSchema>(
	editor: Editor,
	entityId: EntityID,
	def: ComponentDef<S>,
	field: string & keyof S,
	read?: () => number | undefined
): FieldHandle {
	return {
		get value(): number | undefined {
			return read !== undefined ? read() : editor.committedField(entityId, def as ComponentDef, field);
		},
		set(value: number): void {
			editor.setField(entityId, def, field, value);
		},
		get pending(): number | undefined {
			return editor.pendingField(entityId, def, field);
		}
	};
}
