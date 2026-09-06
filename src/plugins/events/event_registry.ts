/***
 * EventRegistry, event channel registry + the per-tick dirty list.
 *
 * Owns the `EventChannel` array (parallel, indexed by EventID), the
 * symbol-key → def map behind `eventKey` and `signalKey` registration, and the
 * dirty-channel list `clearEvents` drains. Extracted from `Store`, which keeps
 * one-line delegations. Fully self-contained (no Store reach-back).
 ***/

import { unsafeCast } from "../../type_primitives";
import { EventChannel } from "./event_channel";
import {
	asEventId,
	type EmptyEventSchema,
	type EventDef,
	type EventHooks,
	type EventReader,
	type EventShape
} from "../../core/ecs/event";
import { ECS_ERROR, ECSError } from "../../core/ecs/utils/error";

export class EventRegistry implements EventHooks {
	// Parallel array indexed by EventID: each channel holds SoA columns + reader.
	private readonly _channels: EventChannel[] = [];
	// IDs of channels emitted to since the last `clearEvents()`. An `emit*`
	// only pushes when the channel was empty (`reader.length === 0`), so each
	// dirty channel appears at most once per tick, `clearEvents` then walks
	// only these instead of every registered channel.
	private readonly _dirtyChannels: number[] = [];
	private _nextEventId = 0;

	// any: type-erased. EventDef<F> phantom is lost in the map, recovered by
	// callers via EventKey<F>
	private readonly _defsByKey: Map<symbol, EventDef<any>> = new Map();

	public register<S extends EventShape<S>>(
		fields: readonly (keyof S & string)[]
	): EventDef<S> {
		const id = asEventId(this._nextEventId++);
		const channel = new EventChannel(fields as readonly string[] as string[]);
		this._channels.push(channel);
		return unsafeCast<EventDef<S>>(id);
	}

	public emit(def: EventDef<any>, values: Record<string, number>): void {
		const id = def as unknown as number;
		const channel = this._channels[id];
		// Sample emptiness, emit, then mark dirty: if `emit` throws (a DEV
		// missing-field check), `reader.length` stays 0 and a later successful emit
		// would push the id a second time, breaking the at-most-once-per-tick
		// dirty-list invariant. Push only on a clean emit.
		const wasEmpty = channel.reader.length === 0;
		channel.emit(values);
		if (wasEmpty) this._dirtyChannels.push(id);
	}

	public emitSignal(def: EventDef<EmptyEventSchema>): void {
		const id = def as unknown as number;
		const channel = this._channels[id];
		const wasEmpty = channel.reader.length === 0;
		channel.emitSignal();
		if (wasEmpty) this._dirtyChannels.push(id);
	}

	public reader<S extends EventShape<S>>(def: EventDef<S>): EventReader<S> {
		return this._channels[def as unknown as number].reader as EventReader<S>;
	}

	public clear(): void {
		const dirty = this._dirtyChannels;
		// Bail before touching `dirty.length`. Setting `length` on an array is a
		// property store, not a field write. V8 does not fold it away when the
		// array is already empty, and this runs once per `update()` whether or
		// not anything was emitted. In a schedule that emits no events (the common
		// case for most phases) that store was a measurable part of each tick.
		if (dirty.length === 0) return;
		const channels = this._channels;
		for (let i = 0; i < dirty.length; i++) {
			channels[dirty[i]].clear();
		}
		dirty.length = 0;
	}

	/** `DEV`-only: total events currently buffered across the dirty channels.
	 * `ECS.update` samples this either side of `dispatchSet` to assert an onSet
	 * observer emitted nothing, its emissions would be wiped by the tick-tail
	 * `clearEvents` and break the empty-channel-at-boundary invariant that
	 * snapshot and restore rely on. Walks only the dirty list, never the hot emit path. */
	public devBufferedCount(): number {
		const dirty = this._dirtyChannels;
		const channels = this._channels;
		let n = 0;
		for (let i = 0; i < dirty.length; i++) n += channels[dirty[i]].reader.length;
		return n;
	}

	public registerByKey<S extends EventShape<S>>(
		key: symbol,
		fields: readonly (keyof S & string)[]
	): EventDef<S> {
		if (this._defsByKey.has(key)) {
			throw new ECSError(
				ECS_ERROR.EVENT_ALREADY_REGISTERED,
				`event '${key.description ?? "<unnamed>"}' is already registered`,
				{ event: key.description }
			);
		}
		const def = this.register<S>(fields);
		this._defsByKey.set(key, def);
		return def;
	}

	// any: type-erased, caller recovers F from EventKey<F>
	public defByKey(key: symbol): EventDef<any> {
		const def = this._defsByKey.get(key);
		if (def === undefined) {
			throw new ECSError(
				ECS_ERROR.EVENT_NOT_REGISTERED,
				`event '${key.description ?? "<unnamed>"}' is not registered, call ecs.events.register(key, fields) at world setup`,
				{ event: key.description }
			);
		}
		return def;
	}

	public hasKey(key: symbol): boolean {
		return this._defsByKey.has(key);
	}
}
