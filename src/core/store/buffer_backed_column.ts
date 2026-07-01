/**
 * BufferBackedColumn — `GrowableTypedArray<T>` API over a fixed SAB view.
 *
 * Plan §6.1.3 wants Archetype's per-column storage to come from a single
 * SharedArrayBuffer instead of a per-archetype `new TypedArrayFor[tag](cap)`.
 * The challenge is that `Archetype._flatColumns` calls `push` / `pop` /
 * `swapRemove` / `bulkAppend` / `bulkAppendZeroes` / `clear`, and a
 * fixed-length TypedArray view doesn't expose any of those.
 *
 * BufferBackedColumn wraps a view at a known `(byte_off, row_capacity)` inside
 * a SAB and tracks a logical length on top of it. Capacity is the view's
 * length; overrun throws. Growth (via SAB realloc + `view_stamp` bump) lands
 * in #171 §6.1.4 — until then, callers must size `row_capacity` for the
 * worst case at construction time.
 *
 * Surface intentionally mirrors `GrowableTypedArray<T>` so the same archetype
 * code paths work against either backing without per-call branching.
 */

import type { ColumnBacking } from "../../type_primitives";

import type { AnyTypedArray } from "./column_store";

/** Thrown when an operation would grow a fixed-capacity SAB column. The
 * grow path (re-allocate the SAB, bump `view_stamp`, rebuild views) is a
 * separate sub-task; until it lands, hitting capacity is a hard error so
 * the symptom surfaces immediately rather than silently corrupting state. */
export class StoreColumnOverflowError extends Error {
	public readonly capacity: number;
	public readonly requested: number;

	constructor(capacity: number, requested: number) {
		super(`BufferBackedColumn overflow: requested length ${requested} exceeds capacity ${capacity}`);
		this.name = "StoreColumnOverflowError";
		this.capacity = capacity;
		this.requested = requested;
	}
}

export class BufferBackedColumn<T extends AnyTypedArray> implements ColumnBacking<T> {
	private _buf: T;
	private _capacity: number;
	private _len = 0;

	/** `view` MUST be a TypedArray constructed over a SAB at the correct
	 * stride alignment (see `createColumnStore`). The column treats
	 * `view.length` as the immutable capacity for the lifetime of this view —
	 * call `refreshView` after a SAB realloc to point at the new view. */
	constructor(view: T) {
		this._buf = view;
		this._capacity = view.length;
	}

	/** Swap the backing view to one over a freshly-grown SAB. The caller is
	 * responsible for having copied the first `length` elements into
	 * `newView` already (`growColumnStore` does this). The logical length is
	 * preserved across the swap; capacity becomes `newView.length`.
	 *
	 * Used to honour the `view_stamp` invariant after a host-side SAB realloc
	 * (#171 §6.1.4 / §8.1): every cached column view must be rebuilt before
	 * the next read/write. */
	public refreshView(newView: T): void {
		if (newView.length < this._len) {
			throw new StoreColumnOverflowError(newView.length, this._len);
		}
		this._buf = newView;
		this._capacity = newView.length;
	}

	public get length(): number {
		return this._len;
	}

	public get capacity(): number {
		return this._capacity;
	}

	public push(value: number): void {
		if (this._len >= this._capacity) {
			throw new StoreColumnOverflowError(this._capacity, this._len + 1);
		}
		this._buf[this._len++] = value;
	}

	public pop(): number {
		return this._buf[--this._len];
	}

	public get(i: number): number {
		return this._buf[i];
	}

	public setAt(i: number, value: number): void {
		this._buf[i] = value;
	}

	/** Move the last element into slot `i`, decrement length. Returns the
	 * value previously at slot `i`. Matches `GrowableTypedArray.swapRemove`. */
	public swapRemove(i: number): number {
		const removed = this._buf[i];
		this._buf[i] = this._buf[--this._len];
		return removed;
	}

	public clear(): void {
		this._len = 0;
	}

	/** Set the logical length directly, declaring that `[0, len)` of the backing
	 * SAB view already holds valid data. The snapshot-mount path
	 * (`Archetype.restoreHostRows`, #789) uses this to re-sync the column's
	 * logical length with the restored `Archetype.length` — the bytes come from
	 * the restored SAB, but `_len` is host state. Throws on overrun (cannot grow
	 * a fixed SAB view here — the mount already adopted the restored capacity). */
	public setLength(len: number): void {
		if (len > this._capacity) {
			throw new StoreColumnOverflowError(this._capacity, len);
		}
		this._len = len;
	}

	/** Raw backing view. Stable for the lifetime of the SAB; views over a
	 * SAB do not invalidate the way a `GrowableTypedArray`'s `buf` does
	 * after a grow. (`view_stamp` will signal "underlying SAB swapped"
	 * once #171 §6.1.4 lands.) */
	public get buf(): T {
		return this._buf;
	}

	/** Zero-copy subarray of valid data (`0..length-1`). */
	public view(): T {
		// TypedArray interop: `subarray` returns the same concrete constructor
		// as `_buf` at runtime, but the lib.dom signature widens to the base
		// TypedArray. Narrow back to the caller's `T`. Mirrors
		// `GrowableTypedArray.view()`.
		return this._buf.subarray(0, this._len) as unknown as T;
	}

	[Symbol.iterator](): Iterator<number> {
		let i = 0;
		const buf = this._buf;
		const len = this._len;
		return {
			next(): IteratorResult<number> {
				if (i < len) return { value: buf[i++], done: false };
				return { value: 0, done: true };
			}
		};
	}

	/** Throw if the backing view cannot hold `capacity` elements. Mirrors
	 * `GrowableTypedArray.ensureCapacity` but cannot allocate — a SAB
	 * grow requires republishing the underlying buffer and rebuilding views
	 * across every archetype, which is the §6.1.4 invariant. */
	public ensureCapacity(capacity: number): void {
		if (capacity > this._capacity) {
			throw new StoreColumnOverflowError(this._capacity, capacity);
		}
	}

	/** Append `count` elements from `src[srcOffset..srcOffset+count]`.
	 * Throws on overrun. */
	public bulkAppend(src: T, srcOffset: number, count: number): void {
		this.ensureCapacity(this._len + count);
		// TypedArray interop: `_buf` and `src` share constructor `T` at runtime;
		// the lib.dom `set()` overloads can't see that, hence the cast.
		this._buf.set(src.subarray(srcOffset, srcOffset + count) as unknown as T, this._len);
		this._len += count;
	}

	/** Append `count` zeroes. Throws on overrun. */
	public bulkAppendZeroes(count: number): void {
		this.ensureCapacity(this._len + count);
		this._buf.fill(0, this._len, this._len + count);
		this._len += count;
	}

	/** Append `count` copies of `value`. Throws on overrun. Single-pass
	 * analogue of `bulkAppendZeroes` for a non-zero default. */
	public bulkAppendValue(value: number, count: number): void {
		this.ensureCapacity(this._len + count);
		this._buf.fill(value, this._len, this._len + count);
		this._len += count;
	}
}
