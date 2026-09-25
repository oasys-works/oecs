/**
 * The world every parallel test builds, and where the worker entry lives.
 *
 * Four archetypes hold `Pos` and `Vel`. Two tags tell three of them apart, and
 * a fourth carries `Frozen`, which the query excludes. So a split has to cross
 * an archetype boundary, and an excluded archetype has to stay untouched.
 *
 * The worker entry is loaded from the source, not from `dist`. That is what the
 * `.ts` extensions in its import chain buy: plain node resolves a relative
 * specifier by its extension, and it strips the types itself. The alternative
 * was a build inside the suite, which several test files would race.
 */

import { ECS } from "../../../core/ecs/ecs";
import type { ComponentDef } from "../../../core/ecs/component";
import type { EntityID } from "../../../core/ecs/entity";
import type { ECSMemoryOptions } from "../../../core/ecs/ecs_memory";
import type { Template } from "../../../core/ecs/store";
import { snapshots } from "../../snapshots";
import { workers, type WorkersPlugin } from "../../workers";

/** The engine's worker entry, as the tests reach it. */
export const WORKER_URL = new URL("../../../core/ecs/../../worker.ts", import.meta.url);

/** The kernel module a `js` kernel names. */
export const KERNELS_URL = new URL("./parallel_kernels.mjs", import.meta.url).href;

export type Backing = "shared" | "wasm";

/** The column schemas, one tag for the deterministic lane and one for the
 * float lane. `stateHash` refuses a float column, so the two lanes carry
 * different oracles and the same body. */
type Tag = "i32" | "f32";

export interface ParallelWorld<T extends Tag = Tag> {
	ecs: ECS & { snapshots: { stateHash(): number } } & WorkersPlugin;
	Pos: ComponentDef<{ x: T; y: T }>;
	Vel: ComponentDef<{ vx: T; vy: T }>;
	Frozen: ComponentDef<Record<string, never>>;
	ids: EntityID[];
}

interface WorldOptions {
	entities: number;
	backing: Backing;
	deterministic?: boolean;
	columnCapacity?: number;
	/** Where the store header sits. A compiled kernel module owns the low
	 * addresses, so a world that runs one puts the store above them. */
	storeBase?: number;
}

/** The maximum every checked-in kernel module declares. A world that runs one
 * must declare the same, or the instantiation inside the worker fails. */
export const KERNEL_MAX_PAGES = 512;

function memoryFor(
	backing: Backing,
	columnCapacity?: number,
	storeBase?: number
): ECSMemoryOptions {
	if (backing === "wasm") {
		return { backing: { wasm: { maximumPages: KERNEL_MAX_PAGES } }, columnCapacity, storeBase };
	}
	return { backing: "shared", columnCapacity, maxBytes: 64 * 1024 * 1024 };
}

/** One world over four archetypes, seeded from the row index so a wrong offset
 * shows up as a wrong value and not as a plausible one. */
export function buildWorld(options: WorldOptions & { deterministic: false }): ParallelWorld<"f32">;
export function buildWorld(options: WorldOptions): ParallelWorld<"i32">;
export function buildWorld(options: WorldOptions): ParallelWorld {
	const deterministic = options.deterministic ?? true;
	const tag: Tag = deterministic ? "i32" : "f32";
	const ecs = ECS.create({
		deterministic,
		memory: memoryFor(options.backing, options.columnCapacity, options.storeBase),
		plugins: [snapshots(), workers()]
	});
	const Pos = ecs.registerComponent({ x: tag, y: tag }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: tag, vy: tag }, { name: "Vel" });
	const TagOne = ecs.registerTag();
	const TagTwo = ecs.registerTag();
	const Frozen = ecs.registerTag();

	const base = () => [Pos({ x: 0, y: 0 }), Vel({ vx: 0, vy: 0 })] as const;
	const templates: Template<any>[] = [
		ecs.template(...base()),
		ecs.template(...base(), TagOne),
		ecs.template(...base(), TagOne, TagTwo),
		ecs.template(...base(), Frozen)
	];
	ecs.startup();

	const ids: EntityID[] = new Array(options.entities);
	for (let i = 0; i < options.entities; i++) {
		ids[i] = ecs.spawn(templates[i % 4]);
	}
	seed(ecs, Pos, Vel);
	ecs.publishRowCounts();
	return { ecs: ecs as ParallelWorld["ecs"], Pos, Vel, Frozen, ids };
}

/** Fill every column through the engine's own query path. The values repeat on
 * a short cycle, so a wrong row shows up as a wrong value. */
export function seed(ecs: ECS, Pos: ComponentDef<any>, Vel: ComponentDef<any>): void {
	const q = ecs.query(Pos, Vel);
	let n = 0;
	q.forEachColumns((cols, count) => {
		const p = cols.mut(Pos);
		const v = cols.mut(Vel);
		for (let i = 0; i < count; i++, n++) {
			p.x[i] = n % 1000;
			p.y[i] = n % 977;
			v.vx[i] = (n % 13) - 6;
			v.vy[i] = (n % 17) - 8;
		}
	});
}

/** Every live `Pos` and `Vel` value, archetype by archetype, as one flat list.
 * The compare on a float world, where `stateHash` refuses to run. */
export function readColumns(ecs: ECS, Pos: ComponentDef<any>, Vel: ComponentDef<any>): number[] {
	const out: number[] = [];
	const q = ecs.query(Pos, Vel);
	q.forEachColumns((cols, count) => {
		const p = cols.read(Pos);
		const v = cols.read(Vel);
		for (let i = 0; i < count; i++) {
			out.push(p.x[i], p.y[i], v.vx[i], v.vy[i]);
		}
	});
	return out;
}
