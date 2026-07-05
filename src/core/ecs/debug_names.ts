/***
 * Component debug names (POLISH_AUDIT #4).
 *
 * `registerComponent(schema, { name: "Pos" })` records a human label for the
 * def so dev-mode diagnostics can say `'Pos' (component 5)` instead of leaving
 * the user to count registration order. Keyed on the callable def object (a
 * WeakMap), not the numeric id — ids restart per world, so an id-keyed global
 * would collide across worlds while the def object is world-unique.
 *
 * Names are diagnostic only: never read on a hot path, no effect on layout,
 * hashing, snapshots, or replay.
 ***/

import type { ComponentHandle } from "./component";

const componentNames = new WeakMap<object, string>();

export function setComponentDebugName(def: ComponentHandle, name: string): void {
	componentNames.set(def as object, name);
}

/** `'Pos' (component 5)` when named at registration, else `component 5`. */
export function componentLabel(def: ComponentHandle): string {
	const name = componentNames.get(def as object);
	return name !== undefined ? `'${name}' (component ${def.id})` : `component ${def.id}`;
}
