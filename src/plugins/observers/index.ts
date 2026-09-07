/***
 * The observers plugin. Callbacks the world runs on a change.
 *
 * Install it to give a world `ecs.observe`, which registers an `onAdd`,
 * `onRemove`, `onDisable`, `onEnable` or `onSet` callback against a component.
 * A world that does not install it carries none of the registry, the ordering,
 * or the radix sort the entity-grain `onSet` drain uses.
 *
 * The store's structural flush is gated on its own observer counts, which stay
 * zero when nothing registers, so a world without the plugin runs the same
 * flush loops it ran before. The registry rides the world's settle hooks and
 * its prewarm hooks, both generic, and neither is in a loop.
 *
 * The registry needs the store and the world's shared system context. An
 * observer callback receives the same context a system does, so it sees the
 * same access span. That is why this plugin reads `host.context`, and why
 * it cannot be installed on a bare store.
 ***/

import { ObserverRegistry } from "./observer_registry";
import type { Plugin, PluginHost } from "../../core/ecs/plugin";
import type {
	ArchetypeSetObserverConfig,
	EntitySetObserverConfig,
	ObserverConfig,
	ObserverHandle,
	StructuralObserverConfig
} from "../../core/ecs/observer";
import type { ComponentHandle } from "../../core/ecs/component";
import type { SparseComponentDef } from "../../core/ecs/sparse_store";

export { ObserverRegistry } from "./observer_registry";

/** The world surface this plugin adds. The overloads match the ones `ECS`
 * carried before the split, so a call site does not change.
 *
 * `observe` registers the callbacks in `config` against `def`. `onAdd`,
 * `onRemove`, `onDisable` and `onEnable` fire at the structural flush, after
 * the batch commits, in canonical order (access-topological across
 * observers, entity id order within), and the flush loops to a fixed point
 * so a cascade settles. `onSet` fires at the settle of `update()`. Register
 * before `startup()`. The handle's `dispose()` unregisters. Cold path. */
export interface ObserversPlugin {
	observe(def: ComponentHandle, config: StructuralObserverConfig): ObserverHandle;
	observe(def: ComponentHandle, config: EntitySetObserverConfig): ObserverHandle;
	observe(def: ComponentHandle, config: ArchetypeSetObserverConfig): ObserverHandle;
	observe(def: SparseComponentDef, config: EntitySetObserverConfig): ObserverHandle;
}

/** The observers plugin, for `ECS.create({ plugins: [observers()] })`. */
export function observers(): Plugin<ObserversPlugin> {
	return {
		name: "observers",
		install(host: PluginHost): ObserversPlugin {
			const registry = new ObserverRegistry(host.store, host.context);
			// The registry is one settle consumer among others, and it takes its
			// place in install order like any other.
			host.onSettle((run) => registry.dispatchSet(run));
			// An observer that spawns or transitions carries the same access
			// shape a system does, so its target archetype is planted at startup
			// rather than first-touched mid-tick.
			host.onPrewarm(() => registry.descriptors());
			host.changes.addStructuralHook((ev) => registry.dispatchStructural(ev));
			return {
				observe(def: ComponentHandle | SparseComponentDef, config: ObserverConfig): ObserverHandle {
					return registry.register(def, config);
				}
			} as ObserversPlugin;
		}
	};
}
