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
 * in `DEV` (design doc §5.1). The same declarations pre-warm the
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
import type { EntityID } from "./entity";
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
	readonly resourceReads?: readonly ResourceKey<any>[];
	/** Resources the system writes. */
	readonly resourceWrites?: readonly ResourceKey<any>[];

	// --- Sparse-component / relation access (issue #496) ---
	// The dense fields above key the 128-bit archetype-mask id space
	// (`ComponentID`). Sparse components (`SparseComponentID`) and relations
	// (`RelationID`) are each a SEPARATE id space, so they get their own terms
	// rather than mis-keying through the dense sets. Safety for every optional
	// term is unchanged — a system that DOES mutate/read undeclared state still
	// throws in `DEV` (the accessCheck set is empty, so the check fails).
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
	readonly resourceReads: readonly ResourceKey<any>[];
	readonly resourceWrites: readonly ResourceKey<any>[];
}

export interface SystemConfig extends SystemAccessConfig {
	// METHOD syntax (not `fn: SystemFn`), deliberately: methods relate
	// bivariantly under strictFunctionTypes, which is what lets a config whose
	// `fn` was typed against a NARROWED `SystemContext<A>` (§typestate) — or a
	// dynamically-built config typed against the permissive default — flow
	// through every `SystemConfig`-shaped seam without casts.
	fn(ctx: SystemContext, deltaTime: number): void;
	name?: string;
	onAdded?(ctx: SystemContext): void;
	onRemoved?: () => void;
	dispose?: () => void;

	/** Components the system queries via `ctx.query(...)`, one group per query.
	 * OPTIONAL — when provided, `registerSystem` validates `queries ⊆ reads ∪
	 * writes` in `DEV` (#213 Phase D, `_assertQueriesDeclared`): a query term
	 * reads each listed component, so this fails fast at registration instead of
	 * at the first iteration's `accessCheck`. */
	queries?: readonly (readonly ComponentDef[])[];

	/** Grant this system FULL world access — it may read/write/add/remove/destroy
	 * ANY component, sparse, relation, or resource without declaring them. The
	 * `DEV` access check is bypassed for its whole span (a no-op in
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

// ═══ Compile-time access typing (§typestate) ═══════════════════════════════
//
// The runtime access check (access_check.ts) mirrored at the type layer: the
// config-form `registerSystem` infers the declared access lists as literal
// tuples, computes a `DeclaredAccess` record from them with exactly the runtime
// rules (write ⊆ read, add = writes ∪ spawns ∪ transitions.add, remove =
// despawns ∪ transitions.remove, destroy ⇔ despawns non-empty, write-implies-
// read for sparse/relation/resource), and types the system's `ctx` as
// `SystemContext<DeclaredAccess<…>>`. Undeclared access then fails at COMPILE
// time with the same taxonomy the runtime check throws with in `DEV`.
//
// Encoding notes (each choice is load-bearing; validated empirically):
//   - The guarded `SystemContext` methods keep a STABLE type-param constraint
//     (`D extends ComponentDef<any>`) across all `A` instantiations and express
//     the access check as `def: D & DeclaredRead<A, D>` — a resolvable
//     conditional intersected into the parameter. Constraints that mention `A`
//     directly break assignability BETWEEN instantiations (a typed ctx would no
//     longer flow into a helper taking a bare `SystemContext`).
//   - The asserts resolve to `unknown` (intersection no-op) when declared, and
//     to a tuple carrying a human-readable message when not — the tuple shows
//     up verbatim in the compiler error.
//   - An intersection of two `ComponentDef` instantiations is NOT used
//     anywhere: TS relates multi-call-signature intersections leniently, which
//     silently disables the check.
//   - `SystemAccess` (all-`any`, `destroy: boolean`) doubles as the constraint
//     and the permissive default, so a bare `SystemContext` stays what it was
//     before — fully permissive — and `SystemContext<Narrow>` is assignable TO
//     it (measured covariance; `destroy` must be `boolean`, not `true`, for
//     that direction to hold).
//
// Known compile-time-only gaps (the runtime check still catches all of these):
// two components with IDENTICAL schemas are interchangeable (structural
// typing); two resource keys with the same `T` are interchangeable; relations
// are a single nominal type, so declaring ONE relation admits all of them.
// Escape hatch: annotate the config's `fn(ctx: SystemContext, dt)` explicitly
// to opt a system back into permissive typing (e.g. tests that deliberately
// violate access to assert the runtime throw).

/**
 * The type-level access record a `SystemContext` is parameterized by. Each
 * field is the UNION of handle types the system declared for that operation
 * (`never` = declared nothing). The interface itself is the permissive
 * default: every field `any`-typed, `destroy` undetermined.
 */
export interface SystemAccess {
	read: ComponentDef<any>;
	write: ComponentDef<any>;
	add: ComponentDef<any>;
	remove: ComponentDef<any>;
	destroy: boolean;
	sparseRead: SparseComponentDef<any>;
	sparseWrite: SparseComponentDef<any>;
	relationRead: RelationDef;
	relationWrite: RelationDef;
	resourceRead: ResourceKey<any>;
	resourceWrite: ResourceKey<any>;
}

/** `unknown` if `D` is in the system's declared read surface, else an error tuple. */
export type DeclaredRead<A extends SystemAccess, D> = [D] extends [A["read"]]
	? unknown
	: ["component is not declared in this system's reads/writes", D];

/** `unknown` if `D` is in the system's declared write surface, else an error tuple. */
export type DeclaredWrite<A extends SystemAccess, D> = [D] extends [A["write"]]
	? unknown
	: ["component is not declared in this system's writes", D];

/** `unknown` if `D` is an authorised addComponent target, else an error tuple. */
export type DeclaredAdd<A extends SystemAccess, D> = [D] extends [A["add"]]
	? unknown
	: ["component is not declared in this system's writes/spawns/transitions.add", D];

/** `unknown` if `D` is an authorised removeComponent target, else an error tuple. */
export type DeclaredRemove<A extends SystemAccess, D> = [D] extends [A["remove"]]
	? unknown
	: ["component is not declared in this system's despawns/transitions.remove", D];

export type DeclaredSparseRead<A extends SystemAccess, D> = [D] extends [A["sparseRead"]]
	? unknown
	: ["sparse component is not declared in this system's sparseReads/sparseWrites", D];

export type DeclaredSparseWrite<A extends SystemAccess, D> = [D] extends [A["sparseWrite"]]
	? unknown
	: ["sparse component is not declared in this system's sparseWrites", D];

/** Relations are one nominal type, so this only distinguishes "declared some
 * relation access" from "declared none" — the runtime check owns the rest.
 * Keyed on the call site's inferred `D` (like the component asserts) rather
 * than on `RelationDef` directly: a conditional whose check type is not a
 * signature type parameter resolves under the compiler's variance-annotation
 * validation markers and falsely flags the `out A` declaration (TS2636). */
export type DeclaredRelationRead<A extends SystemAccess, D> = [D] extends [A["relationRead"]]
	? unknown
	: ["no relation is declared in this system's relationReads/relationWrites"];

export type DeclaredRelationWrite<A extends SystemAccess, D> = [D] extends [A["relationWrite"]]
	? unknown
	: ["no relation is declared in this system's relationWrites"];

export type DeclaredResourceRead<A extends SystemAccess, K> = [K] extends [A["resourceRead"]]
	? unknown
	: ["resource key is not declared in this system's resourceReads/resourceWrites", K];

export type DeclaredResourceWrite<A extends SystemAccess, K> = [K] extends [A["resourceWrite"]]
	? unknown
	: ["resource key is not declared in this system's resourceWrites", K];

/** `destroyEntity` / `commands.despawn` argument: blocked (with a readable
 * error) only when the access record PROVES no despawns were declared. */
export type DestroyEntityArg<A extends SystemAccess> = [A["destroy"]] extends [false]
	? { "this system declares no despawns — destroyEntity/despawn is not permitted": never }
	: EntityID;

// Declaration-list shapes the typed config infers against. `any`-parameterized
// so literal def types survive inference (a bare `ComponentDef` constraint
// would still admit them, but these keep intent explicit).
export type DenseAccessDecl = readonly ComponentDef<any>[];
export type SpawnsAccessDecl = readonly (readonly ComponentDef<any>[] | Template<any>)[];
export type DespawnsAccessDecl = readonly (ComponentDef<any> | Template<any>)[];
export type TransitionsAccessDecl = readonly SystemTransition[];
export type SparseAccessDecl = readonly SparseComponentDef<any>[];
export type RelationsAccessDecl = readonly RelationDef[];
export type ResourcesAccessDecl = readonly ResourceKey<any>[];

// Element-type extractors, written as conditionals (not indexed accesses) so
// literal entries that OMIT an optional field resolve to `never` instead of
// erroring. A `Template` entry contributes its def-list union, mirroring
// `_normalizeAccess`'s runtime expansion.
type SpawnEntryDefs<E> = E extends Template<infer TDefs>
	? TDefs[number]
	: E extends readonly (infer D)[]
		? D
		: never;
type DespawnEntryDefs<E> = E extends Template<infer TDefs> ? TDefs[number] : E;
type TransitionAddDefs<T> = T extends { readonly add: readonly (infer D extends ComponentDef<any>)[] }
	? D
	: never;
type TransitionRemoveDefs<T> = T extends {
	readonly remove: readonly (infer D extends ComponentDef<any>)[];
}
	? D
	: never;

/**
 * Compute the `SystemAccess` record for a set of declared access lists —
 * the type-level `computeSets` (access_check.ts).
 */
export type DeclaredAccess<
	R extends DenseAccessDecl,
	W extends DenseAccessDecl,
	Sp extends SpawnsAccessDecl = readonly never[],
	De extends DespawnsAccessDecl = readonly never[],
	Tr extends TransitionsAccessDecl = readonly never[],
	SR extends SparseAccessDecl = readonly never[],
	SW extends SparseAccessDecl = readonly never[],
	RR extends RelationsAccessDecl = readonly never[],
	RW extends RelationsAccessDecl = readonly never[],
	QR extends ResourcesAccessDecl = readonly never[],
	QW extends ResourcesAccessDecl = readonly never[]
> = {
	read: R[number] | W[number];
	write: W[number];
	add: W[number] | SpawnEntryDefs<Sp[number]> | TransitionAddDefs<Tr[number]>;
	remove: DespawnEntryDefs<De[number]> | TransitionRemoveDefs<Tr[number]>;
	destroy: [De[number]] extends [never] ? false : true;
	sparseRead: SR[number] | SW[number];
	sparseWrite: SW[number];
	relationRead: RR[number] | RW[number];
	relationWrite: RW[number];
	resourceRead: QR[number] | QW[number];
	resourceWrite: QW[number];
};

/**
 * The config shape the typed `registerSystem` overload infers. Structurally a
 * `SystemConfig`, but every declaration list is its own type parameter (one
 * inference site each — inferring a single config-object type parameter breaks
 * contextual typing of `fn`), `queries` is constrained to `reads ∪ writes`
 * (the compile-time Phase D lint), and `fn` / `onAdded` receive the narrowed
 * context. `fn` and `onAdded` use METHOD syntax deliberately: methods relate
 * bivariantly, which is what lets an explicitly-annotated permissive
 * `fn(ctx: SystemContext, dt)` (the escape hatch) keep compiling.
 * `exclusive: true` configs take the dedicated permissive overload instead.
 */
export interface TypedSystemConfig<
	R extends DenseAccessDecl,
	W extends DenseAccessDecl,
	Sp extends SpawnsAccessDecl = readonly never[],
	De extends DespawnsAccessDecl = readonly never[],
	Tr extends TransitionsAccessDecl = readonly never[],
	SR extends SparseAccessDecl = readonly never[],
	SW extends SparseAccessDecl = readonly never[],
	RR extends RelationsAccessDecl = readonly never[],
	RW extends RelationsAccessDecl = readonly never[],
	QR extends ResourcesAccessDecl = readonly never[],
	QW extends ResourcesAccessDecl = readonly never[],
	A extends SystemAccess = DeclaredAccess<R, W, Sp, De, Tr, SR, SW, RR, RW, QR, QW>
> {
	readonly reads: R;
	readonly writes: W;
	readonly spawns?: Sp;
	readonly despawns?: De;
	readonly transitions?: Tr;
	readonly resourceReads?: QR;
	readonly resourceWrites?: QW;
	readonly sparseReads?: SR;
	readonly sparseWrites?: SW;
	readonly relationReads?: RR;
	readonly relationWrites?: RW;
	/** Compile-time mirror of the Phase D lint: every query term ∈ reads ∪ writes. */
	readonly queries?: readonly (readonly (R[number] | W[number])[])[];
	name?: string;
	fn(ctx: SystemContext<A>, deltaTime: number): void;
	onAdded?(ctx: SystemContext<A>): void;
	onRemoved?(): void;
	dispose?(): void;
	/** `boolean`, not `false`, so a config VALUE typed `SystemConfig` (whose
	 * `exclusive` is `boolean | undefined`) still matches this overload; a
	 * literal `exclusive: true` config matches the dedicated permissive
	 * overload first by declaration order. */
	exclusive?: boolean;
	backendHandle?: BackendSystemHandle;
}

export interface SystemDescriptor extends Readonly<SystemConfig> {
	readonly id: SystemID;
	// Normalized by `_normalizeAccess` at registration: required (never
	// undefined) and Template-free, so internals consume plain def lists.
	readonly spawns: readonly (readonly ComponentDef[])[];
	readonly despawns: readonly ComponentDef[];
	readonly transitions: readonly SystemTransition[];
	readonly resourceReads: readonly ResourceKey<any>[];
	readonly resourceWrites: readonly ResourceKey<any>[];
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

/** @internal Phase D lint (issue #213): in `DEV`, validate that every
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
			`reads ∪ writes. A query term reads each listed component, so add the id(s) ` +
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
	resourceReads: Object.freeze<ResourceKey<any>[]>([]),
	resourceWrites: Object.freeze<ResourceKey<any>[]>([]),
	sparseReads: Object.freeze<SparseComponentDef[]>([]),
	sparseWrites: Object.freeze<SparseComponentDef[]>([]),
	relationReads: Object.freeze<RelationDef[]>([]),
	relationWrites: Object.freeze<RelationDef[]>([])
});
