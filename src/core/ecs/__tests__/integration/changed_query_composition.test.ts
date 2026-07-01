// M6 — ChangedQuery is composable.
//
// `q.changed(...)` used to return a terminal `ChangedQuery` exposing only
// `forEach`, so refining AFTER it (`q.changed(Pos).without(Dead)`) was
// impossible — you had to remember to refine BEFORE
// (`q.without(Dead).changed(Pos)`). ChangedQuery now mirrors the dense query
// verbs (`and` / `without` / `anyOf` / `optional`); each refines the underlying
// query and re-wraps, so the order no longer matters and the result set is
// identical either way.
//
// Each test puts its entities in DISTINCT archetypes and counts archetype visits,
// so a visit count directly reflects which archetypes the composed filter kept.
// A `Pos`-writer runs first (ordered before the detector) and bumps `Pos`'s
// changed-tick on every Pos archetype, so `changed(Pos)` sees them all.

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";
import type { ComponentDef } from "../../component";
import type { ArchetypeView } from "../../archetype";
import type { SystemDescriptor } from "../../system";

/** Register a system that bumps `Pos`'s changed-tick on every archetype with Pos. */
function posWriter(world: ECS, Pos: ComponentDef): SystemDescriptor {
	const wq = world.query(Pos);
	return world.registerSystem({
		...openAccess([Pos]),
		fn(ctx) {
			for (const arch of wq._nonEmpty()) arch.getColumn(Pos, "x", ctx.ecsTick);
		}
	});
}

describe("ChangedQuery composition (M6)", () => {
	it(".without() after .changed() excludes the matching archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);
		const Dead = world.registerComponent(["d"] as const);

		const live = world.createEntity();
		world.addComponent(live, Pos, { x: 0 });
		world.addComponent(live, Vel, { vx: 0 });
		const dead = world.createEntity();
		world.addComponent(dead, Pos, { x: 0 });
		world.addComponent(dead, Vel, { vx: 0 });
		world.addComponent(dead, Dead, { d: 0 });

		let base = 0;
		let filtered = 0;
		const dq = world.query(Pos, Vel);
		const writer = posWriter(world, Pos);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel, Dead]),
			fn() {
				dq.changed(Pos).forEach(() => base++);
				dq.changed(Pos)
					.without(Dead)
					.forEach(() => filtered++);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();
		world.update(1 / 60);

		expect(base).toBe(2); // {Pos,Vel} and {Pos,Vel,Dead} both changed Pos
		expect(filtered).toBe(1); // .without(Dead) drops the {Pos,Vel,Dead} archetype
	});

	it("composing after changed() equals refining before it (order-independent)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);
		const Dead = world.registerComponent(["d"] as const);

		const live = world.createEntity();
		world.addComponent(live, Pos, { x: 0 });
		world.addComponent(live, Vel, { vx: 0 });
		const dead = world.createEntity();
		world.addComponent(dead, Pos, { x: 0 });
		world.addComponent(dead, Vel, { vx: 0 });
		world.addComponent(dead, Dead, { d: 0 });

		let after = 0;
		let before = 0;
		const dq = world.query(Pos, Vel);
		const writer = posWriter(world, Pos);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel, Dead]),
			fn() {
				dq.changed(Pos)
					.without(Dead)
					.forEach(() => after++); // refine AFTER changed()
				dq.without(Dead)
					.changed(Pos)
					.forEach(() => before++); // refine BEFORE changed()
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();
		world.update(1 / 60);

		expect(after).toBe(before);
		expect(after).toBe(1);
	});

	it(".and() after .changed() narrows the matched set", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);

		const bare = world.createEntity();
		world.addComponent(bare, Pos, { x: 0 }); // {Pos}
		const moving = world.createEntity();
		world.addComponent(moving, Pos, { x: 0 });
		world.addComponent(moving, Vel, { vx: 0 }); // {Pos,Vel}

		let base = 0;
		let narrowed = 0;
		const dq = world.query(Pos);
		const writer = posWriter(world, Pos);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn() {
				dq.changed(Pos).forEach(() => base++);
				dq.changed(Pos)
					.and(Vel)
					.forEach(() => narrowed++);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();
		world.update(1 / 60);

		expect(base).toBe(2); // {Pos} and {Pos,Vel}
		expect(narrowed).toBe(1); // .and(Vel) keeps only {Pos,Vel}
	});

	it(".anyOf() after .changed() keeps archetypes with at least one term", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);
		const Tag = world.registerComponent(["t"] as const);

		const bare = world.createEntity();
		world.addComponent(bare, Pos, { x: 0 }); // {Pos} — neither Vel nor Tag
		const moving = world.createEntity();
		world.addComponent(moving, Pos, { x: 0 });
		world.addComponent(moving, Vel, { vx: 0 }); // {Pos,Vel}
		const tagged = world.createEntity();
		world.addComponent(tagged, Pos, { x: 0 });
		world.addComponent(tagged, Tag, { t: 0 }); // {Pos,Tag}

		let base = 0;
		let any = 0;
		const dq = world.query(Pos);
		const writer = posWriter(world, Pos);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel, Tag]),
			fn() {
				dq.changed(Pos).forEach(() => base++);
				dq.changed(Pos)
					.anyOf(Vel, Tag)
					.forEach(() => any++);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();
		world.update(1 / 60);

		expect(base).toBe(3); // {Pos}, {Pos,Vel}, {Pos,Tag}
		expect(any).toBe(2); // .anyOf(Vel, Tag) keeps {Pos,Vel} and {Pos,Tag}, drops {Pos}
	});

	it(".optional() carries the optional scope into the changed loop", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 0 });
		world.addComponent(e, Vel, { vx: 7 });

		let sawVel = 0;
		const dq = world.query(Pos);
		const writer = posWriter(world, Pos);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn() {
				// `getOptionalColumnRead` throws in __DEV__ unless `.optional(Vel)`
				// declared it — so reaching it without throwing proves the optional
				// scope carried through the composed ChangedQuery's forEach.
				dq.changed(Pos)
					.optional(Vel)
					.forEach((arch: ArchetypeView) => {
						const vx = arch.getOptionalColumnRead(Vel, "vx");
						if (vx !== undefined) sawVel += vx[0];
					});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();
		world.update(1 / 60);

		expect(sawVel).toBe(7);
	});
});
