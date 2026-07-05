/***
 * accessCheck — Phase B of issue #213.
 *
 * Module-level singleton that enforces a system's declared access surface
 * (`reads` / `writes` / `spawns` / `despawns` / `transitions` /
 * `resourceReads` / `resourceWrites`, plus the optional sparse/relation
 * terms added in #496) at runtime in `DEV`. Schedule calls
 * `accessCheck.enter(desc)` before invoking the system's `fn` (or
 * `onAdded`) and `accessCheck.leave()` after; SystemContext + Archetype
 * call the per-op `check_*` methods which throw `ECSError` if the running
 * system touches something it didn't declare.
 *
 * Lookups are O(1): per-descriptor `Set<number>` (component ids) and
 * `Set<symbol>` (resource keys) are computed on first `enter()` and cached
 * on the descriptor via a non-enumerable property bag (see `_access_sets`).
 * The cost in dev is a single Set.has per access; in prod the entire module
 * is dead-code-eliminated by `DEV` guards at every call site.
 *
 * Sparse components (`SparseComponentID`) and relations (`RelationID`) are
 * each a SEPARATE id space from the dense archetype-mask `ComponentID` (#496).
 * Each gets its own `Set<number>` so a sparse id and a dense id sharing the
 * same numeric value never collide; a sparse/relation write implies a read,
 * exactly as for dense components.
 *
 * Outside-of-system calls (e.g. `ecs.addComponent(...)` from setup
 * code, or accesses inside `onAdded` callbacks before `enter()` is called
 * by Schedule for that descriptor) are intentionally not checked — there's
 * no active system to attribute the violation to.
 ***/

import type { ComponentDef, ComponentHandle } from "./component";
import type { SparseComponentDef } from "./sparse_store";
import { ANY_RELATION, type RelationDef } from "./relation";
import type { ResourceKey } from "./resource";
import type { SystemDescriptor } from "./system";
import { ECSError, ECS_ERROR } from "./utils/error";
import { componentLabel } from "./debug_names";

interface AccessSets {
	reads: Set<number>;
	writes: Set<number>;
	addAllowed: Set<number>;
	removeAllowed: Set<number>;
	hasDespawns: boolean;
	resourceReads: Set<symbol>;
	resourceWrites: Set<symbol>;
	// Separate id spaces from the dense sets above (#496) — see file header.
	sparseReads: Set<number>;
	sparseWrites: Set<number>;
	relationReads: Set<number>;
	relationWrites: Set<number>;
}

// WeakMap keyed on the frozen descriptor. The descriptor object is frozen and
// non-extensible (Object.freeze in registerSystem), so a symbol-keyed slot
// via defineProperty would fail; a WeakMap doesn't require mutating the
// descriptor and lets GC collect the cached sets when the descriptor goes
// away.
const _setsCache = new WeakMap<SystemDescriptor, AccessSets>();

function computeSets(desc: SystemDescriptor): AccessSets {
	const reads = new Set<number>();
	const writes = new Set<number>();
	const addAllowed = new Set<number>();
	const removeAllowed = new Set<number>();
	const resourceReads = new Set<symbol>();
	const resourceWrites = new Set<symbol>();
	const sparseReads = new Set<number>();
	const sparseWrites = new Set<number>();
	const relationReads = new Set<number>();
	const relationWrites = new Set<number>();

	for (let i = 0; i < desc.writes.length; i++) {
		const cid = desc.writes[i].id;
		writes.add(cid);
		// A write implies a read (design doc §3) — reading the same field
		// you write is normal (e.g. decrementing a counter you also read).
		reads.add(cid);
		// A declared write is also an authorised target of addComponent
		// (the system "owns" the column, so spawning a new value into it
		// is consistent with its access surface).
		addAllowed.add(cid);
	}
	for (let i = 0; i < desc.reads.length; i++) {
		reads.add(desc.reads[i].id);
	}
	for (let i = 0; i < desc.spawns.length; i++) {
		const spawn = desc.spawns[i];
		for (let j = 0; j < spawn.length; j++) {
			addAllowed.add(spawn[j].id);
		}
	}
	for (let i = 0; i < desc.transitions.length; i++) {
		const t = desc.transitions[i];
		if (t.add) {
			for (let j = 0; j < t.add.length; j++) {
				addAllowed.add(t.add[j].id);
			}
		}
		if (t.remove) {
			for (let j = 0; j < t.remove.length; j++) {
				removeAllowed.add(t.remove[j].id);
			}
		}
	}
	for (let i = 0; i < desc.despawns.length; i++) {
		// despawns is "components this system removes via removeComponent
		// OR destroys via destroyEntity". Both paths consult removeAllowed
		// for per-component checks; destroyEntity also checks `hasDespawns`
		// to permit the call at all.
		removeAllowed.add(desc.despawns[i].id);
	}
	for (let i = 0; i < desc.resourceReads.length; i++) {
		resourceReads.add(desc.resourceReads[i] as unknown as symbol);
	}
	for (let i = 0; i < desc.resourceWrites.length; i++) {
		const key = desc.resourceWrites[i] as unknown as symbol;
		resourceWrites.add(key);
		// A write implies a read, same as for components.
		resourceReads.add(key);
	}
	// Sparse / relation terms are OPTIONAL (#496) — a dense-only system omits
	// them entirely, so coalesce undefined to a no-op. Write implies read, same
	// as dense; add/remove/set_field all consult the `*_writes` set (sparse and
	// relation mutations are not split into add/remove/write like the dense
	// archetype path, because they trigger no archetype transition).
	const sparseW = desc.sparseWrites;
	if (sparseW !== undefined) {
		for (let i = 0; i < sparseW.length; i++) {
			const sid = sparseW[i] as unknown as number;
			sparseWrites.add(sid);
			sparseReads.add(sid);
		}
	}
	const sparseR = desc.sparseReads;
	if (sparseR !== undefined) {
		for (let i = 0; i < sparseR.length; i++) sparseReads.add(sparseR[i] as unknown as number);
	}
	const relationW = desc.relationWrites;
	if (relationW !== undefined) {
		for (let i = 0; i < relationW.length; i++) {
			const rid = relationW[i] as unknown as number;
			relationWrites.add(rid);
			relationReads.add(rid);
		}
	}
	const relationR = desc.relationReads;
	if (relationR !== undefined) {
		for (let i = 0; i < relationR.length; i++)
			relationReads.add(relationR[i] as unknown as number);
	}

	return {
		reads,
		writes,
		addAllowed,
		removeAllowed,
		hasDespawns: desc.despawns.length > 0,
		resourceReads,
		resourceWrites,
		sparseReads,
		sparseWrites,
		relationReads,
		relationWrites
	};
}

function setsFor(desc: SystemDescriptor): AccessSets {
	const cached = _setsCache.get(desc);
	if (cached !== undefined) return cached;
	const computed = computeSets(desc);
	_setsCache.set(desc, computed);
	return computed;
}

/** The reads-only access surface a run condition declares (#576). A condition
 * can only `reads` components (via a captured query) and `resourceReads`; every
 * mutation set is empty by construction, so the same `check_*` machinery rejects
 * any write/structural/resource-write a misbehaving predicate attempts. */
interface ConditionAccess {
	readonly name: string;
	readonly reads?: readonly ComponentDef[];
	readonly resourceReads?: readonly ResourceKey<any>[];
}

// Cached per condition object — built-ins and custom conditions are stable
// singletons, so the reads-only sets compute once. A WeakMap (not a descriptor
// property) because conditions are plain frozen-ish objects we don't mutate.
const _condSetsCache = new WeakMap<ConditionAccess, AccessSets>();

function computeConditionSets(cond: ConditionAccess): AccessSets {
	const reads = new Set<number>();
	const resourceReads = new Set<symbol>();
	if (cond.reads !== undefined) {
		for (let i = 0; i < cond.reads.length; i++) reads.add(cond.reads[i].id);
	}
	if (cond.resourceReads !== undefined) {
		for (let i = 0; i < cond.resourceReads.length; i++) {
			resourceReads.add(cond.resourceReads[i] as unknown as symbol);
		}
	}
	// Every mutation/structural set is empty: a condition that writes, adds,
	// removes, destroys, or writes a resource fails the corresponding check.
	// (Computed once per condition, so the fresh empty Sets are negligible.)
	return {
		reads,
		writes: new Set<number>(),
		addAllowed: new Set<number>(),
		removeAllowed: new Set<number>(),
		hasDespawns: false,
		resourceReads,
		resourceWrites: new Set<symbol>(),
		sparseReads: new Set<number>(),
		sparseWrites: new Set<number>(),
		relationReads: new Set<number>(),
		relationWrites: new Set<number>()
	};
}

function conditionSetsFor(cond: ConditionAccess): AccessSets {
	const cached = _condSetsCache.get(cond);
	if (cached !== undefined) return cached;
	const computed = computeConditionSets(cond);
	_condSetsCache.set(cond, computed);
	return computed;
}

class AccessCheck {
	private active: SystemDescriptor | null = null;
	private sets: AccessSets | null = null;
	// The label used in violation messages. Tracks `active` for a system span,
	// but a run-condition span (#576) has no descriptor — only this name — so the
	// failure helpers read the label here rather than off `active`.
	private activeName: string | null = null;
	// An `exclusive` system (#681) has full world access: every check_* below
	// passes for the whole span. Kept as an explicit flag (rather than leaving
	// `sets` null) so `isActive()` stays truthful inside the span.
	private exclusive = false;

	enter(desc: SystemDescriptor): void {
		this.active = desc;
		this.activeName = desc.name ?? `system_${desc.id}`;
		this.exclusive = desc.exclusive === true;
		// Exclusive systems get full access: leaving `sets` null makes every
		// check_* below pass (they all early-return on `sets === null`). No need
		// to enumerate every component — the bypass is the whole point.
		this.sets = this.exclusive ? null : setsFor(desc);
	}

	/** Open a reads-only span for a run condition (#576). No descriptor — a
	 * condition can gate a whole SystemSet, so it isn't attributable to one
	 * system — just its declared reads/resource_reads and a name for diagnostics.
	 * Paired with `leave()`. */
	enterCondition(cond: ConditionAccess): void {
		this.active = null;
		this.activeName = cond.name;
		this.sets = conditionSetsFor(cond);
	}

	leave(): void {
		this.active = null;
		this.activeName = null;
		this.sets = null;
		this.exclusive = false;
	}

	isActive(): boolean {
		return this.sets !== null || this.exclusive;
	}

	/** Current system descriptor, if any. Null during a run-condition span. */
	current(): SystemDescriptor | null {
		return this.active;
	}

	checkRead(def: ComponentHandle): void {
		if (this.sets === null) return;
		if (this.sets.reads.has(def.id)) return;
		this.failComponent("read", def, "reads");
	}

	checkWrite(def: ComponentHandle): void {
		if (this.sets === null) return;
		if (this.sets.writes.has(def.id)) return;
		this.failComponent("write", def, "writes");
	}

	checkAdd(def: ComponentHandle): void {
		if (this.sets === null) return;
		if (this.sets.addAllowed.has(def.id)) return;
		this.failComponent("addComponent", def, "spawns / transitions.add / writes");
	}

	checkRemove(def: ComponentHandle): void {
		if (this.sets === null) return;
		if (this.sets.removeAllowed.has(def.id)) return;
		this.failComponent("removeComponent", def, "despawns / transitions.remove");
	}

	checkDestroy(): void {
		if (this.sets === null) return;
		if (this.sets.hasDespawns) return;
		// ! safe: this.sets !== null implies this.activeName !== null
		const name = this.activeName!;
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' called destroyEntity but didn't declare any despawns — declare the components this system removes via destroyEntity in its 'despawns'`,
			{ system: name, op: "destroyEntity" }
		);
	}

	checkResourceRead(key: ResourceKey<any>): void {
		if (this.sets === null) return;
		const sym = key as unknown as symbol;
		if (this.sets.resourceReads.has(sym)) return;
		this.failResource("read", key, "resourceReads");
	}

	checkResourceWrite(key: ResourceKey<any>): void {
		if (this.sets === null) return;
		const sym = key as unknown as symbol;
		if (this.sets.resourceWrites.has(sym)) return;
		this.failResource("write", key, "resourceWrites");
	}

	// --- Sparse component / relation checks (#496) ---
	// Keyed against the dedicated sparse/relation sets, NOT the dense
	// `reads`/`writes` sets — the id spaces are disjoint by construction (see
	// file header). `def as unknown as number` recovers the SparseComponentID /
	// RelationID the branded handle erases to at runtime.

	checkSparseRead(def: SparseComponentDef): void {
		if (this.sets === null) return;
		const sid = def as unknown as number;
		if (this.sets.sparseReads.has(sid)) return;
		this.failSparse("read", sid, "sparseReads");
	}

	checkSparseWrite(def: SparseComponentDef): void {
		if (this.sets === null) return;
		const sid = def as unknown as number;
		if (this.sets.sparseWrites.has(sid)) return;
		this.failSparse("write", sid, "sparseWrites");
	}

	checkRelationRead(def: RelationDef): void {
		if (this.sets === null) return;
		const rid = def as unknown as number;
		if (this.sets.relationReads.has(rid)) return;
		this.failRelation("read", rid, "relationReads");
	}

	checkRelationWrite(def: RelationDef): void {
		if (this.sets === null) return;
		const rid = def as unknown as number;
		if (this.sets.relationWrites.has(rid)) return;
		this.failRelation("write", rid, "relationWrites");
	}

	/** A `(*, T)` wildcard (`Query.forEachRelatedTo`, #579) reads every
	 * relation's reverse index, so it can't name a specific relation — it is
	 * authorised by the `ANY_RELATION` sentinel in `relationReads`. Honoured here
	 * exactly like a per-relation read, just keyed on the reserved sentinel id
	 * (which computeSets folds into `relationReads` like any other entry). */
	checkRelationReadAny(): void {
		if (this.sets === null) return;
		if (this.sets.relationReads.has(ANY_RELATION as unknown as number)) return;
		this.failRelation(
			"(*, T) wildcard read",
			ANY_RELATION as unknown as number,
			"relationReads (as ANY_RELATION)"
		);
	}

	// --- Optional query-term scope (#592) ---
	// `Query.forEach` and `ChangedQuery.forEach` push the iterating query's
	// `_optional` term list for the span of the callback;
	// `Archetype.getOptionalColumnRead` then verifies the fetched component was
	// declared via `.optional(T)` — the term that authorizes the optional fetch.
	// This is what makes the optional term *consumed* rather than decorative: like
	// `reads:[T]` for required access, `.optional(T)` is the fetch's declaration,
	// checked here in `DEV`. A stack (not a single slot) handles re-entrant /
	// nested `forEach`. The optional scope is independent of the per-system
	// `enter`/`leave` above — a host-side `world.query(...).forEach` outside any
	// system still establishes one. No active scope ⇒ lenient: a manual
	// `query.archetypes` walk can't be attributed to an optional declaration, so it
	// isn't checked — mirroring the unchecked outside-of-system calls in the header.
	//
	// CAVEAT (#594 Task 3): the gate always attributes to the INNERMOST active
	// `forEach`. If you nest `forEach` and call `getOptionalColumnRead` on an
	// OUTER query's archetype inside the inner loop, it is checked against the inner
	// query's terms (a false throw or false pass). Per-query attribution isn't worth
	// the complexity for a dev-only assertion; iterate one query at a time, or read
	// the outer span before entering the inner loop.
	private optionalScopes: (readonly number[])[] = [];

	enterOptionalScope(optional: readonly number[]): void {
		this.optionalScopes.push(optional);
	}

	leaveOptionalScope(): void {
		this.optionalScopes.pop();
	}

	checkOptionalFetch(def: ComponentHandle): void {
		const depth = this.optionalScopes.length;
		if (depth === 0) return; // no active forEach scope — lenient (see above)
		const scope = this.optionalScopes[depth - 1];
		const cid = def.id;
		for (let i = 0; i < scope.length; i++) {
			if (scope[i] === cid) return;
		}
		throw new ECSError(
			ECS_ERROR.OPTIONAL_TERM_NOT_DECLARED,
			`getOptionalColumnRead fetched optional component ${cid} but the iterating query didn't declare it — add .optional(component) to the query before fetching it`
		);
	}

	private failComponent(op: string, def: ComponentHandle, missingField: string): never {
		// ! safe: every caller bails when this.sets is null, and both `enter` and
		// `enterCondition` set activeName alongside sets, so it is non-null here.
		const name = this.activeName!;
		const label = componentLabel(def);
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed ${op} on ${label} but didn't declare it — add it to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, component: def.id }
		);
	}

	private failSparse(op: string, sid: number, missingField: string): never {
		// ! safe: same as failComponent.
		const name = this.activeName!;
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed ${op} on sparse component ${sid} but didn't declare it — add it to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, sparse: sid }
		);
	}

	private failRelation(op: string, rid: number, missingField: string): never {
		// ! safe: same as failComponent.
		const name = this.activeName!;
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed ${op} on relation ${rid} but didn't declare it — add it to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, relation: rid }
		);
	}

	private failResource(op: string, key: ResourceKey<any>, missingField: string): never {
		// ! safe: same as failComponent.
		const name = this.activeName!;
		const label = (key as unknown as symbol).description ?? "<unnamed>";
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed resource ${op} on '${label}' but didn't declare it — add the resource key to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, resource: label }
		);
	}
}

export const accessCheck: AccessCheck = new AccessCheck();

/** @internal — test seam for unit tests that need a fresh tracker. */
export const _accessCheckInternals = {
	create: () => new AccessCheck(),
	setsFor
};
