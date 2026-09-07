/**
 * What the schedule hands a compute backend, and what the store has published
 * by the time it does.
 *
 * A backend body is not a closure. It receives the frame's delta time and the
 * frame tick as call arguments, because neither is in the store bytes. It reads
 * the row count of an archetype out of the descriptor, which is a copy the
 * store refreshes. So the dispatch has to publish before it calls.
 *
 * The backend here reads the descriptors the way a module reads them, out of
 * the world's own memory, so a stale copy is visible to the test as it is to a
 * module.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../phase";
import type { BackendSystemHandle, ComputeBackend } from "../../compute_backend";
import type { SystemConfig } from "../../system";
import { unsafeCast } from "../../../../type_primitives";
import { readDescriptors } from "../fixtures/store_walk";

const MAXIMUM_PAGES = 64;

/** The enabled row count of every archetype that holds columns, as the
 * descriptor states it. This is the copy a module reads, and not the live
 * length a query walks. */
function publishedCounts(buffer: ArrayBufferLike, headerOff: number): number[] {
	return readDescriptors(new DataView(buffer), headerOff)
		.filter((d) => d.columns.length > 0)
		.map((d) => d.enabledCount);
}

interface RunRecord {
	readonly handle: number;
	readonly dt: number;
	readonly tick: number;
	readonly counts: number[];
}

class RecordingBackend implements ComputeBackend {
	public readonly runs: RunRecord[] = [];
	public readonly layouts: number[] = [];
	private _headerOff = 0;
	constructor(private readonly _memory: WebAssembly.Memory) {}
	public setLayout(headerOff: number): void {
		this._headerOff = headerOff;
		this.layouts.push(headerOff);
	}
	public run(handle: BackendSystemHandle, dt: number, tick: number): void {
		this.runs.push({
			handle: handle as number,
			dt,
			tick,
			// Read on every call, the way a module walks from the header on every
			// call. A cached address does not survive a grow.
			counts: publishedCounts(this._memory.buffer, this._headerOff)
		});
	}
}

const handle = (n: number): BackendSystemHandle => unsafeCast<BackendSystemHandle>(n);

/** A system with an empty access surface and no body, routed to the backend. */
function backendSystem(name: string, backendHandle: BackendSystemHandle): SystemConfig {
	return {
		name,
		reads: [],
		writes: [],
		spawns: [],
		despawns: [],
		transitions: [],
		resourceReads: [],
		resourceWrites: [],
		backendHandle
	};
}

function wasmWorld(): ECS {
	return new ECS({ memory: { backing: { wasm: { maximumPages: MAXIMUM_PAGES } } } });
}

describe("the schedule dispatches to a compute backend", () => {
	it("carries the handle, the frame's delta time and the frame tick", () => {
		const ecs = wasmWorld();
		const backend = new RecordingBackend(ecs.wasmMemory!);
		ecs.attachBackend(backend);
		const h = handle(7);
		ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem(backendSystem("move", h)));
		ecs.startup();

		ecs.update(0.25);
		ecs.update(0.5);

		// The tick counts `update` calls, so it moves while `dt` varies freely.
		expect(backend.runs.map((r) => [r.handle, r.dt, r.tick])).toEqual([
			[7, 0.25, 0],
			[7, 0.5, 1]
		]);
		ecs.dispose();
	});

	it("publishes the rows a host spawned before startup, before a startup system runs", () => {
		const ecs = wasmWorld();
		const Pos = ecs.registerComponent({ x: "f32", y: "f32" });
		const backend = new RecordingBackend(ecs.wasmMemory!);
		ecs.attachBackend(backend);
		// The first startup phase, which is the one with nothing before it. A
		// later phase would read what the earlier phase's flush published.
		ecs.addSystems(
			SCHEDULE.PRE_STARTUP,
			ecs.registerSystem(backendSystem("startup_move", handle(1)))
		);

		// The host fills the world between construction and startup. Nothing
		// publishes between those two points, and startup runs no tick of its own.
		ecs.spawnMany(ecs.template(Pos({ x: 1, y: 2 })), 5);
		ecs.startup();

		expect(backend.runs.length).toBe(1);
		expect(backend.runs[0].counts).toEqual([5]);
		ecs.dispose();
	});

	it("publishes the rows a run condition spawned, before the system it gates runs", () => {
		const ecs = wasmWorld();
		const Pos = ecs.registerComponent({ x: "f32", y: "f32" });
		const backend = new RecordingBackend(ecs.wasmMemory!);
		ecs.attachBackend(backend);
		const template = ecs.template(Pos({ x: 1, y: 2 }));
		ecs.spawnMany(template, 2);
		// A run condition runs outside the system's access span, so an immediate
		// spawn from one is legal, and it lands between the tick's publish and the
		// dispatch of the system it gates.
		ecs.addSystems(SCHEDULE.UPDATE, {
			system: ecs.registerSystem(backendSystem("gated_move", handle(2))),
			runIf: {
				name: "spawns_then_runs",
				evaluate: () => {
					ecs.spawnMany(template, 3);
					return true;
				}
			}
		});
		ecs.startup();

		ecs.update(1 / 60);

		expect(backend.runs.length).toBe(1);
		expect(backend.runs[0].counts).toEqual([5]);
		ecs.dispose();
	});

	it("publishes once for a clean phase and republishes after a flush", () => {
		const ecs = wasmWorld();
		const Pos = ecs.registerComponent({ x: "f32", y: "f32" });
		const backend = new RecordingBackend(ecs.wasmMemory!);
		ecs.attachBackend(backend);
		const template = ecs.template(Pos({ x: 1, y: 2 }));
		ecs.spawnMany(template, 4);
		// One system per phase. The first sees the four rows the host spawned. The
		// second sees the fifth, which the phase flush between them applied.
		ecs.addSystems(SCHEDULE.PRE_UPDATE, {
			system: ecs.registerSystem({
				...backendSystem("spawner", handle(3)),
				spawns: [[Pos]],
				backendHandle: undefined,
				fn: (ctx) => {
					ctx.commands.spawn(Pos({ x: 9, y: 9 }));
				}
			})
		});
		ecs.addSystems(SCHEDULE.PRE_UPDATE, ecs.registerSystem(backendSystem("reader_a", handle(4))));
		ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem(backendSystem("reader_b", handle(5))));
		ecs.startup();

		ecs.update(1 / 60);

		expect(backend.runs.map((r) => r.handle)).toEqual([4, 5]);
		// A deferred spawn applies at the phase flush, so the reader in the same
		// phase sees four rows and the reader in the next phase sees five.
		expect(backend.runs[0].counts).toEqual([4]);
		expect(backend.runs[1].counts).toEqual([5]);
		ecs.dispose();
	});
});
