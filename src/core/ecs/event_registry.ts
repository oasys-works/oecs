/***
 * EventRegistry — event channel registry + the per-tick dirty list (H1 step 2).
 *
 * Owns the `EventChannel` array (parallel, indexed by EventID), the
 * symbol-key → def map behind `eventKey`/`signalKey` registration, and the
 * dirty-channel list `clearEvents` drains. Extracted from `Store`, which keeps
 * one-line delegations; fully self-contained (no Store reach-back).
 ***/

import { unsafeCast } from "../../type_primitives";
import {
	EventChannel,
	asEventId,
	type EmptyEventSchema,
	type EventDef,
	type EventReader,
	type EventShape
} from "./event";
import { ECS_ERROR, ECSError } from "./utils/error";

export class EventRegistry {
	// Parallel array indexed by EventID: each channel holds SoA columns + reader.
	private readonly channels: EventChannel[] = [];
	// IDs of channels emitted to since the last `clearEvents()`. An `emit*`
	// only pushes when the channel was empty (`reader.length === 0`), so each
	// dirty channel appears at most once per tick — `clearEvents` then walks
	// just these instead of every registered channel.
	private readonly dirtyChannels: number[] = [];
	private count = 0;

	// any: type-erased — EventDef<F> phantom is lost in the map, recovered by
	// callers via EventKey<F>
	private readonly keyMap: Map<symbol, EventDef<any>> = new Map();

	public registerEvent<S extends EventShape<S>>(
		fields: readonly (keyof S & string)[]
	): EventDef<S> {
		const id = asEventId(this.count++);
		const channel = new EventChannel(fields as readonly string[] as string[]);
		this.channels.push(channel);
		return unsafeCast<EventDef<S>>(id);
	}

	public emitEvent(def: EventDef<any>, values: Record<string, number>): void {
		const id = def as unknown as number;
		const channel = this.channels[id];
		// Sample emptiness, emit, THEN mark dirty: if `emit` throws (a DEV
		// missing-field check), `reader.length` stays 0 and a later successful emit
		// would push the id a second time — breaking the at-most-once-per-tick
		// dirty-list invariant. Push only on a clean emit. #728.
		const wasEmpty = channel.reader.length === 0;
		channel.emit(values);
		if (wasEmpty) this.dirtyChannels.push(id);
	}

	public emitSignal(def: EventDef<EmptyEventSchema>): void {
		const id = def as unknown as number;
		const channel = this.channels[id];
		const wasEmpty = channel.reader.length === 0;
		channel.emitSignal();
		if (wasEmpty) this.dirtyChannels.push(id);
	}

	public getEventReader<S extends EventShape<S>>(def: EventDef<S>): EventReader<S> {
		return this.channels[def as unknown as number].reader as EventReader<S>;
	}

	public clearEvents(): void {
		const dirty = this.dirtyChannels;
		const channels = this.channels;
		for (let i = 0; i < dirty.length; i++) {
			channels[dirty[i]].clear();
		}
		dirty.length = 0;
	}

	/** `DEV`-only: total events currently buffered across the dirty channels.
	 * `ECS.update` samples this either side of `dispatchSet` to assert an onSet
	 * observer emitted nothing — its emissions would be wiped by the tick-tail
	 * `clearEvents` and break the empty-channel-at-boundary invariant snapshot /
	 * restore relies on (#586). Walks only the dirty list, never the hot emit path. */
	public devBufferedEventCount(): number {
		const dirty = this.dirtyChannels;
		const channels = this.channels;
		let n = 0;
		for (let i = 0; i < dirty.length; i++) n += channels[dirty[i]].reader.length;
		return n;
	}

	public registerEventByKey<S extends EventShape<S>>(
		key: symbol,
		fields: readonly (keyof S & string)[]
	): EventDef<S> {
		if (this.keyMap.has(key)) {
			throw new ECSError(
				ECS_ERROR.EVENT_ALREADY_REGISTERED,
				`event '${key.description ?? "<unnamed>"}' is already registered`,
				{ event: key.description }
			);
		}
		const def = this.registerEvent<S>(fields);
		this.keyMap.set(key, def);
		return def;
	}

	// any: type-erased — caller recovers F from EventKey<F>
	public getEventDefByKey(key: symbol): EventDef<any> {
		const def = this.keyMap.get(key);
		if (def === undefined) {
			throw new ECSError(
				ECS_ERROR.EVENT_NOT_REGISTERED,
				`event '${key.description ?? "<unnamed>"}' is not registered — call ecs.events.register(key, fields) at world setup`,
				{ event: key.description }
			);
		}
		return def;
	}

	public hasEventKey(key: symbol): boolean {
		return this.keyMap.has(key);
	}
}
