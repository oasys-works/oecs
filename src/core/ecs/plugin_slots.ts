/***
 * The plugin slots a bare world carries, and the guard that fills them.
 *
 * What this file owns: the value a world puts in the member of a plugin it
 * never installed, and the dev refusal of a facade member that would overwrite
 * something the world already has.
 *
 * What it refuses: the `PluginHost` and every type that names a world. The
 * surface guard takes the world as a plain object, so this module stays out of
 * the type cycle that `plugin.ts` and `ecs.ts` share.
 *
 * Cold path. The slots are built once per process, and the guard runs once per
 * plugin under a `__DEV__` build.
 ***/

import { ECSError, ECS_ERROR } from "./utils/error";
import { pluginMissingError } from "./utils/plugin_error";

/** What a world puts in the reserved slot of a plugin it never installed.
 *
 * The slot has to hold something. Left `undefined`, a JavaScript caller reading
 * `ecs.relations.add` meets a `TypeError` about a property of undefined. That
 * fault names neither the plugin nor the import that supplies it. The proxy
 * turns every named read into the fault the world defines.
 *
 * A symbol read and a key that `Object.prototype` answers behave as a plain
 * object does. The `toJSON` and `then` protocol keys do the same. So
 * `console.log`, `JSON.stringify`, a string coercion and an `await` inspect the
 * slot without a fault. Only a member read reaches the throw. Frozen and built
 * once per plugin, because a world holds the shared instance. */
function reservePluginSlot(plugin: string): object {
	return Object.freeze(
		new Proxy(Object.freeze({}), {
			get(_target: object, key: string | symbol): unknown {
				if (
					typeof key === "symbol" ||
					key in Object.prototype ||
					key === "toJSON" ||
					key === "then"
				) {
					return Reflect.get(Object.prototype, key);
				}
				throw pluginMissingError(plugin, `ecs.${plugin}.${key}`);
			}
		})
	);
}

export const MISSING_RELATIONS: object = reservePluginSlot("relations");
export const MISSING_EVENTS: object = reservePluginSlot("events");
export const MISSING_WORKERS: object = reservePluginSlot("workers");

/** The world members a plugin is meant to replace. Each one exists on a
 * bare world only to name the plugin that fills it, so a facade landing on
 * one is the design and not a collision. */
const PLUGIN_RESERVED_SLOTS: readonly string[] = [
	"relations",
	"events",
	"observe",
	"snapshots",
	"workers"
];

/** The reserved `observe` slot. A function, because a caller calls it. */
export function missingObserve(): never {
	throw pluginMissingError("observers", "ecs.observe");
}

/** Refuse a facade member that would overwrite something the world already
 * carries. `Object.assign` is silent about it, and the loss is a method the
 * world needs. The reserved slots are the exception: a bare world
 * declares each one so it can name the missing plugin, and the
 * plugin that fills the slot is meant to replace it. Dev-only. */
export function assertPluginSurface(world: object, plugin: string, surface: object): void {
	const keys = Object.keys(surface);
	for (let k = 0; k < keys.length; k++) {
		const key = keys[k];
		if (PLUGIN_RESERVED_SLOTS.indexOf(key) >= 0) continue;
		if (key in world) {
			throw new ECSError(
				ECS_ERROR.PLUGIN_SURFACE_COLLISION,
				`the ${plugin} plugin contributes ${key}, and the world already carries that member. Rename the member the plugin adds`,
				{ plugin, key }
			);
		}
	}
}
