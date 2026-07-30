/**
 * Is the load of `_fieldIndex[cid][field]` truly megamorphic in the real code?
 *
 * §3a of INVESTIGATION.md gives approximately 7 ns of the 12.2 ns field stage of
 * `getField` to a megamorphic load with a string key. It uses a synthetic test with
 * **24 different object shapes** as the evidence. But `probe-access.mjs`, which
 * measures the stages, registers **one** component only. Therefore the real call site
 * has one shape, and its inline cache finds that shape. The synthetic test with 24
 * shapes and the measurement with 1 shape are not the same workload. The complete
 * estimate of −7 ns depends on the difference between them.
 *
 * This measurement needs care. If you only increase the number of components, you
 * also change the number of entities for each component, and therefore the locality
 * of the cache. A first attempt showed that K=24 was *faster* than K=1 for that
 * reason. Therefore this probe changes the number of shapes, and it keeps EACH other
 * variable constant. To do this, it uses the method that makes the `_fieldIndex`
 * objects: `Object.create(null)`, and then the keys in the sequence of the schema.
 * Therefore two components whose schemas have the same field names in the same
 * sequence share one hidden class. The probe makes two worlds. They have an equal
 * number of components, an equal number of entities, an equal number of fields, an
 * equal number of archetypes, and an equal sequence of the reads. The only difference
 * is whether the 24 schemas use the same field names:
 *
 *   THE SAME names    ⇒ 24 components, 1 `_fieldIndex` shape  ⇒ the IC finds the shape
 *   DIFFERENT names   ⇒ 24 components, 24 shapes              ⇒ the IC is megamorphic
 *
 * The difference between the two worlds is the megamorphic cost in the real code. No
 * other variable can be the cause.
 *
 *   node bench/vs/probe-fieldshape.mjs [bundle]
 */
// The default is the artifact that `vs.mjs` makes. Run `vs.mjs` first, or give the
// path of a different build.
const bundle = process.argv[2] ?? "./.out/oecs.prod/index.js";
const { ECS } = await import(bundle);
const K = 24; // components
const PER = 2_000; // entities per component
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

/** `unique = false` ⇒ every schema is `{x,y,z}` (one shared hidden class). */
function world(unique) {
	const ecs = new ECS({ memory: { columnCapacity: Math.round(PER * 1.4) + 64 } });
	const defs = [];
	const fields = [];
	const ids = [];
	for (let c = 0; c < K; c++) {
		const sfx = unique ? String(c) : "";
		const schema = { [`x${sfx}`]: "f64", [`y${sfx}`]: "f64", [`z${sfx}`]: "f64" };
		const def = ecs.registerComponent(schema, { name: `C${c}` });
		defs.push(def);
		fields.push(`x${sfx}`);
		const init = {};
		init[`x${sfx}`] = 1;
		init[`y${sfx}`] = 2;
		init[`z${sfx}`] = 3;
		ids.push(ecs.spawnMany(ecs.template(def(init)), PER));
	}
	return { ecs, defs, fields, ids };
}

const TOTAL = K * PER;
console.log(`${K} components × ${PER} entities, read through ONE getField call site`);
console.log(`only difference between the two rows: whether the 24 schemas share field names\n`);

const results = {};
for (const unique of [false, true]) {
	const { ecs, defs, fields, ids } = world(unique);
	const label = unique ? "UNIQUE names — 24 _fieldIndex shapes" : "SAME names   —  1 _fieldIndex shape";
	results[unique] = time(label, 20 * TOTAL, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let c = 0; c < K; c++) {
				const def = defs[c];
				const f = fields[c];
				const list = ids[c];
				for (let i = 0; i < PER; i++) s += ecs.getField(list[i], def, f);
			}
		sink = s;
	});
}
console.log(`
  megamorphic cost of the string-keyed field index, on real code:
    ${(results[true] - results[false]).toFixed(2)} ns  (INVESTIGATION.md fix 1 projects −7.00)`);

// Same two worlds through `refRead`, which resolves the field once at creation.
// If the string-keyed load were the dominant cost, refRead should be flat here.
console.log(`\nsame two worlds through refRead (field resolved once, not per read)`);
for (const unique of [false, true]) {
	const { ecs, defs, fields, ids } = world(unique);
	time(unique ? "UNIQUE names, refRead" : "SAME names,   refRead", 20 * TOTAL, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let c = 0; c < K; c++) {
				const def = defs[c];
				const f = fields[c];
				const list = ids[c];
				for (let i = 0; i < PER; i++) s += ecs.refRead(def, list[i])[f];
			}
		sink = s;
	});
}
if (sink === Number.MIN_SAFE_INTEGER) console.log("unreachable");
