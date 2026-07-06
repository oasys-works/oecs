/**
 * Tests for the consumer-ergonomics surfaces added in the ECS ergonomics
 * pass: optional access-declaration fields + Template expansion
 * (`_normalizeAccess`), `Query.forEachUntil`, `getColumnsRead`,
 * `regionHandles`, `updateField`, and the explicit-undefined spawn
 * override skip. The typed event schema is covered by
 * `integration/event.test.ts`; the compile-time halves (branded event
 * fields, schema-typed template values/overrides) are exercised implicitly
 * by every typed call in this file and across the game package.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECSError, ECS_ERROR } from "../../utils/error";
import { SCHEDULE } from "../../schedule";

describe("optional access-declaration fields", () => {
	it("absent optional fields normalize to frozen empties on the descriptor", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const sys = world.registerSystem({
			name: "min",
			reads: [Pos],
			writes: [],
			fn() {}
		});
		expect(sys.spawns).toEqual([]);
		expect(sys.despawns).toEqual([]);
		expect(sys.transitions).toEqual([]);
		expect(sys.resourceReads).toEqual([]);
		expect(sys.resourceWrites).toEqual([]);
		expect(Object.isFrozen(sys.spawns)).toBe(true);
	});

	it("a system with only reads/writes still passes the runtime access check", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });
		let seen = -1;
		const sys = world.registerSystem({
			name: "reader",
			reads: [Pos],
			writes: [],
			fn(ctx) {
				seen = ctx.getField(e, Pos, "x");
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(16);
		expect(seen).toBe(1);
	});
});

describe("Template in spawns/despawns declarations", () => {
	it("expands a Template to its component list on the descriptor", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const Vel = world.registerComponent({ vx: "f64" } as const);
		const t = world.template(Pos, Vel);
		const sys = world.registerSystem({
			name: "spawner",
			reads: [],
			writes: [],
			spawns: [t],
			despawns: [t],
			fn() {}
		});
		expect(sys.spawns).toEqual([[Pos, Vel]]);
		expect(sys.despawns).toEqual([Pos, Vel]);
	});

	it("mixes Template and explicit lists / defs", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const Vel = world.registerComponent({ vx: "f64" } as const);
		const Hp = world.registerComponent({ v: "i32" } as const);
		const t = world.template(Pos, Vel);
		const sys = world.registerSystem({
			name: "mixed",
			reads: [],
			writes: [],
			spawns: [t, [Hp]],
			despawns: [Hp, t],
			fn() {}
		});
		expect(sys.spawns).toEqual([[Pos, Vel], [Hp]]);
		expect(sys.despawns).toEqual([Hp, Pos, Vel]);
	});

	it("a Template despawns declaration authorises destroy_entity at flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const t = world.template(Pos({ x: 5 }));
		const e = world.spawn(t);
		const sys = world.registerSystem({
			name: "reaper",
			reads: [Pos],
			writes: [],
			despawns: [t],
			fn(ctx) {
				if (ctx.isAlive(e)) ctx.commands.despawn(e);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(16);
		expect(world.isAlive(e)).toBe(false);
	});
});

describe("Query.for_each_until", () => {
	it("stops at the first archetype whose callback returns true", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const TagA = world.registerTag();
		const TagB = world.registerTag();
		// Two distinct archetypes matching the Pos query.
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1 });
		world.addComponent(a, TagA);
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 2 });
		world.addComponent(b, TagB);

		let visited = 0;
		const hit = world.query(Pos).forEachUntil(() => {
			visited++;
			return true; // stop immediately
		});
		expect(hit).toBe(true);
		expect(visited).toBe(1);
	});

	it("returns false after visiting everything when nothing matches", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });
		let visited = 0;
		const hit = world.query(Pos).forEachUntil((arch) => {
			visited++;
			const col = arch.getColumnRead(Pos, "x");
			for (let i = 0; i < arch.entityCount; i++) if (col[i] === 999) return true;
			return false;
		});
		expect(hit).toBe(false);
		expect(visited).toBe(1);
	});

	it("include_disabled() spans the disabled tail", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" } as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 7 });
		world.disable(e);

		const defaultHit = world.query(Pos).forEachUntil((arch) => {
			const col = arch.getColumnRead(Pos, "x");
			for (let i = 0; i < arch.entityCount; i++) if (col[i] === 7) return true;
			return false;
		});
		expect(defaultHit).toBe(false);

		const widenedHit = world
			.query(Pos)
			.includeDisabled()
			.forEachUntil((arch) => {
				const col = arch.getColumnRead(Pos, "x");
				for (let i = 0; i < arch.entityCount; i++) if (col[i] === 7) return true;
				return false;
			});
		expect(widenedHit).toBe(true);
	});
});

describe("Archetype.get_columns_read", () => {
	it("returns the same column views as per-field get_column_read", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64" } as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 3, y: 4 });
		let checked = false;
		world.query(Pos).forEach((arch) => {
			const [xs, ys] = arch.getColumnsRead(Pos, "x", "y");
			expect(xs).toBe(arch.getColumnRead(Pos, "x"));
			expect(ys).toBe(arch.getColumnRead(Pos, "y"));
			expect(xs[0]).toBe(3);
			expect(ys[0]).toBe(4);
			checked = true;
		});
		expect(checked).toBe(true);
	});
});

describe("ECS.region_handles", () => {
	it("throws once, naming every missing region id", () => {
		const world = new ECS();
		expect(() => world.regionHandles(7, 9)).toThrowError(/\[7, 9\]/);
		try {
			world.regionHandles(7, 9);
			expect.unreachable("region_handles should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.REGION_NOT_DECLARED);
		}
	});

	it("returns declared handles in argument order", () => {
		const world = new ECS({
			regions: [
				{ id: 11, name: "alpha", bytes: 16, init: () => {} },
				{ id: 12, name: "beta", bytes: 16, init: () => {} }
			]
		});
		const [beta, alpha] = world.regionHandles(12, 11);
		expect(beta).toEqual(world.regionHandle(12));
		expect(alpha).toEqual(world.regionHandle(11));
	});
});

describe("update_field", () => {
	it("host-side: composes get_field → set_field and returns the written value", () => {
		const world = new ECS();
		const Gold = world.registerComponent({ value: "i32" } as const);
		const e = world.spawn();
		world.addComponent(e, Gold, { value: 100 });
		const next = world.updateField(e, Gold, "value", (v) => v - 30);
		expect(next).toBe(70);
		expect(world.getField(e, Gold, "value")).toBe(70);
	});

	it("system-side: same semantics through SystemContext (write declared)", () => {
		const world = new ECS();
		const Gold = world.registerComponent({ value: "i32" } as const);
		const e = world.spawn();
		world.addComponent(e, Gold, { value: 10 });
		const sys = world.registerSystem({
			name: "bank",
			reads: [],
			writes: [Gold],
			fn(ctx) {
				ctx.updateField(e, Gold, "value", (v) => v * 2);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(16);
		expect(world.getField(e, Gold, "value")).toBe(20);
	});
});

describe("spawn override explicit-undefined skip", () => {
	it("keeps the template default instead of writing NaN", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64" } as const);
		const t = world.template(Pos({ x: 1, y: 2 }));
		const e = world.spawn(t, { x: 9, y: undefined });
		expect(world.getField(e, Pos, "x")).toBe(9);
		expect(world.getField(e, Pos, "y")).toBe(2);
	});
});

describe("add_component bundle overload", () => {
	it("accepts a callable-def bundle and zero-fills omitted fields", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64" } as const);
		const e = world.spawn();
		world.addComponent(e, Pos({ x: 5 }));
		expect(world.getField(e, Pos, "x")).toBe(5);
		expect(world.getField(e, Pos, "y")).toBe(0); // omitted → zero-fill
	});

	it("bare-def tag form and complete-values form still work", () => {
		const world = new ECS();
		const Frozen = world.registerComponent({} as const);
		const Pos = world.registerComponent({ x: "f64", y: "f64" } as const);
		const e = world.spawn();
		world.addComponent(e, Frozen);
		world.addComponent(e, Pos, { x: 1, y: 2 });
		expect(world.hasComponent(e, Frozen)).toBe(true);
		expect(world.getField(e, Pos, "y")).toBe(2);
	});
});
