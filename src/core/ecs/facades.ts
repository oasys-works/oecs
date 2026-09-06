/***
 * The core facades. `ecs.resources` and `ecs.snapshots`.
 *
 * Two cohesive secondary surfaces sit off the flat `ECS` namespace on narrow
 * typed facades. Each wraps the same `Store` entry points the flat methods
 * used (monomorphic one-hop delegation, measured as free), and the `DEV`
 * adaptation the flat methods carried (dispatch-trace recording, access
 * checks) sits here with them.
 *
 * `ecs.relations` and `ecs.events` used to live here too. They belong to a
 * plugin now, and each plugin owns its facade. `ECSSnapshots` stays because a
 * bare world carries it: `stateHash()` and `deterministic` are properties of
 * the world, not of the snapshot plugin. The plugin subclasses it to add the
 * capture and restore half.
 *
 * The pre-0.5 flat forms were removed from `ECS` in 0.5.0 (never published
 * as deprecated aliases, 0.5.0 is the break). Hot-path API (component ops,
 * queries, spawn and destroy, sparse ops) stays flat by design.
 *
 * Constructed once per `ECS`. Hold no state of their own.
 */

import type { Store } from "./store";
import type { ResourceKey } from "./resource";
import { accessCheck } from "./access_check";
import { pluginMissingError } from "./utils/plugin_error";
import { dispatchTrace } from "./dispatch_trace";
import { unsafeCast } from "../../type_primitives";
import { DEV } from "../../dev_flag";

/** World resources, singleton values keyed by `ResourceKey<T>`. Runtime
 * mutations (`set` / `remove`) are access-checked as resource writes inside
 * a system span. `register` is a one-time world-setup op. */
export class ECSResources {
	private readonly _store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this._store = store;
	}

	/** Register a resource at world setup. Reading and writing an unregistered
	 * key throws (fail-closed), registration is the explicit "this world has
	 * this singleton" declaration, not a lazy default.
	 *
	 * @example
	 * const GameTime = resourceKey<{ elapsed: number }>("GameTime");
	 * ecs.resources.register(GameTime, { elapsed: 0 });
	 * ecs.resources.get(GameTime).elapsed; // or ctx.getResource(GameTime) inside a system
	 */
	public register<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordResourceRegister(key.description ?? "");
		}
		this._store.resources.register(key, value);
	}

	public get<T>(key: ResourceKey<T>): T {
		if (DEV) {
			accessCheck.assertResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<T>(this._store.resources.get(key));
	}

	public set<T>(key: ResourceKey<T>, value: NoInfer<T>): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this._store.resources.set(key, value);
	}

	/** Drop a resource from the world. Access-checked as a *write*
	 * fails closed on a missing key. Afterwards the key is free to `register`
	 * again, the present → absent → present lifecycle. */
	public remove<T>(key: ResourceKey<T>): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this._store.resources.remove(key);
	}

	public has<T>(key: ResourceKey<T>): boolean {
		return this._store.resources.has(key);
	}
}

/** The determinism surface: world snapshot and resume and the
 * canonical state digest. Every member except `deterministic` throws
 * `DETERMINISM_DISABLED` unless the world was constructed with
 * `{ deterministic: true }`. All cold-path, take captures at tick
 * boundaries (between `update()`s). */
export class ECSSnapshots {
	// Protected, not private: the snapshot plugin subclasses this to add
	// `capture` / `restore`, and reaches the store the same way.
	protected readonly _store: Store;
	/** @internal constructed by `ECS`. */
	constructor(store: Store) {
		this._store = store;
	}

	/** Whether the determinism surface is enabled. */
	public get deterministic(): boolean {
		return this._store.deterministic;
	}

	/** FNV-1a 32 digest over every archetype's live rows in id order, the
	 * canonical "live ECS state digest". Per-call cost scales with live
	 * entity count, not SAB capacity. */
	public stateHash(): number {
		return this._store.stateHash();
	}

}

/** The capture and restore surface, present at run time and absent from the
 * type. A bare world must fail to compile on `ecs.snapshots.capture`. The
 * method cannot appear in the class body, so the snapshot plugin's subclass
 * declares it. A JavaScript caller has no compiler. The prototype answers with
 * the fault that names the import, not with a `TypeError` about a missing
 * method. `ECSSnapshotsFull` overrides all four. */
for (const method of ["capture", "restore", "captureSparse", "restoreSparse"]) {
	(ECSSnapshots.prototype as unknown as Record<string, () => never>)[method] = function (): never {
		throw pluginMissingError("snapshots", `ecs.snapshots.${method}`);
	};
}
