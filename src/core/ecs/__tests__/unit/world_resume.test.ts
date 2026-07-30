/**
 * World snapshot / resume — mount a captured world onto a live, ticking ECS and
 * keep ticking identically. Where `sparse_determinism.test.ts`
 * pins the *fidelity* round-trip (snapshot → restore reproduces the same bytes),
 * these pin the *resume* capability the engine previously lacked:
 *
 *   - **mount + tick** — restore a snapshot onto a live world; it queries + ticks.
 *   - **host-state reconstruction** — `Archetype.length` / `enabledCount`, the
 *     per-row `_entityIds` back-reference, and the entity recycle free-list (in
 *     LIFO order, the load-bearing bit) are rebuilt correctly.
 *   - **resume == control** — a world snapshotted at tick N, restored, and
 *     advanced K ticks yields the SAME per-tick `stateHash` vector as the
 *     original advanced from N. On both heap and SAB.
 *   - **fail closed** — a malformed frame or a registration mismatch throws
 *     `ECSRestoreError` before mutating live state.
 */

import { describe, expect, it } from "vitest";
import { ECS, type ECSOptions } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { ComponentDef } from "../../component";
import type { SparseComponentDef } from "../../sparse_store";
import type { EntityID } from "../../entity";
import {
	frameWorldSnapshot,
	parseHostState,
	serializeHostState,
	unframeWorldSnapshot,
	WORLD_SNAPSHOT_MAGIC,
	ECSRestoreError,
	type HostState
} from "../../resume";
import { heapArraybufferAllocator } from "../../../store";

const HEAP: ECSOptions = { deterministic: true, memory: { heap: {} } };
const SAB: ECSOptions = { deterministic: true };

interface World {
	world: ECS;
	Pos: ComponentDef;
	Life: ComponentDef;
	Mark: SparseComponentDef;
}

/** A deterministic, integer-only churn world. A move/age system advances every
 * enabled (Pos, Life) entity each tick; the driver (`step`) spawns, destroys, and
 * disables entities keyed purely off the absolute step index + current data — no
 * external mutable state (RNG / resources), so it stays inside the v1 resume
 * scope. The archetype graph ({}, {Pos}, {Pos, Life}) is prewarmed so the set is
 * stable, which `restoreInto` requires. */
function build(memory: ECSOptions): World {
	const world = new ECS(memory);
	const Pos = world.registerComponent({ x: "i32" });
	const Life = world.registerComponent({ age: "i32", ttl: "i32" });
	const Mark = world.registerSparseComponent({ tag: "i32" });
	const movers = world.query(Pos, Life);
	const sys = world.registerSystem({
		exclusive: true,
		reads: [],
		writes: [],
		fn: (ctx) => {
			movers.forEach((arch) => {
				const ids = arch.entityIds;
				for (let i = 0; i < arch.entityCount; i++) {
					const p = ctx.ref(Pos, ids[i]);
					p.x += 1;
					const l = ctx.ref(Life, ids[i]);
					l.age += 1;
				}
			});
		}
	});
	world.addSystems(SCHEDULE.UPDATE, sys);
	world.startup();

	// Prewarm {Pos} then {Pos, Life} so discovery never fires mid-run.
	const warm = world.spawn();
	world.addComponent(warm, Pos, { x: 0 });
	world.flush();
	world.addComponent(warm, Life, { age: 0, ttl: 0 });
	world.flush();
	world.despawn(warm);
	world.flush();

	return { world, Pos, Life, Mark };
}

/** Apply one logical step `i` (absolute, so control + resumed apply identical
 * inputs at the same step). Returns nothing; mutates `w`. */
function step(w: World, i: number): void {
	const { world, Pos, Life, Mark } = w;
	world.update(1);

	// Reap entities whose age reached ttl. Collected in archetype-row order then
	// REVERSED before destroy, so the recycle free-list ends up in a non-monotonic
	// order — a scan-only (ascending) reconstruction would reuse different slots
	// and diverge on the first post-resume spawn that takes a sparse Mark.
	const dead: EntityID[] = [];
	world
		.query(Pos, Life)
		.includeDisabled()
		.forEachEntity((eid) => {
			if (world.getField(eid, Life, "age") >= world.getField(eid, Life, "ttl")) dead.push(eid);
		});
	dead.reverse();
	for (const eid of dead) world.despawn(eid);
	world.flush();

	// Spawn two entities, deterministically keyed by the step index. Every spawn
	// takes a sparse Mark (so its entity index enters the canonical sparse fold —
	// this is what makes free-list reuse ORDER observable in stateHash), and
	// every third is disabled (so enabledCount partitions non-trivially).
	for (let k = 0; k < 2; k++) {
		const id = i * 2 + k;
		const e = world.spawn();
		world.addComponent(e, Pos, { x: id % 97 });
		world.addComponent(e, Life, { age: 0, ttl: 1 + (id % 4) });
		world.addSparse(e, Mark, { tag: id % 53 });
		world.flush();
		if (id % 3 === 0) world.disable(e);
	}
	world.flush();
}

describe("resume framing + host-state serialization", () => {
	it("round-trips host-state (free-list order preserved)", () => {
		const hs: HostState = {
			tick: 42,
			entityHighWater: 9,
			entityAliveCount: 5,
			freeIndices: [3, 0, 7], // deliberately non-sorted (LIFO order)
			archetypeRows: [
				{ archetypeId: 0, length: 0, enabledCount: 0 },
				{ archetypeId: 2, length: 5, enabledCount: 4 }
			]
		};
		const back = parseHostState(serializeHostState(hs));
		expect(back).toEqual(hs);
	});

	it("round-trips the combined frame", () => {
		const dense = new Uint8Array([1, 2, 3]);
		const sparse = new Uint8Array([4, 5]);
		const host = new Uint8Array([6, 7, 8, 9]);
		const framed = frameWorldSnapshot(dense, sparse, host);
		const s = unframeWorldSnapshot(framed);
		expect([...s.dense]).toEqual([1, 2, 3]);
		expect([...s.sparse]).toEqual([4, 5]);
		expect([...s.host]).toEqual([6, 7, 8, 9]);
	});

	it("rejects a bare dense buffer (wrong magic)", () => {
		const bogus = new Uint8Array(40); // zeroed magic ≠ WORLD_SNAPSHOT_MAGIC
		expect(() => unframeWorldSnapshot(bogus)).toThrow(ECSRestoreError);
	});

	it("rejects a frame with trailing bytes", () => {
		const framed = frameWorldSnapshot(new Uint8Array([1]), new Uint8Array(0), new Uint8Array(0));
		const padded = new Uint8Array(framed.length + 1);
		padded.set(framed, 0); // magic copies through; the lone extra byte fails the frame-length check
		expect(() => unframeWorldSnapshot(padded)).toThrow(ECSRestoreError);
	});

	it("magic is the documented constant", () => {
		const framed = frameWorldSnapshot(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0));
		expect(new DataView(framed.buffer).getUint32(0, true)).toBe(WORLD_SNAPSHOT_MAGIC);
	});
});

describe("restoreInto — mount + reconstruction", () => {
	it("mounts a snapshot onto a fresh world; it queries + ticks afterward", () => {
		const src = build(SAB);
		for (let i = 0; i < 8; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		const dst = build(SAB);
		dst.world.snapshots.restore(snap);

		// Identical state right after the mount.
		expect(dst.world.snapshots.stateHash()).toBe(src.world.snapshots.stateHash());
		expect(dst.world.query(dst.Pos, dst.Life).entityCount).toBe(
			src.world.query(src.Pos, src.Life).entityCount
		);
		expect(dst.world.query(dst.Pos, dst.Life).includeDisabled().entityCount).toBe(
			src.world.query(src.Pos, src.Life).includeDisabled().entityCount
		);

		// And it keeps ticking in lockstep with the original.
		for (let i = 8; i < 14; i++) {
			step(src, i);
			step(dst, i);
			expect(dst.world.snapshots.stateHash()).toBe(src.world.snapshots.stateHash());
		}
	});

	it("reconstructs the entity recycle free-list in exact LIFO order", () => {
		const src = build(SAB);
		for (let i = 0; i < 8; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		const dst = build(SAB);
		dst.world.snapshots.restore(snap);

		// The next several createEntity() calls must hand out IDENTICAL ids
		// (index + generation) on both worlds — proving the free-list set AND
		// order (and the per-slot generation, which rides the SAB) round-tripped.
		for (let n = 0; n < 6; n++) {
			expect(dst.world.spawn()).toBe(src.world.spawn());
		}
	});

	it("is idempotent into a dirty world (restore replaces existing state)", () => {
		const src = build(SAB);
		for (let i = 0; i < 6; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		// dst is driven on a DIFFERENT trajectory first, then restored.
		const dst = build(SAB);
		for (let i = 0; i < 10; i++) step(dst, i + 100);
		dst.world.snapshots.restore(snap);

		expect(dst.world.snapshots.stateHash()).toBe(src.world.snapshots.stateHash());
	});
});

describe("restoreInto — fails closed", () => {
	/** The fail-closed contract is not just "it throws" — a rejected restore must
	 * leave the TARGET world byte-identical and still tickable. (Regression: the
	 * guard used to run after `restoreColumnStore` had already overwritten the live
	 * in-place backing, so a rejected restore corrupted the target — the throw
	 * passed but `stateHash` had already changed.) */
	function expectRejectedLeavesIntact(
		world: ECS,
		bad: Uint8Array,
		err?: typeof ECSRestoreError
	): void {
		const before = world.snapshots.stateHash();
		if (err === undefined) expect(() => world.snapshots.restore(bad)).toThrow();
		else expect(() => world.snapshots.restore(bad)).toThrow(err);
		// No live state was mutated…
		expect(world.snapshots.stateHash()).toBe(before);
		// …and the world keeps ticking.
		expect(() => world.update(1)).not.toThrow();
	}

	it("rejects a malformed (non-world-snapshot) buffer, target intact", () => {
		const dst = build(SAB);
		for (let i = 0; i < 3; i++) step(dst, i);
		expectRejectedLeavesIntact(dst.world, new Uint8Array(64), ECSRestoreError);
	});

	it("rejects a snapshot whose dense column layout differs, target intact", () => {
		const src = build(SAB);
		for (let i = 0; i < 4; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		// Same archetype graph shape, but Pos carries an extra field → the
		// {Pos,Life} archetype's column layout differs from the snapshot's. The
		// guard reads the snapshot's descriptors directly, so it throws BEFORE the
		// dense backing is overwritten — the target survives.
		const other = new ECS(SAB);
		const Pos2 = other.registerComponent({ x: "i32", y: "i32" });
		const Life2 = other.registerComponent({ age: "i32", ttl: "i32" });
		other.registerSparseComponent({ tag: "i32" });
		other.startup();
		const w = other.spawn();
		other.addComponent(w, Pos2, { x: 0, y: 0 });
		other.flush();
		other.addComponent(w, Life2, { age: 0, ttl: 0 });
		other.flush();

		expectRejectedLeavesIntact(other, snap, ECSRestoreError);
	});

	it("rejects a snapshot whose entity-index capacity differs, target intact", () => {
		// Identical registration + dense layout, but a larger entity budget → a
		// larger entity-index capacity. The capacity guard reads it from the
		// snapshot bytes before any mutation.
		const small: ECSOptions = { deterministic: true, memory: { budget: { entities: 2000 } } };
		const large: ECSOptions = { deterministic: true, memory: { budget: { entities: 50000 } } };
		const src = build(large);
		for (let i = 0; i < 4; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		const dst = build(small);
		for (let i = 0; i < 4; i++) step(dst, i);
		expectRejectedLeavesIntact(dst.world, snap, ECSRestoreError);
	});

	it("rejects a snapshot whose sparse registration differs, target intact", () => {
		const src = build(SAB);
		for (let i = 0; i < 4; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		// Same dense graph (so the dense guard passes), but an extra sparse store
		// → the sparse-section shape check rejects the store-count mismatch BEFORE
		// the dense mount commits (so the target's dense half isn't left clobbered).
		const other = new ECS(SAB);
		const Pos2 = other.registerComponent({ x: "i32" });
		const Life2 = other.registerComponent({ age: "i32", ttl: "i32" });
		other.registerSparseComponent({ tag: "i32" });
		other.registerSparseComponent({ extra: "i32" }); // extra store → mismatch
		other.startup();
		const w = other.spawn();
		other.addComponent(w, Pos2, { x: 0 });
		other.flush();
		other.addComponent(w, Life2, { age: 0, ttl: 0 });
		other.flush();

		expectRejectedLeavesIntact(other, snap);
	});
});

describe("resume == control: per-tick stateHash matches the original", () => {
	for (const [name, memory] of [
		["heap", HEAP],
		["SAB", SAB]
	] as const) {
		it(`holds on ${name}`, () => {
			const N = 8;
			const M = 18;

			// Control: one continuous run, recording the hash after each step.
			const control = build(memory);
			const controlHashes: number[] = [];
			for (let i = 0; i < M; i++) {
				step(control, i);
				controlHashes.push(control.world.snapshots.stateHash());
			}

			// Source: run to N, snapshot.
			const src = build(memory);
			for (let i = 0; i < N; i++) step(src, i);
			const snap = src.world.snapshots.capture();

			// Resumed: mount the tick-N snapshot onto a fresh world, advance N..M,
			// and assert each step's hash equals the control's at the same step.
			const resumed = build(memory);
			resumed.world.snapshots.restore(snap);
			for (let i = N; i < M; i++) {
				step(resumed, i);
				expect(resumed.world.snapshots.stateHash()).toBe(controlHashes[i]);
			}
		});
	}
});

describe("restoreInto — works under a custom in-place heap allocator", () => {
	it("keeps the live allocator (no DEFAULT_SAB_ALLOCATOR leak)", () => {
		const memory: ECSOptions = {
			deterministic: true,
			memory: { allocator: heapArraybufferAllocator() }
		};
		const src = build(memory);
		for (let i = 0; i < 6; i++) step(src, i);
		const snap = src.world.snapshots.capture();

		const dst = build(memory);
		dst.world.snapshots.restore(snap);
		expect(dst.world.snapshots.stateHash()).toBe(src.world.snapshots.stateHash());
		// The mounted backing is a plain ArrayBuffer, not a SharedArrayBuffer.
		expect(dst.world.columnStore.buffer).toBeInstanceOf(ArrayBuffer);
	});
});
