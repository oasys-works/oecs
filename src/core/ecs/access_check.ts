/***
 * accessCheck, runtime enforcement of a system's declared access.
 *
 * Module-level singleton that enforces a system's declared access surface
 * (`reads` / `writes` / `spawns` / `despawns` / `transitions` /
 * `resourceReads` / `resourceWrites`, plus the optional sparse and relation
 * terms) at runtime in `DEV`. Schedule calls
 * `accessCheck.enter(desc)` before invoking the system's `fn` (or
 * `onAdded`) and `accessCheck.leave()` after. SystemContext + Archetype
 * call the per-op `check_*` methods which throw `ECSError` if the running
 * system touches something it didn't declare.
 *
 * Lookups are O(1): per-descriptor `Set<number>` (component ids) and
 * `Set<symbol>` (resource keys) are computed on first `enter()` and cached
 * on the descriptor via a non-enumerable property bag (see `_access_sets`).
 * The cost in dev is a single Set.has per access. In prod the entire module
 * is dead-code-eliminated by `DEV` guards at every call site.
 *
 * Sparse components (`SparseComponentID`) and relations (`RelationID`) are
 * each a separate id space from the dense archetype-mask `ComponentID`.
 * Each gets its own `Set<number>` so a sparse id and a dense id sharing the
 * same numeric value never collide. A sparse or relation write implies a read,
 * exactly as for dense components.
 *
 * Outside-of-system calls (e.g. `ecs.addComponent(...)` from setup
 * code, or accesses inside `onAdded` callbacks before `enter()` is called
 * by Schedule for that descriptor) are intentionally not checked. There's
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
	// Separate id spaces from the dense sets above, see file header.
	sparseReads: Set<number>;
	sparseWrites: Set<number>;
	relationReads: Set<number>;
	relationWrites: Set<number>;
}

// WeakMap keyed on the frozen descriptor. The descriptor object is frozen and
// non-extensible (Object.freeze in registerSystem), so a symbol-keyed slot
// via defineProperty would fail. A WeakMap doesn't require mutating the
// descriptor and lets GC collect the cached sets when the descriptor goes
// away.
const accessSetsCache = new WeakMap<SystemDescriptor, AccessSets>();

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
		// A write implies a read, reading the same field
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
		// or destroys via despawn". Both paths consult removeAllowed
		// for per-component checks. Despawn also checks `hasDespawns`
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
	// Sparse and relation terms are optional, a dense-only system omits
	// them entirely, so coalesce undefined to a no-op. Write implies read, same
	// as dense. Add, remove and set_field all consult the `*_writes` set (sparse and
	// relation mutations are not split into add, remove and write like the dense
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
	const cached = accessSetsCache.get(desc);
	if (cached !== undefined) return cached;
	const computed = computeSets(desc);
	accessSetsCache.set(desc, computed);
	return computed;
}

/** The reads-only access surface a run condition declares. A condition
 * can only `reads` components (via a captured query) and `resourceReads`. Every
 * mutation set is empty by construction, so the same `check_*` machinery rejects
 * any write, structural or resource-write a misbehaving predicate attempts. */
interface ConditionAccess {
	readonly name: string;
	readonly reads?: readonly ComponentDef[];
	readonly resourceReads?: readonly ResourceKey<any>[];
}

// Cached per condition object, built-ins and custom conditions are stable
// singletons, so the reads-only sets compute once. A WeakMap (not a descriptor
// property) because conditions are plain frozen-ish objects we don't mutate.
const conditionSetsCache = new WeakMap<ConditionAccess, AccessSets>();

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
	// Every mutation and structural set is empty: a condition that writes, adds,
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
	const cached = conditionSetsCache.get(cond);
	if (cached !== undefined) return cached;
	const computed = computeConditionSets(cond);
	conditionSetsCache.set(cond, computed);
	return computed;
}

class AccessCheck {
	private _activeSystem: SystemDescriptor | null = null;
	private _activeSets: AccessSets | null = null;
	// The label used in violation messages. Tracks `_activeSystem` for a system span,
	// but a run-condition span has no descriptor, only this name, so the
	// failure helpers read the label here rather than off `_activeSystem`.
	private _activeName: string | null = null;
	// An `_exclusive` system has full world access: every check_* below
	// passes for the whole span. Kept as an explicit flag (rather than leaving
	// `_activeSets` null) so `isActive()` stays truthful inside the span.
	private _exclusive = false;

	enter(desc: SystemDescriptor): void {
		this._activeSystem = desc;
		this._activeName = desc.name ?? `system_${desc.id}`;
		this._exclusive = desc.exclusive === true;
		// Exclusive systems get full access: leaving `_activeSets` null makes every
		// check_* below pass (they all early-return on `_activeSets === null`). No need
		// to enumerate every component, the bypass is the whole point.
		this._activeSets = this._exclusive ? null : setsFor(desc);
	}

	/** Open a reads-only span for a run condition. No descriptor, a
	 * condition can gate a whole SystemSet, so it isn't attributable to one
	 * system, only its declared reads and resource_reads and a name for diagnostics.
	 * Paired with `leave()`. */
	enterCondition(cond: ConditionAccess): void {
		this._activeSystem = null;
		this._activeName = cond.name;
		this._activeSets = conditionSetsFor(cond);
	}

	leave(): void {
		this._activeSystem = null;
		this._activeName = null;
		this._activeSets = null;
		this._exclusive = false;
	}

	isActive(): boolean {
		return this._activeSets !== null || this._exclusive;
	}

	/** Current system descriptor, if any. Null during a run-condition span. */
	current(): SystemDescriptor | null {
		return this._activeSystem;
	}

	assertRead(def: ComponentHandle): void {
		if (this._activeSets === null) return;
		if (this._activeSets.reads.has(def.id)) return;
		this._failComponent("read", def, "reads");
	}

	assertWrite(def: ComponentHandle): void {
		if (this._activeSets === null) return;
		if (this._activeSets.writes.has(def.id)) return;
		this._failComponent("write", def, "writes");
	}

	assertAdd(def: ComponentHandle): void {
		if (this._activeSets === null) return;
		if (this._activeSets.addAllowed.has(def.id)) return;
		this._failComponent("addComponent", def, "spawns / transitions.add / writes");
	}

	assertRemove(def: ComponentHandle): void {
		if (this._activeSets === null) return;
		if (this._activeSets.removeAllowed.has(def.id)) return;
		this._failComponent("removeComponent", def, "despawns / transitions.remove");
	}

	assertDespawn(): void {
		if (this._activeSets === null) return;
		if (this._activeSets.hasDespawns) return;
		// ! safe: this.sets !== null implies this.activeName !== null
		const name = this._activeName!;
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' called despawn but didn't declare any despawns, declare the components this system removes via despawn in its 'despawns'`,
			{ system: name, op: "despawn" }
		);
	}

	assertResourceRead(key: ResourceKey<any>): void {
		if (this._activeSets === null) return;
		const sym = key as unknown as symbol;
		if (this._activeSets.resourceReads.has(sym)) return;
		this._failResource("read", key, "resourceReads");
	}

	assertResourceWrite(key: ResourceKey<any>): void {
		if (this._activeSets === null) return;
		const sym = key as unknown as symbol;
		if (this._activeSets.resourceWrites.has(sym)) return;
		this._failResource("write", key, "resourceWrites");
	}

	// --- Sparse component and relation checks ---
	// Keyed against the dedicated sparse and relation sets, not the dense
	// `reads` and `writes` sets, the id spaces are disjoint by construction (see
	// file header). `def as unknown as number` recovers the SparseComponentID /
	// RelationID the branded handle erases to at runtime.

	assertSparseRead(def: SparseComponentDef): void {
		if (this._activeSets === null) return;
		const sid = def as unknown as number;
		if (this._activeSets.sparseReads.has(sid)) return;
		this._failSparse("read", sid, "sparseReads");
	}

	assertSparseWrite(def: SparseComponentDef): void {
		if (this._activeSets === null) return;
		const sid = def as unknown as number;
		if (this._activeSets.sparseWrites.has(sid)) return;
		this._failSparse("write", sid, "sparseWrites");
	}

	assertRelationRead(def: RelationDef): void {
		if (this._activeSets === null) return;
		const rid = def as unknown as number;
		if (this._activeSets.relationReads.has(rid)) return;
		this._failRelation("read", rid, "relationReads");
	}

	assertRelationWrite(def: RelationDef): void {
		if (this._activeSets === null) return;
		const rid = def as unknown as number;
		if (this._activeSets.relationWrites.has(rid)) return;
		this._failRelation("write", rid, "relationWrites");
	}

	/** A `(*, T)` wildcard (`Query.forEachRelatedTo`) reads every
	 * relation's reverse index, so it can't name a specific relation. It is
	 * authorised by the `ANY_RELATION` sentinel in `relationReads`. Honoured here
	 * exactly like a per-relation read, only keyed on the reserved sentinel id
	 * (which computeSets folds into `relationReads` like any other entry). */
	assertRelationReadAny(): void {
		if (this._activeSets === null) return;
		if (this._activeSets.relationReads.has(ANY_RELATION as unknown as number)) return;
		this._failRelation(
			"(*, T) wildcard read",
			ANY_RELATION as unknown as number,
			"relationReads (as ANY_RELATION)"
		);
	}

	// --- Optional query-term scope ---
	// `Query.forEach` and `ChangedQuery.forEach` push the iterating query's
	// `_optional` term list for the span of the callback
	// `Archetype.getOptionalColumnRead` then verifies the fetched component was
	// declared via `.optional(T)`, the term that authorizes the optional fetch.
	// This is what makes the optional term *consumed* rather than decorative: like
	// `reads:[T]` for required access, `.optional(T)` is the fetch's declaration,
	// checked here in `DEV`. A stack (not a single slot) handles re-entrant /
	// nested `forEach`. The optional scope is independent of the per-system
	// `enter` and `leave` above, a host-side `ecs.query(...).forEach` outside any
	// system still establishes one. No active scope ⇒ lenient: a manual
	// `query.archetypes` walk can't be attributed to an optional declaration, so it
	// isn't checked, mirroring the unchecked outside-of-system calls in the header.
	//
	// Caveat: the gate always attributes to the innermost active
	// `forEach`. If you nest `forEach` and call `getOptionalColumnRead` on an
	// outer query's archetype inside the inner loop, it is checked against the inner
	// query's terms (a false throw or false pass). Per-query attribution isn't worth
	// the complexity for a dev-only assertion. Iterate one query at a time, or read
	// the outer span before entering the inner loop.
	private _optionalScopes: (readonly number[])[] = [];

	enterOptionalScope(optional: readonly number[]): void {
		this._optionalScopes.push(optional);
	}

	leaveOptionalScope(): void {
		this._optionalScopes.pop();
	}

	assertOptionalFetch(def: ComponentHandle): void {
		const depth = this._optionalScopes.length;
		if (depth === 0) return; // no active forEach scope, lenient (see above)
		const scope = this._optionalScopes[depth - 1];
		const cid = def.id;
		for (let i = 0; i < scope.length; i++) {
			if (scope[i] === cid) return;
		}
		throw new ECSError(
			ECS_ERROR.OPTIONAL_TERM_NOT_DECLARED,
			`getOptionalColumnRead fetched optional component ${cid} but the iterating query didn't declare it, add .optional(component) to the query before fetching it`
		);
	}

	private _failComponent(op: string, def: ComponentHandle, missingField: string): never {
		// ! safe: every caller bails when this.sets is null, and both `enter` and
		// `enterCondition` set activeName alongside sets, so it is non-null here.
		const name = this._activeName!;
		const label = componentLabel(def);
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed ${op} on ${label} but didn't declare it, add it to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, component: def.id }
		);
	}

	private _failSparse(op: string, sid: number, missingField: string): never {
		// ! safe: same as failComponent.
		const name = this._activeName!;
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed ${op} on sparse component ${sid} but didn't declare it, add it to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, sparse: sid }
		);
	}

	private _failRelation(op: string, rid: number, missingField: string): never {
		// ! safe: same as failComponent.
		const name = this._activeName!;
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed ${op} on relation ${rid} but didn't declare it, add it to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, relation: rid }
		);
	}

	private _failResource(op: string, key: ResourceKey<any>, missingField: string): never {
		// ! safe: same as failComponent.
		const name = this._activeName!;
		const label = (key as unknown as symbol).description ?? "<unnamed>";
		throw new ECSError(
			ECS_ERROR.ACCESS_UNDECLARED,
			`system '${name}' performed resource ${op} on '${label}' but didn't declare it, add the resource key to '${missingField}' (see docs/api/systems.md)`,
			{ system: name, op, resource: label }
		);
	}
}

export const accessCheck: AccessCheck = new AccessCheck();

/** @internal, test seam for unit tests that need a fresh tracker. */
export const _accessCheckInternals = {
	create: () => new AccessCheck(),
	setsFor
};
