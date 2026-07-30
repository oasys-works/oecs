/**
 * The net, in the ECS. This is the implementation under test.
 *
 * We selected this representation to give pressure to the three mechanisms that the
 * long run must use. We did not select it because it is the fastest method to hold a
 * graph.
 *
 *   ARCHETYPE MIGRATION — the type of an agent is a tag (CON, DUP, ERA or ROOT).
 *     Each agent also holds `Redex`, `Fresh` and `Age` as components, and the ECS
 *     adds and removes them. Each of these operations moves a row between
 *     archetypes. The tags for the type alone give four archetypes, and the tags
 *     that change give a total of 32.
 *
 *   RELATION MUTATION — the *agent at the end* of a port is an exclusive relation
 *     (`P0`, `P1` or `P2`). Therefore each rewrite changes the target of several of
 *     them. An `add` to an exclusive relation replaces the old target, and it gives
 *     no message. This operation uses the path that maintains the reverse index more
 *     than any other operation in the API. The *index* of the port at the other end
 *     is in a `u8` column. Therefore the relation graph and the column data must
 *     agree. They are two independent records of one fact, and the oracle compares
 *     them.
 *
 *   OBSERVERS — the ECS does not calculate the redex queue when a caller asks for
 *     it. The queue is a `Set`, and `onAdd` and `onRemove` observers on the `Redex`
 *     tag maintain it alone. The oracle compares the queue against a new scan, and
 *     against the reference net. A structural observer runs only for a deferred
 *     operation in the schedule. Therefore each change below uses `ctx.commands`.
 *
 * `Fresh` and `Age` have no meaning for the interaction net. They make the archetype
 * graph wider, and they keep one `i32` column that the ECS writes at each tick. The
 * reference model copies their rules exactly. Therefore the oracle checks them, and
 * it does not ignore them.
 */
import { ROOT, MAX_PORTS, NO_SLOT, PORTS, TYPE_NAME, applyRewrite, reduces } from "./spec.mjs";

const SLOT_F = ["s0", "s1", "s2"];

export class EcsNet {
	/**
	 * @param lib the built oecs module (`{ ECS, SCHEDULE }`)
	 * @param opts.strict verify each planned pair really is an active pair in the
	 *   ECS before rewriting it, so a divergence is attributed to the exact
	 *   rewrite that first disagreed rather than to the end-of-tick comparison.
	 */
	constructor(lib, { strict = true, prov = null } = {}) {
		const { ECS, SCHEDULE } = lib;
		this.strict = strict;
		this.prov = prov; // { epochEvery, retain } or null to omit the layer entirely
		this.ecs = new ECS({ deterministic: true });
		const ecs = this.ecs;

		// ── components ──────────────────────────────────────────────────────
		// `registerTag()` takes no options, so tags that want a debug label go
		// through `registerComponent({}, { name })` — the same empty schema, but
		// errors and frame traces then name the agent type instead of a bare id.
		const tag = (name) => ecs.registerComponent({}, { name });
		// Indexed BY the type constants, derived from the same table that defines
		// them — a hand-written array here would silently depend on its literal order
		// matching `CON`/`DUP`/`ERA`/`ROOT`.
		this.TAG = TYPE_NAME.map(tag);
		// Deterministic worlds reject float columns, so every field here is integral.
		this.Slot = ecs.registerComponent({ s0: "u8", s1: "u8", s2: "u8" }, { name: "Slot" });
		this.Redex = tag("Redex");
		this.Fresh = tag("Fresh");
		this.Age = ecs.registerComponent({ ticks: "i32" }, { name: "Age" });

		// ── relations ───────────────────────────────────────────────────────
		// "clear" is the right cleanup policy here: a rewrite always relinks every
		// port it disturbs, so a dangling reverse entry would be a bug rather than a
		// state to tolerate — and "delete" would cascade-destroy the redex's
		// innocent neighbours.
		this.P = [0, 1, 2].map(() =>
			ecs.relations.register({ exclusive: true, onDeleteTarget: "clear" })
		);

		// ── the provenance layer ────────────────────────────────────────────
		// A second entity population — an audit log of rewrites with epoch-based
		// retention — whose only purpose is to reach the relation surface the net's
		// own ports do not: multi target sets, the "delete" cascade, "orphan" plus
		// `compact()`, and the traversal helpers. See `prov.mjs` for the reasoning.
		if (prov !== null) {
			this.Record = ecs.registerComponent({ rule: "u8" }, { name: "Record" });
			this.Epoch = ecs.registerComponent({ index: "i32" }, { name: "Epoch" });
			// exclusive + "delete": despawning an epoch cascade-destroys its records.
			this.InEpoch = ecs.relations.register({ exclusive: true, onDeleteTarget: "delete" });
			// multi + "clear": a record's target set shrinks when a produced agent DIES,
			// which is the reverse-index path no source-side edit exercises.
			this.Produced = ecs.relations.register({ multi: true, onDeleteTarget: "clear" });
			// multi + "orphan": pruned epochs stay referenced as dangling handles, which
			// is the documented reverse-index leak `compact()` reclaims.
			this.EpochAncestors = ecs.relations.register({ multi: true, onDeleteTarget: "orphan" });
			this.qRecords = ecs.query(this.Record);
			this.qEpochs = ecs.query(this.Epoch);
		}

		// ── queries ─────────────────────────────────────────────────────────
		this.qAgents = ecs.query(this.Slot);
		this.qRedex = ecs.query(this.Redex);
		this.qFresh = ecs.query(this.Fresh);
		this.qAge = ecs.query(this.Age);

		// ── the observer-maintained redex queue ─────────────────────────────
		// The whole point: this Set is never recomputed, only pushed to by the two
		// callbacks. If a structural observer misses a transition, fires twice, or
		// fires for the wrong entity, this Set drifts from the rescan and the
		// reference — and nothing else in the harness would notice.
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
			},
		});

		// ── the observer-maintained record set ──────────────────────────────
		// Same discipline as the redex queue, but pointed at the cascade: records are
		// destroyed only *transitively*, by despawning their epoch parent. So this Set
		// staying correct is the assertion that a `"delete"` cascade fires `onRemove`
		// for every victim it destroys — a thing nothing else here would detect.
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
				},
			});
		}

		// ── rewrite adapter (the seam `applyRewrite` drives) ────────────────
		this._ctx = null;
		this._created = [];
		this._touched = new Set();
		this.loops = 0;
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
				// Either endpoint's principal may have changed, so both need their
				// `Redex` tag re-derived at the end of the tick.
				self._touched.add(a);
				self._touched.add(b);
			},
			createAgent(type) {
				const e = self._ctx.commands.spawn(
					self.TAG[type],
					self.Slot({ s0: NO_SLOT, s1: NO_SLOT, s2: NO_SLOT }),
					self.Fresh
				);
				self._created.push(e);
				self._touched.add(e);
				return e;
			},
			destroyAgent(e) {
				self._ctx.commands.despawn(e);
				self._touched.delete(e);
			},
			settle() {
				// The one flush per rewrite: applies the deferred spawns and despawns so
				// the following `setLink` calls address live rows, and fires the
				// structural observers for everything queued so far.
				self._ctx.flush();
			},
			onLoop() {
				self.loops++;
			},
		};

		// ── systems ─────────────────────────────────────────────────────────
		this._plan = [];
		this._tick = 0;
		this.byRef = new Map(); // reference agent id -> entity id
		this.byEcs = new Map(); // entity id -> reference agent id
		// Provenance bijections. Epoch entries are deliberately NEVER pruned: the
		// orphan policy is about dangling handles, so verifying it needs the entity id
		// of an epoch that is already dead.
		this.recByRef = new Map(); // reference record serial -> entity id
		this.epochByIndex = new Map(); // reference epoch index -> entity id
		this.currentEpochEntity = -1;
		this.rewritesApplied = 0;

		const allTags = this.TAG;
		const provComps = prov === null ? [] : [this.Record, this.Epoch];
		const provRels = prov === null ? [] : [this.InEpoch, this.Produced, this.EpochAncestors];
		const rewrite = ecs.registerSystem({
			name: "net-rewrite",
			reads: [],
			writes: [this.Slot, this.Fresh, ...allTags, ...provComps],
			spawns: [...allTags.map((t) => [t, this.Slot, this.Fresh]), ...provComps.map((c) => [c])],
			despawns: [this.Slot, this.Fresh, this.Age, this.Redex, ...allTags, ...provComps],
			relationReads: [...this.P, ...provRels],
			relationWrites: [...this.P, ...provRels],
			fn: (ctx) => {
				this._ctx = ctx;
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

					// Log the rewrite. Ordering matters and mirrors the reference: the two
					// agents were despawned inside `applyRewrite` (and its `settle()` already
					// ran the `"clear"` cleanup that pulls them out of every older record's
					// `Produced` set), so this record only ever sees live targets.
					if (prov !== null && step.rec !== null && this.currentEpochEntity !== -1) {
						const rec = ctx.commands.spawn(this.Record({ rule: step.rule }));
						// Relations are immediate and legal on a not-yet-flushed entity — the
						// create half of `commands.spawn` is not deferred, only the components.
						ctx.addRelation(rec, this.InEpoch, this.currentEpochEntity);
						for (let k = 0; k < made.length; k++) {
							ctx.addRelation(rec, this.Produced, made[k]);
						}
						this.recByRef.set(step.rec, rec);
					}
				}
				this._plan = [];
				this._ctx = null;
			},
		});

		// Re-derive `Redex` for every agent a rewrite disturbed. Runs after the
		// rewrites in the same phase; its adds/removes are deferred, so the observer
		// sees them at this system's flush.
		const redexMaintain = ecs.registerSystem({
			name: "net-redex-maintain",
			reads: [this.Slot, ...allTags],
			writes: [],
			transitions: [{ whenHas: [this.Slot], add: [this.Redex], remove: [this.Redex] }],
			relationReads: this.P,
			fn: (ctx) => {
				for (const e of this._touched) {
					if (!ctx.isAlive(e)) continue;
					const want = this._isActive(ctx, e);
					const has = ctx.hasComponent(e, this.Redex);
					if (want && !has) ctx.commands.add(e, this.Redex);
					else if (!want && has) ctx.commands.remove(e, this.Redex);
				}
				this._touched.clear();
			},
		});

		// `Fresh` -> `Age(0)` promotion, in PRE_UPDATE — i.e. one tick AFTER the
		// agents were created. Promoting them in the same tick would erase `Fresh`
		// before the oracle's tick-boundary comparison ever saw it, making that
		// component (and its archetype edge) untested. Two archetype transitions per
		// promoted agent: `Fresh` off, `Age` on.
		const freshPromote = ecs.registerSystem({
			name: "net-fresh-promote",
			reads: [],
			writes: [this.Age],
			transitions: [{ whenHas: [this.Slot], add: [this.Age], remove: [this.Fresh] }],
			fn: (ctx) => {
				this.qFresh.forEachEntity((e) => {
					ctx.commands.remove(e, this.Fresh);
					ctx.commands.add(e, this.Age, { ticks: 0 });
				});
			},
		});

		// Epoch roll + retention prune, in PRE_UPDATE so the current epoch exists
		// before the rewrites that log into it. The prune is one `commands.despawn`
		// per retired epoch, and the `"delete"` cascade on `InEpoch` turns each of
		// those into a transitive destroy of every record that epoch holds — applied
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
						relationReads: [this.InEpoch, this.EpochAncestors, this.Produced],
						relationWrites: [this.InEpoch, this.EpochAncestors, this.Produced],
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
							for (const idx of roll.pruned) {
								const victim = this.epochByIndex.get(idx);
								if (victim !== undefined) ctx.commands.despawn(victim);
							}
						},
					});

		// The per-tick age bump — one hot `i32` column write per live aged agent,
		// through the `eachChunk` mutable path.
		const ageTick = ecs.registerSystem({
			name: "net-age-tick",
			reads: [],
			writes: [this.Age],
			fn: () => {
				this.qAge.eachChunk((cols, count) => {
					const { ticks } = cols.mut(this.Age);
					for (let i = 0; i < count; i++) ticks[i] += 1;
				});
			},
		});

		this._pendingRoll = null;
		ecs.addSystems(SCHEDULE.PRE_UPDATE, freshPromote);
		if (provRoll !== null) ecs.addSystems(SCHEDULE.PRE_UPDATE, provRoll);
		// Same phase, explicitly ordered: the maintenance pass must see the rewrites'
		// finished wiring. Insertion order would tiebreak the same way, but the
		// constraint is the actual requirement, so it is stated.
		ecs.addSystems(
			SCHEDULE.UPDATE,
			rewrite,
			{ system: redexMaintain, ordering: { after: [rewrite] } }
		);
		ecs.addSystems(SCHEDULE.POST_UPDATE, ageTick);
		ecs.startup();
	}

	// ── binding ─────────────────────────────────────────────────────────────
	_bind(refId, e) {
		this.byRef.set(refId, e);
		this.byEcs.set(e, refId);
	}
	_unbind(refId) {
		const e = this.byRef.get(refId);
		if (e !== undefined) {
			this.byRef.delete(refId);
			this.byEcs.delete(e);
		}
	}

	// ── loading ─────────────────────────────────────────────────────────────
	/**
	 * Build the initial net host-side (immediate ops), then mark every agent as
	 * touched so the FIRST tick's maintenance system derives the initial `Redex`
	 * tags through `ctx.commands` — which means the observer-maintained queue is
	 * populated by the observer, never seeded behind its back.
	 */
	load(spec) {
		const ecs = this.ecs;
		const ids = [];
		for (let i = 0; i < spec.types.length; i++) {
			const e = ecs.spawn();
			ecs.addComponent(e, this.TAG[spec.types[i]]);
			ecs.addComponent(e, this.Slot, { s0: NO_SLOT, s1: NO_SLOT, s2: NO_SLOT });
			ecs.addComponent(e, this.Age, { ticks: 0 });
			ids.push(e);
			this._bind(i, e);
			this._touched.add(e);
		}
		for (const [a, pa, b, pb] of spec.wires) {
			const ea = ids[a];
			const eb = ids[b];
			ecs.relations.add(ea, this.P[pa], eb);
			ecs.setField(ea, this.Slot, SLOT_F[pa], pb);
			ecs.relations.add(eb, this.P[pb], ea);
			ecs.setField(eb, this.Slot, SLOT_F[pb], pa);
		}
		return this;
	}

	// ── driving ─────────────────────────────────────────────────────────────
	/**
	 * Run one tick over `plan` — a list of `{ a, b, made, rule, rec }` in reference
	 * ids. `roll` is the epoch transition the reference already applied (or `null`),
	 * replayed here by the PRE_UPDATE system so both sides roll at the same point.
	 */
	runTick(plan, roll = null) {
		this._plan = plan;
		this._pendingRoll = roll;
		this.ecs.update(1);
		this._tick++;
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
					`— ${ea}.P0 -> ${la}:${sa}`
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

	/** Every live agent entity, ascending. */
	liveAgents() {
		const out = [];
		this.qAgents.forEachEntity((e) => out.push(e));
		out.sort((x, y) => x - y);
		return out;
	}

	/** The redex set recomputed from scratch — the independent check on the
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

	/** Distinct archetypes the agent population currently occupies — the
	 * non-vacuity signal for "this really is exercising migration". */
	archetypeSignatures() {
		const sigs = new Set();
		for (const e of this.liveAgents()) {
			const t = this._typeOf(e);
			sigs.add(
				`${TYPE_NAME[t]}|${this.ecs.hasComponent(e, this.Redex) ? "R" : ""}` +
					`${this.ecs.hasComponent(e, this.Fresh) ? "F" : ""}` +
					`${this.ecs.hasComponent(e, this.Age) ? "A" : ""}`
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
			unreachable: agents.length - order.length,
		};
	}

	/**
	 * Verify the provenance layer against its reference model.
	 *
	 * Covers, in order: the cascade's exact victim set, multi target sets shrinking
	 * because a *target* died, `targetsOf` ordering, the reverse index on both
	 * relations, the observer-maintained record set (the proof that cascade victims
	 * fire `onRemove`), the traversal helpers, and the orphan policy's dangling
	 * handles.
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
		// Every pruned epoch must be dead — the cascade's other half.
		for (const [idx, e] of this.epochByIndex) {
			const alive = prov.epochs.get(idx)?.alive === true;
			if (ecs.isAlive(e) !== alive) {
				fail(where, `epoch ${idx} (entity ${e}): ECS alive=${ecs.isAlive(e)}, model alive=${alive}`);
			}
		}

		// ── records: the cascade destroyed exactly the right ones ────────────
		const wantRecs = prov.liveRecords();
		const wantRecEnts = wantRecs.map((s) => this.recByRef.get(s)).sort((a, b) => a - b);
		const gotRecEnts = this.liveRecordEntities();
		if (gotRecEnts.length !== wantRecEnts.length || gotRecEnts.some((v, i) => v !== wantRecEnts[i])) {
			fail(
				where,
				`live records: ECS has ${gotRecEnts.length}, model has ${wantRecEnts.length} ` +
					`(cascade destroyed the wrong set)`
			);
		}

		// ── the observer-maintained record set ──────────────────────────────
		// Records are only ever destroyed transitively, so this equality IS the
		// assertion that a `"delete"` cascade fires `onRemove` for every victim.
		if (this.observedRecords.size !== gotRecEnts.length) {
			fail(
				where,
				`observer-maintained record set has ${this.observedRecords.size} entries, ` +
					`query rescan finds ${gotRecEnts.length} — a cascade victim's onRemove did not fire`
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
				fail(where, `record ${serial} InEpoch -> ${parent}, want ${wantParent} (epoch ${rec.epoch})`);
			}

			// The multi target set. It shrinks only because produced agents DIED, so a
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
			const cascadeRest = [...cascade.slice(1)].sort((a, b) => a - b);
			if (cascadeRest.some((v, i) => v !== wantKids[i])) {
				fail(where, `cascadeOf(epoch ${idx}) subtree [${cascadeRest}] != its records [${wantKids}]`);
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
			// This checks the COUNT of the hierarchy walk, and it does not check the
			// sequence. It cannot: the query selects `Record` entities, and a parent in
			// the `InEpoch` hierarchy is an `Epoch` entity. Therefore no parent is in the
			// result set, and "a parent comes before its children" has nothing to order
			// here. The comment said that it checked the sequence, and that was not
			// correct. `Known gaps` in `README.md` records the hierarchy coverage.
			const order = [];
			ecs.query(this.Record).hierarchy(this.InEpoch).forEachEntity((x) => order.push(x));
			if (order.length !== wantRecs.length) {
				fail(where, `hierarchy(Record, InEpoch) yielded ${order.length}, want ${wantRecs.length}`);
			}
			// Every entity that the walk yields must be a record of THIS epoch — a walk
			// that yielded the correct number of the wrong entities passed before.
			for (const x of order) {
				if (ecs.relations.rootOf(x, this.InEpoch) === undefined) {
					fail(where, `hierarchy(Record, InEpoch) yielded ${x}, which has no epoch root`);
				}
			}
		}

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
						`— orphan must keep dead targets as dangling handles`
				);
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
						throw new Error(`${where}: ${e} (${TYPE_NAME[t]}) port ${p} should not exist, has ${f}:${q}`);
					}
					continue;
				}
				if (f === -1) throw new Error(`${where}: ${e} (${TYPE_NAME[t]}) port ${p} unwired`);
				if (!alive.has(f)) throw new Error(`${where}: ${e} port ${p} -> dead/non-agent ${f}`);
				const tf = this._typeOf(f);
				if (q >= PORTS[tf]) {
					throw new Error(`${where}: ${e} port ${p} -> ${f} port ${q}, which ${TYPE_NAME[tf]} lacks`);
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
	}
}
