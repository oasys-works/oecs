/**
 * kernel_solid — bridge the engine's in-house reactive kernel
 * (`../../reactive`) into SolidJS.
 *
 * The kernel and Solid are SEPARATE reactive graphs: a bare kernel read inside a
 * Solid scope subscribes Solid to nothing. Every kernel value a Solid component
 * depends on must come through `fromKernel`, which mirrors it into a Solid signal
 * driven by the kernel's `subscribe` (fires once per coalesced change, never on an
 * equal write) and is torn down with the surrounding Solid owner via `onCleanup`.
 * Call it inside a component or `root` so that teardown has an owner to attach to.
 *
 * For a keyed entity collection use `fromKernelMap`: render with a Solid `<For>`
 * keyed on `view.keys()` (the stable entity ids) and read each row's value via
 * `view.cell(id)`. Key on the id, never on a per-tick value object, and never use
 * `<Index>` for entities — see `docs/ideas/ecs-to-solid-three-rendering.md` and
 * `workbench/reactive/check_for_keying.ts` for why each of those bites.
 *
 * This is the packaged Solid plugin over oecs's reactive kernel
 * (`@oasys/oecs/reactive`, #646 / ADR-0021), shipped as the `@oasys/oecs/solid`
 * extension. The core stays zero-dependency and framework-agnostic; the
 * `solid-js` dependency lives here in the extension, never in the core.
 */
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { subscribe, type ReactiveArray, type ReactiveMap } from "../../reactive";

/**
 * Mirror a kernel accessor into a Solid accessor. The returned accessor tracks in
 * Solid; it updates once per coalesced kernel change and never on an equal write.
 */
export function fromKernel<T>(accessor: () => T): Accessor<T> {
	const [get, set] = createSignal<T>(accessor());
	onCleanup(subscribe(accessor, (v) => set(() => v)));
	return get;
}

/** A kernel `reactiveMap` projected for a keyed Solid `<For>`. */
export interface KernelMapView<K, V> {
	/** The live key set — pass to a keyed Solid `<For each>`. Keyed on the id. */
	readonly keys: Accessor<readonly K[]>;
	/** A bridged value accessor for one key — read inside the `<For>` row. */
	cell(key: K): Accessor<V | undefined>;
}

/**
 * Bridge a kernel `reactiveMap` for keyed Solid rendering. `keys` drives a `<For>`
 * (one row per entity, keyed on the stable id); `cell(id)` is that row's bridged
 * value. Changing one entity wakes only its row; spawn/despawn add/remove one row.
 */
export function fromKernelMap<K, V>(map: ReactiveMap<K, V>): KernelMapView<K, V> {
	return {
		keys: fromKernel(() => map.keys()),
		cell: (key) => fromKernel(() => map.get(key))
	};
}

/**
 * Bridge a kernel `reactiveStruct` proxy into a Solid-reactive proxy: reading
 * `view.field` in a Solid scope tracks that field alone (one `fromKernel` per
 * field), so a change to one field re-renders only its readers. Completes the
 * `fromKernel` / `fromKernelMap` / `fromKernelStruct` trio — the read side for the
 * singleton/ephemeral UI state `syncSingletonToStruct` publishes (ADR-0024). The
 * field set is read once from the (enumerable) struct proxy; call inside a component
 * or `root` so each field's `onCleanup` has an owner. The kernel struct's per-field
 * `eq` and batching carry through `fromKernel` unchanged.
 */
export function fromKernelStruct<T extends object>(struct: Readonly<T>): Readonly<T> {
	const reads = {} as { [K in keyof T]: Accessor<T[K]> };
	const keys = Object.keys(struct) as Array<keyof T>;
	const fieldSet = new Set<string | symbol>(keys as Array<string | symbol>);
	for (const k of keys) {
		reads[k] = fromKernel(() => struct[k]);
	}
	// Mirror the kernel struct proxy (`reactive/struct.ts`): enumerable, and safe
	// on non-field keys. A get-only proxy threw on `then` / `Symbol.iterator` / `toJSON`
	// (Solid reconcile + JSX, `await`, `JSON.stringify` all probe them), and an empty
	// `ownKeys` made the bridged view non-enumerable to Solid / `Object.keys`.
	return new Proxy({} as T, {
		get: (target, k) => (fieldSet.has(k) ? reads[k as keyof T]() : Reflect.get(target, k)),
		has: (_, k) => fieldSet.has(k),
		ownKeys: () => keys as Array<string | symbol>,
		getOwnPropertyDescriptor: (_, k) =>
			fieldSet.has(k)
				? { get: () => reads[k as keyof T](), enumerable: true, configurable: true }
				: undefined,
		// Read surface only (`Readonly<T>`, POLISH_AUDIT #8) — mirrors the kernel
		// struct proxy's trap so a JS-side assignment fails loudly instead of
		// sticking a non-reactive value on the hidden target.
		set: (_, k) => {
			if (__DEV__) {
				throw new TypeError(
					`fromKernelStruct view is read-only: write through the kernel struct's ` +
						`setters (set.${String(k)}(value)), not the bridged view`
				);
			}
			return false;
		}
	});
}

/**
 * Bridge a kernel `reactiveArray` into a Solid accessor of its snapshot, for a
 * positional Solid `<Index each={view()}>`. `<Index>` (NOT `<For>`) is the match for
 * an ordered slot list: it keys by position and hands each slot an accessor, so
 * duplicate primitive values (e.g. empty army slots) don't alias and a slot change
 * updates only that row. The snapshot is the array's coarse read (any slot change
 * wakes it), but `<Index>` then diffs by position and touches only the changed
 * index's DOM. Use `fromKernelMap` instead for an *entity* collection (keyed, `<For>`).
 */
export function fromKernelArray<T>(arr: ReactiveArray<T>): Accessor<readonly T[]> {
	return fromKernel(() => arr.snapshot());
}
