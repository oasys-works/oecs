import { describe, expect, it } from "vitest";
import {
	INDEX_BITS,
	MAX_GENERATION,
	MAX_INDEX,
	getEntityGeneration,
	createEntityId,
	getEntityIndex
} from "../../entity";

// X and Y chosen to be one bit off from power of 2s
const [x, y] = [31, 7];

// Adversarial round-trip table — replaces a former unseeded
// `Math.random()` 10k-iteration loop (a failure was non-reproducible).
// Every value is chosen for its bit pattern, so the cartesian product
// below exercises the 20-bit index | 11-bit generation boundary far more
// pointedly than random draws did: min/max, one-bit-off-power-of-two, the
// per-field high bit, and the two alternating-bit masks (0x5… / 0xA…) that
// expose any bit leakage across the field boundary.
const ADVERSARIAL_INDICES = [
	0, // min
	1, // low bit
	31, // 0x1F — one bit off 32
	32, // 0x20 — power of two
	0x5_5555, // alternating 0101…
	0xa_aaaa, // alternating 1010…
	0x8_0000, // index high bit
	MAX_INDEX - 1, // 0xFFFFE
	MAX_INDEX // 0xFFFFF — max
];
const ADVERSARIAL_GENERATIONS = [
	0, // min
	1, // low bit
	7, // 0x7 — one bit off 8
	0x2aa, // alternating 01010…
	0x555, // alternating 10101…
	0x400, // generation high bit
	MAX_GENERATION - 1, // 0x7FE
	MAX_GENERATION // 0x7FF — max
];

describe("entity_id with generation", () => {
	//=========================================================
	// Pack & Unpack
	//=========================================================
	it("roundtrips: pack/unpack", () => {
		const id = createEntityId(x, y);
		expect(getEntityIndex(id)).toBe(x);
		expect(getEntityGeneration(id)).toBe(y);
	});

	it("roundtrips: adversarial index × generation table", () => {
		for (const index of ADVERSARIAL_INDICES) {
			for (const generation of ADVERSARIAL_GENERATIONS) {
				const id = createEntityId(index, generation);
				// Assert the unpacked pair as an object so a failure prints the
				// exact (index, generation) that broke, not just two numbers.
				expect({
					index: getEntityIndex(id),
					generation: getEntityGeneration(id)
				}).toEqual({ index, generation });
			}
		}
	});

	//=========================================================
	// Boundaries
	//=========================================================
	it("roundtrips: min boundary", () => {
		const id = createEntityId(0, 0);
		expect(getEntityIndex(id)).toBe(0);
		expect(getEntityGeneration(id)).toBe(0);
	});

	it("roundtrips: max boundary", () => {
		const id = createEntityId(MAX_INDEX, MAX_GENERATION);
		expect(getEntityIndex(id)).toBe(MAX_INDEX);
		expect(getEntityGeneration(id)).toBe(MAX_GENERATION);
	});

	//=========================================================
	// Equality
	//=========================================================
	it("different id per generation", () => {
		const idA = createEntityId(x, 1);
		const idB = createEntityId(x, 2);

		expect(idA).not.toBe(idB);
	});

	it("different id per index", () => {
		const idA = createEntityId(1, y);
		const idB = createEntityId(2, y);

		expect(idA).not.toBe(idB);
	});

	it("always produces unsigned 32-bit IDs", () => {
		const id = createEntityId(MAX_INDEX, MAX_GENERATION);

		expect(id).toBeGreaterThanOrEqual(0);
	});

	//=========================================================
	// Bit Leakage
	//=========================================================
	it("encodes generation in high bits", () => {
		const id = createEntityId(0, 1);

		expect(id).toBe(1 << INDEX_BITS);
	});

	it("MAX_INTEGER does not affect generation unpacking", () => {
		const id = createEntityId(MAX_INDEX, y);

		expect(getEntityGeneration(id)).toBe(y);
	});

	it("MAX_GENERATION does not affect index unpacking", () => {
		const id = createEntityId(x, MAX_GENERATION);

		expect(getEntityIndex(id)).toBe(x);
	});

	//=========================================================
	// Overflow
	//=========================================================
	it("overflow: max index", () => {
		expect(() => createEntityId(MAX_INDEX + 1, y)).toThrow();
	});

	it("overflow: max gen", () => {
		expect(() => createEntityId(x, MAX_GENERATION + 1)).toThrow();
	});
});
