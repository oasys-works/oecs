import { describe, expect, it, vi } from "vitest";
import { ECS } from "../../ecs";
import { Archetype } from "../../archetype";

// Component schemas. AttackRange + EngageRange deliberately share the field
// name `range` — the skirmisher template shape that motivated the ambiguous-
// override guard (#462).
function setup() {
	const ecs = new ECS({ memory: { columnCapacity: 64 } });
	const Position = ecs.registerComponent({ x: "f64", y: "f64" });
	const Velocity = ecs.registerComponent({ vx: "f64", vy: "f64" });
	const Health = ecs.registerComponent({ current: "i32", max: "i32" });
	const AttackRange = ecs.registerComponent({ range: "f64" });
	const EngageRange = ecs.registerComponent({ range: "f64" });
	const Tag = ecs.registerTag();
	return { ecs, Position, Velocity, Health, AttackRange, EngageRange, Tag };
}

describe("template / direct-spawn (#462)", () => {
	it("resolves the target archetype once, creating it if absent", () => {
		const { ecs, Position, Velocity } = setup();
		const before = ecs.archetypeCount;
		const p = ecs.template(Position({ x: 0, y: 0 }), Velocity({ vx: 0, vy: 0 }));
		const afterRegister = ecs.archetypeCount;
		expect(afterRegister).toBe(before + 1); // exactly one new archetype

		// Spawning never creates archetypes.
		ecs.spawn(p);
		ecs.spawn(p);
		expect(ecs.archetypeCount).toBe(afterRegister);

		// Re-registering the same mask reuses the archetype.
		const p2 = ecs.template(Velocity, Position);
		expect(ecs.archetypeCount).toBe(afterRegister);
		expect(p2).not.toBe(p);
	});

	it("spawn places the entity directly in the template archetype with defaults", () => {
		const { ecs, Position, Health } = setup();
		const p = ecs.template(Position({ x: 3, y: 4 }), Health({ current: 100, max: 120 }));
		const e = ecs.spawn(p);
		expect(ecs.isAlive(e)).toBe(true);
		expect(ecs.entityCount).toBe(1);
		expect(ecs.hasComponent(e, Position)).toBe(true);
		expect(ecs.hasComponent(e, Health)).toBe(true);
		expect(ecs.getField(e, Position, "x")).toBe(3);
		expect(ecs.getField(e, Position, "y")).toBe(4);
		expect(ecs.getField(e, Health, "current")).toBe(100);
		expect(ecs.getField(e, Health, "max")).toBe(120);
	});

	it("missing default values fall back to zero", () => {
		const { ecs, Position } = setup();
		const p = ecs.template(Position); // no values
		const e = ecs.spawn(p);
		expect(ecs.getField(e, Position, "x")).toBe(0);
		expect(ecs.getField(e, Position, "y")).toBe(0);
	});

	it("applies flat per-instance overrides on top of defaults", () => {
		const { ecs, Position, Health } = setup();
		const p = ecs.template(Position({ x: 0, y: 0 }), Health({ current: 100, max: 100 }));
		const e = ecs.spawn(p, { x: 10, current: 25 });
		expect(ecs.getField(e, Position, "x")).toBe(10); // overridden
		expect(ecs.getField(e, Position, "y")).toBe(0); // default
		expect(ecs.getField(e, Health, "current")).toBe(25); // overridden
		expect(ecs.getField(e, Health, "max")).toBe(100); // default
	});

	it("throws (dev) when overriding an ambiguous field name", () => {
		const { ecs, AttackRange, EngageRange } = setup();
		const p = ecs.template(AttackRange({ range: 5 }), EngageRange({ range: 7 }));
		// Spawning with the ambiguous defaults is fine.
		const e = ecs.spawn(p);
		expect(ecs.getField(e, AttackRange, "range")).toBe(5);
		expect(ecs.getField(e, EngageRange, "range")).toBe(7);
		// But a flat override of the shared `range` field is ambiguous.
		expect(() => ecs.spawn(p, { range: 9 })).toThrow(/ambiguous/);
	});

	it("throws (dev) when overriding an unknown field name", () => {
		const { ecs, Position } = setup();
		const p = ecs.template(Position({ x: 0, y: 0 }));
		// The typed surface rejects `z` at compile time; widen to the untyped
		// map to prove the runtime guard still catches untyped call sites.
		const overrides: Record<string, number> = { z: 1 };
		expect(() => ecs.spawn(p, overrides)).toThrow(/no field/);
	});

	it("spawn_many bulk-spawns identical entities with correct rows + defaults", () => {
		const { ecs, Position, Health } = setup();
		const p = ecs.template(Position({ x: 1, y: 2 }), Health({ current: 50, max: 50 }));
		const ids = ecs.spawnMany(p, 500);
		expect(ids.length).toBe(500);
		expect(ecs.entityCount).toBe(500);
		// All distinct, all alive, all carry the template defaults.
		expect(new Set(ids.map((id) => id as number)).size).toBe(500);
		for (const id of ids) {
			expect(ecs.isAlive(id)).toBe(true);
			expect(ecs.getField(id, Position, "x")).toBe(1);
			expect(ecs.getField(id, Health, "max")).toBe(50);
		}
	});

	it("spawn_many applies one shared overrides object to every spawned row", () => {
		const { ecs, Position, Health } = setup();
		const p = ecs.template(Position({ x: 1, y: 2 }), Health({ current: 50, max: 50 }));
		const ids = ecs.spawnMany(p, 100, { x: 9, current: 25 });
		for (const id of ids) {
			expect(ecs.getField(id, Position, "x")).toBe(9); // overridden
			expect(ecs.getField(id, Position, "y")).toBe(2); // default
			expect(ecs.getField(id, Health, "current")).toBe(25); // overridden
			expect(ecs.getField(id, Health, "max")).toBe(50); // default
		}
	});

	it("spawn_many overrides take the per-row path when the target holds disabled rows", () => {
		const { ecs, Position } = setup();
		const p = ecs.template(Position({ x: 1, y: 2 }));
		// Force a disabled row in the target archetype so the bulk append can't
		// land contiguously (`disabledCount > 0` branch).
		const sleeper = ecs.spawn(p);
		ecs.disable(sleeper);
		const ids = ecs.spawnMany(p, 10, { x: 7 });
		for (const id of ids) {
			expect(ecs.getField(id, Position, "x")).toBe(7);
			expect(ecs.getField(id, Position, "y")).toBe(2);
		}
	});

	it("spawn_many throws (dev) on ambiguous / unknown override field names", () => {
		const { ecs, Position, AttackRange, EngageRange } = setup();
		const dup = ecs.template(AttackRange({ range: 5 }), EngageRange({ range: 7 }));
		expect(() => ecs.spawnMany(dup, 3, { range: 9 })).toThrow(/ambiguous/);
		const single = ecs.template(Position);
		const overrides: Record<string, number> = { z: 1 };
		expect(() => ecs.spawnMany(single, 3, overrides)).toThrow(/no field/);
	});

	it("spawn_many of 0 returns an empty array and spawns nothing", () => {
		const { ecs, Position } = setup();
		const p = ecs.template(Position);
		expect(ecs.spawnMany(p, 0)).toEqual([]);
		expect(ecs.entityCount).toBe(0);
	});

	it("supports tag-only templates", () => {
		const { ecs, Tag } = setup();
		const p = ecs.template(Tag);
		const e = ecs.spawn(p);
		expect(ecs.isAlive(e)).toBe(true);
		expect(ecs.hasComponent(e, Tag)).toBe(true);
	});

	it("performs ZERO archetype transitions (no move_entity_from)", () => {
		const { ecs, Position, Velocity, Health } = setup();
		const p = ecs.template(Position, Velocity, Health);

		const spy = vi.spyOn(Archetype.prototype, "moveEntityFrom");
		ecs.spawn(p);
		ecs.spawn(p, { x: 1 });
		ecs.spawnMany(p, 10);
		expect(spy).not.toHaveBeenCalled();

		// Contrast: building the same 3-component entity via create + addComponent
		// pays a transition copy per component after the first.
		const e = ecs.spawn();
		ecs.addComponent(e, Position, { x: 0, y: 0 });
		ecs.addComponent(e, Velocity, { vx: 0, vy: 0 });
		ecs.addComponent(e, Health, { current: 0, max: 0 });
		expect(spy.mock.calls.length).toBe(2); // 2nd + 3rd add move; 1st is a bare append
		spy.mockRestore();
	});
});
