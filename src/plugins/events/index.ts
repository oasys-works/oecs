/***
 * The events plugin. Host-side channels and signals.
 *
 * Install it to give a world `ecs.events`, and to let a system body call
 * `ctx.emit` and `ctx.readEvents`. A world that does not install it carries no
 * channel array, no key map and no ring, and its tick tail skips the clear.
 *
 * An event channel lives for one `update()`. Every system later in that call
 * reads what an earlier one emitted, and the world clears the channels at the
 * tick tail. That lifetime is why the plugin is a construction-time choice
 * and not a lazy one: a channel registered mid-frame would miss its own clear.
 *
 * Cold path. Registration is world setup, and emit and read are per-event.
 ***/

import { EventRegistry } from "./event_registry";
import { ECSEvents } from "./facade";
import type { Plugin, PluginHost } from "../../core/ecs/plugin";

export { ECSEvents } from "./facade";

/** The world surface this plugin adds. */
export interface EventsPlugin {
	readonly events: ECSEvents;
}

/** The events plugin, for `ECS.create({ plugins: [events()] })`. */
export function events(): Plugin<EventsPlugin> {
	return {
		name: "events",
		install(host: PluginHost): EventsPlugin {
			const registry = new EventRegistry();
			host.store.installEvents(registry);
			return { events: new ECSEvents(registry) };
		}
	};
}
