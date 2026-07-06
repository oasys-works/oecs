import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { ComponentDef } from "../../component";
import type { EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

// Field arrays
const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;
const Health = ["hp"] as const;
const Static = [] as const; // tag component

describe("ECS query (integration)", () => {
	//=========================================================
	// Live query growth
	//=========================================================

	it("live query result grows when new matching archetype is created", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const result = world.query(Pos);
		const lengthBefore = result.archetypeCount;
		// Only the {Pos} archetype matches so far.
		expect(lengthBefore).toBe(1);

		// Adding a new component combo creates a new archetype containing Pos
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 0, y: 0 });
		world.addComponent(e2, Vel, { vx: 0, vy: 0 });

		// Same reference — live array was updated in-place by the registry.
		// Grows by exactly one: {Pos} + {Pos,Vel}. An over-count (stale/duplicate
		// archetype in the live array) would push this past 2.
		const after = world.query(Pos);
		expect(after).toBe(result);
		expect(after.archetypeCount).toBe(2);
	});

	//=========================================================
	// Live .not() rejection
	//=========================================================

	it("not() live — newly created excluded archetype does not appear", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Stat = world.registerComponent(Static);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		const q = world.query(Pos, Vel).without(Stat);
		const beforeLen = q.archetypeCount;

		// Create a new entity with the excluded component
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });
		world.addComponent(e2, Vel, { vx: 7, vy: 8 });
		world.addComponent(e2, Stat, {});

		// Live array should NOT have grown — excluded archetype rejected
		expect(q.archetypeCount).toBe(beforeLen);
	});

	//=========================================================
	// Live .anyOf() acceptance/rejection
	//=========================================================

	it("any_of() live — new matching archetype gets added to live array", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Hp = world.registerComponent(Health);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		const q = world.query(Pos).anyOf(Vel, Hp);
		const beforeLen = q.archetypeCount;

		// New archetype with Pos + Hp should be picked up
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });
		world.addComponent(e2, Hp, { hp: 50 });

		expect(q.archetypeCount).toBeGreaterThan(beforeLen);
		const entityIds: number[] = [];
		q.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entityIds.push(a.entityIds[i]);
		});
		expect(entityIds).toContain(e2);
	});

	it("any_of() live — archetype with none of the any_of-components is not added", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Hp = world.registerComponent(Health);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		const q = world.query(Pos).anyOf(Vel);
		const beforeLen = q.archetypeCount;

		// New archetype with Pos + Hp — Hp is NOT in the or-mask
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });
		world.addComponent(e2, Hp, { hp: 50 });

		expect(q.archetypeCount).toBe(beforeLen);
	});

	//=========================================================
	// Immediate destruction via the host facade
	//=========================================================

	it("despawn is immediate — entity is dead on the next line, no flush needed", () => {
		const world = new ECS();

		const id = world.spawn();
		world.despawn(id);

		expect(world.isAlive(id)).toBe(false);
	});

	it("host despawn from inside a system throws in DEV (use ctx.commands.despawn)", () => {
		const world = new ECS();
		const victim = world.spawn();

		const rogue = world.registerSystem({
			name: "rogue_host_despawn",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			fn() {
				world.despawn(victim);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, rogue);
		world.startup();

		expect(() => world.update(0)).toThrow(/host despawn is immediate.*ctx\.commands\.despawn/);
	});

	it("every immediate host structural mutator throws from inside a system in DEV", () => {
		// The despawn guard, extended to the whole immediate host mutation
		// surface: mid-system these ops can move/swap rows a running query is
		// walking AND are invisible to observers, so the receiver rule ("inside
		// a system, use ctx.commands") is enforced wholesale, not just where the
		// archetype-level iteration guard happens to catch it.
		const ops: [string, (world: ECS, victim: EntityID, def: ComponentDef<{ x: "i32" }>) => void, RegExp][] = [
			["addComponent", (w, e, d) => void w.addComponent(e, d, { x: 1 }), /host addComponent is immediate.*ctx\.commands\.add/],
			["addComponents", (w, e, d) => void w.addComponents(e, d({ x: 1 })), /host addComponents is immediate.*ctx\.commands\.add/],
			["removeComponent", (w, e, d) => void w.removeComponent(e, d), /host removeComponent is immediate.*ctx\.commands\.remove/],
			["removeComponents", (w, e, d) => void w.removeComponents(e, [d]), /host removeComponents is immediate.*ctx\.commands\.remove/],
			["disable", (w, e) => void w.disable(e), /host disable is immediate.*ctx\.commands\.disable/],
			["enable", (w, e) => void w.enable(e), /host enable is immediate.*ctx\.commands\.enable/]
		];

		for (const [name, op, pattern] of ops) {
			const world = new ECS();
			const Marker = world.registerComponent({ x: "i32" });
			const victim = world.spawn();
			world.addComponent(victim, Marker, { x: 0 });

			const rogue = world.registerSystem({
				name: `rogue_host_${name}`,
				exclusive: true, // full declared access — the guard fires anyway
				reads: [],
				writes: [],
				fn() {
					op(world, victim, Marker);
				}
			});
			world.addSystems(SCHEDULE.UPDATE, rogue);
			world.startup();

			expect(() => world.update(0), `ecs.${name} should throw in-system`).toThrow(pattern);
		}
	});

	it("host mutators stay usable from a DIFFERENT world's system (#785 multi-world)", () => {
		// The guard is scoped by `_updating` to the world being mutated: a system
		// of world A driving world B's host facade is a supported pattern — B is
		// not mid-iteration, so B's guard must not fire.
		const a = new ECS();
		const b = new ECS();
		const BMarker = b.registerComponent({ x: "i32" });
		const target = b.spawn();

		const driver = a.registerSystem({
			name: "cross_world_driver",
			// Exclusive: the accessCheck slot is process-global, so B's component
			// ids would otherwise be checked against A's declarations. The
			// mutation guard itself is what this test pins: it must key on B's
			// `_updating` (false here), not on the open span alone.
			exclusive: true,
			reads: [],
			writes: [],
			fn() {
				b.addComponent(target, BMarker, { x: 7 });
				b.disable(target);
				b.enable(target);
				b.removeComponent(target, BMarker);
				b.addComponent(target, BMarker, { x: 9 });
				b.despawn(target);
			}
		});
		a.addSystems(SCHEDULE.UPDATE, driver);
		a.startup();

		expect(() => a.update(0)).not.toThrow();
		expect(b.isAlive(target)).toBe(false);
	});

	//=========================================================
	// Column access integration
	//=========================================================

	it("allows column access through archetype dense columns", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 10, y: 20 });
		world.addComponent(e1, Vel, { vx: 1, vy: 2 });

		world.query(Pos, Vel).forEach((arch) => {
			const px = arch.getColumnRead(Pos, "x");
			const vy = arch.getColumnRead(Vel, "vy");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(px[i]).toBe(10);
				expect(vy[i]).toBe(2);
			}
		});
	});

	//=========================================================
	// Deferred structural changes + query consistency (via systems)
	//=========================================================

	it("deferred add_component does not change query result length until flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		// Cache a query for [Pos, Vel] — currently empty
		const before = world.query(Pos, Vel);
		expect(before.archetypeCount).toBe(0);

		// System defers an addComponent
		let lenDuringSystem = -1;
		const q = world.query(Pos, Vel);
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				ctx.commands.add(e1, Vel, { vx: 3, vy: 4 });
				lenDuringSystem = q.archetypeCount;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// During the system, the query was still empty
		expect(lenDuringSystem).toBe(0);

		// After update (which flushes), the live array has grown
		const after = world.query(Pos, Vel);
		expect(after.archetypeCount).toBe(1);
		expect(after._nonEmpty()[0].entityList).toContain(e1);
	});

	it("deferred remove_component does not change query result until flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		// Cache a query for [Pos, Vel] — entity e1 is in it
		const before = world.query(Pos, Vel);
		expect(before.archetypeCount).toBe(1);
		expect(before.archetypes[0].entityCount).toBe(1);

		// System defers a removeComponent
		let countDuringSystem = -1;
		const q = world.query(Pos, Vel);
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				ctx.commands.remove(e1, Vel);
				countDuringSystem = q.archetypes[0].entityCount;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// During the system, entity was still in its archetype
		expect(countDuringSystem).toBe(1);

		// After update (which flushes), entity has moved out
		expect(before.archetypes[0].entityCount).toBe(0);
	});

	it("two systems in sequence see consistent state until flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const posQuery = world.query(Pos);
		const posVelQuery = world.query(Pos, Vel);

		let sys1SawPos = false;
		let sys2VelLen = -1;

		// System 1 observes Pos query and defers adding Vel
		const s1 = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				const entities: number[] = [];
				posQuery.forEach((a) => {
					for (let i = 0; i < a.entityCount; i++) entities.push(a.entityIds[i]);
				});
				if (entities.includes(e1 as number)) sys1SawPos = true;
				ctx.commands.add(e1, Vel, { vx: 0, vy: 0 });
			}
		});

		// System 2 observes Pos+Vel query — should still see old state
		const s2 = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn() {
				sys2VelLen = posVelQuery.archetypeCount;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, s1, s2);
		world.startup();
		world.update(0);

		expect(sys1SawPos).toBe(true);
		expect(sys2VelLen).toBe(0);

		// After update flush, re-query sees the change
		const after = world.query(Pos, Vel);
		expect(after.archetypeCount).toBe(1);
		expect(after._nonEmpty()[0].entityList).toContain(e1);
	});

	it("flush processes structural changes before destructions", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		// System defers both add and destroy
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				ctx.commands.add(e1, Vel, { vx: 0, vy: 0 });
				ctx.commands.despawn(e1);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// After flush: structural applies (add Vel), then destroy runs
		expect(world.isAlive(e1)).toBe(false);
	});

	//=========================================================
	// forEach iteration
	//=========================================================

	it("for_each yields non-empty archetypes with correct columns and count", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 10, y: 20 });
		world.addComponent(e1, Vel, { vx: 1, vy: 2 });

		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 30, y: 40 });
		world.addComponent(e2, Vel, { vx: 3, vy: 4 });

		let archCount = 0;
		let totalEntities = 0;

		world.query(Pos, Vel).forEach((arch) => {
			archCount++;
			totalEntities += arch.entityCount;
			// Verify typed columns are accessible
			const px = arch.getColumnRead(Pos, "x");
			const vx = arch.getColumnRead(Vel, "vx");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(typeof px[i]).toBe("number");
				expect(typeof vx[i]).toBe("number");
			}
		});

		expect(archCount).toBe(1); // one archetype
		expect(totalEntities).toBe(2);
	});

	it("for_each skips archetypes with zero entities", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 0, vy: 0 });

		const q = world.query(Pos, Vel);

		// Deferred destroy + flush to empty the archetype
		world.despawn(e1);
		world.flush();

		let archCount = 0;
		q.forEach(() => {
			archCount++;
		});
		expect(archCount).toBe(0);
	});

	it("for_each iteration allows column mutation", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 5, y: 7 });
		world.addComponent(e1, Vel, { vx: 2, vy: 3 });

		// White-box: column mutation goes through the concrete archetype
		// (the mutable `getColumn` is not on the public read-only view).
		for (const arch of world.query(Pos, Vel)._nonEmpty()) {
			const px = arch.getColumn(Pos, "x", 0);
			const py = arch.getColumn(Pos, "y", 0);
			const vx = arch.getColumnRead(Vel, "vx");
			const vy = arch.getColumnRead(Vel, "vy");
			for (let i = 0; i < arch.entityCount; i++) {
				px[i] += vx[i]; // 5 + 2 = 7
				py[i] += vy[i]; // 7 + 3 = 10
			}
		}

		// Verify mutation via getColumn
		world.query(Pos, Vel).forEach((arch) => {
			const x = arch.getColumnRead(Pos, "x");
			const y = arch.getColumnRead(Pos, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(x[i]).toBe(7);
				expect(y[i]).toBe(10);
			}
		});
	});

	//=========================================================
	// registerSystem with QueryBuilder
	//=========================================================

	it("register_system with query builder resolves query at registration time", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		let capturedQ: any = null;
		const sys = world.registerSystem(
			(q, _ctx, _dt) => {
				capturedQ = q;
			},
			(qb) => qb.with(Pos, Vel)
		);

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0.016);

		expect(capturedQ).not.toBeNull();
		expect(capturedQ.archetypeCount).toBe(1);
	});

	it("register_system with config object still works", () => {
		const world = new ECS();
		let ran = false;
		const sys = world.registerSystem({
			...openAccess([]),
			fn: (_ctx, _dt) => {
				ran = true;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0.016);
		expect(ran).toBe(true);
	});
});
