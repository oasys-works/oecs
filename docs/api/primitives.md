# Primitives

`@oasys/oecs/primitives` gives you the low-level data structures that the ECS is built from, so that
you can use them directly. They operate alone, and they have no dependencies. So they are useful
far outside an ECS. The package does not export the internal helpers for assertions, brands, and
errors, and that is intentional.

```ts
import { BitSet, SparseSet, SparseMap, BinaryHeap, topologicalSort,
         GrowableFloat64Array, GrowableUint32Array } from "@oasys/oecs/primitives";
```

## `BitSet`

A bit set that grows automatically, with a `number[]` behind it. This is how oecs represents the
component signature of an archetype.

```ts
new BitSet(words?: number[]);
has(bit): boolean;   set(bit): void;   clear(bit): void;
isEmpty(): boolean;   overlaps(other): boolean;   contains(other): boolean;   equals(other): boolean;
copy(): BitSet;   copyInto(target): BitSet;   copyWithSet(bit): BitSet;   copyWithClear(bit): BitSet;
hash(): number;   forEach(fn: (bit: number) => void): void;
```

## `SparseSet`

This adds, deletes, and tests dense integer keys in O(1) time, and you can iterate the values as a
dense array. It is correct for "which entity ids are in this set", and it needs no hash map.

```ts
new SparseSet();
get size: number;   get values: readonly number[];
has(key): boolean;   add(key): void;   delete(key): boolean;   clear(): void;
[Symbol.iterator](); // iterates the dense values
```

## `SparseMap<V>`

A map from integer keys to values of type `V`, with a sparse set behind it.

```ts
new SparseMap<V>();
get size: number;   get keys: readonly number[];
has(key): boolean;   get(key): V | undefined;   set(key, value): void;   delete(key): boolean;
clear(): void;   forEach(fn: (key: number, value: V) => void): void;
[Symbol.iterator](); // iterates [key, value] pairs
```

## The `GrowableTypedArray` family

These are typed-array columns that grow automatically. They are the storage behind a component. Use
the concrete subclass for the type of element that you want:

```ts
GrowableFloat32Array   GrowableFloat64Array
GrowableInt8Array      GrowableInt16Array    GrowableInt32Array
GrowableUint8Array     GrowableUint16Array   GrowableUint32Array
// each: new GrowableXArray(initialCapacity = 16)
```

```ts
get length: number;   push(value): void;   pop(): number;   get(i): number;   setAt(i, value): void;
swapRemove(i): number;   clear(): void;   setLength(len): void;
get buf: T;   view(): T;                       // the typed array below
ensureCapacity(n): void;
bulkAppend(src, srcOffset, count): void;   bulkAppendZeroes(count): void;   bulkAppendValue(value, count): void;
[Symbol.iterator]();
```

> [!WARNING]
> A `push` or an append that causes growth makes `buf` and `view()` invalid, because the object
> allocates a new buffer. Do not keep the reference across an append. Read it again after the
> append.

## `BinaryHeap<T>`

A minimum heap, with an order from a comparator. It is the queue of ready nodes behind the
topological sort.

```ts
type CompareFn<T> = (a: T, b: T) => number;
new BinaryHeap<T>(compare: CompareFn<T>);
get size: number;   peek(): T | undefined;   push(value): void;   pop(): T | undefined;   clear(): void;
```

## `topologicalSort<T>`

Kahn's algorithm, with a `BinaryHeap` as the queue of ready nodes. It is the deterministic core
that puts the systems in order.

```ts
topologicalSort<T>(
  nodes: readonly T[],
  edges: Map<T, T[]>,               // edges.get(a) = the nodes that must come AFTER a
  tiebreaker: (a: T, b: T) => number,  // puts the nodes that are ready at the same time in order (a lower value is a higher priority)
  nodeName?: (node: T) => string,
): T[];
```

> [!NOTE]
> It throws a plain `TypeError` for a cycle, and the message names the nodes that it cannot
> schedule, through `nodeName`. The `tiebreaker` makes the output deterministic for the nodes that
> are ready at the same time.

## See also

- [schedule](./schedule.md) — `topologicalSort` in use, to put the systems of a phase in order
- [components](./components.md) — the typed-array columns that `GrowableTypedArray` supports
