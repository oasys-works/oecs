/***
 * System — Function-based system types.
 *
 * Systems are plain functions, not classes. A SystemConfig defines the
 * system's update function, optional lifecycle hooks, and (Phase A+B of
 * issue #213) its access-surface declarations.
 *
 * ECS.registerSystem() assigns a unique SystemID and returns a frozen
 * SystemDescriptor — the identity handle used for scheduling and ordering.
 *
 * Lifecycle:
 *   onAdded(ctx)    — called once during ecs.startup()
 *   fn(ctx, dt)      — called every frame by the schedule
 *   onRemoved()     — called when the system is unregistered
 *   dispose()        — called during ecs.dispose()
 *
 * Access declarations (Phase B of issue #213): every SystemConfig declares
 * `reads` / `writes` (mandatory — empty arrays are explicit "this system
 * touches nothing", the deliberate thinking prompt) plus the OPTIONAL
 * `spawns` / `despawns` / `transitions` / `resourceReads` /
 * `resourceWrites` and the sparse/relation terms (issue #496 — a separate
 * id space from the dense archetype mask). An absent optional field reads
 * as empty — the same precedent #496 set for the sparse terms — so the
 * majority of systems needn't spell out five empty arrays. Safety is
 * unchanged: Schedule wraps each `fn` / `onAdded` call in
 * `accessCheck.enter / leave`; SystemContext + Archetype consult
 * `accessCheck` on every read/write, structural change, sparse/relation
 * mutation, and resource read/write. Undeclared access throws an `ECSError`
 * in `__DEV__` (design doc §5.1). The same declarations pre-warm the
 * archetype graph (#211; sparse/relations cause no archetype transition, so
 * they do not feed prewarm).
 *
 * `spawns` entries and `despawns` may reference a `Template` — registration
 * expands it to its component list, so an archetype declared once (template
 * + spawner + destroyer) stays declared once.
 *
 * Bare-fn (`registerSystem(fn)`) and 2-arg (`registerSystem(fn, qb)`)
 * overloads internally fill empty declarations. Such systems are subject
 * to the same runtime checks — any read/write/etc. they perform will
 * throw, so they remain useful only for trivial no-access systems (e.g.
 * "just bump a counter"). Production work uses the config form.
 *
 ***/

import { Brand, validateAndCast, isNonNegativeInteger } from "../../type_primitives";
import { ECSError, ECS_ERROR } from "./utils/error";
import type { ComponentDef } from "./component";
import type { SparseComponentDef } from "./sparse_store";
import type { RelationDef } from "./relation";
import type { ResourceKey } from "./resource";
import type { SystemContext } from "./query";
import type { BackendSystemHandle } from "./compute_backend";
import type { Template } from "./store";

export type SystemID = Brand<number, "system_id">;

export const asSystemId = (value: number) =>
	validateAndCast<number, SystemID>(
		value,
		isNonNegativeInteger,
		"SystemID must be a non-negative integer"
	);

export type SystemFn = (ctx: SystemContext, deltaTime: number) => void;

/** A pair describing a mid-tick archetype transition.
 * If an entity has every component in `whenHas`, the system may `add`
 * and/or `remove` the listed components, transitioning the entity to a
 * new archetype. Used by Phase C to pre-warm the archetype graph. */
export interface SystemTransition {
	readonly whenHas: readonly ComponentDef[];
	readonly add?: readonly ComponentDef[];
	readonly remove?: readonly ComponentDef[];
}

/** The access declaration as AUTHORED on a `SystemConfig`. `reads` /
 * `writes` are mandatory (empty arrays are explicit, not missing
 * annotations); the rarer structural and resource fields are optional with
 * absent = empty, mirroring the #496 sparse/relation precedent. `spawns`
 * entries and `despawns` accept a `Template` wherever a component list is
 * expected — registration expands it via `_normalizeAccess`. */
export interface SystemAccessConfig {
	/** Components the system READS but does not write. */
	readonly reads: readonly ComponentDef[];
	/** Components the system WRITES. A write is implicitly also a read. */
	readonly writes: readonly ComponentDef[];
	/** Archetype masks the system spawns entities into. Each entry is the
	 * union of components a spawned entity carries at flush time — an
	 * explicit def list, or a `Template` (expanded at registration). */
	readonly spawns?: readonly (readonly ComponentDef[] | Template)[];
	/** Components removed via `removeComponent` / `destroyEntity`.
	 * `destroyEntity` counts as removing every component on the entity —
	 * declare the superset. A `Template` entry expands to its component
	 * list, so a "destroys what the spawner spawns" system references the
	 * same declaration. */
	readonly despawns?: readonly (ComponentDef | Template)[];
	/** Mid-tick archetype transitions; see SystemTransition. */
	readonly transitions?: readonly SystemTransition[];
	/** Resources the system reads. */
	readonly resourceReads?: readonly ResourceKey<unknown>[];
	/** Resources the system writes. */
	readonly resourceWrites?: readonly ResourceKey<unknown>[];

	// --- Sparse-component / relation access (issue #496) ---
	// The dense fields above key the 128-bit archetype-mask id space
	// (`ComponentID`). Sparse components (`SparseComponentID`) and relations
	// (`RelationID`) are each a SEPARATE id space, so they get their own terms
	// rather than mis-keying through the dense sets. Safety for every optional
	// term is unchanged — a system that DOES mutate/read undeclared state still
	// throws in `__DEV__` (the accessCheck set is empty, so the check fails).
	// addSparse / removeSparse / setSparseField and addRelation /
	// removeRelation are WRITES; a write implies a read (mirroring the dense
	// rule), so a `*_writes` term also authorises reads of that handle.

	/** Sparse components the system READS via `getSparseField`
	 * (membership probes `hasSparse` are unchecked, mirroring `hasComponent`). */
	readonly sparseReads?: readonly SparseComponentDef[];
	/** Sparse components the system MUTATES via `addSparse` / `removeSparse` /
	 * `setSparseField`. A write implies a read. */
	readonly sparseWrites?: readonly SparseComponentDef[];
	/** Relations the system READS via `targetOf` / `targetsOf` / `sourcesOf`
	 * (`hasRelation` is unchecked, mirroring `hasComponent`). */
	readonly relationReads?: readonly RelationDef[];
	/** Relations the system MUTATES via `addRelation` / `removeRelation`.
	 * A write implies a read. */
	readonly relationWrites?: readonly RelationDef[];
}

/** The NORMALIZED access declaration a registered system carries — what
 * `SystemDescriptor` exposes and `accessCheck` / prewarm consume. Produced
 * from the authored `SystemAccessConfig` by `_normalizeAccess`: absent
 * optional fields are the shared frozen empties, and every `Template` in
 * `spawns` / `despawns` is expanded to its component list. */
export interface SystemAccessDeclaration extends SystemAccessConfig {
	readonly spawns: readonly (readonly ComponentDef[])[];
	readonly despawns: readonly ComponentDef[];
	readonly transitions: readonly SystemTransition[];
	readonly resourceReads: readonly ResourceKey<unknown>[];
	readonly resourceWrites: readonly ResourceKey<unknown>[];
}

export interface SystemConfig extends SystemAccessConfig {
	fn: SystemFn;
	name?: string;
	onAdded?: (ctx: SystemContext) => void;
	onRemoved?: () => void;
	dispose?: () => void;

	/** Components the system queries via `ctx.query(...)`, one group per query.
	 * OPTIONAL — when provided, `registerSystem` validates `queries ⊆ reads ∪
	 * writes` in `__DEV__` (#213 Phase D, `_assertQueriesDeclared`): a query term
	 * reads each listed component, so this fails fast at registration instead of
	 * at the first iteration's `accessCheck`. */
	queries?: readonly (readonly ComponentDef[])[];

	/** Grant this system FULL world access — it may read/write/add/remove/destroy
	 * ANY component, sparse, relation, or resource without declaring them. The
	 * `__DEV__` access check is bypassed for its whole span (a no-op in
	 * production, where the check is already compiled out). For trusted engine /
	 * host machinery that mutates components not known at registration — the
	 * host→ECS command-apply system (#681) is the canonical case; a save/load or
	 * debug system is another. Bevy's "exclusive system" in spirit: full access,
	 * and — under any future parallel scheduler — it would run alone. The schedule
	 * is sequential today, so here it is purely the access grant. Use sparingly;
	 * a normal system should declare exactly what it touches. */
	exclusive?: boolean;

	/** Opt this system into pluggable-backend execution (#622). When set **and**
	 * a `ComputeBackend` is attached to the ECS, the `Schedule` runs
	 * `backend.run(backendHandle)` in place of `fn`; otherwise `fn` runs as the
	 * TS fallback (a no-op `fn` ⇒ the system is effectively skipped when no
	 * backend is attached). The handle is opaque to the engine — minted by the
	 * backend. The system still declares its `reads`/`writes` so the access span
	 * around the backend call authorises the shared-memory it touches, and so the
	 * scheduler can order it. See `ComputeBackend`. */
	backendHandle?: BackendSystemHandle;
}

export interface SystemDescriptor extends Readonly<SystemConfig> {
	readonly id: SystemID;
	// Normalized by `_normalizeAccess` at registration: required (never
	// undefined) and Template-free, so internals consume plain def lists.
	readonly spawns: readonly (readonly ComponentDef[])[];
	readonly despawns: readonly ComponentDef[];
	readonly transitions: readonly SystemTransition[];
	readonly resourceReads: readonly ResourceKey<unknown>[];
	readonly resourceWrites: readonly ResourceKey<unknown>[];
}

const FROZEN_EMPTY: readonly never[] = Object.freeze([]);

/** A `spawns` entry / `despawns` element is a `Template` iff it's an object
 * (a `ComponentDef` is a branded number; a def list is an array). */
function isTemplate(v: readonly ComponentDef[] | ComponentDef | Template): v is Template {
	return typeof v === "object" && !Array.isArray(v);
}

/** @internal Normalize an authored access config into the declaration shape
 * a `SystemDescriptor` carries: absent optional fields become shared frozen
 * empties; `Template` references in `spawns` / `despawns` expand to their
 * component lists. Pure — does not mutate `config`. */
export function _normalizeAccess(config: SystemAccessConfig): SystemAccessDeclaration {
	let spawns: readonly (readonly ComponentDef[])[] = FROZEN_EMPTY;
	if (config.spawns !== undefined && config.spawns.length > 0) {
		spawns = config.spawns.map((entry) => (isTemplate(entry) ? entry.defs : entry));
	}

	let despawns: readonly ComponentDef[] = FROZEN_EMPTY;
	if (config.despawns !== undefined && config.despawns.length > 0) {
		const out: ComponentDef[] = [];
		for (const entry of config.despawns) {
			if (isTemplate(entry)) out.push(...entry.defs);
			else out.push(entry);
		}
		despawns = out;
	}

	return {
		reads: config.reads,
		writes: config.writes,
		spawns,
		despawns,
		transitions: config.transitions ?? FROZEN_EMPTY,
		resourceReads: config.resourceReads ?? FROZEN_EMPTY,
		resourceWrites: config.resourceWrites ?? FROZEN_EMPTY,
		sparseReads: config.sparseReads,
		sparseWrites: config.sparseWrites,
		relationReads: config.relationReads,
		relationWrites: config.relationWrites
	};
}

/** @internal Phase D lint (issue #213): in `__DEV__`, validate that every
 * component a system lists in `queries` is covered by `reads ∪ writes`. A query
 * term reads each listed component's presence/columns, so querying one the
 * system never declared read access to would throw at the first iteration
 * (`accessCheck`); this surfaces the drift between the two declarations at
 * registration instead. `exclusive` systems (full access, empty reads/writes)
 * are skipped, as are the bare-fn / 2-arg overloads (no `queries`). Pure —
 * throws `QUERY_ACCESS_UNDECLARED` on a violation, naming the offending ids. */
export function _assertQueriesDeclared(config: SystemConfig): void {
	const groups = config.queries;
	if (groups === undefined || config.exclusive === true) return;

	const declared = new Set<number>();
	for (const def of config.reads) declared.add(def.id);
	for (const def of config.writes) declared.add(def.id);

	const undeclared = new Set<number>();
	for (const group of groups) {
		for (const def of group) {
			if (!declared.has(def.id)) undeclared.add(def.id);
		}
	}
	if (undeclared.size === 0) return;

	const who = config.name !== undefined ? `'${config.name}' ` : "";
	throw new ECSError(
		ECS_ERROR.QUERY_ACCESS_UNDECLARED,
		`system ${who}declares queries over component id(s) [${[...undeclared].join(", ")}] not in ` +
			`reads ∪ writes (#213 Phase D). A query term reads each listed component, so add the id(s) ` +
			`to 'reads' (or to 'writes' if the system also mutates them).`
	);
}

/** @internal — empty access declaration shared by the bare-fn and 2-arg
 * `registerSystem` overloads. Systems registered via those overloads
 * have no declared access and therefore fail any runtime check; use the
 * config form when the system performs any ECS access. NOT exported from
 * the package barrel — call sites should never spread this directly. */
export const _INTERNAL_EMPTY_ACCESS: SystemAccessDeclaration = Object.freeze({
	reads: Object.freeze<ComponentDef[]>([]),
	writes: Object.freeze<ComponentDef[]>([]),
	spawns: Object.freeze<readonly ComponentDef[][]>([]),
	despawns: Object.freeze<ComponentDef[]>([]),
	transitions: Object.freeze<SystemTransition[]>([]),
	resourceReads: Object.freeze<ResourceKey<unknown>[]>([]),
	resourceWrites: Object.freeze<ResourceKey<unknown>[]>([]),
	sparseReads: Object.freeze<SparseComponentDef[]>([]),
	sparseWrites: Object.freeze<SparseComponentDef[]>([]),
	relationReads: Object.freeze<RelationDef[]>([]),
	relationWrites: Object.freeze<RelationDef[]>([])
});
