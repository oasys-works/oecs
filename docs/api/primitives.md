# Primitives

`@oasys/oecs/primitives` exposes the low-level data structures the ECS is built on, for direct reuse. They're standalone and dependency-free — handy well outside an ECS. (The internal assertion/brand/error helpers are intentionally *not* exported.)

```ts
import { BitSet, SparseSet, SparseMap, BinaryHeap, topologicalSort,
         GrowableFloat64Array, GrowableUint32Array } from "@oasys/oecs/primitives";
```

## `BitSet`

An auto-growing bit set backed by a `number[]` — how archetype component signatures are represented.

```ts
new BitSet(words?: number[]);
has(bit): boolean;   set(bit): void;   clear(bit): void;
isEmpty(): boolean;   overlaps(other): boolean;   contains(other): boolean;   equals(other): boolean;
copy(): BitSet;   copyInto(target): BitSet;   copyWithSet(bit): BitSet;   copyWithClear(bit): BitSet;
hash(): number;   forEach(fn: (bit: number) => void): void;
```

## `SparseSet`

O(1) add/delete/has of dense integer keys, with the values iterable as a dense array. Ideal for "which entity ids are in this set" without a hash map.

```ts
new SparseSet();
get size: number;   get values: readonly number[];
has(key): boolean;   add(key): void;   delete(key): boolean;   clear(): void;
```

## `SparseMap<V>`

A sparse-set-backed map from integer keys to values `V`.

```ts
new SparseMap<V>();
get size: number;   get keys: readonly number[];
has(key): boolean;   get(key): V | undefined;   set(key, value): void;   delete(key): boolean;
clear(): void;   forEach(fn: (key: number, value: V) => void): void;
```

## `GrowableTypedArray` family

Auto-growing typed-array columns — the backing behind component storage. Use the concrete subclass for the element type you want:

```ts
GrowableFloat32Array   GrowableFloat64Array
GrowableInt8Array      GrowableInt16Array    GrowableInt32Array
GrowableUint8Array     GrowableUint16Array   GrowableUint32Array
// each: new GrowableXArray(initialCapacity = 16)
```

```ts
get length: number;   push(value): void;   pop(): number;   get(i): number;   setAt(i, value): void;
swapRemove(i): number;   clear(): void;   setLength(len): void;
get buf: T;   view(): T;                       // the underlying typed array
ensureCapacity(n): void;
bulkAppend(src, srcOffset, count): void;   bulkAppendZeroes(count): void;   bulkAppendValue(value, count): void;
[Symbol.iterator]();
```

> [!WARNING]
> `buf` and `view()` are invalidated by any `push`/append that triggers a grow (the buffer is reallocated) — don't cache the reference across appends; re-fetch it after.

## `BinaryHeap<T>`

A min-heap ordered by a comparator — the ready queue behind the topological sort.

```ts
type CompareFn<T> = (a: T, b: T) => number;
new BinaryHeap<T>(compare: CompareFn<T>);
get size: number;   peek(): T | undefined;   push(value): void;   pop(): T | undefined;   clear(): void;
```

## `topologicalSort<T>`

Kahn's algorithm with a `BinaryHeap` ready queue — the deterministic system-ordering core.

```ts
topologicalSort<T>(
  nodes: readonly T[],
  edges: Map<T, T[]>,               // edges.get(a) = nodes that must come AFTER a
  tiebreaker: (a: T, b: T) => number,  // orders simultaneously-ready nodes (lower = higher priority)
  nodeName?: (node: T) => string,
): T[];
```

> [!NOTE]
> Throws a plain `TypeError` on a cycle, naming the unschedulable nodes (via `nodeName`). The `tiebreaker` makes the output deterministic among nodes that are ready at the same time.

## See also

- [schedule](./schedule.md) — `topologicalSort` in action, ordering systems within a phase
- [components](./components.md) — the typed-array columns `GrowableTypedArray` backs
