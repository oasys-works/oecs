/***
 * The event seam. The keys, the schema types, and what the world calls on an
 * event registry it did not build.
 *
 * The channel storage and the registry live in the events plugin. This file
 * holds what the core spells: `ctx.emit` and `ctx.readEvents` take an
 * `EventKey`, and `ECS.update` clears the channels at the tick tail.
 *
 * Events are fire-and-forget messages that systems emit within a frame
 * and other systems can read during the same frame. They are auto-cleared
 * at the end of each update cycle (after all phases have run).
 *
 * Events use SoA (Structure of Arrays) layout matching the component
 * pattern: each field is a separate number[] column, and a shared reader
 * object exposes named field arrays plus a length property.
 *
 * Signals are zero-field events. They carry no payload, only a count
 * of how many times they were emitted.
 *
 * Events are identified by module-scope EventKey symbols, analogous
 * to ResourceKey. The schema is a field → value-type record. A field's
 * value type may be a branded number (e.g. `EntityID`), so emitters and
 * readers round-trip the brand without casts. Register once, import the
 * key anywhere:
 *
 *   // definition (module scope)
 *   export const ContactEvent = eventKey<{ a: EntityID; b: EntityID }>("Contact");
 *
 *   // registration (plugin and setup)
 *   ecs.events.register(ContactEvent, ["a", "b"]);
 *
 *   // usage (system)
 *   ctx.emit(ContactEvent, { a: entityId, b: otherId });
 *   const hits = ctx.readEvents(ContactEvent);
 *   for (let i = 0; i < hits.length; i++) { ... }  // hits.a[i] is an EntityID
 *
 ***/

import {
	Brand,
	validateAndCast,
	isNonNegativeInteger,
	unsafeCast
} from "../../type_primitives";

export type EventID = Brand<number, "event_id">;
export const asEventId = (value: number) =>
	validateAndCast<number, EventID>(
		value,
		isNonNegativeInteger,
		"EventID must be a non-negative integer"
	);

/** Event schema: field name → value type. Every value is a number at
 * runtime. The declared type may be a branded number (e.g. `EntityID`)
 * so the brand survives the emit → read round trip at the type layer.
 * This is the erased and default schema type. The public surfaces constrain
 * on `EventShape<S>` (below) instead, so schemas may be declared as type
 * literals or interfaces, an interface lacks the implicit index
 * signature literals get (and so isn't assignable to this `Record`
 * alias), but satisfies the homomorphic `EventShape` check. */
export type EventSchema = Readonly<Record<string, number>>;

/**
 * Homomorphic constraint for event-schema type params:
 * `S extends EventShape<S>` checks every property of `S` is a number without
 * requiring an index signature, so `interface`-declared schemas (which lack
 * the implicit index signature type literals get) are accepted too.
 */
export type EventShape<S> = { readonly [K in keyof S]: number };

/** Schema of a signal, a zero-field event. */
export type EmptyEventSchema = Readonly<Record<never, number>>;

// Phantom symbol for the field schema, never exists at runtime. The
// function-typed slot makes `S` invariant (mirroring `ResourceKey`,
// resource.ts): a def is used for both emits (contravariant in the payload)
// and reads (covariant), so covariant erasure, `EventDef<{a; b}>` widening
// to `EventDef<{a}>`, would let `emit` under-fill the channel's columns.
// Erased positions must spell `EventDef<any>`.
declare const __eventSchema: unique symbol;

export type EventDef<S extends EventShape<S> = EventSchema> = EventID & {
	readonly [__eventSchema]: (value: S) => S;
};

/**
 * Reader view over an event channel's SoA columns. Columns are read-only
 * arrays typed per the event schema: consumers index them and read
 * `.length`. A field declared as a branded number (e.g. `EntityID`) reads
 * back branded, no cast at the consumer.
 *
 * The "cannot mutate the live channel through the reader" property is
 * **advisory**, the columns are the same live `number[]` objects the channel
 * mutates, so the `readonly` typing blocks writes at the type layer only. A
 * deliberate cast can still write through.
 */
export type EventReader<S extends EventShape<S>> = {
	readonly length: number;
} & { readonly [K in keyof S]: ReadonlyArray<S[K]> };

/** The event registry, as everything outside the plugin sees it.
 *
 * `Store.events` is public, so this is the whole crossing surface. The
 * plugin's class implements it, and the compiler holds the two in step.
 *
 * `SystemContext` resolves a key and emits or reads through this. `ECS.update`
 * clears the channels at the tick tail, and a `DEV` build samples the buffered
 * count either side of the observer drain. */
export interface EventHooks {
	/** Register a channel and take its def. The key form is what a caller
	 * uses, and this is the anonymous one the key form builds on. */
	register<S extends EventShape<S>>(fields: readonly (keyof S & string)[]): EventDef<S>;
	/** Register a channel under a module-scope key. Throws on a repeat. */
	registerByKey<S extends EventShape<S>>(
		key: symbol,
		fields: readonly (keyof S & string)[]
	): EventDef<S>;
	/** The def a key was registered under. Throws when it was not. */
	defByKey(key: symbol): EventDef<any>;
	hasKey(key: symbol): boolean;
	emit(def: EventDef<any>, values: Record<string, number>): void;
	emitSignal(def: EventDef<EmptyEventSchema>): void;
	reader<S extends EventShape<S>>(def: EventDef<S>): EventReader<S>;
	/** Drop every channel emitted to this tick. Runs once per `update()`. */
	clear(): void;
	/** `DEV` only. Events buffered across the dirty channels right now. */
	devBufferedCount(): number;
}

// =======================================================
// Event keys, module-scope symbol handles for events
// =======================================================

// Function-typed slot ⇒ `S` is invariant, same rationale as `EventDef`
// above: a key authorises both `emit` (contravariant) and `read` (covariant),
// so one-sided variance is a payload-shape hole. Erased positions must spell
// `EventKey<any>`.
declare const __eventKeySchema: unique symbol;

export type EventKey<S extends EventShape<S> = EventSchema> = symbol & {
	readonly [__eventKeySchema]: (value: S) => S;
};

// Distinguishes a signal key from a payload event key at the type layer, so
// the no-payload `emit(key)` overload accepts only keys minted by
// `signalKey`. The empty-record schema alone wouldn't be enough, every
// payload schema is structurally assignable to `{}`, so without the extra
// phantom a payload event would match the signal overload and emit with no
// column pushes, desyncing `reader.length` from the columns.
declare const __signalKey: unique symbol;

export type SignalKey = EventKey<EmptyEventSchema> & {
	readonly [__signalKey]: true;
};

/**
 * Compile-time exact-cover check for `registerEvent`'s `fields` list. The
 * element type (`keyof S & string`) already rejects foreign fields. This
 * catches the inverse mistake, an under-registered channel. Registering
 * `eventKey<{a; b}>` with `["a"]` used to compile, but `emit` requires the
 * full payload while the channel only has an `a` column, so `b` was silently
 * dropped and `reader.b` (typed as an array) was `undefined` at runtime.
 * Resolves to `unknown` (intersection no-op) when `F` covers every key, and
 * to an impossible tuple naming the missing fields otherwise. A schema with a
 * string index signature (erased or untyped keys) skips the check. There is no
 * finite key set to cover.
 */
export type EventFieldsCover<
	S extends EventShape<S>,
	F extends readonly (keyof S & string)[]
> = string extends keyof S
	? unknown
	: Exclude<keyof S & string, F[number]> extends never
		? unknown
		: readonly [`ERROR, missing event field: ${Exclude<keyof S & string, F[number]>}`];

export function eventKey<S extends EventShape<S>>(name: string): EventKey<S> {
	return unsafeCast<EventKey<S>>(Symbol(name));
}

export function signalKey(name: string): SignalKey {
	return unsafeCast<SignalKey>(Symbol(name));
}
