/**
 * `@oasys/oecs/primitives` — the general-purpose data-structure primitives the
 * ECS is built on, surfaced for direct consumer use: a bit set, sparse set/map,
 * growable typed arrays, a binary heap, and a topological sort.
 *
 * These are the low-level building blocks only; the ECS itself is the default
 * `@oasys/oecs` entry. The internal assertion, brand, and error helpers under
 * `src/type_primitives/` are intentionally NOT re-exported here.
 *
 * @module
 */
export { BitSet } from "./type_primitives/bitset/bitset";
export { SparseSet } from "./type_primitives/sparse_set/sparse_set";
export { SparseMap } from "./type_primitives/sparse_map/sparse_map";
export {
	GrowableTypedArray,
	GrowableFloat32Array,
	GrowableFloat64Array,
	GrowableInt8Array,
	GrowableInt16Array,
	GrowableInt32Array,
	GrowableUint8Array,
	GrowableUint16Array,
	GrowableUint32Array,
	type TypedArrayTag,
	type AnyTypedArray
} from "./type_primitives/typed_arrays/typed_arrays";
export { BinaryHeap, type CompareFn } from "./type_primitives/binary_heap/binary_heap";
export { topologicalSort } from "./type_primitives/topological_sort/topological_sort";
