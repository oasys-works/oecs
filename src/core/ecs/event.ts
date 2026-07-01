/***
 * Event — Typed event channels with SoA storage.
 *
 * Events are fire-and-forget messages that systems emit within a frame
 * and other systems can read during the same frame. They are auto-cleared
 * at the end of each update cycle (after all phases have run).
 *
 * Events use SoA (Structure of Arrays) layout matching the component
 * pattern: each field is a separate number[] column, and a shared reader
 * object exposes named field arrays plus a length property.
 *
 * Signals are zero-field events — they carry no payload, just a count
 * of how many times they were emitted.
 *
 * Events are identified by module-scope EventKey symbols, analogous
 * to ResourceKey. The schema is a field → value-type record; a field's
 * value type may be a branded number (e.g. `EntityID`), so emitters and
 * readers round-trip the brand without casts. Register once, import the
 * key anywhere:
 *
 *   // definition (module scope)
 *   export const ContactEvent = eventKey<{ a: EntityID; b: EntityID }>("Contact");
 *
 *   // registration (plugin/setup)
 *   ecs.registerEvent(ContactEvent, ["a", "b"]);
 *
 *   // usage (system)
 *   ctx.emit(ContactEvent, { a: entityId, b: otherId });
 *   const hits = ctx.read(ContactEvent);
 *   for (let i = 0; i < hits.length; i++) { ... }  // hits.a[i] is an EntityID
 *
 ***/

import {
	Brand,
	validateAndCast,
	isNonNegativeInteger,
	unsafeCast
} from "../../type_primitives";
import { ECSError, ECS_ERROR } from "./utils/error";

export type EventID = Brand<number, "event_id">;
export const asEventId = (value: number) =>
	validateAndCast<number, EventID>(
		value,
		isNonNegativeInteger,
		"EventID must be a non-negative integer"
	);

/** Event schema: field name → value type. Every value is a number at
 * runtime; the declared type may be a branded number (e.g. `EntityID`)
 * so the brand survives the emit → read round trip at the type layer.
 * Declare schemas as type literals (`eventKey<{ a: EntityID }>`), not
 * interfaces — assignability to the `EventSchema` constraint relies on
 * the implicit index signature literals get and interfaces don't. */
export type EventSchema = Readonly<Record<string, number>>;

/** Schema of a signal — a zero-field event. */
export type EmptyEventSchema = Readonly<Record<never, number>>;

// Phantom symbol for the field schema — never exists at runtime.
declare const __eventSchema: unique symbol;

export type EventDef<S extends EventSchema = EventSchema> = EventID & {
	readonly [__eventSchema]: S;
};

/**
 * Reader view over an event channel's SoA columns. Columns are read-only
 * arrays typed per the event schema: consumers index them and read
 * `.length`. A field declared as a branded number (e.g. `EntityID`) reads
 * back branded — no cast at the consumer.
 *
 * The "cannot mutate the live channel through the reader" property is
 * **advisory** — the columns are the same live `number[]` objects the channel
 * mutates (see `EventChannel` below), so the `readonly` typing blocks writes
 * at the type layer only; a §10c-policed cast can still write through.
 */
export type EventReader<S extends EventSchema> = {
	length: number;
} & { readonly [K in keyof S]: ReadonlyArray<S[K]> };

export class EventChannel {
	public readonly fieldNames: string[];
	public readonly columns: number[][];
	// any: type-erased storage — channel is stored in Map<number, EventChannel>, S is lost
	public readonly reader: EventReader<any>;

	constructor(fieldNames: string[]) {
		this.fieldNames = fieldNames;
		this.columns = [];
		for (let i = 0; i < fieldNames.length; i++) {
			this.columns.push([]);
		}

		// Build the reader: a mutable length plus one column per field. The
		// columns are the same `number[]` objects the channel mutates internally
		// (emit/clear); the reader's type (EventReader) exposes them as read-only
		// arrays so consumers don't mutate the channel. That barrier is advisory
		// (compile-time only) — see EventReader.
		const columnsByField: Record<string, ReadonlyArray<number>> = {};
		for (let i = 0; i < fieldNames.length; i++) {
			columnsByField[fieldNames[i]] = this.columns[i];
		}
		// boundary: assemble the dynamic per-field columns into EventReader's mapped shape.
		this.reader = { length: 0, ...columnsByField } as EventReader<EventSchema>;
	}

	public emit(values: Record<string, number>): void {
		const names = this.fieldNames;
		const cols = this.columns;
		if (__DEV__) {
			// Validate ALL fields before mutating any column. Pushing per-field and
			// throwing mid-loop would leave earlier columns one row ahead of
			// `reader.length` and the un-pushed columns — a permanent desync if the
			// throw is caught. Validate-then-push leaves the production path (no
			// __DEV__) a single tight push loop. #727.
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
		this.reader.length++;
	}

	/** Emit a signal (zero-field event). */
	public emitSignal(): void {
		this.reader.length++;
	}

	public clear(): void {
		this.reader.length = 0;
		const cols = this.columns;
		for (let i = 0; i < cols.length; i++) {
			cols[i].length = 0;
		}
	}
}

// =======================================================
// Event keys — module-scope symbol handles for events
// =======================================================

declare const __eventKeySchema: unique symbol;

export type EventKey<S extends EventSchema = EventSchema> = symbol & {
	readonly [__eventKeySchema]: S;
};

// Distinguishes a signal key from a payload event key at the type layer, so
// the no-payload `emit(key)` overload accepts only keys minted by
// `signalKey`. The empty-record schema alone wouldn't be enough — every
// payload schema is structurally assignable to `{}`, so without the extra
// phantom a payload event would match the signal overload and emit with no
// column pushes, desyncing `reader.length` from the columns.
declare const __signalKey: unique symbol;

export type SignalKey = EventKey<EmptyEventSchema> & {
	readonly [__signalKey]: true;
};

export function eventKey<S extends EventSchema>(name: string): EventKey<S> {
	return unsafeCast<EventKey<S>>(Symbol(name));
}

export function signalKey(name: string): SignalKey {
	return unsafeCast<SignalKey>(Symbol(name));
}
