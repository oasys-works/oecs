/***
 * `ecs.events`, the world surface the events plugin adds.
 *
 * The host-side half of the channel API. A system body emits and reads through
 * `ctx`, which reaches the same registry.
 *
 * Constructed once per world. Holds no state of its own.
 ***/

import type {
	EmptyEventSchema,
	EventDef,
	EventFieldsCover,
	EventKey,
	EventReader,
	EventShape,
	SignalKey
} from "../../core/ecs/event";
import { dispatchTrace } from "../../core/ecs/dispatch_trace";
import { DEV } from "../../dev_flag";
import type { EventRegistry } from "./event_registry";

/** Event channels and signals. Emit during one `update()`, visible to every
 * later system in that call, cleared before the next. System-side reads and
 * emits go through `ctx`. This facade is the host-side surface. */
export class ECSEvents {
	private readonly _registry: EventRegistry;
	/** @internal constructed by the events plugin. */
	constructor(registry: EventRegistry) {
		this._registry = registry;
	}

	/** Register an event channel at world setup, before anything emits on it.
	 * `fields` must name every schema key, an under-registered channel would
	 * silently drop the missing fields at emit (see `EventFieldsCover`).
	 *
	 * @example
	 * const Damaged = eventKey<{ target: EntityID; amount: number }>("Damaged");
	 * ecs.events.register(Damaged, ["target", "amount"]);
	 * ecs.events.emit(Damaged, { target: e, amount: 10 }); // or ctx.emit inside a system
	 */
	public register<S extends EventShape<S>, const F extends readonly (keyof S & string)[]>(
		key: EventKey<S>,
		fields: F & EventFieldsCover<S, F>
	): void {
		this._registry.registerByKey<S>(key, fields);
	}

	/** Register a signal (empty-payload event channel). */
	public registerSignal(key: SignalKey): void {
		this._registry.registerByKey<EmptyEventSchema>(key, []);
	}

	public emit(key: SignalKey): void;
	public emit<S extends EventShape<S>>(key: EventKey<S>, values: NoInfer<S>): void;
	// Erased implementation position spells `<any>`, not the bare/`unknown`
	// form, `EventKey` is invariant under the typestate seams (function-typed
	// phantom), so only `<any>` erases (see project typestate constraints).
	public emit(key: EventKey<any>, values?: Record<string, number>): void {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventEmit(key.description ?? "");
		}
		const def = this._registry.defByKey(key);
		if (values === undefined) {
			this._registry.emitSignal(def as EventDef<EmptyEventSchema>);
		} else {
			this._registry.emit(def, values);
		}
	}

	public read<S extends EventShape<S>>(key: EventKey<S>): EventReader<S> {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventRead(key.description ?? "");
		}
		const def = this._registry.defByKey(key);
		return this._registry.reader(def) as EventReader<S>;
	}
}
