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

export type TypedArrayTag =
  | "f32"
  | "f64"
  | "i8"
  | "i16"
  | "i32"
  | "u8"
  | "u16"
  | "u32";

export type AnyTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

export class GrowableTypedArray<T extends AnyTypedArray> {
  private _buf: T;
  private _len = 0;

  constructor(
    private readonly _ctor: new (n: number) => T,
    initial_capacity = 16,
  ) {
    this._buf = new _ctor(initial_capacity);
  }

  get length(): number {
    return this._len;
  }

  push(value: number): void {
    if (this._len >= this._buf.length) this._grow();
    this._buf[this._len++] = value;
  }

  pop(): number {
    return this._buf[--this._len];
  }

  get(i: number): number {
    return this._buf[i];
  }

  set_at(i: number, value: number): void {
    this._buf[i] = value;
  }

  /**
   * Move the last element into slot i, decrement length.
   * Returns the value that was removed from slot i.
   */
  swap_remove(i: number): number {
    const removed = this._buf[i];
    this._buf[i] = this._buf[--this._len];
    return removed;
  }

  clear(): void {
    this._len = 0;
  }

  /**
   * Raw backing buffer. Valid data: indices 0..length-1.
   * This reference is stable until the next push() that triggers a grow —
   * do not cache across entity additions.
   */
  get buf(): T {
    return this._buf;
  }

  /**
   * Zero-copy subarray view of valid data (0..length-1).
   * Shares the backing buffer — invalidated if a subsequent push() grows.
   */
  view(): T {
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
      },
    };
  }

  private _grow(): void {
    const next = new this._ctor(this._buf.length * 2);
    next.set(this._buf);
    this._buf = next;
  }
}

export class GrowableFloat32Array extends GrowableTypedArray<Float32Array> {
  constructor(initial_capacity = 16) {
    super(Float32Array, initial_capacity);
  }
}

export class GrowableFloat64Array extends GrowableTypedArray<Float64Array> {
  constructor(initial_capacity = 16) {
    super(Float64Array, initial_capacity);
  }
}

export class GrowableInt8Array extends GrowableTypedArray<Int8Array> {
  constructor(initial_capacity = 16) {
    super(Int8Array, initial_capacity);
  }
}

export class GrowableInt16Array extends GrowableTypedArray<Int16Array> {
  constructor(initial_capacity = 16) {
    super(Int16Array, initial_capacity);
  }
}

export class GrowableInt32Array extends GrowableTypedArray<Int32Array> {
  constructor(initial_capacity = 16) {
    super(Int32Array, initial_capacity);
  }
}

export class GrowableUint8Array extends GrowableTypedArray<Uint8Array> {
  constructor(initial_capacity = 16) {
    super(Uint8Array, initial_capacity);
  }
}

export class GrowableUint16Array extends GrowableTypedArray<Uint16Array> {
  constructor(initial_capacity = 16) {
    super(Uint16Array, initial_capacity);
  }
}

export class GrowableUint32Array extends GrowableTypedArray<Uint32Array> {
  constructor(initial_capacity = 16) {
    super(Uint32Array, initial_capacity);
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
  u32: GrowableUint32Array,
} as const satisfies Record<
  TypedArrayTag,
  new (cap?: number) => GrowableTypedArray<AnyTypedArray>
>;
