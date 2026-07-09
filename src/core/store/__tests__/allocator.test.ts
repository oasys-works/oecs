import { describe, expect, it } from "vitest";

import {
	DEFAULT_SAB_ALLOCATOR,
	growableSabAllocator,
	heapArraybufferAllocator,
	wasmMemoryAllocator,
	StoreCapExceededError
} from "../allocator";

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

describe("growable_sab_allocator — maxBytes validation", () => {
	it("rejects maxBytes <= 0", () => {
		expect(() => growableSabAllocator(0)).toThrow();
		expect(() => growableSabAllocator(-1)).toThrow();
		expect(() => growableSabAllocator(-256 * 1024 * 1024)).toThrow();
	});

	it("rejects non-integer maxBytes", () => {
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
	it("throws when the FIRST request exceeds maxBytes", () => {
		const alloc = growableSabAllocator(64);
		// The entire #380 design hinges on the cap being fatal — there is no
		// grow-beyond-cap fallback or compaction pass.
		expect(() => alloc(128)).toThrow(/maxBytes/);
	});

	it("throws when a later grow would exceed maxBytes", () => {
		const alloc = growableSabAllocator(64);
		// First allocation under the cap succeeds and reuses one buffer.
		const buffer = alloc(64);
		expect(buffer.byteLength).toBeGreaterThanOrEqual(64);
		// Growing past the cap is fatal, not routed around.
		expect(() => alloc(128)).toThrow(/exceeds the by-design/);
	});

	it("allows requests up to and including maxBytes", () => {
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

// The two growable single-buffer allocators are one factory parameterized
// over the buffer primitive (M9). This matrix runs the same scenarios over
// both so any future divergence in cap arithmetic, in-place reporting, or
// buffer-identity semantics fails loudly on the strategy that drifted.
describe.each([
	["growable_sab_allocator", growableSabAllocator, SharedArrayBuffer as ArrayBufferLike["constructor"]],
	["heap_arraybuffer_allocator", heapArraybufferAllocator, ArrayBuffer as ArrayBufferLike["constructor"]]
] as const)("%s — shared growable-allocator contract", (_label, factory, BufferCtor) => {
	it("rejects invalid maxBytes", () => {
		expect(() => factory(0)).toThrow(/positive integer/);
		expect(() => factory(-1)).toThrow(/positive integer/);
		expect(() => factory(1.5)).toThrow(/positive integer/);
	});

	it("returns the right buffer type at the requested size", () => {
		const alloc = factory(256);
		const buffer = alloc(64);
		expect(buffer).toBeInstanceOf(BufferCtor);
		expect(buffer.byteLength).toBeGreaterThanOrEqual(64);
	});

	it("returns the SAME buffer instance across grows (in-place contract)", () => {
		const alloc = factory(256);
		const first = alloc(64);
		const second = alloc(128);
		expect(second).toBe(first);
		expect(second.byteLength).toBeGreaterThanOrEqual(128);
	});

	it("is marked is_in_place (ADR-0008)", () => {
		expect(factory(64).isInPlace).toBe(true);
	});

	it("preserves views + data across a grow", () => {
		const alloc = factory(256);
		const view = new Int32Array(alloc(64), 0, 4);
		view[0] = 42;
		view[3] = 7;
		alloc(128);
		expect(view[0]).toBe(42);
		expect(view[3]).toBe(7);
	});

	it("throws StoreCapExceededError past the cap, with the cap attached (#380)", () => {
		const alloc = factory(64);
		alloc(64); // exactly at cap is fine
		try {
			alloc(65);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(StoreCapExceededError);
			expect((e as StoreCapExceededError).requestedBytes).toBe(65);
			expect((e as StoreCapExceededError).capBytes).toBe(64);
		}
	});

	it("no-ops a request smaller than the current size (returns same buffer)", () => {
		const alloc = factory(256);
		const grown = alloc(128);
		const shrunk = alloc(32);
		expect(shrunk).toBe(grown);
		expect(shrunk.byteLength).toBeGreaterThanOrEqual(128);
	});
});

// ── 0.5.3 regression guard: the heap buffer MUST stay FIXED ──────────────────
// The pure-TS heap profile's iteration speed rests on one structural fact: its
// `ArrayBuffer` is NON-resizable and born at the full cap. V8 has no fast
// element-access path for TypedArray views over a resizable/growable buffer, so
// a column view over a resizable ArrayBuffer deopts every `col[i]` (~4-5× slower
// iteration — exactly the 0.5.0→0.5.2 regression this pins against). The
// `byteLength >= n` assertions in the shared matrix above pass for BOTH the fixed
// and the resizable shape, so they can't catch a revert; these lock the fixed
// shape directly. If you're here because these fail after "optimizing" the heap
// allocator back to a resizable buffer: don't — see `heapArraybufferAllocator`.
describe("heap_arraybuffer_allocator — fixed-buffer fast-path invariant (0.5.3)", () => {
	it("reserves the FULL cap up front, not the requested size", () => {
		const cap = 4 * 1024 * 1024;
		// Request a tiny 64 bytes; a resizable buffer would hand back byteLength 64.
		const buffer = heapArraybufferAllocator(cap)(64);
		expect(buffer).toBeInstanceOf(ArrayBuffer);
		expect(buffer.byteLength).toBe(cap);
	});

	it("is NON-resizable — the property that keeps col[i] on V8's fast path", () => {
		const cap = 2 * 1024 * 1024;
		// ES2024 `resizable`/`maxByteLength` aren't in the project's ES2022 lib
		// types; read through a narrow shape so the assertion stays strict.
		const buffer = heapArraybufferAllocator(cap)(1024) as unknown as {
			resizable: boolean;
			maxByteLength: number;
			byteLength: number;
		};
		expect(buffer.resizable).toBe(false);
		// A fixed buffer reports maxByteLength === byteLength (=== cap here); a
		// resizable one would report maxByteLength === cap but byteLength === 1024.
		expect(buffer.maxByteLength).toBe(cap);
		expect(buffer.byteLength).toBe(cap);
	});

	it("contrast: growable_sab_allocator IS growable — the shape heap must NOT have", () => {
		const sab = growableSabAllocator(4 * 1024 * 1024)(1024) as unknown as { growable: boolean };
		expect(sab.growable).toBe(true);
	});
});
