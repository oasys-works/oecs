/***
 *
 * SparseMap — O(1) integer-keyed map with cache-friendly dense value storage
 *
 * Keys are non-negative integers. Two parallel dense arrays (keys and values)
 * enable fast linear iteration over entries. A sparse Int32Array maps
 * key → dense index for O(1) get/set/delete.
 * Deletion uses swap-and-pop to keep data dense.
 *
 ***/

const ABSENT = -1;
const INITIAL_CAPACITY = 64;

export class SparseMap<V> {
  private _dense_keys: number[] = [];
  private _dense_vals: V[] = [];
  private _sparse: Int32Array;
  private _capacity: number;

  constructor(initial_capacity = INITIAL_CAPACITY) {
    this._capacity = initial_capacity;
    this._sparse = new Int32Array(initial_capacity).fill(ABSENT);
  }

  get size(): number {
    return this._dense_keys.length;
  }

  /** Live view of keys. Valid indices: 0..size-1. Do not mutate. */
  get keys(): readonly number[] {
    return this._dense_keys;
  }

  has(key: number): boolean {
    return key >= 0 && key < this._capacity && this._sparse[key] !== ABSENT;
  }

  get(key: number): V | undefined {
    if (!this.has(key)) return undefined;
    return this._dense_vals[this._sparse[key]];
  }

  /**
   * Insert or overwrite an entry. O(1) amortised.
   */
  set(key: number, value: V): void {
    if (this.has(key)) {
      this._dense_vals[this._sparse[key]] = value;
      return;
    }
    this._ensure(key);
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
    this._sparse[key] = ABSENT;
    return true;
  }

  clear(): void {
    for (let i = 0; i < this._dense_keys.length; i++) {
      this._sparse[this._dense_keys[i]] = ABSENT;
    }
    this._dense_keys.length = 0;
    this._dense_vals.length = 0;
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

  //=========================================================
  // Internal
  //=========================================================

  private _ensure(key: number): void {
    if (key < this._capacity) return;
    let cap = this._capacity;
    while (cap <= key) cap *= 2;
    const next = new Int32Array(cap).fill(ABSENT);
    next.set(this._sparse);
    this._sparse = next;
    this._capacity = cap;
  }
}
