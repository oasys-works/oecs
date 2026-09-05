/**
 * P23, does each jit pillar still pay?
 *
 * Three pieces of this library exist for the compiler and not for the reader.
 * Each one is correct without the trick, so the unit suite passes when you
 * delete it. Each one carries a file comment that says it was measured. A
 * comment is not a gate: a reviewer who tidies the code away takes the speed
 * with it, and nothing objects.
 *
 * This probe is that gate. For each pillar it copies the checkout, removes the
 * pillar from `src/`, builds the package from the copy, and measures the same
 * workload against both builds. A pillar that still pays gives a slower patched
 * build. A pillar that gives the same number no longer pays on this engine, and
 * the probe says so.
 *
 * The pillars:
 *
 *   dispatch  `seedDispatchSite` (schedule.ts) makes the one call site that
 *             reaches every system body megamorphic on purpose, at module load.
 *             A world whose systems come from one function literal otherwise
 *             gives that site one target, and the engine inlines the system
 *             body, its chunk callback and its hot loop into the scheduler's
 *             own loop. The claim is that the inlined loop is the slower one.
 *
 *   shape     `primeAccessorShapes` (ref.ts) reassigns both own fields of a
 *             throwaway ref and a throwaway cursor at module load. V8 tracks,
 *             for each field of a shape, whether any object of that shape has
 *             reassigned it. A dense cursor reassigns `__cols` on every `at()`,
 *             and a ref and a sparse cursor never do. The claim is that the
 *             first dense `at()` therefore throws away code compiled under the
 *             constant assumption, and that the sparse cursor pays for it.
 *
 *   kinds     `ACCESSORS` (ref.ts) holds one copy of the accessor body for each
 *             of the eight element kinds. V8 shares one feedback vector across
 *             every closure made from one function literal, so a single shared
 *             body would give every accessor in the process one typed-array
 *             site, and that site would see every kind. The claim is the
 *             four-kind cliff.
 *
 * The patched build is the counterfactual, so read the ratio and not the
 * absolute time. Both sides are built by `scripts/build.mjs`, the build the
 * package ships, because guard removal changes function size and function size
 * changes what the compiler inlines.
 *
 * Not measured here. The same two files forbid reading a hot property key or a
 * `switch` tag through an imported binding, and `row_kinds.ts` forbids folding
 * its eight cases into a helper. Those rules have no probe. They are a risk
 * this file does not cover.
 *
 *   node bench/foundations/p23-pillars.mjs            # every pillar
 *   node bench/foundations/p23-pillars.mjs kinds      # one pillar
 *   node bench/foundations/p23-pillars.mjs --keep     # keep the builds
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { emit, iqr, median, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";
import { buildDist } from "../dist.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const OUT = path.join(ROOT, "bench/.out/pillars");
const BASE = "base";

// ── the pillars ─────────────────────────────────────────────────────────────
// Each pillar carries a list of edits, and each edit is a text replacement
// against `src/`, applied to a copy. The probe changes no file in this
// checkout, so it is safe to run with a dirty tree. Each `find` must match
// exactly one time, and the probe stops when it does not: a patch that matches
// nothing measures the baseline against itself and reports a pillar as free.

const PILLARS = [
	{
		id: "dispatch",
		what: "the seeded system dispatch site",
		claim: "a one-target dispatch site lets the engine inline a system body, and that is slower",
		edits: [
			{
				file: "src/core/ecs/schedule.ts",
				find: "\nseedDispatchSite();\n",
				// `void` keeps the function reachable, so the typechecker still
				// sees it used. Only the seeding is gone.
				to: "\nvoid seedDispatchSite;\n"
			}
		]
	},
	{
		id: "shape",
		what: "the primed accessor shapes",
		claim: "the first dense at() discards code the sparse cursor compiled under a constant field",
		edits: [
			{
				file: "src/core/ecs/ref.ts",
				find: "\nprimeAccessorShapes();\n",
				to: "\nvoid primeAccessorShapes;\n"
			}
		]
	},
	{
		id: "kinds",
		what: "one accessor literal for each element kind",
		claim: "one accessor body for eight element kinds puts every accessor in the process past the cliff",
		// The eight entries become eight references to one literal. The bodies are
		// already identical apart from an erased cast, so this is the refactor a
		// tidy-up pass would make, and it changes no behaviour. The eight originals
		// stay in the file under a second name, and nothing reaches them, so the
		// bundler drops them. `void` keeps the typechecker quiet, the same way the
		// other two patches keep their function reachable.
		edits: [
			{
				file: "src/core/ecs/ref.ts",
				find: "const ACCESSORS: Record<TypedArrayTag, AccessorFactory> = {\n\tf64:",
				to: [
					"const sharedAccessor: AccessorFactory = (gid, name) => ({",
					"\tget(this: Accessor) {",
					"\t\tconst cols = this.__cols;",
					"\t\treturn ((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Float64Array)[this.__row];",
					"\t},",
					"\tset(this: Accessor, v: number) {",
					"\t\tconst cols = this.__cols;",
					"\t\t((DEV ? checkedCol(cols, gid, name) : cols[gid]) as Float64Array)[this.__row] = v;",
					"\t},",
					"\tenumerable: true,",
					"\tconfigurable: true",
					"});",
					"",
					"const ACCESSORS: Record<TypedArrayTag, AccessorFactory> = {",
					"\tf64: sharedAccessor,",
					"\tf32: sharedAccessor,",
					"\ti32: sharedAccessor,",
					"\tu32: sharedAccessor,",
					"\ti16: sharedAccessor,",
					"\tu16: sharedAccessor,",
					"\ti8: sharedAccessor,",
					"\tu8: sharedAccessor",
					"};",
					"",
					"const UNUSED_ACCESSORS: Record<TypedArrayTag, AccessorFactory> = {",
					"\tf64:"
				].join("\n")
			},
			{
				file: "src/core/ecs/ref.ts",
				find: "\n/** The accessor for a name that two components give different types.",
				to: "\nvoid UNUSED_ACCESSORS;\n\n/** The accessor for a name that two components give different types."
			}
		]
	}
];

// ── the workloads ───────────────────────────────────────────────────────────
// One for each pillar, shaped to put the pillar's mechanism on the hot path and
// as little else as possible. Each runs in a fresh process against one build.

const SAMPLES = 15;
const WARMUP = 5;

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

/**
 * One system, and thus one target at the dispatch site. The world is small on
 * purpose: the seed changes what the scheduler's loop costs for each system in
 * each phase, so a body that runs for a long time hides it. A large world is
 * measured too, to find out where the effect stops.
 */
async function caseDispatch(lib, size) {
	const { ECS, SCHEDULE } = await import(lib);
	const N = size === "small" ? 100 : 100_000;
	const FRAMES = size === "small" ? 30_000 : 50;
	const ecs = new ECS({ memory: { entities: Math.max(N, 1024) } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
	const T = ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 0.5, vy: 0.25 }));
	for (let i = 0; i < N; i++) ecs.spawn(T);
	const q = ecs.query(Pos, Vel);
	ecs.addSystems(
		SCHEDULE.UPDATE,
		ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			fn: (ctx, dt) => {
				q.forEachChunk((cols, count) => {
					const p = cols.mut(Pos);
					const v = cols.read(Vel);
					const x = p.x;
					const y = p.y;
					const vx = v.vx;
					const vy = v.vy;
					for (let i = 0; i < count; i++) {
						x[i] += vx[i] * dt;
						y[i] += vy[i] * dt;
					}
				});
			}
		})
	);
	ecs.startup();
	return timeIt(() => {
		for (let f = 0; f < FRAMES; f++) ecs.update(0.016);
		return FRAMES;
	});
}

/**
 * A sparse cursor is timed, and `order` decides whether a dense cursor ran
 * first. The dense `at()` is the write that makes `__cols` mutable, so without
 * the prime the sparse loop compiles after the field has changed. The prime
 * makes both fields mutable at module load, so the order stops mattering.
 *
 * The claim is order sensitivity, so read this pillar two ways. Down a column,
 * `dense-first` against `sparse-only` is the claim itself: on the patched build
 * they should differ. Across the columns, each case says whether the prime
 * changed that order's cost.
 */
async function caseShape(lib, order) {
	const { ECS } = await import(lib);
	const N = 50_000;
	const REPS = 20;
	const ecs = new ECS({ memory: { entities: N } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Heat = ecs.registerSparseComponent({ h: "f64" });
	const T = ecs.template(Pos({ x: 1, y: 2 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) {
		ids[i] = ecs.spawn(T);
		ecs.addSparse(ids[i], Heat, { h: i });
	}
	const dense = ecs.cursor(Pos);
	const sparse = ecs.sparseCursor(Heat);
	const denseLoop = () => {
		let s = 0;
		for (let r = 0; r < REPS; r++)
			for (let i = 0; i < N; i++) {
				dense.at(ids[i]);
				s += dense.x;
			}
		return s;
	};
	const sparseLoop = () => {
		let s = 0;
		for (let r = 0; r < REPS; r++)
			for (let i = 0; i < N; i++) {
				sparse.at(ids[i]);
				s += sparse.h;
			}
		return s;
	};
	let sink = 0;
	if (order === "dense-first") for (let i = 0; i < 8; i++) sink += denseLoop();
	globalThis.__sink = sink;
	return timeIt(sparseLoop);
}

/**
 * One component with one field of each element kind, read through a cursor.
 * `one` gives every field the same kind, so a single shared accessor body still
 * sees one typed-array class. It is the control: a pillar that pays only on
 * `eight` is the cliff, and a pillar that also moves `one` is something else.
 */
async function caseKinds(lib, kinds) {
	const { ECS } = await import(lib);
	const N = 50_000;
	const REPS = 20;
	const ecs = new ECS({ memory: { entities: N } });
	const schema =
		kinds === "one"
			? { a: "f64", b: "f64", c: "f64", d: "f64", e: "f64", f: "f64", g: "f64", h: "f64" }
			: { a: "f64", b: "f32", c: "i32", d: "u32", e: "i16", f: "u16", g: "i8", h: "u8" };
	const C = ecs.registerComponent(schema);
	const T = ecs.template(C({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
	const cur = ecs.cursorRead(C);
	return timeIt(() => {
		let s = 0;
		for (let r = 0; r < REPS; r++)
			for (let i = 0; i < N; i++) {
				cur.at(ids[i]);
				s += cur.a + cur.b + cur.c + cur.d + cur.e + cur.f + cur.g + cur.h;
			}
		return s;
	});
}

/** Every measured case, by pillar. A pillar can hold more than one, and the
 * control cases live here beside the case that is supposed to move. */
const CASES = [
	{ pillar: "dispatch", id: "one-system-small", run: (lib) => caseDispatch(lib, "small") },
	{ pillar: "dispatch", id: "one-system-large", run: (lib) => caseDispatch(lib, "large") },
	{ pillar: "shape", id: "sparse-only", run: (lib) => caseShape(lib, "sparse-only") },
	{ pillar: "shape", id: "dense-first", run: (lib) => caseShape(lib, "dense-first") },
	{ pillar: "kinds", id: "eight-kinds", run: (lib) => caseKinds(lib, "eight") },
	{ pillar: "kinds", id: "one-kind-control", control: true, run: (lib) => caseKinds(lib, "one") }
];

// ── the builds ──────────────────────────────────────────────────────────────

/** Directories a copy of the checkout must not carry. `node_modules` is found
 * in a parent, because the copy sits inside this checkout. `dist` would make
 * the build compare against artifacts it did not make. */
const SKIP = new Set(["node_modules", "dist", ".git", ".out"]);

/**
 * A recursive copy, written by hand. `fs.cpSync` refuses a destination inside
 * the source, and the destination has to be inside this checkout, because a
 * copy carries no `node_modules` and node finds one in a parent directory.
 * `.claude/worktrees` holds the copies themselves, so the walk stops there.
 */
function copyCheckout(from, to, rel = "") {
	if (rel === "") fs.rmSync(to, { recursive: true, force: true });
	fs.mkdirSync(path.join(to, rel), { recursive: true });
	for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
		if (SKIP.has(e.name)) continue;
		const next = path.join(rel, e.name);
		if (next === path.join(".claude", "worktrees")) continue;
		if (e.isDirectory()) copyCheckout(from, to, next);
		else if (e.isFile()) fs.copyFileSync(path.join(from, next), path.join(to, next));
	}
}

/** Apply one pillar's patch to a copy, and stop when the text is not there.
 * A `find` that matches no times, or more than one, is a stale patch. It is
 * never a pass. */
function patch(copy, pillar) {
	for (const edit of pillar.edits) {
		const file = path.join(copy, edit.file);
		const src = fs.readFileSync(file, "utf8");
		const hits = src.split(edit.find).length - 1;
		if (hits !== 1) {
			console.error(
				`\n  ! a ${pillar.id} edit matched ${hits} times in ${edit.file}, and it must match one time.` +
					`\n    The source moved under the patch. Fix the patch before you read any number below.\n`
			);
			process.exit(1);
		}
		fs.writeFileSync(file, src.replace(edit.find, edit.to));
	}
}

/** The bytes of every emitted chunk, in name order. Two builds that give the
 * same string are the same program, whatever the patch did to the source. */
function bundleBytes(entry) {
	const dir = path.dirname(entry);
	return fs
		.readdirSync(dir, { recursive: true })
		.filter((f) => typeof f === "string" && f.endsWith(".js"))
		.sort()
		.map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
		.join("\n");
}

function buildAll(wanted) {
	const libs = {};
	process.stderr.write(`building ${BASE}\n`);
	libs[BASE] = buildDist(ROOT, path.join(OUT, BASE));
	const baseBytes = bundleBytes(libs[BASE]);
	for (const p of wanted) {
		const copy = path.join(ROOT, ".claude/worktrees", `p23-${p.id}`);
		process.stderr.write(`building ${p.id}\n`);
		copyCheckout(ROOT, copy);
		patch(copy, p);
		libs[p.id] = buildDist(copy, path.join(OUT, p.id));
		fs.rmSync(copy, { recursive: true, force: true });
		// A patch that the source accepted and the bundler then erased would
		// measure the baseline against itself, and every ratio would read 1.00x.
		// That looks exactly like a pillar that buys nothing, so check it here.
		if (bundleBytes(libs[p.id]) === baseBytes) {
			console.error(
				`\n  ! the ${p.id} patch changed the source and not the build.` +
					`\n    The bundler erased it, so both sides are the same program. Fix the patch.\n`
			);
			process.exit(1);
		}
	}
	return libs;
}

// ── child ───────────────────────────────────────────────────────────────────
// variant: `<caseId>:<buildName>`

const which = variantArg();
if (which) {
	const [caseId, build] = which.split(":");
	const found = CASES.find((c) => c.id === caseId);
	const times = await found.run(path.join(OUT, build, "index.js"));
	emit({ median: median(times), spread: iqr(times) });
} else {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const keep = process.argv.includes("--keep");
	const wanted = PILLARS.filter((p) => args.length === 0 || args.includes(p.id));
	if (wanted.length === 0) {
		console.error(`no pillar matched ${args.join(" ")}, pick from: ${PILLARS.map((p) => p.id).join(" ")}`);
		process.exit(1);
	}

	console.log(`P23, does each jit pillar still pay?`);
	console.log(`      base = this checkout, patched = the same checkout with the pillar removed`);
	console.log(`      both built by scripts/build.mjs, the build the package ships`);
	console.log(`      a ratio near 1.00x means the pillar buys nothing on this engine today\n`);

	const libs = buildAll(wanted);
	console.log("");

	const rows = [];
	for (const p of wanted) {
		console.log(`  ${p.id}: ${p.what}`);
		console.log(`  claim: ${p.claim}`);
		console.log(
			`  ${"case".padEnd(18)} ${"runtime".padEnd(8)} ${"base".padEnd(12)} ${"patched".padEnd(12)} ` +
				`${"patched/base".padEnd(13)} spreads`
		);
		console.log(
			`  ${"-".repeat(18)} ${"-".repeat(8)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(13)} --------`
		);
		for (const c of CASES.filter((c) => c.pillar === p.id)) {
			for (const rt of RUNTIMES) {
				const base = runVariantOn(rt, import.meta.url, `${c.id}:${BASE}`);
				const cut = runVariantOn(rt, import.meta.url, `${c.id}:${p.id}`);
				if (!base || !cut) continue;
				const ratio = cut.median / base.median;
				const overlap = base.spread.p75 >= cut.spread.p25 && cut.spread.p75 >= base.spread.p25;
				rows.push({ pillar: p.id, case: c.id, rt: rt.cmd, ratio, overlap, control: c.control === true });
				console.log(
					`  ${c.id.padEnd(18)} ${rt.cmd.padEnd(8)} ` +
						`${(base.median.toFixed(3) + " ms").padEnd(12)} ${(cut.median.toFixed(3) + " ms").padEnd(12)} ` +
						`${(ratio.toFixed(2) + "x").padEnd(13)} ${overlap ? "OVERLAP (noise)" : "disjoint"}`
				);
			}
		}
		console.log("");
	}

	console.log(`  A pillar earns its comment when its own case is disjoint and above 1.00x,`);
	console.log(`  and its control case is not. Read both.`);
	const largest = (rs) => rs.reduce((a, b) => (a.ratio > b.ratio ? a : b), { ratio: 0, case: "none", rt: "" });
	for (const p of wanted) {
		const all = rows.filter((r) => r.pillar === p.id);
		const best = largest(all.filter((r) => !r.overlap && !r.control));
		const ctrl = largest(all.filter((r) => r.control));
		console.log(
			`  ${p.id.padEnd(10)} largest disjoint ratio ${best.ratio.toFixed(2)}x` +
				` (${best.case}${best.rt ? `, ${best.rt}` : ""}),` +
				` ${all.filter((r) => !r.overlap).length} of ${all.length} comparisons disjoint` +
				(ctrl.case === "none" ? "" : `, control tops out at ${ctrl.ratio.toFixed(2)}x`)
		);
	}
	if (!keep) fs.rmSync(OUT, { recursive: true, force: true });
}
