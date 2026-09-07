/**
 * ECS memory sizing, the single place a consumer says how big a world is and
 * what backs it.
 *
 * Two questions, two fields. A caller answers two independent questions here:
 *
 *   how big      `entities` (and its two shaping numbers), or `maxBytes`
 *   what backs it `backing`, heap, shared, wasm, or a custom allocator
 *
 * Before 0.6 these lived in one key-discriminated union of five arms, so a
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
 *   { memory: { backing: { allocator: heapArrayBufferAllocator(cap) } } }
 *
 * `storeBase` is the third field, and it answers a third question: where inside
 * the backing does the store start. It matters for the wasm backing, because a
 * module owns the low addresses of its own linear memory. Every other backing
 * leaves it at 0.
 *
 * `columnCapacity` pins the exact rows per archetype column on any combination.
 * Benches and tests want that. A caller who gives `entities` gets a derived one.
 *
 * One derivation, every backing. `entityIndexCapacity` used to depend on which
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
 * The resolved `intentLabel` and `budgetEntities` travel into `Store` so the
 * hard-fail at the cap is phrased in the caller's own terms, as a multiple of
 * the declared budget, instead of as raw bytes. The cap
 * stays a hard ceiling with no grow-beyond fallback, that decision is not this
 * module's to revisit.
 */

import {
	growableSabAllocator,
	wasmMemoryAllocator,
	heapArrayBufferAllocator,
	alignUp,
	STORE_BASE_ALIGNMENT,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	ENTITY_INDEX_BYTES_PER_SLOT,
	type InPlaceBufferAllocator
} from "../store";
import { DEFAULT_COLUMN_CAPACITY } from "./utils/constants";
import { ECSError, ECS_ERROR } from "./utils/error";

const KiB = 1024;
const MiB = 1024 * KiB;
const WASM_PAGE_BYTES = 64 * KiB;

/** Default store base for the wasm backing, one WASM page. It clears nothing on
 * its own. It is the smallest base that keeps the header off address 0, which a
 * safe Zig or Rust build cannot read. A caller whose module reaches higher
 * passes a base above that module's `__heap_base`. */
export const WASM_STORE_BASE_BYTES = WASM_PAGE_BYTES;

/**
 * A store base that clears a module's own memory, read from the module.
 *
 * A compiled module owns the low addresses of its linear memory. Its data
 * segment, its shadow stack and its heap all start there, and `__heap_base` is
 * the first address above the segment and the stack. A store based below that
 * overlaps the module. The loss is silent, because the region that lands under
 * a module is the entity index and no digest folds it.
 *
 * `extraBytes` is the run-time heap the module allocates above `__heap_base`.
 * Only the module can bound it, so the caller passes it. Pass the module's own
 * peak, not a guess, because a store based inside the heap fails the same
 * silent way.
 *
 * The result rounds up to a whole WASM page, so a grow of the module's memory
 * never lands in the middle of the store's first page. Cold path, and a caller
 * runs it once, between instantiation and `ECS.create`.
 *
 * @example
 * const instance = await WebAssembly.instantiate(module, { env: { memory } });
 * const ecs = ECS.create({
 *   memory: {
 *     backing: { wasm: { memory } },
 *     storeBase: storeBaseAbove(instance.exports, 4 * 1024 * 1024)
 *   }
 * });
 */
export function storeBaseAbove(exports: Record<string, unknown>, extraBytes = 0): number {
	if (!Number.isFinite(extraBytes) || extraBytes < 0) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`storeBaseAbove: extraBytes must be a finite number >= 0, got ${String(extraBytes)}`
		);
	}
	const exported = exports?.__heap_base;
	// A toolchain exports the base as a `WebAssembly.Global`, and a hand-emitted
	// module can export a plain number instead. Both are the same address.
	const raw =
		typeof exported === "object" && exported !== null && "value" in exported
			? (exported as { value: unknown }).value
			: exported;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`storeBaseAbove: the module exports no numeric '__heap_base', got ${String(raw)}. Link with --export=__heap_base, or pass memory.storeBase by hand.`
		);
	}
	// Arithmetic and not a bitwise round, because a linear memory reaches past
	// the range a 32-bit mask keeps.
	const above = Math.ceil((raw + extraBytes) / WASM_PAGE_BYTES) * WASM_PAGE_BYTES;
	// A base of 0 is unreadable from a safe Zig or Rust build, so one page is the
	// floor whatever the module reports.
	return Math.max(WASM_STORE_BASE_BYTES, above);
}

/** Default byte ceiling of every backing, mirrors `growableSabAllocator`'s
 * default (see its doc comment for the measured footprint analysis that makes
 * 256 MiB structurally unreachable). */
export const DEFAULT_ECS_CAP_BYTES = 256 * MiB;

/** Headroom multiplier applied to an entity count's live column bytes: capacity
 * doubling plus abandoned in-place holes bound the worst-case footprint at
 * this multiple of the live data (footprint analysis in `growableSabAllocator`'s doc). */
export const BUDGET_GROWTH_HEADROOM = 3;

/** Default average fully-populated row stride assumed when the caller gives an
 * entity count. A workload with two components uses less than this for each
 * row, thus 64 rounds up and gives headroom. */
export const BUDGET_DEFAULT_BYTES_PER_ENTITY = 64;

/** Default archetype spread assumed when the caller doesn't declare one. Drives
 * only the derived per-archetype column capacity, not correctness, an
 * under-declared spread only means earlier (amortised) column doubling. */
export const BUDGET_DEFAULT_ARCHETYPES = 8;

/** Floor for an entity-count-derived cap: small worlds still get room for
 * consumer-declared regions, rings, and descriptor overhead the arithmetic
 * doesn't model. */
const BUDGET_CAP_FLOOR_BYTES = 4 * MiB;

/** WASM-backed memory. Either bring your own shared `WebAssembly.Memory`, which
 * a consumer that instantiates the module itself already owns, or declare page
 * bounds and let the engine construct it. */
export type WasmMemoryArm =
	| {
			readonly memory: WebAssembly.Memory;
			readonly initialPages?: never;
			readonly maximumPages?: never;
	  }
	| { readonly maximumPages: number; readonly initialPages?: number; readonly memory?: never };

/**
 * What backs the world's bytes. This is the only axis with real exclusivity: a
 * world has exactly one buffer, so these genuinely cannot combine. Sizing is a
 * separate field and combines with all of them.
 *
 *   "heap"        a plain fixed `ArrayBuffer` reserved at the cap. No
 *                 cross-origin isolation needed, and the default. Trade-off: no
 *                 worker offload and no WASM compute backend, because both need
 *                 a transferable `SharedArrayBuffer`.
 *   "shared"      a growable `SharedArrayBuffer` (`@oasys/oecs/shared`).
 *                 Enables worker offload and a WASM compute backend, and needs
 *                 COOP and COEP in a browser. See `growableSabAllocator`'s doc for
 *                 the JavaScriptCore write cost this backing carries.
 *   { wasm }      the buffer is a `WebAssembly.Memory`, zero-copy with a WASM
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
 * combination is legal, the two axes do not police each other.
 *
 * Give `entities` when you know roughly how many the world holds. Give
 * `maxBytes` when you know the ceiling instead. Give both when you know both:
 * the count sizes the columns and the entity index, and the cap is yours.
 */
export interface ECSMemoryOptions {
	/** Expected peak live entities, the one number most callers know. Sizes the
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
	/** Byte offset inside the backing where the store header goes. Every offset
	 * the store writes is relative to it, and the store writes only inside
	 * `[storeBase, storeBase + capacity)`.
	 *
	 * Default 0 for the heap, shared and allocator backings. Default
	 * `WASM_STORE_BASE_BYTES` for the wasm backing, because a module owns the
	 * low addresses of its own linear memory and a safe Zig or Rust build traps
	 * on a read of address 0. Raise it above the module's `__heap_base` plus
	 * whatever the module allocates at run time.
	 *
	 * Must be an integer >= 0 and a multiple of `STORE_BASE_ALIGNMENT`. */
	readonly storeBase?: number;
}

/** What the caller's intent resolved to. Exposed as `ECS.memoryPlan` for
 * diagnostics. `intentLabel`, `budgetEntities` and `capBytes` also travel into
 * `Store` so cap errors speak the caller's language. */
export interface ResolvedECSMemory {
	/** Which backing holds the bytes, the axis-B answer. */
	readonly source: "heap" | "shared" | "wasm" | "allocator";
	/** Which sizing input drove the numbers, the axis-A answer. */
	readonly sizing: "default" | "entities" | "maxBytes" | "entities+maxBytes";
	readonly allocator: InPlaceBufferAllocator;
	readonly columnCapacity: number;
	readonly entityIndexCapacity: number;
	/** Byte ceiling of the backing, `null` when unknowable from JS (a
	 * bring-your-own `WebAssembly.Memory` hides its `maximum`. A custom allocator
	 * owns its own cap unless `maxBytes` declared one). */
	readonly capBytes: number | null;
	/** Human phrasing of the declared intent, reused verbatim in cap errors so
	 * the failure names what the caller asked for. */
	readonly intentLabel: string;
	/** The declared entity count when one was given, drives the "N× the
	 * declared budget" cap-error diagnostic. */
	readonly budgetEntities: number | null;
	/** How each derived number was arrived at, one line per decision. */
	readonly derivation: readonly string[];
	/** Byte offset of the store header inside the backing. */
	readonly storeBase: number;
	/** The backing `WebAssembly.Memory` when the wasm backing was used (both
	 * bring-your-own and engine-constructed), the consumer hands this to its
	 * WASM `ComputeBackend` so the module and the columns share bytes. */
	readonly wasmMemory: WebAssembly.Memory | null;
}

/** Subset of the plan `Store` needs to phrase cap and overflow errors in the
 * caller's terms. */
export interface ECSMemoryCapContext {
	readonly capBytes: number | null;
	readonly intentLabel: string;
	readonly budgetEntities: number | null;
}

const ceilPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const floorPow2 = (n: number): number => 2 ** Math.floor(Math.log2(Math.max(1, n)));
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const fmtBytes = (n: number): string =>
	n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : n >= KiB ? `${(n / KiB).toFixed(0)} KiB` : `${n} B`;

/** Validate a caller-given `storeBase`. `wasmBacking` decides whether 0 is an
 * answer, because a module cannot read a header at address 0. */
function resolveStoreBase(given: number | undefined, wasmBacking: boolean): number {
	if (given === undefined) return wasmBacking ? WASM_STORE_BASE_BYTES : 0;
	if (!Number.isInteger(given) || given < 0) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`memory.storeBase must be an integer >= 0, got ${given}`
		);
	}
	if (given % STORE_BASE_ALIGNMENT !== 0) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`memory.storeBase must be a multiple of ${STORE_BASE_ALIGNMENT}, got ${given}. ` +
				`The alignment keeps every column on its element boundary.`
		);
	}
	if (wasmBacking && given === 0) {
		throw new ECSError(
			ECS_ERROR.INVALID_MEMORY_OPTIONS,
			`memory.storeBase is 0, and a header at address 0 is unreadable from a safe build ` +
				`of a WASM module. Pass a storeBase of at least one page (${WASM_STORE_BASE_BYTES}), ` +
				`above the module's own data.`
		);
	}
	return given;
}

function assertPositiveInt(name: string, n: number): void {
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
 * These are removed, not aliased. A silently-ignored `budget` would size a world
 * wrong and only show up as a cap failure much later, and a silently-ignored
 * `allocator` would put the columns in a different buffer than a WASM
 * consumer's module reads. So the guard throws and names the rewrite, the same way the
 * `initial_capacity` and `buffer_allocator` guard in `ECS`'s constructor does.
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
		`${found.map((k) => `memory.${k}`).join(" and ")} ${found.length > 1 ? "were" : "was"} removed in 0.6. ` +
			`Sizing and backing are now two independent fields, so every combination of them ` +
			`is expressible. Rewrite as: ` +
			found.map((k) => REMOVED_ARMS[k]).join(". ")
	);
}

/**
 * Turn a consumer's sizing intent into a concrete memory plan. Pure apart from
 * allocator and Memory construction. Throws `INVALID_MEMORY_OPTIONS` on a malformed
 * option set, at construction, not first-grow.
 */
export function resolveECSMemory(opts?: ECSMemoryOptions): ResolvedECSMemory {
	if (opts !== undefined) rejectRemovedArms(opts);

	const entities = opts?.entities;
	const declaredCap = opts?.maxBytes;
	const pinnedColumns = opts?.columnCapacity;
	const backing = opts?.backing ?? "heap";
	const isWasmBacking = typeof backing === "object" && backing.wasm !== undefined;
	const storeBase = resolveStoreBase(opts?.storeBase, isWasmBacking);

	if (pinnedColumns !== undefined) assertPositiveInt("columnCapacity", pinnedColumns);
	if (declaredCap !== undefined) assertPositiveInt("maxBytes", declaredCap);

	// `archetypes` and `bytesPerEntity` shape a derivation that only runs when
	// there is an entity count. Alone they do nothing, and a caller who wrote one
	// alone meant something we did not do, say so rather than ignore it.
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
		assertPositiveInt("entities", entities);
		assertPositiveInt("archetypes", archetypes);
		assertPositiveInt("bytesPerEntity", bytesPerEntity);
		if (entities > 1 << 20) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				`memory.entities=${entities} exceeds the EntityID index space (1<<20 = ${1 << 20})`
			);
		}
		// Size columns so the expected per-archetype row count fits without a
		// doubling, the same way `DEFAULT_COLUMN_CAPACITY` already covers a
		// small world.
		columnCapacity = pinnedColumns ?? clamp(ceilPow2(Math.ceil(entities / archetypes)), 64, 1 << 20);
		// 2× headroom over the count before EID_MAX_INDEX_OVERFLOW, enough slack
		// for churn, small enough that runaway creation still fails fast.
		entityIndexCapacity = clamp(ceilPow2(entities * 2), 1 << 12, 1 << 20);
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
			storeBase,
			intentLabel,
			budgetEntities: entities ?? null,
			derivation: [
				...backingTrace,
				...(storeBase > 0
					? [`storeBase = ${fmtBytes(storeBase)}, the store writes nothing below it`]
					: []),
				...sizeTrace,
				entities === undefined
					? `entityIndex = floor_pow2(cap/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
					: `cap = ${capTraceFor(cap)}`
			],
			wasmMemory: null
		};
	};

	// --- axis B: what backs it ----------------------------------------------

	// --- wasm: the buffer is a WebAssembly.Memory ---------------------------
	if (typeof backing === "object" && backing.wasm !== undefined) {
		const arm = backing.wasm;
		if (arm.memory !== undefined) {
			// boundary: WebAssembly.Memory FFI, `buffer` types as ArrayBuffer but
			// is a SharedArrayBuffer iff constructed `shared: true`. Checked here so
			// a non-shared Memory is a construction error naming the option, not a
			// deep allocator throw on first use.
			if (!(arm.memory.buffer instanceof SharedArrayBuffer)) {
				throw new ECSError(
					ECS_ERROR.INVALID_MEMORY_OPTIONS,
					"memory.backing.wasm.memory must be constructed with `shared: true`, the SAB " +
						"substrate requires a SharedArrayBuffer-backed WebAssembly.Memory"
				);
			}
			// The store promises to write only inside its span, so this arm needs a
			// cap. The Memory's own `maximum` is not readable from JS, so the cap
			// is the caller's `maxBytes` or the default. The caller must build the
			// Memory large enough for `storeBase` plus that cap.
			const callerCap = declaredCap ?? DEFAULT_ECS_CAP_BYTES;
			if (entities === undefined) {
				entityIndexCapacity = indexFromCap(Math.max(callerCap - storeBase, 0));
			}
			return {
				source: "wasm",
				sizing,
				allocator: wasmMemoryAllocator(arm.memory),
				columnCapacity,
				entityIndexCapacity,
				capBytes: callerCap,
				storeBase,
				intentLabel: `caller-supplied WebAssembly.Memory (declared cap ${fmtBytes(callerCap)})`,
				budgetEntities: entities ?? null,
				derivation: [
					"backing = wasm_memory_allocator(memory), zero-copy with a WASM compute backend (is_in_place ✓)",
					declaredCap !== undefined
						? `cap = ${fmtBytes(callerCap)} (caller-declared maxBytes; the Memory's own maximum is not readable from JS)`
						: `cap = ${fmtBytes(callerCap)} (default; the Memory's own maximum is not readable from JS)`,
					`storeBase = ${fmtBytes(storeBase)}, the module owns every byte below it`,
					...sizeTrace,
					entities === undefined
						? `entityIndex = floor_pow2((cap - storeBase)/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
						: `entityIndex sized from the entity count above`
				],
				wasmMemory: arm.memory
			};
		}
		assertPositiveInt("backing.wasm.maximumPages", arm.maximumPages);
		const initialPages = arm.initialPages ?? Math.min(32, arm.maximumPages);
		assertPositiveInt("backing.wasm.initialPages", initialPages);
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
					`${fmtBytes(arm.maximumPages * WASM_PAGE_BYTES)}), the Memory's page maximum IS the ceiling. ` +
					`Declare it once, in pages.`
			);
		}
		const memory = new WebAssembly.Memory({
			initial: initialPages,
			maximum: arm.maximumPages,
			shared: true
		});
		const capBytes = arm.maximumPages * WASM_PAGE_BYTES;
		if (entities === undefined) {
			entityIndexCapacity = indexFromCap(Math.max(capBytes - storeBase, 0));
		}
		return {
			source: "wasm",
			sizing,
			allocator: wasmMemoryAllocator(memory),
			columnCapacity,
			entityIndexCapacity,
			capBytes,
			storeBase,
			intentLabel: `engine-constructed WebAssembly.Memory (max ${arm.maximumPages} pages)`,
			budgetEntities: entities ?? null,
			derivation: [
				`cap = ${arm.maximumPages} pages × 64 KiB = ${fmtBytes(capBytes)} (Memory maximum)`,
				`initial = ${initialPages} pages (${arm.initialPages !== undefined ? "declared" : "default"})`,
				`storeBase = ${fmtBytes(storeBase)}, the module owns every byte below it`,
				...sizeTrace,
				entities === undefined
					? `entityIndex = floor_pow2((cap - storeBase)/4 ÷ ${ENTITY_INDEX_BYTES_PER_SLOT} B) = ${entityIndexCapacity} slots`
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
				"memory.backing.allocator must declare `isInPlace: true`. A live Store's flush " +
					"loops hoist entity-index views across grows, so an allocator that is not " +
					"in-place (DEFAULT_SAB_ALLOCATOR, for example) corrupts the entity→row mapping. " +
					"Use growableSabAllocator, fixedSabAllocator or wasmMemoryAllocator. An " +
					"allocator that is not in-place is for snapshot and test sizing only."
			);
		}
		// The caller's allocator owns the real ceiling, so `capBytes` stays a
		// declaration. It is not only a label: with no entity count it is the only
		// input the index derivation has, and before 0.6 this branch ignored it and
		// always reserved the full EntityID space, which made any allocator with a
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
			storeBase,
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
						: `entityIndex = ${entityIndexCapacity} slots (default, no entity count and no declared cap)`
			],
			wasmMemory: null
		};
	}

	// --- shared: opt-in SharedArrayBuffer (worker offload and WASM backend) ----
	if (backing === "shared") {
		const capBytes = declaredCap ?? derivedCap ?? DEFAULT_ECS_CAP_BYTES;
		// `growableSabAllocator` throws SabUnavailableError at Store construction
		// if `SharedArrayBuffer` is absent (no cross-origin isolation).
		return withCap(
			capBytes,
			"shared",
			growableSabAllocator(capBytes),
			`shared SharedArrayBuffer backing (${fmtBytes(capBytes)} growable cap, needs COOP and COEP)`,
			[
				`backing = growable_sab_allocator(${fmtBytes(capBytes)}), growable SharedArrayBuffer (is_in_place ✓), needs cross-origin isolation`,
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
		heapArrayBufferAllocator(capBytes),
		sizing === "default"
			? `default sizing (${fmtBytes(capBytes)} reserved cap)`
			: entities !== undefined
				? `budget of ${entities} entities`
				: `explicit cap of ${fmtBytes(capBytes)}`,
		[
			`backing = heap_arraybuffer_allocator(${fmtBytes(capBytes)}), fixed ArrayBuffer reserved at the cap, no SAB and no COOP+COEP (is_in_place ✓)`,
			"trade-off: no worker offload and no WASM backend (both need a transferable SharedArrayBuffer)"
		]
	);
}
