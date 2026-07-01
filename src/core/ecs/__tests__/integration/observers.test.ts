/**
 * Component observers (#517 §1 / ADR-0013) — onAdd / onRemove / onSet.
 *
 * Ports the two locked proofs to the REAL engine:
 *   - determinism: one logical op-set in several INPUT ORDERINGS → identical
 *     `stateHash` (the `observer_determinism_sim` scenario);
 *   - glitch-freedom: a producer/consumer pair yields the glitch-free result
 *     under access-topological order (the `observer_ordering_sim` scenario).
 * Plus the acceptance-criteria guards: no-observer fast path, radix (not
 * comparator) ordering, access enforcement, dirty-state-out-of-hash, cascade
 * convergence + the non-convergence guard, and yieldExisting.
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { getEntityGeneration, getEntityIndex, type EntityID } from "../../entity";
import { eventKey } from "../../event";
import { ECS_ERROR } from "../../utils/error";
import { openAccess } from "../test_helpers";

// ============================================================================
// Phase 1 — structural observers (onAdd / onRemove)
// ============================================================================

describe("Observers — onAdd / onRemove basics", () => {
	it("onAdd fires at the flush boundary for a deferred add", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const fired: number[] = [];
		world.observe(Tag, {
			onAdd: (eid) => fired.push(eid as number),
			access: openAccess([Tag])
		});
		const e = world.createEntity();
		const adder = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => ctx.addComponent(e, Tag)
		});
		world.addSystems(SCHEDULE.UPDATE, adder);
		world.startup();
		expect(fired).toEqual([]); // not fired until the deferred flush
		world.update(1 / 60);
		expect(fired).toEqual([e as number]);
	});

	it("onRemove fires for an effective remove; no-op remove fires nothing", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const removed: number[] = [];
		world.observe(Tag, {
			onRemove: (eid) => removed.push(eid as number),
			access: openAccess([Tag])
		});
		const e = world.createEntity();
		world.addComponent(e, Tag); // immediate setup add — does NOT fire onAdd
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				ctx.removeComponent(e, Tag); // effective
				ctx.removeComponent(e, Tag); // no-op (already lacks) — must not fire
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(removed).toEqual([e as number]);
	});

	it("immediate (top-level) add_component does NOT fire onAdd (fires only at the flush boundary)", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		let fires = 0;
		world.observe(Tag, { onAdd: () => fires++, access: openAccess([Tag]) });
		const e = world.createEntity();
		world.addComponent(e, Tag); // immediate path — ADR-0013: not an observed point
		expect(fires).toBe(0);
	});

	it("dispose() stops firing and restores the fast path", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		let fires = 0;
		const handle = world.observe(Tag, { onAdd: () => fires++, access: openAccess([Tag]) });
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				if (!ctx.hasComponent(e1, Tag)) ctx.addComponent(e1, Tag);
				else if (!ctx.hasComponent(e2, Tag)) ctx.addComponent(e2, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(fires).toBe(1);
		handle.dispose();
		world.update(1 / 60); // e2 gains Tag, but observer is gone
		expect(fires).toBe(1);
		expect(world.hasComponent(e2, Tag)).toBe(true);
	});
});

// ============================================================================
// A handle disposed MID-ROUND must not fire later in the same flush (#726).
//
// `dispatchStructural` captures the topo order ONCE, then walks it. A sibling
// observer's callback can reach another observer's `dispose()` handle and flip
// its `disposed` flag, but the already-captured `order` snapshot still holds the
// now-disposed entry. The fire loop skips `obs.disposed`; without that skip the
// disposed observer still fires for components later in the topo order this same
// round. The two observers are registered on DIFFERENT components A and B (A
// first ⇒ lower component id ⇒ fires first under the cid tie-break, with no
// read/write dependency between them), and a single deferred batch adds (and, in
// the second case, removes) both so one flush dispatches both in topo order.
// ============================================================================

describe("Observers — dispose mid-round (#726)", () => {
	it("an observer disposed from a sibling's on_add does not fire later the same round", () => {
		const world = new ECS({ deterministic: true });
		const A = world.registerTag(); // registered first → lower cid → fires first
		const B = world.registerTag();
		let aFires = 0;
		let bFires = 0;
		// A fires first and disposes B's handle before the loop reaches B.
		world.observe(A, {
			onAdd: () => {
				aFires++;
				handleB.dispose();
			},
			access: openAccess([A])
		});
		const handleB = world.observe(B, {
			onAdd: () => bFires++,
			access: openAccess([B])
		});
		const e = world.createEntity();
		// One deferred batch adds BOTH A and B → a single flush dispatches both in
		// topo order (A before B).
		const sys = world.registerSystem({
			...openAccess([A, B]),
			fn: (ctx) => {
				ctx.addComponent(e, A);
				ctx.addComponent(e, B);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(aFires).toBe(1); // A fired
		expect(bFires).toBe(0); // B was disposed mid-round → must NOT fire
		expect(world.hasComponent(e, B)).toBe(true); // the add still committed
	});

	it("an observer disposed from a sibling's on_remove does not fire later the same round", () => {
		const world = new ECS({ deterministic: true });
		const A = world.registerTag(); // lower cid → fires first
		const B = world.registerTag();
		let aRemoves = 0;
		let bRemoves = 0;
		world.observe(A, {
			onRemove: () => {
				aRemoves++;
				handleB.dispose();
			},
			access: openAccess([A])
		});
		const handleB = world.observe(B, {
			onRemove: () => bRemoves++,
			access: openAccess([B])
		});
		const e = world.createEntity();
		world.addComponent(e, A); // immediate setup — does not fire onRemove
		world.addComponent(e, B);
		// One deferred batch removes BOTH A and B → one flush dispatches both
		// onRemove in topo order (A before B).
		const sys = world.registerSystem({
			...openAccess([A, B]),
			fn: (ctx) => {
				ctx.removeComponent(e, A);
				ctx.removeComponent(e, B);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(aRemoves).toBe(1); // A's onRemove fired
		expect(bRemoves).toBe(0); // B was disposed mid-round → must NOT fire
		expect(world.hasComponent(e, B)).toBe(false); // the remove still committed
	});
});

// ============================================================================
// onRemove fans out across a destroy (#531). A destroy is a remove of the whole
// mask, so it must fire onRemove for every carried component — at the deferred
// flush boundary, in the same commit-then-observe / canonical-order discipline
// as an explicit remove. The entity is freed before the callback runs, so the
// onRemove identifies WHAT was destroyed by its (now dead) eid. PATTERNS §72.
// ============================================================================

describe("Observers — onRemove on destroy", () => {
	it("a deferred destroy fires onRemove for every component the entity carried", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const Tag = world.registerTag();
		const removedPos: number[] = [];
		const removedTag: number[] = [];
		world.observe(Pos, {
			onRemove: (eid) => removedPos.push(eid as number),
			access: openAccess([Pos])
		});
		world.observe(Tag, {
			onRemove: (eid) => removedTag.push(eid as number),
			access: openAccess([Tag])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1 });
		world.addComponent(e, Tag);
		const sys = world.registerSystem({
			...openAccess([Pos, Tag]),
			fn: (ctx) => ctx.destroyEntity(e)
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(removedPos).toEqual([e as number]);
		expect(removedTag).toEqual([e as number]);
	});

	it("destroying a component-less entity fires no onRemove", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const removed: number[] = [];
		world.observe(Tag, {
			onRemove: (eid) => removed.push(eid as number),
			access: openAccess([Tag])
		});
		const e = world.createEntity(); // alive but unplaced — carries nothing
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => ctx.destroyEntity(e)
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(removed).toEqual([]);
		expect(world.isAlive(e)).toBe(false);
	});

	it("onRemove from a destroy sees the entity already freed (commit-then-observe)", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		let aliveInCallback: boolean | null = null;
		world.observe(Tag, {
			onRemove: (eid, ctx) => {
				aliveInCallback = ctx.isAlive(eid);
			},
			access: openAccess([Tag])
		});
		const e = world.createEntity();
		world.addComponent(e, Tag);
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => ctx.destroyEntity(e)
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(aliveInCallback).toBe(false); // freed before the callback runs
	});

	it("a remove and a destroy in the same tick: the remove's onRemove sees the entity live, the destroy's fires after with it freed", () => {
		const world = new ECS({ deterministic: true });
		const A = world.registerTag();
		const B = world.registerTag();
		let aliveWhenARemoved: boolean | null = null;
		let aliveWhenBRemoved: boolean | null = null;
		world.observe(A, {
			onRemove: (eid, ctx) => {
				aliveWhenARemoved = ctx.isAlive(eid);
			},
			access: openAccess([A])
		});
		world.observe(B, {
			onRemove: (eid, ctx) => {
				aliveWhenBRemoved = ctx.isAlive(eid);
			},
			access: openAccess([B])
		});
		const e = world.createEntity();
		world.addComponent(e, A);
		world.addComponent(e, B);
		const sys = world.registerSystem({
			...openAccess([A, B]),
			fn: (ctx) => {
				ctx.removeComponent(e, A); // explicit remove — fires with e live
				ctx.destroyEntity(e); // destroy — fires onRemove(B) with e freed
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(aliveWhenARemoved).toBe(true); // pre-#531 remove semantics preserved
		expect(aliveWhenBRemoved).toBe(false); // destroy is commit-then-observe
	});

	it("a destroy's onRemove may queue structural work, which settles to a fixed point", () => {
		const world = new ECS({ deterministic: true });
		const Unit = world.registerTag();
		const Marker = world.registerTag();
		const survivor = world.createEntity();
		world.observe(Unit, {
			onRemove: (_eid, ctx) => ctx.addComponent(survivor, Marker),
			access: openAccess([Unit, Marker])
		});
		const e = world.createEntity();
		world.addComponent(e, Unit);
		const sys = world.registerSystem({
			...openAccess([Unit, Marker]),
			fn: (ctx) => ctx.destroyEntity(e)
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(world.isAlive(e)).toBe(false);
		expect(world.hasComponent(survivor, Marker)).toBe(true);
	});

	it("a destroy's onRemove that destroys another entity cascades to a fixed point", () => {
		const world = new ECS({ deterministic: true });
		const Parent = world.registerTag();
		const Child = world.registerTag();
		const removedChildren: number[] = [];
		const child = world.createEntity();
		world.addComponent(child, Child);
		world.observe(Parent, {
			onRemove: (_eid, ctx) => ctx.destroyEntity(child),
			access: openAccess([Parent, Child])
		});
		world.observe(Child, {
			onRemove: (eid) => removedChildren.push(eid as number),
			access: openAccess([Child])
		});
		const parent = world.createEntity();
		world.addComponent(parent, Parent);
		const sys = world.registerSystem({
			...openAccess([Parent, Child]),
			fn: (ctx) => ctx.destroyEntity(parent)
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(world.isAlive(parent)).toBe(false);
		expect(world.isAlive(child)).toBe(false);
		expect(removedChildren).toEqual([child as number]); // cascade onRemove fired
	});

	it("destroy onRemove fires in canonical entity-index order, independent of destroy queue order", () => {
		const fireOrder = (reverse: boolean): number[] => {
			const world = new ECS({ deterministic: true });
			const Tag = world.registerTag();
			const fired: number[] = [];
			world.observe(Tag, {
				onRemove: (eid) => fired.push(getEntityIndex(eid)),
				access: openAccess([Tag])
			});
			const es: EntityID[] = [];
			for (let i = 0; i < 5; i++) {
				const e = world.createEntity();
				world.addComponent(e, Tag);
				es.push(e);
			}
			const sys = world.registerSystem({
				...openAccess([Tag]),
				fn: (ctx) => {
					const order = reverse ? [...es].reverse() : es;
					for (const e of order) ctx.destroyEntity(e);
				}
			});
			world.addSystems(SCHEDULE.UPDATE, sys);
			world.startup();
			world.update(1 / 60);
			return fired;
		};
		const forward = fireOrder(false);
		const reversed = fireOrder(true);
		// Canonical (ascending entity-index) regardless of the order queued.
		expect(forward).toEqual([...forward].sort((a, b) => a - b));
		expect(reversed).toEqual(forward);
	});
});

describe("Observers — canonical ordering", () => {
	it("fires entities in entity-id order regardless of queue order (radix, not queue)", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const fired: number[] = [];
		world.observe(Tag, {
			onAdd: (eid) => fired.push(getEntityIndex(eid)),
			access: openAccess([Tag])
		});
		const ids: EntityID[] = [];
		for (let i = 0; i < 8; i++) ids.push(world.createEntity());
		// Queue the adds in a scrambled (reverse) order.
		const scrambled = ids.slice().reverse();
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				for (const e of scrambled) ctx.addComponent(e, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		const sorted = fired.slice().sort((a, b) => a - b);
		expect(fired).toEqual(sorted); // canonical entity-id order
		expect(fired.length).toBe(8);
	});

	it("orders by bare entity index across the high radix pass and recycled generations", () => {
		// Hardens the canonical-order guard against the two radix-internal
		// regressions the 8-entity case above can't see (#550):
		//   1. a single-pass radix — caught by spanning > 1024 indices so the
		//      second 10-bit pass is load-bearing (8 entities all fit the low pass);
		//   2. a sort keyed on the full packed handle (index | generation) rather
		//      than the bare index — caught by recycling low-index slots so they
		//      carry a non-zero generation. With every generation 0 (no recycling)
		//      bare-index order and packed-handle order coincide, so a sort that
		//      never reduced to the 20-bit index would have stayed green.
		// (Dropping the radix's defensive `& INDEX_MASK` alone is a behavioural
		// no-op — the index is exactly 20 bits and the two 10-bit passes never
		// read the generation bits above bit 19 — so the catchable regression is
		// a sort that *does* consider those bits, e.g. a comparator on raw IDs.)
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const fired: number[] = [];
		world.observe(Tag, {
			onAdd: (eid) => fired.push(getEntityIndex(eid)),
			access: openAccess([Tag])
		});

		// > 1024 entities ⇒ indices reach into the radix's second 10-bit pass. The
		// top slots (1024+) share low-10-bit buckets with the bottom slots, so a
		// low-pass-only sort would interleave them out of ascending order.
		const N = (1 << 10) + 64; // 1088
		const ids: EntityID[] = [];
		for (let i = 0; i < N; i++) ids.push(world.createEntity()); // all generation 0

		// Recycle a handful of LOW-index slots: a deferred destroy + flush frees
		// the slot, then a fresh createEntity pops it back off the LIFO free stack
		// with generation + 1 — small index, but large packed handle.
		const recycle = [0, 1, 2, 5, 9];
		for (const i of recycle) world.destroyEntity(ids[i]);

		let scrambled: EntityID[] = [];
		const adder = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				for (const e of scrambled) ctx.addComponent(e, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, adder);
		world.startup();
		world.update(1 / 60); // warm-up: flushes the deferred destroys; scrambled empty ⇒ nothing fires
		expect(fired).toEqual([]);

		// Reclaim the freed slots — same low indices, now generation >= 1.
		for (let k = 0; k < recycle.length; k++) {
			const e = world.createEntity();
			ids[getEntityIndex(e)] = e;
		}
		expect(recycle.every((i) => getEntityGeneration(ids[i]) > 0)).toBe(true);

		// Queue the adds reversed so the firing order can only come from the radix.
		scrambled = ids.slice().reverse();
		world.update(1 / 60);

		// Canonical firing order is ascending by BARE index. A single-pass radix
		// interleaves the 1024+ slots; a packed-handle sort pushes the recycled
		// (high-generation) low indices to the end — both break strict ascent.
		const expected = ids.map((e) => getEntityIndex(e)).sort((a, b) => a - b);
		expect(fired).toEqual(expected);
		expect(fired.length).toBe(N);
	});
});

describe("Observers — determinism (observer_determinism_sim, real engine)", () => {
	// Cross-component-reading, cascading observers — the three things that make
	// firing order matter. A correct (commit → observe canonical → fixed-point)
	// design produces the same DERIVED per-entity state across input orderings.
	//
	// Two distinct digests, matching the sim:
	//   - `stateHash` (raw) hashes archetype rows in INSERTION order, so it is
	//     legitimately queue-order-sensitive — even with NO observers (that's how
	//     lockstep works: identical input order → identical hash for divergence
	//     detection). It is the *replay* (same-order) guarantee.
	//   - the sim's `hashState` folds the world in canonical ENTITY-ID order, so
	//     it isolates the observer-derived values from row layout. That is the
	//     order-INVARIANCE measure.
	function build(): {
		world: ECS;
		A: ReturnType<ECS["registerComponent"]>;
		B: ReturnType<ECS["registerComponent"]>;
		C: ReturnType<ECS["registerComponent"]>;
		ids: EntityID[];
	} {
		const world = new ECS({ deterministic: true });
		const A = world.registerComponent(["v"] as const, "i32");
		const B = world.registerComponent(["v"] as const, "i32");
		const C = world.registerComponent(["v"] as const, "i32");
		const access = openAccess([A, B, C]);
		let seq = 0;

		world.observe(A, {
			onAdd: (eid, ctx) => {
				seq++;
				const hasB = ctx.hasComponent(eid, B);
				ctx.setField(eid, A, "v", ctx.getField(eid, A, "v") + (hasB ? 1000 : 0) + seq);
				if (getEntityIndex(eid) % 2 === 0)
					ctx.addComponent(eid, C, { v: getEntityIndex(eid) });
			},
			access
		});
		world.observe(B, {
			onAdd: (eid, ctx) => {
				seq++;
				const hasA = ctx.hasComponent(eid, A);
				ctx.setField(eid, B, "v", ctx.getField(eid, B, "v") + (hasA ? 2000 : 0) + seq);
			},
			access
		});
		world.observe(C, {
			onAdd: (eid, ctx) => {
				ctx.setField(eid, C, "v", ctx.getField(eid, C, "v") + 7);
				if (ctx.hasComponent(eid, B)) ctx.removeComponent(eid, B);
			},
			access
		});

		const N = 12;
		const ids: EntityID[] = [];
		for (let i = 0; i < N; i++) ids.push(world.createEntity());
		return { world, A, B, C, ids };
	}

	// FNV-1a over the world in canonical entity-id order — the real-engine analog
	// of the sim's `hashState`.
	function canonicalDigest(b: ReturnType<typeof build>): number {
		const { world, A, B, C, ids } = b;
		let h = 0x811c9dc5;
		const mix = (n: number) => {
			h ^= n & 0xffffffff;
			h = Math.imul(h, 0x01000193) >>> 0;
		};
		const sorted = ids.slice().sort((x, y) => getEntityIndex(x) - getEntityIndex(y));
		for (const id of sorted) {
			mix(getEntityIndex(id));
			for (const def of [A, B, C])
				mix(world.hasComponent(id, def) ? world.getField(id, def, "v") : -1);
		}
		return h >>> 0;
	}

	function run(perm: (ops: [EntityID, 0 | 1][]) => [EntityID, 0 | 1][]): {
		raw: number;
		canon: number;
	} {
		const b = build();
		const { world, A, B, ids } = b;
		const ops: [EntityID, 0 | 1][] = [];
		for (const id of ids) {
			ops.push([id, 0]);
			ops.push([id, 1]);
		}
		const ordered = perm(ops);
		const defs = [A, B] as const;
		const sys = world.registerSystem({
			...openAccess([A, B]),
			fn: (ctx) => {
				for (const [id, which] of ordered)
					ctx.addComponent(id, defs[which], { v: getEntityIndex(id) });
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		return { raw: world.stateHash(), canon: canonicalDigest(b) };
	}

	const orderings: { name: string; perm: (o: [EntityID, 0 | 1][]) => [EntityID, 0 | 1][] }[] = [
		{ name: "forward", perm: (o) => o },
		{ name: "reverse", perm: (o) => o.slice().reverse() },
		{
			name: "by-component",
			perm: (o) => o.slice().sort((a, b) => a[1] - b[1] || (a[0] as number) - (b[0] as number))
		},
		{ name: "rotated", perm: (o) => o.slice(7).concat(o.slice(0, 7)) },
		{
			name: "swap-pairs",
			perm: (o) => {
				const x = o.slice();
				for (let i = 0; i + 1 < x.length; i += 2) [x[i], x[i + 1]] = [x[i + 1], x[i]];
				return x;
			}
		}
	];

	it("observer-derived state is invariant to the order ops were queued", () => {
		const digests = orderings.map((o) => run(o.perm).canon);
		expect(new Set(digests).size).toBe(1);
	});

	it("replay reproduces the same state_hash (identical op order → identical hash)", () => {
		expect(run((o) => o).raw).toBe(run((o) => o).raw);
	});
});

describe("Observers — glitch-free ordering (observer_ordering_sim, real engine)", () => {
	// Producer P (onAdd C) writes D=50; consumer Q (onAdd B) reads D → A = D+1.
	// Access-topological order fires P before Q ⇒ A = 51 (glitch-free).
	function run(perm: (ids: EntityID[]) => EntityID[]): number[] {
		const world = new ECS({ deterministic: true });
		const A = world.registerComponent(["v"] as const, "i32");
		const B = world.registerTag();
		const C = world.registerTag();
		const D = world.registerComponent(["v"] as const, "i32");

		// Producer P: writes D. Consumer Q: reads D, writes A. The decls make Q
		// depend on P (writer-of-D before reader-of-D).
		world.observe(C, {
			onAdd: (eid, ctx) => ctx.setField(eid, D, "v", 50),
			access: { writes: [D] }
		});
		world.observe(B, {
			onAdd: (eid, ctx) => ctx.setField(eid, A, "v", ctx.getField(eid, D, "v") + 1),
			access: { reads: [D], writes: [A] }
		});

		const N = 6;
		const ids: EntityID[] = [];
		for (let i = 0; i < N; i++) {
			const e = world.createEntity();
			world.addComponent(e, A, { v: 0 }); // entity must hold A + D to be written
			world.addComponent(e, D, { v: 0 });
			ids.push(e);
		}
		const order = perm(ids);
		const adder = world.registerSystem({
			...openAccess([A, B, C, D]),
			fn: (ctx) => {
				for (const e of order) {
					ctx.addComponent(e, B);
					ctx.addComponent(e, C);
				}
			}
		});
		world.addSystems(SCHEDULE.UPDATE, adder);
		world.startup();
		world.update(1 / 60);
		return ids.map((e) => world.getField(e, A, "v"));
	}

	it("consumer reads the producer's fresh value (A = 51), order-invariant", () => {
		const forward = run((o) => o);
		const reversed = run((o) => o.slice().reverse());
		expect(forward).toEqual(new Array(6).fill(51));
		expect(reversed).toEqual(new Array(6).fill(51));
	});
});

describe("Observers — no-observer fast path", () => {
	function scenario(world: ECS, Tag: ReturnType<ECS["registerTag"]>, ids: EntityID[]): void {
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				for (const e of ids) if (!ctx.hasComponent(e, Tag)) ctx.addComponent(e, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
	}

	it("a side-effect-free observer does not perturb state_hash vs no observer", () => {
		const w1 = new ECS({ deterministic: true });
		const T1 = w1.registerTag();
		const id1: EntityID[] = [w1.createEntity(), w1.createEntity()];
		scenario(w1, T1, id1);
		const hashNoObserver = w1.stateHash();

		const w2 = new ECS({ deterministic: true });
		const T2 = w2.registerTag();
		w2.observe(T2, { onAdd: () => {}, onRemove: () => {}, access: openAccess([T2]) });
		const id2: EntityID[] = [w2.createEntity(), w2.createEntity()];
		scenario(w2, T2, id2);
		expect(w2.stateHash()).toBe(hashNoObserver);
	});
});

describe("Observers — access enforcement", () => {
	it("an undeclared write inside an observer throws in __DEV__", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const Pos = world.registerComponent(["x"] as const, "i32");
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		// Observer declares nothing but writes Pos — accessCheck must catch it.
		world.observe(Tag, {
			onAdd: (eid, ctx) => ctx.setField(eid, Pos, "x", 1),
			access: { writes: [Tag] }
		});
		const adder = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => ctx.addComponent(e, Tag)
		});
		world.addSystems(SCHEDULE.UPDATE, adder);
		world.startup();
		expect(() => world.update(1 / 60)).toThrow();
	});

	it("a declared write inside an observer passes", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const Pos = world.registerComponent(["x"] as const, "i32");
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		world.observe(Tag, {
			onAdd: (eid, ctx) => ctx.setField(eid, Pos, "x", 42),
			access: { writes: [Tag, Pos] }
		});
		const adder = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => ctx.addComponent(e, Tag)
		});
		world.addSystems(SCHEDULE.UPDATE, adder);
		world.startup();
		expect(() => world.update(1 / 60)).not.toThrow();
		expect(world.getField(e, Pos, "x")).toBe(42);
	});
});

describe("Observers — cascades", () => {
	it("a cascading chain converges to a fixed point", () => {
		const world = new ECS({ deterministic: true });
		const A = world.registerTag();
		const B = world.registerTag();
		const C = world.registerTag();
		world.observe(A, {
			onAdd: (eid, ctx) => ctx.addComponent(eid, B),
			access: openAccess([A, B])
		});
		world.observe(B, {
			onAdd: (eid, ctx) => ctx.addComponent(eid, C),
			access: openAccess([B, C])
		});
		const e = world.createEntity();
		const sys = world.registerSystem({
			...openAccess([A, B, C]),
			fn: (ctx) => {
				if (!ctx.hasComponent(e, A)) ctx.addComponent(e, A);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(world.hasComponent(e, A)).toBe(true);
		expect(world.hasComponent(e, B)).toBe(true);
		expect(world.hasComponent(e, C)).toBe(true);
	});

	it("a non-convergent cascade throws OBSERVER_NON_CONVERGENT", () => {
		const world = new ECS({ deterministic: true });
		const Toggle = world.registerTag();
		world.observe(Toggle, {
			onAdd: (eid, ctx) => ctx.removeComponent(eid, Toggle),
			onRemove: (eid, ctx) => ctx.addComponent(eid, Toggle),
			access: openAccess([Toggle])
		});
		const e = world.createEntity();
		const sys = world.registerSystem({
			...openAccess([Toggle]),
			fn: (ctx) => {
				if (!ctx.hasComponent(e, Toggle)) ctx.addComponent(e, Toggle);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(1 / 60)).toThrow(
			expect.objectContaining({ category: ECS_ERROR.OBSERVER_NON_CONVERGENT })
		);
	});
});

describe("Observers — yield_existing", () => {
	it("replays onAdd over current matches on registration, in entity-id order", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const ids: EntityID[] = [];
		for (let i = 0; i < 5; i++) {
			const e = world.createEntity();
			world.addComponent(e, Tag); // immediate — no observer yet
			ids.push(e);
		}
		const fired: number[] = [];
		world.observe(Tag, {
			onAdd: (eid) => fired.push(getEntityIndex(eid)),
			yieldExisting: true,
			access: openAccess([Tag])
		});
		expect(fired).toEqual(ids.map((e) => getEntityIndex(e)).sort((a, b) => a - b));
	});

	it("a yield_existing registration mid-system does not disable access_check for the rest of the frame", () => {
		// #554: the replay enters/leaves the observer's access frame; a bare leave
		// nulls the caller's frame (leave() doesn't pop), silently disabling
		// dev-mode enforcement for the remainder of the registering system. The
		// undeclared Pos write below must still throw under the restored frame.
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		const Pos = world.registerComponent(["x"] as const, "i32");
		// A pre-existing match so yieldExisting actually enters/leaves a frame.
		const existing = world.createEntity();
		world.addComponent(existing, Tag);
		const target = world.createEntity();
		world.addComponent(target, Pos, { x: 0 });
		// System declares Tag only — NOT Pos. Mid-frame it lazily registers a
		// yieldExisting observer, then performs an undeclared write to Pos.
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				world.observe(Tag, {
					onAdd: () => {},
					yieldExisting: true,
					access: openAccess([Tag])
				});
				ctx.setField(target, Pos, "x", 1); // undeclared — must throw
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(1 / 60)).toThrow();
	});
});

// ============================================================================
// Phase 2 — data observers (onSet)
// ============================================================================

describe("Observers — onSet (per-entity, dirty list)", () => {
	it("fires once per changed entity, deduped within a tick", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const fired: number[] = [];
		world.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		world.addComponent(e1, Pos, { x: 0 });
		world.addComponent(e2, Pos, { x: 0 });
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				ctx.setField(e1, Pos, "x", 1);
				ctx.setField(e1, Pos, "x", 2); // same entity again — dedups
				ctx.setField(e2, Pos, "x", 3);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(fired.slice().sort((a, b) => a - b)).toEqual(
			[e1, e2].map((e) => getEntityIndex(e)).sort((a, b) => a - b)
		);
	});

	it("records a dirty row from a ctx.ref write via ctx.mark_changed", () => {
		// `ctx.ref` / `ctx.getColumn` writes bypass setField's auto-record, so a
		// per-entity onSet consumer marks the row explicitly (the bench's winning
		// `tick+list`: raw write + an int push).
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const fired: number[] = [];
		world.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				const r = ctx.ref(Pos, e);
				r.x = 9;
				ctx.markChanged(e, Pos);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(fired).toEqual([getEntityIndex(e)]);
		expect(world.getField(e, Pos, "x")).toBe(9);
	});

	it("does not fire for entities whose value did not change", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		let fires = 0;
		world.observe(Pos, {
			onSet: () => fires++,
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		const noop = world.registerSystem({ ...openAccess([Pos]), fn: () => {} });
		world.addSystems(SCHEDULE.UPDATE, noop);
		world.startup();
		world.update(1 / 60);
		expect(fires).toBe(0);
	});

	it("fans every changed entity out to ALL per-entity onSet observers on the same component", () => {
		// Two independent subsystems observe onSet for the SAME component. Each
		// must receive the full changed-entity set — the first observer's drain
		// must not starve the rest (the consume-once bug: a shared dirty list was
		// taken by the first observer, leaving later observers an empty list).
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const a: number[] = [];
		const b: number[] = [];
		world.observe(Pos, {
			onSet: (eid) => a.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		world.observe(Pos, {
			onSet: (eid) => b.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		world.addComponent(e1, Pos, { x: 0 });
		world.addComponent(e2, Pos, { x: 0 });
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				ctx.setField(e1, Pos, "x", 1);
				ctx.setField(e2, Pos, "x", 2);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		const expected = [e1, e2].map((e) => getEntityIndex(e)).sort((x, y) => x - y);
		expect(a.slice().sort((x, y) => x - y)).toEqual(expected);
		expect(b.slice().sort((x, y) => x - y)).toEqual(expected);
	});

	it("records a host-side ECS.set_field write for the per-entity onSet observer", () => {
		// A mutation through the host facade (outside a system, between updates)
		// must still be seen by an entity-granular onSet observer — `ECS.setField`
		// records the dirty row exactly like `SystemContext.setField`.
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const fired: number[] = [];
		world.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		world.startup();
		world.setField(e, Pos, "x", 7); // host-side write between updates
		world.update(1 / 60);
		expect(fired).toEqual([getEntityIndex(e)]);
		expect(world.getField(e, Pos, "x")).toBe(7);
	});
});

describe("Observers — onSet (archetype-granular, change tick)", () => {
	it("fires once per changed archetype-column with the archetype view; not on unchanged ticks", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const counts: number[] = [];
		world.observe(Pos, {
			onSet: (arch) => counts.push(arch.entityCount),
			access: openAccess([Pos]) // default granularity: archetype
		});
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		world.addComponent(e1, Pos, { x: 0 });
		world.addComponent(e2, Pos, { x: 0 });
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				if (ctx.ecsTick === 1) ctx.setField(e1, Pos, "x", 5);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60); // tick 0: setup writes already stamped tick 0 — baseline replay
		const afterTick0 = counts.length;
		world.update(1 / 60); // tick 1: write → fires once
		world.update(1 / 60); // tick 2: no write → must not fire
		expect(counts[afterTick0]).toBe(2); // the tick-1 firing saw 2 entities
		expect(counts.length).toBe(afterTick0 + 1); // exactly one more firing across ticks 1+2
	});
});

describe("Observers — dirty state stays out of state_hash", () => {
	it("a populated dirty list does not change state_hash vs no tracking", () => {
		// Capture the hash mid-tick (after writes, before the post-update drain),
		// with and without an entity-onSet observer enabling dirty tracking.
		function hashAfterWrite(observe: boolean): number {
			const world = new ECS({ deterministic: true });
			const Pos = world.registerComponent(["x"] as const, "i32");
			if (observe)
				world.observe(Pos, {
					onSet: () => {},
					granularity: "entity",
					access: openAccess([Pos])
				});
			const e = world.createEntity();
			world.addComponent(e, Pos, { x: 0 });
			let captured = 0;
			const sys = world.registerSystem({
				...openAccess([Pos]),
				fn: (ctx) => {
					ctx.setField(e, Pos, "x", 5); // populates the dirty list when observed
					captured = world.stateHash();
				}
			});
			world.addSystems(SCHEDULE.UPDATE, sys);
			world.startup();
			world.update(1 / 60);
			return captured;
		}
		expect(hashAfterWrite(true)).toBe(hashAfterWrite(false));
	});
});

describe("Observers — onSet and the one-tick event window (#586)", () => {
	it("onSet reads events emitted earlier in the same tick (it fires inside the window)", () => {
		// `clearEvents` is the tick's last act (after `dispatchSet`), so onSet sees
		// the settled component snapshot AND this tick's events. (Was 0 pre-#586,
		// when the clear ran before `dispatchSet`.)
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const Ev = eventKey<{ v: number }>("Ev");
		world.registerEvent(Ev, ["v"] as const);
		let seen = -1;
		world.observe(Pos, {
			onSet: (_eid, ctx) => {
				seen = ctx.read(Ev).length;
			},
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				ctx.emit(Ev, { v: 1 });
				ctx.setField(e, Pos, "x", 1); // triggers onSet at the tick tail
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(seen).toBe(1);
	});

	it("does not extend event lifetime: the channel is empty at the tick boundary (snapshot-safe)", () => {
		// stateHash() and the world snapshot exclude event state; that is sound only
		// because no event survives the update() boundary. onSet reading an event must
		// not keep it alive into the next tick.
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const Ev = eventKey<{ v: number }>("Ev");
		world.registerEvent(Ev, ["v"] as const);
		world.observe(Pos, {
			onSet: (_eid, ctx) => {
				void ctx.read(Ev).length; // read inside onSet — must not extend lifetime
			},
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		let tick = 0;
		const nextTickLen: number[] = [];
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				if (tick === 0) {
					ctx.emit(Ev, { v: 1 });
					ctx.setField(e, Pos, "x", 1);
				}
				nextTickLen.push(ctx.read(Ev).length);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60); // tick 0: emits + reads its own event (1)
		tick = 1;
		world.update(1 / 60); // tick 1: channel cleared at tick 0's tail → 0, no leak
		expect(nextTickLen).toEqual([1, 0]);
	});

	it("throws if an onSet observer emits an event (its emission would be silently dropped)", () => {
		// onSet runs at the tick tail; anything it emits is wiped by `clearEvents`
		// before any reader, and would break snapshot/restore determinism if it
		// survived. A __DEV__ guard turns the silent drop into a loud error.
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(["x"] as const, "i32");
		const Ev = eventKey<{ v: number }>("Ev");
		world.registerEvent(Ev, ["v"] as const);
		world.observe(Pos, {
			onSet: (_eid, ctx) => ctx.emit(Ev, { v: 1 }),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => ctx.setField(e, Pos, "x", 1)
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(1 / 60)).toThrow(
			expect.objectContaining({ category: ECS_ERROR.OBSERVER_ONSET_EMIT })
		);
	});
});
