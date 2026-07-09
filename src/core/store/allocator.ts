/**
 * BufferAllocator — pluggable buffer source for the SAB layer (#234 / PR 3D).
 *
 * The engine has historically allocated its SAB as a fresh
 * `new SharedArrayBuffer(totalBytes)` inside `createColumnStore`.
 * Phase 3D requires the SAB to optionally be backed by a
 * `WebAssembly.Memory.buffer` so the WASM sim can read/write the live
 * ECS columns through its own memory handle. This module abstracts the
 * "where does the buffer come from" decision behind a single function
 * type.
 *
 * Contract for every `BufferAllocator`:
 *   - Returns a `SharedArrayBuffer` of byteLength >= `bytes`.
 *   - MAY detach any prior buffer the implementation has handed out
 *     (e.g., `WebAssembly.Memory.grow` detaches existing typed-array
 *     views into the previous buffer). Callers MUST snapshot any data
 *     they need to preserve BEFORE invoking the allocator.
 *   - Returned buffers MAY be larger than `bytes` (e.g., wasm-memory
 *     rounds up to 64 KiB page boundaries). Callers must rely on the
 *     SAB header / descriptor for the canonical layout, not on
 *     `buffer.byteLength`.
 *
 * The default `DEFAULT_SAB_ALLOCATOR` does `new SharedArrayBuffer(bytes)`
 * — fast, allocation-per-call, prior buffers untouched. Production code
 * paths that don't care about wasm interop stay on this.
 *
 * `wasmMemoryAllocator(memory)` returns an allocator that grows the
 * given `WebAssembly.Memory` (in 64 KiB page increments) as needed and
 * returns its current buffer. Used by a host so the
 * engine's SAB IS the sim's memory.
 */

/**
 * Source of `SharedArrayBuffer`s for the SAB layer. See the file header
 * for the contract — in particular, the detachment caveat for in-place
 * implementations.
 *
 * The optional `isInPlace` marker tells the SAB layer that
 * **TypedArray and DataView views built over a returned buffer remain
 * valid after a subsequent allocator call** — reads and writes through
 * the old views land on the same underlying memory the new buffer
 * exposes. The `extendColumnStore` fast path uses this hint to skip the
 * snapshot+restore + view-rebuild work that's only necessary when the
 * memory actually moves.
 *
 * Note: `isInPlace` does NOT promise the SAB *reference* stays
 * identical. `growableSabAllocator` happens to return the same SAB
 * instance every time (`SharedArrayBuffer.prototype.grow` resizes in
 * place); `wasmMemoryAllocator` on shared `WebAssembly.Memory`
 * returns a *new* SAB ref after `memory.grow()`, but old views built
 * over the previous ref keep working — V8 keeps the underlying linear
 * memory mapped at the same address. Verified empirically (this branch,
 * Bun + V8): writes via an old `Int32Array(old_ref, off, len)` after
 * `memory.grow()` are visible through a fresh view over the new ref,
 * and vice versa. Default allocator omits the marker;
 * `growableSabAllocator` and `wasmMemoryAllocator` set it.
 */
export interface BufferAllocator {
	/** Returns a buffer of byteLength >= `bytes`. The historical name is
	 * "SAB", but the return is `ArrayBufferLike`: `growableSabAllocator` /
	 * `wasmMemoryAllocator` produce a `SharedArrayBuffer` (the SAB profile),
	 * while `heapArraybufferAllocator` produces a plain fixed (non-resizable)
	 * `ArrayBuffer` reserved at the cap (the pure-TS heap profile — no
	 * cross-origin isolation required). The store layer treats the backing
	 * uniformly; only the WASM/worker boundary narrows back to
	 * `SharedArrayBuffer`. */
	(bytes: number): ArrayBufferLike;
	readonly isInPlace?: boolean;
}

/**
 * The only allocator shape a **live `Store`** accepts (#682). ADR-0008 makes
 * "a live Store is backed by an in-place allocator" a correctness invariant —
 * the flush loops hoist entity-index views across grows. This brand moves
 * that invariant from runtime convention to the type/construction boundary:
 * `growableSabAllocator` / `wasmMemoryAllocator` / `heapArraybufferAllocator`
 * return it; `DEFAULT_SAB_ALLOCATOR` keeps the wide `BufferAllocator` type and
 * therefore cannot typecheck where a live-Store backing is required. Non-in-place
 * allocators remain valid for snapshot/test sizing only. The brand says nothing
 * about *shared* vs *heap* backing — `heapArraybufferAllocator`'s fixed
 * `ArrayBuffer` is just as in-place as a growable SAB: it is reserved at the full
 * cap up front and never moves, so grow/extend relocate columns *within* it
 * (`copyWithin`) rather than resizing the buffer — existing views stay valid, the
 * same guarantee `SharedArrayBuffer.prototype.grow` gives by resizing in place.
 */
export type InPlaceBufferAllocator = BufferAllocator & { readonly isInPlace: true };

/**
 * Thrown when an allocator cannot satisfy a request because its by-design
 * byte ceiling is reached (#380: the cap is a runaway-growth signal, not a
 * limit to paper over — there is deliberately no grow-beyond-cap fallback).
 * Typed so `Store`'s grow handler can recognise the cap case and re-throw
 * with the caller's declared sizing intent attached (#682) without ever
 * catching-to-recover.
 */
export class StoreCapExceededError extends Error {
	constructor(
		message: string,
		public readonly requestedBytes: number,
		/** `null` when the ceiling isn't knowable from JS (a shared
		 * `WebAssembly.Memory` doesn't expose its `maximum`). */
		public readonly capBytes: number | null,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = "StoreCapExceededError";
	}
}

/** Thrown when a **SAB-producing** allocator runs in an environment that
 * doesn't expose `SharedArrayBuffer`. The fix is environment-level (the host
 * must serve the page cross-origin isolated, or be a runtime like Bun that
 * exposes SAB unconditionally) — OR choose the pure-TS heap profile
 * (`memory: { heap: {} }` / `heapArraybufferAllocator`), which needs no SAB
 * and no cross-origin isolation. Lives on the allocator (not the store)
 * because the allocator is the only thing that constructs a SAB. */
export class SabUnavailableError extends Error {
	constructor() {
		super(
			"SharedArrayBuffer is not available in this runtime. " +
				"The chosen world backing is SAB-based and cannot start without it. " +
				"In browsers this requires cross-origin isolation: serve the page with " +
				"`Cross-Origin-Opener-Policy: same-origin` and " +
				"`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). " +
				"Alternatively choose the pure-TS heap profile (`memory: { heap: {} }`), " +
				"which is backed by a plain ArrayBuffer and needs no SAB / no COOP+COEP. " +
				"In Bun/Node SAB is available unconditionally — if you see this there, the " +
				"runtime is older than expected or the global was shadowed."
		);
		this.name = "SabUnavailableError";
	}
}

/**
 * Allocate a fresh `SharedArrayBuffer` per call. Prior buffers are
 * untouched and remain valid for as long as the caller holds references.
 * This is the default used by `createColumnStore` when no allocator is
 * provided. Throws `SabUnavailableError` in a runtime without SAB — the
 * availability check lives here (the SAB-producing seam), not in
 * `createColumnStore`, so a heap allocator never trips it.
 */
export const DEFAULT_SAB_ALLOCATOR: BufferAllocator = (bytes) => {
	if (typeof SharedArrayBuffer === "undefined") throw new SabUnavailableError();
	return new SharedArrayBuffer(bytes);
};

/** WASM linear-memory page size; `memory.grow(n)` adds `n` of these. */
const WASM_PAGE_BYTES = 64 * 1024;

/** The buffer primitive a growable single-buffer allocator runs over (M9).
 * `growableSabAllocator` and `heapArraybufferAllocator` are the same
 * allocator — cap arithmetic, hard-ceiling semantics (#380), `isInPlace`
 * reporting — differing only in these two operations. */
interface BufferStrategy {
	create(byteLength: number, maxByteLength: number): ArrayBufferLike;
	growTo(buffer: ArrayBufferLike, byteLength: number): void;
}

/** One home for the single-buffer allocators: the first call allocates the
 * backing (a resizable SAB grown via `.grow()` for `growableSabAllocator`; a
 * fixed `ArrayBuffer` reserved at `maxBytes` for `heapArraybufferAllocator`,
 * whose growTo never fires); later in-cap calls return the same buffer. The cap
 * check, the hard-ceiling throw (#380 — deliberately no grow-beyond-cap
 * fallback), and the `isInPlace` marker live here exactly once; the public
 * wrappers contribute only the buffer primitive and any availability guard. */
function makeGrowableAllocator(
	label: string,
	strategy: BufferStrategy,
	maxBytes: number
): InPlaceBufferAllocator {
	if (maxBytes <= 0 || !Number.isInteger(maxBytes)) {
		throw new Error(`${label}: maxBytes must be a positive integer (got ${maxBytes})`);
	}
	let buffer: ArrayBufferLike | null = null;
	const alloc = (bytes: number): ArrayBufferLike => {
		if (bytes > maxBytes) {
			// BY DESIGN: the cap is a hard ceiling, not a soft target. We do
			// NOT fall back to a fresh allocator or compact here — see #380 and
			// the footprint analysis on `growableSabAllocator`. A real workload
			// uses ~16 MiB of the 256 MiB cap and columns never grow, so
			// reaching this throw means something upstream is creating entities
			// without bound (or `maxBytes` was set too low for an intentionally
			// huge world). Treat it as a fatal to diagnose, not a limit to
			// route around.
			throw new StoreCapExceededError(
				`${label}: requested ${bytes} bytes exceeds the by-design ` +
					`maxBytes cap of ${maxBytes}. This is a hard ceiling with no ` +
					`grow-beyond-cap fallback (#380); a real workload stays ~16 MiB. ` +
					`Reaching it signals runaway entity/column growth upstream — ` +
					`diagnose that rather than raising the cap blindly.`,
				bytes,
				maxBytes
			);
		}
		if (buffer === null) {
			buffer = strategy.create(bytes, maxBytes);
			return buffer;
		}
		if (bytes > buffer.byteLength) {
			strategy.growTo(buffer, bytes);
		}
		return buffer;
	};
	// `isInPlace` lets `extendColumnStore` detect the growable path.
	Object.defineProperty(alloc, "isInPlace", { value: true, enumerable: true });
	return alloc as InPlaceBufferAllocator;
}

/**
 * Allocator that backs the SAB by a single growable `SharedArrayBuffer`
 * (created with `{ maxByteLength: maxBytes }`). First call allocates;
 * subsequent calls `.grow(bytes)` the existing buffer and return it.
 *
 * The `isInPlace` marker is set so `extendColumnStore` knows it can
 * reuse the buffer rather than allocating fresh and copying data —
 * existing typed-array views built with explicit `(byteOffset, length)`
 * stay valid after `.grow()` in Bun + V8 (the underlying mapping extends
 * in place rather than relocating).
 *
 * Sizing: `maxBytes` is committed *virtual* memory, not resident RAM —
 * physical pages fault in lazily as the SAB actually grows. Larger caps
 * cost more per allocation than smaller ones — Bun benchmark
 * `alloc(64,max=1GB)+grow(65568)` measures ~32 µs vs ~21 µs at 256 MB
 * and ~12 µs at 1 MB (V8 per-byte bookkeeping at construction).
 * Production callers with bigger worlds can pass a larger cap; the bench
 * gains are ~10 µs/Store-construction by staying under 256 MB.
 *
 * THE 256 MiB DEFAULT IS A HARD DESIGN CEILING, NOT A SOFT TARGET — and
 * exceeding it is INTENDED to be fatal. There is deliberately no
 * grow-beyond-cap fallback or compaction pass (see #380, and the loud
 * note at the `bytes > maxBytes` throw below). If you are here because
 * a workload died at the cap and you are tempted to add a fresh-allocator
 * realloc fallback: don't, unless the numbers below have changed. They
 * say the cap is structurally unreachable for a real workload.
 *
 * Measured footprint of a real 2-party workload (instrumented, 2026-05;
 * do NOT trust the old "~500 archetypes × 64-capacity ≈ 2 MiB" figure
 * that used to live here — it was wrong on every term):
 *   - Total SAB capacity ≈ 16.2 MiB — ~6% of the cap.
 *   - ~12 MiB of that is the entity-index region's *virtual* reservation
 *     (`ENTITY_INDEX_DEFAULT_CAPACITY = 1<<20` slots × 12 B); only ~12 KiB
 *     of it is physically resident for a 1000-entity workload.
 *   - Only ~5 archetypes are prewarmed (no lazy archetypes), each at
 *     `DEFAULT_COLUMN_CAPACITY = 1024` rows — NOT 64. Live column data is
 *     ~0.1 MiB; a fully-populated entity row is ~49 B.
 *   - Columns never trigger a grow: 1024 initial capacity already covers the
 *     ~1000-row budget, so the doubling + in-place hole tax never fires on
 *     the hot path.
 * The entity-ID space itself caps total live entities at `1<<20` ≈ 1M
 * (20-bit index in `EntityID`). Even at that absolute ceiling — ~1M rows
 * × 49 B × ~3 (post-double capacity + abandoned holes) ≈ ~150 MiB columns
 * + 12 MiB index — the workload still lands under 256 MiB. You cannot reach
 * the cap without first exhausting the entity-ID space. Hitting it
 * therefore signals a real defect upstream (runaway entity creation), not
 * a sizing shortfall to paper over.
 *
 * Cited verification (#237 audit, this branch): Bun runtime check
 * confirms `new Int32Array(buffer, off, len)` retains identical byteOffset,
 * length, and stored values after `.grow()`; DataView byteLength
 * auto-tracks the grown buffer.
 *
 * Used by the `extendColumnStore` fast path during lazy archetype
 * registration (#237 Option A) — keeps existing column views valid so
 * `refreshViews` is a no-op for old archetypes.
 */
export function growableSabAllocator(maxBytes: number = 256 * 1024 * 1024): InPlaceBufferAllocator {
	// Fail fast (at construction, not first grow) in a SAB-less runtime — this
	// allocator produces SharedArrayBuffers. The heap profile uses
	// `heapArraybufferAllocator` instead and never reaches here. The guard
	// stays in this wrapper (not the shared core) — availability is a property
	// of the buffer primitive, and only this one needs SAB.
	if (typeof SharedArrayBuffer === "undefined") throw new SabUnavailableError();
	return makeGrowableAllocator(
		"growable_sab_allocator",
		{
			create: (byteLength, maxByteLength) => {
				// boundary: `SharedArrayBuffer` constructor with `{ maxByteLength }`
				// is in the ES2024 spec and supported by Bun + V8, but the lib types
				// for ES2022 (this project) only declare the 1-arg overload.
				// Cast the constructor here so the rest of the layer stays
				// strictly typed.
				const SabCtor = SharedArrayBuffer as unknown as new (
					len: number,
					opts: { maxByteLength: number }
				) => SharedArrayBuffer;
				return new SabCtor(byteLength, { maxByteLength });
			},
			// boundary: SharedArrayBuffer.grow is in the spec but not in all
			// lib types; widen here so the rest of the layer doesn't need to.
			growTo: (buffer, byteLength) =>
				(buffer as unknown as { grow(n: number): void }).grow(byteLength)
		},
		maxBytes
	);
}

/**
 * Allocator that backs the store by a single **fixed (non-resizable) plain
 * `ArrayBuffer`** reserved at the full `maxBytes` cap up front. This is the
 * pure-TS **heap profile** — the oecs default and the answer to ADR-0018's
 * deferred §1B: no `SharedArrayBuffer`, hence no cross-origin isolation
 * (COOP/COEP) requirement, and no worker/WASM transfer (single-process worlds
 * only).
 *
 * WHY FIXED, NOT RESIZABLE (the 0.5.3 iteration-perf fix): V8 has no fast
 * element-access path for TypedArray views over a **resizable/growable**
 * `ArrayBuffer` — every `col[i]` re-checks bounds against the buffer's mutable
 * length, a ~4× per-element tax measured on V8 13.6 (an isolated `col[i] *= 2`
 * loop: fixed `ArrayBuffer` ~1.6G vs a view over a resizable buffer ~0.37G
 * element-accesses/s). oecs 0.3.x gave each column its own fixed buffer and sat
 * mid-pack among SoA ECS libs; the 0.5.0 switch to one resizable arena silently
 * regressed all iteration-bound systems ~5× (the cross-library `packed_5`
 * scenario: 0.5.2 ~86k op/s → 0.5.3 ~420k). A fixed buffer restores the fast path.
 *
 * How growth still works in place: the cap is reserved as one fixed buffer at
 * construction. A resizable buffer was originally chosen so `.resize()` could
 * grow in place without moving views; a fixed buffer never moves EITHER — the
 * store's grow/extend relocate columns to the tail *within* this buffer
 * (`copyWithin`), so the buffer object and every existing view stay valid.
 * `isInPlace: true` therefore still holds, and ADR-0008's
 * entity-index-hoist-across-grow invariant is preserved. The store keys its
 * tail cursor off the header `capacity` (the logical high-water), NOT
 * `buffer.byteLength` — which is now always `maxBytes` (the same decoupling the
 * wasm page-rounded allocator already relied on).
 *
 *   - Memory cost is unchanged: a fixed `ArrayBuffer(maxBytes)` faults pages in
 *     lazily (untouched pages cost no RSS), exactly like the resizable buffer's
 *     `maxByteLength` reservation — a 256 MiB reservation on a 1000-entity world
 *     stays a few MiB resident (measured ~4 MiB RSS, within ~1 MiB of the old
 *     resizable buffer).
 *   - same 256 MiB default cap with hard-ceiling semantics (#380): a request
 *     past `maxBytes` throws `StoreCapExceededError` — runaway growth signal,
 *     not a limit to route around.
 *
 * Why a non-shared buffer suffices: `Atomics` live only on the cross-thread
 * command/event/action rings, never on the core store path, so a single-process
 * world needs no sharing. `stateHash` determinism works here too — FNV1a over
 * column bytes is backing-agnostic.
 */
export function heapArraybufferAllocator(
	maxBytes: number = 256 * 1024 * 1024
): InPlaceBufferAllocator {
	return makeGrowableAllocator(
		"heap_arraybuffer_allocator",
		{
			// Reserve the whole cap as ONE fixed buffer. `byteLength` (the current
			// need) is ignored: the buffer never resizes, so it must be born at the
			// ceiling. Lazy page-faulting keeps RSS proportional to real use.
			create: (_byteLength, maxByteLength) => new ArrayBuffer(maxByteLength),
			// Unreachable: the buffer is created at `maxByteLength`, so
			// `makeGrowableAllocator`'s `bytes > buffer.byteLength` guard never fires
			// (a byte count past the cap throws first). A fixed `ArrayBuffer` has no
			// `.resize()`; assert loudly rather than attempt one, in case the guard
			// logic ever changes.
			growTo: () => {
				throw new Error(
					"heap_arraybuffer_allocator: the heap buffer is fixed at maxBytes and must " +
						"never grow — growth relocates columns within the buffer, not the buffer itself"
				);
			}
		},
		maxBytes
	);
}

/**
 * Allocator that backs the SAB by `memory.buffer` — i.e. makes the engine's
 * live SAB *be* a WASM module's `WebAssembly.Memory`. Grows the memory in
 * 64 KiB page increments when `bytes` exceeds the current buffer.
 *
 * This is the **opt-in storage backing for the WASM path** (#625). A consumer
 * that attaches a WASM `ComputeBackend` passes
 * `bufferAllocator: wasmMemoryAllocator(memory)` so the Zig systems read/write
 * the same bytes the host's columns live in — zero-copy across the FFI boundary.
 * It is NOT a match-context assumption: a pure-TS game omits `bufferAllocator` and
 * gets the default (`DEFAULT_SAB_ALLOCATOR` — a fresh `SharedArrayBuffer` per
 * alloc) or opts into `growableSabAllocator` for the in-place fast path
 * without any WASM module. "The SAB is the WebAssembly.Memory" is thus a
 * property the WASM backend opts into, paid for only when WASM is in use.
 *
 * After `memory.grow()` on a *shared* memory, `memory.buffer` returns a
 * new `SharedArrayBuffer` reference, but **TypedArrays and DataViews
 * built over the previous reference remain valid** — V8 keeps the
 * underlying linear memory mapped at the same address, so reads and
 * writes through old views land on the same bytes the new buffer
 * exposes. This is why `isInPlace: true` is safe here (verified
 * empirically against Bun + V8): the SAB layer's fast path can carry
 * forward existing column views across an `extend` without paying for
 * snapshot+restore. Old DataViews' `byteLength` is frozen at the
 * pre-grow size, so callers needing to write past that boundary must
 * construct a fresh DataView over the post-grow buffer (the SAB-layer
 * extend path does this).
 *
 * Throws if `memory` was not constructed with `shared: true` — the SAB
 * contract requires `SharedArrayBuffer`-backed memory. Throws a contextual
 * error if a needed grow fails (cap reached or host refusal): the JS API's
 * `memory.grow` throws a RangeError on cap overrun rather than returning the
 * core wasm instruction's `-1`, and both are normalised into that error. The
 * caller should construct memory with a `maximum` large enough for the
 * workload's worst-case capacity.
 */
export function wasmMemoryAllocator(memory: WebAssembly.Memory): InPlaceBufferAllocator {
	// Validate once at construction. `WebAssembly.Memory.prototype.buffer`
	// is typed `ArrayBuffer` in the lib, but a memory constructed with
	// `shared: true` returns a `SharedArrayBuffer` at runtime. The
	// instanceof here pins the contract at the boundary; later reads
	// inside the closure use the same buffer (or its post-grow
	// successor, which is also SAB-backed for shared memory).
	if (!(memory.buffer instanceof SharedArrayBuffer)) {
		throw new Error(
			"wasm_memory_allocator: WebAssembly.Memory must be constructed with `shared: true` " +
				"so its buffer is a SharedArrayBuffer"
		);
	}
	// boundary: WebAssembly.Memory FFI. `memory.buffer` types as `ArrayBuffer`
	// but is a `SharedArrayBuffer` at runtime (validated above). The cast is
	// localised here so the rest of the SAB layer is SAB-only.
	const bufferAsSab = (): SharedArrayBuffer => memory.buffer as unknown as SharedArrayBuffer;
	const alloc = (bytes: number): SharedArrayBuffer => {
		const current = memory.buffer.byteLength;
		if (bytes <= current) {
			return bufferAsSab();
		}
		const additionalPages = Math.ceil((bytes - current) / WASM_PAGE_BYTES);
		const growFailed = (cause?: unknown): Error =>
			// The JS API doesn't expose the Memory's `maximum`, so the cap is
			// reported as unknowable (`null`) — the caller declared it at
			// `new WebAssembly.Memory({ maximum })` time.
			new StoreCapExceededError(
				`wasm_memory_allocator: memory.grow(${additionalPages}) failed ` +
					`(current=${current} bytes, requested=${bytes} bytes, maximum may be reached)`,
				bytes,
				null,
				{ cause }
			);
		// The WebAssembly *JS API* (`WebAssembly.Memory.prototype.grow`) THROWS
		// a RangeError when the grow would exceed `maximum` — it does NOT return
		// -1. The -1 sentinel is the core wasm `memory.grow` *instruction*'s
		// failure signal, not the JS API's. Normalise BOTH into the allocator's
		// contextual diagnostic (which names current/requested bytes) so callers
		// get the same actionable error regardless of how the host signals it,
		// rather than leaking a raw RangeError past this boundary.
		let result: number;
		try {
			result = memory.grow(additionalPages);
		} catch (cause) {
			throw growFailed(cause);
		}
		if (result === -1) {
			throw growFailed();
		}
		return bufferAsSab();
	};
	// Shared `WebAssembly.Memory` keeps the underlying linear memory
	// mapped at the same address across `memory.grow()` — old views over
	// the previous `memory.buffer` ref read/write the same bytes the new
	// ref exposes. The SAB layer's `isInPlace` fast path relies on
	// exactly that property (views survive grow), so set the marker.
	// Confirms thread A of #362 / #361: closing the missed fast path was
	// the 6× mutation-tax fix.
	Object.defineProperty(alloc, "isInPlace", { value: true, enumerable: true });
	return alloc as InPlaceBufferAllocator;
}
