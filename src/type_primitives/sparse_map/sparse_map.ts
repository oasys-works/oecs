/***
 * SparseMap — O(1) integer-keyed map with cache-friendly dense iteration.
 *
 * Keys are non-negative integers. Two parallel dense arrays (keys + values)
 * enable linear iteration. A sparse number[] maps key → dense index for
 * O(1) get/set/delete.
 *
 * Membership is verified by cross-referencing dense_keys[sparse[key]] === key,
 * so stale sparse entries are harmless. Deletion uses swap-and-pop.
 *
 ***/

/**
 * O(1) integer-keyed map with cache-friendly dense iteration.
 *
 */
export class SparseMap<V> {
	private _denseKeys: number[] = [];
	private _denseVals: V[] = [];
	private _sparse: number[] = [];

	public get size(): number {
		return this._denseKeys.length;
	}

	public get keys(): readonly number[] {
		return this._denseKeys;
	}

	public has(key: number): boolean {
		return this._denseKeys[this._sparse[key]] === key;
	}

	public get(key: number): V | undefined {
		return this.has(key) ? this._denseVals[this._sparse[key]] : undefined;
	}

	public set(key: number, value: V): void {
		if (this.has(key)) {
			this._denseVals[this._sparse[key]] = value;
			return;
		}
		this._sparse[key] = this._denseKeys.length;
		this._denseKeys.push(key);
		this._denseVals.push(value);
	}

	public delete(key: number): boolean {
		if (!this.has(key)) return false;
		const row = this._sparse[key];
		const lastKey = this._denseKeys[this._denseKeys.length - 1];
		// Swap-and-pop: move last entry into the deleted slot
		this._denseKeys[row] = lastKey;
		this._denseVals[row] = this._denseVals[this._denseVals.length - 1];
		this._sparse[lastKey] = row;
		this._denseKeys.pop();
		this._denseVals.pop();
		return true;
	}

	public clear(): void {
		this._denseKeys.length = 0;
		this._denseVals.length = 0;
		this._sparse.length = 0;
	}

	public forEach(fn: (key: number, value: V) => void): void {
		for (let i = 0; i < this._denseKeys.length; i++) {
			fn(this._denseKeys[i], this._denseVals[i]);
		}
	}

	[Symbol.iterator](): Iterator<[number, V]> {
		let i = 0;
		const keys = this._denseKeys;
		const vals = this._denseVals;
		return {
			next(): IteratorResult<[number, V]> {
				if (i < keys.length) {
					return { value: [keys[i], vals[i++]], done: false };
				}
				// Iterator idiom: consumers ignore `value` when `done` is true,
				// but TS still types it as [number, V] per IteratorResult<T>.
				return { value: undefined as unknown as [number, V], done: true };
			}
		};
	}
}
