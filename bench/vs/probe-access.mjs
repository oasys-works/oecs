/**
 * The true division of the time in `read_by_id` and in `has`.
 *
 * The comparison shows that oecs uses 21.7 ns for a read of a field by id, and that
 * the other libraries use 0.93 ns. It also shows 8.65 ns for a test of membership in
 * oecs, against 6.96 ns in bitECS. Neither value gives the REASON. The statement
 * "dense rows cost one lookup" is only a part of the reason. This probe divides both
 * operations into stages through the public API. It then measures the two possible
 * causes separately.
 *
 *   node bench/vs/probe-access.mjs [bundle]
 */
const bundle = process.argv[2] ?? "./.out/oecs.v054.mjs";
const { ECS } = await import(bundle);
const N = 10_000;
let sink = 0;

function time(label, iters, fn) {
	for (let i = 0; i < 5; i++) fn();
	let best = Infinity;
	for (let s = 0; s < 9; s++) {
		const t0 = process.hrtime.bigint();
		fn();
		const dt = Number(process.hrtime.bigint() - t0) / 1e6;
		if (dt < best) best = dt;
	}
	const ns = (best * 1e6) / iters;
	console.log(`  ${label.padEnd(46)} ${ns.toFixed(2).padStart(7)} ns/op`);
	return ns;
}

// ── the oecs ladder ─────────────────────────────────────────────────────────
const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
const P3 = ecs.registerComponent({ x: "f64", y: "f64", z: "f64" }, { name: "P3" });
const ids = ecs.spawnMany(ecs.template(P3({ x: 1, y: 2, z: 3 })), N);

console.log("oecs by-id access ladder (each row adds one stage)");
const tAlive = time("ecs.isAlive(id)", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.isAlive(ids[i]) ? 1 : 0;
	sink = s;
});
const tHas = time("ecs.hasComponent(id, P3)  [+ arch resolve + mask]", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.hasComponent(ids[i], P3) ? 1 : 0;
	sink = s;
});
const tGet = time("ecs.getField(id, P3, 'x')  [+ field resolve + read]", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.getField(ids[i], P3, "x");
	sink = s;
});

console.log("\nsame resolution, amortised over more fields per entity");
const tRef1 = time("refRead → 1 field", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.refRead(P3, ids[i]).x;
	sink = s;
});
const tRef3 = time("refRead → 3 fields (per entity)", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++)
		for (let i = 0; i < N; i++) {
			const p = ecs.refRead(P3, ids[i]);
			s += p.x + p.y + p.z;
		}
	sink = s;
});
const tGet3 = time("getField × 3 fields (per entity)", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++)
		for (let i = 0; i < N; i++) {
			const e = ids[i];
			s += ecs.getField(e, P3, "x") + ecs.getField(e, P3, "y") + ecs.getField(e, P3, "z");
		}
	sink = s;
});

console.log(`
  derived:
    entity liveness check            ${tAlive.toFixed(2)} ns
    + archetype resolve + mask test  ${(tHas - tAlive).toFixed(2)} ns   (= hasComponent - isAlive)
    + field resolve + column read    ${(tGet - tHas).toFixed(2)} ns   (= getField - hasComponent)
    one ref, then each extra field   ${((tRef3 - tRef1) / 2).toFixed(2)} ns   (= (ref3 - ref1) / 2)
    3 fields: ref reuse vs 3 getField ${tRef3.toFixed(2)} vs ${tGet3.toFixed(2)} ns`);

// ── suspect 1: the string-keyed field index ─────────────────────────────────
// `readField` ends in `this._fieldIndex[cid][field]` — a STRING-keyed load on an
// object whose shape differs per component, i.e. a megamorphic keyed access on
// every single read. A numeric field handle would make it an array index. This
// prices the difference on the same data.
console.log("\nsuspect 1 — string-keyed field index vs numeric index (synthetic)");
{
	const COMPS = 24;
	const byName = [];
	const byIdx = [];
	for (let c = 0; c < COMPS; c++) {
		// A distinct object SHAPE per component, which is what an object literal
		// built from each schema's own field names produces.
		const o = {};
		for (let f = 0; f < 3; f++) o[`f${c}_${f}`] = f;
		byName.push(o);
		byIdx.push(new Int32Array([0, 1, 2]));
	}
	const names = byName.map((o) => Object.keys(o));
	const cids = new Int32Array(N);
	for (let i = 0; i < N; i++) cids[i] = i % COMPS;

	time("string key:  fieldIndex[cid][name]", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				s += byName[c][names[c][0]];
			}
		sink = s;
	});
	time("numeric key: fieldIndex[cid][0]", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) s += byIdx[cids[i]][0];
		sink = s;
	});
	// The monomorphic case, for reference: one shape only, so the inline cache hits.
	const one = byName[0];
	const k = names[0][0];
	time("string key, single shape (IC hit)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += one[k];
		sink = s;
	});
}

// ── suspect 2: what bitECS's membership test actually costs ─────────────────
// bitECS: world[$internal] → componentMap.get(component) → 2 property loads →
// entityMasks[gen][eid] & bitflag. Notably NO liveness check: a recycled id reads
// whatever mask now sits at that slot. This prices that exact shape, so the 6.96
// vs 8.65 gap can be attributed rather than guessed at.
console.log("\nsuspect 2 — bitECS's has() shape vs oecs's (synthetic)");
{
	const comp = {};
	const componentMap = new Map([[comp, { generationId: 0, bitflag: 1 }]]);
	const entityMasks = [new Int32Array(N + 2).fill(1)];
	const world = { m: componentMap, e: entityMasks };
	time("Map.get + entityMasks[g][eid] & flag", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const rec = world.m.get(comp);
				s += (world.e[rec.generationId][ids[i] & 0xfffff] & rec.bitflag) === rec.bitflag ? 1 : 0;
			}
		sink = s;
	});
	const gens = new Int32Array(N + 2);
	time("generational liveness check alone", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const id = ids[i];
				const idx = id & 0xfffff;
				s += idx < N && gens[idx] === (id >>> 20) ? 1 : 0;
			}
		sink = s;
	});
}
