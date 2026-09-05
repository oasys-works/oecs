/**
 * P09, access by id, and the SoA and AoS crossover.
 *
 * Two foundational rules meet in this probe, and the library's own `vs/`
 * comparison already reports that `read_by_id` is the one row where `oecs`
 * places last of eight.
 *
 * **Rule 8**, `layout(soa)` is a programmer declaration, not a compiler choice.
 * Experiment 09 measured SoA winning multi-field sequential walks by 1.30 to 1.34x,
 * and **AoS winning random access by 1.45x once the working set exceeds cache**
 * (L4 and L5). The winner flips with both access pattern and working-set size.
 * `oecs` is SoA-only, so if the crossover is real the library has no answer for
 * the far side of it.
 *
 * **Rule 13**, generation checks must be elidable. Experiment 17 measured them
 * at 28 to 31% on a dense array walk, but experiment 19's N2 found them lost in the
 * noise on pointer-chasing. `oecs` places the check on by-id access only, which
 * is the second case. This probe tests whether that placement holds up.
 *
 * Both are measured at a small working set (fits cache) and a large one (does
 * not), in creation order and in shuffled order. Experiment 09's first shuffle
 * used `(i * 2654435761) % (i + 1)`, which is structured rather than random and
 * left access semi-sequential. The corrected Fisher-Yates over xorshift32 is
 * what runs here.
 */
import { emit, iqr, median, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";

const SMALL = 10_000;
const LARGE = 1_000_000;
const SAMPLES = 15;
const WARMUP = 5;

function shuffled(n) {
	const a = new Uint32Array(n);
	for (let i = 0; i < n; i++) a[i] = i;
	let s = 0x2545f491;
	const next = () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s;
	};
	// Fisher-Yates. A modulo-stride "shuffle" leaves access semi-sequential and
	// silently measures a prefetch-friendly pattern instead of a random one.
	for (let i = n - 1; i > 0; i--) {
		const j = next() % (i + 1);
		const t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
	return a;
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

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

/** variant name: `<impl>-<size>-<order>` e.g. `cursor-large-shuffled` */
async function run(name) {
	const [impl, sizeName, orderName] = name.split("-");
	const N = sizeName === "small" ? SMALL : LARGE;
	const order = orderName === "shuffled" ? shuffled(N) : null;

	if (impl === "plainObj") {
		const items = new Array(N);
		for (let i = 0; i < N; i++) items[i] = { x: i * 0.5, y: i * 0.25 };
		const times = timeIt(() => {
			let s = 0;
			if (order) for (let i = 0; i < N; i++) s += items[order[i]].x;
			else for (let i = 0; i < N; i++) s += items[i].x;
			return s;
		});
		return { name, median: median(times), spread: iqr(times) };
	}

	if (impl === "rawSoA") {
		const x = new Float64Array(N);
		const y = new Float64Array(N);
		for (let i = 0; i < N; i++) {
			x[i] = i * 0.5;
			y[i] = i * 0.25;
		}
		const times = timeIt(() => {
			let s = 0;
			if (order) for (let i = 0; i < N; i++) s += x[order[i]];
			else for (let i = 0; i < N; i++) s += x[i];
			return s;
		});
		return { name, median: median(times), spread: iqr(times) };
	}

	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS } = await import(DIST.href);
	const ecs = new ECS({ memory: { entities: N, columnCapacity: pow2(N) } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const T = ecs.template(Pos({ x: 0, y: 0 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) {
		ids[i] = ecs.spawn(T);
		ecs.setField(ids[i], Pos, "x", i * 0.5);
		ecs.setField(ids[i], Pos, "y", i * 0.25);
	}

	let times;
	if (impl === "sparse") {
		// The library's own sparse storage, the feature the README lists for
		// exactly this access shape. Registered on a second world so the dense
		// columns above do not sit in cache beside it.
		const Sparse = ecs.registerSparseComponent({ sx: "f64" });
		for (let i = 0; i < N; i++) ecs.setSparseField(ids[i], Sparse, "sx", i * 0.5);
		times = timeIt(() => {
			let s = 0;
			if (order) for (let i = 0; i < N; i++) s += ecs.getSparseField(ids[order[i]], Sparse, "sx");
			else for (let i = 0; i < N; i++) s += ecs.getSparseField(ids[i], Sparse, "sx");
			return s;
		});
	} else if (impl === "cursor") {
		// The idiom the library's own `vs/README` says to use: acquire once,
		// re-point per entity, allocate nothing.
		const cur = ecs.cursorRead(Pos);
		times = timeIt(() => {
			let s = 0;
			if (order) for (let i = 0; i < N; i++) s += cur.at(ids[order[i]]).x;
			else for (let i = 0; i < N; i++) s += cur.at(ids[i]).x;
			return s;
		});
	} else if (impl === "getField") {
		times = timeIt(() => {
			let s = 0;
			if (order) for (let i = 0; i < N; i++) s += ecs.getField(ids[order[i]], Pos, "x");
			else for (let i = 0; i < N; i++) s += ecs.getField(ids[i], Pos, "x");
			return s;
		});
	} else {
		throw new Error(`unknown impl ${impl}`);
	}
	return { name, median: median(times), spread: iqr(times) };
}

const which = variantArg();
if (which) {
	emit(await run(which));
} else {
	console.log(`P09, access by id (exp 09 L3-L5 / rule 8, exp 17+19 / rule 13)`);
	console.log(`      small = ${SMALL.toLocaleString()} (fits cache), large = ${LARGE.toLocaleString()} (does not)`);
	console.log(`      shuffled = Fisher-Yates over xorshift32, not a modulo stride\n`);

	const impls = ["cursor", "getField", "sparse", "plainObj", "rawSoA"];
	for (const size of ["small", "large"]) {
		console.log(`  --- ${size} (${(size === "small" ? SMALL : LARGE).toLocaleString()} entities) ---`);
		const header = `  ${"impl".padEnd(10)} ${"runtime".padEnd(7)} ${"in order".padEnd(12)} ${"shuffled".padEnd(12)} shuffle cost`;
		console.log(header);
		console.log(`  ${"-".repeat(10)} ${"-".repeat(7)} ${"-".repeat(12)} ${"-".repeat(12)} ------------`);
		for (const impl of impls) {
			for (const rt of RUNTIMES) {
				const seq = runVariantOn(rt, import.meta.url, `${impl}-${size}-seq`);
				const shu = runVariantOn(rt, import.meta.url, `${impl}-${size}-shuffled`);
				if (!seq || !shu) continue;
				console.log(
					`  ${impl.padEnd(10)} ${rt.cmd.padEnd(7)} ` +
						`${(seq.median.toFixed(3) + " ms").padEnd(12)} ${(shu.median.toFixed(3) + " ms").padEnd(12)} ` +
						`${(shu.median / seq.median).toFixed(2)}x`
				);
			}
		}
		console.log("");
	}
	console.log(`  Read the LARGE + shuffled column against plainObj: that is the cell where`);
	console.log(`  experiment 09 says AoS wins, and where the library has no AoS to offer.`);
}
