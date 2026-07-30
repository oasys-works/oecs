/**
 * The cost of a ref, and the question whether a cursor that moves can remove that
 * cost.
 *
 * Fix 2 in INVESTIGATION.md estimates −6.4 ns for each entity. To get this result, it
 * replaces the `Object.create(proto)` in `createRef` with one accessor that the code
 * uses again and moves. The evidence is a synthetic test that gave 7.00 ns to allocate
 * and read, and 0.62 ns to move and read. This probe measures the real code, and it
 * separates two costs that the synthetic test holds together:
 *
 *   THE ALLOCATION   — one `Object.create(proto)` for each entity.
 *   THE SHAPE OF THE ACCESSOR — each component has its OWN cached prototype.
 *                     Therefore a read of `ref.x` at a site that receives refs from
 *                     several components is a megamorphic load of a property. The code
 *                     also uses the WeakMap to find the prototype at each call.
 *
 * A cursor that moves removes the first cost, and it does NOT remove the second cost.
 * Therefore the estimate is correct only if the allocation is the largest cost.
 * `probe-fieldshape.mjs` shows that this is not true: `refRead` measured 21.9 ns with
 * one component, and 47.5 ns with 24 components. The allocation cannot cause a
 * difference of 25 ns.
 *
 *   node bench/vs/probe-refcursor.mjs [bundle]
 */
const bundle = process.argv[2] ?? "./.out/oecs.b.mjs";
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
	console.log(`  ${label.padEnd(48)} ${ns.toFixed(2).padStart(7)} ns/op`);
	return ns;
}

const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
const P3 = ecs.registerComponent({ x: "f64", y: "f64", z: "f64" }, { name: "P3" });
const ids = ecs.spawnMany(ecs.template(P3({ x: 1, y: 2, z: 3 })), N);

console.log("one component — how much of a ref is allocation?\n");
const r1 = time("refRead → 1 field", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.refRead(P3, ids[i]).x;
	sink = s;
});
const r3 = time("refRead → 3 fields", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++)
		for (let i = 0; i < N; i++) {
			const p = ecs.refRead(P3, ids[i]);
			s += p.x + p.y + p.z;
		}
	sink = s;
});
const g1 = time("getField → 1 field", 20 * N, () => {
	let s = 0;
	for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.getField(ids[i], P3, "x");
	sink = s;
});

// The cursor a fix-2 API would hand back, modelled at the JS level: ONE object,
// repointed per entity. `_row` is the only per-entity write, and the accessor
// prototype is resolved once outside the loop — so this is the floor a
// `cursor.at(entity)` could reach, minus the entity→row resolution it would
// still owe. Getting the prototype requires a first ref, which is why the model
// is built from one rather than reimplemented.
console.log(`\nmodelled re-pointable cursor (one object, repointed per entity)`);
{
	const seed = ecs.refRead(P3, ids[0]);
	const proto = Object.getPrototypeOf(seed);
	const cursor = Object.create(proto);
	// The row for each entity, resolved up front, so this measures ONLY the
	// accessor cost and not the resolution a real cursor would still pay.
	const rows = new Int32Array(N);
	for (let i = 0; i < N; i++) rows[i] = i;

	time("repoint + read 1 field (resolution excluded)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				cursor._row = rows[i];
				s += cursor.x;
			}
		sink = s;
	});
	time("allocate + read 1 field (resolution excluded)", 20 * N, () => {
		let s = 0;
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				const c = Object.create(proto);
				c._row = rows[i];
				s += c.x;
			}
		sink = s;
	});
}

console.log(`
  derived:
    each field after the first        ${((r3 - r1) / 2).toFixed(2)} ns
    ref vs getField at 1 field        ${r1.toFixed(2)} vs ${g1.toFixed(2)} ns
  A cursor can only recover the allocation term. Compare the two modelled rows
  above: if they are close, fix 2's −6.4 ns is not there to be had.`);
if (sink === Number.MIN_SAFE_INTEGER) console.log("unreachable");

// ── the shipped cursor ───────────────────────────────────────────────────────
// The real thing, including the entity→(archetype,row) resolution the modelled
// rows above deliberately excluded. This is what a by-id sweep now costs.
if (typeof ecs.cursor === "function") {
	console.log(`\nECS.cursor — resolution included (this is the shipped path)`);
	const c1 = time("cursor.at + 1 field", 20 * N, () => {
		let s = 0;
		const c = ecs.cursor(P3);
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				c.at(ids[i]);
				s += c.x;
			}
		sink = s;
	});
	const c3 = time("cursor.at + 3 fields", 20 * N, () => {
		let s = 0;
		const c = ecs.cursor(P3);
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				c.at(ids[i]);
				s += c.x + c.y + c.z;
			}
		sink = s;
	});
	time("cursorRead.at + 3 fields", 20 * N, () => {
		let s = 0;
		const c = ecs.cursorRead(P3);
		for (let r = 0; r < 20; r++)
			for (let i = 0; i < N; i++) {
				c.at(ids[i]);
				s += c.x + c.y + c.z;
			}
		sink = s;
	});
	console.log(`
    1 field:  cursor ${c1.toFixed(2)} vs refRead ${r1.toFixed(2)} vs getField ${g1.toFixed(2)} ns
    3 fields: cursor ${c3.toFixed(2)} vs refRead ${r3.toFixed(2)} vs 3×getField ${(g1 * 3).toFixed(2)} ns
    each field after the first, via cursor ${((c3 - c1) / 2).toFixed(2)} ns`);
}
