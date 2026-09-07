// STRUCTURAL_DURING_ITERATION, a dev guard. A host-side structural mutation
// applies at once. So despawning, transitioning or toggling an entity of an
// archetype that a live host query walk is visiting swap-removes rows under
// the iterator, and the walk then skips an entity or visits one twice. The
// guard turns that into a loud dev error. A mutation that touches no archetype
// under the walk stays legal.
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../phase";
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
		// The guard fired before any mutation (`removeRow` is `_destroyOne`'s
		// first write), so the failed despawn left all 3 entities intact.
		expect(q.entityCount).toBe(3);
	});

	it("removeComponent and addComponent transitions out of a walked archetype throw", () => {
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

	it("disable of a walked entity throws inside forEachChunk", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent(["x"] as const);
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 1 });
		const q = ecs.query(Pos);
		expectIterationGuard(() => {
			q.forEachChunk(() => {
				ecs.disable(e);
			});
		});
	});

	it("despawning an entity in a different archetype during the walk is legal", () => {
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
						// deferred, applies at the phase flush, after the walk
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
