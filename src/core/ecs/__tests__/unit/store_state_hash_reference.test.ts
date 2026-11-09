/**
 * Store.stateHash against a reference fold.
 *
 * The reference below is the digest written the slow way: every column word
 * assembled from four little-endian byte loads, every sparse field split into
 * two little-endian words through a `DataView`. `stateHash` takes faster routes
 * to the same words (a `Uint32Array` view on a 4-byte column, a direct column
 * read on a sparse field). This file pins that the routes change the speed and
 * not the value: every column type, odd row counts, a disabled partition, and
 * both the shared and the heap backing.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { Store } from "../../store";
import type { Archetype } from "../../archetype";
import type { SparseComponentStore } from "../../sparse_store";
import type { EntityID } from "../../entity";
import type { TypedArrayTag } from "../../../../type_primitives";

const BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

const step = (h: number, w: number): number => Math.imul((h ^ w) >>> 0, PRIME) >>> 0;

/** The fold of one column's live bytes, one byte load at a time. */
function foldColumnBytes(h: number, buf: ArrayBufferView, lenBytes: number): number {
	const b = new Uint8Array(buf.buffer, buf.byteOffset, lenBytes);
	const words = lenBytes >>> 2;
	for (let w = 0; w < words; w++) {
		const k = w * 4;
		h = step(h, (b[k] | (b[k + 1] << 8) | (b[k + 2] << 16) | (b[k + 3] << 24)) >>> 0);
	}
	const tail = lenBytes & 3;
	if (tail !== 0) {
		const k = words * 4;
		let t = b[k];
		if (tail > 1) t |= b[k + 1] << 8;
		if (tail > 2) t |= b[k + 2] << 16;
		h = step(h, t >>> 0);
	}
	return h;
}

/** The dense part: (id, len, enabledCount, live column bytes) per archetype. */
function referenceDense(h: number, archs: readonly Archetype[]): number {
	for (const arch of archs) {
		h = step(h, arch.id as number);
		h = step(h, arch.length);
		h = step(h, arch.enabledCount);
		if (arch.length === 0) continue;
		for (const col of arch.flatColumns) {
			const buf = col.buf;
			h = foldColumnBytes(h, buf, arch.length * buf.BYTES_PER_ELEMENT);
		}
	}
	return h;
}

/** The sparse part: (id, size, then index and f64 words per member). */
function referenceSparse(h: number, stores: readonly SparseComponentStore[]): number {
	const dv = new DataView(new ArrayBuffer(8));
	for (let s = 0; s < stores.length; s++) {
		const store = stores[s];
		h = step(h, s);
		h = step(h, store.size);
		const idxs = Array.from(store.indices).sort((a, b) => a - b);
		for (const index of idxs) {
			h = step(h, index);
			for (const v of store.getRow(index)!) {
				dv.setFloat64(0, v, true);
				h = step(h, dv.getUint32(0, true));
				h = step(h, dv.getUint32(4, true));
			}
		}
	}
	return h;
}

function reference(store: Store): number {
	const inner = store as unknown as {
		_archGraph: { archetypes: Archetype[] };
		_sparseStores: SparseComponentStore[];
	};
	let h = BASIS;
	h = referenceDense(h, inner._archGraph.archetypes);
	h = referenceSparse(h, inner._sparseStores);
	return h >>> 0;
}

const storeOf = (w: ECS): Store => (w as unknown as { _store: Store })._store;

const TYPES: readonly TypedArrayTag[] = ["i32", "u32", "i16", "u16", "i8", "u8"];

/** A world with one archetype per column type, a mixed archetype, odd row
 * counts, negative and high-bit values, a disabled partition, and a sparse
 * store with fields of every width. */
function build(memory: { backing: "heap" } | undefined, rows: number): ECS {
	const w = new ECS({ deterministic: true, ...(memory ? { memory } : {}) });
	const single = TYPES.map((t) => w.registerComponent({ a: t, b: t }));
	const Mixed = w.registerComponent({ p: "u8", q: "i32", r: "u16", s: "i8", t: "u32", u: "i16" });
	const Aura = w.registerSparseComponent({ a: "i32", b: "u8", c: "u32", d: "i16" });
	const ids: EntityID[] = [];
	let seed = 0x2545f491;
	const rnd = (): number => {
		seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0;
		return seed;
	};
	for (let c = 0; c < single.length; c++) {
		for (let i = 0; i < rows + c; i++) {
			ids.push(w.spawnBundle(single[c]({ a: rnd() | 0, b: -(rnd() & 0xffff) })));
		}
	}
	for (let i = 0; i < rows + 3; i++) {
		ids.push(
			w.spawnBundle(
				Mixed({ p: rnd(), q: rnd() | 0, r: rnd(), s: rnd() | 0, t: rnd(), u: rnd() | 0 }),
				single[0]({ a: i, b: -i })
			)
		);
	}
	for (let i = 0; i < ids.length; i += 3)
		w.addSparse(ids[i], Aura, { a: -i, b: i, c: rnd(), d: -i });
	for (let i = 1; i < ids.length; i += 5) w.disable(ids[i]);
	w.flush();
	return w;
}

describe("stateHash equals the byte-at-a-time reference fold", () => {
	for (const backing of ["shared", "heap"] as const) {
		for (const rows of [0, 1, 2, 3, 5, 7, 64, 129]) {
			it(`${backing} backing, ${rows} base rows`, () => {
				const w = build(backing === "heap" ? { backing: "heap" } : undefined, rows);
				const s = storeOf(w);
				expect(s.stateHash()).toBe(reference(s));
			});
		}
	}

	it("still agrees after a grow, a despawn churn and a field write", () => {
		const w = build({ backing: "heap" }, 9);
		const s = storeOf(w);
		const A = w.registerComponent({ v: "u16", k: "i32" });
		const more: EntityID[] = [];
		for (let i = 0; i < 3001; i++) more.push(w.spawnBundle(A({ v: i, k: -i })));
		for (let i = 0; i < more.length; i += 7) w.despawn(more[i]);
		w.flush();
		w.setField(more[1], A, "k", 0x7fffffff);
		expect(s.stateHash()).toBe(reference(s));
	});
});
