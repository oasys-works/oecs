/**
 * Which method for a name to an ordinal must replace `_fieldIndex[cid][field]`?
 *
 * Fix 1 in INVESTIGATION.md says: "keep `_fieldIndex` as a flat `Int32Array` with the
 * key `cid * stride + ordinal`". That method gives 1.43 ns for the load of the
 * *ordinal*. But the public API receives the NAME of a field. Therefore a flat
 * `Int32Array` does not remove the step with the string. It only moves that step.
 * This probe measures the step itself, and it uses the same shape of data that the
 * real `_fieldIndex` has: one object shape for each component, and therefore a
 * megamorphic load with a key. Thus a measurement selects the replacement. The limit
 * of 1.43 ns does not select it, because no API with a string key can reach that
 * limit.
 *
 *   node bench/vs/probe-fieldname.mjs
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
	console.log(`  ${label.padEnd(52)} ${ns.toFixed(2).padStart(7)} ns/op`);
	return ns;
}

/**
 * `WIDTH` fields per component, `COMPS` distinct component shapes. Field names
 * are per-component (`f0_x`, `f1_x`, …) so no two components share an object
 * shape — the property that makes the current keyed load megamorphic.
 */
function bench(COMPS, WIDTH) {
	console.log(`\n${COMPS} component shapes × ${WIDTH} fields — read field ordinal ${WIDTH - 1} (worst case for a scan)`);

	const rec = []; // Record<string, number>  — what we do today
	const map = []; // Map<string, number>     — every Map shares one hidden class
	const names = []; // string[]              — already stored as `_fieldNames`
	const flat = new Int32Array(COMPS * WIDTH); // the fix-1 shape, ordinal already known
	for (let c = 0; c < COMPS; c++) {
		const o = Object.create(null);
		const m = new Map();
		const ns = [];
		for (let f = 0; f < WIDTH; f++) {
			const key = `f${c}_${f}`;
			o[key] = f;
			m.set(key, f);
			ns.push(key);
			flat[c * WIDTH + f] = f;
		}
		rec.push(o);
		map.push(m);
		names.push(ns);
	}

	// The call-site strings. A real call site passes a literal, so these are the
	// same interned strings the tables were built with — pointer-comparable.
	const asked = names.map((ns) => ns[WIDTH - 1]);
	const cids = new Int32Array(N);
	for (let i = 0; i < N; i++) cids[i] = i % COMPS;

	const base = time("Record<string,number>[cid][name]   (today)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				s += rec[c][asked[c]];
			}
		sink = s;
	});
	const mapNs = time("Map<string,number>[cid].get(name)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				s += map[c].get(asked[c]);
			}
		sink = s;
	});
	const scanNs = time("identity scan over string[]", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				const ns = names[c];
				const want = asked[c];
				let fi = -1;
				for (let j = 0; j < ns.length; j++)
					if (ns[j] === want) {
						fi = j;
						break;
					}
				s += fi;
			}
		sink = s;
	});
	const flatNs = time("flat Int32Array[cid*W + ordinal]  (ceiling)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) s += flat[cids[i] * WIDTH + (WIDTH - 1)];
		sink = s;
	});
	return { base, mapNs, scanNs, flatNs };
}

console.log("name → ordinal, priced at the shape the real _fieldIndex has");
for (const [comps, width] of [
	[24, 3],
	[24, 1],
	[24, 8],
	[4, 3]
])
	bench(comps, width);

// A non-interned key: `getField(e, def, someComputedName)`. Pointer equality
// fails, so the scan degrades to a content compare and Map.get must hash the
// string from scratch. The realistic worst case for both replacements.
console.log("\nnon-interned key (computed at the call site, 24 shapes × 3 fields)");
{
	const COMPS = 24;
	const rec = [];
	const map = [];
	const names = [];
	for (let c = 0; c < COMPS; c++) {
		const o = Object.create(null);
		const m = new Map();
		const ns = [];
		for (let f = 0; f < 3; f++) {
			const key = `f${c}_${f}`;
			o[key] = f;
			m.set(key, f);
			ns.push(key);
		}
		rec.push(o);
		map.push(m);
		names.push(ns);
	}
	// Fresh string objects with the same contents — no pointer identity.
	const asked = names.map((ns) => ns[2].split("").join(""));
	const cids = new Int32Array(N);
	for (let i = 0; i < N; i++) cids[i] = i % COMPS;

	time("Record[cid][name]", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				s += rec[c][asked[c]];
			}
		sink = s;
	});
	time("Map[cid].get(name)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				s += map[c].get(asked[c]);
			}
		sink = s;
	});
	time("identity-then-content scan over string[]", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = cids[i];
				const ns = names[c];
				const want = asked[c];
				let fi = -1;
				for (let j = 0; j < ns.length; j++)
					if (ns[j] === want) {
						fi = j;
						break;
					}
				s += fi;
			}
		sink = s;
	});
}
if (sink === Number.MIN_SAFE_INTEGER) console.log("unreachable");
