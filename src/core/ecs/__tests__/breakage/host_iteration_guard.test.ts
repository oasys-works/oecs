// STRUCTURAL_DURING_ITERATION (dev guard): host-side structural mutations are
// immediate (0.5.0), so despawning / transitioning / toggling an entity of an
// archetype that a live host query walk is visiting would swap-remove rows
// under the iterator — entities get silently skipped or visited twice. The
// audit repro: 3 entities, despawn-in-forEach, only 2 died and 1 was never
// visited. The guard turns that into a loud dev error; mutations touching
// archetypes NOT being walked stay legal.
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";
import { ECSError, ECS_ERROR } from "../../utils/error";

function expectIterationGuard(fn: () => void): void {
	try {
		fn();
		expect.fail("expected STRUCTURAL_DURING_ITERATION");
	} catch (err) {
		expect(err).toBeInstanceOf(ECSError);
		expect((err as ECSError).category).toBe(ECS_ERROR.STRUCTURAL_DURING_ITERATION);
	}
}

describe("host iteration guard (STRUCTURAL_DURING_ITERATION)", () => {
	it("despawning a walked entity inside a host forEach throws instead of skipping rows", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		for (let i = 0; i < 3; i++) {
			const e = ecs.spawn();
			ecs.addComponent(e, Pos, { x: i });
		}
		const q = ecs.query(Pos);
		expectIterationGuard(() => {
			q.forEach((arch) => {
				for (let i = 0; i < arch.entityCount; i++) {
					ecs.despawn(arch.entityIds[i] as EntityID);
				}
			});
		});
		// The guard fired BEFORE any mutation (`removeRow` is `_destroyOne`'s
		// first write), so the failed despawn left all 3 entities intact.
		expect(q.entityCount).toBe(3);
	});

	it("removeComponent / addComponent transitions out of a walked archetype throw", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		const Tag = ecs.registerTag();
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 1 });
		const q = ecs.query(Pos);
		expectIterationGuard(() => {
			q.forEach(() => {
				ecs.removeComponent(e, Pos);
			});
		});
		expectIterationGuard(() => {
			q.forEach(() => {
				ecs.addComponent(e, Tag); // transition moves the row out of the walked archetype
			});
		});
	});

	it("disable of a walked entity throws inside eachChunk", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 1 });
		const q = ecs.query(Pos);
		expectIterationGuard(() => {
			q.eachChunk(() => {
				ecs.disable(e);
			});
		});
	});

	it("despawning an entity in a DIFFERENT archetype during the walk is legal", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		const Other = ecs.registerComponent(["y"] as const);
		const walked = ecs.spawn();
		ecs.addComponent(walked, Pos, { x: 1 });
		const bystander = ecs.spawn();
		ecs.addComponent(bystander, Other, { y: 2 });
		const q = ecs.query(Pos);
		let visited = 0;
		q.forEach((arch) => {
			visited += arch.entityCount;
			ecs.despawn(bystander);
		});
		expect(visited).toBe(1);
		expect(ecs.isAlive(bystander)).toBe(false);
		expect(ecs.isAlive(walked)).toBe(true);
	});

	it("collect-then-mutate after the walk stays the supported pattern", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		for (let i = 0; i < 3; i++) {
			const e = ecs.spawn();
			ecs.addComponent(e, Pos, { x: i });
		}
		const q = ecs.query(Pos);
		const doomed: EntityID[] = [];
		q.forEach((arch) => {
			for (let i = 0; i < arch.entityCount; i++) doomed.push(arch.entityIds[i] as EntityID);
		});
		for (const e of doomed) ecs.despawn(e);
		expect(q.entityCount).toBe(0);
	});

	it("deferred ctx.commands.despawn inside a system remains legal (flush applies it)", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 1 });
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			reads: [Pos],
			writes: [],
			despawns: [Pos],
			fn() {
				q.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						// deferred — applies at the phase flush, after the walk
						void arch.entityIds[i];
					}
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(0);
		expect(ecs.isAlive(e)).toBe(true);
	});
});
