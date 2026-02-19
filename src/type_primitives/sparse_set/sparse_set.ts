/***
 *
 * SparseSet — O(1) integer-key set with cache-friendly dense iteration
 *
 * Keys are non-negative integers. A dense number[] holds members packed
 * at 0..size-1 for fast linear iteration. A sparse Int32Array maps
 * key → dense index for O(1) membership test and O(1) deletion
 * via swap-and-pop.
 *
 ***/

const ABSENT = -1;
const INITIAL_CAPACITY = 64;

export class SparseSet {
  private _dense: number[] = [];
  private _sparse: Int32Array;
  private _capacity: number;

  constructor(initial_capacity = INITIAL_CAPACITY) {
    this._capacity = initial_capacity;
    this._sparse = new Int32Array(initial_capacity).fill(ABSENT);
  }

  get size(): number {
    return this._dense.length;
  }

  /** Live view of members. Valid indices: 0..size-1. Do not mutate. */
  get values(): readonly number[] {
    return this._dense;
  }

  has(key: number): boolean {
    return key >= 0 && key < this._capacity && this._sparse[key] !== ABSENT;
  }

  /** Add key. No-op if already present. */
  add(key: number): void {
    if (this.has(key)) return;
    this._ensure(key);
    this._sparse[key] = this._dense.length;
    this._dense.push(key);
  }

  /**
   * Remove key via swap-and-pop. O(1).
   * Returns true if the key was present, false if it was absent.
   */
  delete(key: number): boolean {
    if (!this.has(key)) return false;
    const row = this._sparse[key];
    const last = this._dense[this._dense.length - 1];
    this._dense[row] = last;
    this._sparse[last] = row;
    this._dense.pop();
    this._sparse[key] = ABSENT;
    return true;
  }

  clear(): void {
    for (let i = 0; i < this._dense.length; i++) {
      this._sparse[this._dense[i]] = ABSENT;
    }
    this._dense.length = 0;
  }

  [Symbol.iterator](): Iterator<number> {
    return this._dense[Symbol.iterator]();
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
