import { describe, expect, it } from "vitest";

import { DEFAULT_SAB_ALLOCATOR, growableSabAllocator, wasmMemoryAllocator } from "../allocator";

/**
 * Allocator boundary behaviours. The grow/extend suites exercise these
 * paths *incidentally*; this file pins them at their own boundary so a
 * regression surfaces here rather than as a corrupted live Store. Each
 * test maps to a finding in #552.
 */

describe("DEFAULT_SAB_ALLOCATOR", () => {
	it("returns a SharedArrayBuffer of at least the requested size", () => {
		const buffer = DEFAULT_SAB_ALLOCATOR(128);
		expect(buffer).toBeInstanceOf(SharedArrayBuffer);
		expect(buffer.byteLength).toBeGreaterThanOrEqual(128);
	});

	it("allocates a fresh buffer per call (prior buffers untouched)", () => {
		const a = DEFAULT_SAB_ALLOCATOR(64);
		const b = DEFAULT_SAB_ALLOCATOR(64);
		// Distinct instances — the default path never reuses a buffer.
		expect(a).not.toBe(b);
	});

	it("is NOT marked is_in_place — fresh-alloc moves memory (ADR-0008)", () => {
		// The load-bearing invariant: views over a returned buffer do NOT
		// survive the next allocator call, so extendColumnStore must take the
		// snapshot+restore path. Flipping this marker corrupts the
		// entity→row map. See docs/adr/0008-in-place-sab-allocator-required.md.
		expect(DEFAULT_SAB_ALLOCATOR.isInPlace).toBeFalsy();
	});
});

describe("growable_sab_allocator — max_bytes validation", () => {
	it("rejects max_bytes <= 0", () => {
		expect(() => growableSabAllocator(0)).toThrow();
		expect(() => growableSabAllocator(-1)).toThrow();
		expect(() => growableSabAllocator(-256 * 1024 * 1024)).toThrow();
	});

	it("rejects non-integer max_bytes", () => {
		expect(() => growableSabAllocator(1.5)).toThrow();
		expect(() => growableSabAllocator(64.0001)).toThrow();
		expect(() => growableSabAllocator(Number.NaN)).toThrow();
		expect(() => growableSabAllocator(Number.POSITIVE_INFINITY)).toThrow();
	});

	it("accepts a positive-integer cap", () => {
		expect(() => growableSabAllocator(64)).not.toThrow();
		expect(() => growableSabAllocator(256 * 1024 * 1024)).not.toThrow();
	});
});

describe("growable_sab_allocator — hard cap throw (#380)", () => {
	it("throws when the FIRST request exceeds max_bytes", () => {
		const alloc = growableSabAllocator(64);
		// The entire #380 design hinges on the cap being fatal — there is no
		// grow-beyond-cap fallback or compaction pass.
		expect(() => alloc(128)).toThrow(/max_bytes/);
	});

	it("throws when a later grow would exceed max_bytes", () => {
		const alloc = growableSabAllocator(64);
		// First allocation under the cap succeeds and reuses one buffer.
		const buffer = alloc(64);
		expect(buffer.byteLength).toBeGreaterThanOrEqual(64);
		// Growing past the cap is fatal, not routed around.
		expect(() => alloc(128)).toThrow(/exceeds the by-design/);
	});

	it("allows requests up to and including max_bytes", () => {
		const alloc = growableSabAllocator(256);
		expect(() => alloc(64)).not.toThrow();
		// Exactly at the cap is fine — the throw is strictly `bytes > maxBytes`.
		expect(() => alloc(256)).not.toThrow();
	});
});

describe("growable_sab_allocator — in-place contract (ADR-0008)", () => {
	it("is marked is_in_place: true", () => {
		expect(growableSabAllocator().isInPlace).toBe(true);
	});

	it("returns the SAME buffer reference across grows (resizes in place)", () => {
		const alloc = growableSabAllocator();
		const first = alloc(64);
		const grown = alloc(128);
		// SharedArrayBuffer.prototype.grow resizes in place — same instance.
		expect(grown).toBe(first);
		expect(grown.byteLength).toBeGreaterThanOrEqual(128);
	});

	it("a shrink-or-equal request returns the existing buffer unchanged", () => {
		const alloc = growableSabAllocator();
		const first = alloc(128);
		const same = alloc(64); // <= current byteLength → no grow
		expect(same).toBe(first);
		expect(same.byteLength).toBeGreaterThanOrEqual(128);
	});
});

describe("wasm_memory_allocator — rejections", () => {
	it("throws when the memory was not constructed with shared: true", () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
		expect(() => wasmMemoryAllocator(memory)).toThrow(/shared/);
	});

	it("throws a contextual error when a needed grow fails (cap reached)", () => {
		// initial 1 page, maximum 2 pages → a request needing 3 pages forces
		// the grow to fail. The JS API throws a RangeError (it does NOT return
		// -1); the allocator must normalise that into its own contextual error
		// naming the requested bytes, with the underlying RangeError preserved
		// as `cause` rather than leaking past the boundary.
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const PAGE = 64 * 1024;
		let caught: Error | undefined;
		try {
			alloc(3 * PAGE);
		} catch (e) {
			caught = e instanceof Error ? e : new Error(String(e));
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toMatch(/memory\.grow/);
		expect(caught?.message).toMatch(/requested=\d+ bytes/);
		// The raw host RangeError is carried as the cause, not swallowed.
		expect(caught?.cause).toBeInstanceOf(RangeError);
	});
});

describe("wasm_memory_allocator — in-place contract (ADR-0008)", () => {
	it("is marked is_in_place: true on shared memory", () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
		expect(wasmMemoryAllocator(memory).isInPlace).toBe(true);
	});

	it("returns a SharedArrayBuffer-backed buffer of at least the requested size", () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 8, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const PAGE = 64 * 1024;
		// Within the current page → returns the existing buffer.
		const within = alloc(1024);
		expect(within).toBeInstanceOf(SharedArrayBuffer);
		expect(within.byteLength).toBeGreaterThanOrEqual(1024);
		// Past the current page → grows and returns a buffer covering the request.
		const grown = alloc(3 * PAGE);
		expect(grown).toBeInstanceOf(SharedArrayBuffer);
		expect(grown.byteLength).toBeGreaterThanOrEqual(3 * PAGE);
	});
});
