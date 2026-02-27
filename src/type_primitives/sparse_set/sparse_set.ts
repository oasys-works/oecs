/***
 * SparseSet — O(1) integer-key set with cache-friendly dense iteration.
 *
 * Keys are non-negative integers. A dense number[] holds members packed
 * at 0..size-1 for linear iteration. A sparse number[] maps
 * key → dense index for O(1) has/add/delete.
 *
 * Membership is verified by cross-referencing dense[sparse[key]] === key,
 * so stale sparse entries are harmless (no clearing needed on delete).
 * Deletion uses swap-and-pop to keep data contiguous.
 *
 ***/

export class SparseSet {
  private _dense: number[] = [];
  private _sparse: number[] = [];

  public get size(): number {
    return this._dense.length;
  }

  public get values(): readonly number[] {
    return this._dense;
  }

  public has(key: number): boolean {
    return this._dense[this._sparse[key]] === key;
  }

  public add(key: number): void {
    if (this.has(key)) return;
    this._sparse[key] = this._dense.length;
    this._dense.push(key);
  }

  public delete(key: number): boolean {
    if (!this.has(key)) return false;
    const row = this._sparse[key];
    const last = this._dense[this._dense.length - 1];
    // Swap the last element into the deleted slot, then pop
    this._dense[row] = last;
    this._sparse[last] = row;
    this._dense.pop();
    return true;
  }

  public clear(): void {
    this._dense.length = 0;
    this._sparse.length = 0;
  }

  [Symbol.iterator](): Iterator<number> {
    return this._dense[Symbol.iterator]();
  }
}
