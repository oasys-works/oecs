/***
 * EventChannel, one channel's SoA columns and the reader over them.
 *
 * Each field is a separate `number[]` column, matching the component pattern.
 * A shared reader object exposes the named field arrays plus a length. A
 * signal is a zero-field channel: it carries no payload, only a count.
 *
 * The channel lives for one `update()`. The world clears it at the tick tail.
 ***/

import { DEV } from "../../dev_flag";
import { ECSError, ECS_ERROR } from "../../core/ecs/utils/error";
import type { EventReader, EventSchema } from "../../core/ecs/event";

export class EventChannel {
	public readonly fieldNames: string[];
	public readonly columns: number[][];
	// any: type-erased storage, channel is stored in Map<number, EventChannel>, S is lost
	public readonly reader: EventReader<any>;
	// The one mutable view of the reader's `length`. The public `EventReader`
	// type declares it readonly (a consumer writing `reader.length = 0` on the
	// live shared object would permanently desync every other system's view),
	// so the channel keeps this private alias to the same
	// object for emit and clear bookkeeping.
	private readonly _readerLen: { length: number };

	constructor(fieldNames: string[]) {
		this.fieldNames = fieldNames;
		this.columns = [];
		for (let i = 0; i < fieldNames.length; i++) {
			this.columns.push([]);
		}

		// Build the reader: a mutable length plus one column per field. The
		// columns are the same `number[]` objects the channel mutates internally
		// (emit and clear); the reader's type (EventReader) exposes them as read-only
		// arrays so consumers don't mutate the channel. That barrier is advisory
		// (compile-time only), see EventReader.
		const columnsByField: Record<string, ReadonlyArray<number>> = {};
		for (let i = 0; i < fieldNames.length; i++) {
			columnsByField[fieldNames[i]] = this.columns[i];
		}
		// boundary: assemble the dynamic per-field columns into EventReader's mapped shape.
		const reader = { length: 0, ...columnsByField };
		this._readerLen = reader;
		this.reader = reader as EventReader<EventSchema>;
	}

	public emit(values: Record<string, number>): void {
		const names = this.fieldNames;
		const cols = this.columns;
		if (DEV) {
			// Validate all fields before mutating any column. Pushing per-field and
			// throwing mid-loop would leave earlier columns one row ahead of
			// `reader.length` and the un-pushed columns, a permanent desync if the
			// throw is caught. Validate-then-push leaves the production path (no
			// DEV) a single tight push loop.
			for (let i = 0; i < names.length; i++) {
				if (!(names[i] in values)) {
					throw new ECSError(
						ECS_ERROR.FIELD_NOT_REGISTERED,
						`emit: event field "${names[i]}" missing from values`
					);
				}
			}
		}
		for (let i = 0; i < names.length; i++) cols[i].push(values[names[i]]);
		this._readerLen.length++;
	}

	/** Emit a signal (zero-field event). */
	public emitSignal(): void {
		this._readerLen.length++;
	}

	public clear(): void {
		this._readerLen.length = 0;
		const cols = this.columns;
		for (let i = 0; i < cols.length; i++) {
			cols[i].length = 0;
		}
	}
}
