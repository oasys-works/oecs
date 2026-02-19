/***
 *
 * SparseSet — O(1) integer-key set with cache-friendly dense iteration
 *
 * Keys are non-negative integers. A dense number[] holds members packed
 * at 0..size-1 for fast linear iteration. A sparse number[] maps
 * key → dense index for O(1) membership test and O(1) deletion
 * via swap-and-pop. Membership is verified by cross-referencing the
 * dense array (piecs-style), so stale sparse entries are harmless.
 *
 ***/

export class SparseSet {
  private _dense: number[] = [];
  private _sparse: number[] = [];

  get size(): number {
    return this._dense.length;
  }

  /** Live view of members. Valid indices: 0..size-1. Do not mutate. */
  get values(): readonly number[] {
    return this._dense;
  }

  has(key: number): boolean {
    return this._dense[this._sparse[key]] === key;
  }

  /** Add key. No-op if already present. */
  add(key: number): void {
    if (this.has(key)) return;
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
    return true;
  }

  clear(): void {
    this._dense.length = 0;
    this._sparse.length = 0;
  }

  [Symbol.iterator](): Iterator<number> {
    return this._dense[Symbol.iterator]();
  }
}
