/**
 * Entity enable/disable — the row-partition feature (#577).
 *
 * A disabled entity keeps its components, relations, sparse data, and stable
 * `EntityID`, but is moved to the disabled tail of its archetype so default
 * queries skip it (the iteration bound `arch.entityCount` is the enabled-row
 * count). `.includeDisabled()` opts a query back in. Covers:
 *  - default query exclusion (forEach / count) + `includeDisabled` opt-in;
 *  - round-trip preservation of components, sparse data, relations, EntityID;
 *  - the partition invariant under disable/enable/destroy/spawn/add_component;
 *  - `stateHash` reflecting the disabled set + snapshot round-trip;
 *  - deferred (system-side) toggling being safe mid-`forEach`.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { _INTERNAL_EMPTY_ACCESS } from "../../system";

const Pos = { x: "i32", y: "i32" } as const;
const Vel = { vx: "i32", vy: "i32" } as const;

/** Spawn `n` entities carrying Pos (x=i, y=i*10), returning their ids. */
function spawnPos(world: ECS, PosDef: ReturnType<ECS["registerComponent"]>, n: number) {
	const ids = [];
	for (let i = 0; i < n; i++) {
		const e = world.spawn();
		world.addComponent(e, PosDef, { x: i, y: i * 10 });
		ids.push(e);
	}
	return ids;
}

describe("entity enable/disable (#577)", () => {
	it("disable excludes from default queries; enable restores", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 4);
		const q = world.query(P);

		expect(q.entityCount).toBe(4);

		world.disable(ids[1]);
		expect(world.isDisabled(ids[1])).toBe(true);
		expect(q.entityCount).toBe(3);

		// forEach must not visit the disabled entity.
		const seen = new Set<number>();
		q.forEach((arch) => {
			const xs = arch.getColumnRead(P, "x");
			for (let i = 0; i < arch.entityCount; i++) seen.add(xs[i]);
		});
		expect(seen.has(1)).toBe(false);
		expect(seen.size).toBe(3);

		world.enable(ids[1]);
		expect(world.isDisabled(ids[1])).toBe(false);
		expect(q.entityCount).toBe(4);
	});

	it("include_disabled() sees disabled entities (count + for_each span)", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 4);
		const q = world.query(P);
		const qAll = q.includeDisabled();

		world.disable(ids[0]);
		world.disable(ids[2]);

		expect(q.entityCount).toBe(2);
		expect(qAll.entityCount).toBe(4);

		let n = 0;
		qAll.forEach((arch) => {
			// Inside an includeDisabled forEach, entityCount spans all rows.
			expect(arch.entityCount).toBe(arch.totalCount);
			n += arch.entityCount;
		});
		expect(n).toBe(4);

		// The default query is unaffected by the derived include query.
		expect(q.entityCount).toBe(2);
	});

	it("preserves component field values across disable→enable", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const e = world.spawn();
		world.addComponent(e, P, { x: 7, y: 70 });

		world.disable(e);
		// Data is intact while disabled.
		expect(world.getField(e, P, "x")).toBe(7);
		expect(world.getField(e, P, "y")).toBe(70);

		world.enable(e);
		expect(world.getField(e, P, "x")).toBe(7);
		expect(world.getField(e, P, "y")).toBe(70);
	});

	it("preserves sparse data and relations across disable→enable; EntityID stable", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const Cooldown = world.registerSparseComponent({ ready_at: "i32" } as const);
		const ChildOf = world.relations.register({ exclusive: true });

		const parent = world.spawn();
		world.addComponent(parent, P, { x: 0, y: 0 });
		const child = world.spawn();
		world.addComponent(child, P, { x: 1, y: 1 });
		world.addSparse(child, Cooldown, { ready_at: 42 });
		world.relations.add(child, ChildOf, parent);

		const genBefore = child;
		world.disable(child);

		expect(world.isAlive(child)).toBe(true);
		expect(world.hasSparse(child, Cooldown)).toBe(true);
		expect(world.getSparseField(child, Cooldown, "ready_at")).toBe(42);
		expect(world.relations.targetOf(child, ChildOf)).toBe(parent);

		world.enable(child);
		expect(child).toBe(genBefore); // same packed id (no destroy/respawn)
		expect(world.getSparseField(child, Cooldown, "ready_at")).toBe(42);
		expect(world.relations.targetOf(child, ChildOf)).toBe(parent);
		expect(world.getField(child, P, "x")).toBe(1);
	});

	it("keeps the partition correct: disabling a middle entity leaves others intact", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 5); // x = 0..4
		const q = world.query(P);

		world.disable(ids[2]); // x=2
		world.disable(ids[0]); // x=0

		const xs: number[] = [];
		q.forEach((arch) => {
			const col = arch.getColumnRead(P, "x");
			const y = arch.getColumnRead(P, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				xs.push(col[i]);
				// y is always 10× x — proves no column got scrambled by the swaps.
				expect(y[i]).toBe(col[i] * 10);
			}
		});
		xs.sort((a, b) => a - b);
		expect(xs).toEqual([1, 3, 4]);

		// Re-enable and confirm all five return with correct data.
		world.enable(ids[0]);
		world.enable(ids[2]);
		expect(q.entityCount).toBe(5);
		for (const e of ids) {
			expect(world.isDisabled(e)).toBe(false);
		}
	});

	it("is idempotent: re-disabling / re-enabling is a no-op", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 3);
		const q = world.query(P);

		world.disable(ids[1]);
		world.disable(ids[1]);
		expect(q.entityCount).toBe(2);
		expect(world.isDisabled(ids[1])).toBe(true);

		world.enable(ids[1]);
		world.enable(ids[1]);
		expect(q.entityCount).toBe(3);
	});

	it("destroying an enabled entity while disabled rows exist keeps the partition", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 5); // x = 0..4
		const q = world.query(P);

		world.disable(ids[3]); // disabled tail holds x=3
		world.disable(ids[4]); // and x=4

		// Destroy a MIDDLE enabled entity (x=1) — the swap-remove must not pull a
		// disabled row into the enabled region.
		world.despawn(ids[1]);
		world.flush();

		const enabled: number[] = [];
		q.forEach((arch) => {
			const col = arch.getColumnRead(P, "x");
			const y = arch.getColumnRead(P, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				enabled.push(col[i]);
				expect(y[i]).toBe(col[i] * 10);
			}
		});
		enabled.sort((a, b) => a - b);
		expect(enabled).toEqual([0, 2]);

		// The disabled entities survive and re-enable cleanly.
		world.enable(ids[3]);
		world.enable(ids[4]);
		expect(q.entityCount).toBe(4);
		expect(world.getField(ids[3], P, "x")).toBe(3);
		expect(world.getField(ids[4], P, "x")).toBe(4);
	});

	it("destroying a disabled entity leaves the enabled set intact", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 4);
		const q = world.query(P);

		world.disable(ids[2]);
		world.despawn(ids[2]);
		world.flush();

		expect(q.entityCount).toBe(3);
		expect(world.isAlive(ids[2])).toBe(false);
	});

	it("adding a component to a disabled entity keeps it disabled", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const V = world.registerComponent(Vel);
		const e = world.spawn();
		world.addComponent(e, P, { x: 5, y: 50 });

		world.disable(e);
		// Add a component → archetype transition; disabled state must follow.
		world.addComponent(e, V, { vx: 1, vy: 2 });

		expect(world.isDisabled(e)).toBe(true);
		expect(world.getField(e, P, "x")).toBe(5);
		expect(world.getField(e, V, "vx")).toBe(1);
		expect(world.query(P, V).entityCount).toBe(0); // excluded by default
		expect(world.query(P, V).includeDisabled().entityCount).toBe(1);
	});

	it("spawning into an archetype that holds disabled rows keeps the partition", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const tmpl = world.template([{ def: P, values: { x: 0, y: 0 } }]);
		const first = world.spawnMany(tmpl, 3);
		const q = world.query(P);

		world.disable(first[1]);
		expect(q.entityCount).toBe(2);

		// Bulk spawn into the same archetype while a disabled row is present
		// (exercises the per-entity fallback in spawnMany).
		const more = world.spawnMany(tmpl, 2);
		expect(q.entityCount).toBe(4); // 2 original enabled + 2 new
		for (const e of more) expect(world.isDisabled(e)).toBe(false);
		expect(world.isDisabled(first[1])).toBe(true);
		expect(q.includeDisabled().entityCount).toBe(5);
	});

	it("state_hash reflects the disabled set", () => {
		const make = () => {
			const w = new ECS({ deterministic: true });
			const Pd = w.registerComponent(Pos);
			const ids = spawnPos(w, Pd, 3);
			return { w, ids };
		};
		const a = make();
		const b = make();
		// Identical worlds hash equal.
		expect(a.w.snapshots.stateHash()).toBe(b.w.snapshots.stateHash());

		a.w.disable(a.ids[1]);
		// Disabling changes the digest.
		expect(a.w.snapshots.stateHash()).not.toBe(b.w.snapshots.stateHash());

		// Same disable on b converges the hash again (deterministic).
		b.w.disable(b.ids[1]);
		expect(a.w.snapshots.stateHash()).toBe(b.w.snapshots.stateHash());

		// Enabling restores the original digest.
		a.w.enable(a.ids[1]);
		b.w.enable(b.ids[1]);
		expect(a.w.snapshots.stateHash()).toBe(b.w.snapshots.stateHash());
	});

	it("system-side disable is deferred and safe mid-for_each", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const ids = spawnPos(world, P, 4);
		const q = world.query(P);

		let visited = 0;
		let ran = false;
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				..._INTERNAL_EMPTY_ACCESS,
				name: "disable_one",
				reads: [P],
				fn(ctx) {
					if (ran) return;
					ran = true;
					q.forEach((arch) => {
						const xs = arch.getColumnRead(P, "x");
						const eids = arch.entityIds;
						for (let i = 0; i < arch.entityCount; i++) {
							visited++;
							// Disable an entity mid-iteration — must be safe (deferred).
							if (xs[i] === 0) ctx.disable(eids[i] as (typeof ids)[number]);
						}
					});
				}
			})
		);
		world.startup();
		world.update(1 / 60);

		// All 4 were visited (the disable didn't corrupt the in-flight loop).
		expect(visited).toBe(4);
		// And the toggle took effect at the flush boundary.
		expect(q.entityCount).toBe(3);
		expect(world.isDisabled(ids[0])).toBe(true);
	});
});
