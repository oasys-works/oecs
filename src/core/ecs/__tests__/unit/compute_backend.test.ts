/**
 * ComputeBackend seam (#622) — the pure-TS fixture proof.
 *
 * Per ADR-0018 the pluggable opt-in backend seam is validated end-to-end by a
 * fixture that attaches *no* game backend: a bare `ECS` runs pure-TS systems
 * (default = none), and a tiny fake `ComputeBackend` proves attach + route +
 * layout republish with **zero game vocabulary** crossing the engine boundary.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { ComputeBackend, BackendSystemHandle } from "../../compute_backend";
import type { SystemConfig, SystemFn } from "../../system";
import { unsafeCast } from "../../../../type_primitives";

/** Records every engine→backend call; mints opaque handles as plain indices. */
class FakeBackend implements ComputeBackend {
	readonly layoutCalls: number[] = [];
	readonly runCalls: BackendSystemHandle[] = [];
	setLayout(headerOff: number): void {
		this.layoutCalls.push(headerOff);
	}
	run(handle: BackendSystemHandle): void {
		this.runCalls.push(handle);
	}
}

const handle = (n: number): BackendSystemHandle => unsafeCast<BackendSystemHandle>(n);

/** A full SystemConfig with empty access (so the config-form `backendHandle`
 * field is reachable — the bare/2-arg overloads can't carry it). */
function config(fn: SystemFn, backendHandle?: BackendSystemHandle): SystemConfig {
	return {
		reads: [],
		writes: [],
		spawns: [],
		despawns: [],
		transitions: [],
		resourceReads: [],
		resourceWrites: [],
		fn,
		backendHandle
	};
}

describe("ComputeBackend seam (#622)", () => {
	it("default = none: a bare ECS runs pure-TS systems", () => {
		const ecs = new ECS();
		let ran = 0;
		ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem(config(() => ran++)));
		ecs.startup();
		ecs.update(1 / 50);
		expect(ran).toBe(1);
	});

	it("attach seeds the layout immediately (set_layout(0))", () => {
		const ecs = new ECS();
		const backend = new FakeBackend();
		ecs.attachBackend(backend);
		expect(backend.layoutCalls).toEqual([0]);
		expect(backend.runCalls).toEqual([]);
	});

	it("a system with a backend_handle routes to backend.run instead of fn", () => {
		const ecs = new ECS();
		const backend = new FakeBackend();
		ecs.attachBackend(backend);

		let fnRan = 0;
		const h = handle(7);
		ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem(config(() => fnRan++, h)));
		ecs.startup();
		ecs.update(1 / 50);

		expect(backend.runCalls).toEqual([h]); // routed
		expect(fnRan).toBe(0); // fn body NOT run
	});

	it("falls back to fn when a handle is set but no backend is attached", () => {
		const ecs = new ECS();
		let fnRan = 0;
		ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem(config(() => fnRan++, handle(3))));
		ecs.startup();
		ecs.update(1 / 50);
		expect(fnRan).toBe(1); // TS fallback ran
	});

	it("runs non-routed systems' fn even while a backend is attached", () => {
		const ecs = new ECS();
		const backend = new FakeBackend();
		ecs.attachBackend(backend);

		let plainRan = 0;
		ecs.addSystems(
			SCHEDULE.UPDATE,
			ecs.registerSystem(config(() => plainRan++)), // no handle → fn
			ecs.registerSystem(config(() => {}, handle(1))) // handle → backend
		);
		ecs.startup();
		ecs.update(1 / 50);

		expect(plainRan).toBe(1);
		expect(backend.runCalls).toEqual([handle(1)]);
	});

	it("republishes the layout to the backend after a SAB grow", () => {
		const ecs = new ECS({ memory: { columnCapacity: 4 } });
		const backend = new FakeBackend();
		ecs.attachBackend(backend);
		const seeded = backend.layoutCalls.length; // ≥1 (seed)

		// Insert well past the initial capacity to force grow(s).
		const C = ecs.registerComponent({ x: "f64" });
		for (let i = 0; i < 32; i++) {
			const e = ecs.createEntity();
			ecs.addComponent(e, C, { x: i });
		}

		expect(backend.layoutCalls.length).toBeGreaterThan(seeded);
	});

	it("detach reverts routing to fn and stops layout republish", () => {
		const ecs = new ECS({ memory: { columnCapacity: 4 } });
		const backend = new FakeBackend();
		const detach = ecs.attachBackend(backend);

		let fnRan = 0;
		ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem(config(() => fnRan++, handle(9))));
		ecs.startup();

		detach();
		const layoutAfterDetach = backend.layoutCalls.length;

		ecs.update(1 / 50);
		expect(fnRan).toBe(1); // back to the TS body
		expect(backend.runCalls).toEqual([]); // never routed

		// A grow after detach no longer reaches the backend.
		const C = ecs.registerComponent({ x: "f64" });
		for (let i = 0; i < 32; i++) {
			const e = ecs.createEntity();
			ecs.addComponent(e, C, { x: i });
		}
		expect(backend.layoutCalls.length).toBe(layoutAfterDetach);
	});

	it("rejects a second backend (one per ECS) in dev", () => {
		const ecs = new ECS();
		ecs.attachBackend(new FakeBackend());
		expect(() => ecs.attachBackend(new FakeBackend())).toThrow();
	});

	it("attach after detach is allowed", () => {
		const ecs = new ECS();
		const detach = ecs.attachBackend(new FakeBackend());
		detach();
		expect(() => ecs.attachBackend(new FakeBackend())).not.toThrow();
	});
});
