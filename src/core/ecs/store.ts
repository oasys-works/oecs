/***
 * Store — Internal ECS data orchestrator.
 *
 * Owns all mutable state: entity ID allocation, component metadata,
 * archetype graph, and entity-to-archetype mapping. World delegates
 * every data operation here; Store is never exposed to systems or
 * external code.
 *
 * Architecture: Archetype-based storage with cached graph edges.
 * Component data lives in typed array columns within each Archetype.
 * Moving an entity between archetypes copies its column data from the
 * source row to a fresh row in the target archetype, then swap-removes
 * the source row.
 *
 * The archetype graph caches add/remove edges, so repeated transitions
 * (e.g. "add Velocity to [Position]") resolve in O(1) after the first
 * occurrence.
 *
 * Deferred operations (addComponentDeferred, removeComponentDeferred,
 * destroyEntityDeferred) buffer changes in flat parallel arrays and
 * flush them in batch — avoiding per-operation archetype transitions
 * during system execution.
 *
 ***/

import {
	getEntityIndex,
	getEntityGeneration,
	createEntityId,
	INDEX_BITS,
	INDEX_MASK,
	MAX_ENTITY_ID,
	RETIRED_GENERATION,
	type EntityID
,
	entityNotAliveError
} from "./entity";
import type { CursorBinder } from "./ref";
import type { FrameTraceSink } from "./frame_trace";
import { setComponentDebugName } from "./debug_names";
import {
	asComponentId,
	makeComponentDef,
	type ComponentDef,
	type ComponentHandle,
	type ComponentID,
	type ComponentSchema,
	type FieldValues
} from "./component";
import {
	SparseComponentStore,
	type SparseComponentDef,
	type SparseComponentID
} from "./sparse_store";
import type { RelationDef, RelationOptions } from "./relation";
import type { EmptyEventSchema, EventDef, EventReader, EventShape } from "./event";
import { EventRegistry } from "./event_registry";
import { ResourceRegistry } from "./resource_registry";
import {
	unsafeCast,
	BitSet,
	BITS_PER_WORD_SHIFT,
	BITS_PER_WORD_MASK,
	type TypedArrayTag
} from "../../type_primitives";
import {
	Archetype,
	_moveResult,
	type ArchetypeColumnLayout,
	type ArchetypeID
} from "./archetype";
import type { Query, QueryHost } from "./query";
import { RelationService } from "./relation_service";
// Type-only: the per-consumer host seams Store implements. observer.ts /
// query.ts import only types from store.ts, so neither edge is a runtime cycle.
import type { ObserverHost } from "./observer";
import { ECS_ERROR, ECSError } from "./utils/error";
import { EntityAllocator } from "./entity_allocator";
import { DeferredCommandBuffer } from "./deferred_commands";
import { SnapshotService } from "./snapshot_service";
import { ArchetypeGraph } from "./archetype_graph";
import { accessCheck } from "./access_check";
import { UNASSIGNED, EMPTY_VALUES, DEFAULT_COLUMN_CAPACITY } from "./utils/constants";
import {
	ACTION_RING_DEFAULT_CAPACITY_SLOTS,
	buildEntityIndexViews,
	COMMAND_RING_DEFAULT_CAPACITY_SLOTS,
	createColumnStore,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	ENTITY_INDEX_HEADER_OFFSETS,
	EVENT_RING_DEFAULT_CAPACITY_SLOTS,
	extendColumnStore,
	findRegionEntry,
	findRegionOffset,
	FNV1A_OFFSET_BASIS,
	FNV1A_PRIME,
	fnv1aStepWord,
	growColumnStore,
	growableSabAllocator,
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COLUMN_DESCRIPTOR_BYTES,
	STORE_DESCRIPTOR_COMPONENT_LIMIT,
	STORE_HEADER_OFFSETS,
	StoreCapExceededError,
	type ArchetypeGrowSpec,
	type ArchetypeSpec,
	type InPlaceBufferAllocator,
	type ColumnStoreRegionHandle,
	type StoreRegionSpec,
	type ColumnStore
} from "../store";
import type { ECSMemoryCapContext } from "./ecs_memory";
import { ECSRestoreError, type HostState } from "./resume";
import { DEV } from "../../dev_flag";

export interface ComponentMeta {
	/** Optional debug name from `registerComponent(schema, { name })` —
	 * diagnostic messages only, never behaviour. */
	name?: string;
	fieldNames: string[];
	fieldIndex: Record<string, number>;
	fieldTypes: TypedArrayTag[];
	// --- Component observers ---
	// Hot-path flags consulted by the structural flush + the field-write path.
	// All false unless `ecs.observe(...)` registered a matching observer; the
	// no-observer flush path is byte-for-byte unchanged (`_structuralObserverCount`
	// gate in `flushStructural`). See `observer.ts`.
	/** Has an onAdd observer — collect effective adds for this component. */
	obsAdd: boolean;
	/** Has an onRemove observer — collect effective removes for this component. */
	obsRem: boolean;
	/** Has an onDisable observer — collect effective disables for this
	 * component at the toggle drain. */
	obsDisable: boolean;
	/** Has an onEnable observer — collect effective enables for this
	 * component at the toggle drain. */
	obsEnable: boolean;
	/** Has a per-entity onSet observer — record dirty rows on the write path
	 * (the opt-in dirty list). */
	trackDirty: boolean;
}

/**
 * Effective `(component, entity)` structural events for one fixed-point round,
 * collected during `_flushAdds` / `_flushRemoves` and handed to the observer
 * dispatch hook. Flat parallel arrays, count-bounded (`*_len`), reused across
 * rounds — never reallocated in the flush. This is a scheduling artifact: it is
 * NOT part of `stateHash` or snapshot. See `observer.ts`.
 */
export interface StructuralObserverEvents {
	addComp: number[];
	addEid: number[];
	addLen: number;
	remComp: number[];
	remEid: number[];
	remLen: number;
	/** Effective disable events — collected during the toggle drain
	 * (`_flushToggles`), one per `(component, entity)` of each net-disabled
	 * entity's mask. Empty on a structural (add/remove/destroy) round. */
	disComp: number[];
	disEid: number[];
	disLen: number;
	/** Effective enable events, symmetric with the disable arrays. */
	enaComp: number[];
	enaEid: number[];
	enaLen: number;
}


/** Shared empty list returned by `_takeDirty` when a component has no dirty
 * rows — avoids allocating on the common no-change path. */
const EMPTY_DIRTY: EntityID[] = [];

/** Sentinel in a `Template.overrideIndex`: the field name is owned by more
 * than one component, so a flat per-instance override cannot disambiguate
 * which column it means. Overriding such a field throws in `DEV`. */
const TEMPLATE_OVERRIDE_AMBIGUOUS = -1;

/** Scratch buffer for folding an f64 sparse field into `stateHash` as two
 * little-endian u32 words. Reused across calls (single-threaded `Store`); the
 * explicit LE read matches the dense column path's byte assembly so the digest
 * stays architecture-independent. */
const F64_HASH_SCRATCH = new DataView(new ArrayBuffer(8));

/**
 * Composite-add edge cache key construction. The plural-add key packs
 * the entry def ids as a base-`COMPOSITE_ADD_ID_STRIDE` number seeded with the
 * entry count: digits are `def + 1` (so id 0 is never a vanishing leading
 * zero), the stride exceeds the `< 128` dense-component-id ceiling, and the
 * count seed keeps different-arity adds in disjoint magnitude bands. The result
 * is an EXACT key — equal keys ⇔ equal (ordered) id lists — so a cache hit
 * needs no `equals` verification. `MAX_ENTRIES` caps the pack at
 * `MAX_SAFE_INTEGER` (8·129⁷ < 2⁵³); larger or out-of-range adds skip the cache
 * and take the final-mask resolve, which is correct but uncached. */
const COMPOSITE_ADD_ID_STRIDE = 129; // STORE_DESCRIPTOR_COMPONENT_LIMIT (128) + 1
const COMPOSITE_ADD_MAX_ENTRIES = 7;
/** Sentinel `key`: this add isn't cacheable (too many entries, or a def id at/
 * past the stride). Negative so it can't collide with any real packed key. */
const COMPOSITE_ADD_UNKEYABLE = -1;

/** Runtime shape of one template / `addComponents` entry: a def plus optional
 * field values (omitted fields zero-fill). The public authoring surface is
 * callable-bundle varargs, schema-checked per item by `StrictBundles`
 * (component.ts); the `ECS` facade normalizes those bundles into this erased
 * array before calling the store, so the store stays schema-agnostic. */
type TemplateEntryData = {
	readonly def: ComponentDef;
	readonly values?: Readonly<Record<string, number>>;
};

/** Union of every field name owned by a component in `Defs` (distributes
 * over the def list). */
type TemplateFieldNames<Defs extends readonly ComponentDef[]> =
	Defs[number] extends ComponentDef<infer S> ? keyof S & string : never;

/** Flat per-instance override map for `ECS.spawn`: any field of any
 * component in the template, each optional. A misspelled field is a compile
 * error (and still a `DEV` throw at runtime for untyped call sites). */
export type TemplateOverrides<Defs extends readonly ComponentDef[]> = {
	readonly [K in TemplateFieldNames<Defs>]?: number;
};

// Phantom slot carrying the template's def-list type so `spawn` can check
// overrides against it. Optional + erased at runtime. Deliberately COVARIANT
// (unlike the invariant `ResourceKey` / `EventKey` phantoms): a
// `Template<[…]>` must erase to bare `Template` in a system's `spawns` /
// `despawns` access declaration, and widening only loosens the *advisory*
// override checking — there is no write-direction hole to close.
declare const __templateDefs: unique symbol;

/** A resolved template — an archetype template produced by
 * `ECS.template(...)`. **Opaque** apart from `defs`: callers hold it and pass
 * it to `ECS.spawn` / `ECS.spawnMany` (and may reference it in a system's
 * `spawns` / `despawns` access declaration — the scheduler expands it to
 * `defs`); the remaining fields are engine-internal and may change. `spawn`
 * lands an entity directly in `archetype_id` with zero archetype transitions,
 * writing `flatValues` (defaults in `_flatColumns` order) in one append
 * pass. */
export interface Template<Defs extends readonly ComponentDef[] = readonly ComponentDef[]> {
	readonly archetypeId: ArchetypeID;
	readonly flatValues: number[];
	readonly overrideIndex: Map<string, number>;
	/** The component set this template spawns into, in entry order. */
	readonly defs: readonly ComponentDef[];
	readonly [__templateDefs]?: Defs;
}

export interface StoreOptions {
	initialCapacity?: number;
	/** Pluggable SAB buffer source. When provided, `createColumnStore`,
	 * `extendColumnStore`, and `growColumnStore` route through it. Default is
	 * `growableSabAllocator`. Typed `InPlaceBufferAllocator`: a live
	 * Store's flush loops hoist entity-index views across grows, so only
	 * in-place allocators may back one — the constructor also
	 * runtime-asserts the marker for untyped JS callers. Consumers normally
	 * don't touch this directly; `ECSOptions.memory` resolves to it. */
	bufferAllocator?: InPlaceBufferAllocator;
	/** Sizing intent the world was constructed with, used to phrase
	 * allocator-cap and entity-index-overflow errors in the caller's own
	 * terms ("3.2× the declared budget") instead of raw bytes. Wired by
	 * `ECS` from `resolveECSMemory`; absent for bare test Stores. */
	capContext?: ECSMemoryCapContext;
	/** Fired after every SAB resize (extend or grow). The new SAB has
	 * already been built and archetypes have already refreshed their
	 * views by the time this fires. Used by ECS to call
	 * `sim.setLayout(0)` so WASM-side cached pointers re-walk. */
	onBufferResized?: () => void;
	/** Max live entities the SAB entity-index region holds.
	 * Default `ENTITY_INDEX_DEFAULT_CAPACITY` (`1 << 20` — the full EntityID
	 * index space). Exceeding this at runtime throws `EID_MAX_INDEX_OVERFLOW`.
	 * Tests with small entity counts may set lower to bench the SAB region size
	 * or to make index exhaustion reachable; a 1000-entity workload fits
	 * comfortably in the default. */
	entityIndexCapacity?: number;
	/** Consumer-declared SAB regions, forwarded verbatim to
	 * `createColumnStore`. Each `StoreRegionSpec` carries an opaque `region_id`,
	 * a precomputed byte size, and an `init` closure; the engine lays them out
	 * generically and exposes them via `regionHandle(id)` / `regionOffset(id)`.
	 * A game (e.g. `@internal/sim`'s region specs) supplies these — the engine
	 * ships no game regions of its own. Omitted ⇒ none. */
	regions?: readonly StoreRegionSpec[];
	/** Byte size of the opt-in sim-bindings region, forwarded verbatim to
	 * `createColumnStore`. A consumer that attaches a WASM backend passes its own
	 * size (`@internal/sim`'s `SIM_BINDINGS_BYTES`, computed from the binding
	 * manifest); the host then writes the `(component_id, field_id)` IDs into the
	 * region. Omitted / 0 ⇒ no region (a pure-TS game pays nothing for the WASM
	 * seam). De-welded from the engine ABI so a manifest edit doesn't
	 * drift an engine golden. */
	bindingsRegionBytes?: number;
	/** Opt into the **determinism surface**. Default `false`.
	 * Gates the three methods that fold/serialize state in canonical (sorted)
	 * order: `stateHash`, `snapshotSparse`, `restoreSparse`. When `false`
	 * those throw `DETERMINISM_DISABLED` — the canonical-ordering tax (sparse
	 * `canonicalIndices` sort + relation target-set sort) is never paid, and a
	 * consumer can't accidentally read a non-canonical digest. When `true`,
	 * today's behavior is reproduced bit-for-bit. This is the ONLY effect of the
	 * flag: it does not touch the per-tick path, the in-place-allocator invariant
	 * (a memory-safety requirement that holds regardless), or the
	 * always-on `enabled_count` partition maintenance. The flag's value is a
	 * capability gate, not a hot-path switch — `stateHash`/snapshot are never
	 * called per tick. */
	deterministic?: boolean;
}

export class Store implements ObserverHost, QueryHost {
	// --- Entity ID management ---
	// Generational slot allocation (generations view, high-water, free-list,
	// alive count) lives in `EntityAllocator`. `entityArchetype` /
	// `entityRow` stay here — which archetype/row a live slot occupies is
	// membership state, not allocation state.
	//
	// The generations/archetype/row views are
	// Int32Arrays into the SAB's entity-index region, so Zig systems can
	// resolve `entityId → (archetype_id, row)` during `sim.tick()` without
	// callback-into-TS. The view objects get replaced whenever the SAB is
	// reallocated (extend / grow); the engine refreshes them (and replants
	// the allocator's) inside `_handleBufferResized` before any caller
	// observes the new SAB.
	private readonly entityAllocator: EntityAllocator;

	// --- Component metadata ---
	// Parallel array indexed by ComponentID: fieldNames, fieldIndex, and fieldTypes
	// for building archetype column layouts.
	private readonly componentMetas: ComponentMeta[] = [];
	private componentCount = 0;

	// --- Sparse storage class (out-of-identity components) ---
	// Parallel array indexed by SparseComponentID. Each store holds a sparse
	// component's membership + data keyed by entity index, OUTSIDE the archetype
	// mask — add/remove cause no archetype transition and consume no identity
	// bit. A separate id space from `componentCount`, which is the mechanism by
	// which sparse components escape the STORE_DESCRIPTOR_COMPONENT_LIMIT cap.
	private readonly sparseStores: SparseComponentStore[] = [];
	/** Debug names parallel to `sparseStores` — diagnostics only. */
	private readonly sparseNames: (string | undefined)[] = [];

	// --- Relations (sparse (relation, target) pairs) ---
	// Registry + traversal algorithms live in `RelationService`; the Store's
	// relation methods below are one-line delegations. Wired in the constructor
	// through the narrow `RelationServiceHost` seam.
	private readonly relationService: RelationService;

	// --- Event channels ---
	// Channel array + key map + per-tick dirty list live in `EventRegistry`
	// (event_registry.ts); the event methods below delegate.
	private readonly events = new EventRegistry();

	// --- Archetype management ---
	// Topology (archetype list, mask→id map, id counter, inverted component
	// index, edge resolution/creation) lives in `ArchetypeGraph`.
	// Storage lifecycle stays here: `_archExtendStoreWithNewSpecs` (SAB
	// extend + view refresh), `_materializeArchetype` (column-store binding
	// + grow handler), `_fanIntoQueries` (query-registry fan-in) are the
	// graph's host seams. Flush loops hoist `archGraph.archetypes` /
	// `.componentIndex` to locals — the graph is their sole writer and
	// archetypes are never removed, so hoisted references stay valid.
	private readonly archGraph: ArchetypeGraph;
	// Registered queries: the Store pushes newly-created archetypes into matching
	// query result arrays, so queries are always up-to-date.
	private readonly registeredQueries: {
		includeMask: BitSet;
		excludeMask: BitSet | null;
		anyOfMask: BitSet | null;
		result: Archetype[];
		query: Query<any> | null;
	}[] = [];
	private emptyArchetypeId: ArchetypeID;

	// entityIndex → ArchetypeID (UNASSIGNED = not in any archetype).
	// SAB-backed. See `entityGenerations`
	// comment for the lifecycle.
	private entityArchetype: Int32Array;
	// entityIndex → row within its archetype (UNASSIGNED = no row).
	// SAB-backed.
	private entityRow: Int32Array;

	// --- Deferred operation buffers ---
	// The pending buffers and the phase-flush drain policy (fast path,
	// observed fixed point, re-entrancy guard) live in `DeferredCommandBuffer`
	//; the batch appliers (`_flushAdds` etc.) stay here with the
	// transition/dirty/observer machinery they are entangled with, reached
	// through the collaborator's closure host.
	private readonly _deferred: DeferredCommandBuffer;
	// Snapshot / resume orchestration — serialization, framing,
	// and fail-closed validation live in `SnapshotService`; the Store keeps
	// the DETERMINISM_DISABLED gates and the live-world mutation seams
	// (`_mountRestoredDense`, `_reconstructHostRows`).
	private readonly _snapshots: SnapshotService;

	public _tick: number = 0;

	/** Per-world frame-trace sink, installed via `ECS.setTrace`.
	 * `null` unless a consumer attaches a recorder. Every call site is
	 * `if (DEV) store._trace?.…`, so production builds dead-code-eliminate
	 * the seam and pay only this one nullable field. The sink observes; it never
	 * folds into `stateHash` (a scheduling artifact, like `_changedTick` / the
	 * observer state below). */
	public _trace: FrameTraceSink | null = null;

	// --- Component observers ---
	// Count of components with any onAdd/onRemove observer. While 0, the
	// structural-flush fast path is byte-for-byte unchanged (no event collection,
	// no fixed-point loop). The whole subsystem is additive and inert until an
	// observer registers — observer/dirty/event state lives entirely here and is
	// NOT folded into `stateHash` or snapshot (a scheduling artifact, like
	// `_changedTick`).
	private _structuralObserverCount = 0;
	/** Count of components with any onDisable/onEnable observer. While 0
	 * (with `_structuralObserverCount` also 0), `flushStructural` takes the
	 * byte-for-byte fast path and the toggle drain skips event collection. */
	private _toggleObserverCount = 0;
	/** Reused effective-event scratch for the current flush round. */
	private readonly _obsEvents: StructuralObserverEvents = {
		addComp: [],
		addEid: [],
		addLen: 0,
		remComp: [],
		remEid: [],
		remLen: 0,
		disComp: [],
		disEid: [],
		disLen: 0,
		enaComp: [],
		enaEid: [],
		enaLen: 0
	};
	/** Installed via `setStructuralObserverHook` — dispatches a round's collected
	 * events to the observer registry (ordering + callbacks), which may enqueue
	 * further structural ops. */
	private _structuralObserverHook: ((ev: StructuralObserverEvents) => void) | null = null;

	/** Install the structural-observer dispatch hook (called once by `ECS`
	 * during construction) — the named seam replacing direct writes to the
	 * previously-public field. */
	public setStructuralObserverHook(fn: (ev: StructuralObserverEvents) => void): void {
		this._structuralObserverHook = fn;
	}

	// Destroy fires onRemove for every component the entity carried (a destroy is
	// a remove of the whole mask). `flushDestroyed` walks the dying entity's
	// archetype mask through this reused, pre-bound bit visitor — one allocation
	// at construction, none per destroyed entity — collecting an effective-remove
	// event per observed component into `_obsEvents`. `_collectDestroyEid`
	// carries the current entity across the `BitSet.forEach` callback. Inert
	// unless `_structuralObserverCount > 0`. See `flushDestroyed`.
	private _collectDestroyEid = 0;
	private readonly _collectDestroyRemoveBit = (cid: number): void => {
		if (!this.componentMetas[cid].obsRem) return;
		const ev = this._obsEvents;
		ev.remComp[ev.remLen] = cid;
		ev.remEid[ev.remLen] = this._collectDestroyEid;
		ev.remLen++;
	};

	// Disable/enable fan a *net* toggle transition out to an onDisable / onEnable
	// per carried component — like the destroy fan-out above, a disable is a
	// soft remove of the whole mask from default queries. `_flushToggles` walks
	// each net-toggled entity's archetype mask through the matching pre-bound
	// visitor, collecting an event per observed component into `_obsEvents`.
	// `_collectToggleEid` carries the current entity across `BitSet.forEach`.
	// Inert unless `_toggleObserverCount > 0`.
	private _collectToggleEid = 0;
	private readonly _collectDisableBit = (cid: number): void => {
		if (!this.componentMetas[cid].obsDisable) return;
		const ev = this._obsEvents;
		ev.disComp[ev.disLen] = cid;
		ev.disEid[ev.disLen] = this._collectToggleEid;
		ev.disLen++;
	};
	private readonly _collectEnableBit = (cid: number): void => {
		if (!this.componentMetas[cid].obsEnable) return;
		const ev = this._obsEvents;
		ev.enaComp[ev.enaLen] = cid;
		ev.enaEid[ev.enaLen] = this._collectToggleEid;
		ev.enaLen++;
	};
	/** Net-transition snapshot for the toggle drain: entity → its disabled
	 * state at the START of the drain. Reused, cleared each drain. Lets
	 * `_flushToggles` emit one event per *net* transition (disable→enable→disable
	 * within a tick = a single onDisable) instead of one per buffered op — required
	 * because the radix canonical-order pass would otherwise reorder duplicate eids
	 * and mis-sequence a consumer's delete/republish. */
	private readonly _toggleInitial = new Map<EntityID, boolean>();

	// --- Per-entity onSet: opt-in per-row dirty list ---
	// `_dirtyLists[cid]` is the list of dirty entity ids; `_dirtyMarks[cid]` is
	// the per-entity-index dedup bit (append to the list only if the bit was
	// clear). Drained as the onSet callback at the post-update detection point.
	// Allocated only for components with a per-entity onSet observer.
	public _anyDirtyTracked = false;
	private readonly _dirtyTrackedCids: number[] = [];
	private readonly _dirtyLists: (EntityID[] | undefined)[] = [];
	private readonly _dirtyMarks: (Uint8Array | undefined)[] = [];

	/** Set by any path that changes a SAB-backed archetype's live row count
	 * (`flushStructural`/`flushDestroyed` when they did work; immediate
	 * `destroyEntity`, `addComponent(s)`, `removeComponent(s)` on the
	 * Store). Cleared by `publishRowCountsToDescriptor`. Lets read-only
	 * phases' `ctx.flush` skip the descriptor walk entirely. */
	private _rowCountsDirty: boolean = false;

	/** Monotonic counter bumped by every membership-changing path (immediate
	 * `addComponent(s)`, `removeComponent(s)`, `destroyEntity`,
	 * `batchAddComponent`, `batchRemoveComponent`, `flushStructural`,
	 * `flushDestroyed`, and new-archetype installs in `ArchetypeGraph.install`).
	 * Read by `Query._nonEmpty()` via `QueryResolver._getQueryDirtyEpoch`
	 * — a query whose stored `_lastSeenEpoch` matches the current epoch
	 * reuses its cached non-empty list. Replaces the previous walk
	 * over `registeredQueries` that wrote one dirty bit per query per
	 * mutation; 5000 startup adds × Q queries used to be 5000×Q writes,
	 * now it's 5000 integer increments. Public so ECS can forward through
	 * its `QueryResolver` impl; not part of the user-facing API. */
	public _queryDirtyEpoch: number = 0;

	private readonly initialCapacity: number;

	// Scratch BitSet for `addComponents` / `removeComponents` target-mask
	// computation. The previous `currentArch.mask.copy()` allocated a fresh
	// BitSet + `_words.slice()` per call — every spawn that introduces any
	// new bit paid that cost. The scratch is safe because the only caller
	// that holds the mask long-term is `ArchetypeGraph.install`, which now clones
	// before storing into the archetype map (`archGetOrCreateFromMask`
	// clones when handing off to the graph's `install`). addComponents /
	// removeComponents do not recurse — their callees (`ArchetypeGraph.install`,
	// `moveEntityFrom`, `writeFields`, `_onArchLenChange`) never call
	// back into them.
	private readonly _scratchTargetMask: BitSet = new BitSet();

	// --- SAB-backed ECS columns ---
	// Every Archetype's column views are TypedArrays over this SAB. When a
	// new archetype is discovered we `extendColumnStore` to plant its region
	// at the SAB tail, refresh every pre-existing archetype's column views
	// (the realloc moved them — that's the `view_stamp` contract), then
	// construct the new archetype via `Archetype.fromColumnStore`. The
	// heap-backed `TypedArrayFor[tag]` fallback in `archetype.ts` is no
	// longer reached from this code path; it stays compileable until a
	// later change removes it.
	private _columnStore: ColumnStore;


	/** Installed on every SAB-backed Archetype so the Archetype can
	 * request a SAB grow when an insertion would exceed its column
	 * capacity. Doubles the offending archetype's row capacity (or jumps
	 * to whatever fits `arch.length + additional`, whichever is larger),
	 * reallocs the SAB via `growColumnStore` (live rows of every archetype
	 * are carried forward), and republishes column views to every
	 * SAB-backed archetype. */
	private readonly _growHandler = (arch: Archetype, additional: number): void => {
		const archId = arch.id as number;
		const storeArch = this._columnStore.archetypes.get(archId);
		if (storeArch === undefined) {
			throw new ECSError(
				ECS_ERROR.ARCHETYPE_NOT_FOUND,
				`growHandler invoked on archetype ${archId} which has no SAB region`
			);
		}
		const oldCapacity = storeArch.rowCapacity;
		const required = arch.length + additional;
		// Double until the new capacity covers `required`. Doubling keeps the
		// amortised cost of N inserts O(N).
		let newCapacity = oldCapacity > 0 ? oldCapacity : 1;
		while (newCapacity < required) newCapacity = newCapacity * 2;

		const growSpecs: ArchetypeGrowSpec[] = [];
		const archs = this.archGraph.archetypes;
		for (let i = 0; i < archs.length; i++) {
			const a = archs[i];
			const sa = this._columnStore.archetypes.get(a.id as number);
			if (sa === undefined) continue;
			growSpecs.push({
				archetypeId: a.id as number,
				// Only the overflowing archetype's capacity grows; the rest stay
				// at their current capacity (growColumnStore rejects shrinks).
				newRowCapacity: (a.id as number) === archId ? newCapacity : sa.rowCapacity,
				// Tag-only archetypes have no SAB column data — their `length`
				// grows on the heap-backed `_entityIds` past `sa.row_capacity`
				// (the SAB descriptor's capacity is metadata only when columns
				// is empty). Report row_count=0 for them so growColumnStore
				// doesn't reject the spec on a vacuous bound check.
				rowCount: a.hasColumns ? a.length : 0
			});
		}
		// No cap-fallback BY DESIGN. If `_bufferAllocator` is the default
		// `growableSabAllocator`, this call throws once the requested size
		// crosses the allocator's 256 MiB cap. We deliberately let that throw
		// propagate (the match dies) rather than catching it to realloc into a
		// fresh allocator or compact holes. A real workload uses ~16 MiB
		// and columns never grow (1024 initial capacity > the typical ~1000-row
		// budget), and the entity-ID space (`1<<20`) caps total entities below the
		// point where columns could fill 256 MiB. So hitting the cap means runaway
		// entity creation upstream — a defect to diagnose, not a limit to paper
		// over. See `growableSabAllocator`'s doc comment for the full numbers.
		// The catch below does NOT soften that: a cap hit is re-thrown — still
		// fatal — with the caller's declared sizing intent attached so
		// the failure is diagnosable in the caller's own terms.
		let growResult;
		try {
			growResult = growColumnStore(
				this._columnStore,
				{ archetypes: growSpecs },
				this._bufferAllocator
			);
		} catch (cause) {
			if (cause instanceof StoreCapExceededError) throw this._capExceededError(cause);
			throw cause;
		}
		this._columnStore = growResult.store;
		// In-place fast path (the grow-side analogue): only the grown
		// archetypes' columns moved, so every other archetype's views are
		// still valid — refresh just the grown ones. The realloc path moved
		// everything, so `viewsPreserved` is false and we refresh all.
		if (growResult.viewsPreserved) {
			const grownIds = growResult.grownArchetypeIds;
			for (let i = 0; i < grownIds.length; i++) {
				const a = this.archGet(grownIds[i] as ArchetypeID);
				if (a.isBufferBacked) a.refreshViews(this._columnStore);
			}
		} else {
			for (let i = 0; i < archs.length; i++) {
				if (archs[i].isBufferBacked) archs[i].refreshViews(this._columnStore);
			}
		}
		this._handleBufferResized();
	};

	/** Build the intent-aware fatal for an allocator cap hit. The
	 * allocator can only name raw bytes; the Store knows what the caller
	 * declared (`capContext`) and how many entities are live, so the error
	 * says "3.2× the declared budget — runaway creation upstream?" instead
	 * of leaving the caller to reverse-engineer byte counts. Fatality is
	 * unchanged (no grow-beyond-cap fallback). */
	private _capExceededError(cause: StoreCapExceededError): ECSError {
		const ctx = this._capContext;
		const live = this.entityAllocator.aliveCount;
		const requested =
			`SAB grow refused: requested ${cause.requestedBytes} bytes exceeds ` +
			(cause.capBytes !== null ? `the ${cause.capBytes}-byte cap.` : `the backing's ceiling.`);
		let intent: string;
		if (ctx === undefined) {
			intent = ` The ECS holds ${live} live entities (no sizing intent declared).`;
		} else if (ctx.budgetEntities !== null) {
			const ratio = (live / ctx.budgetEntities).toFixed(1);
			intent =
				` Declared ${ctx.intentLabel}; the ECS holds ${live} live entities ` +
				`(${ratio}× the budget) — runaway entity creation upstream, or an ` +
				`under-declared budget. Raise the budget only if a ${live}-entity ` +
				`ECS is intended.`;
		} else {
			intent = ` Declared ${ctx.intentLabel}; the ECS holds ${live} live entities.`;
		}
		return new ECSError(
			ECS_ERROR.STORE_CAP_EXCEEDED,
			requested +
				intent +
				` The cap is a hard ceiling with no grow-beyond fallback — ` +
				`diagnose growth before raising it. Caused by: ${cause.message}`
		);
	}

	private readonly _bufferAllocator: InPlaceBufferAllocator;
	private readonly _capContext: ECSMemoryCapContext | undefined;
	private readonly _onBufferResized: (() => void) | undefined;

	/** Construct with an `initialCapacity` number (legacy form) or an
	 * options object (adds `bufferAllocator` and
	 * `onBufferResized` callback). Both signatures coexist so test fixtures
	 * that pass `new Store(4)` keep working. */
	constructor(arg?: number | StoreOptions) {
		const opts: StoreOptions = typeof arg === "number" ? { initialCapacity: arg } : (arg ?? {});
		this.initialCapacity = opts.initialCapacity ?? DEFAULT_COLUMN_CAPACITY;
		// Default to `growableSabAllocator`. Existing
		// TypedArray column views survive `.grow()` in-place — the engine's
		// hot extend path skips the realloc-and-republish work that
		// dominated lazy archetype registration. Callers wanting the
		// classical per-extend fresh-SAB behavior (or `wasmMemoryAllocator`
		// for the sim FFI) pass an explicit `bufferAllocator`. Default cap is
		// 256 MiB — plenty for a 1000-entity workload (~2 MiB live SAB), well
		// below browser per-origin SAB ceilings, and quicker to construct than a
		// 1 GiB cap (V8 does per-byte bookkeeping at the `maxByteLength`
		// reservation; see the allocator.ts header note).
		this._bufferAllocator = opts.bufferAllocator ?? growableSabAllocator();
		// Enforced at the boundary: a live Store's flush loops
		// hoist entity-index views across grows, which is only correct for an
		// in-place allocator. The option type already rejects non-in-place
		// allocators at compile time; this backstop catches untyped JS callers.
		if (this._bufferAllocator.isInPlace !== true) {
			throw new ECSError(
				ECS_ERROR.INVALID_MEMORY_OPTIONS,
				"Store requires an in-place SAB allocator: the flush loops keep " +
					"writing through hoisted entity-index views across grows, so a non-in-place " +
					"allocator (e.g. DEFAULT_SAB_ALLOCATOR) corrupts the entity→row mapping. " +
					"Use growableSabAllocator / wasmMemoryAllocator; non-in-place allocators " +
					"are snapshot/test sizing utilities only."
			);
		}
		this._capContext = opts.capContext;
		this._onBufferResized = opts.onBufferResized;
		// Initialise empty so the first `extendColumnStore` call in
		// `archGetOrCreateFromMask` has a base to extend. Empty stores
		// are 32 bytes (header only); the empty archetype is planted by the
		// constructor's `archGetOrCreateFromMask(new BitSet())` below.
		// The allocator is always an in-place grower (asserted above), so
		// pre-reserve descriptor-region headroom: future `extendColumnStore`
		// calls can append new archetype descriptors without shifting any
		// existing column byte_offs. This is the engine-side wiring for
		// the in-place growable-SAB fast path. 64 KiB ≈ 2000 archetypes at the
		// typical ~3 columns/archetype — comfortable headroom for runtime
		// archetype discovery without bloating empty stores.
		this._entityIndexCapacity = opts.entityIndexCapacity ?? ENTITY_INDEX_DEFAULT_CAPACITY;
		this._regions = opts.regions;
		this._bindingsRegionBytes = opts.bindingsRegionBytes ?? 0;
		this._deterministic = opts.deterministic ?? false;
		// Deferred-command queue + drain policy. Closure host (the
		// `RelationServiceHost` style): appliers and observer gates re-read
		// live Store state per flush call — never per entity.
		this._deferred = new DeferredCommandBuffer(
			{
				applyAdds: () => this._flushAdds(),
				applyRemoves: () => this._flushRemoves(),
				applyDestroys: () => this._drainDestroyed(),
				applyToggles: () => this._flushToggles(),
				structuralObserverCount: () => this._structuralObserverCount,
				toggleObserverCount: () => this._toggleObserverCount,
				structuralObserverHook: () => this._structuralObserverHook
			},
			this._obsEvents
		);
		// The host seam hands the relation service closures, not field refs:
		// `entityGenerations` / `entityArchetype` / `entityRow` are reallocated
		// on capacity growth, so each accessor re-reads the live field per call.
		this.relationService = new RelationService({
			isAlive: (id) => this.isAlive(id),
			hasSparse: (entityId, def) => this.hasSparse(entityId, def),
			pushSparseStore: (fieldNames, fieldTypes) => this._pushSparseStore(fieldNames, fieldTypes),
			sparseStoreOf: (def) => this.sparseStoreOf(def),
			sparseStores: () => this.sparseStores,
			entityGenerations: () => this.entityAllocator.generations,
			entityArchetype: () => this.entityArchetype,
			entityRow: () => this.entityRow,
			archetypes: () => this.archGraph.archetypes,
			forEachSparseMatch: (
				include,
				exclude,
				anyOf,
				sparseInclude,
				sparseExclude,
				denseArchetypes,
				cb,
				includeDisabled
			) =>
				this._forEachSparseMatch(
					include,
					exclude,
					anyOf,
					sparseInclude,
					sparseExclude,
					denseArchetypes,
					cb,
					includeDisabled
				)
		});
		// Always-on event ring. 4 KiB + 16 B header per
		// Store is negligible and means any system that needs to emit
		// SAB-visible events finds `header.event_ring_off` non-zero
		// without per-test wiring. Symmetric with `entityIndex` being
		// always-on.
		// Always-on command ring. Same reasoning as the
		// always-on event ring: a consumer's WASM structural-change drain
		// needs it; bare-SAB tests pay the negligible 4 KiB + 16 B cost.
		// Without it, the drain returns 0 (RingAbsent) and the parity test
		// cannot drain commands.
		// Always-on action ring. Was an opt-in `actionRingCapacitySlots`
		// ECS option; now de-gamed to an always-on engine mechanism region at the
		// default capacity (like the command/event rings), so the public surface
		// carries no ring-sizing knob. The TS→WASM action drain finds it present.
		this._columnStore = createColumnStore([], this._bufferAllocator, {
			reservedDescriptorBytes: 64 * 1024,
			entityIndexCapacity: this._entityIndexCapacity,
			eventRingCapacitySlots: EVENT_RING_DEFAULT_CAPACITY_SLOTS,
			commandRingCapacitySlots: COMMAND_RING_DEFAULT_CAPACITY_SLOTS,
			actionRingCapacitySlots: ACTION_RING_DEFAULT_CAPACITY_SLOTS,
			regions: this._regions,
			bindingsRegionBytes: this._bindingsRegionBytes
		});
		// Build the initial Int32Array views over the SAB entity-index
		// region. Mutated by every entity create/destroy/move; refreshed
		// inside `_handleBufferResized` after extend/grow.
		const views = buildEntityIndexViews(
			this._columnStore.buffer,
			this._columnStore.header.entityIndexOff,
			this._entityIndexCapacity
		);
		this.entityArchetype = views.archetypes;
		this.entityRow = views.rows;
		// boundary: TypedArray interop. The allocator owns the generations
		// view plus a single-slot view over the region's `length` field (the
		// pre-built-view optimization).
		this.entityAllocator = new EntityAllocator(
			this._entityIndexCapacity,
			views.generations,
			new Uint32Array(
				this._columnStore.buffer,
				this._columnStore.header.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length,
				1
			)
		);
		// Snapshot/resume orchestration. Closure host — accessors
		// re-read live fields per call (the column store and entity-index views
		// are replaced on restore); the allocator rides in whole as its own
		// snapshot seam (step 3). All cold-path.
		this._snapshots = new SnapshotService(
			{
				sparseStores: () => this.sparseStores,
				relationStores: () => this.relationService.stores,
				generations: () => this.entityAllocator.generations,
				archetypes: () => this.archGraph.archetypes,
				columnStore: () => this._columnStore,
				bufferAllocator: () => this._bufferAllocator,
				entityIndexCapacity: () => this._entityIndexCapacity,
				tick: () => this._tick,
				setTick: (tick) => {
					this._tick = tick;
				},
				publishRowCounts: () => this.publishRowCountsToDescriptor(),
				mountRestoredDense: (restored) => this._mountRestoredDense(restored),
				reconstructHostRows: (host) => this._reconstructHostRows(host),
				invalidateQueryCaches: () => {
					this._queryDirtyEpoch++;
					this._rowCountsDirty = true;
				}
			},
			this.entityAllocator
		);
		// Archetype topology. Creation-path-only closures — an
		// edge-cache hit never calls the host.
		this.archGraph = new ArchetypeGraph({
			componentMetas: () => this.componentMetas,
			initialCapacity: () => this.initialCapacity,
			extendStore: (specs) => this._archExtendStoreWithNewSpecs(specs),
			materialize: (id, ownedMask, layouts) => this._materializeArchetype(id, ownedMask, layouts),
			fanIntoQueries: (archetype) => this._fanIntoQueries(archetype)
		});
		this.emptyArchetypeId = this.archGetOrCreateFromMask(new BitSet());
	}

	/** Capacity of the entity-index SAB region (max slots ≈ max live
	 * entities). Fixed at construction; a future
	 * follow-up will grow it via `growColumnStore` when `entityHighWater`
	 * hits the cap. */
	private readonly _entityIndexCapacity: number;
	/** Consumer-declared SAB regions, captured so the realloc path
	 * re-lays them out. `undefined` when no consumer regions were declared.
	 * The region contents survive a grow via the self-describing region table
	 * (`extend.ts` snapshot/restore), so this is only the layout recipe. */
	private readonly _regions: readonly StoreRegionSpec[] | undefined;
	/** Byte size of the opt-in sim-bindings region. 0 ⇒ no region (the
	 * pure-TS default). Captured so the initial `createColumnStore` reserves it;
	 * across a realloc the size is re-derived from the old header by
	 * `optionsFromOld`, so it is not threaded through the grow/extend path. */
	private readonly _bindingsRegionBytes: number;
	/** Determinism opt-in. When `false` (the default), the
	 * canonical-ordering determinism surface (`stateHash` / `snapshotSparse` /
	 * `restoreSparse`) throws `DETERMINISM_DISABLED` rather than running its
	 * sort. Memory-safety invariants (the in-place allocator) and the
	 * `enabled_count` partition are unaffected — they hold regardless. */
	private readonly _deterministic: boolean;

	/** Whether the determinism surface is enabled. `false` ⇒ `stateHash`
	 * / `snapshotSparse` / `restoreSparse` throw `DETERMINISM_DISABLED`. */
	public get deterministic(): boolean {
		return this._deterministic;
	}

	/** Guard the canonical-ordering determinism surface. Throws
	 * `DETERMINISM_DISABLED` when determinism wasn't opted into, naming the
	 * method so the caller knows to pass `{ deterministic: true }`. Always on
	 * (not `DEV`-gated): the surface is cold (never per-tick) so one boolean
	 * check is free, and a silent non-canonical digest is the failure mode we're
	 * preventing. */
	private _requireDeterministic(method: string): void {
		if (!this._deterministic) {
			throw new ECSError(
				ECS_ERROR.DETERMINISM_DISABLED,
				`${method} requires determinism — construct the Store/ECS with ` +
					`{ deterministic: true }. The canonical-ordering determinism surface ` +
					`(stateHash / snapshotSparse / restoreSparse) is opt-in.`
			);
		}
	}

	/** Reject `f32`/`f64` fields on a `deterministic: true` world at registration.
	 * IEEE-754 rounds differently across V8 / Bun / Zig at the 1-ULP
	 * level, so a float column in a fixed-update path is a silent per-tick
	 * `stateHash` divergence between client and server — the one thing the
	 * determinism opt-in exists to prevent. Non-deterministic worlds
	 * skip this entirely (floats stay allowed), so it costs the default path
	 * nothing. `kind` names the storage class in the error ("component" /
	 * "sparse component"); the array shorthand's `f64` default lands here too, so
	 * a deterministic world must pass an explicit integer type. */
	private _rejectNonDeterministicFields(
		fieldNames: readonly string[],
		fieldTypes: readonly TypedArrayTag[],
		kind: string
	): void {
		if (!this._deterministic) return;
		for (let i = 0; i < fieldTypes.length; i++) {
			const t = fieldTypes[i];
			if (t === "f32" || t === "f64") {
				throw new ECSError(
					ECS_ERROR.NON_DETERMINISTIC_COLUMN_TYPE,
					`Cannot register ${kind} field "${fieldNames[i]}" as "${t}" on a ` +
						`{ deterministic: true } world: floating-point columns round differently ` +
						`across V8 / Bun / Zig (1-ULP IEEE-754), breaking cross-host stateHash ` +
						`agreement. Use an integer type (e.g. "i32") — represent ` +
						`fractional quantities as fixed-point (Q16.16). Note the array shorthand ` +
						`defaults to "f64", so pass an explicit integer type there.`,
					{ field: fieldNames[i], type: t, kind }
				);
			}
		}
	}

	/** Rebuild the Int32Array views over the SAB entity-index region
	 * after a host-side SAB realloc (extend / grow). Called from
	 * `_handleBufferResized` BEFORE the user-supplied `onBufferResized`
	 * callback fires so any downstream reader sees coherent views. */
	private _refreshEntityIndexViews(): void {
		const off = this._columnStore.view.getUint32(STORE_HEADER_OFFSETS.entity_index_off, true);
		// boundary: TypedArray interop. Capacity didn't change in this PR's
		// scope; the new region's bytes were either preserved (slow path
		// via snapshot+restore in extend/grow) or untouched (in-place fast
		// path). Re-derive the views from the new SAB.
		const views = buildEntityIndexViews(this._columnStore.buffer, off, this._entityIndexCapacity);
		this.entityArchetype = views.archetypes;
		this.entityRow = views.rows;
		this.entityAllocator.replantViews(
			views.generations,
			new Uint32Array(this._columnStore.buffer, off + ENTITY_INDEX_HEADER_OFFSETS.length, 1)
		);
	}

	/** Centralised "SAB was just reallocated" handler. Refreshes the
	 * Int32Array views FIRST (so user callbacks observe valid views),
	 * then mirrors `entityHighWater` into the region's length header,
	 * then fires the user-supplied callback. */
	private _handleBufferResized(): void {
		this._refreshEntityIndexViews();
		this.entityAllocator.publishLength();
		this._onBufferResized?.();
	}

	/** SAB backing every archetype's column views. Read-only handle; the
	 * live mutation happens through `archGetOrCreateFromMask`.
	 * Exposed for tests, snapshot/restore, and the upcoming
	 * `columnStoreStateHash` wire-up. Production reads of column data should
	 * still go through `Archetype.getColumnRead` (which sources from this
	 * SAB under the hood). */
	public get columnStore(): ColumnStore {
		return this._columnStore;
	}

	/** Resolve a consumer-declared SAB region's byte offset by `region_id`, or
	 * 0 when the region is absent (no region was declared with that id). The
	 * generic, de-gamed replacement for the removed game-named accessors
	 * (`terrain_view` / `spatial_grid_view` / … ); a consumer pairs this with
	 * its own region module (e.g. `@internal/sim`'s region helpers) to
	 * materialise a typed view. TS twin of Zig `abi.find_region`. */
	public regionOffset(regionId: number): number {
		return findRegionOffset(this._columnStore.view, regionId);
	}

	/** A handle to a consumer-declared SAB region resolved by `region_id`, or
	 * `null` when absent. Carries the live `buffer`/`view` plus the region's byte
	 * `offset` and `bytes`, so a consumer's region module can build a TypedArray
	 * view over exactly the region's span without re-reading the directory.
	 * Re-fetch after a SAB grow (the offset/view may have moved). */
	public regionHandle(regionId: number): ColumnStoreRegionHandle | null {
		const entry = findRegionEntry(this._columnStore.view, regionId);
		if (entry === null) return null;
		return {
			buffer: this._columnStore.buffer,
			view: this._columnStore.view,
			offset: entry.byteOffset,
			bytes: entry.byteLength
		};
	}

	/**
	 * Stamp every SAB-backed archetype's live `length` into its descriptor's
	 * `row_count` field. `extendColumnStore` /
	 * `growColumnStore` are the only other writers of `row_count`, and they
	 * record the count at the moment of the resize — `Archetype.addEntity`
	 * does not update it, so any insertion after the most recent resize
	 * leaves the descriptor stale. Zig systems that drive their per-row loop
	 * off `arch_hdr.row_count` (every `tick_*` export)
	 * read those stale bytes and silently skip the just-spawned rows.
	 *
	 * Lockstep walk: SAB descriptors are written by `extendColumnStore` in
	 * the order non-SAB archetypes are promoted, which is the same id-order
	 * those archetypes occupy in `this.archGraph.archetypes`. Iterating that array
	 * once, skipping non-SAB entries, and advancing an `archAddr` cursor
	 * by the descriptor's `column_count` lets us write `row_count` without
	 * the throwaway `Map<archId, length>` the previous version allocated
	 * on every call. Cheap: descriptor-region seeks only, no column
	 * I/O.
	 *
	 * Gated by `_rowCountsDirty` — mutation paths
	 * (`flushStructural`, `flushDestroyed`, immediate `destroyEntity`,
	 * `addComponent(s)`, `removeComponent(s)`) set the flag; this method
	 * clears it. Read-only phases that flush only to drain empty buffers
	 * pay nothing. */
	public publishRowCountsToDescriptor(): void {
		if (!this._rowCountsDirty) return;
		const view = this._columnStore.view;
		let archAddr = view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
		const archs = this.archGraph.archetypes;
		for (let i = 0; i < archs.length; i++) {
			const a = archs[i];
			if (!a.isBufferBacked) continue;
			const columnCount = view.getUint32(
				archAddr + ARCHETYPE_DESCRIPTOR_OFFSETS.column_count,
				true
			);
			if (DEV) {
				const descArchId = view.getUint32(
					archAddr + ARCHETYPE_DESCRIPTOR_OFFSETS.archetype_id,
					true
				);
				if (descArchId !== (a.id as number)) {
					throw new Error(
						`descriptor order drift: archetypes[${i}].id=${a.id as number} but ` +
							`descriptor at +${archAddr} reports archetype_id=${descArchId}`
					);
				}
			}
			view.setUint32(
				archAddr + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count,
				a.hasColumns ? a.length : 0,
				true
			);
			// Publish the enabled-row count too so the WASM sim's
			// per-row scan loops skip disabled rows. Mirrors row_count: 0 for a
			// column-less archetype (no SAB rows to scan).
			view.setUint32(
				archAddr + ARCHETYPE_DESCRIPTOR_OFFSETS.enabled_count,
				a.hasColumns ? a.enabledCount : 0,
				true
			);
			archAddr += ARCHETYPE_DESCRIPTOR_HEADER_BYTES + columnCount * COLUMN_DESCRIPTOR_BYTES;
		}
		this._rowCountsDirty = false;
	}

	/** FNV-1a-style 32-bit digest over (archetype_id, live_row_count, live
	 * column bytes) for each archetype in id order, followed by the sparse
	 * stores (out-of-identity components) in registration order.
	 * This is the canonical "live ECS state digest" for cross-replay
	 * determinism. It replaces the earlier per-networked-component fold.
	 *
	 * **Sparse coverage.** Sparse data lives outside the archetype
	 * graph, so it is folded separately after the archetype loop — per store:
	 * the sparse-component id, the member count, then each member's source
	 * entity index + f64 field words, walked in CANONICAL ascending-index order
	 * (`SparseComponentStore.canonicalIndices`). Canonical order is what makes
	 * the digest insertion-order-independent: two worlds with identical sparse
	 * contents built by different add/remove sequences agree. Keyed by entity
	 * index, and destruction purges the slot, so a recycled index never carries
	 * a stale occupant's data into the hash.
	 *
	 * It is strictly broader than the prior per-networked-component fold
	 * (covers every column, not just a hand-picked subset of networked
	 * components), and strictly tighter than `columnStoreStateHash(...)`
	 * which scans the full SAB including trailing unused capacity.
	 *
	 * **Per-word fold.** The inner column loop folds one 32-bit
	 * word at a time using FNV-1a's `xor + imul(PRIME)` step. This is NOT
	 * byte-for-byte FNV-1a-32 of the column bytes — it's a deterministic
	 * digest with the same equality semantics, and much quicker than the
	 * per-byte loop it replaces. Trailing 0–3 tail bytes (only possible for
	 * u8/u16 columns at odd row counts) are folded together as a single
	 * little-endian word so the algorithm stays branch-free in the inner
	 * loop. The 4-byte `id` and `len` headers are folded as words for the
	 * same reason. Byte order is little-endian to match the platform's
	 * native TypedArray layout; the digest is opaque (no consumer compares
	 * against a literal value), so endianness is an implementation detail
	 * rather than wire contract.
	 *
	 * Determinism: same store ⇒ same digest within a process, and across
	 * processes on the same architecture (which is all `replay_match`
	 * needs — both replays run the same algorithm on the same words).
	 *
	 * **Opt-in.** Throws `DETERMINISM_DISABLED` unless the
	 * Store was constructed with `{ deterministic: true }`. The canonical
	 * ordering this fold relies on (sparse `canonicalIndices`, sorted relation
	 * target sets) is the determinism tax the flag gates. */
	public stateHash(): number {
		this._requireDeterministic("state_hash()");
		let h = FNV1A_OFFSET_BASIS;
		const archs = this.archGraph.archetypes;
		for (let i = 0; i < archs.length; i++) {
			const arch = archs[i];
			const id = arch.id as number;
			const len = arch.length;
			// Fold archetype_id as one word — catches "missing archetype"
			// divergence even when both sides have zero rows in the archetype.
			h = fnv1aStepWord(h, id);
			// Fold live row count as one word — so removed rows show up even
			// when their bytes happen to remain in trailing slots.
			h = fnv1aStepWord(h, len);
			// Fold the enabled/disabled partition boundary: the disabled set
			// is real game state, so two worlds with identical row bytes but a
			// different `enabled_count` must diverge. The disabled rows' bytes are
			// still folded below (they're within `[0, len)`); this word pins which
			// of those rows are inert. Determinism holds under lockstep — same op
			// sequence ⇒ same row order ⇒ same boundary (same basis as swap-remove).
			h = fnv1aStepWord(h, arch.enabledCount);
			if (len === 0) continue;
			const cols = arch._flatColumns;
			for (let j = 0; j < cols.length; j++) {
				const buf = cols[j].buf;
				const lenBytes = len * buf.BYTES_PER_ELEMENT;
				const view = new Uint8Array(buf.buffer, buf.byteOffset, lenBytes);
				const wordCount = lenBytes >>> 2;
				let k = 0;
				// Hot inner loop: the per-word FNV step is deliberately INLINED here
				// rather than calling `fnv1aStepWord` (the shared definition the
				// cold folds below use). Inlining the column fold is a
				// deliberate perf decision — it is much quicker than the per-byte loop
				// it replaced — and this
				// scan dominates `stateHash`, run per tick over every live column.
				// The step is identical to `fnv1aStepWord`; keep them in sync.
				for (let w = 0; w < wordCount; w++) {
					// Assemble little-endian u32 from four byte loads. Works at
					// any byteOffset alignment (u8/u16 SAB columns may sit at
					// 1- or 2-byte boundaries; a Uint32Array view would throw).
					const word =
						(view[k] | (view[k + 1] << 8) | (view[k + 2] << 16) | (view[k + 3] << 24)) >>> 0;
					h = (h ^ word) >>> 0;
					h = Math.imul(h, FNV1A_PRIME);
					k += 4;
				}
				const tail = lenBytes & 3;
				if (tail !== 0) {
					// Zero-pad tail bytes into one little-endian word so the
					// inner loop stays branchless. Three byte loads max.
					let tailWord = view[k];
					if (tail > 1) tailWord |= view[k + 1] << 8;
					if (tail > 2) tailWord |= view[k + 2] << 16;
					h = (h ^ (tailWord >>> 0)) >>> 0;
					h = Math.imul(h, FNV1A_PRIME);
				}
			}
		}

		// Fold the sparse stores (out-of-identity components) so the
		// per-tick digest covers their membership + data too. Sparse data lives
		// outside the archetype graph, so the loop above misses it entirely.
		// Each store is walked in CANONICAL entity-index order: SparseMap's
		// native iteration is insertion/swap order, so two worlds with identical
		// sparse contents reached by different add/remove histories would
		// otherwise diverge. Stores are folded in registration order —
		// their `SparseComponentID` is their index here, stable across a run.
		const sparse = this.sparseStores;
		for (let s = 0; s < sparse.length; s++) {
			const store = sparse[s];
			// Fold the sparse-component id + member count, mirroring the
			// archetype header: a store that exists on one side but is empty on
			// the other still perturbs the digest. Cold path (scales with sparse
			// members, not capacity) — folds via the shared `fnv1aStepWord`.
			h = fnv1aStepWord(h, s);
			h = fnv1aStepWord(h, store.size);
			const idxs = store.canonicalIndices();
			for (let i = 0; i < idxs.length; i++) {
				const index = idxs[i];
				// Fold the source entity index so identical rows on different
				// entities don't collide, and so the membership set is part of
				// the digest (the destroy/purge path drops stale indices, so a
				// recycled slot can't smuggle a previous occupant's data in).
				h = fnv1aStepWord(h, index);
				const row = store.getRow(index)!;
				for (let f = 0; f < row.length; f++) {
					// f64 field → two little-endian u32 words, matching the dense
					// column path's explicit LE byte order (architecture-stable).
					F64_HASH_SCRATCH.setFloat64(0, row[f], true);
					h = fnv1aStepWord(h, F64_HASH_SCRATCH.getUint32(0, true));
					h = fnv1aStepWord(h, F64_HASH_SCRATCH.getUint32(4, true));
				}
			}
		}

		// Fold multi-relation forward target sets. Their *values* live in the
		// relation store's side map, not the sparse store (which carries only
		// multi membership as a tag), so the sparse loop above misses them.
		// Exclusive relations need nothing here — their target is a sparse field,
		// already folded above. Walked in canonical order (sources ascending by
		// index, targets ascending by id) so add/remove history doesn't perturb
		// the digest. The relation id is folded as a header, mirroring the
		// sparse-store and archetype headers.
		const rels = this.relationService.stores;
		for (let r = 0; r < rels.length; r++) {
			const rs = rels[r];
			if (rs.exclusive) continue; // exclusive targets already folded via their sparse field
			// Fold the relation id header even for an empty multi relation (mirrors
			// the sparse-store and archetype headers): a relation present on one
			// side but empty on the other still perturbs the digest.
			h = fnv1aStepWord(h, r);
			// Canonical source/target ordering and the empty-set skip live solely in
			// `forEachCanonicalTargetSet` — shared with
			// `snapshotRelations` and `pairsOf`, so the three can't disagree. Fold
			// the source index + target count, then each target id (full EntityID,
			// generation included — matching the exclusive sparse-field path).
			rs.forEachCanonicalTargetSet((idx, targets) => {
				h = fnv1aStepWord(h, idx);
				h = fnv1aStepWord(h, targets.length);
				for (let t = 0; t < targets.length; t++) h = fnv1aStepWord(h, targets[t]);
			});
		}
		return h >>> 0;
	}

	// =======================================================
	// Archetype graph
	// =======================================================

	private archGet(id: ArchetypeID): Archetype {
		return this.archGraph.get(id);
	}

	/** Look up the `EntityID` at `row` in archetype `archetype_id`. Used
	 * by a WASM system to resolve an
	 * `EntityID` from an event-ring payload — Zig writes
	 * `(archId, row, …)` to the event ring,
	 * and TS bridges it back through `ctx.emit(...)` via this method.
	 *
	 * Throws `ECSError` if `archetype_id` is out of range or `row` is
	 * past the archetype's live row count — these would indicate a
	 * ring-payload corruption or a stale row index (extend / grow
	 * happened mid-tick), both of which are bugs the parity test would
	 * surface. */
	public entityIdAtRow(archetypeId: number, row: number): EntityID {
		const arch = this.archGet(archetypeId as ArchetypeID);
		if (DEV) {
			if (row < 0 || row >= arch.entityCount) {
				throw new ECSError(
					ECS_ERROR.ARCHETYPE_NOT_FOUND,
					`entity_id_at_row: archetype ${archetypeId} has ${arch.entityCount} rows, requested row ${row}`
				);
			}
		}
		return arch.entityIds[row] as EntityID;
	}

	/** Find or create an archetype for the given component mask — see
	 * `ArchetypeGraph.getOrCreateFromMask`. */
	private archGetOrCreateFromMask(mask: BitSet): ArchetypeID {
		return this.archGraph.getOrCreateFromMask(mask);
	}

	/** Bulk variant of `archGetOrCreateFromMask` — one `extendColumnStore`
	 * call for the whole batch (the prewarm pass). See
	 * `ArchetypeGraph.createManyFromMasks`. */
	public archCreateManyFromMasks(masks: readonly BitSet[]): ArchetypeID[] {
		return this.archGraph.createManyFromMasks(masks);
	}

	/** Snapshot every existing archetype's SAB rows, call `extendColumnStore`
	 * once with `newSpecs`, then refresh every pre-existing SAB-backed
	 * Archetype's TypedArray views. The single `existing` snapshot is the
	 * key win in the bulk variant — single-mask creation rebuilds it per
	 * call (i.e. N times for N new archetypes). */
	private _archExtendStoreWithNewSpecs(newSpecs: ArchetypeSpec[]): void {
		const existing: ArchetypeGrowSpec[] = [];
		const archs = this.archGraph.archetypes;
		for (let i = 0; i < archs.length; i++) {
			const a = archs[i];
			const storeArch = this._columnStore.archetypes.get(a.id as number);
			if (storeArch === undefined) continue;
			existing.push({
				archetypeId: a.id as number,
				// `newRowCapacity` is required by the shared `ArchetypeGrowSpec`
				// shape but is ignored by `extendColumnStore` (extend never resizes
				// existing rows; that's `growColumnStore`'s job). Carry the
				// current capacity for clarity.
				newRowCapacity: storeArch.rowCapacity,
				// Tag-only archetypes' `length` lives on the heap-backed
				// `_entityIds` and is allowed to exceed the SAB descriptor's
				// `row_capacity` (which is meaningless when there are no
				// columns). Report row_count=0 for them so extendColumnStore
				// doesn't reject the spec on a vacuous bound check.
				rowCount: a.hasColumns ? a.length : 0
			});
		}
		// Like the grow path: a cap hit here stays fatal, it's just
		// re-thrown with the declared sizing intent attached.
		let extendResult;
		try {
			extendResult = extendColumnStore(
				this._columnStore,
				{ newArchetypes: newSpecs, existing },
				this._bufferAllocator
			);
		} catch (cause) {
			if (cause instanceof StoreCapExceededError) throw this._capExceededError(cause);
			throw cause;
		}
		this._columnStore = extendResult.store;
		// In-place fast path, generalised to the wasm allocator:
		// when extendColumnStore took the in-place branch (isInPlace
		// allocator + descriptor headroom), every existing archetype's
		// TypedArray column views are still valid — `isInPlace`
		// guarantees views built before the allocator call still operate
		// on the same memory after, even if the SAB ref itself changed
		// (wasmMemoryAllocator's post-grow ref points at the same
		// underlying linear memory). `viewsPreserved` is the explicit
		// signal; relying on `buffer` instance equality misses the
		// wasm-memory fast path.
		if (!extendResult.viewsPreserved) {
			for (let i = 0; i < archs.length; i++) {
				if (archs[i].isBufferBacked) archs[i].refreshViews(this._columnStore);
			}
		}
		this._handleBufferResized();
	}

	/** Materialise the `Archetype` object for a freshly-minted graph node —
	 * binds the graph's topology to THIS store's column backing and grow
	 * handler (`ArchetypeGraphHost.materialize`). Store-owned so the graph
	 * never touches `_columnStore`. */
	private _materializeArchetype(
		id: ArchetypeID,
		ownedMask: BitSet,
		layouts: ArchetypeColumnLayout[]
	): Archetype {
		const archetype = Archetype.fromColumnStore(
			id,
			ownedMask,
			layouts,
			this._columnStore,
			id as number
		);
		archetype.growHandler = this._growHandler;
		return archetype;
	}

	/** Push a newly-installed archetype into every registered query whose masks
	 * it satisfies (`ArchetypeGraphHost.fanIntoQueries`; the query registry
	 * stays on Store). No epoch bump — see the note in `ArchetypeGraph.install`. */
	private _fanIntoQueries(archetype: Archetype): void {
		const rqs = this.registeredQueries;
		for (let i = 0; i < rqs.length; i++) {
			const rq = rqs[i];
			if (
				archetype.matches(rq.includeMask) &&
				(!rq.excludeMask || !archetype.mask.overlaps(rq.excludeMask)) &&
				(!rq.anyOfMask || archetype.mask.overlaps(rq.anyOfMask))
			) {
				rq.result.push(archetype);
			}
		}
	}

	/** Resolve "add component_id to archetype_id" → target ArchetypeID (edge-cached). */
	private archResolveAdd(archetypeId: ArchetypeID, componentId: ComponentID): ArchetypeID {
		return this.archGraph.resolveAdd(archetypeId, componentId);
	}

	/** Resolve "remove component_id from archetype_id" → target ArchetypeID (edge-cached). */
	private archResolveRemove(archetypeId: ArchetypeID, componentId: ComponentID): ArchetypeID {
		return this.archGraph.resolveRemove(archetypeId, componentId);
	}

	// =======================================================
	// Entity lifecycle
	// =======================================================

	public createEntity(): EntityID {
		const id = this.entityAllocator.alloc();
		const index = this.entityAllocator.lastIndex;

		// New entities start in the empty archetype with no row assignment
		this.entityArchetype[index] = this.emptyArchetypeId;
		this.entityRow[index] = UNASSIGNED;

		return id;
	}

	// =======================================================
	// Template / direct-spawn
	// =======================================================
	//
	// A template resolves a component set + default field values to a target
	// archetype ONCE, at registration. `spawn`/`spawnMany` then bump-allocate
	// the entity straight into that archetype — no empty-archetype detour, no
	// `moveEntityFrom` column copy. The default values are pre-flattened into
	// one array in `_flatColumns` order so the append writes them in a single
	// pass (`addEntityWithValues`), skipping the zero-fill-then-overwrite of
	// the `addComponent` path.

	/** Allocate an entity slot WITHOUT placing it in the empty archetype, for
	 * the template spawn paths. Returns the packed `EntityID`; the slot index
	 * is left in `entityAllocator.lastIndex`. Skips the empty-archetype
	 * membership write `createEntity` performs (the caller installs the real
	 * archetype + row). This *commits* the slot (bumps counts, stamps the
	 * generation so `isAlive` is already true), so the caller MUST have
	 * reserved the column capacity for the row first
	 * (`Archetype.ensureRowCapacity`) — otherwise a cap throw from the
	 * subsequent append leaves the slot phantom-alive. */
	private _allocEntity(): EntityID {
		return this.entityAllocator.alloc();
	}

	/** Pre-check that `count` fresh entity slots can be allocated without
	 * exhausting the entity-index space, so `spawnMany` commits all-or-nothing.
	 * `_allocEntity`'s own per-call high-water guard would otherwise
	 * throw `EID_MAX_INDEX_OVERFLOW` partway through the alloc loop, leaving the
	 * slots it already committed phantom-alive. Free-list reuse covers the first
	 * `entityFreeIndices.length` slots; only the remainder draws down the
	 * high-water headroom. */
	private _ensureEntityIndexCapacity(count: number): void {
		this.entityAllocator.ensureCapacity(count);
	}

	/** Resolve a template: compute the target archetype (creating it if absent —
	 * fits the prewarm model), pre-flatten default field values into
	 * `_flatColumns` order, and build the override index (field name → flat
	 * column index; `TEMPLATE_OVERRIDE_AMBIGUOUS` for a name shared by more than
	 * one component, which a flat override cannot target). */
	public resolveTemplate(entries: readonly TemplateEntryData[]): Template {
		const mask = new BitSet();
		for (let i = 0; i < entries.length; i++) mask.set(entries[i].def.id);
		const archetypeId = this.archGetOrCreateFromMask(mask);
		const arch = this.archGet(archetypeId);

		const flatValues = new Array<number>(arch._flatColumns.length).fill(0);
		const overrideIndex = new Map<string, number>();
		const defs: ComponentDef[] = new Array(entries.length);

		for (let i = 0; i < entries.length; i++) {
			defs[i] = entries[i].def;
			const cid = entries[i].def.id;
			const meta = this.componentMetas[cid as number];
			if (meta === undefined) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`template: component ${cid as number} is not registered`
				);
			}
			const vals: Record<string, number | undefined> = entries[i].values ?? EMPTY_VALUES;
			const base = arch._colOffset[cid as number];
			for (let j = 0; j < meta.fieldNames.length; j++) {
				const name = meta.fieldNames[j];
				flatValues[base + j] = vals[name] ?? 0;
				// A field name owned by >1 component is ambiguous for a flat
				// override — mark it so an override on it throws (dev) instead of
				// silently writing the wrong column.
				overrideIndex.set(name, overrideIndex.has(name) ? TEMPLATE_OVERRIDE_AMBIGUOUS : base + j);
			}
		}

		return { archetypeId, flatValues, overrideIndex, defs };
	}

	/** Resolve an override key to its flat column index, with the DEV guards
	 * for unknown and ambiguous field names; `-1` means skip (the production
	 * fallback where DEV would have thrown). */
	private _resolveOverrideColumn(p: Template, key: string): number {
		const idx = p.overrideIndex.get(key);
		if (idx === undefined) {
			if (DEV) {
				throw new ECSError(
					ECS_ERROR.FIELD_NOT_REGISTERED,
					`template override: no field "${key}" in this template`
				);
			}
			return -1;
		}
		if (idx === TEMPLATE_OVERRIDE_AMBIGUOUS) {
			if (DEV) {
				throw new ECSError(
					ECS_ERROR.FIELD_NOT_REGISTERED,
					`template override: field "${key}" is ambiguous (owned by more than one component in this template); set it via the template defaults instead of a flat override`
				);
			}
			return -1;
		}
		return idx;
	}

	/** Apply per-instance overrides to the freshly-spawned row. Each key is a
	 * field name resolved through the template's override index. */
	private _applyOverrides(
		arch: Archetype,
		row: number,
		p: Template,
		overrides: Record<string, number | undefined>
	): void {
		const cols = arch._flatColumns;
		for (const key in overrides) {
			// An explicitly-undefined optional override means "keep the template
			// default" — skip it rather than writing NaN into the column.
			if (overrides[key] === undefined) continue;
			const idx = this._resolveOverrideColumn(p, key);
			if (idx >= 0) cols[idx].buf[row] = overrides[key];
		}
	}

	/** Bulk variant of `_applyOverrides`: one `fill` per overridden column
	 * across the contiguous rows `[start, start + count)`. */
	private _applyOverridesRange(
		arch: Archetype,
		start: number,
		count: number,
		p: Template,
		overrides: Record<string, number | undefined>
	): void {
		const cols = arch._flatColumns;
		for (const key in overrides) {
			if (overrides[key] === undefined) continue;
			const idx = this._resolveOverrideColumn(p, key);
			if (idx >= 0) cols[idx].buf.fill(overrides[key], start, start + count);
		}
	}

	/** Spawn one entity directly into the template's archetype (zero archetype
	 * transitions). Writes the template defaults in a single append pass, then
	 * applies any per-instance overrides. */
	public spawn(p: Template, overrides?: Record<string, number | undefined>): EntityID {
		const arch = this.archGraph.archetypes[p.archetypeId as number];
		// Fail-closed: reserve the target's column capacity for the new row
		// BEFORE committing the entity slot. A SAB-cap grow throws here, while the
		// world is still untouched — so there is no phantom-alive slot left behind
		// (slot committed, but `entityArchetype`/`entityRow` never written, and
		// `entityCount` over-counted). Mirrors the `addComponent` path, which
		// grows before the row write. No-op for the empty/tag archetype.
		if (arch.materializesRows) arch.ensureRowCapacity(1);
		const id = this._allocEntity();
		const idx = this.entityAllocator.lastIndex;
		// Empty template (no components): the spawned entity is component-less, so
		// it stays unplaced (row UNASSIGNED) in the rowless empty archetype — the
		// same canonical form as `createEntity`. No fields ⇒ no overrides apply.
		if (!arch.materializesRows) {
			this.entityArchetype[idx] = p.archetypeId as number;
			this.entityRow[idx] = UNASSIGNED;
			return id;
		}
		const pre = arch.length;
		const preE = arch.enabledCount;
		const row = arch.addEntityWithValues(id, p.flatValues, this._tick, this.entityRow);
		if (overrides !== undefined) this._applyOverrides(arch, row, p, overrides);
		this.entityArchetype[idx] = p.archetypeId as number;
		this.entityRow[idx] = row;
		this._onArchGrow(arch, pre, preE);
		return id;
	}

	/** Bulk-spawn `count` identical entities into the template's archetype. The
	 * field writes are O(columns) — one `TypedArray.fill` per column via
	 * `addEntitiesWithValues` — not O(count×columns). Returns the new ids in
	 * spawn order. */
	public spawnMany(
		p: Template,
		count: number,
		overrides?: Record<string, number | undefined>
	): EntityID[] {
		// Guard BEFORE `new Array(count)`: a negative count makes the allocation
		// throw `RangeError('Invalid array length')`, so the `count <= 0` guard was
		// dead for negatives.
		if (count <= 0) return [];
		const arch = this.archGraph.archetypes[p.archetypeId as number];
		// Fail-closed + atomic: reserve BOTH the entity-index headroom and
		// the target's column capacity for all `count` rows BEFORE committing any
		// slot. Either pre-check throws with the world untouched (no partial
		// spawn), or neither the commit loop nor the append below can hit a cap —
		// so `spawnMany` is all-or-nothing, never a partial / phantom-alive batch.
		this._ensureEntityIndexCapacity(count);
		arch.ensureRowCapacity(count);
		const out: EntityID[] = new Array(count);
		const ids = new Uint32Array(count);
		for (let i = 0; i < count; i++) {
			const id = this._allocEntity();
			ids[i] = id as number;
			out[i] = id;
		}
		const entArch = this.entityArchetype;
		const entRow = this.entityRow;
		// Empty template: all spawned entities are component-less and stay unplaced
		// in the rowless empty archetype (see `spawn`).
		if (!arch.materializesRows) {
			for (let i = 0; i < count; i++) {
				const eIdx = getEntityIndex(out[i]);
				entArch[eIdx] = p.archetypeId as number;
				entRow[eIdx] = UNASSIGNED;
			}
			return out;
		}
		const pre = arch.length;
		const preE = arch.enabledCount;
		// Common case — no disabled rows in the target: one bulk append, rows land
		// contiguously at [start, start+count). Rare case — the target already holds
		// disabled rows: spawn one at a time so each enabled row is placed in front
		// of the disabled tail (`addEntityWithValues` → `_placeTail`).
		if (arch.disabledCount > 0) {
			for (let i = 0; i < count; i++) {
				const row = arch.addEntityWithValues(out[i], p.flatValues, this._tick, entRow);
				const eIdx = getEntityIndex(out[i]);
				entArch[eIdx] = p.archetypeId as number;
				entRow[eIdx] = row;
				if (overrides !== undefined) this._applyOverrides(arch, row, p, overrides);
			}
			this._onArchGrow(arch, pre, preE);
			return out;
		}
		const start = arch.addEntitiesWithValues(ids, count, p.flatValues, this._tick);
		for (let i = 0; i < count; i++) {
			const eIdx = getEntityIndex(out[i]);
			entArch[eIdx] = p.archetypeId as number;
			entRow[eIdx] = start + i;
		}
		if (overrides !== undefined) this._applyOverridesRange(arch, start, count, p, overrides);
		this._onArchGrow(arch, pre, preE);
		return out;
	}

	/** Immediately destroy an entity, removing it from its archetype.
	 *
	 * With no `delete`/`clear` target-cleanup policy registered (the common
	 * case) this tears the one entity down and returns — no allocation. When a
	 * policy is in play, a `delete`-target's sources are appended to a local
	 * work-list this method then drains in the same iterative pass:
	 * the `work.length` re-read drives chains and trees out without recursion, so
	 * depth is bounded by entity count, not tree depth. This mirrors the deferred
	 * `flushDestroyed` buffer mechanism — both paths are iterative and reach the
	 * identical end state; the only difference is the shared `pendingDestroy`
	 * buffer there vs. a local work-list here. `isAlive` dedups a source reached
	 * twice (diamonds) and terminates cycles, exactly as the generation guard does
	 * in the deferred loop. */
	public destroyEntity(id: EntityID): void {
		if (!this.isAlive(id)) {
			if (DEV) throw entityNotAliveError("destroyEntity", id);
			return;
		}

		// No target-cleanup policy → no cascade can ever form, so skip the
		// work-list allocation and tear the single entity down directly.
		if (!this.relationService.hasTargetCleanup) {
			this._destroyOne(id, null);
			return;
		}

		// `delete`-policy cascade: `_destroyOne` appends each dead
		// target's sources to `work`; the `work.length` re-read drains them in
		// this same loop. `isAlive` guards already-dead sources (a diamond or
		// cycle reaching the same entity twice), which terminates the walk.
		const work: EntityID[] = [id];
		for (let i = 0; i < work.length; i++) {
			const next = work[i];
			if (this.isAlive(next)) this._destroyOne(next, work);
		}
	}

	/** Tear a single entity out of its archetype, relation, and sparse stores,
	 * then recycle (or retire) its slot. Shared by both immediate-destroy entry
	 * points (the fast no-cascade path and the work-list driver in
	 * `destroyEntity`). When `cascade` is non-null, a `delete`-policy target's
	 * surviving sources are appended to it for the driver to drain;
	 * `null` skips that collection for callers that cannot cascade. The caller
	 * must have already confirmed `id` is alive. */
	private _destroyOne(id: EntityID, cascade: EntityID[] | null): void {
		const index = getEntityIndex(id);
		const row = this.entityRow[index];

		if (row !== UNASSIGNED) {
			const arch = this.archGet(this.entityArchetype[index] as ArchetypeID);
			const preLen = arch.length;
			// Partition-aware swap-remove: keeps the enabled prefix contiguous
			// and owns its own entityRow updates for any relocated rows.
			arch.removeRow(row, this.entityRow);
			// Dirty bookkeeping: previously this path
			// only flagged row counts, leaving query caches stale if the entity
			// was the last in its archetype. Pure shrink — no enabled-crossing test.
			this._onArchLenChange(arch, preLen);
		}

		this.entityArchetype[index] = UNASSIGNED;
		this.entityRow[index] = UNASSIGNED;

		// Relations ride the sparse store; purge the entity's source role first
		// (it reads the exclusive target field, which `_purgeSparse` clears).
		// Then apply each relation's target-role cleanup policy: `clear`
		// drops surviving sources' links in place; `delete` appends them to
		// `cascade` for the driver to destroy through this same path.
		if (this.relationService.count > 0) {
			this.relationService.purgeSource(id);
			if (cascade !== null) this.relationService.cleanupTarget(id, cascade);
		}
		// Out-of-identity sparse data is keyed by entity index, so it's untouched
		// by the archetype swap-remove above — purge it explicitly so a recycled
		// slot can't inherit stale sparse components.
		if (this.sparseStores.length > 0) this._purgeSparse(index);
		// Per-entity onSet dirty bits are keyed by index too — clear so a recycled
		// slot can be marked afresh. Gated so the no-onSet path is untouched.
		if (this._anyDirtyTracked) this._clearDirtyForIndex(index);

		// Generation bump / RETIRED_GENERATION tombstone / free-list push —
		// see `EntityAllocator.recycle`.
		this.entityAllocator.recycle(index, getEntityGeneration(id));
	}

	/**
	 * Liveness check, **fail-closed** against forged / retired / out-of-bounds
	 * handles. For a general-purpose engine that may receive a handle from
	 * serialization, IPC, or any untrusted caller, three malformed inputs must read
	 * dead rather than alias a slot:
	 *   - **Out of range** — an `id` outside the 31-bit packed space (`< 0` or
	 *     `> MAX_ENTITY_ID`). Without this, the 20-bit index mask below silently
	 *     folds garbage high bits onto a valid slot. (Same bound the snapshot /
	 *     postMessage decode applies.)
	 *   - **Tombstone generation** — a handle carrying `RETIRED_GENERATION`, which
	 *     the allocator stamps into a retired slot and never issues to a live
	 *     entity, would otherwise match a retired slot's parked generation and read
	 *     alive (the ABA tombstone, previously documented as a known gap).
	 * Both guards are comparisons predicted not-taken on the live path, so a
	 * well-formed handle pays two branches and nothing else.
	 */
	public isAlive(id: EntityID): boolean {
		return this._liveIndex(id) >= 0;
	}

	/**
	 * Liveness and the packed index in one result: the entity index if `id` is
	 * live, else `-1`. Same three fail-closed guards as `isAlive` (documented
	 * above), and the sole implementation of them — `isAlive` is a comparison on
	 * top of this.
	 *
	 * Why it returns the index instead of a boolean: every by-id caller needs
	 * BOTH answers, and the pair used to cost two derivations of the same index.
	 * `hasComponent` called `isAlive(id)` — which computed `getEntityIndex(id)`
	 * internally — and then computed `getEntityIndex(id)` again to reach
	 * `entityArchetype`. The generational check has already touched the index; a
	 * caller that is about to index a parallel array with it should be handed the
	 * one that was computed, not re-derive it. The generations read is inlined
	 * here for the same reason, rather than delegated to
	 * `entityAllocator.isAliveIndex` — which stays as the index-domain entry point
	 * for callers that already hold an index.
	 *
	 * **This gives much less than it appears to give.** The estimate for this
	 * change was a large decrease. The measurement shows that `has` and `isAlive`
	 * are only a little faster. The decrease is real, but it is much smaller than
	 * the estimate. The work that we removed was truly not necessary. But V8
	 * already made both one-line functions inline, and it already removed most of
	 * the duplicated calculation. Therefore "the work is plainly not necessary" is
	 * not an argument about performance for a JIT compiler. This note stops the
	 * next reader from making the same estimate again.
	 */
	private _liveIndex(id: EntityID): number {
		const raw = id as number;
		if (raw < 0 || raw > MAX_ENTITY_ID) return -1;
		const generation = raw >> INDEX_BITS;
		if (generation === RETIRED_GENERATION) return -1;
		const index = raw & INDEX_MASK;
		const alloc = this.entityAllocator;
		if (index >= alloc.highWater || alloc.generations[index] !== generation) return -1;
		return index;
	}

	public get entityCount(): number {
		return this.entityAllocator.aliveCount;
	}

	/** An archetype's row count moved from `preLen` to its current
	 * `arch.length` on a **shrink** (rows removed: the source of a transition, a
	 * destroy, a batch-source drain). Always marks SAB row counts dirty
	 * (the descriptor walk just needs "something moved"); bumps the query-dirty
	 * epoch only on a `length` 0/non-zero crossing, the only case where
	 * `Query._nonEmptyArchetypes` can change on a shrink. Mutations that
	 * move row counts within the same side (6→5) leave the non-empty set unchanged
	 * and skip the bump.
	 *
	 * A shrink does **not** need the `enabledCount` crossing test: the
	 * only enabled-count move it can make is 1→0 (the last enabled row leaves an
	 * archetype that keeps disabled rows), which leaves the archetype in a default
	 * query's non-empty list as a harmless stale *inclusion* — `count`/`forEach`
	 * bound on `enabledCount` (now 0) iterate it zero times. Only a **grow** into
	 * an all-disabled archetype can stale-*exclude* a live row, so the enabled
	 * crossing lives in `_onArchGrow`, off this path.
	 *
	 * **Inlining-sensitive — keep the body tiny.** This function is called
	 * once or twice per immediate-mode `addComponent` / `removeComponent` and the
	 * mutation hot path depends on it being inlined at every call site.
	 * An earlier change added an `if (registeredQueries.length === 0) return;`
	 * gate to skip the bump for no-query workloads. The bench showed a large
	 * regression of the mutation churn loop, because the extra statement pushed
	 * the function past V8's per-call inlining budget. The gate is no longer in
	 * the code. Do a bench run before you merge a change here. Code review
	 * alone is not sufficient. */
	private _onArchLenChange(arch: Archetype, preLen: number): void {
		this._rowCountsDirty = true;
		if ((preLen === 0) !== (arch.length === 0)) this._queryDirtyEpoch++;
	}

	/** An archetype **grew** — rows were appended (the target of a transition, a
	 * spawn, a batch-target fill). Like `_onArchLenChange` it marks row counts
	 * dirty and bumps the query-dirty epoch on a `length` 0/non-zero crossing
	 * (`includeDisabled` membership), but it *also* bumps on an `enabledCount`
	 * 0→1 crossing. The non-empty filter is field-split: a default
	 * query keeps archetypes with `enabledCount > 0`. An enabled row appended to
	 * an archetype that is non-empty but all-disabled (`length > 0,
	 * enabledCount == 0`) crosses `enabledCount` 0→1 without touching `length`,
	 * so the `preLen` test alone (the earlier proxy, valid only while
	 * `enabledCount === length`) misses it and a cached default query keeps a stale
	 * `_nonEmpty` list. Only grows can do this, so only grow sites carry the test.
	 *
	 * **Precondition: ≥1 row was appended** (every caller adds at least one row),
	 * so `arch.length > 0` afterward — which is why the crossings simplify and the
	 * body stays inlinable (the inlining caveat on `_onArchLenChange` applies
	 * here too; this is bench-verified). The general
	 * `(pre === 0) !== (post === 0)` boundary test collapses given the post side:
	 *   - `length`: post > 0 always ⇒ a crossing iff `preLen === 0`.
	 *   - `enabledCount`: non-decreasing on a grow ⇒ a 0-crossing iff it was 0
	 *     before and is non-zero now (`preEnabled === 0 && enabledCount !== 0`);
	 *     a disabled-row append leaves it 0 and correctly skips. The `enabledCount`
	 *     read is short-circuited away on the hot path (`preLen` or `preEnabled`
	 *     non-zero), so a no-disabled workload pays only two scalar compares. */
	private _onArchGrow(arch: Archetype, preLen: number, preEnabled: number): void {
		this._rowCountsDirty = true;
		if (preLen === 0 || (preEnabled === 0 && arch.enabledCount !== 0)) this._queryDirtyEpoch++;
	}

	/** Dirty bookkeeping for an enable/disable toggle. `length` is
	 * unchanged (no row added/removed) but `enabled_count` moved, so: republish
	 * row counts (the descriptor's `enabled_count` changed, so the WASM sim and
	 * snapshot see the new partition), and bump the query epoch only when the
	 * *enabled* count crossed 0 — the boundary at which an archetype enters/leaves
	 * a query's non-empty set (`Query._nonEmpty` filters on `entityCount`, which
	 * is now `enabled_count`). */
	private _onArchEnabledChange(arch: Archetype, preEnabled: number): void {
		this._rowCountsDirty = true;
		if ((preEnabled === 0) !== (arch.enabledCount === 0)) this._queryDirtyEpoch++;
	}

	// =======================================================
	// Entity enable / disable
	// =======================================================
	//
	// A disabled entity keeps its components, relations, sparse data, and stable
	// `EntityID` — it is just moved to the disabled tail of its archetype so the
	// default-iteration bound (`Archetype.entityCount` = `enabled_count`) skips
	// it. No archetype transition, no data loss. Host-side calls are immediate;
	// the system-side mirror buffers (see `*_deferred`) because the row swap would
	// corrupt an in-flight `forEach` over that archetype.

	/** Immediately disable an entity (idempotent). The entity must hold at least
	 * one component — a component-less entity occupies no archetype row, so it
	 * cannot be partitioned (a `DEV` error; prod no-op). */
	public disableEntity(id: EntityID): void {
		if (!this.isAlive(id)) {
			if (DEV) throw entityNotAliveError("disableEntity", id);
			return;
		}
		const index = getEntityIndex(id);
		const row = this.entityRow[index];
		if (row === UNASSIGNED) {
			if (DEV)
				throw new ECSError(
					ECS_ERROR.ENTITY_NOT_ALIVE,
					"cannot disable a component-less entity: it occupies no archetype row; add a component first"
				);
			return;
		}
		const arch = this.archGet(this.entityArchetype[index] as ArchetypeID);
		if (row >= arch.enabledCount) return; // already disabled
		const preEnabled = arch.enabledCount;
		arch.disableRow(row, this.entityRow);
		this._onArchEnabledChange(arch, preEnabled);
	}

	/** Immediately enable an entity (idempotent). */
	public enableEntity(id: EntityID): void {
		if (!this.isAlive(id)) {
			if (DEV) throw entityNotAliveError("enableEntity", id);
			return;
		}
		const index = getEntityIndex(id);
		const row = this.entityRow[index];
		if (row === UNASSIGNED) return; // component-less entities are always enabled
		const arch = this.archGet(this.entityArchetype[index] as ArchetypeID);
		if (row < arch.enabledCount) return; // already enabled
		const preEnabled = arch.enabledCount;
		arch.enableRow(row, this.entityRow);
		this._onArchEnabledChange(arch, preEnabled);
	}

	/** Whether `id` is currently disabled. A component-less entity is never
	 * disabled (it has no row to partition). */
	public isDisabled(id: EntityID): boolean {
		if (!this.isAlive(id)) {
			if (DEV) throw entityNotAliveError("isDisabled", id);
			return false;
		}
		const index = getEntityIndex(id);
		const row = this.entityRow[index];
		if (row === UNASSIGNED) return false;
		const arch = this.archGet(this.entityArchetype[index] as ArchetypeID);
		return row >= arch.enabledCount;
	}

	/** 0-crossing detection for the per-entity flush paths (`_flushAdds`,
	 * `_flushRemoves`) without per-entity Map traffic — the same cost the
	 * destroy drain also avoids. Each touched archetype is stamped with the
	 * current flush epoch (`Archetype._flushSeenEpoch`), its pre-length and
	 * pre-enabled-count recorded on first sight (`_flushPreLen` /
	 * `_flushPreEnabled`), and pushed onto this scratch list;
	 * `_settleFlushDirty` walks the list once after the loop. The field
	 * accesses per entity replace a `Map.has` + `Map.set` hash probe pair. The
	 * epoch is bumped at settle so the next flush re-records. */
	private _flushEpoch = 0;
	private readonly _flushTouched: Archetype[] = [];

	/** Resolve dirty flags for a per-entity batch flush from the captured
	 * pre-counts. Marks row counts dirty if any archetype was touched; bumps
	 * the query epoch once if any touched archetype crossed the 0 boundary on
	 * *either* `length` (includeDisabled membership) or `enabledCount`
	 * (default-query membership) — the deferred analog of the immediate
	 * `_onArchLenChange` two-field check. A single bump is sufficient
	 * (queries only need to know "something changed"). Clears the touched list
	 * and advances the flush epoch on exit. */
	private _settleFlushDirty(): void {
		const touched = this._flushTouched;
		if (touched.length === 0) return;
		this._rowCountsDirty = true;
		let crossed = false;
		for (let i = 0; i < touched.length; i++) {
			const arch = touched[i];
			if (
				(arch._flushPreLen === 0) !== (arch.length === 0) ||
				(arch._flushPreEnabled === 0) !== (arch.enabledCount === 0)
			)
				crossed = true;
		}
		if (crossed) this._queryDirtyEpoch++;
		touched.length = 0;
		this._flushEpoch++;
	}

	// =======================================================
	// Deferred destruction
	// =======================================================

	public destroyEntityDeferred(id: EntityID): void {
		if (DEV && !this.isAlive(id)) throw entityNotAliveError("destroyEntityDeferred", id);
		this._deferred.queueDestroy(id);
	}

	/** Buffer an enable/disable toggle for the phase flush. The row swap a
	 * toggle performs would corrupt a `forEach` over that archetype if applied
	 * mid-system, so it is deferred like add/remove. */
	public disableEntityDeferred(id: EntityID): void {
		if (DEV && !this.isAlive(id)) throw entityNotAliveError("disableEntityDeferred", id);
		this._deferred.queueToggle(id, true);
	}

	public enableEntityDeferred(id: EntityID): void {
		if (DEV && !this.isAlive(id)) throw entityNotAliveError("enableEntityDeferred", id);
		this._deferred.queueToggle(id, false);
	}

	/** Drain buffered enable/disable toggles, applying each in operation order via
	 * the immediate path (which is idempotent and updates dirty flags). Called at
	 * the flush boundary after structural adds/removes settle, so a toggle sees the
	 * entity's final archetype placement for the tick.
	 *
	 * When an onDisable/onEnable observer is registered (`_toggleObserverCount >
	 * 0`) this also collects effective toggle events into `_obsEvents` for
	 * the dispatch hook, collapsed to one event per *net* transition across the
	 * drain (see `_toggleInitial`). The no-observer path is byte-for-byte the
	 * earlier drain. */
	private _flushToggles(): void {
		const ids = this._deferred.toggleIds;
		const dis = this._deferred.toggleDisable;
		const n = ids.length;
		const collecting = this._toggleObserverCount > 0;

		if (!collecting) {
			for (let i = 0; i < n; i++) {
				const id = ids[i];
				// A stale (already-destroyed/recycled) handle is skipped — same liveness
				// guard the other flush paths use.
				if (!this.isAlive(id)) continue;
				if (dis[i]) this.disableEntity(id);
				else this.enableEntity(id);
			}
			ids.length = 0;
			dis.length = 0;
			return;
		}

		// Observed path: snapshot each distinct entity's pre-drain disabled state,
		// apply every toggle in operation order (idempotent), then emit one event per
		// NET transition. A toggle never adds/removes/destroys, so every snapshotted
		// entity is still alive at the diff (the guards are defensive).
		const init = this._toggleInitial;
		for (let i = 0; i < n; i++) {
			const id = ids[i];
			if (!this.isAlive(id)) continue;
			if (!init.has(id)) init.set(id, this.isDisabled(id));
		}
		for (let i = 0; i < n; i++) {
			const id = ids[i];
			if (!this.isAlive(id)) continue;
			if (dis[i]) this.disableEntity(id);
			else this.enableEntity(id);
		}
		ids.length = 0;
		dis.length = 0;
		for (const [id, wasDisabled] of init) {
			if (!this.isAlive(id)) continue;
			const nowDisabled = this.isDisabled(id);
			if (wasDisabled === nowDisabled) continue; // no net transition
			this._collectToggle(id, nowDisabled);
		}
		init.clear();
	}

	/** Fan one entity's net toggle transition out to an onDisable / onEnable event
	 * per carried component. Walks the entity's archetype mask through the
	 * matching pre-bound bit visitor; a component-less entity (no row) carries
	 * nothing and is skipped. */
	private _collectToggle(id: EntityID, nowDisabled: boolean): void {
		const index = getEntityIndex(id);
		if (this.entityRow[index] === UNASSIGNED) return;
		const arch = this.archGet(this.entityArchetype[index] as ArchetypeID);
		this._collectToggleEid = id as number;
		arch.mask.forEach(nowDisabled ? this._collectDisableBit : this._collectEnableBit);
	}

	public get pendingToggleCount(): number {
		return this._deferred.toggleCount;
	}

	/** Flush all buffered entity destructions in batch.
	 *
	 * When onRemove observers are registered (`_structuralObserverCount > 0`),
	 * a destroy fires onRemove for every component the entity carried — a destroy
	 * *is* a remove of the whole mask — collected here and dispatched by the
	 * `flushStructural` fixed-point loop, the only caller in that mode (it drains
	 * `pendingDestroy` each round so the trailing `ctx.flush()` call is a no-op).
	 * Same commit-then-observe discipline as `_flushRemoves`: the entity is fully
	 * freed before the callback runs, so onRemove receives the (now dead) eid as
	 * the identity of what was destroyed, not a live handle to read. The
	 * no-observer path is byte-for-byte unchanged (`collecting` gate).
	 *
	 * Re-entrancy: while the observed fixed point owns the flush, the loop
	 * drains destroys itself via `_drainDestroyed`, so a re-entrant
	 * `ctx.flush()` from a callback no-ops (the guard lives in
	 * `DeferredCommandBuffer.flushDestroyed`) — otherwise it would collect
	 * into the shared `_obsEvents` scratch mid-dispatch and corrupt it. */
	public flushDestroyed(): void {
		this._deferred.flushDestroyed();
	}

	private _drainDestroyed(): void {
		const buf = this._deferred.destroyIds;
		if (buf.length === 0) return;

		// Hot loop — hoist fields to locals for faster access
		const alloc = this.entityAllocator;
		const entArch = this.entityArchetype;
		const entRow = this.entityRow;
		const entGens = alloc.generations;
		const archs = this.archGraph.archetypes;
		const hw = alloc.highWater;

		// 0-crossing detection without per-entity Map traffic. The
		// generic settle path (the `_flushEpoch` stamps + `_settleFlushDirty`)
		// captures each touched archetype's pre-length so it can compare
		// `(pre === 0) !== (cur === 0)` afterwards — one `Map.has` per entity,
		// which profiling showed was the dominant cost of this loop.
		//
		// Destruction only *removes* rows, so a touched archetype's length can
		// only fall and the sole reachable crossing is `pre > 0 → 0`. `pre > 0`
		// is implied for any archetype we remove a row from, so "an archetype
		// emptied" ⟺ its `length` reaches 0 right after a removal — a local
		// numeric compare, no pre-length capture and no touched-set bookkeeping.
		let removedRow = false;
		let crossed = false;

		// Out-of-identity sparse data is keyed by entity index — purge it per
		// destroyed entity so a recycled slot can't inherit stale sparse
		// components. Gated so the no-sparse-storage path is untouched.
		const hasSparse = this.sparseStores.length > 0;
		// Relations layer on the sparse store; purge each destroyed entity's
		// source role *before* its sparse rows go (the exclusive purge reads the
		// target field). Gated so the no-relations path is untouched.
		const hasRelations = this.relationService.count > 0;
		// Target-role cleanup policies: `clear` drops surviving sources'
		// links in place; `delete` pushes sources back onto `buf` so this same
		// loop destroys them (the `buf.length` re-read drives the cascade — chains
		// and trees fall out, the generation guard dedups and terminates cycles).
		// Gated so no-policy worlds skip the whole reverse-index walk.
		const hasTargetCleanup = hasRelations && this.relationService.hasTargetCleanup;
		// Per-entity onSet dirty bits are keyed by index — clear on destroy
		// so a recycled slot can be marked afresh. Gated like the others.
		const hasDirty = this._anyDirtyTracked;
		// onRemove fan-out: collect an effective-remove event per observed
		// component on each dying entity. Gated so the no-observer path is
		// byte-for-byte unchanged; dispatched by `flushStructural`.
		const collecting = this._structuralObserverCount > 0;

		for (let i = 0; i < buf.length; i++) {
			const eid = buf[i];
			// Inline entity ID unpacking (avoids function call overhead in hot path)
			const idx = (eid as number) & INDEX_MASK;
			const gen = (eid as number) >> INDEX_BITS;
			// Skip if entity was already destroyed (stale generation)
			if (idx >= hw || entGens[idx] !== gen) continue;

			const row = entRow[idx];
			if (row !== UNASSIGNED) {
				const arch = archs[entArch[idx] as ArchetypeID];
				// Fan a destroy out to an onRemove per carried component.
				// Read the mask before the row goes; the event fires post-free.
				// A component-less entity (row === UNASSIGNED) carries nothing, so
				// it is correctly skipped along with this whole block.
				if (collecting) {
					this._collectDestroyEid = eid as number;
					arch.mask.forEach(this._collectDestroyRemoveBit);
				}
				// Partition-aware swap-remove — owns its entityRow updates and
				// handles tag-only archetypes via its hasColumns guard.
				arch.removeRow(row, entRow);
				removedRow = true;
				if (arch.length === 0) crossed = true;
			}

			if (hasRelations) this.relationService.purgeSource(eid);
			if (hasTargetCleanup) this.relationService.cleanupTarget(eid, buf);
			if (hasSparse) this._purgeSparse(idx);
			if (hasDirty) this._clearDirtyForIndex(idx);

			entArch[idx] = UNASSIGNED;
			entRow[idx] = UNASSIGNED;
			// Generation bump / tombstone retire / free-list push —
			// the inline block this loop carried before the extraction lives in
			// `EntityAllocator.recycle` now (monomorphic call, bench-gated).
			alloc.recycle(idx, gen);
		}

		buf.length = 0;
		// Settle dirty flags inline (mirrors `_settleFlushDirty`, but for the
		// remove-only case computed above without the pre-length Map).
		if (removedRow) {
			this._rowCountsDirty = true;
			if (crossed) this._queryDirtyEpoch++;
		}
	}

	public get pendingDestroyCount(): number {
		return this._deferred.destroyCount;
	}

	// =======================================================
	// Deferred structural changes
	// =======================================================

	public addComponentDeferred(
		entityId: EntityID,
		def: ComponentDef<Record<string, never>>
	): void;
	public addComponentDeferred<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: FieldValues<S>
	): void;
	public addComponentDeferred(
		entityId: EntityID,
		def: ComponentDef,
		values?: Record<string, number>
	): void {
		if (DEV && !this.isAlive(entityId)) throw entityNotAliveError("addComponentDeferred", entityId, this.componentLabel(def.id));
		this._deferred.queueAdd(entityId, def, values ?? EMPTY_VALUES);
	}

	public removeComponentDeferred(entityId: EntityID, def: ComponentDef): void {
		if (DEV && !this.isAlive(entityId)) throw entityNotAliveError("removeComponentDeferred", entityId, this.componentLabel(def.id));
		this._deferred.queueRemove(entityId, def);
	}

	/** Phase-boundary structural flush. The drain policy — no-observer fast
	 * path, observed fixed point (adds/removes → destroys → toggles),
	 * convergence guard, re-entrancy — lives in `DeferredCommandBuffer`
	 *; the batch appliers it drives are the `_flush*` /
	 * `_drainDestroyed` methods below. */
	public flushStructural(): void {
		this._deferred.flushStructural();
	}

	/** Batch-apply all deferred component additions. */
	private _flushAdds(): void {
		const ids = this._deferred.addIds;
		const defs = this._deferred.addDefs;
		const vals = this._deferred.addValues;
		const n = ids.length;

		const entArch = this.entityArchetype;
		const entRow = this.entityRow;
		const entGens = this.entityAllocator.generations;
		const archs = this.archGraph.archetypes;
		const metas = this.componentMetas;
		const hw = this.entityAllocator.highWater;
		const tick = this._tick;
		const epoch = this._flushEpoch;
		const touched = this._flushTouched;
		// Effective-event collection. `collecting` is a single hoisted
		// guard — false on the no-observer fast path, so the loop body is the
		// earlier flush plus one predicted-not-taken branch (measured free).
		const collecting = this._structuralObserverCount > 0;
		const ev = this._obsEvents;

		for (let i = 0; i < n; i++) {
			const eid = ids[i];
			// Inline entity ID unpacking
			const idx = (eid as number) & INDEX_MASK;
			const gen = (eid as number) >> INDEX_BITS;
			if (idx >= hw || entGens[idx] !== gen) continue;

			const srcArchId = entArch[idx] as ArchetypeID;
			const compId = defs[i].id;
			const src = archs[srcArchId];
			const meta = metas[compId as number];

			// Already has this component → overwrite field values in-place (no transition)
			if (src.mask.has(compId as number)) {
				if (meta.fieldNames.length > 0) {
					src.writeFields(entRow[idx], compId, vals[i], tick);
				}
				continue;
			}

			const tgtId = this.archResolveAdd(srcArchId, compId);
			const tgt = archs[tgtId];
			const srcRow = entRow[idx];
			const tagOnly = !tgt.hasColumns && !src.hasColumns;

			// Record pre-counts for the 0-crossing detector before
			// the move mutates either side. Both `length` and `enabledCount` are
			// snapshotted — an enabled append into an all-disabled archetype crosses
			// `enabledCount` 0→1 without touching `length`. Only first sight
			// per archetype counts — epoch-stamped on the archetype itself, not a
			// Map probe (see `_flushEpoch`).
			if (srcRow !== UNASSIGNED && src._flushSeenEpoch !== epoch) {
				src._flushSeenEpoch = epoch;
				src._flushPreLen = src.length;
				src._flushPreEnabled = src.enabledCount;
				touched.push(src);
			}
			if (tgt._flushSeenEpoch !== epoch) {
				tgt._flushSeenEpoch = epoch;
				tgt._flushPreLen = tgt.length;
				tgt._flushPreEnabled = tgt.enabledCount;
				touched.push(tgt);
			}

			let dstRow: number;

			if (srcRow !== UNASSIGNED) {
				if (tagOnly) {
					tgt.moveEntityFromTag(src, srcRow, eid, entRow);
				} else {
					const edge = src.getEdge(compId)!;
					tgt.moveEntityFrom(src, srcRow, eid, edge.addMap!, tick, entRow);
				}
				dstRow = _moveResult[0];
			} else {
				dstRow = tagOnly ? tgt.addEntityTag(eid, entRow) : tgt.addEntity(eid, entRow);
			}

			// Write the new component's field values
			if (meta.fieldNames.length > 0) {
				tgt.writeFields(dstRow, compId, vals[i], tick);
			}

			entArch[idx] = tgtId;
			entRow[idx] = dstRow;

			// Effective add committed — collect for onAdd dispatch (observers fire
			// only after the whole batch commits; see `flushStructural`).
			if (collecting && meta.obsAdd) {
				ev.addComp[ev.addLen] = compId as number;
				ev.addEid[ev.addLen] = eid as number;
				ev.addLen++;
			}
		}

		ids.length = 0;
		defs.length = 0;
		vals.length = 0;
		this._settleFlushDirty();
	}

	/** Batch-apply all deferred component removals. */
	private _flushRemoves(): void {
		const ids = this._deferred.removeIds;
		const defs = this._deferred.removeDefs;
		const n = ids.length;

		const entArch = this.entityArchetype;
		const entRow = this.entityRow;
		const entGens = this.entityAllocator.generations;
		const archs = this.archGraph.archetypes;
		const hw = this.entityAllocator.highWater;
		const tick = this._tick;
		const epoch = this._flushEpoch;
		const touched = this._flushTouched;
		const metas = this.componentMetas;
		const collecting = this._structuralObserverCount > 0;
		const ev = this._obsEvents;

		for (let i = 0; i < n; i++) {
			const eid = ids[i];
			const idx = (eid as number) & INDEX_MASK;
			const gen = (eid as number) >> INDEX_BITS;
			if (idx >= hw || entGens[idx] !== gen) continue;

			const srcArchId = entArch[idx] as ArchetypeID;
			const compId = defs[i].id;
			const src = archs[srcArchId];

			if (!src.mask.has(compId as number)) continue;

			const tgtId = this.archResolveRemove(srcArchId, compId);
			const tgt = archs[tgtId];
			const srcRow = entRow[idx];
			const tagOnly = !tgt.hasColumns && !src.hasColumns;

			// Record pre-counts for 0-crossing detection — both
			// `length` and `enabledCount`, epoch-stamped, not a Map probe (see
			// `_flushEpoch`).
			if (src._flushSeenEpoch !== epoch) {
				src._flushSeenEpoch = epoch;
				src._flushPreLen = src.length;
				src._flushPreEnabled = src.enabledCount;
				touched.push(src);
			}
			if (tgt._flushSeenEpoch !== epoch) {
				tgt._flushSeenEpoch = epoch;
				tgt._flushPreLen = tgt.length;
				tgt._flushPreEnabled = tgt.enabledCount;
				touched.push(tgt);
			}

			if (tagOnly) {
				tgt.moveEntityFromTag(src, srcRow, eid, entRow);
			} else {
				const edge = src.getEdge(compId)!;
				tgt.moveEntityFrom(src, srcRow, eid, edge.removeMap!, tick, entRow);
			}

			entArch[idx] = tgtId;
			entRow[idx] = _moveResult[0];

			// Effective remove committed — collect for onRemove dispatch. The
			// component is gone from the entity, but the eid is still live, so the
			// callback can read other components / the entity itself.
			if (collecting && metas[compId as number].obsRem) {
				ev.remComp[ev.remLen] = compId as number;
				ev.remEid[ev.remLen] = eid as number;
				ev.remLen++;
			}
		}

		ids.length = 0;
		defs.length = 0;
		this._settleFlushDirty();
	}

	public get pendingStructuralCount(): number {
		return this._deferred.structuralCount;
	}

	// =======================================================
	// Component observers
	// =======================================================
	// The `ObserverRegistry` (observer.ts, owned by ECS) drives ordering +
	// callback dispatch; the Store owns the hot-path flags, the effective-event
	// collection (in `_flushAdds`/`_flushRemoves`), the fixed-point loop
	// (`flushStructural`), and the per-row dirty list for per-entity onSet. All
	// of this is a scheduling artifact — never folded into `stateHash`/snapshot.

	/** Set the per-component observation flags from the registry's aggregate of
	 * live observers for `cid`. Maintains `_structuralObserverCount` and
	 * `_toggleObserverCount` (the fast-path gates) and lazily allocates the
	 * dirty list when per-entity onSet tracking turns on. */
	public _configureComponentObservation(
		cid: number,
		hasAdd: boolean,
		hasRem: boolean,
		hasDisable: boolean,
		hasEnable: boolean,
		trackDirty: boolean
	): void {
		const meta = this.componentMetas[cid];
		if (meta === undefined) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`observe(): component ${cid} is not registered`
			);
		}
		const wasStructural = meta.obsAdd || meta.obsRem;
		meta.obsAdd = hasAdd;
		meta.obsRem = hasRem;
		const nowStructural = hasAdd || hasRem;
		if (wasStructural && !nowStructural) this._structuralObserverCount--;
		else if (!wasStructural && nowStructural) this._structuralObserverCount++;

		const wasToggle = meta.obsDisable || meta.obsEnable;
		meta.obsDisable = hasDisable;
		meta.obsEnable = hasEnable;
		const nowToggle = hasDisable || hasEnable;
		if (wasToggle && !nowToggle) this._toggleObserverCount--;
		else if (!wasToggle && nowToggle) this._toggleObserverCount++;

		if (trackDirty && !meta.trackDirty) {
			meta.trackDirty = true;
			if (this._dirtyLists[cid] === undefined) {
				this._dirtyLists[cid] = [];
				this._dirtyMarks[cid] = new Uint8Array(Math.max(1, this.entityAllocator.generations.length));
			}
			this._dirtyTrackedCids.push(cid);
			this._anyDirtyTracked = true;
		} else if (!trackDirty && meta.trackDirty) {
			meta.trackDirty = false;
			const at = this._dirtyTrackedCids.indexOf(cid);
			if (at >= 0) this._dirtyTrackedCids.splice(at, 1);
			this._anyDirtyTracked = this._dirtyTrackedCids.length > 0;
			// Reset any pending dirty state (buffers stay allocated for re-enable).
			const list = this._dirtyLists[cid];
			const marks = this._dirtyMarks[cid];
			if (list !== undefined && marks !== undefined) {
				for (let k = 0; k < list.length; k++) marks[(list[k] as number) & INDEX_MASK] = 0;
				list.length = 0;
			}
		}
	}

	/** Record a per-entity onSet "changed" event for the entity. Called from the
	 * field-write path (`SystemContext.setField` / `markChanged`) and gated by
	 * the caller on `_anyDirtyTracked`. Appends to the dirty list only if the
	 * dedup bit was clear (the dirty list + dedup-bit mechanism). */
	public _noteSet(def: ComponentHandle, eid: EntityID): void {
		const cid = def.id;
		const meta = this.componentMetas[cid];
		if (meta === undefined || !meta.trackDirty) return;
		const idx = (eid as number) & INDEX_MASK;
		let marks = this._dirtyMarks[cid]!;
		if (idx >= marks.length) marks = this._growDirtyMarks(cid, idx);
		if (marks[idx] !== 0) return;
		marks[idx] = 1;
		this._dirtyLists[cid]!.push(eid);
	}

	private _growDirtyMarks(cid: number, idx: number): Uint8Array {
		const old = this._dirtyMarks[cid]!;
		let cap = Math.max(1, old.length);
		while (cap <= idx) cap *= 2;
		const grown = new Uint8Array(cap);
		grown.set(old);
		this._dirtyMarks[cid] = grown;
		return grown;
	}

	/** Detach and return the dirty-row list for `cid`, clearing its dedup bits and
	 * leaving the store with a fresh empty list (so re-dirties during the drain
	 * accumulate for the NEXT tick, not this one). Returns a shared empty array
	 * when nothing is dirty. Caller owns the returned array. */
	public _takeDirty(cid: number): EntityID[] {
		const list = this._dirtyLists[cid];
		if (list === undefined || list.length === 0) return EMPTY_DIRTY;
		this._dirtyLists[cid] = [];
		const marks = this._dirtyMarks[cid]!;
		for (let i = 0; i < list.length; i++) marks[(list[i] as number) & INDEX_MASK] = 0;
		return list;
	}

	/** Clear any dirty dedup bits for a freed entity index across every tracked
	 * component, so a recycled slot at the same index can be marked afresh. Gated
	 * by `_anyDirtyTracked` at the destroy call sites. */
	private _clearDirtyForIndex(idx: number): void {
		const cids = this._dirtyTrackedCids;
		for (let i = 0; i < cids.length; i++) {
			const marks = this._dirtyMarks[cids[i]];
			if (marks !== undefined && idx < marks.length) marks[idx] = 0;
		}
	}

	/** Visit every non-empty archetype containing `cid` whose component-column
	 * changed at or after `baseline`, in canonical (ascending archetype-id) order
	 * — the archetype-granular onSet detection point. Reuses the existing
	 * per-archetype change tick (free; no write-path cost). */
	public _forEachChangedArchetype(
		cid: number,
		baseline: number,
		cb: (arch: Archetype) => void
	): void {
		const bucket = this.archGraph.componentIndex[cid];
		if (bucket === undefined) return;
		// `bucket` is already ascending by archetype id (ArchetypeGraph.install pushes ids in
		// monotonic creation order — guarded in DEV), which IS the canonical
		// order this visit promises. The previous Map<Set> form had to copy the set
		// into a fresh array and `sort()` it here every call; the ordered list drops
		// both the allocation and the sort.
		const archs = this.archGraph.archetypes;
		for (let i = 0; i < bucket.length; i++) {
			const arch = archs[bucket[i] as number];
			if (arch.length > 0 && arch._changedTick[cid] >= baseline) cb(arch);
		}
	}

	/** Enabled live entities currently carrying `cid`, used by `yieldExisting` to
	 * replay onAdd on registration. Bounded by `enabled_count`: a disabled
	 * entity is excluded from default queries, so seeding it via onAdd would
	 * publish a row that an immediate onDisable should have removed — it is simply
	 * absent at seed (the "delete on disable" semantics). Unordered here — the
	 * registry radix-sorts. */
	public _collectEntitiesWithComponent(cid: number): EntityID[] {
		const out: EntityID[] = [];
		const bucket = this.archGraph.componentIndex[cid];
		if (bucket === undefined) return out;
		const archs = this.archGraph.archetypes;
		for (let b = 0; b < bucket.length; b++) {
			const arch = archs[bucket[b] as number];
			const eids = arch.entityIds;
			for (let i = 0; i < arch.enabledCount; i++) out.push(unsafeCast<EntityID>(eids[i]));
		}
		return out;
	}

	// =======================================================
	// Component registration
	// =======================================================

	public registerComponent<S extends Record<string, TypedArrayTag>>(
		schema: S,
		name?: string
	): ComponentDef<S> {
		// The SAB archetype descriptor carries a fixed COMPONENT_MASK_WORDS-word
		// component mask; any component past STORE_DESCRIPTOR_COMPONENT_LIMIT is
		// invisible to the Zig side, which matches archetypes on that mask alone.
		// The heap-side BitSet can grow past it, so an overflow would silently
		// conflate archetypes differing only in such a component. Fail loudly
		// here.
		if (this.componentCount >= STORE_DESCRIPTOR_COMPONENT_LIMIT) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_LIMIT_EXCEEDED,
				`Cannot register more than ${STORE_DESCRIPTOR_COMPONENT_LIMIT} components: the SAB ` +
					`archetype descriptor mask is ${STORE_DESCRIPTOR_COMPONENT_LIMIT} bits wide. Widen ` +
					`the descriptor mask (descriptor.ts + abi.zig, a SIM_ABI_VERSION bump) to raise it.`,
				{ componentCount: this.componentCount, limit: STORE_DESCRIPTOR_COMPONENT_LIMIT }
			);
		}
		const fieldNames = Object.keys(schema);
		const fieldTypes: TypedArrayTag[] = new Array(fieldNames.length);
		const fieldIndex: Record<string, number> = Object.create(null);
		for (let i = 0; i < fieldNames.length; i++) {
			fieldIndex[fieldNames[i]] = i;
			fieldTypes[i] = schema[fieldNames[i]];
		}
		// Reject float columns on a deterministic world BEFORE consuming an id /
		// pushing metas, so a rejected registration leaves no partial state.
		this._rejectNonDeterministicFields(fieldNames, fieldTypes, "component");
		const id = asComponentId(this.componentCount++);
		this.componentMetas.push({
			name,
			fieldNames,
			fieldIndex,
			fieldTypes,
			obsAdd: false,
			obsRem: false,
			obsDisable: false,
			obsEnable: false,
			trackDirty: false
		});
		const def = makeComponentDef<S>(id);
		if (name !== undefined) setComponentDebugName(def, name);
		return def;
	}

	/** `'Pos' (component 5)` when the component was registered with a debug
	 * name, else `component 5` — the label diagnostics interpolate. */
	public componentLabel(cid: number): string {
		const name = this.componentMetas[cid]?.name;
		return name !== undefined ? `'${name}' (component ${cid})` : `component ${cid}`;
	}

	/** Return the field index assigned to `(def, fieldName)` at component
	 * registration. Indexes are insertion-order, zero-based, and stable for
	 * the lifetime of the ECS. Used by systems that pass `(component_id,
	 * field_id)` pairs across the WASM FFI. */
	public fieldIdOf(def: ComponentHandle, fieldName: string): number {
		const cid = def.id;
		const meta = this.componentMetas[cid];
		if (meta === undefined) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`field_id_of: component ${cid} is not registered`
			);
		}
		const idx = meta.fieldIndex[fieldName];
		if (idx === undefined) {
			throw new ECSError(
				ECS_ERROR.FIELD_NOT_REGISTERED,
				`field_id_of: component ${cid} has no field "${fieldName}"`
			);
		}
		return idx;
	}

	// =======================================================
	// Sparse storage class (out-of-identity components)
	// =======================================================

	/** Register a sparse component or tag. Unlike `registerComponent`, this
	 * allocates from a separate id space and never touches the archetype mask,
	 * so it does **not** count against `STORE_DESCRIPTOR_COMPONENT_LIMIT`. See
	 * `sparse_store.ts`. */
	public registerSparseComponent<S extends Record<string, TypedArrayTag>>(
		schema: S,
		name?: string
	): SparseComponentDef<S> {
		const fieldNames = Object.keys(schema);
		const fieldTypes: TypedArrayTag[] = new Array(fieldNames.length);
		for (let i = 0; i < fieldNames.length; i++) fieldTypes[i] = schema[fieldNames[i]];
		// Same float ban as dense registration — a sparse column feeds stateHash
		// too. Check before allocating the store id, no partial state.
		this._rejectNonDeterministicFields(fieldNames, fieldTypes, "sparse component");
		return this._pushSparseStore<S>(fieldNames, fieldTypes, name);
	}

	/** Sparse sibling of `componentLabel` — sparse ids are a separate id space. */
	public sparseLabel(sid: number): string {
		const name = this.sparseNames[sid];
		return name !== undefined
			? `'${name}' (sparse component ${sid})`
			: `sparse component ${sid}`;
	}

	/** Allocate the backing sparse store WITHOUT the float guard, for
	 * engine-internal backings whose `f64` holds an EXACT integer rather than a
	 * user quantity: the exclusive-relation `{ target }` slot stores an `EntityID`
	 * (≤ 2^53, so f64 is bit-exact and cross-host identical — the ban targets float
	 * *arithmetic* rounding, which a target slot never undergoes). User schemas go
	 * through `registerSparseComponent`, which guards first. */
	private _pushSparseStore<S extends Record<string, TypedArrayTag> = Record<string, never>>(
		fieldNames: string[],
		fieldTypes: TypedArrayTag[],
		name?: string
	): SparseComponentDef<S> {
		const id = this.sparseStores.length as SparseComponentID;
		this.sparseStores.push(new SparseComponentStore(fieldNames, fieldTypes));
		this.sparseNames.push(name);
		return unsafeCast<SparseComponentDef<S>>(id);
	}

	private sparseStoreOf(def: SparseComponentDef): SparseComponentStore {
		const id = def as number;
		const store = this.sparseStores[id];
		if (store === undefined) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`sparse component ${id} is not registered`
			);
		}
		return store;
	}

	/** Add (or overwrite) a sparse component on an entity. No archetype
	 * transition, no row copy — the entity's `archetype_id` is unchanged. */
	public addSparse(
		entityId: EntityID,
		def: SparseComponentDef,
		values?: Record<string, number>
	): void {
		if (!this.isAlive(entityId)) {
			if (DEV) throw entityNotAliveError("addSparse", entityId, this.sparseLabel(def as unknown as number));
			return;
		}
		this.sparseStoreOf(def).setRow(getEntityIndex(entityId), values ?? EMPTY_VALUES);
	}

	/** Remove a sparse component from an entity. No-op if absent. */
	public removeSparse(entityId: EntityID, def: SparseComponentDef): void {
		if (!this.isAlive(entityId)) {
			if (DEV) throw entityNotAliveError("removeSparse", entityId, this.sparseLabel(def as unknown as number));
			return;
		}
		this.sparseStoreOf(def).remove(getEntityIndex(entityId));
	}

	/** Total, like `hasComponent` — `false` for a dead entity, never a throw. */
	public hasSparse(entityId: EntityID, def: SparseComponentDef): boolean {
		if (!this.isAlive(entityId)) {
			return false;
		}
		return this.sparseStoreOf(def).has(getEntityIndex(entityId));
	}

	public getSparseField(entityId: EntityID, def: SparseComponentDef, field: string): number {
		if (DEV && !this.isAlive(entityId)) throw entityNotAliveError("getSparseField", entityId, `${this.sparseLabel(def as unknown as number)}.${field}`);
		const store = this.sparseStoreOf(def);
		const fieldIdx = store.fieldIndex[field];
		if (fieldIdx === undefined) {
			if (DEV) {
				throw new ECSError(
					ECS_ERROR.FIELD_NOT_REGISTERED,
					`sparse component has no field "${field}"`
				);
			}
			return 0;
		}
		const value = store.getField(getEntityIndex(entityId), fieldIdx);
		if (value === undefined) {
			if (DEV) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`entity does not hold this sparse component`
				);
			}
			return 0;
		}
		return value;
	}

	public setSparseField(
		entityId: EntityID,
		def: SparseComponentDef,
		field: string,
		value: number
	): void {
		if (DEV && !this.isAlive(entityId)) throw entityNotAliveError("setSparseField", entityId, `${this.sparseLabel(def as unknown as number)}.${field}`);
		const store = this.sparseStoreOf(def);
		const fieldIdx = store.fieldIndex[field];
		if (fieldIdx === undefined) {
			if (DEV) {
				throw new ECSError(
					ECS_ERROR.FIELD_NOT_REGISTERED,
					`sparse component has no field "${field}"`
				);
			}
			return;
		}
		const ok = store.setField(getEntityIndex(entityId), fieldIdx, value);
		if (DEV && !ok) {
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`entity does not hold this sparse component`
			);
		}
	}

	/** Drop all sparse data for a destroyed entity index so a recycled slot
	 * can't inherit it. Gated by the caller on `sparseStores.length > 0` to
	 * keep the destroy hot path free when sparse storage is unused. */
	private _purgeSparse(index: number): void {
		const stores = this.sparseStores;
		for (let i = 0; i < stores.length; i++) stores[i].remove(index);
	}

	/** Serialize the sparse stores **and** relation side data to a self-contained
	 * byte buffer — the sparse half of a world snapshot (the dense half is the
	 * SAB snapshot). Two framed sections: the sparse stores (`snapshot_sparse_-
	 * stores` — exclusive relation targets + multi membership ride here) followed
	 * by the relation side data (`snapshotRelations` — multi forward target
	 * sets, which live outside the sparse store). Both are written in canonical
	 * entity-index order, so two worlds with identical contents inserted in
	 * different orders snapshot byte-for-byte the same. The reverse index
	 * is derived and never serialized — `restoreSparse` rebuilds it. Pairs with
	 * `restoreSparse`.
	 *
	 * **Opt-in.** Throws `DETERMINISM_DISABLED` unless the
	 * Store was constructed with `{ deterministic: true }` — the canonical
	 * entity-index ordering is the determinism tax the flag gates. */
	public snapshotSparse(): Uint8Array {
		this._requireDeterministic("snapshot_sparse()");
		return this._snapshots.snapshotSparse();
	}

	/** Repopulate the sparse stores from `snapshotSparse` bytes, replacing all
	 * current sparse data (full-equality round-trip of membership + data), then
	 * rebuild every relation's derived side indices: multi forward sets from the
	 * relation section, and the reverse index for both cardinalities (exclusive
	 * from the just-restored sparse target field, multi from the rebuilt forward
	 * sets). The sparse components and relations must already be registered in
	 * the same order — restore carries data, not the registration (which is
	 * code). Throws `SparseRestoreError` if the snapshot's shape, field identity,
	 * entity-index bounds, or frame length don't validate.
	 *
	 * **Opt-in.** Throws `DETERMINISM_DISABLED` unless the
	 * Store was constructed with `{ deterministic: true }`; paired with
	 * `snapshotSparse`, which produces the canonical bytes restore consumes. */
	public restoreSparse(bytes: Uint8Array): void {
		this._requireDeterministic("restore_sparse()");
		this._snapshots.restoreSparse(bytes);
	}

	// =======================================================
	// World snapshot / resume — mount onto a live world
	// =======================================================

	/**
	 * Capture the full live world to one self-contained byte buffer that
	 * `restoreInto` can mount back onto a live, ticking world ("rewind a running
	 * world and keep ticking"). Three sections (see `resume.ts`): the dense SAB
	 * column bytes (`snapshotColumnStore`), the sparse + relation bytes
	 * (`snapshotSparse`), and the host-side bookkeeping the SAB omits — the world
	 * tick, the entity recycle free-list (in live order; no byte source, and its
	 * order is load-bearing for byte-identical resume), the alive count, and each
	 * archetype's `length` / `enabledCount`.
	 *
	 * **Opt-in.** Throws `DETERMINISM_DISABLED` unless constructed with
	 * `{ deterministic: true }` — the sparse section rides the canonical-ordering
	 * surface and byte-identical resume is a determinism property. Pairs with
	 * `restoreInto`.
	 *
	 * **v1 scope.** Resources + events are NOT captured (resume requires
	 * resource-free per-tick state; events are tick-cleared). Change-detection /
	 * scheduler baselines (`changed()` queries) are likewise not captured — they
	 * are scheduling artifacts, never folded into `stateHash`. Take the snapshot
	 * at a tick boundary (between `update()`s). See the ADR. */
	public snapshot(): Uint8Array {
		this._requireDeterministic("snapshot()");
		return this._snapshots.snapshot();
	}

	/**
	 * Mount a `snapshot()` buffer onto this live world and leave it ready to keep
	 * ticking. Fails closed on a malformed frame or a registration mismatch
	 * BEFORE any live state is touched (the archetype/component graph is rebuilt
	 * from code, not the snapshot — same contract as `restoreSparse`). On
	 * success the world's dense + sparse state, entity allocator, and tick are
	 * exactly the captured world's.
	 *
	 * Requires a world whose SAB-backed archetype set + column layout match the
	 * snapshot's exactly (prewarm so the archetype set is stable) and the same
	 * entity-index capacity. **Opt-in:** throws `DETERMINISM_DISABLED`
	 * unless `{ deterministic: true }`. See `snapshot()` for the v1 scope. */
	public restoreInto(bytes: Uint8Array): void {
		this._requireDeterministic("restoreInto()");
		this._snapshots.restoreInto(bytes);
	}

	/** Adopt a restored dense store (`SnapshotService.restoreInto`'s mount
	 * step): swap the live backing, refresh every buffer-backed archetype's
	 * views, recover the allocator high-water from the restored region, and
	 * republish (the grow tail). Store-owned because it assigns
	 * `_columnStore` — the service never writes Store fields. */
	private _mountRestoredDense(restored: ColumnStore): void {
		this._columnStore = restored;
		const archs = this.archGraph.archetypes;
		for (let i = 0; i < archs.length; i++) {
			if (archs[i].isBufferBacked) archs[i].refreshViews(this._columnStore);
		}
		// entityHighWater is host state; set it from the restored region's length
		// header BEFORE _handleBufferResized (which mirrors highWater back into the
		// header — the stale host value would clobber the restored one).
		this.entityAllocator.setHighWater(
			restored.view.getUint32(
				restored.header.entityIndexOff + ENTITY_INDEX_HEADER_OFFSETS.length,
				true
			)
		);
		this._handleBufferResized();
	}

	/** Rebuild each SAB-backed archetype's host-side `length` / `enabledCount` /
	 * `_entityIds` after the dense backing was swapped in `restoreInto`. `length`
	 * + the per-row entity-id back-reference come from a scan of the restored
	 * entity-index region (which entity occupies which row); `enabledCount` comes
	 * from the captured host-state (the partition boundary is positional only
	 * — it has no per-entity byte source). */
	private _reconstructHostRows(host: HostState): void {
		const highWater = this.entityAllocator.highWater;
		const archIndex = this.entityArchetype;
		const rowIndex = this.entityRow;
		const gens = this.entityAllocator.generations;
		// Per-archetype row → packed EntityID, dense over [0, length).
		const rowsByArch = new Map<number, number[]>();
		for (let i = 0; i < highWater; i++) {
			const aid = archIndex[i];
			if (aid === UNASSIGNED) continue; // free or retired slot
			const row = rowIndex[i];
			if (row === UNASSIGNED) continue; // component-less alive entity (no row)
			let rows = rowsByArch.get(aid);
			if (rows === undefined) {
				rows = [];
				rowsByArch.set(aid, rows);
			}
			rows[row] = createEntityId(i, gens[i]) as number;
		}
		for (let r = 0; r < host.archetypeRows.length; r++) {
			const meta = host.archetypeRows[r];
			const a = this.archGet(meta.archetypeId as ArchetypeID);
			const rows = rowsByArch.get(meta.archetypeId) ?? [];
			if (DEV) {
				if (rows.length !== meta.length) {
					throw new ECSRestoreError(
						`archetype ${meta.archetypeId} row-count mismatch on restore: scan found ` +
							`${rows.length} rows, host-state recorded ${meta.length}`
					);
				}
				for (let k = 0; k < rows.length; k++) {
					if (rows[k] === undefined) {
						throw new ECSRestoreError(
							`archetype ${meta.archetypeId} has a hole at row ${k} after restore ` +
								`(entity-index region inconsistent)`
						);
					}
				}
			}
			a.restoreHostRows(rows, meta.enabledCount);
		}
	}

	// =======================================================
	// Relations — (relation, target) pairs on the sparse store
	// =======================================================
	// Registry, traversal, and hierarchy ordering live in `RelationService`
	// (relation_service.ts) — semantics and rationale are documented there.
	// These delegations keep the Store surface stable for ecs.ts and the query
	// internals.

	public registerRelation(opts?: RelationOptions): RelationDef {
		return this.relationService.registerRelation(opts);
	}

	/** Number of registered relations. Visible to tests asserting the
	 * no-transition invariant alongside `archetype_count`. */
	public get relationCount(): number {
		return this.relationService.count;
	}

	public addRelation(src: EntityID, def: RelationDef, tgt: EntityID): void {
		this.relationService.addRelation(src, def, tgt);
	}

	public removeRelation(src: EntityID, def: RelationDef, tgt?: EntityID): void {
		this.relationService.removeRelation(src, def, tgt);
	}

	public targetOf(src: EntityID, def: RelationDef): EntityID | undefined {
		return this.relationService.targetOf(src, def);
	}

	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		return this.relationService.targetsOf(src, def);
	}

	public sourcesOf(tgt: EntityID, def: RelationDef): EntityID[] {
		return this.relationService.sourcesOf(tgt, def);
	}

	public hasRelation(src: EntityID, def: RelationDef): boolean {
		return this.relationService.hasRelation(src, def);
	}

	public pairsOf(def: RelationDef): readonly (readonly [EntityID, EntityID])[] {
		return this.relationService.pairsOf(def);
	}

	public sourcesOfAny(tgt: EntityID): readonly (readonly [RelationDef, EntityID])[] {
		return this.relationService.sourcesOfAny(tgt);
	}

	public relationBackingSparseId(def: RelationDef): SparseComponentID {
		return this.relationService.relationBackingSparseId(def);
	}

	/** Drive a `(*, T)` wildcard query (`Query.forEachRelatedTo`) — see
	 * `RelationService.forEachRelationTargetMatch`. */
	public _forEachRelationTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void {
		this.relationService.forEachRelationTargetMatch(
			target,
			include,
			exclude,
			anyOf,
			sparseInclude,
			sparseExclude,
			includeDisabled,
			cb
		);
	}

	public compactRelations(): number {
		return this.relationService.compactRelations();
	}

	public ancestorsOf(src: EntityID, def: RelationDef): EntityID[] {
		return this.relationService.ancestorsOf(src, def);
	}

	public rootOf(src: EntityID, def: RelationDef): EntityID {
		return this.relationService.rootOf(src, def);
	}

	public cascadeOf(root: EntityID, def: RelationDef): EntityID[] {
		return this.relationService.cascadeOf(root, def);
	}

	/** Second query-match path: iterate entities matching a
	 * dense mask **and** sparse-membership terms, invoking `cb` per entity.
	 * Yields `EntityID`s, not archetype spans — sparse members are scattered
	 * across archetypes, so there is no SoA column to hand back. Driven by the
	 * cheapest candidate set:
	 *
	 *  - **sparse require present** → walk the *smallest* required store's
	 *    `indices` (an upper bound on the result), filtering each by the other
	 *    required stores, the excluded stores, and the dense mask resolved from
	 *    the entity's own archetype. Independent of archetype count.
	 *  - **sparse exclude only** → walk `denseArchetypes` (already dense-mask-
	 *    matched and non-empty by the caller), skipping rows in any excluded
	 *    store.
	 *  - **neither** → walk `denseArchetypes`' entity ids (dense-only fallback).
	 *
	 * Only reached via `Query.forEachEntity`; dense `forEach` never consults
	 * the sparse stores, so dense-only queries are unaffected. */
	public _forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void,
		includeDisabled: boolean
	): void {
		const stores = this.sparseStores;
		if (DEV) {
			for (let i = 0; i < sparseInclude.length; i++) {
				if (stores[sparseInclude[i] as number] === undefined)
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`sparse component ${sparseInclude[i]} is not registered`
					);
			}
			for (let i = 0; i < sparseExclude.length; i++) {
				if (stores[sparseExclude[i] as number] === undefined)
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`sparse component ${sparseExclude[i]} is not registered`
					);
			}
		}

		if (sparseInclude.length > 0) {
			// Drive from the smallest required store — its membership is an
			// upper bound on the match, so the scan is sized to the rarest term.
			let driver = stores[sparseInclude[0] as number];
			for (let i = 1; i < sparseInclude.length; i++) {
				const s = stores[sparseInclude[i] as number];
				if (s.size < driver.size) driver = s;
			}
			const indices = driver.indices;
			const gens = this.entityAllocator.generations;
			const entArch = this.entityArchetype;
			const entRow = this.entityRow;
			const archetypes = this.archGraph.archetypes;
			for (let i = 0; i < indices.length; i++) {
				const idx = indices[i];
				let ok = true;
				for (let j = 0; j < sparseInclude.length; j++) {
					const s = stores[sparseInclude[j] as number];
					if (s !== driver && !s.has(idx)) {
						ok = false;
						break;
					}
				}
				if (!ok) continue;
				for (let j = 0; j < sparseExclude.length; j++) {
					if (stores[sparseExclude[j] as number].has(idx)) {
						ok = false;
						break;
					}
				}
				if (!ok) continue;
				const archId = entArch[idx];
				if (archId === UNASSIGNED) continue;
				const arch = archetypes[archId];
				const mask = arch.mask;
				if (!mask.contains(include)) continue;
				if (exclude !== null && mask.overlaps(exclude)) continue;
				if (anyOf !== null && !mask.overlaps(anyOf)) continue;
				// Skip disabled entities by default: a disabled entity's sparse
				// data is still present (disable doesn't touch sparse stores), so this
				// membership-driven path would otherwise yield it. A component-less
				// entity (row UNASSIGNED) is never disabled.
				if (!includeDisabled) {
					const row = entRow[idx];
					if (row !== UNASSIGNED && row >= arch.enabledCount) continue;
				}
				cb(createEntityId(idx, gens[idx]));
			}
			return;
		}

		// No sparse require: `denseArchetypes` already encodes the dense mask
		// match, so just walk its entity ids (which carry their own generation),
		// optionally dropping rows present in an excluded store.
		const hasExcl = sparseExclude.length > 0;
		for (let a = 0; a < denseArchetypes.length; a++) {
			const arch = denseArchetypes[a];
			const eids = arch.entityIds;
			// Default: only the enabled prefix; includeDisabled: all rows.
			// Read the partition fields directly (not the flag-dependent
			// `entityCount` getter — `forEachEntity` doesn't set that flag).
			const n = includeDisabled ? arch.totalCount : arch.enabledCount;
			for (let r = 0; r < n; r++) {
				const id = eids[r] as EntityID;
				if (hasExcl) {
					const idx = getEntityIndex(id);
					let excluded = false;
					for (let j = 0; j < sparseExclude.length; j++) {
						if (stores[sparseExclude[j] as number].has(idx)) {
							excluded = true;
							break;
						}
					}
					if (excluded) continue;
				}
				cb(id);
			}
		}
	}

	/** Fourth query-match path: the matched set in hierarchy depth order
	 * (parents before children) — see `RelationService.forEachHierarchyMatch`. */
	public _forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void {
		this.relationService.forEachHierarchyMatch(
			include,
			exclude,
			anyOf,
			sparseInclude,
			sparseExclude,
			denseArchetypes,
			relation,
			maxDepth,
			includeDisabled,
			cb
		);
	}

	// =======================================================
	// Immediate component operations (for setup/spawning)
	// =======================================================

	public addComponent(entityId: EntityID, def: ComponentDef<Record<string, never>>): void;
	public addComponent<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: FieldValues<S>
	): void;
	public addComponent(
		entityId: EntityID,
		def: ComponentDef,
		values?: Record<string, number>
	): void {
		if (!this.isAlive(entityId)) {
			if (DEV) throw entityNotAliveError("addComponent", entityId, this.componentLabel(def.id));
			return;
		}

		const entityIndex = getEntityIndex(entityId);
		const currentArchetypeId = this.entityArchetype[entityIndex] as ArchetypeID;
		const currentArch = this.archGet(currentArchetypeId);

		// Single edge probe (#hot-add). The steady state — a repeated (source
		// archetype, added component) pair — used to pay FOUR redundant lookups
		// before touching a row: `mask.has(cid)`, then `archResolveAdd` (which
		// re-reads `mask.has(cid)` and the same `edges[cid]` slot), then
		// `archGet(target)`, then `getEdge(cid)` a second time for `addMap`.
		// `edges[cid]` is a holey array, so each probe is a hole-check load.
		//
		// One probe answers all of it: `cacheEdge` records the add direction on
		// the source (`edge.add`/`addMap`) and the remove direction on the
		// target, so a non-null `edge.add` means *exactly* "this archetype does
		// NOT hold cid, and the destination is already resolved" — an archetype
		// that holds cid can never be the `from` of an add edge for cid. The
		// cold path (first time this pair is seen, or the entity already holds
		// the component) falls through to the original resolve below.
		const edge = currentArch.getEdge(def.id);
		if (edge === undefined || edge.add === null) {
			this._addComponentCold(entityId, entityIndex, currentArch, currentArchetypeId, def, values);
			return;
		}
		const targetArchetypeId = edge.add;
		const targetArch = this.archGet(targetArchetypeId);
		const srcRow = this.entityRow[entityIndex];

		let dstRow: number;

		if (srcRow !== UNASSIGNED) {
			const srcPre = currentArch.length;
			const tgtPre = targetArch.length;
			const tgtPreE = targetArch.enabledCount;
			const tagOnly = !targetArch.hasColumns && !currentArch.hasColumns;

			if (tagOnly) {
				targetArch.moveEntityFromTag(currentArch, srcRow, entityId, this.entityRow);
			} else {
				targetArch.moveEntityFrom(
					currentArch,
					srcRow,
					entityId,
					edge.addMap!,
					this._tick,
					this.entityRow
				);
			}
			dstRow = _moveResult[0];
			this._onArchLenChange(currentArch, srcPre);
			this._onArchGrow(targetArch, tgtPre, tgtPreE);
		} else {
			const tgtPre = targetArch.length;
			const tgtPreE = targetArch.enabledCount;
			dstRow = targetArch.hasColumns
				? targetArch.addEntity(entityId, this.entityRow)
				: targetArch.addEntityTag(entityId, this.entityRow);
			this._onArchGrow(targetArch, tgtPre, tgtPreE);
		}

		targetArch.writeFields(
			dstRow,
			def.id,
			values as Record<string, number>,
			this._tick
		);

		this.entityArchetype[entityIndex] = targetArchetypeId;
		this.entityRow[entityIndex] = dstRow;
	}

	/** @internal — cold tail of `addComponent`: the entity already holds `def`
	 * (overwrite in place, no transition), or the (source, component) add edge
	 * has not been cached yet (first time this pair is seen — resolve, which
	 * plants the edge, then re-enter the hot body). Split out so the edge-hit
	 * path above stays a straight line with one holey-array probe; this runs at
	 * most once per (archetype, component) pair plus on in-place overwrites. */
	private _addComponentCold(
		entityId: EntityID,
		entityIndex: number,
		currentArch: Archetype,
		currentArchetypeId: ArchetypeID,
		def: ComponentDef,
		values?: Record<string, number>
	): void {
		// Already has this component → overwrite in-place (no archetype transition)
		if (currentArch.hasComponent(def.id)) {
			currentArch.writeFields(
				this.entityRow[entityIndex],
				def.id,
				values as Record<string, number>,
				this._tick
			);
			return;
		}
		// Plant the add edge (and its transition map), then take the hot path.
		// `resolveAdd` caches both directions and we've just ruled out
		// `mask.has(cid)`, so `edge.add` is non-null on re-entry — the recursion
		// is depth-1 by construction.
		this.archResolveAdd(currentArchetypeId, def.id);
		(this.addComponent as (e: EntityID, d: ComponentDef, v?: Record<string, number>) => void)(
			entityId,
			def,
			values
		);
	}

	/** Add multiple components in one transition (resolves final archetype, then moves once).
	 *
	 * Final-mask resolve, not graph walk. The previous implementation called
	 * `archResolveAdd` once per entry, which threaded through every
	 * intermediate archetype on the path — and each unseen intermediate
	 * triggered a fresh `extendColumnStore` even though no entity ever lived
	 * there. Computing the union mask up front and resolving once via
	 * `archGetOrCreateFromMask` collapses N-1 intermediate-archetype
	 * creations into zero for the batched case. The lazy
	 * single-mask path remains the same; this just avoids feeding it
	 * archetypes the entity never visits.
	 *
	 * Composite-add edge cache. The final-mask resolve, unlike the
	 * single-add `edges[]` walk, re-pays a per-call `mask.hash()`, `ArchetypeGraph.lookup`
	 * (the Map-of-buckets + `equals` scan), and `getBatchTransitionMap` on
	 * every call. That is much slower than a cached edge walk, and a probe put the
	 * cost on the two `Map.get` calls, and not on the hash. So a repeated (source,
	 * added-set) add now resolves through `currentArch`'s composite-add cache: one
	 * `Map.get` on an exact packed key yields the target + transition map, and we
	 * skip the union-mask build entirely. First call per key still resolves via
	 * the final-mask path below (no intermediate planting) and plants the edge. */
	public addComponents(entityId: EntityID, entries: readonly TemplateEntryData[]): void {
		if (!this.isAlive(entityId)) {
			if (DEV) throw entityNotAliveError("addComponents", entityId);
			return;
		}

		const entityIndex = getEntityIndex(entityId);
		const currentArchetypeId = this.entityArchetype[entityIndex] as ArchetypeID;
		const currentArch = this.archGet(currentArchetypeId);

		// Pack the entry def ids into an exact composite-add key and try
		// the cache before touching a mask. The pack also serves as the loop
		// that would otherwise begin the union build — on a hit it replaces it.
		const n = entries.length;
		let key = n;
		for (let i = 0; i < n; i++) {
			const cid = entries[i].def.id;
			if (cid >= COMPOSITE_ADD_ID_STRIDE - 1 || n > COMPOSITE_ADD_MAX_ENTRIES) {
				key = COMPOSITE_ADD_UNKEYABLE;
				break;
			}
			key = key * COMPOSITE_ADD_ID_STRIDE + (cid + 1);
		}

		if (key !== COMPOSITE_ADD_UNKEYABLE) {
			const ce = currentArch.getCompositeAddEdge(key);
			if (ce !== undefined) {
				this._addComponentsInto(
					entityId,
					entityIndex,
					currentArch,
					this.archGet(ce.target),
					ce.target,
					ce.map,
					entries
				);
				return;
			}
		}

		// Cold path. Compute the final target mask = current ∪ {entries[*].def}.
		// Lazy-init the scratch: only seed it from `currentArch.mask` if at
		// least one entry would actually introduce a new bit; entries that fully
		// overlap the current mask short-circuit to an in-place overwrite below.
		// Scratch is owned by Store and reused across calls — the terminal
		// `archGetOrCreateFromMask` → `ArchetypeGraph.install` path clones it before
		// storing long-term.
		let targetMask: BitSet | null = null;
		for (let i = 0; i < n; i++) {
			const cid = entries[i].def.id;
			if (targetMask !== null) {
				targetMask.set(cid);
			} else if (!currentArch.mask.has(cid)) {
				targetMask = currentArch.mask.copyInto(this._scratchTargetMask);
				targetMask.set(cid);
			}
		}

		if (targetMask === null) {
			// All components already present — overwrite in-place. No transition,
			// so nothing to cache (the composite edge only spans real moves).
			const row = this.entityRow[entityIndex];
			for (let i = 0; i < n; i++) {
				currentArch.writeFields(
					row,
					entries[i].def.id,
					entries[i].values ?? EMPTY_VALUES,
					this._tick
				);
			}
			return;
		}

		const targetArchetypeId = this.archGetOrCreateFromMask(targetMask);
		const targetArch = this.archGet(targetArchetypeId);
		// Build the src→target map once and plant the composite edge so the next
		// add of this set from this archetype skips straight to the move. The map
		// is unused when the source is rowless (append, not move), but caching it
		// now primes the live-entity case the issue targets.
		const map = currentArch.getBatchTransitionMap(targetArch);
		if (key !== COMPOSITE_ADD_UNKEYABLE) {
			currentArch.cacheCompositeAddEdge(key, targetArchetypeId, map);
		}
		this._addComponentsInto(
			entityId,
			entityIndex,
			currentArch,
			targetArch,
			targetArchetypeId,
			map,
			entries
		);
	}

	/** Shared move+write tail of `addComponents`: place the entity into
	 * the already-resolved `targetArch` — a `moveEntityFrom` along the cached
	 * `map` when it has a row, else a fresh append (the rowless empty-archetype
	 * source ignores `map`) — then write every entry's fields. Both the
	 * composite-edge-cache hit and the final-mask cold path funnel through here so
	 * the placement logic lives once. */
	private _addComponentsInto(
		entityId: EntityID,
		entityIndex: number,
		currentArch: Archetype,
		targetArch: Archetype,
		targetArchetypeId: ArchetypeID,
		map: Int16Array,
		entries: readonly { def: ComponentDef; values?: Readonly<Record<string, number>> }[]
	): void {
		const srcRow = this.entityRow[entityIndex];

		let dstRow: number;
		if (srcRow !== UNASSIGNED) {
			const srcPre = currentArch.length;
			const tgtPre = targetArch.length;
			const tgtPreE = targetArch.enabledCount;
			targetArch.moveEntityFrom(
				currentArch,
				srcRow,
				entityId,
				map,
				this._tick,
				this.entityRow
			);
			dstRow = _moveResult[0];
			this._onArchLenChange(currentArch, srcPre);
			this._onArchGrow(targetArch, tgtPre, tgtPreE);
		} else {
			const tgtPre = targetArch.length;
			const tgtPreE = targetArch.enabledCount;
			dstRow = targetArch.addEntity(entityId, this.entityRow);
			this._onArchGrow(targetArch, tgtPre, tgtPreE);
		}

		for (let i = 0; i < entries.length; i++) {
			targetArch.writeFields(
				dstRow,
				entries[i].def.id,
				entries[i].values ?? EMPTY_VALUES,
				this._tick
			);
		}

		this.entityArchetype[entityIndex] = targetArchetypeId;
		this.entityRow[entityIndex] = dstRow;
	}

	public removeComponent(entityId: EntityID, def: ComponentDef): void {
		if (!this.isAlive(entityId)) {
			if (DEV) throw entityNotAliveError("removeComponent", entityId, this.componentLabel(def.id));
			return;
		}

		const entityIndex = getEntityIndex(entityId);
		const currentArchetypeId = this.entityArchetype[entityIndex] as ArchetypeID;
		const currentArch = this.archGet(currentArchetypeId);

		// Single edge probe — the mirror of `addComponent`'s (see the note
		// there). `cacheEdge` records the remove direction on the archetype that
		// HOLDS the component, so a non-null `edge.remove` means exactly "this
		// archetype holds cid and the destination is resolved", collapsing
		// `hasComponent` + `archResolveRemove` + a second `getEdge` into one
		// holey-array probe.
		const edge = currentArch.getEdge(def.id);
		if (edge === undefined || edge.remove === null) {
			this._removeComponentCold(entityId, currentArch, currentArchetypeId, def);
			return;
		}
		const targetArchetypeId = edge.remove;
		const targetArch = this.archGet(targetArchetypeId);
		const srcRow = this.entityRow[entityIndex];
		const tagOnly = !targetArch.hasColumns && !currentArch.hasColumns;
		const srcPre = currentArch.length;
		const tgtPre = targetArch.length;
		const tgtPreE = targetArch.enabledCount;

		if (tagOnly) {
			targetArch.moveEntityFromTag(currentArch, srcRow, entityId, this.entityRow);
		} else {
			targetArch.moveEntityFrom(
				currentArch,
				srcRow,
				entityId,
				edge.removeMap!,
				this._tick,
				this.entityRow
			);
		}

		this.entityArchetype[entityIndex] = targetArchetypeId;
		this.entityRow[entityIndex] = _moveResult[0];
		this._onArchLenChange(currentArch, srcPre);
		this._onArchGrow(targetArch, tgtPre, tgtPreE);
	}

	/** @internal — cold tail of `removeComponent`: the entity doesn't hold `def`
	 * (no-op), or the (source, component) remove edge has not been cached yet.
	 * Mirror of `_addComponentCold`; same depth-1 re-entry argument. */
	private _removeComponentCold(
		entityId: EntityID,
		currentArch: Archetype,
		currentArchetypeId: ArchetypeID,
		def: ComponentDef
	): void {
		if (!currentArch.hasComponent(def.id)) return;
		this.archResolveRemove(currentArchetypeId, def.id);
		this.removeComponent(entityId, def);
	}

	/** Remove multiple components in one transition (resolves final archetype, then moves once).
	 *
	 * Final-mask resolve, not graph walk. Same rationale as `addComponents`
	 * above — the previous per-step path threaded `archResolveRemove`
	 * once per def, which materialised every intermediate archetype on the
	 * removal path. Computing the difference mask up front and resolving
	 * once avoids planting N-1 intermediates the entity never lives in. */
	public removeComponents(entityId: EntityID, defs: ComponentDef[]): void {
		if (!this.isAlive(entityId)) {
			if (DEV) throw entityNotAliveError("removeComponents", entityId);
			return;
		}

		const entityIndex = getEntityIndex(entityId);
		const currentArchetypeId = this.entityArchetype[entityIndex] as ArchetypeID;
		const currentArch = this.archGet(currentArchetypeId);

		// Compute the final target mask = current \ {defs[*]}. Lazy-init the
		// scratch: only seed it from `currentArch.mask` if at least one entry
		// would actually clear a bit; defs that don't overlap short-circuit
		// to a no-op below. Scratch is owned by Store and reused across
		// calls — see the matching comment in `addComponents`.
		let targetMask: BitSet | null = null;
		for (let i = 0; i < defs.length; i++) {
			const cid = defs[i].id;
			if (targetMask !== null) {
				targetMask.clear(cid);
			} else if (currentArch.mask.has(cid)) {
				targetMask = currentArch.mask.copyInto(this._scratchTargetMask);
				targetMask.clear(cid);
			}
		}

		// No effective removal — no transition.
		if (targetMask === null) return;

		const targetArchetypeId = this.archGetOrCreateFromMask(targetMask);
		const targetArch = this.archGet(targetArchetypeId);
		const srcRow = this.entityRow[entityIndex];
		const srcPre = currentArch.length;
		const tgtPre = targetArch.length;
		const tgtPreE = targetArch.enabledCount;

		const map = currentArch.getBatchTransitionMap(targetArch);
		targetArch.moveEntityFrom(
			currentArch,
			srcRow,
			entityId,
			map,
			this._tick,
			this.entityRow
		);

		this.entityArchetype[entityIndex] = targetArchetypeId;
		this.entityRow[entityIndex] = _moveResult[0];
		this._onArchLenChange(currentArch, srcPre);
		this._onArchGrow(targetArch, tgtPre, tgtPreE);
	}

	/** Total: a dead/stale `entityId` returns `false` rather
	 * than throwing — a "has" probe is exactly what callers reach for to avoid
	 * touching dead entities, so it must be safe to ask. */
	public hasComponent(entityId: EntityID, def: ComponentHandle): boolean {
		const entityIndex = this._liveIndex(entityId);
		if (entityIndex < 0) return false;
		return this.archGet(this.entityArchetype[entityIndex] as ArchetypeID).hasComponent(def.id);
	}

	/**
	 * Bulk add a component to ALL entities in the given archetype.
	 * Uses TypedArray.set() for O(columns) instead of O(N×columns).
	 * The archetype must not already contain this component.
	 */
	public batchAddComponent(
		src: ArchetypeID,
		def: ComponentDef,
		values?: Record<string, number>
	): void {
		const srcArch = this.archGet(src);
		if (srcArch.length === 0) return;
		const compId = def.id;
		if (srcArch.mask.has(compId as number)) return;

		const tgtId = this.archResolveAdd(srcArch.id, compId);
		const tgt = this.archGet(tgtId);
		// The bulk move maintains the enabled/disabled partition only when the
		// destination has no disabled rows. Disabled entities + whole-
		// archetype batch ops is an exotic combination; reject it loudly rather
		// than corrupt the partition. Enable first, or use per-entity addComponent.
		if (srcArch.disabledCount > 0 || tgt.disabledCount > 0) {
			throw new ECSError(
				ECS_ERROR.PARTITION_BULK_INTO_DISABLED,
				"batchAddComponent is unsupported on archetypes with disabled entities — enable them first or use per-entity addComponent"
			);
		}
		const edge = srcArch.getEdge(compId)!;
		const count = srcArch.length;
		// src always crosses to 0 (count > 0 guard at top); tgt crosses only
		// if it was empty before the bulk move. Both archetypes are disabled-free
		// here (the guard above throws otherwise), so `enabledCount === length`
		// — the tgt grow's enabled-pre value equals its length-pre value.
		const srcPre = count;
		const tgtPre = tgt.length;
		const tgtPreE = tgt.enabledCount;

		const entArch = this.entityArchetype;
		const entRow = this.entityRow;

		const dstStart = tgt.bulkMoveAllFrom(srcArch, edge.addMap!, this._tick);

		// Update entity→archetype/row mappings for all moved entities
		for (let i = 0; i < count; i++) {
			const idx = getEntityIndex(tgt.entityIds[dstStart + i] as EntityID);
			entArch[idx] = tgtId;
			entRow[idx] = dstStart + i;
		}

		// Write field values to all new entries via one TypedArray.fill per
		// field (instead of N×fieldCount per-row JS writes through
		// `writeFields`). The freshly-moved rows for the added component were
		// zero-filled by `bulkMoveAllFrom`; this overwrites those zeroes
		// with the caller-supplied values.
		const meta = this.componentMetas[compId as number];
		if (meta.fieldNames.length > 0 && values) {
			tgt.bulkWriteFields(dstStart, count, compId, values, this._tick);
		}
		this._onArchLenChange(srcArch, srcPre);
		this._onArchGrow(tgt, tgtPre, tgtPreE);
	}

	/**
	 * Bulk remove a component from ALL entities in the given archetype.
	 * Uses TypedArray.set() for O(columns) instead of O(N×columns).
	 * The archetype must contain this component.
	 */
	public batchRemoveComponent(src: ArchetypeID, def: ComponentDef): void {
		const srcArch = this.archGet(src);
		if (srcArch.length === 0) return;
		const compId = def.id;
		if (!srcArch.mask.has(compId as number)) return;

		const tgtId = this.archResolveRemove(srcArch.id, compId);
		const tgt = this.archGet(tgtId);
		// See `batchAddComponent`: batch ops don't support disabled rows.
		if (srcArch.disabledCount > 0 || tgt.disabledCount > 0) {
			throw new ECSError(
				ECS_ERROR.PARTITION_BULK_INTO_DISABLED,
				"batchRemoveComponent is unsupported on archetypes with disabled entities — enable them first or use per-entity removeComponent"
			);
		}
		const edge = srcArch.getEdge(compId)!;
		const count = srcArch.length;
		// src always crosses to 0 (count > 0 guard at top); tgt crosses only
		// if it was empty before the bulk move. Both archetypes are disabled-free
		// here (the guard above throws otherwise), so `enabledCount === length`.
		const srcPre = count;
		const entArch = this.entityArchetype;
		const entRow = this.entityRow;

		// Removing the last component: every entity becomes component-less. The
		// empty archetype is rowless, so unplace them all (UNASSIGNED) and clear
		// src directly instead of bulk-moving into a destination — the canonical
		// component-less form (matches `createEntity`), keeping `stateHash` and
		// zero-require iteration history-independent.
		if (!tgt.materializesRows) {
			const eids = srcArch.entityIds;
			for (let i = 0; i < count; i++) {
				const idx = getEntityIndex(eids[i] as EntityID);
				entArch[idx] = tgtId as number;
				entRow[idx] = UNASSIGNED;
			}
			srcArch.clearRows();
			this._onArchLenChange(srcArch, srcPre);
			return;
		}

		const tgtPre = tgt.length;
		const tgtPreE = tgt.enabledCount;
		const dstStart = tgt.bulkMoveAllFrom(srcArch, edge.removeMap!, this._tick);

		// Update entity→archetype/row mappings for all moved entities
		for (let i = 0; i < count; i++) {
			const idx = getEntityIndex(tgt.entityIds[dstStart + i] as EntityID);
			entArch[idx] = tgtId;
			entRow[idx] = dstStart + i;
		}
		this._onArchLenChange(srcArch, srcPre);
		this._onArchGrow(tgt, tgtPre, tgtPreE);
	}

	// =======================================================
	// Direct data access (used by SystemContext)
	// =======================================================

	public getEntityArchetype(entityId: EntityID): Archetype {
		return this.archGet(this.entityArchetype[getEntityIndex(entityId)] as ArchetypeID);
	}

	public getEntityRow(entityId: EntityID): number {
		return this.entityRow[getEntityIndex(entityId)];
	}

	/**
	 * The row `resolveEntity` placed the entity at — the alloc-free second
	 * return value of a resolve, read immediately after the call. Same out-param
	 * pattern as `EntityAllocator.lastIndex` and `_moveResult`; returning a
	 * `{ arch, row }` pair instead would allocate on every by-id read.
	 */
	public resolvedRow = 0;

	/**
	 * (archetype, row) for a by-id access, derived from ONE index computation.
	 *
	 * `getEntityArchetype` and `getEntityRow` are each one line, and every by-id
	 * caller needs both — so the pair cost two derivations of the same packed
	 * index and two call frames to read two elements of two parallel arrays
	 * addressed identically. This is that pair, fused: index once, publish the
	 * row on `resolvedRow`, return the archetype.
	 *
	 * The two single-purpose accessors stay above — tests reach for one half at a
	 * time — but no runtime path uses them in a pair any more.
	 */
	public resolveEntity(entityId: EntityID): Archetype {
		const index = (entityId as number) & INDEX_MASK;
		this.resolvedRow = this.entityRow[index];
		return this.archGet(this.entityArchetype[index] as ArchetypeID);
	}

	/**
	 * Build the `at(entity)` binder a `ComponentCursor` repoints itself through
	 * (ref.ts). Handing the cursor a closure rather than the Store keeps the
	 * mutation surface out of a value that user code holds onto.
	 *
	 * `stampTick` distinguishes the two variants once, here, instead of per
	 * `at()`: a mutable cursor bumps the component's change tick on every
	 * repoint (matching `ctx.ref`), a read-only one never does.
	 *
	 * The access check lives HERE, in the binder, and not only at the call that
	 * creates the cursor. A cursor is made one time and then kept, so it outlives
	 * the span that made it: a cursor made at host level (where no system is
	 * active, and the check at creation therefore passes) writes an undeclared
	 * component when a system body uses it, and a `ctx.cursor` that a system
	 * stores in an outer variable does the same in the NEXT system. Both slip
	 * past a check that only runs at creation. `at()` is the point of use, so the
	 * check belongs on it. The creation-site check stays as well: it fails early,
	 * and its stack names the line that made the cursor.
	 */
	public cursorBinder(def: ComponentHandle, stampTick: boolean): CursorBinder {
		const cid = def.id as number;
		return (cursor, entity) => {
			const index = (entity as number) & INDEX_MASK;
			const arch = this.archGet(this.entityArchetype[index] as ArchetypeID);
			if (DEV) {
				// A mutable cursor writes through its setters, so it needs `writes`;
				// a read-only one needs `reads`. Same split as the creation site.
				if (stampTick) accessCheck.checkWrite(def);
				else accessCheck.checkRead(def);
				if (!this.isAlive(entity as EntityID))
					throw entityNotAliveError("cursor.at", entity as EntityID, this.componentLabel(cid));
				if (arch.columnGroups[cid] === undefined)
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`cursor.at: ${this.componentLabel(cid)} has no columns in the archetype of entity ` +
							`${String(entity)} — the entity doesn't hold it, or it is a tag (no fields to point at)`,
						{ component: cid, entity: entity as number }
					);
			}
			if (stampTick) arch._changedTick[cid] = this._tick;
			cursor._bufs = arch._bufs;
			cursor._off = arch._colOffset[cid];
			cursor._row = this.entityRow[index];
		};
	}

	/** A component's field names in schema order — the cursor prototype key and
	 * ordinal source (ref.ts). One array per component, owned by its meta. */
	public componentFieldNames(def: ComponentHandle): readonly string[] {
		return this.componentMetas[def.id as number].fieldNames;
	}

	// =======================================================
	// Query support
	// =======================================================

	/**
	 * Find all archetypes matching the given masks.
	 * Uses the inverted componentIndex to start from the component with the
	 * fewest archetypes, minimizing the number of superset checks.
	 */
	public getMatchingArchetypes(
		required: BitSet,
		excluded?: BitSet,
		anyOf?: BitSet
	): readonly Archetype[] {
		const words = required._words;
		let hasAnyBit = false;
		for (let i = 0; i < words.length; i++) {
			if (words[i] !== 0) {
				hasAnyBit = true;
				break;
			}
		}
		// Empty required mask → match all archetypes (only filter by exclude/any_of)
		if (!hasAnyBit) {
			const archs = this.archGraph.archetypes;
			const result: Archetype[] = [];
			for (let i = 0; i < archs.length; i++) {
				const arch = archs[i];
				if (
					(!excluded || !arch.mask.overlaps(excluded)) &&
					(!anyOf || arch.mask.overlaps(anyOf))
				) {
					result.push(arch);
				}
			}
			return result;
		}

		// Find the smallest componentIndex bucket among all required components.
		// This is the tightest starting point for the superset intersection.
		let smallestSet: ArchetypeID[] | undefined;
		let hasEmpty = false;
		for (let wi = 0; wi < words.length; wi++) {
			let word = words[wi];
			if (word === 0) continue;
			const base = wi << BITS_PER_WORD_SHIFT;
			while (word !== 0) {
				// Extract lowest set bit
				const t = word & (-word >>> 0);
				const bit = base + (BITS_PER_WORD_MASK - Math.clz32(t));
				word ^= t;
				const bucket = this.archGraph.componentIndex[bit];
				if (bucket === undefined || bucket.length === 0) {
					hasEmpty = true;
					break;
				}
				if (!smallestSet || bucket.length < smallestSet.length) smallestSet = bucket;
			}
			if (hasEmpty) break;
		}
		// If any required component has zero archetypes, no match is possible
		if (hasEmpty || !smallestSet) return [];

		const result: Archetype[] = [];
		for (let i = 0; i < smallestSet.length; i++) {
			const arch = this.archGet(smallestSet[i]);
			if (
				arch.matches(required) &&
				(!excluded || !arch.mask.overlaps(excluded)) &&
				(!anyOf || arch.mask.overlaps(anyOf))
			) {
				result.push(arch);
			}
		}
		return result;
	}

	/**
	 * Register a live query. Returns a mutable Archetype[] that this Store will
	 * push newly-created matching archetypes into, keeping the query always up-to-date.
	 */
	public registerQuery(include: BitSet, exclude?: BitSet, anyOf?: BitSet): Archetype[] {
		const result = this.getMatchingArchetypes(include, exclude, anyOf) as Archetype[];
		this.registeredQueries.push({
			includeMask: include.copy(),
			excludeMask: exclude ? exclude.copy() : null,
			anyOfMask: anyOf ? anyOf.copy() : null,
			result,
			query: null
		});
		return result;
	}

	public updateQueryRef(result: Archetype[], query: Query<any>): void {
		const rqs = this.registeredQueries;
		for (let i = 0; i < rqs.length; i++) {
			if (rqs[i].result === result) {
				rqs[i].query = query;
				return;
			}
		}
	}

	public get archetypeCount(): number {
		return this.archGraph.archetypes.length;
	}

	// =======================================================
	// Event channels — delegations to `EventRegistry` (event_registry.ts)
	// =======================================================

	public registerEvent<S extends EventShape<S>>(fields: readonly (keyof S & string)[]): EventDef<S> {
		return this.events.registerEvent<S>(fields);
	}

	public emitEvent(def: EventDef<any>, values: Record<string, number>): void {
		this.events.emitEvent(def, values);
	}

	public emitSignal(def: EventDef<EmptyEventSchema>): void {
		this.events.emitSignal(def);
	}

	public getEventReader<S extends EventShape<S>>(def: EventDef<S>): EventReader<S> {
		return this.events.getEventReader(def);
	}

	public clearEvents(): void {
		this.events.clearEvents();
	}

	/** `DEV`-only mid-update emit detection — see
	 * `EventRegistry.devBufferedEventCount`. */
	public _devBufferedEventCount(): number {
		return this.events.devBufferedEventCount();
	}

	public registerEventByKey<S extends EventShape<S>>(
		key: symbol,
		fields: readonly (keyof S & string)[]
	): EventDef<S> {
		return this.events.registerEventByKey<S>(key, fields);
	}

	// any: type-erased — caller recovers F from EventKey<F>
	public getEventDefByKey(key: symbol): EventDef<any> {
		return this.events.getEventDefByKey(key);
	}

	public hasEventKey(key: symbol): boolean {
		return this.events.hasEventKey(key);
	}

	// =======================================================
	// Resource storage — delegations to `ResourceRegistry` (resource_registry.ts)
	// =======================================================

	private readonly resources = new ResourceRegistry();

	public registerResource(key: symbol, value: unknown): void {
		this.resources.register(key, value);
	}

	public getResource(key: symbol): unknown {
		return this.resources.get(key);
	}

	public setResource(key: symbol, value: unknown): void {
		this.resources.set(key, value);
	}

	/** Fails closed on a missing key; the present → absent → present
	 * lifecycle — see `ResourceRegistry.remove`. */
	public removeResource(key: symbol): void {
		this.resources.remove(key);
	}

	public hasResource(key: symbol): boolean {
		return this.resources.has(key);
	}
}


