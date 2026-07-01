/***
 * BinaryHeap — generic array-backed binary heap with configurable ordering.
 *
 * Array layout uses implicit indexing: root at index 0, children of node `i`
 * at `2i + 1` and `2i + 2`, parent of node `i` at `(i - 1) >> 1`.
 *
 * The comparator determines ordering: when `compare(a, b) < 0`, `a` has
 * higher priority and floats toward the root. A standard `(a, b) => a - b`
 * comparator yields a min-heap; `(a, b) => b - a` yields a max-heap.
 *
 * push and pop are O(log n). peek and clear are O(1).
 *
 ***/

export type CompareFn<T> = (a: T, b: T) => number;

/**
 * Generic array-backed binary heap with configurable comparator.
 *
 */
export class BinaryHeap<T> {
	private readonly _compare: CompareFn<T>;
	private readonly _data: T[] = [];

	constructor(compare: CompareFn<T>) {
		this._compare = compare;
	}

	public get size(): number {
		return this._data.length;
	}

	/** Returns the highest-priority element without removing it, or undefined if empty. */
	public peek(): T | undefined {
		return this._data[0];
	}

	/** Inserts a value and restores heap order by sifting up. O(log n). */
	public push(value: T): void {
		this._data.push(value);
		this._siftUp(this._data.length - 1);
	}

	/** Removes and returns the highest-priority element, or undefined if empty. O(log n). */
	public pop(): T | undefined {
		const data = this._data;
		const len = data.length;
		if (len === 0) return undefined;

		const top = data[0];
		const last = data.pop()!;
		if (data.length > 0) {
			data[0] = last;
			this._siftDown(0);
		}
		return top;
	}

	/** Removes all elements. O(1). */
	public clear(): void {
		this._data.length = 0;
	}

	/** Moves a node up toward the root until heap order is restored. */
	private _siftUp(index: number): void {
		const data = this._data;
		const compare = this._compare;
		const value = data[index];

		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (compare(value, data[parent]) >= 0) break;
			data[index] = data[parent];
			index = parent;
		}
		data[index] = value;
	}

	/** Moves a node down away from the root until heap order is restored. */
	private _siftDown(index: number): void {
		const data = this._data;
		const compare = this._compare;
		const len = data.length;
		const half = len >> 1; // nodes at index >= half are leaves
		const value = data[index];

		while (index < half) {
			let best = (index << 1) + 1; // left child
			const right = best + 1;

			// Pick the child with higher priority (smaller compare value)
			if (right < len && compare(data[right], data[best]) < 0) {
				best = right;
			}

			if (compare(data[best], value) >= 0) break;
			data[index] = data[best];
			index = best;
		}
		data[index] = value;
	}
}
