/**
 * ECS memory sizing — the single place a consumer says how big an
 * ECS is and what backs it.
 *
 * This surface used to be two loosely-coupled knobs (`initialCapacity`
 * + `bufferAllocator`) plus invariants that lived as tribal knowledge: which
 * allocators may back a live Store, what the 256 MiB default cap
 * means, and the hand-wired `new WebAssembly.Memory(...) →
 * wasmMemoryAllocator(memory)` incantation for the WASM path. Now that
 * SAB is the always-on substrate for every consumer,
 * this is public API: a caller expresses *intent* through
 * `ECSOptions.memory` and `resolveECSMemory` turns it into a concrete
 * plan — allocator, column capacity, entity-index reservation, byte cap —
 * with a human-readable derivation trace.
 *
 * Exactly one sizing arm (or none — empty `{}` / omitted means today's
 * defaults):
 *
 *   { memory: { budget: { entities: 10_000 } } }            // "I expect ~10k entities"
 *   { memory: { maxBytes: 32 * 1024 * 1024 } }             // explicit byte cap
 *   { memory: { wasm: { maximumPages: 4096 } } }           // engine constructs the Memory
 *   { memory: { wasm: { memory: my_shared_memory } } }      // bring-your-own Memory
 *   { memory: { heap: {} } }                                // pure-TS ArrayBuffer, no SAB / no COOP+COEP
 *   { memory: { allocator: heapArraybufferAllocator(cap) } }  // expert escape hatch
 *
 * Any arm may pin `columnCapacity` explicitly (benches and tests want exact
 * row counts; the budget arm derives one otherwise).
 *
 * The in-place invariant is enforced *here*, at construction: the
 * escape-hatch arm is typed `InPlaceBufferAllocator` (so `DEFAULT_SAB_ALLOCATOR`
 * does not typecheck) and a runtime backstop rejects untyped JS callers.
 *
 * The resolved `intentLabel` / `budgetEntities` travel into `Store` so the
 * hard-fail at the cap is phrased in the caller's own terms ("3.2× the
 * declared budget — runaway entity creation upstream?") instead of raw bytes.
 * The cap stays a hard ceiling with no grow-beyond fallback — that decision
 * is not this module's to revisit.
 */

import {
	growableSabAllocator,
	wasmMemoryAllocator,
	heapArraybufferAllocator,
	alignUp,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	ENTITY_INDEX_BYTES_PER_SLOT,
	type InPlaceBufferAllocator
} from "../store";
import { DEFAULT_COLUMN_CAPACITY } from "./utils/constants";
import { ECSError, ECS_ERROR } from "./utils/error";

const KiB = 1024;
const MiB = 1024 * KiB;
const WASM_PAGE_BYTES = 64 * KiB;

/** Default byte ceiling of the growable backing — mirrors
 * `growableSabAllocator`'s default (see its doc comment for the measured
 * footprint analysis that makes 256 MiB structurally unreachable). */
export const DEFAULT_ECS_CAP_BYTES = 256 * MiB;

/** Headroom multiplier applied to a budget's live column bytes: capacity
 * doubling plus abandoned in-place holes bound worst-case footprint at ~3×
 * live data (footprint analysis in `growableSabAllocator`'s doc). */
export const BUDGET_GROWTH_HEADROOM = 3;

/** Default average fully-populated row stride assumed by the budget arm.
 * The instrumented 2-party workload measured ~49 B/entity; 64 rounds up. */
export const BUDGET_DEFAULT_BYTES_PER_ENTITY = 64;

/** Default archetype spread assumed by the budget arm when the consumer
 * doesn't declare one. Drives only the derived per-archetype column
 * capacity, not correctness — an under-declared spread just means earlier
 * (amortised) column doubling. */
export const BUDGET_DEFAULT_ARCHETYPES = 8;

/** Floor for a budget-derived cap: small budgets still get room for
 * consumer-declared regions, rings, and descriptor overhead the budget
 * arithmetic doesn't model. */
const BUDGET_CAP_FLOOR_BYTES = 4 * MiB;

/** Sizing intent: "I expect a world about this big." The engine derives
 * column capacity, entity-index reservation, and the byte cap from it, and
 * cap errors are phrased against this budget. */
export interface EntityBudget {
	/** Expected peak live entities — the one number most callers know.
	 * Bounded by the EntityID 20-bit index space (1<<20). */
	readonly entities: number;
	/** Expected distinct archetypes the entities spread across.
	 * Default `BUDGET_DEFAULT_ARCHETYPES`. */
	readonly archetypes?: number;
	/** Average fully-populated row stride in bytes.
	 * Default `BUDGET_DEFAULT_BYTES_PER_ENTITY`. */
	readonly bytesPerEntity?: number;
}

/** WASM-backed memory, first-class. Either bring your own shared
 * `WebAssembly.Memory` (the server match context does — its sim factory
 * owns the memory), or declare page bounds and let the engine construct
 * it. This replaces the hand-wired sequence that each caller had to do
 * before. */
export type WasmMemoryArm =
	| {
			readonly memory: WebAssembly.Memory;
			readonly initialPages?: never;
			readonly maximumPages?: never;
	  }
	| { readonly maximumPages: number; readonly initialPages?: number; readonly memory?: never };

/** Pure-TS **heap** backing: a plain fixed (non-resizable)
 * `ArrayBuffer` reserved at the cap up front, instead of a `SharedArrayBuffer`.
 * Needs no cross-origin isolation (COOP/COEP) and is the intended default for
 * embedders that can't set those headers (the oecs profile). Trade-off: no
 * worker offload and no WASM compute backend — both require a transferable
 * `SharedArrayBuffer`. An empty `{}` takes the default 256 MiB cap. */
export interface HeapMemoryArm {
	/** Byte ceiling of the heap backing — reserved fixed (non-resizable) at
	 * this cap up front. Default `DEFAULT_ECS_CAP_BYTES` (256 MiB), same
	 * hard-ceiling semantics as the SAB backing. */
	readonly maxBytes?: number;
}

/** Opt-in **shared-memory** backing (`@oasys/oecs/shared`): a growable
 * `SharedArrayBuffer` instead of a plain `ArrayBuffer`. Required for worker
 * offload and a WASM compute backend, but needs cross-origin isolation
 * (COOP/COEP) in browsers. Empty `{}` takes the default 256 MiB growable cap. */
export interface SharedMemoryArm {
	/** Byte ceiling of the growable shared backing. Default
	 * `DEFAULT_ECS_CAP_BYTES` (256 MiB), hard-ceiling semantics. */
	readonly maxBytes?: number;
}

/** Pinnable on every arm: exact initial rows per archetype column. The
 * budget arm derives one when unpinned; every other arm defaults to
 * `DEFAULT_COLUMN_CAPACITY`. */
interface ColumnCapacityPin {
	readonly columnCapacity?: number;
}

/**
 * The single sizing option on `ECSOptions.memory`. Key-discriminated —
 * exactly one of `budget` | `maxBytes` | `wasm` | `allocator`, or none for
 * default sizing. The `never` fields make a two-arm literal a type error;
 * `resolveECSMemory` backstops untyped JS callers at runtime.
 */
export type ECSMemoryOptions =
	| ({
			readonly budget: EntityBudget;
			readonly maxBytes?: never;
			readonly wasm?: never;
			readonly allocator?: never;
			readonly heap?: never;
			readonly shared?: never;
	  } & ColumnCapacityPin)
	| ({
			readonly maxBytes: number;
			readonly budget?: never;
			readonly wasm?: never;
			readonly allocator?: never;
			readonly heap?: never;
			readonly shared?: never;
	  } & ColumnCapacityPin)
	| ({
			readonly wasm: WasmMemoryArm;
			readonly budget?: never;
			readonly maxBytes?: never;
			readonly allocator?: never;
			readonly heap?: never;
			readonly shared?: never;
	  } & ColumnCapacityPin)
	| ({
			readonly heap: HeapMemoryArm;
			readonly budget?: never;
			readonly maxBytes?: never;
			readonly wasm?: never;
			readonly allocator?: never;
			readonly shared?: never;
	  } & ColumnCapacityPin)
	| ({
			readonly shared: SharedMemoryArm;
			readonly budget?: never;
			readonly maxBytes?: never;
			readonly wasm?: never;
			readonly allocator?: never;
			readonly heap?: never;
	  } & ColumnCapacityPin)
	| ({
			/** Expert escape hatch. Typed `InPlaceBufferAllocator` so only
			 * allocators that statically declare `isInPlace: true` compile —
			 * the in-place boundary. `DEFAULT_SAB_ALLOCATOR` is rejected by the
			 * type system; non-in-place allocators stay snapshot/test-sizing
			 * utilities. */
			readonly allocator: InPlaceBufferAllocator;
			/** The allocator owns its real ceiling; this hint only labels
			 * diagnostics (cap errors, `memoryPlan.derivation`). */
			readonly capBytesHint?: number;
			readonly budget?: never;
			readonly maxBytes?: never;
			readonly wasm?: never;
			readonly heap?: never;
			readonly shared?: never;
	  } & ColumnCapacityPin)
	| ({
			/** No sizing arm: default growable backing (256 MiB cap), with the
			 * column capacity optionally pinned — the minimal migration from the
			 * removed `initialCapacity` knob. */
			readonly budget?: never;
			readonly maxBytes?: never;
			readonly wasm?: never;
			readonly allocator?: never;
			readonly heap?: never;
			readonly shared?: never;
	  } & ColumnCapacityPin);

/** What the caller's intent resolved to. Exposed as `ECS.memoryPlan` for
 * diagnostics; `intentLabel`/`budgetEntities`/`capBytes` also travel
 * into `Store` so cap errors speak the caller's language. */
export interface ResolvedECSMemory {
	readonly source: "default" | "budget" | "maxBytes" | "wasm" | "allocator" | "heap" | "shared";
	readonly allocator: InPlaceBufferAllocator;
	readonly columnCapacity: number;
	readonly entityIndexCapacity: number;
	/** Byte ceiling of the backing, `null` when unknowable from JS (a
	 * bring-your-own `WebAssembly.Memory` hides its `maximum`; a custom
	 * allocator owns its own cap unless hinted). */
	readonly capBytes: number | null;
	/** Human phrasing of the declared intent — reused verbatim in cap
	 * errors so the failure names what the caller asked for. */
	readonly intentLabel: string;
	/** The declared entity budget when the budget arm was used — drives the
	 * "N× the declared budget" cap-error diagnostic. */
	readonly budgetEntities: number | null;
	/** How each derived number was arrived at, one line per decision. */
	readonly derivation: readonly string[];
	/** The backing `WebAssembly.Memory` when the wasm arm was used (both
	 * bring-your-own and engine-constructed) — the consumer hands this to
	 * its WASM `ComputeBackend` so the sim and the columns share bytes. */
	readonly wasmMemory: WebAssembly.Memory | null;
}

/** Subset of the plan `Store` needs to phrase cap/overflow errors in the
 * caller's terms. */
export interface ECSMemoryCapContext {
	readonly capBytes: number | null;
	readonly intentLabel: string;
	readonly budgetEntities: number | null;
}

const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const floorPow2 = (n: number): number => 2 ** Math.floor(Math.log2(Math.max(1, n)));
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const fmtBytes = (n: number): string =>
	n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : n >= KiB ? `${(n / KiB).toFixed(0)} KiB` : `${n} B`;

function requirePositiveInt(name: string, n: number): void {
	if (!Number.isInteger(n) || n <= 0) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`memory.${name} must be a positive integer (got ${n})`
		);
	}
}

/**
 * Turn a consumer's sizing intent into a concrete memory plan. Pure apart
 * from allocator/Memory construction; throws `INVALID_MEMORY_OPTIONS` on a
 * malformed option set — at construction, not first-grow.
 */
export function resolveECSMemory(opts?: ECSMemoryOptions): ResolvedECSMemory {
	const armKeys = (["budget", "maxBytes", "wasm", "allocator", "heap", "shared"] as const).filter(
		(k) => opts !== undefined && opts[k] !== undefined
	);
	if (armKeys.length > 1) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`memory takes at most one of budget | maxBytes | wasm | allocator | heap | shared (got: ${armKeys.join(", ")})`
		);
	}
	const pinnedColumns = opts?.columnCapacity;
	if (pinnedColumns !== undefined) requirePositiveInt("columnCapacity", pinnedColumns);

	// --- budget: derive everything from "I expect ~N entities" -------------
	if (opts?.budget !== undefined) {
		const { entities } = opts.budget;
		const archetypes = opts.budget.archetypes ?? BUDGET_DEFAULT_ARCHETYPES;
		const bytesPerEntity = opts.budget.bytesPerEntity ?? BUDGET_DEFAULT_BYTES_PER_ENTITY;
		requirePositiveInt("budget.entities", entities);
		requirePositiveInt("budget.archetypes", archetypes);
		requirePositiveInt("budget.bytesPerEntity", bytesPerEntity);
		if (entities > 1 << 20) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				`memory.budget.entities=${entities} exceeds the EntityID index space (1<<20 = ${1 << 20})`
			);
		}
		// Size columns so the expected per-archetype row count fits without a
		// doubling — the same way the 1024 default already covers the typical
		// ~1000-row workload.
		const columnCapacity =
			pinnedColumns ?? clamp(nextPow2(Math.ceil(entities / archetypes)), 64, 1 << 20);
		// 2× headroom over the budget before EID_MAX_INDEX_OVERFLOW — enough
		// slack for churn, small enough that runaway creation still fails fast.
		const entityIndexCapacity = clamp(nextPow2(entities * 2), 1 << 12, 1 << 20);
		const indexBytes = entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT;
		const columnBytes = entities * bytesPerEntity * BUDGET_GROWTH_HEADROOM;
		const capBytes = alignUp(
			Math.max(indexBytes + columnBytes, BUDGET_CAP_FLOOR_BYTES),
			WASM_PAGE_BYTES
		);
		return {
			source: "budget",
			allocator: heapArraybufferAllocator(capBytes),
			columnCapacity,
			entityIndexCapacity,
			capBytes,
			intentLabel: `budget of ${entities} entities`,
			budgetEntities: entities,
			derivation: [
				`columnCapacity = ${pinnedColumns !== undefined ? `${columnCapacity} (pinned)` : `pow2(${entities}/${archetypes} per archetype) = ${columnCapacity}`}`,
				`entityIndex = pow2(2 × ${entities}) = ${entityIndexCapacity} slots × ${ENTITY_INDEX_BYTES_PER_SLOT} B = ${fmtBytes(indexBytes)}`,
				`columns = ${entities} × ${bytesPerEntity} B × ${BUDGET_GROWTH_HEADROOM} (double+holes headroom) = ${fmtBytes(columnBytes)}`,
				`cap = align64K(max(index + columns, ${fmtBytes(BUDGET_CAP_FLOOR_BYTES)} floor)) = ${fmtBytes(capBytes)}`
			],
			wasmMemory: null
		};
	}

	// --- maxBytes: explicit ceiling, growable backing ----------------------
	if (opts?.maxBytes !== undefined) {
		requirePositiveInt("maxBytes", opts.maxBytes);
		const columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
		// Reserve at most a quarter of the declared cap for the entity index;
		// never above the full-ID-space default.
		const entityIndexCapacity = clamp(
			floorPow2(opts.maxBytes / 4 / ENTITY_INDEX_BYTES_PER_SLOT),
			1 << 12,
			ENTITY_INDEX_DEFAULT_CAPACITY
		);
		return {
			source: "maxBytes",
			allocator: heapArraybufferAllocator(opts.maxBytes),
			columnCapacity,
			entityIndexCapacity,
			capBytes: opts.maxBytes,
			intentLabel: `explicit cap of ${fmtBytes(opts.maxBytes)}`,
			budgetEntities: null,
			derivation: [
				`cap = ${fmtBytes(opts.maxBytes)} (caller-declared)`,
				`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`,
				`entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
			],
			wasmMemory: null
		};
	}

	// --- wasm: the SAB IS a WebAssembly.Memory ------------------------------
	if (opts?.wasm !== undefined) {
		const arm = opts.wasm;
		const columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
		if (arm.memory !== undefined) {
			// boundary: WebAssembly.Memory FFI — `buffer` types as ArrayBuffer
			// but is a SharedArrayBuffer iff constructed `shared: true`. Checked
			// here so a non-shared Memory is a construction error naming the
			// option, not a deep allocator throw on first use.
			if (!(arm.memory.buffer instanceof SharedArrayBuffer)) {
				throw new ECSError(
					ECS_ERROR.INVALID_MEMORY_OPTIONS,
					"memory.wasm.memory must be constructed with `shared: true` — the SAB substrate " +
						"requires a SharedArrayBuffer-backed WebAssembly.Memory"
				);
			}
			return {
				source: "wasm",
				allocator: wasmMemoryAllocator(arm.memory),
				columnCapacity,
				entityIndexCapacity: ENTITY_INDEX_DEFAULT_CAPACITY,
				// The JS API hides a Memory's `maximum`; the caller declared it.
				capBytes: null,
				intentLabel: "caller-supplied WebAssembly.Memory",
				budgetEntities: null,
				derivation: [
					"backing = wasm_memory_allocator(memory) — zero-copy with the sim (is_in_place ✓)",
					"cap = the Memory's own `maximum` (declared by the caller; not readable from JS)",
					`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`
				],
				wasmMemory: arm.memory
			};
		}
		requirePositiveInt("wasm.maximumPages", arm.maximumPages);
		const initialPages = arm.initialPages ?? Math.min(32, arm.maximumPages);
		requirePositiveInt("wasm.initialPages", initialPages);
		if (initialPages > arm.maximumPages) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				`memory.wasm.initialPages (${initialPages}) exceeds maximumPages (${arm.maximumPages})`
			);
		}
		const memory = new WebAssembly.Memory({
			initial: initialPages,
			maximum: arm.maximumPages,
			shared: true
		});
		const capBytes = arm.maximumPages * WASM_PAGE_BYTES;
		// Unlike the bring-your-own case the ceiling is known here, so size the
		// entity-index reservation to fit under it (same quarter-of-cap rule as
		// the maxBytes arm) — otherwise a small Memory couldn't even construct
		// a Store (the full default reservation alone is ~12 MiB).
		const entityIndexCapacity = clamp(
			floorPow2(capBytes / 4 / ENTITY_INDEX_BYTES_PER_SLOT),
			1 << 12,
			ENTITY_INDEX_DEFAULT_CAPACITY
		);
		return {
			source: "wasm",
			allocator: wasmMemoryAllocator(memory),
			columnCapacity,
			entityIndexCapacity,
			capBytes,
			intentLabel: `engine-constructed WebAssembly.Memory (max ${arm.maximumPages} pages)`,
			budgetEntities: null,
			derivation: [
				`cap = ${arm.maximumPages} pages × 64 KiB = ${fmtBytes(capBytes)} (Memory maximum)`,
				`initial = ${initialPages} pages (${arm.initialPages !== undefined ? "declared" : "default"})`,
				`entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`,
				`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`
			],
			wasmMemory: memory
		};
	}

	// --- allocator: expert escape hatch -------------------------------------
	if (opts?.allocator !== undefined) {
		// Runtime backstop of the in-place type boundary for untyped JS
		// callers: the brand can be cast away, the flush-loop invariant can't.
		if (opts.allocator.isInPlace !== true) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				"memory.allocator must declare `isInPlace: true`: a live Store's flush " +
					"loops hoist entity-index views across grows, so a non-in-place allocator (e.g. " +
					"DEFAULT_SAB_ALLOCATOR) corrupts the entity→row mapping. Use growableSabAllocator " +
					"/ wasmMemoryAllocator; non-in-place allocators are snapshot/test sizing only."
			);
		}
		const columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
		const hint = opts.capBytesHint;
		if (hint !== undefined) requirePositiveInt("capBytesHint", hint);
		return {
			source: "allocator",
			allocator: opts.allocator,
			columnCapacity,
			entityIndexCapacity: ENTITY_INDEX_DEFAULT_CAPACITY,
			capBytes: hint ?? null,
			intentLabel:
				hint !== undefined
					? `custom in-place allocator (cap hint ${fmtBytes(hint)})`
					: "custom in-place allocator",
			budgetEntities: null,
			derivation: [
				"backing = caller allocator (is_in_place ✓ checked at construction)",
				hint !== undefined
					? `cap = ${fmtBytes(hint)} (caller hint — diagnostics only; the allocator owns the real cap)`
					: "cap = allocator-owned (no hint)",
				`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`
			],
			wasmMemory: null
		};
	}

	// --- heap: pure-TS fixed ArrayBuffer, no SharedArrayBuffer --------------
	if (opts?.heap !== undefined) {
		if (opts.heap.maxBytes !== undefined)
			requirePositiveInt("heap.maxBytes", opts.heap.maxBytes);
		const capBytes = opts.heap.maxBytes ?? DEFAULT_ECS_CAP_BYTES;
		const columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
		// Size the entity-index reservation to fit under the cap (same
		// quarter-of-cap rule as the maxBytes / wasm arms). The region is
		// reserved eagerly at Store construction, so against the full default
		// reservation alone (~12 MiB) a small `heap.maxBytes` couldn't even
		// build a Store — it would throw StoreCapExceededError before the world
		// exists. For the default cap this clamps back to the full EntityID
		// space, so `heap: {}` is unchanged.
		const entityIndexCapacity = clamp(
			floorPow2(capBytes / 4 / ENTITY_INDEX_BYTES_PER_SLOT),
			1 << 12,
			ENTITY_INDEX_DEFAULT_CAPACITY
		);
		return {
			source: "heap",
			allocator: heapArraybufferAllocator(capBytes),
			columnCapacity,
			entityIndexCapacity,
			capBytes,
			intentLabel: `pure-TS heap backing (${fmtBytes(capBytes)} growable cap, no SharedArrayBuffer)`,
			budgetEntities: null,
			derivation: [
				`backing = heap_arraybuffer_allocator(${fmtBytes(capBytes)}) — fixed ArrayBuffer reserved at the cap, no SAB / no COOP+COEP (is_in_place ✓)`,
				"trade-off: no worker offload / no WASM backend (both need a transferable SharedArrayBuffer)",
				`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`,
				`entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
			],
			wasmMemory: null
		};
	}

	// --- shared: opt-in SharedArrayBuffer (worker offload / WASM backend) ----
	if (opts?.shared !== undefined) {
		if (opts.shared.maxBytes !== undefined)
			requirePositiveInt("shared.maxBytes", opts.shared.maxBytes);
		const capBytes = opts.shared.maxBytes ?? DEFAULT_ECS_CAP_BYTES;
		const columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
		const entityIndexCapacity = clamp(
			floorPow2(capBytes / 4 / ENTITY_INDEX_BYTES_PER_SLOT),
			1 << 12,
			ENTITY_INDEX_DEFAULT_CAPACITY
		);
		// `growableSabAllocator` throws SabUnavailableError at Store construction
		// if `SharedArrayBuffer` is absent (no cross-origin isolation).
		return {
			source: "shared",
			allocator: growableSabAllocator(capBytes),
			columnCapacity,
			entityIndexCapacity,
			capBytes,
			intentLabel: `shared SharedArrayBuffer backing (${fmtBytes(capBytes)} growable cap, needs COOP/COEP)`,
			budgetEntities: null,
			derivation: [
				`backing = growable_sab_allocator(${fmtBytes(capBytes)}) — growable SharedArrayBuffer (is_in_place ✓); needs cross-origin isolation`,
				"enables worker offload + a WASM compute backend (transferable SharedArrayBuffer)",
				`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`,
				`entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
			],
			wasmMemory: null
		};
	}

	// --- default (omitted or `{}` / only columnCapacity pinned) ------------
	const columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
	return {
		source: "default",
		allocator: heapArraybufferAllocator(),
		columnCapacity,
		entityIndexCapacity: ENTITY_INDEX_DEFAULT_CAPACITY,
		capBytes: DEFAULT_ECS_CAP_BYTES,
		intentLabel: `default sizing (${fmtBytes(DEFAULT_ECS_CAP_BYTES)} growable cap)`,
		budgetEntities: null,
		derivation: [
			`cap = ${fmtBytes(DEFAULT_ECS_CAP_BYTES)} (heap_arraybuffer_allocator default)`,
			`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "DEFAULT_COLUMN_CAPACITY"})`,
			`entityIndex = ${ENTITY_INDEX_DEFAULT_CAPACITY} slots (full EntityID space, ~12 MiB virtual)`
		],
		wasmMemory: null
	};
}
