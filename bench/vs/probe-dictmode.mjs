/**
 * The number of shapes does not make `_fieldIndex[cid][field]` slow. What makes it
 * slow?
 *
 * `probe-fieldshape.mjs` shows that 24 different `_fieldIndex` shapes cost the same
 * as one shape. Therefore megamorphism is not the cause. The other possible cause is
 * the method that MAKES the object. `store.ts` makes it with `Object.create(null)`,
 * and that is a correct choice, because no key of `Object.prototype` can then collide
 * with a field that has the name `constructor`. But an object with a null prototype
 * goes to **dictionary mode** when the code assigns keys to it. In dictionary mode,
 * each load with a key is a lookup in a hash table, and no inline cache is possible.
 * This condition explains a cost that does not change with the number of shapes, and
 * that is still approximately 6 ns.
 *
 * This probe measures the four possible tables with 1 shape and with 24 shapes.
 * Therefore one measurement selects the replacement for both conditions.
 *
 *   node bench/vs/probe-dictmode.mjs
 */
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
	console.log(`  ${label.padEnd(50)} ${ns.toFixed(2).padStart(7)} ns/op`);
	return ns;
}

function run(shapes) {
	const COMPS = 24; // always 24 tables; `shapes` controls how many hidden classes
	console.log(`\n${COMPS} tables, ${shapes} distinct field-name set${shapes > 1 ? "s" : ""}`);

	const nullProto = [];
	const literal = [];
	const map = [];
	const names = [];
	for (let c = 0; c < COMPS; c++) {
		const sfx = shapes === 1 ? "" : String(c % shapes);
		const keys = [`x${sfx}`, `y${sfx}`, `z${sfx}`];
		// What store.ts builds today.
		const np = Object.create(null);
		for (let f = 0; f < 3; f++) np[keys[f]] = f;
		// Same content, ordinary object literal — fast properties, real IC.
		const lit = { [keys[0]]: 0, [keys[1]]: 1, [keys[2]]: 2 };
		const m = new Map();
		for (let f = 0; f < 3; f++) m.set(keys[f], f);
		nullProto.push(np);
		literal.push(lit);
		map.push(m);
		names.push(keys);
	}
	const asked = names.map((k) => k[2]);
	const cids = new Int32Array(N);
	for (let i = 0; i < N; i++) cids[i] = i % COMPS;

	const sweep = (label, table, read) =>
		time(label, 20 * N, () => {
			let s = 0;
			for (let r = 0; r < 20; r++)
				for (let i = 0; i < N; i++) {
					const c = cids[i];
					s += read(table[c], asked[c]);
				}
			sink = s;
		});

	const np = sweep("Object.create(null) + assign   (today)", nullProto, (t, k) => t[k]);
	const lit = sweep("object literal  { x: 0, … }", literal, (t, k) => t[k]);
	const m = sweep("Map.get", map, (t, k) => t.get(k));
	return { np, lit, m };
}

console.log("field-name → ordinal: what the table's construction costs");
const one = run(1);
const many = run(24);

console.log(`
  summary (ns per lookup)
                                 1 shape   24 shapes
    Object.create(null)  today   ${one.np.toFixed(2).padStart(7)}   ${many.np.toFixed(2).padStart(9)}
    object literal               ${one.lit.toFixed(2).padStart(7)}   ${many.lit.toFixed(2).padStart(9)}
    Map                          ${one.m.toFixed(2).padStart(7)}   ${many.m.toFixed(2).padStart(9)}

  A table that is flat across the two columns is insensitive to how many
  components an app registers; one that is not pays more as the app grows.`);
if (sink === Number.MIN_SAFE_INTEGER) console.log("unreachable");
