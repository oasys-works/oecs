/***
 * GrowableTypedArray — TypedArray wrapper with amortised O(1) append.
 *
 * TypedArrays have fixed length — resizing requires allocating a new
 * buffer and copying. GrowableTypedArray wraps one with a separate
 * logical length and doubles the backing buffer on overflow.
 *
 * Named subclasses (GrowableFloat32Array etc.) are provided for each
 * numeric type. TypedArrayFor maps TypeTag strings to their class so
 * component columns can be allocated by tag.
 *
 ***/

export const DEFAULT_INITIAL_CAPACITY = 16;
export const GROWTH_FACTOR = 2;

export type TypedArrayTag = "f32" | "f64" | "i8" | "i16" | "i32" | "u8" | "u16" | "u32";

export type AnyTypedArray =
	| Float32Array
	| Float64Array
	| Int8Array
	| Int16Array
	| Int32Array
	| Uint8Array
	| Uint16Array
	| Uint32Array;

/**
 * Common surface of a row-addressable column buffer. `GrowableTypedArray<T>`
 * implements it over a heap-allocated TypedArray; SAB-backed columns (see
 * `packages/engine/src/core/sab/sab_backed_column.ts`) implement it over a
 * `SharedArrayBuffer` view at a known offset. Archetype column storage
 * targets this interface so a single code path serves both backings.
 */
export interface ColumnBacking<T extends AnyTypedArray> {
	readonly length: number;
	readonly buf: T;
	push(value: number): void;
	pop(): number;
	swapRemove(i: number): number;
	clear(): void;
	view(): T;
	ensureCapacity(capacity: number): void;
	bulkAppend(src: T, srcOffset: number, count: number): void;
	bulkAppendZeroes(count: number): void;
	bulkAppendValue(value: number, count: number): void;
	/** Set the logical length directly, declaring that `[0, len)` already holds
	 * valid data. The snapshot-mount path (`Archetype.restoreHostRows`)
	 * uses this: a restored SAB carries the column bytes, but the column's logical
	 * length is host state that must be re-synced with `Archetype.length`. Throws
	 * if `len` exceeds capacity. NOT a hot-path method — push/pop track length. */
	setLength(len: number): void;
}

/**
 * TypedArray wrapper with amortised O(1) append. Doubles the backing buffer on overflow.
 *
 */
export class GrowableTypedArray<T extends AnyTypedArray> implements ColumnBacking<T> {
	private _buf: T;
	private _len = 0;

	constructor(
		private readonly _ctor: new (n: number) => T,
		initialCapacity = 16
	) {
		this._buf = new _ctor(initialCapacity);
	}

	public get length(): number {
		return this._len;
	}

	public push(value: number): void {
		if (this._len >= this._buf.length) this._grow();
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

	/**
	 * Move the last element into slot i, decrement length.
	 * Returns the value that was removed from slot i.
	 */
	public swapRemove(i: number): number {
		const removed = this._buf[i];
		this._buf[i] = this._buf[--this._len];
		return removed;
	}

	public clear(): void {
		this._len = 0;
	}

	/** Set the logical length directly (snapshot-mount reconstruction). The
	 * caller guarantees `[0, len)` already holds valid data. Grows the backing if
	 * needed so the length is always representable. */
	public setLength(len: number): void {
		this.ensureCapacity(len);
		this._len = len;
	}

	/**
	 * Raw backing buffer. Valid data: indices 0..length-1.
	 * This reference is stable until the next push() that triggers a grow —
	 * do not cache across entity additions.
	 */
	public get buf(): T {
		return this._buf;
	}

	/**
	 * Zero-copy subarray view of valid data (0..length-1).
	 * Shares the backing buffer — invalidated if a subsequent push() grows.
	 */
	public view(): T {
		// TypedArray interop: `subarray` returns the same concrete constructor
		// as `_buf` at runtime, but the lib.dom signature widens to the base
		// TypedArray. Narrow back to the caller's `T`.
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

	/** Ensure the backing buffer can hold at least `capacity` elements without growing. */
	public ensureCapacity(capacity: number): void {
		if (capacity <= this._buf.length) return;
		let newCap = this._buf.length || 1;
		while (newCap < capacity) newCap *= GROWTH_FACTOR;
		const next = new this._ctor(newCap);
		next.set(this._buf.subarray(0, this._len));
		this._buf = next;
	}

	/**
	 * Append `count` elements from `src` starting at `srcOffset`.
	 * Grows if needed. Equivalent to push() in a loop but uses TypedArray.set().
	 */
	public bulkAppend(src: T, srcOffset: number, count: number): void {
		this.ensureCapacity(this._len + count);
		// TypedArray interop: `_buf` and `src` share constructor `T` at runtime;
		// the lib.dom `set()` overloads can't see that, hence the cast.
		this._buf.set(src.subarray(srcOffset, srcOffset + count) as any, this._len);
		this._len += count;
	}

	/** Append `count` zeroes. Grows if needed. */
	public bulkAppendZeroes(count: number): void {
		this.ensureCapacity(this._len + count);
		this._buf.fill(0, this._len, this._len + count);
		this._len += count;
	}

	/** Append `count` copies of `value`. Grows if needed. Single-pass
	 * analogue of `bulkAppendZeroes` for a non-zero default. */
	public bulkAppendValue(value: number, count: number): void {
		this.ensureCapacity(this._len + count);
		this._buf.fill(value, this._len, this._len + count);
		this._len += count;
	}

	private _grow(): void {
		const next = new this._ctor(this._buf.length * GROWTH_FACTOR);
		next.set(this._buf);
		this._buf = next;
	}
}

export class GrowableFloat32Array extends GrowableTypedArray<Float32Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Float32Array, initialCapacity);
	}
}

export class GrowableFloat64Array extends GrowableTypedArray<Float64Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Float64Array, initialCapacity);
	}
}

export class GrowableInt8Array extends GrowableTypedArray<Int8Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Int8Array, initialCapacity);
	}
}

export class GrowableInt16Array extends GrowableTypedArray<Int16Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Int16Array, initialCapacity);
	}
}

export class GrowableInt32Array extends GrowableTypedArray<Int32Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Int32Array, initialCapacity);
	}
}

export class GrowableUint8Array extends GrowableTypedArray<Uint8Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Uint8Array, initialCapacity);
	}
}

export class GrowableUint16Array extends GrowableTypedArray<Uint16Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Uint16Array, initialCapacity);
	}
}

export class GrowableUint32Array extends GrowableTypedArray<Uint32Array> {
	constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
		super(Uint32Array, initialCapacity);
	}
}

export const TypedArrayFor = {
	f32: GrowableFloat32Array,
	f64: GrowableFloat64Array,
	i8: GrowableInt8Array,
	i16: GrowableInt16Array,
	i32: GrowableInt32Array,
	u8: GrowableUint8Array,
	u16: GrowableUint16Array,
	u32: GrowableUint32Array
} as const satisfies Record<TypedArrayTag, new (cap?: number) => GrowableTypedArray<AnyTypedArray>>;
