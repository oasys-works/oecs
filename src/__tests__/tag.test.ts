import { describe, expect, it } from "vitest";
import { ECS } from "../ecs";
import { SCHEDULE } from "../schedule";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

describe("Tag components", () => {
  //=========================================================
  // register_tag
  //=========================================================

  it("register_tag returns a valid ComponentDef", () => {
    const world = new ECS();
    const Tag = world.register_tag();

    // At runtime, a ComponentDef is just a branded number (ComponentID)
    expect(typeof (Tag as unknown as number)).toBe("number");
  });

  it("multiple register_tag calls return distinct IDs", () => {
    const world = new ECS();
    const TagA = world.register_tag();
    const TagB = world.register_tag();

    expect(TagA).not.toBe(TagB);
  });

  //=========================================================
  // add_component with tag (no values arg)
  //=========================================================

  it("add_component with tag requires no values argument", () => {
    const world = new ECS();
    const IsEnemy = world.register_tag();

    const e = world.create_entity();
    // Should compile and work without a values argument
    world.add_component(e, IsEnemy);

    expect(world.has_component(e, IsEnemy)).toBe(true);
  });

  it("add_component with tag creates correct archetype transition", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const IsEnemy = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    world.add_component(e, IsEnemy);

    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.has_component(e, IsEnemy)).toBe(true);
  });

  //=========================================================
  // has_component / remove_component with tags
  //=========================================================

  it("has_component returns false before tag is added", () => {
    const world = new ECS();
    const Tag = world.register_tag();

    const e = world.create_entity();
    expect(world.has_component(e, Tag)).toBe(false);
  });

  it("remove_component works for tags", () => {
    const world = new ECS();
    const Tag = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Tag);
    expect(world.has_component(e, Tag)).toBe(true);

    world.remove_component(e, Tag);
    expect(world.has_component(e, Tag)).toBe(false);
  });

  it("remove_component on tag preserves other component data", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Tag = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 42, y: 99 });
    world.add_component(e, Tag);

    world.remove_component(e, Tag);

    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.has_component(e, Tag)).toBe(false);

    // Verify position data survived via for..of
    for (const arch of world.query(Pos)) {
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(px[i]).toBe(42);
        expect(py[i]).toBe(99);
      }
    }
  });

  //=========================================================
  // Query matching with tags
  //=========================================================

  it("tags participate in query matching", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const IsEnemy = world.register_tag();

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, IsEnemy);

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });

    // Query requiring tag should only match e1
    const q = world.query(Pos).and(IsEnemy);
    const entities = [...q].flatMap((a) => [...a.entity_list]);
    expect(entities).toContain(e1);
    expect(entities).not.toContain(e2);
  });

  it("query.not(tag) excludes tagged entities", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const IsDead = world.register_tag();

    const alive = world.create_entity();
    world.add_component(alive, Pos, { x: 1, y: 2 });

    const dead = world.create_entity();
    world.add_component(dead, Pos, { x: 3, y: 4 });
    world.add_component(dead, IsDead);

    const q = world.query(Pos).not(IsDead);
    const entities = [...q].flatMap((a) => [...a.entity_list]);
    expect(entities).toContain(alive);
    expect(entities).not.toContain(dead);
  });

  it("tag archetype has no columns for the tag component", () => {
    const world = new ECS();
    const Tag = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Tag);

    // Verify via for..of — tag archetype has no columns for the tag
    let checked = false;
    for (const arch of world.query(Tag)) {
      expect(arch.entity_count).toBe(1);
      expect(arch.has_columns).toBe(false);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  //=========================================================
  // Deferred add_component with tag via system
  //=========================================================

  it("deferred add_component with tag works via system", () => {
    const world = new ECS();
    const Tag = world.register_tag();

    const e = world.create_entity();

    const sys = world.register_system({
      fn(ctx) {
        ctx.add_component(e, Tag);
      },
    });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();

    // Not yet applied
    expect(world.has_component(e, Tag)).toBe(false);

    world.update(0);

    expect(world.has_component(e, Tag)).toBe(true);
  });

  //=========================================================
  // Multiple tags compose correctly
  //=========================================================

  it("multiple tags compose into correct archetype", () => {
    const world = new ECS();
    const TagA = world.register_tag();
    const TagB = world.register_tag();
    const TagC = world.register_tag();

    const e1 = world.create_entity();
    world.add_component(e1, TagA);
    world.add_component(e1, TagB);

    const e2 = world.create_entity();
    world.add_component(e2, TagA);
    world.add_component(e2, TagB);
    world.add_component(e2, TagC);

    // Query for TagA + TagB should match both
    const q_ab = world.query(TagA).and(TagB);
    const entities_ab = [...q_ab].flatMap((a) => [...a.entity_list]);
    expect(entities_ab).toContain(e1);
    expect(entities_ab).toContain(e2);

    // Query for TagA + TagB + TagC should only match e2
    const q_abc = world.query(TagA).and(TagB, TagC);
    const entities_abc = [...q_abc].flatMap((a) => [...a.entity_list]);
    expect(entities_abc).not.toContain(e1);
    expect(entities_abc).toContain(e2);
  });

  it("tags mixed with data components work correctly", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const IsEnemy = world.register_tag();
    const IsBoss = world.register_tag();

    const minion = world.create_entity();
    world.add_component(minion, Pos, { x: 0, y: 0 });
    world.add_component(minion, Vel, { vx: 1, vy: 0 });
    world.add_component(minion, IsEnemy);

    const boss = world.create_entity();
    world.add_component(boss, Pos, { x: 10, y: 10 });
    world.add_component(boss, Vel, { vx: 0, vy: 1 });
    world.add_component(boss, IsEnemy);
    world.add_component(boss, IsBoss);

    // All enemies with position
    const q_enemies = world.query(Pos).and(IsEnemy);
    const enemies = [...q_enemies].flatMap((a) => [...a.entity_list]);
    expect(enemies).toContain(minion);
    expect(enemies).toContain(boss);

    // Only bosses
    const q_bosses = world.query(Pos).and(IsEnemy, IsBoss);
    const bosses = [...q_bosses].flatMap((a) => [...a.entity_list]);
    expect(bosses).not.toContain(minion);
    expect(bosses).toContain(boss);

    // Data columns still accessible alongside tags
    for (const arch of q_bosses) {
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(px[i]).toBe(10);
        expect(py[i]).toBe(10);
      }
    }
  });

  //=========================================================
  // Iterator skips empty archetypes
  //=========================================================

  it("iterator skips empty archetypes", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const q = world.query(Pos);

    // Destroy entity to leave archetype empty
    world.destroy_entity_deferred(e1);
    world.flush();

    const iterated: any[] = [];
    for (const arch of q) {
      iterated.push(arch);
    }
    expect(iterated.length).toBe(0);
  });

  it("iterator yields only non-empty archetypes", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    // e1: Pos only
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    // e2: Pos + Vel (creates a second archetype matching Pos)
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });
    world.add_component(e2, Vel, { vx: 5, vy: 6 });

    const q = world.query(Pos);
    // Two archetypes contain Pos
    expect(q.archetype_count).toBe(2);

    // Destroy e1 to empty one archetype
    world.destroy_entity_deferred(e1);
    world.flush();

    // Iterator should skip the empty one
    const iterated = [...q];
    expect(iterated.length).toBe(1);
    expect(iterated[0].entity_count).toBeGreaterThan(0);
  });
});
