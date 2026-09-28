/**
 * The net, in the ECS. This is the implementation under test.
 *
 * We selected this representation to give pressure to the mechanisms that the long
 * run must use. We did not select it because it is the fastest method to hold a
 * graph.
 *
 *   Archetype migration, the type of an agent is a tag (CON, DUP, ERA or ROOT).
 *     Each agent also holds `Redex`, `Fresh`, `Age` and `Tainted` as components, and
 *     the ECS adds and removes them. Each of these operations moves a row between
 *     archetypes.
 *
 *   Relation mutation, the *agent at the end* of a port is an exclusive relation
 *     (`P0`, `P1` or `P2`). Therefore each rewrite changes the target of several of
 *     them. An `add` to an exclusive relation replaces the old target, and it gives
 *     no message. This operation uses the path that maintains the reverse index more
 *     than any other operation in the API. The *index* of the port at the other end
 *     is in a `u8` column. Therefore the relation graph and the column data must
 *     agree. They are two independent records of one fact, and the oracle compares
 *     them.
 *
 *   Observers, the ECS does not calculate the redex queue when a caller asks for
 *     it. The queue is a `Set`, and `onAdd` and `onRemove` observers on the `Redex`
 *     tag maintain it alone. The oracle compares the queue against a new scan, and
 *     against the reference. A structural observer runs only for a deferred
 *     operation in the schedule. Therefore each change below uses `ctx.commands`.
 *
 *   Change detection, `Touch.seq` counts the times a `setLink` used an agent as an
 *     endpoint. The reference counts the same number in its own `setLink`. Therefore
 *     the set of agents that a tick writes has an independent model. An `onSet`
 *     observer with the granularity of an entity must give exactly that set. A second
 *     `onSet` observer with the granularity of an archetype, and a `changed()` query,
 *     must give each archetype that holds one of those agents.
 *
 *   The enabled and disabled partition, the harness disables and enables agents
 *     through the host write seam. A default query must not show a disabled row.
 *     Therefore a disabled agent must not age and must keep `Fresh`, and the exact
 *     comparison of `Age.ticks` is the proof. `onDisable` and `onEnable` observers
 *     alone maintain a second set, as the redex queue does.
 *
 *   Sparse components, the `Watch` sparse component is present on an agent if and
 *     only if the agent is in an active pair. `andSparse` and `notSparse` must
 *     agree with that rule.
 *
 *   Events and resources, the rewrite system emits one event for each rewrite, and
 *     a reader in POST_UPDATE drains the channel. The driver compares the drained
 *     rows against the plan, row by row. A resource holds a phase number, and it
 *     gates a system through `runIfResourceEq`.
 *
 * `Fresh`, `Age`, `Touch`, `Quar` and `Tainted` have no meaning for the interaction
 * net. They make the archetype graph wider, and they keep columns that the ECS
 * writes. The reference model copies their rules exactly. Therefore the oracle checks
 * them, and it does not ignore them.
 */
import { ROOT, MAX_PORTS, NO_SLOT, PORTS, TYPE_NAME, applyRewrite, reduces } from "./spec.mjs";
import { mirrorF32Of, mirrorOf, mixDefaults, mixSchema } from "./mirror.mjs";
import { fingerprintEcs } from "./fingerprint.mjs";
import { ageStepI32 } from "./kernels.mjs";
import { aos } from "./aos.mjs";

/** The module that a `js` kernel names. The worker loads it by URL, and the
 * system body imports it, so one source serves both paths. */
export const KERNELS_URL = new URL("./kernels.mjs", import.meta.url).href;

/** The worker entry of the engine, as the unit tests reach it. Node resolves a
 * relative specifier by its extension. It strips the types itself. So the
 * worker runs the sources of the tree. A mutant lives in the bundle that the
 * host loads. It therefore reaches the host half of the pool alone. */
export const WORKER_URL = new URL("../../src/worker.ts", import.meta.url);

const SLOT_F = ["s0", "s1", "s2"];

/** How many entity ids of dead agents to keep for the check of the reverse index.
 * A dead target must hold no key in the reverse index of a `"clear"` relation, and
 * `assertSelfConsistent` reads the live agents only. Therefore this list is the
 * cohort that closes that gap. It has a limit, because the check is one call for
 * each id and for each relation. */
const DEAD_COHORT = 64;

export class EcsNet {
	/**
	 * @param lib the built oecs module (`{ ECS, SCHEDULE, ... }`)
	 * @param opts.strict verify each planned pair really is an active pair in the
	 *   ECS before rewriting it, so a divergence is attributed to the exact
	 *   rewrite that first disagreed rather than to the end-of-tick comparison.
	 * @param opts.prov `{ epochEvery, retain }`, or `null` to omit the provenance layer.
	 * @param opts.float use a world with no determinism, and add an `f64` mirror
	 *   column. A deterministic world rejects a float column, so this is the only
	 *   arm that can cover one. It gives up `stateHash`, `capture` and `restore`,
	 *   because those need determinism.
	 * @param opts.sab put the column store on a `SharedArrayBuffer` instead of a
	 *   plain `ArrayBuffer`. This is the opt-in profile that a worker or a WASM
	 *   compute backend needs. The complete oracle then runs over that backing,
	 *   which is a much better test of it than one unit test of the allocator.
	 * @param opts.record log each host command into a `HostCommandRecorder`. It
	 *   keeps the complete run, so a soak must leave it off.
	 * @param opts.storeBase the byte offset inside the backing where the store
	 *   header goes. Every offset the store writes is then relative to it. A WASM
	 *   module needs that, because a module owns the low addresses of its own
	 *   linear memory. A world at a non-zero base must give the same results as a
	 *   world at base 0.
	 * @param opts.maxBytes the byte ceiling of the backing. It is a hard ceiling
	 *   with no fallback, so a grow that passes it throws `STORE_CAP_EXCEEDED`.
	 * @param opts.allocator an `InPlaceBufferAllocator` to pass through
	 *   `memory: { backing: { allocator } }`. `fixedSabAllocator` reserves the
	 *   whole cap at construction and never grows.
	 * @param opts.parallel give the age bump a `parallel` config and install the
	 *   workers plugin. The system then runs as a `js` kernel across a pool, when
	 *   the caller attaches one. It runs its own body when the caller does not.
	 *   Both paths execute the body of `kernels.mjs`.
	 */
	constructor(
		lib,
		{
			strict = true,
			prov = null,
			float = false,
			record = false,
			sab = false,
			storeBase = 0,
			maxBytes = 0,
			allocator = null,
			parallel = false
		} = {}
	) {
		const {
			ECS,
			SCHEDULE,
			and,
			or,
			not,
			getEntityIndex,
			eventKey,
			signalKey,
			resourceKey,
			runIfResourceEq,
			installHostCommandSeam,
			HostCommandRecorder,
			bundle,
			snapshots,
			events,
			relations,
			observers,
			workers
		} = lib;
		// Kept for the names that only one check reads, such as `HIERARCHY_UNBOUNDED`.
		this._lib = lib;
		this.strict = strict;
		this.prov = prov; // { epochEvery, retain } or null to omit the layer entirely
		this.float = float;
		this.sab = sab;
		// A deterministic world gives `stateHash`, `capture` and `restore`. A world
		// with a float column cannot be deterministic, so it gives up those three.
		this.hashable = !float;
		// `memory: { backing: "shared" }` selects the `SharedArrayBuffer` backing. The root
		// entry carries the option, and `@oasys/oecs/shared` carries the allocators for
		// a caller that wants to pass one. Every line below this point is the same for
		// both backings, which is the point: the oracle then tests the whole engine over
		// the opt-in profile and not one allocator alone.
		const options = float ? {} : { deterministic: true };
		const memory = {};
		if (sab) memory.backing = "shared";
		// An allocator of the caller wins over the string form. It owns the real
		// ceiling, and `maxBytes` beside it is the declaration that the derivation
		// of the entity index reads.
		if (allocator !== null) memory.backing = { allocator };
		// A non-zero base moves every offset the store writes. The store then owns
		// `[storeBase, storeBase + capacity)` and it writes nothing below that.
		if (storeBase > 0) memory.storeBase = storeBase;
		if (maxBytes > 0) memory.maxBytes = maxBytes;
		if (sab || storeBase > 0 || maxBytes > 0) options.memory = memory;
		this.storeBase = storeBase;
		// The oracle drives capture and restore, so it installs the snapshot
		// plugin. A world that never captures does not, and does not carry
		// the serialization code.
		// The workers plugin joins the list for the parallel arm alone. A world that
		// never attaches a pool carries neither the pool nor the plan builder. The
		// other arms keep the shape that the package ships.
		this.parallel = parallel;
		// `aos` is a plugin written outside the package, from the root exports alone
		// (`aos.mjs`). It keeps two array-of-structs stores that the storage seam
		// takes into the destroy purge, the digest and the snapshot.
		const plugins = [snapshots(), events(), relations(), observers(), aos(lib)()];
		if (parallel) plugins.push(workers());
		this.ecs = ECS.create({ ...options, plugins });
		const ecs = this.ecs;

		// ── the host write seam ─────────────────────────────────────────────
		// Installed first, and before `startup()`, so its apply system sits at the
		// head of PRE_UPDATE. The harness enqueues the quarantine between ticks, and
		// the apply system drains it there. That is the only path in this harness
		// that mutates the world from outside the schedule, and it is the path a
		// level editor or a validated command stream uses.
		//
		// The recorder keeps each command of the complete run, so a soak with millions
		// of rewrites would hold a very large log. Therefore it is opt-in, and the
		// short cases turn it on.
		this.recorder = record ? new HostCommandRecorder(1) : null;
		this.queue = installHostCommandSeam(
			ecs,
			record ? { name: "net-host-apply", recorder: this.recorder } : { name: "net-host-apply" }
		);

		// ── components ──────────────────────────────────────────────────────
		// `registerTag()` takes no options, so tags that want a debug label go
		// through `registerComponent({}, { name })`, the same empty schema, but
		// errors and frame traces then name the agent type instead of a bare id.
		const tag = (name) => ecs.registerComponent({}, { name });
		// Indexed by the type constants, derived from the same table that defines
		// them, a hand-written array here would silently depend on its literal order
		// matching `CON`, `DUP`, `ERA` and `ROOT`.
		this.TAG = TYPE_NAME.map(tag);
		// Deterministic worlds reject float columns, so every field here is integral.
		this.Slot = ecs.registerComponent({ s0: "u8", s1: "u8", s2: "u8" }, { name: "Slot" });
		this.Redex = tag("Redex");
		this.Fresh = tag("Fresh");
		// `Age.fticks` exists in the float arm only. It holds the same integer that
		// `ticks` holds. An integer below 2^53 is exact in `f64`, so the comparison
		// stays exact and the run stays reproducible.
		this.Age = float
			? ecs.registerComponent({ ticks: "i32", fticks: "f64" }, { name: "Age" })
			: ecs.registerComponent({ ticks: "i32" }, { name: "Age" });
		// The column for the change detection. `setLink` increases it through
		// `ctx.updateField`, for both endpoints.
		this.Touch = ecs.registerComponent({ seq: "i32" }, { name: "Touch" });
		// The column for the row grain of the change detection. `redexMaintain`
		// copies `Touch.seq` into it for each touched agent through a chunk loop, and
		// records the row through `cols.ticks(Seen)`, so its `onSet` observer reads the
		// scan of the tick plane and never the dirty list. Nothing writes it by id.
		this.Seen = ecs.registerComponent({ n: "i32" }, { name: "Seen" });
		// A column that the host writes, through `queue.setField`. It counts the times
		// the quarantine disabled this agent.
		this.Quar = ecs.registerComponent({ count: "u8" }, { name: "Quar" });
		// One column of each integer kind, and of `f32` in the float arm. The net
		// alone holds `u8` and `i32`, so the row plane and the value paths of the
		// other kinds had no cover here. `mirror.mjs` gives the model: the mirrors
		// follow `Touch.seq`, and the constants keep the value that the template gave.
		this.Mix = ecs.registerComponent(mixSchema(float), { name: "Mix" });
		this._mixDefaults = mixDefaults(float);
		// A tag that the host adds and removes, through `queue.add` and
		// `queue.remove`. An agent holds it if and only if the agent is disabled.
		this.Tainted = tag("Tainted");
		// A sparse component, present if and only if the agent is in an active pair.
		// Its one field, `hits`, mirrors `Touch.seq` for each member: `redexMaintain`
		// writes the raw `seq` into it, and the `u8` column keeps the low byte. So the
		// model is `seq & 0xff`, the reference keeps no new state, and a store that
		// converts through the wrong type, or reads the wrong slot, shows on each
		// member at each comparison. The write goes through a sparse cursor for a
		// member that stays, and through the values of `addSparse` for a member that
		// joins, so both value paths of the sparse store run under the churn.
		this.Watch = ecs.registerSparseComponent({ hits: "u8" }, { name: "Watch" });
		// The cursors over `Watch`. A cursor made at host level is checked on each
		// `at()` against the system that runs, so `redexMaintain` must declare the
		// component in `sparseWrites`, which it does.
		this.watchWrite = ecs.sparseCursor(this.Watch);
		this.watchRead = ecs.sparseCursorRead(this.Watch);
		// Two stores a plugin owns, array-of-structs, beside the core's own. `Kin`
		// holds one record for each agent: its type and `Touch.seq`. `Pair` holds a
		// record for each agent in an active pair, the rule that `Watch` follows,
		// with `Touch.seq`. A rewrite destroys exactly the agents of an active pair,
		// so the destroy purge runs on `Pair` members at each rewrite. The reference
		// holds the type, the counter and the pairs, so both stores have an exact
		// model and the harness adds no state for them.
		this.kin = ecs.aos.define("net.Kin", ["type", "seq"]);
		this.pair = ecs.aos.define("net.Pair", ["seq"]);
		this.aosJoins = 0;
		// The row grain of the change detection, on a component that carries no
		// `onSet` observer. `Touch` and `Seen` get a tick plane from their
		// observers, so neither one can show what `trackRows` does. `Mix` has no
		// observer. Thus this call is the only reason it holds a plane. The reader
		// below reads that plane through `cols.ticksRead`.
		ecs.trackRows(this.Mix);

		// ── the template for a new agent ────────────────────────────────────
		// `ecs.template` makes an opaque archetype template, and `spawn` and
		// `spawnMany` consume it. The load path below uses it, so a direct create
		// into a prepared archetype has cover. `bundle` is the other authoring form,
		// and the template holds one of each.
		this.agentTemplates = this.TAG.map((t) =>
			ecs.template(
				t,
				bundle(this.Slot, { s0: NO_SLOT, s1: NO_SLOT, s2: NO_SLOT }),
				bundle(this.Touch, { seq: 0 }),
				bundle(this.Seen, { n: 0 }),
				bundle(this.Quar, { count: 0 }),
				bundle(this.Mix, this._mixDefaults)
			)
		);

		// ── relations ───────────────────────────────────────────────────────
		// "clear" is the right cleanup policy here: a rewrite always relinks every
		// port it disturbs, so a dangling reverse entry would be a bug rather than a
		// state to tolerate, and "delete" would cascade-destroy the redex's
		// innocent neighbours.
		this.P = [0, 1, 2].map(() =>
			ecs.relations.register({ exclusive: true, onDeleteTarget: "clear" })
		);

		// ── the provenance layer ────────────────────────────────────────────
		// A second entity population, an audit log of rewrites with epoch-based
		// retention, whose only purpose is to reach the relation surface the net's
		// own ports do not: multi target sets, the "delete" cascade, "orphan" plus
		// `compact()`, and the traversal helpers. See `prov.mjs` for the reasoning.
		if (prov !== null) {
			this.Record = ecs.registerComponent({ rule: "u8" }, { name: "Record" });
			this.Epoch = ecs.registerComponent({ index: "i32" }, { name: "Epoch" });
			// exclusive + "delete": despawning an epoch cascade-destroys its records.
			this.InEpoch = ecs.relations.register({ exclusive: true, onDeleteTarget: "delete" });
			// multi + "clear": a record's target set shrinks when a produced agent dies,
			// which is the reverse-index path no source-side edit exercises.
			this.Produced = ecs.relations.register({ multi: true, onDeleteTarget: "clear" });
			// multi + "orphan": pruned epochs stay referenced as dangling handles, which
			// is the documented reverse-index leak `compact()` reclaims.
			this.EpochAncestors = ecs.relations.register({ multi: true, onDeleteTarget: "orphan" });
			// exclusive + "clear": each record points at the record before it in the same
			// EPOCH. That makes a chain with hundreds of levels. `InEpoch` is one level
			// deep, so it cannot test `hierarchy` past depth 1, `maxDepth`, or the order
			// of a parent before its children. This chain can, because a parent and a
			// child are both `Record` entities and both are in the result set.
			this.PrevRec = ecs.relations.register({ exclusive: true, onDeleteTarget: "clear" });
			this.qRecords = ecs.query(this.Record);
			this.qEpochs = ecs.query(this.Epoch);
		}

		// ── queries ─────────────────────────────────────────────────────────
		// `qAgents` is a default query, so it does not show a disabled row.
		// `qAgentsAll` shows every row. The structural checks use `qAgentsAll`,
		// because the net contains its disabled agents. The difference between the
		// two is the assertion about the row partition.
		this.qAgents = ecs.query(this.Slot);
		this.qAgentsAll = ecs.query(this.Slot).includeDisabled();
		this.qRedex = ecs.query(this.Redex);
		this.qFresh = ecs.query(this.Fresh);
		this.qAge = ecs.query(this.Age);
		// The same mask over the disabled rows as well. `forEachChangedArchetype`, the
		// path behind an `onSet` observer with the granularity of an archetype, visits
		// each archetype with one or more rows, and an all-disabled archetype has rows.
		// A query with `includeDisabled()` keeps exactly those archetypes. Therefore this
		// query gives the upper bound for that observer.
		this.qAgeAll = ecs.query(this.Age).includeDisabled();
		this.qTainted = ecs.query(this.Tainted).includeDisabled();
		this.qWatch = ecs.query(this.Slot).andSparse(this.Watch);
		this.qWatchAll = ecs.query(this.Slot).includeDisabled().andSparse(this.Watch);
		this.qNoWatch = ecs.query(this.Slot).notSparse(this.Watch);
		// The change-detection queries. `changed()` needs its component in the include
		// mask of the query, and it gives back a `ChangedQuery`, which has `forEachArchetype`
		// alone. A `ChangedQuery` also composes, and the two spellings below must give
		// the same set.
		this.qTouchChanged = ecs.query(this.Touch).changed(this.Touch);
		// The chunk loop of `redexMaintain` walks this one. A default query, so a
		// disabled agent gets no record, which is the rule the dispatch applies.
		this.qSeen = ecs.query(this.Seen, this.Touch);
		// The same query over the disabled rows as well. A default query gives the
		// non-empty archetypes, and an archetype whose rows are all disabled is empty
		// for it. Therefore the default arm above cannot report such an archetype, and
		// this arm must. The pair is the check on `includeDisabled()` under `changed()`.
		this.qTouchChangedAll = ecs.query(this.Touch).includeDisabled().changed(this.Touch);
		this.qTouchChangedNoFresh = ecs.query(this.Touch).changed(this.Touch).not(this.Fresh);
		this.qTouchNoFreshChanged = ecs.query(this.Touch).not(this.Fresh).changed(this.Touch);
		this.qAgeChanged = ecs.query(this.Age).changed(this.Age);

		// ── the query verbs that the net models exactly ─────────────────────
		// `PORTS` is [3, 3, 1, 1]. Therefore a CON and a DUP hold ports 0, 1 and 2, and
		// an ERA and the ROOT hold port 0 alone. The relation of port 1 is present if and
		// only if the agent is a CON or a DUP. The reference already holds the type of
		// each agent. Therefore these queries need no new model, and their answer moves
		// with each rewrite.
		this.qWithP1 = ecs.query(this.Slot).includeDisabled().andRelation(this.P[1]);
		this.qWithoutP1 = ecs.query(this.Slot).includeDisabled().notRelation(this.P[1]);
		// The same question over the enabled rows alone. The two arms differ by exactly
		// the disabled agents. Therefore the pair also reads the row partition, through
		// a term that is neither a component nor a sparse component.
		this.qWithP1Enabled = ecs.query(this.Slot).andRelation(this.P[1]);
		// `optional` spans the archetypes that hold `Age` and the archetypes that do
		// not. A `Fresh` agent has no `Age` yet, so both spans occur in each run. The
		// absent span must be exactly the `Fresh` agents, and the present span must
		// carry the numbers that `compare` reads through `getField`. Therefore this is a
		// second path to a fact that the reference holds, and it is not a repetition.
		this.qOptionalAge = ecs.query(this.Slot).includeDisabled().optional(this.Age);
		// Exactly one ROOT exists. `nets.mjs` rejects a specification with any other
		// number, no rule makes a ROOT, and a pair that holds the ROOT is inert. The
		// quarantine can disable it, so this query must show the disabled rows.
		this.qRoot = ecs.query(this.TAG[ROOT]).includeDisabled();
		// The members of the active pairs, over the disabled rows as well. `firstEntity`
		// must give a member while the net reduces, and `undefined` in the idle tail.
		this.qRedexAll = ecs.query(this.Redex).includeDisabled();

		// ── the archetype terms, three spellings of one set ─────────────────
		// `freshPromote` removes `Fresh` and adds `Age` in one command batch.
		// Therefore an agent holds exactly one of the two, and "holds `Age`" and
		// "does not hold `Fresh`" name one set. The reference holds the age of each
		// agent, so the model gives that set, and it gives the complement.
		//
		// The chained form is the first spelling. The second nests `and`, `or` and
		// `not` inside one `where`. The third is a term of the harness's own making,
		// the shape a plugin contributes. All three must give the same archetypes
		// and the same entities.
		const termBase = ecs.query(this.Slot).includeDisabled();
		this.qAgedChain = termBase.and(this.Age).not(this.Fresh);
		// Every agent holds `Touch`, so `and(Age, Touch)` is "holds Age". The `or`
		// arm widens it to the active pairs, and the outer `not` takes the `Fresh`
		// ones back out. A `Fresh` agent in an active pair is what makes the `or`
		// arm and the `not` arm both do work.
		this.qAgedExpr = termBase.where(
			and(or(and(this.Age, this.Touch), this.Redex), not(this.Fresh))
		);
		// A term of the harness's own making. `matches` reads the component mask,
		// which is the whole interface a plugin term has.
		this.AgedTerm = {
			name: "aged",
			matches: (mask) => mask.has(this.Age.id) && !mask.has(this.Fresh.id)
		};
		this.qAgedTerm = termBase.where(this.AgedTerm);
		// The complement, over the same parent query. `where` caches on the identity
		// of the term. A cache that ignored the term would give this query the list
		// of the one above. The two sets are disjoint and they cover the net.
		this.UnagedTerm = { name: "unaged", matches: (mask) => !mask.has(this.Age.id) };
		this.qUnagedTerm = termBase.where(this.UnagedTerm);

		// ── the row grain of the change detection ───────────────────────────
		// `setLink` writes `Mix` for both endpoints, through `ctx.ref` and through
		// `ctx.cursor`. Both record the row. Therefore the rows of `Mix` that a tick
		// stamps are the agents that the reference counted in its own `setLink`.
		// That is the touched set of the model.
		//
		// The default arm drops a disabled row, as a chunk loop does. The
		// `includeDisabled()` arm keeps it. The `changed(Mix)` arm reaches the same
		// rows through the archetype filter first.
		this.qMixAll = ecs.query(this.Mix).includeDisabled();
		this.qMixEnabled = ecs.query(this.Mix);
		this.qMixChanged = ecs.query(this.Mix).includeDisabled().changed(this.Mix);

		// ── the observer-maintained redex queue ─────────────────────────────
		// The whole point: this Set is never recomputed, only pushed to by the two
		// callbacks. If a structural observer misses a transition, fires twice, or
		// fires for the wrong entity, this Set drifts from the rescan and the
		// reference, and nothing else in the harness would notice.
		this.observedRedex = new Set();
		this.observerAdds = 0;
		this.observerRemoves = 0;
		this.redexObserver = ecs.observe(this.Redex, {
			name: "redex-queue",
			access: { reads: [], writes: [] },
			onAdd: (e) => {
				if (this.observedRedex.has(e)) {
					throw new Error(`observer: onAdd for ${e}, which is already queued`);
				}
				this.observedRedex.add(e);
				this.observerAdds++;
			},
			onRemove: (e) => {
				if (!this.observedRedex.delete(e)) {
					throw new Error(`observer: onRemove for ${e}, which was not queued`);
				}
				this.observerRemoves++;
			}
		});

		// ── the observer-maintained record set ──────────────────────────────
		// Same discipline as the redex queue, but pointed at the cascade: records are
		// destroyed only *transitively*, by despawning their epoch parent. So this Set
		// staying correct is the assertion that a `"delete"` cascade fires `onRemove`
		// for every victim it destroys, a thing nothing else here would detect.
		this.observedRecords = new Set();
		this.recordAdds = 0;
		this.recordRemoves = 0;
		if (prov !== null) {
			this.recordObserver = ecs.observe(this.Record, {
				name: "record-log",
				access: { reads: [], writes: [] },
				onAdd: (e) => {
					if (this.observedRecords.has(e)) {
						throw new Error(`observer: record onAdd for ${e}, which is already logged`);
					}
					this.observedRecords.add(e);
					this.recordAdds++;
				},
				onRemove: (e) => {
					if (!this.observedRecords.delete(e)) {
						throw new Error(`observer: record onRemove for ${e}, which was not logged`);
					}
					this.recordRemoves++;
				}
			});
		}

		// ── the observer-maintained set of the changed entities ─────────────
		// An `onSet` observer with the granularity of an entity drains the dirty list
		// for each row. The registration of this observer is what turns that list on.
		// The driver compares this set against the set that the reference wrote, and
		// the comparison is exact in both directions. Refer to `driver.changeCheck`.
		this.setEntities = new Set();
		this.setEntityCalls = 0;
		this.touchEntityObserver = ecs.observe(this.Touch, {
			name: "touch-entity",
			granularity: "entity",
			access: { reads: [], writes: [] },
			onSet: (e) => {
				this.setEntities.add(e);
				this.setEntityCalls++;
			}
		});
		// The same observer on `Seen`. Its records come from `cols.ticks` in a chunk
		// loop alone, so this set is the exact test of the scan of the tick plane.
		this.seenEntities = new Set();
		this.seenEntityObserver = ecs.observe(this.Seen, {
			name: "seen-entity",
			granularity: "entity",
			access: { reads: [], writes: [] },
			onSet: (e) => {
				this.seenEntities.add(e);
			}
		});
		// The same observer on the sparse `Watch`. `redexMaintain` writes `hits`
		// through the mutable sparse cursor for a member that stays, and records
		// each such agent in `watchStayed` itself, while a joiner takes its value
		// through `addSparse`, which is structural and records nothing. So this
		// set must equal `watchStayed`, and the comparison is exact both ways.
		this.watchSetEntities = new Set();
		this.watchStayed = new Set();
		// The same record, with the disabled members kept. `ctx.sparseChanged` reads
		// the sparse tick directly, and it applies no rule about a disabled row.
		this.watchStamped = new Set();
		this.watchEntityObserver = ecs.observe(this.Watch, {
			name: "watch-entity",
			granularity: "entity",
			access: { reads: [], writes: [] },
			onSet: (e) => {
				this.watchSetEntities.add(e);
			}
		});
		// An `onSet` observer with the granularity of an archetype fires one time for
		// each archetype column that changed. It costs nothing, because it reads the
		// tick for the change that the write path already keeps. This set holds the
		// signature of each archetype, and not its id, so the reference can predict it.
		this.setArchSigs = new Set();
		this.setArchCalls = 0;
		this.touchArchObserver = ecs.observe(this.Touch, {
			name: "touch-arch",
			granularity: "archetype",
			access: { reads: [], writes: [] },
			onSet: (arch) => {
				this.setArchSigs.add(this._archSignature(arch));
				this.setArchCalls++;
			}
		});
		// The same observer on `Age`. `ageTick` below asks for the mutable column of
		// each archetype that it visits, and the documentation says that this sets the
		// tick for the change at that moment. Therefore this set must be equal to the
		// set of archetypes that `ageTick` visited, and the harness records that set
		// itself. The comparison is exact in both directions.
		this.setAgeArchIds = new Set();
		this.ageArchObserver = ecs.observe(this.Age, {
			name: "age-arch",
			granularity: "archetype",
			access: { reads: [], writes: [] },
			onSet: (arch) => {
				this.setAgeArchIds.add(arch.id);
			}
		});

		// ── the observer-maintained set of the disabled entities ────────────
		// `onDisable` and `onEnable` fire at the drain of the deferred toggle, one time
		// for each net transition. An immediate `ecs.disable()` from the host fires
		// nothing, so every toggle in this harness goes through the write seam. This
		// Set is never recomputed. Therefore it drifts if the ECS misses a transition,
		// or if it fails to collapse a disable, enable, disable sequence to one call.
		// `onRemove` is here for one reason: a despawn of a disabled agent gives no
		// `onEnable` call, because a destroy is not an enable. A despawn does fan
		// `onRemove` over the complete mask of the entity, so that callback is the
		// correct place to drop the dead entity. The set therefore stays under the
		// control of the observer callbacks alone. It also makes the fan-out of
		// `onRemove` over a destroy a checked behaviour: a despawn that failed to
		// report leaves a dead entity in the set, and the next tick finds it.
		this.observedDisabled = new Set();
		this.disableCalls = 0;
		this.enableCalls = 0;
		this.toggleObserver = ecs.observe(this.Slot, {
			name: "quarantine",
			access: { reads: [], writes: [] },
			onDisable: (e) => {
				if (this.observedDisabled.has(e)) {
					throw new Error(`observer: onDisable for ${e}, which is already quarantined`);
				}
				this.observedDisabled.add(e);
				this.disableCalls++;
			},
			onEnable: (e) => {
				if (!this.observedDisabled.delete(e)) {
					throw new Error(`observer: onEnable for ${e}, which was not quarantined`);
				}
				this.enableCalls++;
			},
			onRemove: (e) => {
				this.observedDisabled.delete(e);
			}
		});

		// ── events and resources ────────────────────────────────────────────
		// One event for each rewrite, with the rule and both entity ids. A reader in
		// POST_UPDATE drains the channel. The driver then compares the drained rows
		// against the plan of the tick, row by row. A channel that keeps its rows for
		// more than one tick fails that comparison, so the automatic clear has cover.
		this.RewriteEvent = eventKey("net-rewrite");
		this.EpochSignal = signalKey("net-epoch-roll");
		ecs.events.register(this.RewriteEvent, ["rule", "a", "b"]);
		ecs.events.registerSignal(this.EpochSignal);
		this.drainedEvents = [];
		this.drainedSignals = 0;
		/** The count of the commands that the harness put into the host queue. The
		 * recorder must log the same number. */
		this.enqueuedCommands = 0;
		// A resource that holds the phase number of the tick. The driver gives the
		// number, so the driver knows exactly which ticks the gate must permit.
		this.PhaseRes = resourceKey("net-phase");
		ecs.resources.register(this.PhaseRes, -1);
		this.gatedRuns = 0;

		// ── rewrite adapter (the seam `applyRewrite` drives) ────────────────
		this._ctx = null;
		this._created = [];
		this._touched = new Set();
		this.loops = 0;
		/** Entity ids of agents that a rewrite destroyed, most recent last. The check
		 * of the reverse index for a dead key reads this. */
		this._deadCohort = [];
		const self = this;
		this.adapter = {
			typeOf(e) {
				return self._typeOf(e);
			},
			getLink(e, p) {
				const t = self._ctx.targetOf(e, self.P[p]);
				return [t === undefined ? -1 : t, self._ctx.getField(e, self.Slot, SLOT_F[p])];
			},
			setLink(a, p, b, q) {
				const ctx = self._ctx;
				// Both directions, both stores: the relation carries the endpoint agent,
				// the column carries the port index on that agent.
				ctx.addRelation(a, self.P[p], b);
				ctx.setField(a, self.Slot, SLOT_F[p], q);
				ctx.addRelation(b, self.P[q], a);
				ctx.setField(b, self.Slot, SLOT_F[q], p);
				// The counter for the change detection, for both endpoints. `updateField`
				// reads the value and writes it back, so it covers the read-modify-write
				// path as well as the plain `setField` above. The reference counts the
				// same number in its own `setLink`.
				const sa = ctx.updateField(a, self.Touch, "seq", inc);
				const sb = ctx.updateField(b, self.Touch, "seq", inc);
				// The mirrors of the new counter, in each integer kind. One endpoint
				// writes through `ctx.ref`, and the other through `ctx.cursor`. Both
				// accessors share one prototype, and the two are different paths.
				const wa = ctx.ref(self.Mix, a);
				const ma = mirrorOf(sa);
				wa.m8 = ma.m8;
				wa.m16 = ma.m16;
				wa.mu16 = ma.mu16;
				wa.mu32 = ma.mu32;
				const wb = self._mixCursor.at(b);
				const mb = mirrorOf(sb);
				wb.m8 = mb.m8;
				wb.m16 = mb.m16;
				wb.mu16 = mb.mu16;
				wb.mu32 = mb.mu32;
				if (self.float) {
					wa.mf32 = mirrorF32Of(sa);
					wb.mf32 = mirrorF32Of(sb);
				}
				// Either endpoint's principal may have changed, so both need their
				// `Redex` tag re-derived at the end of the tick.
				self._touched.add(a);
				self._touched.add(b);
			},
			createAgent(type) {
				const e = self._ctx.commands.spawn(
					self.TAG[type],
					self.Slot({ s0: NO_SLOT, s1: NO_SLOT, s2: NO_SLOT }),
					self.Touch({ seq: 0 }),
					self.Seen({ n: 0 }),
					self.Quar({ count: 0 }),
					self.Mix(self._mixDefaults),
					self.Fresh
				);
				self._created.push(e);
				self._touched.add(e);
				return e;
			},
			destroyAgent(e) {
				self._ctx.commands.despawn(e);
				self._touched.delete(e);
				self._noteDead(e);
			},
			settle() {
				// The one flush per rewrite: applies the deferred spawns and despawns so
				// the following `setLink` calls address live rows, and fires the
				// structural observers for everything queued so far.
				self._ctx.flush();
			},
			onLoop() {
				self.loops++;
			}
		};

		// ── systems ─────────────────────────────────────────────────────────
		this._plan = [];
		this._tick = 0;
		this._phase = -1;
		this.byRef = new Map(); // reference agent id -> entity id
		this.byEcs = new Map(); // entity id -> reference agent id
		// the same map as `byEcs`, by the index of the entity and in a typed array.
		// The fingerprint reads it for each agent and for each link target, and a
		// typed-array read costs a fraction of a `Map` lookup. `-1` is "no agent".
		this._getEntityIndex = getEntityIndex;
		this.refOfIndex = new Int32Array(1 << 16).fill(-1);
		// Provenance bijections. Epoch entries are deliberately never pruned: the
		// orphan policy is about dangling handles, so verifying it needs the entity id
		// of an epoch that is already dead.
		this.recByRef = new Map(); // reference record serial -> entity id
		this.epochByIndex = new Map(); // reference epoch index -> entity id
		this.currentEpochEntity = -1;
		// The tail of the chain of records in the epoch that is open now. `provRoll`
		// resets it, so a chain never crosses an epoch boundary.
		this._chainTail = -1;
		this.rewritesApplied = 0;

		const allTags = this.TAG;
		const provComps = prov === null ? [] : [this.Record, this.Epoch];
		const provRels =
			prov === null ? [] : [this.InEpoch, this.Produced, this.EpochAncestors, this.PrevRec];
		const rewrite = ecs.registerSystem({
			name: "net-rewrite",
			reads: [],
			writes: [this.Slot, this.Touch, this.Mix, this.Fresh, ...allTags, ...provComps],
			spawns: [
				...allTags.map((t) => [
					t,
					this.Slot,
					this.Touch,
					this.Seen,
					this.Quar,
					this.Mix,
					this.Fresh
				]),
				...provComps.map((c) => [c])
			],
			// A despawn removes every component that the entity carries. Therefore this
			// list must name each one, and that includes the components that the host
			// adds through the write seam.
			despawns: [
				this.Slot,
				this.Touch,
				this.Seen,
				this.Quar,
				this.Mix,
				this.Tainted,
				this.Fresh,
				this.Age,
				this.Redex,
				...allTags,
				...provComps
			],
			relationReads: [...this.P, ...provRels],
			relationWrites: [...this.P, ...provRels],
			fn: (ctx) => {
				this._ctx = ctx;
				// The cursor for the mirrors of the second endpoint of each link. A cursor
				// checks its access at `at()`, so one made here serves the whole plan.
				this._mixCursor = ctx.cursor(this.Mix);
				for (let i = 0; i < this._plan.length; i++) {
					const step = this._plan[i];
					const ea = this.byRef.get(step.a);
					const eb = this.byRef.get(step.b);
					if (ea === undefined || eb === undefined) {
						throw new Error(`plan step ${i}: ref agents ${step.a}/${step.b} are not mapped`);
					}
					if (this.strict) this._assertActivePair(ctx, i, ea, eb, step);
					this._created.length = 0;
					applyRewrite(this.adapter, ea, eb);
					// The two implementations create the rule's right-hand side in the
					// same order, so zipping the two id lists is the whole bijection.
					const made = this._created;
					if (made.length !== step.made.length) {
						throw new Error(
							`plan step ${i}: ECS created ${made.length} agents, reference created ${step.made.length}`
						);
					}
					this._unbind(step.a);
					this._unbind(step.b);
					for (let k = 0; k < made.length; k++) this._bind(step.made[k], made[k]);
					this.rewritesApplied++;
					// One event for each rewrite. The reader in POST_UPDATE drains the
					// channel, and the driver compares the rows against this plan.
					ctx.emit(this.RewriteEvent, { rule: step.rule, a: ea, b: eb });

					// Log the rewrite. Ordering matters and mirrors the reference: the two
					// agents were despawned inside `applyRewrite` (and its `settle()` already
					// ran the `"clear"` cleanup that pulls them out of every older record's
					// `Produced` set), so this record only ever sees live targets.
					if (prov !== null && step.rec !== null && this.currentEpochEntity !== -1) {
						const rec = ctx.commands.spawn(this.Record({ rule: step.rule }));
						// Relations are immediate and legal on a not-yet-flushed entity, the
						// create half of `commands.spawn` is not deferred, only the components.
						ctx.addRelation(rec, this.InEpoch, this.currentEpochEntity);
						for (let k = 0; k < made.length; k++) {
							ctx.addRelation(rec, this.Produced, made[k]);
						}
						// Extend the chain inside this epoch. The first record of an epoch has
						// no parent, so it is the root of its chain.
						if (this._chainTail !== -1) ctx.addRelation(rec, this.PrevRec, this._chainTail);
						this._chainTail = rec;
						this.recByRef.set(step.rec, rec);
					}
				}
				this._plan = [];
				this._ctx = null;
				this._mixCursor = null;
			}
		});

		// Re-derive `Redex` for every agent a rewrite disturbed. Runs after the
		// rewrites in the same phase. Its adds and removes are deferred, so the observer
		// sees them at this system's flush.
		//
		// It also maintains the `Watch` Sparse component by the same rule. A sparse
		// add and a sparse remove are immediate, and a dense add and remove here are
		// deferred. Therefore this one system covers both paths, and the driver
		// compares the two results against one model.
		const redexMaintain = ecs.registerSystem({
			name: "net-redex-maintain",
			reads: [this.Slot, this.Touch, this.Seen, ...allTags],
			writes: [this.Seen],
			transitions: [{ whenHas: [this.Slot], add: [this.Redex], remove: [this.Redex] }],
			relationReads: this.P,
			sparseWrites: [this.Watch],
			fn: (ctx) => {
				const watch = this.watchWrite;
				// The row grain. One chunk loop over every agent copies `seq` into `Seen`
				// for each touched agent and records the row with one store into the
				// tick column. The deferred `Redex` add or remove below then moves some
				// of these rows in the flush of this phase, so the record must travel.
				const touched = this._touched;
				if (touched.size > 0) {
					this.qSeen.forEachColumns((cols, count) => {
						const seen = cols.mut(this.Seen).n;
						const seq = cols.read(this.Touch).seq;
						const t = cols.ticks(this.Seen);
						const eids = cols.arch.entityIds;
						const now = cols.tick;
						for (let i = 0; i < count; i++) {
							if (!touched.has(eids[i])) continue;
							seen[i] = seq[i];
							t[i] = now;
						}
					});
				}
				for (const e of this._touched) {
					if (!ctx.isAlive(e)) continue;
					const want = this._isActive(ctx, e);
					const has = ctx.hasComponent(e, this.Redex);
					if (want && !has) ctx.commands.add(e, this.Redex);
					else if (!want && has) ctx.commands.remove(e, this.Redex);
					// The sparse half. It is immediate, so it lands now and not at the flush.
					// `hits` mirrors `Touch.seq`: every agent whose `seq` changed this tick
					// is in `_touched`, because the same `setLink` adds both endpoints, so
					// a write here keeps the mirror exact for every member. The raw `seq`
					// goes in, and the `u8` column keeps the low byte.
					const hasW = ctx.hasSparse(e, this.Watch);
					if (want && !hasW) {
						ctx.addSparse(e, this.Watch, { hits: ctx.getField(e, this.Touch, "seq") });
					} else if (!want && hasW) {
						ctx.removeSparse(e, this.Watch);
					} else if (want) {
						watch.at(e);
						watch.hits = ctx.getField(e, this.Touch, "seq");
						// The sparse row grain reports this write, unless the agent is
						// disabled, which the dispatch hides as a default query does.
						if (!this.ecs.isDisabled(e)) this.watchStayed.add(e);
						// `ctx.sparseChanged` reads the same tick and applies no such rule,
						// so its expected set holds the disabled members as well.
						this.watchStamped.add(e);
					}
				}
				// `_touched` stays for `net-aos`, which runs next and clears it.
			}
		});

		// The two plugin stores, maintained for every agent a rewrite touched. It
		// runs after `redexMaintain`, so `Watch` already holds this tick's pairs,
		// and `Pair` follows it by the same rule. The declaration names the two
		// access domains in `domainWrites` alone, and the body reads `Kin` too, so
		// the rule that a write implies a read runs at each tick. The adds and the
		// removes are the plugin's own and immediate. The destroyed agents left
		// through the purge, inside the rewrite's flush.
		const kin = this.kin;
		const pair = this.pair;
		const aosMaintain = ecs.registerSystem({
			name: "net-aos",
			reads: [this.Touch],
			writes: [],
			domainWrites: [kin.domain, pair.domain],
			fn: (ctx) => {
				for (const e of this._touched) {
					if (!ctx.isAlive(e)) continue;
					const seq = ctx.getField(e, this.Touch, "seq");
					if (!kin.has(e)) {
						kin.add(e, { type: this._typeOfCtx(ctx, e), seq });
						this.aosJoins++;
					} else if (kin.get(e, "seq") !== seq) {
						kin.set(e, "seq", seq);
					}
					if (ctx.hasSparse(e, this.Watch)) {
						if (pair.has(e)) pair.set(e, "seq", seq);
						else pair.add(e, { seq });
					} else if (pair.has(e)) {
						// Unreached in a net: an agent leaves an active pair only when a
						// rewrite consumes the pair, and the rewrite destroys it, so the
						// purge takes the record first. The branch keeps the rule whole.
						pair.remove(e);
					}
				}
				this._touched.clear();
			}
		});

		// The promotion of `Fresh` to `Age(0)`. It runs one tick after the ECS makes
		// the agent. A promotion in the same tick removes `Fresh` before the
		// comparison at the tick boundary reads it. Then that component, and its edge
		// in the archetype graph, has no test. Each promoted agent makes two
		// archetype transitions: `Fresh` off, and `Age` on.
		//
		// `qFresh` is a default query. Therefore it does not show a disabled row, and
		// a disabled agent keeps `Fresh`. That is not a rule of this harness. It is
		// the behaviour that the row partition must give. `ref.promoteFresh` copies
		// it. The system runs in UPDATE, and the schedule below gives the reason: a
		// row that this tick disabled is visible there, and it is not visible in
		// PRE_UPDATE.
		const freshPromote = ecs.registerSystem({
			name: "net-fresh-promote",
			reads: [],
			writes: [this.Age],
			transitions: [{ whenHas: [this.Slot], add: [this.Age], remove: [this.Fresh] }],
			fn: (ctx) => {
				this.qFresh.forEachEntity((e) => {
					ctx.commands.remove(e, this.Fresh);
					ctx.commands.add(e, this.Age, float ? { ticks: 0, fticks: 0 } : { ticks: 0 });
				});
			}
		});

		// Epoch roll + retention prune, in PRE_UPDATE so the current epoch exists
		// before the rewrites that log into it. The prune is one `commands.despawn`
		// per retired epoch, and the `"delete"` cascade on `InEpoch` turns each of
		// those into a transitive destroy of every record that epoch holds, applied
		// at the PRE_UPDATE flush, where the record observer sees the victims.
		const provRoll =
			prov === null
				? null
				: ecs.registerSystem({
						name: "net-prov-roll",
						reads: [],
						writes: [this.Epoch],
						spawns: [[this.Epoch]],
						// A cascade destroy removes every component its victims carry, so the
						// record side has to be declared here too even though this system never
						// names a record.
						despawns: [this.Epoch, this.Record],
						relationReads: [this.InEpoch, this.EpochAncestors, this.Produced, this.PrevRec],
						relationWrites: [this.InEpoch, this.EpochAncestors, this.Produced, this.PrevRec],
						fn: (ctx) => {
							const roll = this._pendingRoll;
							if (roll === null) return;
							this._pendingRoll = null;
							const e = ctx.commands.spawn(this.Epoch({ index: roll.created }));
							// Chain to every epoch still in the window. Multi relation, and the
							// one whose targets are allowed to die and dangle.
							for (const idx of roll.ancestors) {
								const prev = this.epochByIndex.get(idx);
								if (prev !== undefined) ctx.addRelation(e, this.EpochAncestors, prev);
							}
							this.epochByIndex.set(roll.created, e);
							this.currentEpochEntity = e;
							// A chain of records never crosses an epoch boundary, so the new
							// epoch starts with no tail.
							this._chainTail = -1;
							for (const idx of roll.pruned) {
								const victim = this.epochByIndex.get(idx);
								if (victim !== undefined) ctx.commands.despawn(victim);
							}
							// A signal is an event with no field. It counts the rolls.
							ctx.emit(this.EpochSignal);
						}
					});

		// The per-tick age bump, one hot `i32` column write per live aged agent,
		// through the `forEachColumns` mutable path.
		//
		// `cols.mut(def)` sets the tick for the change at the moment of the call, and
		// it does that even if no write follows. This loop asks for that accessor for
		// each archetype that the query gives. Therefore each of those archetypes must
		// appear in a `changed(Age)` query and in the `onSet` observer on `Age`.
		// `changeRead` below lists the same archetypes through `forEachArchetype`, which walks
		// the same set. That list is the expected value, and it needs no model of the
		// archetype graph.
		//
		// The body is `ageStepI32` of `kernels.mjs`, and the `parallel` config below
		// names the same export. Therefore the sequential path and the pooled path
		// execute one source. A difference between them comes from the split.
		// `ageSequentialRuns` counts the runs of this body. It must stay at zero in a
		// world that holds a pool.
		this.ageSequentialRuns = 0;
		const ageParallel = parallel
			? {
					parallel: {
						kernel: { js: KERNELS_URL, export: "ageStepI32" },
						columns: [[this.Age, "ticks"]],
						minRows: 1,
						query: this.qAge
					}
				}
			: {};
		const ageTick = ecs.registerSystem({
			name: "net-age-tick",
			reads: [],
			writes: [this.Age],
			...ageParallel,
			fn: (ctx, dt) => {
				this.ageSequentialRuns++;
				this.qAge.forEachColumns((cols, count) => {
					const c = cols.mut(this.Age);
					ageStepI32(c.ticks, 0, count, dt);
					if (float) {
						const f = c.fticks;
						for (let i = 0; i < count; i++) f[i] += dt;
					}
				});
			}
		});

		// The reader for the change detection, in POST_UPDATE and last. It captures
		// what the two `changed()` queries report. The driver compares the capture
		// against the model. It must run after `ageTick`, because `ageTick` is what
		// sets the tick for `Age`.
		this.changedTouchSigs = new Set();
		this.changedTouchAllSigs = new Set();
		this.changedTouchNoFreshSigs = new Set();
		this.changedTouchNoFreshAltSigs = new Set();
		this.changedTouchEnts = new Set();
		this.changedAgeArchIds = new Set();
		this.changedAgeEnts = new Set();
		this.ageArchIdsNow = new Set();
		this.ageArchIdsAll = new Set();
		this.ageEntsNow = new Set();
		const changeRead = ecs.registerSystem({
			name: "net-change-read",
			reads: [this.Touch, this.Age, this.Fresh, ...allTags],
			writes: [],
			fn: () => {
				this.changedTouchSigs.clear();
				this.changedTouchEnts.clear();
				this.qTouchChanged.forEachArchetype((arch) => {
					this.changedTouchSigs.add(this._archSignature(arch));
					const ids = arch.entityIds;
					for (let i = 0; i < arch.entityCount; i++) this.changedTouchEnts.add(ids[i]);
				});
				// The arm that shows the disabled rows. An archetype whose rows are all
				// disabled is absent from the default arm above, and it must be present here.
				this.changedTouchAllSigs.clear();
				this.qTouchChangedAll.forEachArchetype((arch) => {
					this.changedTouchAllSigs.add(this._archSignature(arch));
				});
				// The same set through the two spellings of the composition. The
				// documentation says that they give one set, so they must agree.
				this.changedTouchNoFreshSigs.clear();
				this.qTouchChangedNoFresh.forEachArchetype((arch) => {
					this.changedTouchNoFreshSigs.add(this._archSignature(arch));
				});
				this.changedTouchNoFreshAltSigs.clear();
				this.qTouchNoFreshChanged.forEachArchetype((arch) => {
					this.changedTouchNoFreshAltSigs.add(this._archSignature(arch));
				});
				this.changedAgeArchIds.clear();
				this.changedAgeEnts.clear();
				this.qAgeChanged.forEachArchetype((arch) => {
					this.changedAgeArchIds.add(arch.id);
					const ids = arch.entityIds;
					for (let i = 0; i < arch.entityCount; i++) this.changedAgeEnts.add(ids[i]);
				});
				// The expected value for the two lines above, and for the `onSet` observer
				// on `Age`. `ageTick` ran a moment ago in this same phase, and it asked for
				// the mutable accessor of each archetype that this query gives. `forEachArchetype`
				// and `forEachColumns` walk the same list. Therefore this set is exactly the set
				// of archetypes whose `Age` column the tick wrote.
				this.ageArchIdsNow.clear();
				this.ageEntsNow.clear();
				this.qAge.forEachArchetype((arch) => {
					this.ageArchIdsNow.add(arch.id);
					const ids = arch.entityIds;
					for (let i = 0; i < arch.entityCount; i++) this.ageEntsNow.add(ids[i]);
				});
				this.ageArchIdsAll.clear();
				this.qAgeAll.forEachArchetype((arch) => this.ageArchIdsAll.add(arch.id));
			}
		});

		// ── the reader for the row grain ────────────────────────────────────
		// `cols.ticksRead(Mix)` is the row tick column that `ecs.trackRows(Mix)`
		// installed. `cols.since` is the change tick of the previous run of this
		// system. Therefore a row above it changed during this tick. The model says
		// which agents those are, because `setLink` writes `Mix` for both endpoints.
		//
		// Three arms. The default query drops a disabled row. The `includeDisabled()`
		// arm keeps it. `changed(Mix).forEachColumns` reaches the same rows behind the
		// filter on the archetype. The body runs on the cadence of the deep
		// comparison. The system runs at each tick, so `cols.since` still spans one
		// tick.
		this.rowChangedAll = new Set();
		this.rowChangedEnabled = new Set();
		this.rowChangedFiltered = new Set();
		const rowGrainRead = ecs.registerSystem({
			name: "net-row-grain",
			reads: [this.Mix],
			writes: [],
			fn: () => {
				if (!this._deep) return;
				collectChangedRows(this.qMixAll, this.Mix, this.rowChangedAll);
				collectChangedRows(this.qMixEnabled, this.Mix, this.rowChangedEnabled);
				collectChangedRows(this.qMixChanged, this.Mix, this.rowChangedFiltered);
			}
		});

		// ── the reader for the query verbs ──────────────────────────────────
		// These verbs need a system, and not a call of the harness between the ticks.
		// `getOptionalColumnRead` runs two checks in a development build: the read needs
		// the cover of a `reads:` declaration, and the query must have named the same
		// component in `optional`. A relation term needs the cover of `relationReads`.
		// Therefore this system is where the declaration and the read meet.
		//
		// The sets over each agent are O(live). A soak case holds hundreds of thousands
		// of agents, so the driver asks for them at a verification tick alone, through
		// `_deep`. The three cheap reads below it run at each tick.
		this.withP1 = new Set();
		this.withoutP1 = new Set();
		this.withP1Enabled = new Set();
		this.optionalAgeSeen = new Map();
		this.optionalAgeAbsent = new Set();
		this.optionalSpansWithAge = 0;
		this.optionalSpansWithoutAge = 0;
		this.rootSingle = -1;
		this.redexFirst = undefined;
		this.untilVisited = 0;
		this.untilArchTotal = 0;
		this.untilStopped = false;
		this.resourcePhase = -2;
		this.resourceHas = false;
		// The three spellings of the archetype term, and the complement.
		this.termChainEnts = new Set();
		this.termExprEnts = new Set();
		this.termPluginEnts = new Set();
		this.termUnagedEnts = new Set();
		this.termChainArchs = new Set();
		this.termExprArchs = new Set();
		this.termPluginArchs = new Set();
		// The members that `ctx.sparseChanged` reports for `Watch`.
		this.sparseChangedEnts = new Set();
		this._deep = false;
		const verifyRead = ecs.registerSystem({
			name: "net-verify-read",
			reads: [this.Slot, this.Age, this.Redex, ...allTags],
			writes: [],
			relationReads: [this.P[1]],
			sparseReads: [this.Watch],
			resourceReads: [this.PhaseRes],
			fn: (ctx) => {
				// `hasResource` and `getResource` from inside a system. The facade
				// `ecs.resources` is the host route, and `surface.mjs` reads that one. The
				// driver picks the phase number, so the expected value comes from the driver.
				this.resourceHas = ctx.hasResource(this.PhaseRes);
				this.resourcePhase = ctx.getResource(this.PhaseRes);

				// Exactly one ROOT. A production build skips the count in `singleEntity` and
				// gives the first match, so the value is the assertion in both builds.
				this.rootSingle = this.qRoot.singleEntity();

				// The first member of an active pair, or `undefined` when none is left.
				this.redexFirst = this.qRedexAll.firstEntity();

				// `some` must stop at the archetype that the predicate accepts, and
				// it must report that it stopped. The count of the archetypes that `forEachArchetype`
				// gives is the expected value, so this needs no model of the graph.
				this.untilArchTotal = 0;
				this.qAgentsAll.forEachArchetype(() => this.untilArchTotal++);
				this.untilVisited = 0;
				this.untilStopped = this.qAgentsAll.some(() => {
					this.untilVisited++;
					// Stop at the second archetype, when there is one.
					return this.untilVisited >= 2;
				});

				if (!this._deep) return;

				// The partition by port arity, through a relation term.
				this.withP1.clear();
				this.qWithP1.forEachEntity((e) => this.withP1.add(e));
				this.withoutP1.clear();
				this.qWithoutP1.forEachEntity((e) => this.withoutP1.add(e));
				this.withP1Enabled.clear();
				this.qWithP1Enabled.forEachEntity((e) => this.withP1Enabled.add(e));

				// The optional column. The absent span is the expected branch here, and it
				// is not an error.
				this.optionalAgeSeen.clear();
				this.optionalAgeAbsent.clear();
				this.qOptionalAge.forEachArchetype((arch) => {
					const ticks = arch.getOptionalColumnRead(this.Age, "ticks");
					const ids = arch.entityIds;
					if (ticks === undefined) {
						this.optionalSpansWithoutAge++;
						for (let i = 0; i < arch.entityCount; i++) this.optionalAgeAbsent.add(ids[i]);
						return;
					}
					this.optionalSpansWithAge++;
					for (let i = 0; i < arch.entityCount; i++) this.optionalAgeSeen.set(ids[i], ticks[i]);
				});

				// The archetype terms. Each spelling reports its archetypes and its
				// entities. The driver requires all three to agree. It also requires
				// them to equal the set that the model holds.
				collect(this.qAgedChain, this.termChainArchs, this.termChainEnts);
				collect(this.qAgedExpr, this.termExprArchs, this.termExprEnts);
				collect(this.qAgedTerm, this.termPluginArchs, this.termPluginEnts);
				collect(this.qUnagedTerm, null, this.termUnagedEnts);

				// The sparse row grain. `redexMaintain` recorded each member that it
				// wrote through the mutable sparse cursor. So the expected set is a
				// record of the harness, and the read here is a second path to it.
				this.sparseChangedEnts.clear();
				this.qAgentsAll.forEachEntity((e) => {
					if (ctx.sparseChanged(this.Watch, e)) this.sparseChangedEnts.add(e);
				});
			}
		});

		// ── the marks for the change detection ──────────────────────────────
		// `ctx.markChanged` records a row for the per-entity `onSet` observer, and it
		// makes no change to the tick for the change on the archetype. The engine gives
		// it for the hot loop that writes a column through `getColumnMut`, where the engine
		// sees no single write.
		//
		// Therefore a marked agent must appear in the set with the granularity of an
		// entity, and it must not put its archetype into `changed(Touch)`. The driver
		// picks the agents, so the model holds them.
		//
		// The idle tail is where the difference is sharp. No write happens there. So each
		// archetype layer must stay quiet, and the per-entity layer must report exactly
		// these agents.
		// The driver gives reference ids, and this system maps them. The map must happen
		// here, and not in the driver before the tick: the driver picks the agents after
		// the reference applied the rewrites, and the ECS binds the agents that the same
		// rewrites make during this tick. A map before the tick therefore gives
		// `undefined` for each new agent.
		this._marks = [];
		this.markCalls = 0;
		const markWrite = ecs.registerSystem({
			name: "net-mark",
			reads: [],
			writes: [this.Touch],
			fn: (ctx) => {
				for (let i = 0; i < this._marks.length; i++) {
					const e = this.byRef.get(this._marks[i]);
					// Each live reference agent has a binding by this phase. A gap is a fault
					// of the harness, and a silent skip would make the model agree with it.
					if (e === undefined) {
						throw new Error(`net-mark: ref agent ${this._marks[i]} has no ECS entity`);
					}
					ctx.markChanged(e, this.Touch);
				}
				this.markCalls += this._marks.length;
			}
		});

		// ── the explicit unlink of a relation, from a system ────────────────
		// A port of the net is exclusive, and a rewrite replaces its target with an
		// `add`. Each other unlink in the net comes from `onDeleteTarget`. Therefore
		// the explicit unlink has no cover in the net itself.
		//
		// `surface.mjs` covers `ecs.relations.remove`, which is the host route. This
		// system covers `ctx.removeRelation`, which is the route of a system, and which
		// the access check reads against `relationWrites`. The two are different paths.
		//
		// The target is a `Produced` set of the provenance layer. That set is multi with
		// `"clear"`, and `prov.mjs` compares it element by element. Therefore the model
		// holds the answer before and after the call. The net's own ports must keep the
		// symmetry of their links, so an unlink there would break layer 1.
		//
		// `ctx.hasRelation` asks whether the source holds any target. Therefore its
		// value after the removal is "the set still holds something", and the model
		// gives that number.
		this._unlink = null;
		this.unlinkCalls = 0;
		this.unlinkBefore = null;
		this.unlinkAfter = null;
		const unlinkWrite =
			prov === null
				? null
				: ecs.registerSystem({
						name: "net-unlink",
						reads: [],
						writes: [],
						relationReads: [this.Produced],
						relationWrites: [this.Produced],
						fn: (ctx) => {
							this.unlinkBefore = null;
							this.unlinkAfter = null;
							if (this._unlink === null) return;
							const { serial, targetRef } = this._unlink;
							const rec = this.recByRef.get(serial);
							const tgt = this.byRef.get(targetRef);
							// A gap in either map is a fault of the harness. A silent skip would make
							// the model agree with it.
							if (rec === undefined) throw new Error(`net-unlink: record ${serial} has no entity`);
							if (tgt === undefined)
								throw new Error(`net-unlink: agent ${targetRef} has no entity`);
							this.unlinkBefore = ctx.hasRelation(rec, this.Produced);
							ctx.removeRelation(rec, this.Produced, tgt);
							this.unlinkAfter = ctx.hasRelation(rec, this.Produced);
							this.unlinkCalls++;
						}
					});

		// The reader for the events, in POST_UPDATE. It drains both channels. An event
		// channel clears itself at the end of the update, so a row that this reader
		// sees at the next tick is a fault, and the driver finds it.
		const eventRead = ecs.registerSystem({
			name: "net-event-read",
			reads: [],
			writes: [],
			fn: (ctx) => {
				const r = ctx.readEvents(this.RewriteEvent);
				this.drainedEvents.length = 0;
				for (let i = 0; i < r.length; i++) {
					this.drainedEvents.push([r.rule[i], r.a[i], r.b[i]]);
				}
				this.drainedSignals = ctx.readEvents(this.EpochSignal).length;
			}
		});

		// The system that writes the resource, and the system that a run condition
		// gates on the value of that resource. The driver gives the phase number, so
		// the driver knows the exact set of ticks on which the gate must permit the
		// body to run.
		const phaseWrite = ecs.registerSystem({
			name: "net-phase-write",
			reads: [],
			writes: [],
			resourceWrites: [this.PhaseRes],
			fn: (ctx) => {
				ctx.setResource(this.PhaseRes, this._phase);
			}
		});
		const phaseGated = ecs.registerSystem({
			name: "net-phase-gated",
			reads: [],
			writes: [],
			fn: () => {
				this.gatedRuns++;
			}
		});

		// ── two phases of the harness, whose position is observable ─────────
		// The phase set is open, so the harness owns a slot of its own. It does not
		// contend for insertion order inside UPDATE. Each phase holds one census
		// system, and the model gives the exact value that each one must read.
		//
		// The census before UPDATE reads the count of the live agents at the start of
		// the tick. The census after UPDATE reads the count after the rewrites. That
		// is a different number on any tick whose rules do not cancel. Both read
		// `Age.ticks` of the ROOT, which `ageTick` increases in POST_UPDATE. So a
		// phase that drifted past POST_UPDATE reads one more.
		//
		// The order of the two `addPhase` calls is a requirement. A phase with no
		// constraint lands at the tail of its loop. Declaration order breaks the tie,
		// and every built-in is declared first. Therefore the census after UPDATE is
		// declared first. With its `after` dropped, its `before` alone puts it ahead
		// of UPDATE. It then reads the count of the wrong point. Declared second, it
		// would keep its place and the fault would hide.
		this.censusPostPhase = ecs.addPhase("net-census-post", {
			loop: "update",
			after: [SCHEDULE.UPDATE],
			before: [SCHEDULE.POST_UPDATE]
		});
		this.censusPrePhase = ecs.addPhase("net-census-pre", {
			loop: "update",
			before: [SCHEDULE.UPDATE]
		});
		this.censusPreLive = -1;
		this.censusPreRootAge = -1;
		this.censusPostLive = -1;
		this.censusPostRootAge = -1;
		// The ROOT never dies and no rule makes one, so this entity is fixed for the
		// whole run. `load` binds it.
		this.rootEntity = -1;
		const censusPre = ecs.registerSystem({
			name: "net-census-pre",
			reads: [this.Age],
			writes: [],
			fn: (ctx) => {
				this.censusPreLive = this._countAgents();
				this.censusPreRootAge = ctx.getField(this.rootEntity, this.Age, "ticks");
			}
		});
		const censusPost = ecs.registerSystem({
			name: "net-census-post",
			reads: [this.Age],
			writes: [],
			fn: (ctx) => {
				this.censusPostLive = this._countAgents();
				this.censusPostRootAge = ctx.getField(this.rootEntity, this.Age, "ticks");
			}
		});

		this._pendingRoll = null;
		// PRE_UPDATE holds the apply system of the write seam at its head, because
		// `installHostCommandSeam` ran first. The two systems below therefore read the
		// state of the quarantine from before this tick's toggles, because a deferred
		// disable lands at the flush at the end of the phase. `ref.promoteFresh` runs
		// before `ref.applyQuarantine` for that reason.
		ecs.addSystems(SCHEDULE.PRE_UPDATE, phaseWrite);
		if (provRoll !== null) ecs.addSystems(SCHEDULE.PRE_UPDATE, provRoll);
		// Same phase, explicitly ordered: the maintenance pass must see the rewrites'
		// finished wiring. Insertion order would tiebreak the same way, but the
		// constraint is the actual requirement, so it is stated.
		//
		// `freshPromote` is in UPDATE, and it is before the rewrites. The phase is the
		// reason. A `disable` command from the write seam is deferred, so it lands at
		// the flush at the end of PRE_UPDATE. A system in PRE_UPDATE therefore reads
		// the quarantine from before the toggles of this tick. Then it promotes a row
		// that this tick disabled. This system must skip such a row, because `qFresh`
		// is a default query. UPDATE is the first phase that shows the toggle.
		// Therefore this phase makes that behaviour possible to check.
		ecs.addSystems(
			SCHEDULE.UPDATE,
			{ system: freshPromote, ordering: { before: [rewrite] } },
			rewrite,
			{ system: redexMaintain, ordering: { after: [rewrite] } },
			{ system: aosMaintain, ordering: { after: [redexMaintain] } }
		);
		ecs.addSystems(
			SCHEDULE.POST_UPDATE,
			ageTick,
			eventRead,
			// the gate. `runIfResourceEq` compares the value of the resource with 0.
			{ system: phaseGated, runIf: runIfResourceEq(this.PhaseRes, 0) },
			// the marks go in before the reader. The engine dispatches the `onSet`
			// observers after each phase of the tick, so the phase is not important for
			// the marks. The order is here because it is the requirement, and not because
			// the insertion order gives it.
			{ system: markWrite, ordering: { after: [ageTick] } },
			// the unlink runs before the reader of the provenance layer sees the state at
			// the end of the tick. The driver applies the same change to the model.
			...(unlinkWrite === null ? [] : [unlinkWrite]),
			// Last, because it must see the tick that `ageTick` set.
			{ system: changeRead, ordering: { after: [ageTick, markWrite] } },
			// after `ageTick` as well, so the `Age` values that the optional column gives
			// are the values of this tick, which is what `compare` reads.
			{ system: verifyRead, ordering: { after: [ageTick] } },
			// the row grain. It must run after each write of `Mix` of this tick. Every
			// one of those is in UPDATE, so any place in POST_UPDATE serves.
			rowGrainRead
		);
		ecs.addSystems(this.censusPrePhase, censusPre);
		ecs.addSystems(this.censusPostPhase, censusPost);

		// ── the checkpoints inside a tick ───────────────────────────────────
		// the engine fires `phaseBoundary(phase)` at the point where a phase has run
		// and its flush has settled. That is the documented seam for a read of the
		// state between the phases of one frame. This sink takes the fingerprint of
		// the agents there (`fingerprint.mjs`), and the driver compares each one with
		// the reference at the matching point of its own sequence. Therefore a
		// divergence gets the phase that made it, and not only the tick.
		//
		// The seam is a development-build seam. In a production build `setTrace`
		// keeps an empty body, so the sink never fires, and `phaseSinkFired` stays
		// false. The driver reads that flag, and it does not expect a checkpoint
		// from a build that cannot give one.
		//
		// The `Redex` and `Watch` flags are absent from the PRE_UPDATE checkpoint. The
		// ECS derives both one tick after the load, through the maintenance system, and
		// the reference holds them from the start. Each later checkpoint holds them.
		this.phaseFp = new Map();
		this.phaseFpOn = false;
		this.phaseSinkFired = false;
		this.phaseSinkCalls = 0;
		const noop = () => {};
		ecs.setTrace({
			tickBegin: noop,
			tickEnd: noop,
			systemBegin: noop,
			systemEnd: noop,
			commandQueued: noop,
			flushBegin: noop,
			flushEnd: noop,
			observerFired: noop,
			eventEmitted: noop,
			eventRead: noop,
			phaseBoundary: (phase) => {
				this.phaseSinkFired = true;
				if (!this.phaseFpOn) return;
				// The two phases of the harness get no fingerprint. Each one is a scan
				// of every agent. The three built-in checkpoints already name the
				// segment of the tick that a divergence belongs to. The census systems
				// write nothing, so a checkpoint beside them would repeat one.
				if (
					phase !== SCHEDULE.PRE_UPDATE &&
					phase !== SCHEDULE.UPDATE &&
					phase !== SCHEDULE.POST_UPDATE
				) {
					return;
				}
				this.phaseSinkCalls++;
				this.phaseFp.set(phase, fingerprintEcs(this, { redex: phase !== SCHEDULE.PRE_UPDATE }));
			}
		});
		ecs.startup();
	}

	/** The fingerprint of the agents now. Refer to `fingerprint.mjs`. */
	fingerprint(opts) {
		return fingerprintEcs(this, opts);
	}

	// ── binding ─────────────────────────────────────────────────────────────
	_bind(refId, e) {
		this.byRef.set(refId, e);
		this.byEcs.set(e, refId);
		const i = this._getEntityIndex(e);
		if (i >= this.refOfIndex.length) {
			let n = this.refOfIndex.length;
			while (n <= i) n *= 2;
			const grown = new Int32Array(n).fill(-1);
			grown.set(this.refOfIndex);
			this.refOfIndex = grown;
		}
		this.refOfIndex[i] = refId;
	}
	_unbind(refId) {
		const e = this.byRef.get(refId);
		if (e !== undefined) {
			this.byRef.delete(refId);
			this.byEcs.delete(e);
			this.refOfIndex[this._getEntityIndex(e)] = -1;
		}
	}

	/** Remember a dead entity id for the check of the reverse index. */
	_noteDead(e) {
		this._deadCohort.push(e);
		if (this._deadCohort.length > DEAD_COHORT) this._deadCohort.shift();
	}

	/** The signature of an archetype, from an `ArchetypeView`. It must be equal to
	 * the string that `ref.refSignature` makes. `hasComponent` on a view takes a
	 * component id, and it is not access-checked, as `ctx.hasComponent` is not. */
	_archSignature(arch) {
		let t = -1;
		for (let i = 0; i < 4; i++) if (arch.hasComponent(this.TAG[i].id)) t = i;
		return (
			`${TYPE_NAME[t]}|${arch.hasComponent(this.Redex.id) ? "R" : ""}` +
			`${arch.hasComponent(this.Fresh.id) ? "F" : ""}` +
			`${arch.hasComponent(this.Age.id) ? "A" : ""}` +
			`${arch.hasComponent(this.Tainted.id) ? "T" : ""}`
		);
	}

	// ── loading ─────────────────────────────────────────────────────────────
	/**
	 * Build the initial net host-side (immediate ops), then mark every agent as
	 * touched so the first tick's maintenance system derives the initial `Redex`
	 * tags through `ctx.commands`, which means the observer-maintained queue is
	 * populated by the observer, never seeded behind its back.
	 *
	 * The spawn goes through a `Template`, by two paths. `ecs.spawn` appends one row
	 * and copies the bits that the template resolved one time (`widthBits`). Then
	 * `ecs.spawnMany` appends the rest of the group in one fill for each column,
	 * which converts through the true view. The constants of `Mix` come from the
	 * template alone, so each comparison reads what each path stored, and a fault in
	 * either one is visible on the agents that it made. The reference makes the same
	 * agents one at a time. Only the ECS has these two paths to test.
	 */
	load(spec) {
		const ecs = this.ecs;
		const ids = [];
		// Group the agents by type, because one template holds one archetype.
		const byType = [[], [], [], []];
		for (let i = 0; i < spec.types.length; i++) byType[spec.types[i]].push(i);
		for (let t = 0; t < 4; t++) {
			const n = byType[t].length;
			if (n === 0) continue;
			// The first half of the group one at a time, and the rest in one call. A
			// group of one takes the single path.
			const single = Math.max(1, n >> 1);
			const made = [];
			for (let k = 0; k < single; k++) made.push(ecs.spawn(this.agentTemplates[t]));
			if (n > single) {
				// A loop, and not a spread: a large net gives this call more arguments
				// than the engine of JavaScript accepts in one call.
				const rest = ecs.spawnMany(this.agentTemplates[t], n - single);
				for (let k = 0; k < rest.length; k++) made.push(rest[k]);
			}
			for (let k = 0; k < made.length; k++) {
				const e = made[k];
				ecs.addComponent(e, this.Age, this.float ? { ticks: 0, fticks: 0 } : { ticks: 0 });
				ids[byType[t][k]] = e;
				this._bind(byType[t][k], e);
				this._touched.add(e);
			}
		}
		for (const [a, pa, b, pb] of spec.wires) {
			const ea = ids[a];
			const eb = ids[b];
			ecs.relations.add(ea, this.P[pa], eb);
			ecs.setField(ea, this.Slot, SLOT_F[pa], pb);
			ecs.relations.add(eb, this.P[pb], ea);
			ecs.setField(eb, this.Slot, SLOT_F[pb], pa);
			// The same counter that the reference keeps in its own `load`, which calls
			// the same `setLink`. These host writes mark the dirty list for the row.
			// Therefore the first tick reports every agent of the initial net, and
			// `driver.changeCheck` expects that.
			const sa = ecs.updateField(ea, this.Touch, "seq", inc);
			const sb = ecs.updateField(eb, this.Touch, "seq", inc);
			// The mirrors, through the host cursor. The systems use `ctx.ref` and
			// `ctx.cursor`, so this is the third accessor path to the same columns.
			this._hostMirror(ea, sa);
			this._hostMirror(eb, sb);
		}
		// The one ROOT. `nets.mjs` rejects a specification with any other number, no
		// rule makes a ROOT, and no rule destroys one. Therefore this entity holds
		// for the whole run, and the census systems read its `Age` by id.
		this.rootEntity = this.qRoot.singleEntity();
		return this;
	}

	/** The count of the live agents, the disabled ones included. One read for each
	 * archetype, and none for each row, so a census system pays it at each tick. */
	_countAgents() {
		let n = 0;
		this.qAgentsAll.forEachArchetype((arch) => {
			n += arch.entityCount;
		});
		return n;
	}

	/** Write the mirrors of `seq` into `Mix` of `e`, from the host. */
	_hostMirror(e, seq) {
		const w = this.ecs.cursor(this.Mix).at(e);
		const m = mirrorOf(seq);
		w.m8 = m.m8;
		w.m16 = m.m16;
		w.mu16 = m.mu16;
		w.mu32 = m.mu32;
		if (this.float) w.mf32 = mirrorF32Of(seq);
	}

	// ── driving ─────────────────────────────────────────────────────────────
	/**
	 * Run one tick over `plan`, a list of `{ a, b, made, rule, rec }` in reference
	 * ids. `roll` is the epoch transition the reference already applied (or `null`),
	 * replayed here by the PRE_UPDATE system so both sides roll at the same point.
	 * `phase` is the number that the gated system's run condition tests.
	 *
	 * `quar` is the quarantine plan. It goes into the host write seam here, between
	 * ticks, which is the seam's intended use: a host buffers commands off-schedule,
	 * and the blessed apply system drains them at the head of PRE_UPDATE.
	 */
	runTick(plan, roll = null, quar = null, phase = -1, deep = false, marks = [], unlink = null) {
		// The three sets below hold one tick. Clear them here, so a set that the driver
		// reads after the tick holds that tick alone. The counters stay cumulative,
		// because the floors for non-vacuity read them.
		this.setEntities.clear();
		this.seenEntities.clear();
		this.watchSetEntities.clear();
		this.watchStayed.clear();
		this.watchStamped.clear();
		this.setArchSigs.clear();
		this.setAgeArchIds.clear();
		this._plan = plan;
		this._pendingRoll = roll;
		this._phase = phase;
		// The sets over each agent in `net-verify-read` are O(live). A soak case holds
		// hundreds of thousands of agents, so the driver asks for them at a verification
		// tick alone.
		this._deep = deep;
		// The agents that `net-mark` gives to `ctx.markChanged`. The driver picks them,
		// so the model holds them.
		this._marks = marks;
		// The one `Produced` pair that `net-unlink` removes on this tick, or `null`.
		this._unlink = unlink;
		if (quar !== null) this._enqueueQuarantine(quar);
		this.ecs.update(1);
		this._tick++;
	}

	/**
	 * Put one quarantine plan into the host queue.
	 *
	 * Each agent that this plan disables also gets the `Tainted` tag and a bump of
	 * the `Quar.count` column. Therefore one plan uses five of the seven kinds of
	 * host command: `disable`, `enable`, `add_component` and `remove_component`, plus
	 * `set_field`. `spawn` and `despawn` are in `surface.mjs`.
	 *
	 * `plan.churn` names agents that go disable, enable, disable in one drain. An
	 * observer fires one time for each net transition, so the ECS must collapse that
	 * sequence to a single `onDisable` call.
	 */
	_enqueueQuarantine(plan) {
		const q = this.queue;
		let n = 0;
		for (const a of plan.enable) {
			const e = this.byRef.get(a);
			if (e === undefined) continue;
			q.enable(e);
			q.remove(e, this.Tainted);
			n += 2;
		}
		for (const a of plan.disable) {
			const e = this.byRef.get(a);
			if (e === undefined) continue;
			q.disable(e);
			q.add(e, this.Tainted, {});
			q.setField(e, this.Quar, "count", plan.count.get(a));
			n += 3;
		}
		for (const a of plan.churn) {
			const e = this.byRef.get(a);
			if (e === undefined) continue;
			q.disable(e);
			q.enable(e);
			q.disable(e);
			q.add(e, this.Tainted, {});
			q.setField(e, this.Quar, "count", plan.count.get(a));
			n += 5;
		}
		this.enqueuedCommands += n;
		if (q.pendingCount !== n) {
			throw new Error(`host queue holds ${q.pendingCount} commands after enqueueing ${n}`);
		}
	}

	/** Live record entities, ascending. */
	liveRecordEntities() {
		const out = [];
		this.qRecords.forEachEntity((e) => out.push(e));
		out.sort((x, y) => x - y);
		return out;
	}

	/** Live epoch entities, ascending. */
	liveEpochEntities() {
		const out = [];
		this.qEpochs.forEachEntity((e) => out.push(e));
		out.sort((x, y) => x - y);
		return out;
	}

	// ── reads ───────────────────────────────────────────────────────────────
	_typeOf(e) {
		for (let t = 0; t < 4; t++) {
			if (this.ecs.hasComponent(e, this.TAG[t])) return t;
		}
		return -1;
	}
	/** Type via a context (inside a system), where `hasComponent` is the same call
	 * but the access checker is watching. */
	_typeOfCtx(ctx, e) {
		for (let t = 0; t < 4; t++) if (ctx.hasComponent(e, this.TAG[t])) return t;
		return -1;
	}
	_isActive(ctx, e) {
		const t = this._typeOfCtx(ctx, e);
		if (t < 0) return false;
		const f = ctx.targetOf(e, this.P[0]);
		if (f === undefined) return false;
		if (ctx.getField(e, this.Slot, "s0") !== 0) return false;
		const tf = this._typeOfCtx(ctx, f);
		return tf >= 0 && reduces(t, tf);
	}
	_assertActivePair(ctx, i, ea, eb, step) {
		const ta = this._typeOfCtx(ctx, ea);
		const tb = this._typeOfCtx(ctx, eb);
		const la = ctx.targetOf(ea, this.P[0]);
		const sa = ctx.getField(ea, this.Slot, "s0");
		if (la !== eb || sa !== 0) {
			throw new Error(
				`plan step ${i}: ECS pair (${ea},${eb}) [ref ${step.a},${step.b}] is not principal-linked ` +
					`. ${ea}.P0 -> ${la}:${sa}`
			);
		}
		if (!reduces(ta, tb)) {
			throw new Error(
				`plan step ${i}: ECS pair (${ea},${eb}) types ${TYPE_NAME[ta]}/${TYPE_NAME[tb]} do not reduce`
			);
		}
	}

	/** Host-side link read, for verification. */
	linkOf(e, p) {
		const t = this.ecs.relations.targetOf(e, this.P[p]);
		return [t === undefined ? -1 : t, this.ecs.getField(e, this.Slot, SLOT_F[p])];
	}

	/** Every live agent entity, ascending, the disabled ones included. The net holds
	 * its disabled agents, so every structural check reads this. */
	liveAgents() {
		const out = [];
		this.qAgentsAll.forEachEntity((e) => out.push(e));
		out.sort((x, y) => x - y);
		return out;
	}

	/** The agents that a default query shows. The difference between this and
	 * `liveAgents()` must be exactly the quarantine. */
	enabledAgents() {
		const out = [];
		this.qAgents.forEachEntity((e) => out.push(e));
		out.sort((x, y) => x - y);
		return out;
	}

	/**
	 * The three readings of the `Watch` sparse component.
	 *
	 * `redexMaintain` adds and removes `Watch` by the same rule that it uses for the
	 * `Redex` tag. A sparse add is immediate and a dense add is deferred, so the two
	 * halves take different paths to one result. The reference gives one expected set
	 * for both.
	 *
	 * `all` shows the disabled rows, and `enabled` does not. Therefore the difference
	 * between them is a second reading of the quarantine, through a sparse term.
	 */
	watchSets() {
		const all = new Set();
		const enabled = new Set();
		const none = new Set();
		this.qWatchAll.forEachEntity((e) => all.add(e));
		this.qWatch.forEachEntity((e) => enabled.add(e));
		this.qNoWatch.forEachEntity((e) => none.add(e));
		return { all, enabled, none };
	}

	/** The entities that carry the `Tainted` tag, which the host adds. It must be
	 * exactly the quarantine. */
	taintedEntities() {
		const out = new Set();
		this.qTainted.forEachEntity((e) => out.add(e));
		return out;
	}

	/** The redex set recomputed from scratch, the independent check on the
	 * observer-maintained one. */
	rescanRedex() {
		const set = new Set();
		for (const e of this.liveAgents()) {
			const t = this._typeOf(e);
			if (t < 0) continue;
			const [f, q] = this.linkOf(e, 0);
			if (f === -1 || q !== 0) continue;
			const tf = this._typeOf(f);
			if (tf >= 0 && reduces(t, tf)) set.add(e);
		}
		return set;
	}

	census() {
		const c = [0, 0, 0, 0];
		for (const e of this.liveAgents()) {
			const t = this._typeOf(e);
			if (t >= 0) c[t]++;
		}
		return c;
	}

	/** Distinct archetypes the agent population currently occupies, the
	 * non-vacuity signal for "this really is exercising migration". The string is
	 * the same one `_archSignature` and `ref.refSignature` make. */
	archetypeSignatures() {
		const sigs = new Set();
		for (const e of this.liveAgents()) {
			const t = this._typeOf(e);
			sigs.add(
				`${TYPE_NAME[t]}|${this.ecs.hasComponent(e, this.Redex) ? "R" : ""}` +
					`${this.ecs.hasComponent(e, this.Fresh) ? "F" : ""}` +
					`${this.ecs.hasComponent(e, this.Age) ? "A" : ""}` +
					`${this.ecs.hasComponent(e, this.Tainted) ? "T" : ""}`
			);
		}
		return sigs;
	}

	/**
	 * Canonical encoding of the ROOT-reachable net, identical in construction to
	 * `RefNet.canonical()`.
	 *
	 * This is the one comparison in the harness that does **not** go through the
	 * driver's id bijection: it renumbers agents by BFS discovery order, so two
	 * nets match iff they are isomorphic regardless of how ids were allocated. That
	 * makes it both a bijection-free cross-check against the reference and the
	 * basis for comparing normal forms produced under different reduction orders.
	 */
	canonical() {
		let root = -1;
		const agents = this.liveAgents();
		for (const e of agents) {
			if (this._typeOf(e) === ROOT) {
				root = e;
				break;
			}
		}
		if (root === -1) return { form: "<no root>", reachable: 0, unreachable: agents.length };
		const idx = new Map();
		const order = [];
		const push = (e) => {
			if (e !== -1 && !idx.has(e)) {
				idx.set(e, order.length);
				order.push(e);
			}
		};
		push(root);
		for (let i = 0; i < order.length; i++) {
			const e = order[i];
			for (let p = 0; p < PORTS[this._typeOf(e)]; p++) push(this.linkOf(e, p)[0]);
		}
		const parts = [];
		for (let i = 0; i < order.length; i++) {
			const e = order[i];
			const t = this._typeOf(e);
			const links = [];
			for (let p = 0; p < PORTS[t]; p++) {
				const [f, q] = this.linkOf(e, p);
				links.push(`${idx.get(f)}.${q}`);
			}
			parts.push(`${TYPE_NAME[t]}[${links.join(" ")}]`);
		}
		return {
			form: parts.join(" "),
			reachable: order.length,
			unreachable: agents.length - order.length
		};
	}

	/**
	 * Verify the provenance layer against its reference model.
	 *
	 * Covers, in order: the cascade's exact victim set, multi target sets shrinking
	 * because a *target* died, `targetsOf` ordering, the reverse index on both
	 * relations, the observer-maintained record set (the proof that cascade victims
	 * fire `onRemove`), the traversal helpers over a deep chain, and the orphan
	 * policy's dangling handles.
	 *
	 * `fail` is injected so this reports through the driver's `Divergence` channel.
	 */
	assertProvenance(where, prov, fail) {
		const ecs = this.ecs;

		// ── epochs: exactly the retained window is alive ─────────────────────
		const wantEpochs = prov.liveEpochs.map((i) => this.epochByIndex.get(i)).sort((a, b) => a - b);
		const gotEpochs = this.liveEpochEntities();
		if (gotEpochs.length !== wantEpochs.length || gotEpochs.some((v, i) => v !== wantEpochs[i])) {
			fail(where, `live epochs [${gotEpochs}] but the retention window says [${wantEpochs}]`);
		}
		for (const idx of prov.liveEpochs) {
			const e = this.epochByIndex.get(idx);
			const got = ecs.getField(e, this.Epoch, "index");
			if (got !== idx) fail(where, `epoch entity ${e} carries index ${got}, want ${idx}`);
		}
		// Every pruned epoch must be dead, the cascade's other half.
		for (const [idx, e] of this.epochByIndex) {
			const alive = prov.epochs.get(idx)?.alive === true;
			if (ecs.isAlive(e) !== alive) {
				fail(
					where,
					`epoch ${idx} (entity ${e}): ECS alive=${ecs.isAlive(e)}, model alive=${alive}`
				);
			}
		}

		// ── records: the cascade destroyed exactly the right ones ────────────
		const wantRecs = prov.liveRecords();
		const wantRecEnts = wantRecs.map((s) => this.recByRef.get(s)).sort((a, b) => a - b);
		const gotRecEnts = this.liveRecordEntities();
		if (
			gotRecEnts.length !== wantRecEnts.length ||
			gotRecEnts.some((v, i) => v !== wantRecEnts[i])
		) {
			fail(
				where,
				`live records: ECS has ${gotRecEnts.length}, model has ${wantRecEnts.length} ` +
					`(cascade destroyed the wrong set)`
			);
		}

		// ── the observer-maintained record set ──────────────────────────────
		// Records are only ever destroyed transitively, so this equality is the
		// assertion that a `"delete"` cascade fires `onRemove` for every victim.
		if (this.observedRecords.size !== gotRecEnts.length) {
			fail(
				where,
				`observer-maintained record set has ${this.observedRecords.size} entries, ` +
					`query rescan finds ${gotRecEnts.length}, a cascade victim's onRemove did not fire`
			);
		}
		for (const e of gotRecEnts) {
			if (!this.observedRecords.has(e)) {
				fail(where, `record ${e} is live but was never logged by its onAdd observer`);
			}
		}

		// ── per record: rule, epoch parent, and the multi Produced set ───────
		for (const serial of wantRecs) {
			const e = this.recByRef.get(serial);
			const rec = prov.records.get(serial);
			const rule = ecs.getField(e, this.Record, "rule");
			if (rule !== rec.rule) fail(where, `record ${serial} rule ${rule}, want ${rec.rule}`);

			const parent = ecs.relations.targetOf(e, this.InEpoch);
			const wantParent = this.epochByIndex.get(rec.epoch);
			if (parent !== wantParent) {
				fail(
					where,
					`record ${serial} InEpoch -> ${parent}, want ${wantParent} (epoch ${rec.epoch})`
				);
			}

			// The multi target set. It shrinks only because produced agents died, so a
			// mismatch here is a reverse-index-on-target-death bug, not a source edit.
			const gotProduced = ecs.relations.targetsOf(e, this.Produced);
			const wantProduced = [...rec.produced]
				.map((a) => this.byRef.get(a))
				.filter((x) => x !== undefined)
				.sort((a, b) => a - b);
			if (
				gotProduced.length !== wantProduced.length ||
				gotProduced.some((v, i) => v !== wantProduced[i])
			) {
				fail(
					where,
					`record ${serial} Produced = [${gotProduced}] but model says [${wantProduced}] ` +
						`(${rec.produced.size} produced, ${wantProduced.length} still live)`
				);
			}
			// targetsOf promises ascending order.
			for (let i = 1; i < gotProduced.length; i++) {
				if (gotProduced[i - 1] >= gotProduced[i]) {
					fail(where, `record ${serial} Produced not ascending: [${gotProduced}]`);
				}
			}
			// Every live produced agent must list this record in the reverse index.
			for (const t of gotProduced) {
				if (!ecs.relations.sourcesOf(t, this.Produced).includes(e)) {
					fail(where, `agent ${t} Produced reverse index is missing record ${e}`);
				}
			}
		}

		// ── reverse index + traversal helpers on the exclusive InEpoch ───────
		for (const idx of prov.liveEpochs) {
			const epochEnt = this.epochByIndex.get(idx);
			const wantKids = prov
				.recordsIn(idx)
				.map((s) => this.recByRef.get(s))
				.sort((a, b) => a - b);
			const gotKids = ecs.relations.sourcesOf(epochEnt, this.InEpoch);
			if (gotKids.length !== wantKids.length || gotKids.some((v, i) => v !== wantKids[i])) {
				fail(where, `sourcesOf(epoch ${idx}, InEpoch) = [${gotKids}], want [${wantKids}]`);
			}
			// `cascadeOf` predicts exactly what a despawn of this epoch would destroy.
			const cascade = ecs.relations.cascadeOf(epochEnt, this.InEpoch);
			const wantCascade = [epochEnt, ...wantKids];
			if (cascade.length !== wantCascade.length || cascade[0] !== epochEnt) {
				fail(
					where,
					`cascadeOf(epoch ${idx}) has ${cascade.length} entries starting ${cascade[0]}, ` +
						`want ${wantCascade.length} starting ${epochEnt}`
				);
			}
			const cascadeRest = cascade.slice(1).sort((a, b) => a - b);
			if (cascadeRest.some((v, i) => v !== wantKids[i])) {
				fail(
					where,
					`cascadeOf(epoch ${idx}) subtree [${cascadeRest}] != its records [${wantKids}]`
				);
			}
		}
		if (wantRecs.length > 0) {
			// One record's ancestor chain, as a spot check on the eager helpers.
			const serial = wantRecs[0];
			const e = this.recByRef.get(serial);
			const epochEnt = this.epochByIndex.get(prov.records.get(serial).epoch);
			const anc = ecs.relations.ancestorsOf(e, this.InEpoch);
			if (anc.length !== 2 || anc[0] !== e || anc[1] !== epochEnt) {
				fail(where, `ancestorsOf(record ${serial}) = [${anc}], want [${e}, ${epochEnt}]`);
			}
			if (ecs.relations.rootOf(e, this.InEpoch) !== epochEnt) {
				fail(where, `rootOf(record ${serial}) != its epoch ${epochEnt}`);
			}
			// The walk over the one-level `InEpoch` tree. It checks the count, and it
			// cannot check the sequence: the query selects `Record` entities, and a
			// parent in the `InEpoch` hierarchy is an `Epoch` entity. Therefore no
			// parent is in the result set. `PrevRec` below is the deep tree, and it does
			// check the sequence.
			const order = [];
			ecs
				.query(this.Record)
				.hierarchy(this.InEpoch)
				.forEachEntity((x) => order.push(x));
			if (order.length !== wantRecs.length) {
				fail(where, `hierarchy(Record, InEpoch) yielded ${order.length}, want ${wantRecs.length}`);
			}
			// Every entity that the walk yields must be a record of this epoch, a walk
			// that yielded the correct number of the wrong entities passed before.
			for (const x of order) {
				if (ecs.relations.rootOf(x, this.InEpoch) === undefined) {
					fail(where, `hierarchy(Record, InEpoch) yielded ${x}, which has no epoch root`);
				}
			}
		}

		// ── the deep chain: ancestorsOf past depth 1, and hierarchy order ────
		this._assertRecordChain(where, prov, fail);

		// ── the orphan policy: dangling handles survive, and are the only leak ─
		for (const idx of prov.liveEpochs) {
			const e = this.epochByIndex.get(idx);
			const wantAnc = prov.epochs
				.get(idx)
				.ancestors.map((a) => this.epochByIndex.get(a))
				.sort((a, b) => a - b);
			const gotAnc = ecs.relations.targetsOf(e, this.EpochAncestors);
			if (gotAnc.length !== wantAnc.length || gotAnc.some((v, i) => v !== wantAnc[i])) {
				fail(
					where,
					`epoch ${idx} EpochAncestors = [${gotAnc}], want [${wantAnc}] ` +
						`. Orphan must keep dead targets as dangling handles`
				);
			}
		}
	}

	/**
	 * The chain of records inside each live epoch, against the model.
	 *
	 * This is the layer that reaches `hierarchy` past depth 1. `InEpoch` is one level
	 * deep, so it can never test truncation by `maxDepth`, and it can never test the
	 * order of a parent before its children. `PrevRec` is a chain with one level for
	 * each record of the epoch, and both a parent and a child are `Record` entities.
	 * Therefore both properties have an exact expected value here.
	 *
	 * Four things get a check:
	 *   - `ancestorsOf`, the complete chain from a record back to the first record of
	 *     its epoch, in order, with the record itself first
	 *   - `rootOf`, the first record of the epoch
	 *   - `hierarchy` with no limit, every live record, and each parent before each
	 *     of its children
	 *   - `hierarchy` with `maxDepth = k`, exactly the records at depth 0 to k.
	 */
	_assertRecordChain(where, prov, fail) {
		const ecs = this.ecs;
		const lib = this._lib;
		const chains = prov.liveChains();
		if (chains.length === 0) return;

		// depth of each live record, and the entity of each serial
		const depthOf = new Map(); // entity -> depth in its chain
		const rootOfChain = new Map(); // entity -> entity of its chain root
		for (const chain of chains) {
			const first = this.recByRef.get(chain[0]);
			for (let d = 0; d < chain.length; d++) {
				const e = this.recByRef.get(chain[d]);
				depthOf.set(e, d);
				rootOfChain.set(e, first);
			}
		}

		// ── ancestorsOf over the deepest chain ──────────────────────────────
		let deepest = chains[0];
		for (const c of chains) if (c.length > deepest.length) deepest = c;
		if (deepest.length > 1) {
			const tailSerial = deepest[deepest.length - 1];
			const tail = this.recByRef.get(tailSerial);
			const want = [];
			for (let d = deepest.length - 1; d >= 0; d--) want.push(this.recByRef.get(deepest[d]));
			const got = ecs.relations.ancestorsOf(tail, this.PrevRec);
			if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
				fail(
					where,
					`ancestorsOf(record chain tail) has ${got.length} entries, want ${want.length} ` +
						`(a chain ${deepest.length} deep; this is the check that reaches past depth 1)`
				);
			}
			if (ecs.relations.rootOf(tail, this.PrevRec) !== want[want.length - 1]) {
				fail(where, `rootOf over the record chain is not the first record of the epoch`);
			}
		}

		// ── hierarchy with no limit: every record, parents first ────────────
		const walk = [];
		ecs
			.query(this.Record)
			.hierarchy(this.PrevRec)
			.forEachEntity((x) => walk.push(x));
		if (walk.length !== depthOf.size) {
			fail(
				where,
				`hierarchy(Record, PrevRec) yielded ${walk.length} records, want ${depthOf.size}`
			);
		}
		const seen = new Set();
		for (const x of walk) {
			if (seen.has(x)) fail(where, `hierarchy(Record, PrevRec) yielded ${x} two times`);
			seen.add(x);
			const parent = ecs.relations.targetOf(x, this.PrevRec);
			// The order that the documentation promises: a parent comes before its
			// children. `InEpoch` cannot check this. This chain can.
			if (parent !== undefined && !seen.has(parent)) {
				fail(
					where,
					`hierarchy(Record, PrevRec) yielded ${x} before its parent ${parent} ` +
						`. A walk must give a parent before its children`
				);
			}
		}
		// `HIERARCHY_UNBOUNDED` must be the same as the default.
		if (lib.HIERARCHY_UNBOUNDED !== undefined) {
			const unbounded = [];
			ecs
				.query(this.Record)
				.hierarchy(this.PrevRec, lib.HIERARCHY_UNBOUNDED)
				.forEachEntity((x) => unbounded.push(x));
			if (unbounded.length !== walk.length || unbounded.some((v, i) => v !== walk[i])) {
				fail(where, `hierarchy(..., HIERARCHY_UNBOUNDED) differs from the default walk`);
			}
		}

		// ── hierarchy with a limit: exactly the depths 0..k ─────────────────
		// A depth of 2 keeps the check cheap and still needs the truncation to work at
		// a level that `InEpoch` cannot reach.
		for (const maxDepth of [1, 2]) {
			const got = [];
			ecs
				.query(this.Record)
				.hierarchy(this.PrevRec, maxDepth)
				.forEachEntity((x) => got.push(x));
			let want = 0;
			for (const d of depthOf.values()) if (d <= maxDepth) want++;
			if (got.length !== want) {
				fail(
					where,
					`hierarchy(Record, PrevRec, maxDepth=${maxDepth}) yielded ${got.length}, want ${want}`
				);
			}
			for (const x of got) {
				const d = depthOf.get(x);
				if (d === undefined || d > maxDepth) {
					fail(
						where,
						`hierarchy(Record, PrevRec, maxDepth=${maxDepth}) yielded ${x} at depth ${d}`
					);
				}
			}
		}
	}

	/**
	 * ECS-only structural invariant: every port of every live agent is wired to a
	 * live port that wires back, ports that should not exist hold no relation and
	 * no slot, and the relation reverse index agrees with the forward links.
	 *
	 * This needs no reference net, so it is the check that survives even if the
	 * driver's id bijection were wrong.
	 */
	assertSelfConsistent(where) {
		const agents = this.liveAgents();
		const alive = new Set(agents);
		// forward links + symmetry
		for (const e of agents) {
			const t = this._typeOf(e);
			if (t < 0) throw new Error(`${where}: entity ${e} carries Slot but no type tag`);
			for (let p = 0; p < MAX_PORTS; p++) {
				const [f, q] = this.linkOf(e, p);
				if (p >= PORTS[t]) {
					if (f !== -1 || q !== NO_SLOT) {
						throw new Error(
							`${where}: ${e} (${TYPE_NAME[t]}) port ${p} should not exist, has ${f}:${q}`
						);
					}
					continue;
				}
				if (f === -1) throw new Error(`${where}: ${e} (${TYPE_NAME[t]}) port ${p} unwired`);
				if (!alive.has(f)) throw new Error(`${where}: ${e} port ${p} -> dead/non-agent ${f}`);
				const tf = this._typeOf(f);
				if (q >= PORTS[tf]) {
					throw new Error(
						`${where}: ${e} port ${p} -> ${f} port ${q}, which ${TYPE_NAME[tf]} lacks`
					);
				}
				const [back, bq] = this.linkOf(f, q);
				if (back !== e || bq !== p) {
					throw new Error(
						`${where}: link not symmetric: ${e}:${p} -> ${f}:${q} but ${f}:${q} -> ${back}:${bq}`
					);
				}
			}
		}
		// reverse index agrees with the forward links, in both directions
		const expect = [new Map(), new Map(), new Map()];
		for (const e of agents) {
			const t = this._typeOf(e);
			for (let p = 0; p < PORTS[t]; p++) {
				const [f] = this.linkOf(e, p);
				if (!expect[p].has(f)) expect[p].set(f, []);
				expect[p].get(f).push(e);
			}
		}
		for (let p = 0; p < MAX_PORTS; p++) {
			for (const e of agents) {
				const got = [...this.ecs.relations.sourcesOf(e, this.P[p])].sort((x, y) => x - y);
				const want = (expect[p].get(e) ?? []).sort((x, y) => x - y);
				if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
					throw new Error(
						`${where}: sourcesOf(${e}, P${p}) = [${got}] but forward links say [${want}]`
					);
				}
			}
		}

		// ── the reverse index, read as a whole ──────────────────────────────
		// `pairsOf` gives every (source, target) pair of one relation. The loop above
		// asks one question for each live agent, so an entry under a key that names a
		// dead entity is out of its reach. This comparison has no such blind spot,
		// because it reads the complete relation and compares it with the complete set
		// of the forward links.
		for (let p = 0; p < MAX_PORTS; p++) {
			const want = [];
			for (const e of agents) {
				const t = this._typeOf(e);
				if (p < PORTS[t]) want.push(`${e}>${this.linkOf(e, p)[0]}`);
			}
			want.sort();
			const got = this.ecs.relations
				.pairsOf(this.P[p])
				.map(([s, t]) => `${s}>${t}`)
				.sort();
			if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
				throw new Error(
					`${where}: pairsOf(P${p}) has ${got.length} pairs, the forward links have ${want.length}`
				);
			}
		}

		// ── a dead target must hold no key in the reverse index ─────────────
		// `"clear"` unlinks every source when a target dies, so no key of a dead
		// target may remain. The loop over the live agents above cannot see such a
		// key, and `README.md` recorded that as a gap. This closes it.
		for (const dead of this._deadCohort) {
			if (this.ecs.isAlive(dead)) continue; // the id came back with a new generation
			for (let p = 0; p < MAX_PORTS; p++) {
				const left = this.ecs.relations.sourcesOf(dead, this.P[p]);
				if (left.length !== 0) {
					throw new Error(
						`${where}: dead entity ${dead} still keys P${p} in the reverse index, with sources ` +
							`[${left}], "clear" must delete the key when its target dies`
					);
				}
			}
			if (this.prov !== null) {
				const left = this.ecs.relations.sourcesOf(dead, this.Produced);
				if (left.length !== 0) {
					throw new Error(
						`${where}: dead agent ${dead} still keys Produced, with sources [${left}]`
					);
				}
			}
		}

		// ── the wildcard read, against the per-relation reads ───────────────
		// `sourcesOfAny` answers "which relations point at this entity, and from
		// where". It must agree with the same question asked one relation at a time.
		for (const e of agents) {
			const want = [];
			for (let p = 0; p < MAX_PORTS; p++) {
				for (const s of this.ecs.relations.sourcesOf(e, this.P[p])) want.push(`${p}:${s}`);
			}
			if (this.prov !== null) {
				for (const s of this.ecs.relations.sourcesOf(e, this.Produced)) want.push(`Pr:${s}`);
			}
			want.sort();
			const got = [];
			for (const [rel, src] of this.ecs.relations.sourcesOfAny(e)) {
				const p = this.P.indexOf(rel);
				if (p >= 0) got.push(`${p}:${src}`);
				else if (this.prov !== null && rel === this.Produced) got.push(`Pr:${src}`);
				else got.push(`?${rel}:${src}`);
			}
			got.sort();
			if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
				throw new Error(
					`${where}: sourcesOfAny(${e}) = [${got}] but the per-relation reads say [${want}]`
				);
			}
			// `has` is the membership probe for the forward direction.
			for (let p = 0; p < MAX_PORTS; p++) {
				const t = this._typeOf(e);
				const wantHas = p < PORTS[t];
				if (this.ecs.relations.has(e, this.P[p]) !== wantHas) {
					throw new Error(
						`${where}: relations.has(${e}, P${p}) = ${!wantHas}, but the port ` +
							`${wantHas ? "exists" : "does not exist"}`
					);
				}
			}
		}
	}
}

/** The read-modify-write that `updateField` takes. Hoisted, so the harness does
 * not allocate a closure for each endpoint of each link. */
function inc(v) {
	return v + 1;
}

/** The archetype ids and the entity ids that one query gives. Pass `null` for
 * `archs` when the caller compares the entities alone. */
function collect(query, archs, ents) {
	if (archs !== null) archs.clear();
	ents.clear();
	query.forEachArchetype((arch) => {
		if (archs !== null) archs.add(arch.id);
		const ids = arch.entityIds;
		for (let i = 0; i < arch.entityCount; i++) ents.add(ids[i]);
	});
}

/** The rows of one chunk pass whose row tick of `def` is above `cols.since`,
 * into `out`. The row grain of the change detection, read through the column
 * that `ecs.trackRows(def)` installs. */
function collectChangedRows(query, def, out) {
	out.clear();
	query.forEachColumns((cols, count) => {
		const t = cols.ticksRead(def);
		const since = cols.since;
		const eids = cols.arch.entityIds;
		for (let i = 0; i < count; i++) {
			if (t[i] > since) out.add(eids[i]);
		}
	});
}
