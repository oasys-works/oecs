import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";
import type { EntityID } from "../../entity";

const DT = 0.5;

function moveWorld(n: number) {
	const world = new ECS({ memory: { columnCapacity: Math.max(n, 4) } });
	const Pos = world.registerComponent({ x: "f64", y: "f64" });
	const Vel = world.registerComponent({ vx: "f64", vy: "f64" });
	for (let i = 0; i < n; i++) {
		const e = world.spawn();
		world.addComponent(e, Pos, { x: i, y: 2 * i });
		world.addComponent(e, Vel, { vx: 1, vy: -1 });
	}
	return { world, Pos, Vel, q: world.query(Pos, Vel) };
}

describe("Query.eachChunk", () => {
	it("moves entities correctly (Pos += Vel*dt) via cols.mut / cols.read", () => {
		const N = 64;
		const { Pos, Vel, q } = moveWorld(N);
		q.eachChunk((cols, count) => {
			const { x, y } = cols.mut(Pos);
			const { vx, vy } = cols.read(Vel);
			for (let i = 0; i < count; i++) {
				x[i] += vx[i] * DT;
				y[i] += vy[i] * DT;
			}
		});
		const xs: number[] = [];
		const ys: number[] = [];
		q.forEach((arch) => {
			const x = arch.getColumnRead(Pos, "x");
			const y = arch.getColumnRead(Pos, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				xs.push(x[i]);
				ys.push(y[i]);
			}
		});
		expect(xs).toHaveLength(N);
		for (let i = 0; i < N; i++) {
			expect(xs[i]).toBeCloseTo(i + DT, 10);
			expect(ys[i]).toBeCloseTo(2 * i - DT, 10);
		}
	});

	it("hands back count === entityCount and covers every row exactly once", () => {
		const { q } = moveWorld(50);
		let total = 0;
		let chunks = 0;
		q.eachChunk((_cols, count) => {
			total += count;
			chunks++;
		});
		expect(total).toBe(50);
		expect(chunks).toBe(1);
	});

	it("cols.mut stamps the change tick; cols.read does not", () => {
		const { world, Pos, Vel, q } = moveWorld(4);
		// store._tick re-syncs at update() start, so two ticks push the visible
		// current tick to 1 — distinguishable from the setup stamp (0).
		world.update(0);
		world.update(0);
		const cur = world._getCurrentTick();
		expect(cur).toBeGreaterThanOrEqual(1);
		q.eachChunk((cols) => {
			cols.mut(Pos);
			cols.read(Vel);
		});
		for (const arch of q._nonEmpty()) {
			expect(arch._changedTick[Pos.id]).toBe(cur);
			expect(arch._changedTick[Vel.id]).not.toBe(cur);
		}
	});

	it("iterates correctly across multiple archetypes (cached group is not aliased)", () => {
		const world = new ECS({ memory: { columnCapacity: 32 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Vel = world.registerComponent({ vx: "f64", vy: "f64" });
		const Tag = world.registerTag();
		// 12 entities: even ids carry Tag (→ 2 archetypes), all carry Pos+Vel.
		for (let i = 0; i < 12; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: 0 });
			world.addComponent(e, Vel, { vx: 10, vy: 0 });
			if (i % 2 === 0) world.addComponent(e, Tag);
		}
		const q = world.query(Pos, Vel);
		let chunks = 0;
		let total = 0;
		q.eachChunk((cols, count) => {
			chunks++;
			total += count;
			const { x } = cols.mut(Pos);
			const { vx } = cols.read(Vel);
			for (let i = 0; i < count; i++) x[i] += vx[i] * DT;
		});
		expect(chunks).toBe(2);
		expect(total).toBe(12);
		// every entity advanced x by vx*DT = 5 from its initial x === id
		const seen: number[] = [];
		q.forEach((arch) => {
			const x = arch.getColumnRead(Pos, "x");
			for (let i = 0; i < arch.entityCount; i++) seen.push(x[i]);
		});
		seen.sort((a, b) => a - b);
		for (let i = 0; i < 12; i++) expect(seen[i]).toBeCloseTo(i + 5, 10);
	});

	it("honors includeDisabled(): default skips disabled rows; includeDisabled() spans and mutates them", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64" });
		const ids: EntityID[] = [];
		for (let i = 0; i < 6; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: 0 });
			ids.push(e);
		}
		// Disable two (host-side, immediate) → 4 enabled rows, 2 in the disabled tail.
		world.disable(ids[1]);
		world.disable(ids[4]);
		const q = world.query(Pos);

		// Default eachChunk visits only the enabled rows.
		let enabledSeen = 0;
		q.eachChunk((cols, count) => {
			enabledSeen += count;
			const { x } = cols.mut(Pos);
			for (let i = 0; i < count; i++) x[i] += 1;
		});
		expect(enabledSeen).toBe(4);

		// includeDisabled() widens the bound to all rows and reaches the disabled tail.
		let allSeen = 0;
		q.includeDisabled().eachChunk((cols, count) => {
			allSeen += count;
			const { x } = cols.mut(Pos);
			for (let i = 0; i < count; i++) x[i] += 10;
		});
		expect(allSeen).toBe(6);

		const vals: number[] = [];
		q.includeDisabled().forEach((arch) => {
			const x = arch.getColumnRead(Pos, "x");
			for (let i = 0; i < arch.entityCount; i++) vals.push(x[i]);
		});
		vals.sort((a, b) => a - b);
		// 2 disabled rows got +10 only → 10; 4 enabled rows got +1 then +10 → 11.
		expect(vals).toEqual([10, 10, 11, 11, 11, 11]);
	});

	it("is re-entrancy-safe: a nested eachChunk on the same query keeps the outer cursor", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64" });
		const Tag = world.registerTag();
		// Two archetypes with disjoint x ranges so a corrupted cursor is observable.
		for (const x of [100, 101, 102]) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x });
			world.addComponent(e, Tag);
		}
		for (const x of [200, 201]) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x });
		}
		const q = world.query(Pos);
		let innerPasses = 0;
		let didNest = false;
		const outerFirsts: number[] = [];
		q.eachChunk((cols) => {
			const before = cols.read(Pos).x[0];
			if (!didNest) {
				didNest = true; // nest exactly once (and stops the inner pass recursing)
				// Nested pass over the SAME query — must not re-point the outer cursor.
				q.eachChunk((inner) => {
					innerPasses++;
					void inner.read(Pos).x[0];
				});
			}
			// Re-reading the outer cursor must still resolve the outer archetype.
			const after = cols.read(Pos).x[0];
			expect(after).toBe(before);
			outerFirsts.push(before);
		});
		expect(innerPasses).toBe(2);
		expect(outerFirsts.sort((a, b) => a - b)).toEqual([100, 200]);
	});

	it("enforces system access: cols.mut(Pos) throws without writes:[Pos]", () => {
		const { world, Pos, Vel, q } = moveWorld(4);
		const bad = world.registerSystem({
			...openAccess([Vel]), // Pos intentionally undeclared
			fn: () => {
				q.eachChunk((cols) => {
					cols.mut(Pos);
				});
			}
		});
		world.addSystems(SCHEDULE.UPDATE, bad);
		world.startup();
		expect(() => world.update(0)).toThrow();
	});

	it("passes inside a system that declares the access", () => {
		const { world, Pos, Vel, q } = moveWorld(4);
		const good = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn: () => {
				q.eachChunk((cols, count) => {
					const { x, y } = cols.mut(Pos);
					const { vx, vy } = cols.read(Vel);
					for (let i = 0; i < count; i++) {
						x[i] += vx[i] * DT;
						y[i] += vy[i] * DT;
					}
				});
			}
		});
		world.addSystems(SCHEDULE.UPDATE, good);
		world.startup();
		expect(() => world.update(0)).not.toThrow();
	});
});
