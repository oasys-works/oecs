/**
 * P10, what does a read of one field by id cost, and where does the cost sit?
 *
 * P09 measured `getField` at about twice the cursor and named the cause: the
 * field-name lookup, not the layout. That was a diagnosis from reading the
 * code. This probe tests it.
 *
 * `Archetype.readField(row, cid, field)` does four things:
 *
 *   1. `_colOffset[cid]`          an integer-keyed array load
 *   2. `_fieldIndex[cid][field]`  a string-keyed property load
 *   3. `_bufs[offset + fi]`       an array load
 *   4. `[row]`                    the element load, the only one that is work
 *
 * Step 2 is the one a caller pays on every read and never needs to. A field
 * index belongs to the schema, not to the archetype: `Pos.x` is field 0 in
 * every archetype that holds `Pos`. So it can resolve once, when the caller
 * asks for the accessor, and never again.
 *
 * The substrate study's answer to this shape is to generate a free function for
 * each site at define time and hand the caller that. A closure that captures
 * the resolved index does the same work with no code generation, no
 * `new Function`, and nothing for a Content-Security-Policy to refuse. Both are
 * measured here, because "generate the code" and "hoist the lookup" are
 * different claims and only one of them may be paying.
 *
 * Five paths, over the same entities and the same field:
 *
 *   getfield   `ecs.getField(id, Pos, "x")`, today's convenience path
 *   cursor     `cur.at(id).x`, today's by-id sweep path
 *   bound      a closure holding the component id and the field index
 *   generated  the same body from `new Function`, with both baked in as literals
 *   chunk      a dense column walk, in order only, the floor, not a peer
 *
 * In order and shuffled, because P09 showed the shuffle cost dominates the
 * whole by-id path and would hide a difference in the lookup.
 */
import { emit, iqr, median, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";

const N = 200_000;
const SAMPLES = 15;
const WARMUP = 5;

const KEEP = [];

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

function timeIt(fn) {
	let sink = 0;
	for (let i = 0; i < WARMUP; i++) sink += fn();
	const ts = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now();
		sink += fn();
		ts.push(performance.now() - t0);
	}
	globalThis.__sink = sink;
	return ts;
}

/** Fisher-Yates over xorshift32. A modulo stride walks a pattern the prefetcher
 * learns, and the shuffled row must not measure that. */
function shuffledOrder(n) {
	const a = new Uint32Array(n);
	for (let i = 0; i < n; i++) a[i] = i;
	let x = 0x9e3779b9;
	for (let i = n - 1; i > 0; i--) {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		const j = x % (i + 1);
		const t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
	return a;
}

async function run(name) {
	const [path, order] = name.split("+");
	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS } = await import(DIST.href);

	const ecs = new ECS({ memory: { budget: { entities: N }, columnCapacity: pow2(N) } });
	KEEP.push(ecs);
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	ecs.startup();

	const T = ecs.template(Pos({ x: 0, y: 0, z: 0 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) {
		ids[i] = ecs.spawn(T);
		ecs.setField(ids[i], Pos, "x", i * 0.5);
	}

	const walk = order === "shuffled" ? shuffledOrder(N) : null;
	// One order array either way, so both rows run the same indirection count.
	const seq = walk ?? (() => {
		const a = new Uint32Array(N);
		for (let i = 0; i < N; i++) a[i] = i;
		return a;
	})();

	// The two candidates reach past the public surface on purpose. They are a
	// measurement of a body the library could expose, not a suggestion that a
	// user write this.
	const store = ecs.store;
	const cid = Pos.id ?? Pos;
	const probeArch = store.resolveEntity(ids[0]);
	const fi = probeArch._fieldIndex[cid]["x"];

	let times;
	let checksum = 0;

	if (path === "getfield") {
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) s += ecs.getField(ids[seq[i]], Pos, "x");
			return s;
		});
		for (let i = 0; i < N; i++) checksum += ecs.getField(ids[seq[i]], Pos, "x");
	} else if (path === "cursor") {
		const cur = ecs.cursorRead(Pos);
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) s += cur.at(ids[seq[i]]).x;
			return s;
		});
		for (let i = 0; i < N; i++) checksum += cur.at(ids[seq[i]]).x;
	} else if (path === "bound") {
		// The field index resolves once here, and the string never appears again.
		const get = (id) => {
			const a = store.resolveEntity(id);
			return a._bufs[a._colOffset[cid] + fi][store.resolvedRow];
		};
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) s += get(ids[seq[i]]);
			return s;
		});
		for (let i = 0; i < N; i++) checksum += get(ids[seq[i]]);
	} else if (path === "generated") {
		// The same body, with the component id and the field index as literals.
		// If this beats `bound`, code generation is buying something a closure
		// cannot. If it ties, the lesson is to hoist the lookup and nothing more.
		const make = new Function(
			"store",
			`return function get(id){var a=store.resolveEntity(id);return a._bufs[a._colOffset[${cid}]+${fi}][store.resolvedRow];}`
		);
		const get = make(store);
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) s += get(ids[seq[i]]);
			return s;
		});
		for (let i = 0; i < N; i++) checksum += get(ids[seq[i]]);
	} else if (path === "chunk") {
		// The floor. It resolves nothing per row, so it is not a peer of the four
		// above. It is the number they are spending their indirection against.
		const q = ecs.query(Pos);
		times = timeIt(() => {
			let s = 0;
			q.eachChunk((cols, count) => {
				const { x } = cols.read(Pos);
				for (let i = 0; i < count; i++) s += x[i];
			});
			return s;
		});
		q.eachChunk((cols, count) => {
			const { x } = cols.read(Pos);
			for (let i = 0; i < count; i++) checksum += x[i];
		});
	} else {
		throw new Error(`unknown path ${path}`);
	}

	if (KEEP.length !== 1) throw new Error("sink broken");
	return { name, median: median(times), spread: iqr(times), checksum: Math.round(checksum) };
}

const PATHS = ["getfield", "cursor", "bound", "generated", "chunk"];

const which = variantArg();
if (which) {
	try {
		emit(await run(which));
	} catch (e) {
		emit({ name: which, blocked: String(e && e.message ? e.message : e) });
	}
} else {
	console.log(`P10, a read of one field by id: where the cost sits`);
	console.log(`      ${N.toLocaleString()} entities, one f32 field, summed`);
	console.log(`      bound and generated resolve the field index once; getfield resolves it per read`);
	console.log(`      chunk is the floor: a dense walk that resolves nothing per row\n`);

	console.log(
		`  ${"order".padEnd(10)} ${"runtime".padEnd(12)} ${"path".padEnd(11)} ${"median".padEnd(10)} ${"vs cursor".padEnd(11)} ${"p25-p75".padEnd(15)} checksum`
	);
	console.log(
		`  ${"-".repeat(10)} ${"-".repeat(12)} ${"-".repeat(11)} ${"-".repeat(10)} ${"-".repeat(11)} ${"-".repeat(15)} --------`
	);
	for (const order of ["inorder", "shuffled"]) {
		for (const rt of RUNTIMES) {
			const got = {};
			for (const p of PATHS) got[p] = runVariantOn(rt, import.meta.url, `${p}+${order}`);
			if (!got.cursor || got.cursor.blocked) {
				console.log(`  ${order.padEnd(10)} ${rt.cmd.padEnd(12)} ! no cursor baseline`);
				continue;
			}
			for (const p of PATHS) {
				const r = got[p];
				if (!r) continue;
				if (r.blocked) {
					console.log(`  ${order.padEnd(10)} ${rt.cmd.padEnd(12)} ${p.padEnd(11)} blocked: ${r.blocked}`);
					continue;
				}
				console.log(
					`  ${order.padEnd(10)} ${`${rt.cmd} (${rt.engine})`.padEnd(12)} ${p.padEnd(11)} ` +
						`${r.median.toFixed(3).padEnd(10)} ${(r.median / got.cursor.median).toFixed(2).concat("x").padEnd(11)} ` +
						`${`${r.spread.p25.toFixed(2)}-${r.spread.p75.toFixed(2)}`.padEnd(15)} ${r.checksum}`
				);
			}
		}
	}
	console.log(`\n  Checksums must match within an order, or the paths are not reading the same thing.`);
	console.log(`  A tie between bound and generated means the lookup was the cost, not the call shape.`);
}
