/**
 * Optional query terms — fetch-if-present (#575, Bevy `Option<&T>` / flecs `?`).
 *
 * `q.optional(T)` fetches `T` when an entity has it but does NOT exclude
 * entities that lack it: the matched set stays at the required terms, spanning
 * archetypes with and without `T`. Per archetype span the column is resolved via
 * `arch.getOptionalColumnRead(T, field)` — the column when present,
 * `undefined` when absent. These tests cover the issue's acceptance criteria:
 *  - iterate entities WITH and WITHOUT the optional component (both branches);
 *  - the present/absent accessor returns a column vs `undefined`;
 *  - read-only ⇒ a `stateHash` no-op;
 *  - the optional read is access-declared (`reads:[T]`), and the check fires even
 *    on the absent span;
 *  - composition with `and` / `not` / `anyOf` is symmetric — the term survives a
 *    dense compose in EITHER order (#592 finding #1, the silent-drop regression);
 *  - the term gates the fetch — `getOptionalColumnRead` throws in `__DEV__` if
 *    the component wasn't declared via `.optional(T)` (#592 finding #2);
 *  - cache identity.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import type { SystemConfig } from "../../system";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;
const Health = ["hp"] as const;

/** Empty dense access declaration; spread and override per test. */
function base(overrides: Partial<SystemConfig>): SystemConfig {
	return {
		reads: [],
		writes: [],
		spawns: [],
		despawns: [],
		transitions: [],
		resourceReads: [],
		resourceWrites: [],
		fn: (_ctx: SystemContext, _dt: number) => {},
		...overrides
	};
}

/** Register `sys` into UPDATE, start the world, return the run-one-tick thunk
 * (where the system's `fn` — and its access checks — fire). */
function runOnce(world: ECS, cfg: SystemConfig): () => void {
	const sys = world.registerSystem(cfg);
	world.addSystems(SCHEDULE.UPDATE, sys);
	world.startup();
	return () => world.update(0);
}

describe("ECS optional query terms (#575)", () => {
	//=========================================================
	// Both branches: iterate with AND without the optional component
	//=========================================================

	it("iterates entities with and without the optional component", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		// e1 has Vel, e2 does not — two archetypes ({Pos,Vel} and {Pos}).
		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 10, vy: 20 });
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 3, y: 4 });

		const q = world.query(Pos).optional(Vel);

		const visited: number[] = [];
		const withVel: number[] = [];
		const withoutVel: number[] = [];
		q.forEach((arch) => {
			const px = arch.getColumnRead(Pos, "x");
			const vx = arch.getOptionalColumnRead(Vel, "vx");
			for (let i = 0; i < arch.entityCount; i++) {
				const e = arch.entityIds[i];
				visited.push(e);
				if (vx !== undefined) {
					withVel.push(e);
					// Present-span accessor exposes the real column data.
					expect(vx[i]).toBe(10);
					expect(px[i]).toBe(1);
				} else {
					withoutVel.push(e);
				}
			}
		});

		// Matched set = required term (Pos) → BOTH entities iterate.
		expect(visited.sort()).toEqual([e1, e2].sort());
		expect(withVel).toEqual([e1]);
		expect(withoutVel).toEqual([e2]);
	});

	it("absent accessor is undefined for an entity lacking the optional component", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0, y: 0 }); // {Pos} only

		const q = world.query(Pos).optional(Vel);

		let sawArchetype = false;
		q.forEach((arch) => {
			sawArchetype = true;
			expect(arch.getOptionalColumnRead(Vel, "vx")).toBeUndefined();
		});
		expect(sawArchetype).toBe(true);
	});

	it("reflects live add of the optional component (entity migrates archetype)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 5, y: 5 });

		const q = world.query(Pos).optional(Vel);

		const presentBefore: boolean[] = [];
		q.forEach((arch) => {
			presentBefore.push(arch.getOptionalColumnRead(Vel, "vx") !== undefined);
		});
		expect(presentBefore).toEqual([false]);

		// Give it Vel — host-side immediate add, then the optional column resolves.
		world.addComponent(e, Vel, { vx: 7, vy: 8 });

		let presentAfter = false;
		let value = -1;
		q.forEach((arch) => {
			const vx = arch.getOptionalColumnRead(Vel, "vx");
			if (vx !== undefined) {
				presentAfter = true;
				value = vx[0];
			}
		});
		expect(presentAfter).toBe(true);
		expect(value).toBe(7);
	});

	//=========================================================
	// Determinism: read-only ⇒ stateHash no-op
	//=========================================================

	it("optional iteration is a state_hash no-op (read-only)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 5, y: 6 });

		const q = world.query(Pos).optional(Vel);

		const before = world.stateHash();
		let sum = 0;
		q.forEach((arch) => {
			const px = arch.getColumnRead(Pos, "x");
			const vx = arch.getOptionalColumnRead(Vel, "vx");
			for (let i = 0; i < arch.entityCount; i++) {
				sum += px[i] + (vx ? vx[i] : 0);
			}
		});
		const after = world.stateHash();

		expect(after).toBe(before);
		expect(sum).toBe(1 + 5 + 3); // px(e1)+px(e2)+vx(e1); e2 has no Vel
	});

	//=========================================================
	// Access declaration: an optional read needs reads:[T]
	//=========================================================

	it("permits an optional read when the component is declared in reads", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, Vel, { vx: 1, vy: 1 });
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 2, y: 2 });

		const q = world.query(Pos).optional(Vel);
		const tick = runOnce(
			world,
			base({
				name: "optional_reader",
				reads: [Pos, Vel],
				fn() {
					q.forEach((arch) => {
						arch.getColumnRead(Pos, "x");
						arch.getOptionalColumnRead(Vel, "vx");
					});
				}
			})
		);

		expect(tick).not.toThrow();
	});

	it("throws when the optional component is read but not declared", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, Vel, { vx: 1, vy: 1 });

		const q = world.query(Pos).optional(Vel);
		const tick = runOnce(
			world,
			base({
				name: "undeclared_optional",
				reads: [Pos], // Vel omitted
				fn() {
					q.forEach((arch) => {
						arch.getOptionalColumnRead(Vel, "vx");
					});
				}
			})
		);

		expect(tick).toThrow(/system 'undeclared_optional'.*read.*didn't declare/);
	});

	it("access check fires on the absent span, not just the present one", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		// Only a {Pos} entity exists — the optional Vel column is ALWAYS absent,
		// so the check must run before the absent short-circuit to fire here.
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos).optional(Vel);
		const tick = runOnce(
			world,
			base({
				name: "absent_span_reader",
				reads: [Pos], // Vel omitted
				fn() {
					q.forEach((arch) => {
						arch.getOptionalColumnRead(Vel, "vx");
					});
				}
			})
		);

		expect(tick).toThrow(/system 'absent_span_reader'.*read.*didn't declare/);
	});

	//=========================================================
	// Cache identity + composition
	//=========================================================

	it("optional() returns a stable cached reference, distinct from the plain query", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const plain = world.query(Pos);
		const first = plain.optional(Vel);
		const second = world.query(Pos).optional(Vel);

		expect(first).toBe(second); // same (parent_id, cid) → cached
		expect(first).not.toBe(plain); // distinct identity from the plain query
		// Same matched archetype set as the plain query (optional doesn't narrow).
		expect(first.archetypes).toBe(plain.archetypes);
	});

	it("optional(A, B) folds to the same instance as optional(A).optional(B)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32");

		const chained = world.query(Pos).optional(Vel).optional(Hp);
		const multi = world.query(Pos).optional(Vel, Hp);

		expect(multi).toBe(chained);
	});

	it("composes with and / not while keeping the optional fetch", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32");

		// Require Pos AND Hp, exclude nothing extra, fetch Vel if present.
		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, Hp, { hp: 100 });
		world.addComponent(e1, Vel, { vx: 9, vy: 9 });
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 2, y: 2 });
		world.addComponent(e2, Hp, { hp: 50 }); // no Vel
		const e3 = world.createEntity();
		world.addComponent(e3, Pos, { x: 3, y: 3 }); // no Hp → excluded by `and(Hp)`

		const q = world.query(Pos).and(Hp).optional(Vel);

		const visited: number[] = [];
		const withVel: number[] = [];
		q.forEach((arch) => {
			const vx = arch.getOptionalColumnRead(Vel, "vx");
			for (let i = 0; i < arch.entityCount; i++) {
				visited.push(arch.entityIds[i]);
				if (vx !== undefined) withVel.push(arch.entityIds[i]);
			}
		});

		expect(visited.sort()).toEqual([e1, e2].sort()); // e3 lacks Hp
		expect(withVel).toEqual([e1]);
	});

	//=========================================================
	// Composition is symmetric: the optional term survives a dense compose
	// in EITHER order (#592 — the order-dependent silent-drop regression).
	//=========================================================

	it("keeps the optional term when .optional() precedes .and() (the dropped order, #592)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32");

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, Hp, { hp: 100 });
		world.addComponent(e1, Vel, { vx: 7, vy: 7 });
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 2, y: 2 });
		world.addComponent(e2, Hp, { hp: 50 }); // no Vel

		// optional FIRST, then and — the order that used to drop the term and
		// alias the plain `.and(Hp)` query (#592 finding #1).
		const q = world.query(Pos).optional(Vel).and(Hp);

		// The plain compose (no optional) is a DISTINCT object — proof the term
		// gave the composed query its own identity rather than collapsing onto it.
		const plain = world.query(Pos).and(Hp);
		expect(q).not.toBe(plain);

		const visited: number[] = [];
		const withVel: number[] = [];
		q.forEach((arch) => {
			const vx = arch.getOptionalColumnRead(Vel, "vx"); // declared ⇒ no throw
			for (let i = 0; i < arch.entityCount; i++) {
				visited.push(arch.entityIds[i]);
				if (vx !== undefined) withVel.push(arch.entityIds[i]);
			}
		});

		expect(visited.sort()).toEqual([e1, e2].sort());
		expect(withVel).toEqual([e1]);
	});

	it("optional survives compose through not() and any_of() too (#592)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32");

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, Vel, { vx: 3, vy: 3 }); // {Pos,Vel}, no Hp
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 2, y: 2 });
		world.addComponent(e2, Hp, { hp: 9 }); // {Pos,Hp} → excluded by not(Hp)

		// optional FIRST, then not(Hp): the term must survive, and the fetch must
		// not throw the #592 dev-gate.
		const q = world.query(Pos).optional(Vel).without(Hp);
		const seen: number[] = [];
		q.forEach((arch) => {
			const vx = arch.getOptionalColumnRead(Vel, "vx");
			for (let i = 0; i < arch.entityCount; i++) {
				seen.push(arch.entityIds[i]);
				if (arch.entityIds[i] === e1) expect(vx?.[i]).toBe(3);
			}
		});
		expect(seen).toEqual([e1]); // e2 excluded by not(Hp)

		// anyOf preserves it as well (smoke: declared fetch doesn't throw).
		const q2 = world.query(Pos).optional(Vel).anyOf(Vel, Hp);
		expect(() =>
			q2.forEach((arch) => {
				arch.getOptionalColumnRead(Vel, "vx");
			})
		).not.toThrow();
	});

	//=========================================================
	// The term gates the fetch (#592): getOptionalColumnRead requires the
	// component to have been declared via .optional(T) on the iterating query.
	//=========================================================

	it("throws when fetching an optional column the query never declared (#592)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0, y: 0 });
		world.addComponent(e, Vel, { vx: 1, vy: 1 });

		// Plain query — never called .optional(Vel).
		const q = world.query(Pos);
		expect(() =>
			q.forEach((arch) => {
				arch.getOptionalColumnRead(Vel, "vx");
			})
		).toThrow(/getOptionalColumnRead.*didn't declare it/);
	});

	it("throws when fetching a different optional than the one declared (#592)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32");

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		// Declared .optional(Hp), but fetches Vel — Vel is not in the scope.
		const q = world.query(Pos).optional(Hp);
		expect(() =>
			q.forEach((arch) => {
				arch.getOptionalColumnRead(Vel, "vx");
			})
		).toThrow(/getOptionalColumnRead.*didn't declare it/);
	});

	it("a changed-query loop gates the optional fetch too (#594 Task 1)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32"); // the undeclared optional

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 1 });
		world.addComponent(e, Vel, { vx: 2, vy: 2 });

		// .optional(Vel) declared; changed(Pos) wraps it. Before #594 the changed-query
		// loop never entered an optional scope, so this fetch silently passed.
		const cq = world.query(Pos).optional(Vel).changed(Pos);

		expect(() =>
			cq.forEach((arch) => {
				arch.getOptionalColumnRead(Hp, "hp"); // undeclared → must throw now
			})
		).toThrow(/getOptionalColumnRead.*didn't declare it/);

		// The declared optional does not throw in the same changed-query loop.
		expect(() =>
			cq.forEach((arch) => {
				arch.getOptionalColumnRead(Vel, "vx");
			})
		).not.toThrow();
	});

	//=========================================================
	// Multi-arg dense compose is cached/stable on a non-dense receiver (#594
	// Task 2): folding through the single-arg cache stops _carry_nondense from
	// minting a fresh query-id per call.
	//=========================================================

	it("and(A, B) folds to and(A).and(B) on an optional-carrying query (#594 Task 2)", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent(Position, "i32");
		const Vel = world.registerComponent(Velocity, "i32");
		const Hp = world.registerComponent(Health, "i32");
		const Mana = world.registerComponent(["mana"] as const, "i32");

		const root = world.query(Pos).optional(Vel);

		// Multi-arg == chained == repeated: one stable cached instance, no id churn.
		const multi = root.and(Hp, Mana);
		expect(multi).toBe(root.and(Hp).and(Mana));
		expect(root.and(Hp, Mana)).toBe(multi); // second call: same instance

		// not / any_of multi-arg fold likewise.
		expect(root.without(Hp, Mana)).toBe(root.without(Hp).without(Mana));
		expect(root.anyOf(Hp, Mana)).toBe(root.anyOf(Hp).anyOf(Mana));

		// And the optional term still gates a fetch through the folded compose.
		expect(() =>
			multi.forEach((arch) => {
				arch.getOptionalColumnRead(Vel, "vx");
			})
		).not.toThrow();
	});
});
