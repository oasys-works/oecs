/**
 * ECS memory sizing — the single place a consumer says how big a world is and
 * what backs it.
 *
 * TWO QUESTIONS, TWO FIELDS. A caller answers two independent questions here:
 *
 *   how big      `entities` (and its two shaping numbers), or `maxBytes`
 *   what backs it `backing` — heap, shared, wasm, or a custom allocator
 *
 * Before 0.6 these lived in ONE key-discriminated union of five arms, so a
 * caller could answer only one of them. The `budget` arm and the `maxBytes` arm
 * both chose the heap allocator themselves, which made "a budget of 50,000
 * entities on a shared backing" impossible to say. The two axes are now two
 * fields and every combination is legal:
 *
 *   { memory: {} }                                          // defaults
 *   { memory: { entities: 10_000 } }                         // "I expect ~10k entities"
 *   { memory: { maxBytes: 32 * 1024 * 1024 } }               // explicit byte cap
 *   { memory: { entities: 50_000, backing: "shared" } }      // both axes
 *   { memory: { entities: 50_000, maxBytes: 64 * 1024 * 1024 } }  // size from one, cap from the other
 *   { memory: { backing: { wasm: { maximumPages: 4096 } } } }
 *   { memory: { backing: { allocator: heapArraybufferAllocator(cap) } } }
 *
 * `columnCapacity` pins the exact rows per archetype column on any combination.
 * Benches and tests want that; a caller who gives `entities` gets a derived one.
 *
 * ONE DERIVATION, EVERY BACKING. `entityIndexCapacity` used to depend on which
 * arm the caller picked, and the escape hatch always reserved the full EntityID
 * space. That made a custom allocator unusable below about 12.6 MiB, because
 * the index reservation alone did not fit under the cap. The index now comes
 * from `entities` first, from the cap second, and from the default last, and it
 * does so for every backing.
 *
 * The in-place invariant is enforced here, at construction: the allocator
 * backing is typed `InPlaceBufferAllocator` (so `DEFAULT_SAB_ALLOCATOR` does not
 * typecheck) and a runtime backstop rejects untyped JS callers.
 *
 * The resolved `intentLabel` / `budgetEntities` travel into `Store` so the
 * hard-fail at the cap is phrased in the caller's own terms ("3.2× the declared
 * budget — runaway entity creation upstream?") instead of raw bytes. The cap
 * stays a hard ceiling with no grow-beyond fallback — that decision is not this
 * module's to revisit.
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

/** Default byte ceiling of every backing — mirrors `growableSabAllocator`'s
 * default (see its doc comment for the measured footprint analysis that makes
 * 256 MiB structurally unreachable). */
export const DEFAULT_ECS_CAP_BYTES = 256 * MiB;

/** Headroom multiplier applied to an entity count's live column bytes: capacity
 * doubling plus abandoned in-place holes bound worst-case footprint at ~3×
 * live data (footprint analysis in `growableSabAllocator`'s doc). */
export const BUDGET_GROWTH_HEADROOM = 3;

/** Default average fully-populated row stride assumed when the caller gives an
 * entity count. The instrumented 2-party workload measured ~49 B/entity; 64
 * rounds up. */
export const BUDGET_DEFAULT_BYTES_PER_ENTITY = 64;

/** Default archetype spread assumed when the caller doesn't declare one. Drives
 * only the derived per-archetype column capacity, not correctness — an
 * under-declared spread just means earlier (amortised) column doubling. */
export const BUDGET_DEFAULT_ARCHETYPES = 8;

/** Floor for an entity-count-derived cap: small worlds still get room for
 * consumer-declared regions, rings, and descriptor overhead the arithmetic
 * doesn't model. */
const BUDGET_CAP_FLOOR_BYTES = 4 * MiB;

/** WASM-backed memory. Either bring your own shared `WebAssembly.Memory` (the
 * server match context does — its sim factory owns the memory), or declare page
 * bounds and let the engine construct it. */
export type WasmMemoryArm =
	| {
			readonly memory: WebAssembly.Memory;
			readonly initialPages?: never;
			readonly maximumPages?: never;
	  }
	| { readonly maximumPages: number; readonly initialPages?: number; readonly memory?: never };

/**
 * What backs the world's bytes. This is the ONLY axis with real exclusivity: a
 * world has exactly one buffer, so these genuinely cannot combine. Sizing is a
 * separate field and combines with all of them.
 *
 *   "heap"        a plain fixed `ArrayBuffer` reserved at the cap. No
 *                 cross-origin isolation needed, and the default. Trade-off: no
 *                 worker offload and no WASM compute backend, because both need
 *                 a transferable `SharedArrayBuffer`.
 *   "shared"      a growable `SharedArrayBuffer` (`@oasys/oecs/shared`).
 *                 Enables worker offload and a WASM compute backend, and needs
 *                 COOP/COEP in a browser. See `growableSabAllocator`'s doc for
 *                 the JavaScriptCore write cost this backing carries.
 *   { wasm }      the buffer IS a `WebAssembly.Memory` — zero-copy with a WASM
 *                 `ComputeBackend`.
 *   { allocator } expert escape hatch. Typed `InPlaceBufferAllocator` so only
 *                 allocators that statically declare `isInPlace: true` compile.
 *                 Give `maxBytes` beside it to declare the ceiling, which the
 *                 index derivation then respects.
 */
export type MemoryBacking =
	| "heap"
	| "shared"
	| { readonly wasm: WasmMemoryArm; readonly allocator?: never }
	| { readonly allocator: InPlaceBufferAllocator; readonly wasm?: never };

/**
 * How the world is sized and what backs it. Every field is optional and every
 * combination is legal — the two axes do not police each other.
 *
 * Give `entities` when you know roughly how many the world holds. Give
 * `maxBytes` when you know the ceiling instead. Give both when you know both:
 * the count sizes the columns and the entity index, and the cap is yours.
 */
export interface ECSMemoryOptions {
	/** Expected peak live entities — the one number most callers know. Sizes the
	 * column capacity, the entity-index reservation and (unless `maxBytes` says
	 * otherwise) the byte cap. Bounded by the EntityID 20-bit index space
	 * (1<<20). */
	readonly entities?: number;
	/** Expected distinct archetypes the entities spread across. Shapes the
	 * derived column capacity only. Needs `entities`. Default
	 * `BUDGET_DEFAULT_ARCHETYPES`. */
	readonly archetypes?: number;
	/** Average fully-populated row stride in bytes. Shapes the derived cap only.
	 * Needs `entities`. Default `BUDGET_DEFAULT_BYTES_PER_ENTITY`. */
	readonly bytesPerEntity?: number;
	/** Byte ceiling of the backing, with hard-ceiling semantics and no
	 * grow-beyond fallback. Wins over a cap derived from `entities`. For the
	 * allocator backing this is a declaration: the allocator owns the real
	 * ceiling, but the index derivation believes this number. Default
	 * `DEFAULT_ECS_CAP_BYTES` (256 MiB). */
	readonly maxBytes?: number;
	/** Exact initial rows per archetype column. Overrides the derived value. */
	readonly columnCapacity?: number;
	/** What holds the bytes. Default `"heap"`. */
	readonly backing?: MemoryBacking;
}

/** What the caller's intent resolved to. Exposed as `ECS.memoryPlan` for
 * diagnostics; `intentLabel`/`budgetEntities`/`capBytes` also travel into
 * `Store` so cap errors speak the caller's language. */
export interface ResolvedECSMemory {
	/** Which backing holds the bytes — the axis-B answer. */
	readonly source: "heap" | "shared" | "wasm" | "allocator";
	/** Which sizing input drove the numbers — the axis-A answer. */
	readonly sizing: "default" | "entities" | "maxBytes" | "entities+maxBytes";
	readonly allocator: InPlaceBufferAllocator;
	readonly columnCapacity: number;
	readonly entityIndexCapacity: number;
	/** Byte ceiling of the backing, `null` when unknowable from JS (a
	 * bring-your-own `WebAssembly.Memory` hides its `maximum`; a custom allocator
	 * owns its own cap unless `maxBytes` declared one). */
	readonly capBytes: number | null;
	/** Human phrasing of the declared intent — reused verbatim in cap errors so
	 * the failure names what the caller asked for. */
	readonly intentLabel: string;
	/** The declared entity count when one was given — drives the "N× the
	 * declared budget" cap-error diagnostic. */
	readonly budgetEntities: number | null;
	/** How each derived number was arrived at, one line per decision. */
	readonly derivation: readonly string[];
	/** The backing `WebAssembly.Memory` when the wasm backing was used (both
	 * bring-your-own and engine-constructed) — the consumer hands this to its
	 * WASM `ComputeBackend` so the sim and the columns share bytes. */
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
 * The pre-0.6 arms, and how each one is spelled now.
 *
 * These are REMOVED, not aliased. A silently-ignored `budget` would size a world
 * wrong and only show up as a cap failure much later, and a silently-ignored
 * `allocator` would put the columns in a different buffer than a WASM consumer's
 * sim reads. So the guard throws and names the rewrite, the same way the
 * `initial_capacity` / `buffer_allocator` guard in `ECS`'s constructor does.
 */
const REMOVED_ARMS: Readonly<Record<string, string>> = {
	budget: "{ budget: { entities: N } } → { entities: N }",
	heap: '{ heap: { maxBytes: X } } → { maxBytes: X, backing: "heap" }',
	shared: '{ shared: { maxBytes: X } } → { maxBytes: X, backing: "shared" }',
	wasm: "{ wasm: W } → { backing: { wasm: W } }",
	allocator: "{ allocator: A } → { backing: { allocator: A } }",
	capBytesHint: "{ capBytesHint: X } → { maxBytes: X }"
};

function rejectRemovedArms(opts: ECSMemoryOptions): void {
	const hasOwn = Object.prototype.hasOwnProperty;
	const found = Object.keys(REMOVED_ARMS).filter((k) => hasOwn.call(opts, k));
	if (found.length === 0) return;
	throw new ECSError(
		ECS_ERROR.INVALID_MEMORY_OPTIONS,
		`memory.${found.join(" / memory.")} was removed in 0.6: sizing and backing are now two ` +
			`independent fields, so every combination of them is expressible. Rewrite as — ` +
			found.map((k) => REMOVED_ARMS[k]).join("; ")
	);
}

/**
 * Turn a consumer's sizing intent into a concrete memory plan. Pure apart from
 * allocator/Memory construction; throws `INVALID_MEMORY_OPTIONS` on a malformed
 * option set — at construction, not first-grow.
 */
export function resolveECSMemory(opts?: ECSMemoryOptions): ResolvedECSMemory {
	if (opts !== undefined) rejectRemovedArms(opts);

	const entities = opts?.entities;
	const declaredCap = opts?.maxBytes;
	const pinnedColumns = opts?.columnCapacity;
	const backing = opts?.backing ?? "heap";

	if (pinnedColumns !== undefined) requirePositiveInt("columnCapacity", pinnedColumns);
	if (declaredCap !== undefined) requirePositiveInt("maxBytes", declaredCap);

	// `archetypes` and `bytesPerEntity` shape a derivation that only runs when
	// there is an entity count. Alone they do nothing, and a caller who wrote one
	// alone meant something we did not do — say so rather than ignore it.
	if (entities === undefined) {
		for (const k of ["archetypes", "bytesPerEntity"] as const) {
			if (opts?.[k] !== undefined) {
				throw new ECSError(
					ECS_ERROR.INVALID_MEMORY_OPTIONS,
					`memory.${k} shapes the sizing derived from memory.entities, which was not given. ` +
						`Add memory.entities, or drop memory.${k}.`
				);
			}
		}
	}

	// --- axis A: how big ----------------------------------------------------
	let columnCapacity: number;
	let entityIndexCapacity: number;
	// The cap an entity count implies. `null` when there is no count.
	let derivedCap: number | null = null;
	const sizeTrace: string[] = [];

	if (entities !== undefined) {
		const archetypes = opts?.archetypes ?? BUDGET_DEFAULT_ARCHETYPES;
		const bytesPerEntity = opts?.bytesPerEntity ?? BUDGET_DEFAULT_BYTES_PER_ENTITY;
		requirePositiveInt("entities", entities);
		requirePositiveInt("archetypes", archetypes);
		requirePositiveInt("bytesPerEntity", bytesPerEntity);
		if (entities > 1 << 20) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				`memory.entities=${entities} exceeds the EntityID index space (1<<20 = ${1 << 20})`
			);
		}
		// Size columns so the expected per-archetype row count fits without a
		// doubling — the same way the 1024 default already covers the typical
		// ~1000-row workload.
		columnCapacity = pinnedColumns ?? clamp(nextPow2(Math.ceil(entities / archetypes)), 64, 1 << 20);
		// 2× headroom over the count before EID_MAX_INDEX_OVERFLOW — enough slack
		// for churn, small enough that runaway creation still fails fast.
		entityIndexCapacity = clamp(nextPow2(entities * 2), 1 << 12, 1 << 20);
		const indexBytes = entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT;
		const columnBytes = entities * bytesPerEntity * BUDGET_GROWTH_HEADROOM;
		derivedCap = alignUp(
			Math.max(indexBytes + columnBytes, BUDGET_CAP_FLOOR_BYTES),
			WASM_PAGE_BYTES
		);
		sizeTrace.push(
			`columnCapacity = ${pinnedColumns !== undefined ? `${columnCapacity} (pinned)` : `pow2(${entities}/${archetypes} per archetype) = ${columnCapacity}`}`,
			`entityIndex = pow2(2 × ${entities}) = ${entityIndexCapacity} slots × ${ENTITY_INDEX_BYTES_PER_SLOT} B = ${fmtBytes(indexBytes)}`,
			`columns = ${entities} × ${bytesPerEntity} B × ${BUDGET_GROWTH_HEADROOM} (double+holes headroom) = ${fmtBytes(columnBytes)}`
		);
	} else {
		columnCapacity = pinnedColumns ?? DEFAULT_COLUMN_CAPACITY;
		// Filled in below, once the backing has said what the cap really is: with
		// no entity count the index is sized backwards from the ceiling.
		entityIndexCapacity = ENTITY_INDEX_DEFAULT_CAPACITY;
		sizeTrace.push(
			`columnCapacity = ${columnCapacity} (${pinnedColumns !== undefined ? "pinned" : "default"})`
		);
	}

	/**
	 * Size the entity index backwards from a known ceiling: at most a quarter of
	 * the cap, never above the full EntityID space. The region is reserved
	 * eagerly at Store construction, so a small cap must not be handed an index
	 * that alone would not fit under it.
	 *
	 * Only called when there is no entity count. A count is the better input and
	 * already won above.
	 */
	const indexFromCap = (cap: number): number =>
		clamp(floorPow2(cap / 4 / ENTITY_INDEX_BYTES_PER_SLOT), 1 << 12, ENTITY_INDEX_DEFAULT_CAPACITY);

	const sizing: ResolvedECSMemory["sizing"] =
		entities !== undefined
			? declaredCap !== undefined
				? "entities+maxBytes"
				: "entities"
			: declaredCap !== undefined
				? "maxBytes"
				: "default";

	const capTraceFor = (cap: number): string =>
		declaredCap !== undefined
			? `${fmtBytes(cap)} (caller-declared maxBytes; the ${fmtBytes(derivedCap ?? cap)} the entity count implies is overridden)`
			: `align64K(max(index + columns, ${fmtBytes(BUDGET_CAP_FLOOR_BYTES)} floor)) = ${fmtBytes(cap)}`;

	/** Finish a plan for a backing that does not own its own ceiling. */
	const withCap = (
		cap: number,
		source: ResolvedECSMemory["source"],
		allocator: InPlaceBufferAllocator,
		intentLabel: string,
		backingTrace: readonly string[]
	): ResolvedECSMemory => {
		if (entities === undefined) entityIndexCapacity = indexFromCap(cap);
		return {
			source,
			sizing,
			allocator,
			columnCapacity,
			entityIndexCapacity,
			capBytes: cap,
			intentLabel,
			budgetEntities: entities ?? null,
			derivation: [
				...backingTrace,
				...sizeTrace,
				entities === undefined
					? `entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
					: `cap = ${capTraceFor(cap)}`
			],
			wasmMemory: null
		};
	};

	// --- axis B: what backs it ----------------------------------------------

	// --- wasm: the buffer IS a WebAssembly.Memory ---------------------------
	if (typeof backing === "object" && backing.wasm !== undefined) {
		const arm = backing.wasm;
		if (arm.memory !== undefined) {
			// boundary: WebAssembly.Memory FFI — `buffer` types as ArrayBuffer but
			// is a SharedArrayBuffer iff constructed `shared: true`. Checked here so
			// a non-shared Memory is a construction error naming the option, not a
			// deep allocator throw on first use.
			if (!(arm.memory.buffer instanceof SharedArrayBuffer)) {
				throw new ECSError(
					ECS_ERROR.INVALID_MEMORY_OPTIONS,
					"memory.backing.wasm.memory must be constructed with `shared: true` — the SAB " +
						"substrate requires a SharedArrayBuffer-backed WebAssembly.Memory"
				);
			}
			if (declaredCap !== undefined) {
				throw new ECSError(
					ECS_ERROR.INVALID_MEMORY_OPTIONS,
					"memory.maxBytes cannot be given beside a caller-supplied WebAssembly.Memory — " +
						"the Memory declares its own ceiling through its `maximum`, which JS cannot read back."
				);
			}
			// The ceiling is unknowable, so the index falls back to the default
			// unless an entity count sized it. Before 0.6 it was ALWAYS the default
			// here, which reserved the full EntityID space for every WASM world.
			return {
				source: "wasm",
				sizing,
				allocator: wasmMemoryAllocator(arm.memory),
				columnCapacity,
				entityIndexCapacity,
				capBytes: null,
				intentLabel: "caller-supplied WebAssembly.Memory",
				budgetEntities: entities ?? null,
				derivation: [
					"backing = wasm_memory_allocator(memory) — zero-copy with the sim (is_in_place ✓)",
					"cap = the Memory's own `maximum` (declared by the caller; not readable from JS)",
					...sizeTrace,
					entities === undefined
						? `entityIndex = ${entityIndexCapacity} slots (default — no entity count and no readable cap)`
						: `entityIndex sized from the entity count above`
				],
				wasmMemory: arm.memory
			};
		}
		requirePositiveInt("backing.wasm.maximumPages", arm.maximumPages);
		const initialPages = arm.initialPages ?? Math.min(32, arm.maximumPages);
		requirePositiveInt("backing.wasm.initialPages", initialPages);
		if (initialPages > arm.maximumPages) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				`memory.backing.wasm.initialPages (${initialPages}) exceeds maximumPages (${arm.maximumPages})`
			);
		}
		if (declaredCap !== undefined) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				`memory.maxBytes (${fmtBytes(declaredCap)}) cannot be given beside ` +
					`memory.backing.wasm.maximumPages (${arm.maximumPages} pages = ` +
					`${fmtBytes(arm.maximumPages * WASM_PAGE_BYTES)}) — the Memory's page maximum IS the ceiling. ` +
					`Declare it once, in pages.`
			);
		}
		const memory = new WebAssembly.Memory({
			initial: initialPages,
			maximum: arm.maximumPages,
			shared: true
		});
		const capBytes = arm.maximumPages * WASM_PAGE_BYTES;
		if (entities === undefined) entityIndexCapacity = indexFromCap(capBytes);
		return {
			source: "wasm",
			sizing,
			allocator: wasmMemoryAllocator(memory),
			columnCapacity,
			entityIndexCapacity,
			capBytes,
			intentLabel: `engine-constructed WebAssembly.Memory (max ${arm.maximumPages} pages)`,
			budgetEntities: entities ?? null,
			derivation: [
				`cap = ${arm.maximumPages} pages × 64 KiB = ${fmtBytes(capBytes)} (Memory maximum)`,
				`initial = ${initialPages} pages (${arm.initialPages !== undefined ? "declared" : "default"})`,
				...sizeTrace,
				entities === undefined
					? `entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
					: `entityIndex sized from the entity count above`
			],
			wasmMemory: memory
		};
	}

	// --- allocator: expert escape hatch -------------------------------------
	if (typeof backing === "object" && backing.allocator !== undefined) {
		// Runtime backstop of the in-place type boundary for untyped JS callers:
		// the brand can be cast away, the flush-loop invariant can't.
		if (backing.allocator.isInPlace !== true) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				"memory.backing.allocator must declare `isInPlace: true`: a live Store's flush " +
					"loops hoist entity-index views across grows, so a non-in-place allocator (e.g. " +
					"DEFAULT_SAB_ALLOCATOR) corrupts the entity→row mapping. Use growableSabAllocator " +
					"/ fixedSabAllocator / wasmMemoryAllocator; non-in-place allocators are " +
					"snapshot/test sizing only."
			);
		}
		// The caller's allocator owns the real ceiling, so `capBytes` stays a
		// declaration. It is NOT only a label: with no entity count it is the only
		// input the index derivation has, and before 0.6 this branch ignored it and
		// always reserved the full EntityID space — which made any allocator with a
		// cap under about 12.6 MiB fail to construct a world at all.
		const cap = declaredCap ?? null;
		if (entities === undefined && cap !== null) entityIndexCapacity = indexFromCap(cap);
		return {
			source: "allocator",
			sizing,
			allocator: backing.allocator,
			columnCapacity,
			entityIndexCapacity,
			capBytes: cap,
			intentLabel:
				cap !== null
					? `custom in-place allocator (declared cap ${fmtBytes(cap)})`
					: "custom in-place allocator",
			budgetEntities: entities ?? null,
			derivation: [
				"backing = caller allocator (is_in_place ✓ checked at construction)",
				cap !== null
					? `cap = ${fmtBytes(cap)} (caller-declared; the allocator owns the real ceiling)`
					: "cap = allocator-owned (no maxBytes declared)",
				...sizeTrace,
				entities !== undefined
					? "entityIndex sized from the entity count above"
					: cap !== null
						? `entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
						: `entityIndex = ${entityIndexCapacity} slots (default — no entity count and no declared cap)`
			],
			wasmMemory: null
		};
	}

	// --- shared: opt-in SharedArrayBuffer (worker offload / WASM backend) ----
	if (backing === "shared") {
		const capBytes = declaredCap ?? derivedCap ?? DEFAULT_ECS_CAP_BYTES;
		// `growableSabAllocator` throws SabUnavailableError at Store construction
		// if `SharedArrayBuffer` is absent (no cross-origin isolation).
		return withCap(
			capBytes,
			"shared",
			growableSabAllocator(capBytes),
			`shared SharedArrayBuffer backing (${fmtBytes(capBytes)} growable cap, needs COOP/COEP)`,
			[
				`backing = growable_sab_allocator(${fmtBytes(capBytes)}) — growable SharedArrayBuffer (is_in_place ✓); needs cross-origin isolation`,
				"enables worker offload + a WASM compute backend (transferable SharedArrayBuffer)"
			]
		);
	}

	if (backing !== "heap") {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`memory.backing must be "heap", "shared", { wasm }, or { allocator } (got ${JSON.stringify(backing)})`
		);
	}

	// --- heap: pure-TS fixed ArrayBuffer, no SharedArrayBuffer (default) -----
	const capBytes = declaredCap ?? derivedCap ?? DEFAULT_ECS_CAP_BYTES;
	return withCap(
		capBytes,
		"heap",
		heapArraybufferAllocator(capBytes),
		sizing === "default"
			? `default sizing (${fmtBytes(capBytes)} reserved cap)`
			: entities !== undefined
				? `budget of ${entities} entities`
				: `explicit cap of ${fmtBytes(capBytes)}`,
		[
			`backing = heap_arraybuffer_allocator(${fmtBytes(capBytes)}) — fixed ArrayBuffer reserved at the cap, no SAB / no COOP+COEP (is_in_place ✓)`,
			"trade-off: no worker offload / no WASM backend (both need a transferable SharedArrayBuffer)"
		]
	);
}
