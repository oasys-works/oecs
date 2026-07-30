/**
 * A diagnostic for the two rows where oecs is slower. It lets the comparison give
 * the REASON, and not a ratio only.
 *
 *   1. A RANDOM READ BY ENTITY ID. Each other library here uses the entity id as the
 *      index of its component storage. Therefore "read one field of entity e" is
 *      `x[e]`, which is the same instruction as the raw baseline. oecs puts the rows
 *      together in each archetype. Therefore the same read must first resolve the
 *      entity to an archetype and a row. This probe measures the cost of each
 *      documented alternative: `getField`, `refRead`, and a walk with `eachChunk`
 *      outside the loop. Thus the difference has a cause in the layout, and it does
 *      not look like a missing optimization.
 *
 *   2. THE COST FOR EACH CHUNK. `iter_frag` puts 9,984 entities in 64 archetypes.
 *      Therefore `eachChunk` runs 64 times in each pass, with approximately 156 rows
 *      each time. This probe measures the dispatch alone, with an empty body, for 1
 *      archetype and for 64 archetypes. That cost is the difference between oecs and
 *      a library that gives the caller an array of tuples for each archetype, and
 *      that uses no callback.
 *
 *   node bench/vs/probe-oecs.mjs [bundle]
 */
const N = 10_000;
// The default is the artifact that `vs.mjs` makes. Run `vs.mjs` first, or give the
// path of a different build.
const bundle = process.argv[2] ?? "./.out/oecs.prod/index.js";
const { ECS } = await import(bundle);
let sink = 0;

function time(label, iters, fn) {
	for (let i = 0; i < 3; i++) fn();
	let best = Infinity;
	for (let s = 0; s < 7; s++) {
		const t0 = process.hrtime.bigint();
		fn();
		const dt = Number(process.hrtime.bigint() - t0) / 1e6;
		if (dt < best) best = dt;
	}
	console.log(`  ${label.padEnd(40)} ${((best * 1e6) / iters).toFixed(2).padStart(7)} ns/op`);
}

// ── 1. random access by entity id ───────────────────────────────────────────
{
	const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
	const q = ecs.query(Pos);
	console.log("random read of one field, by entity id (competitors: 0.93 ns = raw x[eid])");

	time("ecs.getField(id, Pos, 'x')", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.getField(ids[i], Pos, "x");
		sink = s;
	});

	time("ecs.refRead(Pos, id).x", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.refRead(Pos, ids[i]).x;
		sink = s;
	});

	// Two fields per entity: the shape `refRead` is documented for, since its
	// archetype+row lookup happens once at creation and each field is then a
	// single typed-array index.
	time("ecs.refRead → 2 fields (per field)", 2 * 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const p = ecs.refRead(Pos, ids[i]);
				s += p.x + p.y;
			}
		sink = s;
	});

	time("eachChunk column walk (not by id)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++) {
			q.eachChunk((cols, count) => {
				const { x } = cols.read(Pos);
				for (let i = 0; i < count; i++) s += x[i];
			});
		}
		sink = s;
	});
}

// ── 2. per-chunk dispatch cost ──────────────────────────────────────────────
{
	const mk = (archetypes) => {
		const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const bits = Math.log2(archetypes);
		const tags = [];
		for (let i = 0; i < bits; i++) tags.push(ecs.registerTag());
		const per = Math.floor(N / archetypes);
		for (let mask = 0; mask < archetypes; mask++) {
			const items = [Pos({ x: 0, y: 0 })];
			for (let b = 0; b < bits; b++) if (mask & (1 << b)) items.push(tags[b]);
			ecs.spawnMany(ecs.template(...items), per);
		}
		return { ecs, Pos, q: ecs.query(Pos), rows: per * archetypes };
	};

	console.log("\neachChunk dispatch, EMPTY body (pure per-chunk overhead)");
	for (const n of [1, 8, 64]) {
		const { q, rows } = mk(n);
		time(`${String(n).padStart(2)} archetypes (${Math.floor(rows / n)} rows each)`, 300 * rows, () => {
			for (let r = 0; r < 300; r++) q.eachChunk((_c, count) => (sink = count));
		});
	}

	console.log("\neachChunk with x[i] += 2 body");
	for (const n of [1, 8, 64]) {
		const { q, Pos, rows } = mk(n);
		time(`${String(n).padStart(2)} archetypes (${Math.floor(rows / n)} rows each)`, 300 * rows, () => {
			for (let r = 0; r < 300; r++) {
				q.eachChunk((cols, count) => {
					const { x } = cols.mut(Pos);
					for (let i = 0; i < count; i++) x[i] += 2;
				});
			}
		});
	}
}
