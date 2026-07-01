import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

describe("Tag components", () => {
	//=========================================================
	// registerTag
	//=========================================================

	it("register_tag returns a valid ComponentDef", () => {
		const world = new ECS();
		const Tag = world.registerTag();

		// At runtime, a ComponentDef is just a branded number (ComponentID)
		expect(typeof Tag.id).toBe("number");
	});

	it("multiple register_tag calls return distinct IDs", () => {
		const world = new ECS();
		const TagA = world.registerTag();
		const TagB = world.registerTag();

		expect(TagA).not.toBe(TagB);
	});

	//=========================================================
	// addComponent with tag (no values arg)
	//=========================================================

	it("add_component with tag requires no values argument", () => {
		const world = new ECS();
		const IsEnemy = world.registerTag();

		const e = world.createEntity();
		// Should compile and work without a values argument
		world.addComponent(e, IsEnemy);

		expect(world.hasComponent(e, IsEnemy)).toBe(true);
	});

	it("add_component with tag creates correct archetype transition", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const IsEnemy = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		world.addComponent(e, IsEnemy);

		expect(world.hasComponent(e, Pos)).toBe(true);
		expect(world.hasComponent(e, IsEnemy)).toBe(true);
	});

	//=========================================================
	// hasComponent / removeComponent with tags
	//=========================================================

	it("has_component returns false before tag is added", () => {
		const world = new ECS();
		const Tag = world.registerTag();

		const e = world.createEntity();
		expect(world.hasComponent(e, Tag)).toBe(false);
	});

	it("remove_component works for tags", () => {
		const world = new ECS();
		const Tag = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Tag);
		expect(world.hasComponent(e, Tag)).toBe(true);

		world.removeComponent(e, Tag);
		expect(world.hasComponent(e, Tag)).toBe(false);
	});

	it("remove_component on tag preserves other component data", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Tag = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 42, y: 99 });
		world.addComponent(e, Tag);

		world.removeComponent(e, Tag);

		expect(world.hasComponent(e, Pos)).toBe(true);
		expect(world.hasComponent(e, Tag)).toBe(false);

		// Verify position data survived via forEach
		world.query(Pos).forEach((arch) => {
			const px = arch.getColumnRead(Pos, "x");
			const py = arch.getColumnRead(Pos, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(px[i]).toBe(42);
				expect(py[i]).toBe(99);
			}
		});
	});

	//=========================================================
	// Query matching with tags
	//=========================================================

	it("tags participate in query matching", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const IsEnemy = world.registerTag();

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, IsEnemy);

		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 3, y: 4 });

		// Query requiring tag should only match e1
		const q = world.query(Pos).and(IsEnemy);
		const entities: number[] = [];
		q.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entities.push(a.entityIds[i]);
		});
		expect(entities).toContain(e1);
		expect(entities).not.toContain(e2);
	});

	it("query.not(tag) excludes tagged entities", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const IsDead = world.registerTag();

		const alive = world.createEntity();
		world.addComponent(alive, Pos, { x: 1, y: 2 });

		const dead = world.createEntity();
		world.addComponent(dead, Pos, { x: 3, y: 4 });
		world.addComponent(dead, IsDead);

		const q = world.query(Pos).without(IsDead);
		const entities: number[] = [];
		q.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entities.push(a.entityIds[i]);
		});
		expect(entities).toContain(alive);
		expect(entities).not.toContain(dead);
	});

	it("tag archetype has no columns for the tag component", () => {
		const world = new ECS();
		const Tag = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Tag);

		// White-box: `hasColumns` is an internal detail, not on the public
		// view — iterate the concrete archetype list.
		let checked = false;
		for (const arch of world.query(Tag)._nonEmpty()) {
			expect(arch.entityCount).toBe(1);
			expect(arch.hasColumns).toBe(false);
			checked = true;
		}
		expect(checked).toBe(true);
	});

	//=========================================================
	// Deferred addComponent with tag via system
	//=========================================================

	it("deferred add_component with tag works via system", () => {
		const world = new ECS();
		const Tag = world.registerTag();

		const e = world.createEntity();

		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn(ctx) {
				ctx.addComponent(e, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		// Not yet applied
		expect(world.hasComponent(e, Tag)).toBe(false);

		world.update(0);

		expect(world.hasComponent(e, Tag)).toBe(true);
	});

	//=========================================================
	// Multiple tags compose correctly
	//=========================================================

	it("multiple tags compose into correct archetype", () => {
		const world = new ECS();
		const TagA = world.registerTag();
		const TagB = world.registerTag();
		const TagC = world.registerTag();

		const e1 = world.createEntity();
		world.addComponent(e1, TagA);
		world.addComponent(e1, TagB);

		const e2 = world.createEntity();
		world.addComponent(e2, TagA);
		world.addComponent(e2, TagB);
		world.addComponent(e2, TagC);

		// Query for TagA + TagB should match both
		const qAb = world.query(TagA).and(TagB);
		const entitiesAb: number[] = [];
		qAb.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entitiesAb.push(a.entityIds[i]);
		});
		expect(entitiesAb).toContain(e1);
		expect(entitiesAb).toContain(e2);

		// Query for TagA + TagB + TagC should only match e2
		const qAbc = world.query(TagA).and(TagB, TagC);
		const entitiesAbc: number[] = [];
		qAbc.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entitiesAbc.push(a.entityIds[i]);
		});
		expect(entitiesAbc).not.toContain(e1);
		expect(entitiesAbc).toContain(e2);
	});

	it("tags mixed with data components work correctly", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const IsEnemy = world.registerTag();
		const IsBoss = world.registerTag();

		const minion = world.createEntity();
		world.addComponent(minion, Pos, { x: 0, y: 0 });
		world.addComponent(minion, Vel, { vx: 1, vy: 0 });
		world.addComponent(minion, IsEnemy);

		const boss = world.createEntity();
		world.addComponent(boss, Pos, { x: 10, y: 10 });
		world.addComponent(boss, Vel, { vx: 0, vy: 1 });
		world.addComponent(boss, IsEnemy);
		world.addComponent(boss, IsBoss);

		// All enemies with position
		const qEnemies = world.query(Pos).and(IsEnemy);
		const enemies: number[] = [];
		qEnemies.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) enemies.push(a.entityIds[i]);
		});
		expect(enemies).toContain(minion);
		expect(enemies).toContain(boss);

		// Only bosses
		const qBosses = world.query(Pos).and(IsEnemy, IsBoss);
		const bosses: number[] = [];
		qBosses.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) bosses.push(a.entityIds[i]);
		});
		expect(bosses).not.toContain(minion);
		expect(bosses).toContain(boss);

		// Data columns still accessible alongside tags
		qBosses.forEach((arch) => {
			const px = arch.getColumnRead(Pos, "x");
			const py = arch.getColumnRead(Pos, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(px[i]).toBe(10);
				expect(py[i]).toBe(10);
			}
		});
	});

	//=========================================================
	// forEach skips empty archetypes
	//=========================================================

	it("for_each skips empty archetypes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const q = world.query(Pos);

		// Destroy entity to leave archetype empty
		world.destroyEntity(e1);
		world.flush();

		let iteratedCount = 0;
		q.forEach(() => {
			iteratedCount++;
		});
		expect(iteratedCount).toBe(0);
	});

	it("for_each yields only non-empty archetypes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		// e1: Pos only
		const e1 = world.createEntity();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		// e2: Pos + Vel (creates a second archetype matching Pos)
		const e2 = world.createEntity();
		world.addComponent(e2, Pos, { x: 3, y: 4 });
		world.addComponent(e2, Vel, { vx: 5, vy: 6 });

		const q = world.query(Pos);
		// Two archetypes contain Pos
		expect(q.archetypeCount).toBe(2);

		// Destroy e1 to empty one archetype
		world.destroyEntity(e1);
		world.flush();

		// forEach should skip the empty one
		let iteratedCount = 0;
		q.forEach((arch) => {
			iteratedCount++;
			expect(arch.entityCount).toBeGreaterThan(0);
		});
		expect(iteratedCount).toBe(1);
	});
});
