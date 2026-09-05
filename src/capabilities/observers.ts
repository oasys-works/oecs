/***
 * The observers capability. Callbacks the world runs on a change.
 *
 * Install it to give a world `ecs.observe`, which registers an `onAdd`,
 * `onRemove`, `onDisable`, `onEnable` or `onSet` callback against a component.
 * A world that does not install it carries none of the registry, the ordering,
 * or the radix sort the entity-grain `onSet` drain uses.
 *
 * The store's structural flush is gated on its own observer counts, which stay
 * zero when nothing registers, so a world without the capability runs the same
 * flush loops it ran before. The world checks for the registry once per
 * `update()` and once at startup. Neither is in a loop.
 *
 * The registry needs the world's shared system context, not just the store: an
 * observer callback receives the same context a system does, so it sees the
 * same access span. That is why this capability reads `host.context`, and why
 * it cannot be installed on a bare store.
 ***/

import { ObserverRegistry } from "../core/ecs/observer";
import type { Capability, CapabilityHost } from "../core/ecs/capability";
import type {
	ArchetypeSetObserverConfig,
	EntitySetObserverConfig,
	ObserverConfig,
	ObserverHandle,
	StructuralObserverConfig
} from "../core/ecs/observer";
import type { ComponentHandle } from "../core/ecs/component";
import type { SparseComponentDef } from "../core/ecs/sparse_store";

/** The world surface this capability adds. The overloads match the ones `ECS`
 * carried before the split, so a call site does not change. */
export interface ObserversCapability {
	observe(def: ComponentHandle, config: StructuralObserverConfig): ObserverHandle;
	observe(def: ComponentHandle, config: EntitySetObserverConfig): ObserverHandle;
	observe(def: ComponentHandle, config: ArchetypeSetObserverConfig): ObserverHandle;
	observe(def: SparseComponentDef, config: EntitySetObserverConfig): ObserverHandle;
}

/** The observers capability, for `ECS.create({ plugins: [observers()] })`. */
export function observers(): Capability<ObserversCapability> {
	return {
		name: "observers",
		install(host: CapabilityHost): ObserversCapability {
			const registry = new ObserverRegistry(host.store, host.context);
			host.installObservers(registry);
			host.store.setStructuralObserverHook((ev) => registry.dispatchStructural(ev));
			return {
				observe(def: ComponentHandle | SparseComponentDef, config: ObserverConfig): ObserverHandle {
					return registry.register(def, config);
				}
			} as ObserversCapability;
		}
	};
}
