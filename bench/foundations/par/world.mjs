/**
 * The world every parallel probe builds, and the one public seam that hands a
 * probe the store buffer.
 *
 * There is no `ecs.buffer`. The public way to the bytes is a declared region:
 * `ECSOptions.regions` puts a consumer region in the store, and
 * `ecs.regionHandle(id)` gives back `{ buffer, view, offset, bytes }` where
 * `buffer` is the whole store buffer. A worker host already declares a region
 * for its own control words, so this costs it nothing extra.
 *
 * The handle goes stale on a realloc. Re-fetch it after any grow.
 */

/** A region id the engine never interprets. One word, enough to exist. */
export const PROBE_REGION = 0x50415231;

export async function loadEcs() {
	return await import(new URL("../../../dist/index.js", import.meta.url).href);
}

/** The workers plugin, from the shipped artifact. The pool no longer sits on
 * `ECS`, so a probe that attaches one installs this. */
export async function loadWorkers() {
	return await import(new URL("../../../dist/plugins/workers.js", import.meta.url).href);
}

/** The buffer the columns live in, reached through the public region seam. */
export function storeBuffer(ecs) {
	const handle = ecs.regionHandle(PROBE_REGION);
	if (handle === null) throw new Error("probe region missing, pass regionSpec() in ECSOptions.regions");
	return handle.buffer;
}

export function regionSpec() {
	return { id: PROBE_REGION, name: "p24-probe", bytes: 64, init: () => {} };
}

/**
 * A world over three archetypes, all holding `Pos`, `Vel` and `Target`, told
 * apart by two tags. Every kernel row therefore lives in one of three
 * archetypes, so a split has to cross an archetype boundary and cannot be
 * mistaken for a split over one flat array.
 *
 * `columnCapacity` is pinned so no grow lands inside a timed run.
 * `deterministic` swaps the float columns for integers, which is the only way
 * `snapshots.stateHash()` will run.
 */
export async function buildWorld({
	entities,
	backing = "shared",
	columnCapacity,
	deterministic = false,
	allocator,
	maxBytes
} = {}) {
	const { ECS } = await loadEcs();
	const { workers } = await loadWorkers();
	const cap = columnCapacity ?? Math.ceil(entities * 0.62);
	const memory = allocator
		? { backing: { allocator }, columnCapacity: cap, ...(maxBytes ? { maxBytes } : {}) }
		: { backing, columnCapacity: cap, ...(maxBytes ? { maxBytes } : {}) };
	const ecs = ECS.create({
		memory,
		deterministic,
		regions: [regionSpec()],
		plugins: [workers()]
	});

	const num = deterministic ? "i32" : "f32";
	const Pos = ecs.registerComponent({ x: num, y: num, z: num }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: num, vy: num, vz: num }, { name: "Vel" });
	const Target = ecs.registerComponent({ tx: num, ty: num, tz: num }, { name: "Target" });
	const TagOne = ecs.registerTag();
	const TagTwo = ecs.registerTag();

	const parts = () => [
		Pos({ x: 0, y: 0, z: 0 }),
		Vel({ vx: 0, vy: 0, vz: 0 }),
		Target({ tx: 0, ty: 0, tz: 0 })
	];
	const tA = ecs.template(...parts());
	const tB = ecs.template(...parts(), TagOne);
	const tC = ecs.template(...parts(), TagOne, TagTwo);
	ecs.startup();

	const ids = new Array(entities);
	for (let i = 0; i < entities; i++) {
		const t = i % 7 === 0 ? tC : i % 3 === 0 ? tB : tA;
		ids[i] = ecs.spawn(t);
	}
	ecs.publishRowCounts();

	return { ecs, Pos, Vel, Target, TagOne, TagTwo, ids };
}

/** Fill every column from the row index, through the engine's own query path.
 * The values repeat on a short cycle, so a wrong offset shows up as a wrong sum
 * and not as a plausible one. */
export function seedWorld(ecs, Pos, Vel, Target) {
	const q = ecs.query(Pos, Vel, Target);
	let n = 0;
	q.forEachChunk((cols, count) => {
		const p = cols.mut(Pos);
		const v = cols.mut(Vel);
		const t = cols.mut(Target);
		for (let i = 0; i < count; i++, n++) {
			p.x[i] = n % 1000;
			p.y[i] = n % 977;
			p.z[i] = n % 883;
			v.vx[i] = (n % 13) - 6;
			v.vy[i] = (n % 17) - 8;
			v.vz[i] = (n % 19) - 9;
			t.tx[i] = n % 500;
			t.ty[i] = n % 400;
			t.tz[i] = n % 300;
		}
	});
	return n;
}

/** The nine `(component_id, field_id)` pairs the kernels bind, in the order
 * `par/kernels.mjs` expects. */
export function kernelSpecs(ecs, Pos, Vel, Target) {
	return [
		[Pos.id, ecs.fieldId(Pos, "x")],
		[Pos.id, ecs.fieldId(Pos, "y")],
		[Pos.id, ecs.fieldId(Pos, "z")],
		[Vel.id, ecs.fieldId(Vel, "vx")],
		[Vel.id, ecs.fieldId(Vel, "vy")],
		[Vel.id, ecs.fieldId(Vel, "vz")],
		[Target.id, ecs.fieldId(Target, "tx")],
		[Target.id, ecs.fieldId(Target, "ty")],
		[Target.id, ecs.fieldId(Target, "tz")]
	];
}
