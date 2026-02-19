/***
 *
 * SparseMap — O(1) integer-keyed map with cache-friendly dense value storage
 *
 * Keys are non-negative integers. Two parallel dense arrays (keys and values)
 * enable fast linear iteration over entries. A sparse number[] maps
 * key → dense index for O(1) get/set/delete. Membership is verified by
 * cross-referencing the dense key array (piecs-style), so stale sparse
 * entries are harmless.
 * Deletion uses swap-and-pop to keep data dense.
 *
 ***/

export class SparseMap<V> {
  private _dense_keys: number[] = [];
  private _dense_vals: V[] = [];
  private _sparse: number[] = [];

  get size(): number {
    return this._dense_keys.length;
  }

  /** Live view of keys. Valid indices: 0..size-1. Do not mutate. */
  get keys(): readonly number[] {
    return this._dense_keys;
  }

  has(key: number): boolean {
    return this._dense_keys[this._sparse[key]] === key;
  }

  get(key: number): V | undefined {
    return this.has(key) ? this._dense_vals[this._sparse[key]] : undefined;
  }

  /**
   * Insert or overwrite an entry. O(1) amortised.
   */
  set(key: number, value: V): void {
    if (this.has(key)) {
      this._dense_vals[this._sparse[key]] = value;
      return;
    }
    this._sparse[key] = this._dense_keys.length;
    this._dense_keys.push(key);
    this._dense_vals.push(value);
  }

  /**
   * Remove an entry via swap-and-pop. O(1).
   * Returns true if the key was present, false if it was absent.
   */
  delete(key: number): boolean {
    if (!this.has(key)) return false;
    const row = this._sparse[key];
    const last_key = this._dense_keys[this._dense_keys.length - 1];
    this._dense_keys[row] = last_key;
    this._dense_vals[row] = this._dense_vals[this._dense_vals.length - 1];
    this._sparse[last_key] = row;
    this._dense_keys.pop();
    this._dense_vals.pop();
    return true;
  }

  clear(): void {
    this._dense_keys.length = 0;
    this._dense_vals.length = 0;
    this._sparse.length = 0;
  }

  for_each(fn: (key: number, value: V) => void): void {
    for (let i = 0; i < this._dense_keys.length; i++) {
      fn(this._dense_keys[i], this._dense_vals[i]);
    }
  }

  [Symbol.iterator](): Iterator<[number, V]> {
    let i = 0;
    const keys = this._dense_keys;
    const vals = this._dense_vals;
    return {
      next(): IteratorResult<[number, V]> {
        if (i < keys.length) {
          return { value: [keys[i], vals[i++]], done: false };
        }
        return { value: undefined as unknown as [number, V], done: true };
      },
    };
  }
}
