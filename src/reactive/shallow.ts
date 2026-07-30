/**
 * Shallow (one-level) value equality — the recommended `eq` for object-valued
 * projections. Mirrors zustand `useShallow` / MobX `comparer.shallow`: two objects
 * are equal iff they have the same own keys with `Object.is`-equal values. Restores
 * "equal write wakes nobody" for projections that build a fresh object each tick.
 *
 * Lives in the kernel entry (`/reactive`) — it has zero ECS dependency
 *; `/reactive-sync` re-exports it for compatibility.
 */
export function shallow(a: object, b: object): boolean {
	if (Object.is(a, b)) return true;
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const ka = Object.keys(ra);
	if (ka.length !== Object.keys(rb).length) return false;
	for (let i = 0; i < ka.length; i++) {
		const k = ka[i];
		if (!Object.prototype.hasOwnProperty.call(rb, k) || !Object.is(ra[k], rb[k])) return false;
	}
	return true;
}
