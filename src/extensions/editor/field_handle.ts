/**
 * fieldHandle — the inspector field-handle (#701), the two-way sugar that sits
 * back-to-back with the reactive read bridge.
 *
 * An inspector field is a READ through the reactive channel (`syncFieldsToMap` /
 * `syncSingletonToStruct`, ADR-0022/0024) and a WRITE through a `setField` host
 * command. {@link fieldHandle} pairs them: `handle.value` reads the channel, and
 * `handle.set(v)` enqueues a `setField` via the {@link Editor} — so the field
 * FEELS two-way while staying safe (the write applies at the drain point, never
 * from the callback) and undoable (it is a reified editor command on the bus).
 * This is the literal write-mirror of the read struct.
 *
 * The read side is a caller-supplied thunk, NOT a direct kernel import: the
 * handle stays framework-agnostic (no `solid-js`, no reactive-kernel dependency),
 * and the caller wires it to whatever channel it already has —
 * `() => sync.map.get(eid)?.x`, `() => struct.x`, etc. Read it inside a tracking
 * scope (a Solid `createMemo`/`<Index>` body, an `effect`) and the handle's value
 * tracks that channel; the write lands on the NEXT tick (the bus drains at the
 * schedule head), at which point the same channel re-publishes the new value.
 */
import type { ComponentDef, ComponentSchema, EntityID } from "../../core/ecs";
import type { Editor } from "./editor";

/**
 * A two-way handle on one `(entity, component, field)` slot. `value` reads the
 * reactive channel (tracked, if read in a tracking scope); `set` enqueues an
 * undoable `setField` command via the editor.
 */
export interface FieldHandle {
	/**
	 * The field's current value through the reactive read channel — `undefined`
	 * until the channel has it (e.g. before the spawn's first commit). Read inside
	 * a tracking scope to subscribe to the channel; the value reflects the last
	 * COMMITTED tick, so a fresh `set` shows up on the next tick.
	 */
	readonly value: number | undefined;
	/** Enqueue an undoable `setField` for this slot; applied at the next tick. */
	set(value: number): void;
	/**
	 * The editor's pending (not-yet-committed) value for this slot, or `undefined`
	 * if none — a NON-reactive read of the editor shadow, for an optimistic echo
	 * between the `set` and its commit. Self-resolves to `undefined` once the read
	 * channel catches up, so it does not outlive the edit. Not a substitute for
	 * `value` in a tracking scope (it does not subscribe); `value` is the source of
	 * truth.
	 */
	readonly pending: number | undefined;
}

/**
 * Build a {@link FieldHandle} for one `(eid, def, field)` slot. `read` is the
 * tracked read of the reactive channel for this field (e.g.
 * `() => sync.map.get(eid)?.x`); `set` routes through `editor.setField`, so the
 * edit is queued, batched, and undoable.
 */
export function fieldHandle<S extends ComponentSchema>(
	editor: Editor,
	eid: EntityID,
	def: ComponentDef<S>,
	field: string & keyof S,
	read: () => number | undefined
): FieldHandle {
	return {
		get value(): number | undefined {
			return read();
		},
		set(value: number): void {
			editor.setField(eid, def, field, value);
		},
		get pending(): number | undefined {
			return editor.pendingField(eid, def, field);
		}
	};
}
