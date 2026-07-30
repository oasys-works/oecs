/**
 * A diagnostic for the `iter2` case. In the time of each library, how much is the
 * ACQUISITION OF THE QUERY for each frame, and how much is the loop?
 *
 * This division is necessary for an equal comparison. A real frame loop acquires its
 * query again at each tick. Therefore `iter2` calls the query inside the repetition
 * loop for each library. But the acquisition of a query in one library can make a
 * dense array again at each call. For that library, `iter2` then reports "the loop
 * and the construction of the array". For the other libraries, it reports "the loop
 * and a hit in the cache". This probe moves the acquisition out of the loop, and it
 * thus separates the two costs. Then the comparison can give the correct cause, and
 * it does not hide the cause in one value.
 *
 *   node bench/vs/probe-query.mjs
 */
const N = 10_000;
const DT = 0.016;
const REPS = 100;
let sink = 0;

function time(label, fn) {
	for (let i = 0; i < 3; i++) fn();
	let best = Infinity;
	for (let s = 0; s < 7; s++) {
		const t0 = process.hrtime.bigint();
		fn();
		const dt = Number(process.hrtime.bigint() - t0) / 1e6;
		if (dt < best) best = dt;
	}
	console.log(`  ${label.padEnd(34)} ${best.toFixed(3).padStart(8)} ms   ${((best * 1e6) / (REPS * N)).toFixed(2).padStart(6)} ns/op`);
	return best;
}

// ── bitECS ──────────────────────────────────────────────────────────────────
{
	const { createWorld, addEntity, addComponent, query } = await import("bitecs");
	const world = createWorld();
	const Pos = { x: new Float64Array(N + 1), y: new Float64Array(N + 1) };
	const Vel = { vx: new Float64Array(N + 1), vy: new Float64Array(N + 1) };
	for (let i = 0; i < N; i++) {
		const e = addEntity(world);
		addComponent(world, e, Pos);
		addComponent(world, e, Vel);
		Vel.vx[e] = 1;
		Vel.vy[e] = 1;
	}
	console.log("bitecs");
	const inner = (ents) => {
		const { x, y } = Pos;
		const { vx, vy } = Vel;
		for (let i = 0; i < ents.length; i++) {
			const e = ents[i];
			x[e] += vx[e] * DT;
			y[e] += vy[e] * DT;
		}
	};
	time("query() inside rep loop", () => {
		for (let r = 0; r < REPS; r++) inner(query(world, [Pos, Vel]));
	});
	const hoisted = query(world, [Pos, Vel]);
	time("query() hoisted out", () => {
		for (let r = 0; r < REPS; r++) inner(hoisted);
	});
	time("query() alone, no loop body", () => {
		for (let r = 0; r < REPS; r++) sink = query(world, [Pos, Vel]).length;
	});
}

// ── harmony-ecs ─────────────────────────────────────────────────────────────
{
	const { World, Schema, Entity, Query, Format } = await import("harmony-ecs");
	const V2 = { x: Format.float64, y: Format.float64 };
	const world = World.make(N * 8);
	const Pos = Schema.makeBinary(world, V2);
	const Vel = Schema.makeBinary(world, V2);
	const Kinetic = [Pos, Vel];
	for (let i = 0; i < N; i++) Entity.make(world, Kinetic, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
	const q = Query.make(world, Kinetic);
	console.log("harmony");
	time("for..of query (documented form)", () => {
		for (let r = 0; r < REPS; r++) {
			for (const [entities, [p, v]] of q) {
				for (let i = 0; i < entities.length; i++) {
					p.x[i] += v.x[i] * DT;
					p.y[i] += v.y[i] * DT;
				}
			}
		}
	});
	time("indexed over q[] (no iterator)", () => {
		for (let r = 0; r < REPS; r++) {
			for (let a = 0; a < q.length; a++) {
				const [entities, [p, v]] = q[a];
				for (let i = 0; i < entities.length; i++) {
					p.x[i] += v.x[i] * DT;
					p.y[i] += v.y[i] * DT;
				}
			}
		}
	});
}

// ── oecs ────────────────────────────────────────────────────────────────────
{
	// The default is the artifact that `vs.mjs` makes. Run `vs.mjs` first, or give
	// the path of a different build.
	const { ECS } = await import(process.argv[2] ?? "./.out/oecs.prod/index.js");
	const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
	ecs.spawnMany(ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 1 })), N);
	const q = ecs.query(Pos, Vel);
	console.log("oecs");
	time("eachChunk per rep", () => {
		for (let r = 0; r < REPS; r++) {
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
	time("eachChunk alone, empty body", () => {
		for (let r = 0; r < REPS; r++) q.eachChunk((_c, count) => (sink = count));
	});
}
