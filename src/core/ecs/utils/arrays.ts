/***
 * Array utilities. Hash-bucket push, and the canonical entity-id order.
 *
 * `radixSortByIndex` lives here and not beside one caller, because two plugins
 * want it and neither may import the other. The observers plugin sorts an
 * entity-grain drain with it. The relations plugin sorts a hierarchy pass with
 * it. A core home is what keeps the relation code free of the observer code.
 ***/

// Local copy of the entity-id mask, the way `store.ts` keeps its own. Importing
// it would pull the whole packed-id codec into every plugin bundle that sorts,
// and the width is fixed by the id layout, not by a build option.
const INDEX_MASK = (1 << 20) - 1; // entity.ts: 20-bit dense index

/** Push a value into a hash-bucket map, creating the bucket array if absent. */
export function bucketPush<T>(map: Map<number, T[]>, key: number, value: T): void {
	const bucket = map.get(key);
	if (bucket !== undefined) {
		bucket.push(value);
	} else {
		map.set(key, [value]);
	}
}

/**
 * O(K) LSD radix sort of entity ids by their 20-bit dense index (two 10-bit
 * passes), in place. This is the canonical within-observer order, *never* a
 * comparator `Array.sort`, which the bench measured as much slower than the
 * entire flush. Distinct live entities have distinct indices,
 * so index order is a total canonical order. `out` is typed scratch, and the
 * return value is the scratch to keep: the same buffer, or a larger one when
 * `K` outgrew it. `c0` / `c1` are 1024-entry histograms (reused).
 */
export function radixSortByIndex(
	eids: number[],
	out: Uint32Array,
	c0: Int32Array,
	c1: Int32Array
): Uint32Array {
	const K = eids.length;
	if (K < 2) return out;
	if (out.length < K) {
		let n = out.length;
		while (n < K) n *= 2;
		out = new Uint32Array(n);
	}
	c0.fill(0);
	c1.fill(0);
	for (let k = 0; k < K; k++) {
		const v = eids[k] & INDEX_MASK;
		c0[v & 1023]++;
		c1[(v >> 10) & 1023]++;
	}
	for (let i = 1; i < 1024; i++) {
		c0[i] += c0[i - 1];
		c1[i] += c1[i - 1];
	}
	for (let k = K - 1; k >= 0; k--) {
		const v = eids[k];
		out[--c0[v & INDEX_MASK & 1023]] = v;
	}
	for (let k = K - 1; k >= 0; k--) {
		const v = out[k];
		eids[--c1[((v & INDEX_MASK) >> 10) & 1023]] = v;
	}
	return out;
}
