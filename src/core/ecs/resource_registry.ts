/***
 * ResourceRegistry, the world's symbol-keyed resource dictionary.
 *
 * Extracted from `Store`, which keeps one-line delegations. Fully
 * self-contained (no Store reach-back). Resources stay out of `stateHash` and
 * out of snapshot and resume. This is host-side state, not simulation state.
 ***/

import { ECS_ERROR, ECSError } from "./utils/error";

export class ResourceRegistry {
	private readonly _values: Map<symbol, unknown> = new Map();

	public register(key: symbol, value: unknown): void {
		if (this._values.has(key)) {
			throw new ECSError(
				ECS_ERROR.RESOURCE_ALREADY_REGISTERED,
				`resource '${key.description ?? "<unnamed>"}' is already registered, remove() it first if you meant to replace it`,
				{ resource: key.description }
			);
		}
		this._values.set(key, value);
	}

	public get(key: symbol): unknown {
		if (!this._values.has(key)) {
			throw new ECSError(
				ECS_ERROR.RESOURCE_NOT_REGISTERED,
				`resource read: '${key.description ?? "<unnamed>"}' is not registered, call ecs.resources.register(key, value) at world setup`,
				{ resource: key.description }
			);
		}
		return this._values.get(key);
	}

	public set(key: symbol, value: unknown): void {
		if (!this._values.has(key)) {
			throw new ECSError(
				ECS_ERROR.RESOURCE_NOT_REGISTERED,
				`resource write: '${key.description ?? "<unnamed>"}' is not registered, call ecs.resources.register(key, value) at world setup`,
				{ resource: key.description }
			);
		}
		this._values.set(key, value);
	}

	/** Drop a resource from the world. Fails closed on a missing key (mirrors
	 * `get` and `set`). Afterwards the key is free to `register` again, the
	 * present → absent → present lifecycle. Purely a host-side
	 * dictionary delete with no determinism-hash effect. */
	public remove(key: symbol): void {
		if (!this._values.has(key)) {
			throw new ECSError(
				ECS_ERROR.RESOURCE_NOT_REGISTERED,
				`resource remove: '${key.description ?? "<unnamed>"}' is not registered, call ecs.resources.register(key, value) at world setup`,
				{ resource: key.description }
			);
		}
		this._values.delete(key);
	}

	public has(key: symbol): boolean {
		return this._values.has(key);
	}
}
