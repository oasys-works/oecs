/**
 * P23-solid, what does the solid plugin cost per tick?
 *
 * The plugin reads the store's change feed and writes one Solid signal per row
 * inside one `batch` per `update()`. Nothing under `bench/` measured that path
 * before this file.
 *
 * The plugin first wrote a Solid store keyed by entity id. This probe put that
 * publish above the signal-per-row publish, so the row model changed and the
 * README keeps both results.
 *
 * An earlier revision compared the plugin against a chain of the observers
 * plugin, the in-house reactive kernel and a kernel-to-Solid mirror. The
 * package no longer ships that kernel, so the chain rows are gone. The README
 * keeps what they said.
 *
 * The warm-up counts row visits and not ticks, because the seed warms the
 * publish path before any reader exists. See `warmupTicks`.
 *
 * One `createEffect` for each entity reads that entity's `x`. The world runs one
 * system that writes K rows by id through `ctx.setField`, on a fixed shuffled
 * order. The probe times the whole tick call, so the publish and the Solid flush
 * both sit inside it.
 *
 * Three groups, one variant per process:
 *
 *   plugin:d<K>    publish K dirty rows of N, with N effects awake
 *   plugin:idle    the same world, no write, the tax of a quiet tick
 *   plugin:nosub   one middle density, no effects, the publish alone
 *
 * `nosub` drops the cells as well as the effects, because a cell exists only for
 * a reader. That row measures the publish with nobody watching.
 *
 * What this refuses. No DOM, no `<For>`, no renderer. An effect is the cheapest
 * subscriber Solid has, so every row here is a floor for a real view.
 *
 * Under node's own export condition solid-js resolves to its server build. A
 * signal there holds a value and no effect ever runs. Each child spawns with
 * `--conditions=browser` in its node arguments, and not in `NODE_OPTIONS`,
 * because `runVariant` clears that variable for the child. Each child then
 * proves the condition took. An effect inside a `createRoot` must run once at
 * creation and again after each signal write, and the child throws when it does
 * not.
 */
import { emit, iqr, median, runVariant, variantArg } from "./harness.mjs";

const N = 200_000;
/** P22's densities, so the two probes read against each other. */
const DENSITIES = [1, 200, 2_000, 20_000, 200_000];
const NOSUB_K = 2_000;
const SAMPLES = 20;
/**
 * The warm-up counts row visits, not ticks. The seed runs the publish path over
 * every entity before a single cell exists, so the branch that writes a cell is
 * cold when the samples start. A small K gives that branch too few visits per
 * tick to reach the optimizing tier, and the variant then reports the tier it
 * climbed out of. The cap keeps K = 1 finite.
 */
const WARM_VISITS = 40_000;
const WARMUP_CAP = 400;
const warmupTicks = (K) =>
	Math.min(WARMUP_CAP, Math.max(6, Math.ceil(WARM_VISITS / Math.max(K, 1))));

/** The client build of solid-js, and room for one Solid effect per entity. */
const NODE_ARGS = ["--conditions=browser", "--max-old-space-size=8192"];

const KEEP = [];

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

const dist = (p) => import(new URL(`../../dist/${p}`, import.meta.url).href);

/**
 * Prove that solid-js is the client build. The server build creates the same
 * signal and never schedules, so every timing below would report the cost of
 * writing values nobody reads. Returns the effect's run count after creation
 * and after each of two writes.
 */
async function selfCheck() {
	const { createRoot, createEffect, createSignal } = await import("solid-js");
	let runs = 0;
	let set = null;
	createRoot(() => {
		const [get, setValue] = createSignal(0);
		set = setValue;
		createEffect(() => {
			get();
			runs++;
		});
	});
	const created = runs;
	set(1);
	const first = runs;
	set(2);
	const second = runs;
	return { created, first, second, ok: created === 1 && first === 2 && second === 3 };
}

async function assertClientSolid() {
	const c = await selfCheck();
	if (!c.ok) {
		throw new Error(
			`solid-js is not the client build, an effect ran ${c.created}, ${c.first}, ${c.second} times. Spawn the child with --conditions=browser`
		);
	}
}

/**
 * One world of N entities, one `Pos` of two f32 fields, and one UPDATE system
 * that writes `x` on K rows by id. `frame` changes the written value on every
 * tick, so no equality skip can hide a publish.
 */
async function buildWorld(K) {
	const { ECS, SCHEDULE } = await dist("index.js");
	const { solid } = await dist("plugins/solid.js");
	const ecs = ECS.create({ memory: { entities: N }, plugins: [solid()] });
	KEEP.push(ecs);
	const Pos = ecs.registerComponent({ x: "f32", y: "f32" });
	const order = shuffledOrder(N);
	const ids = new Uint32Array(N);
	const st = { frame: 0 };
	const sys = ecs.registerSystem({
		reads: [Pos],
		writes: [Pos],
		fn: (ctx) => {
			const frame = st.frame;
			for (let j = 0; j < K; j++) ctx.setField(ids[order[j]], Pos, "x", frame);
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.startup();
	const T = ecs.template(Pos({ x: 0, y: 0 }));
	for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
	return { ecs, Pos, ids, st };
}

/** One view, and the tick is a plain `update()`. */
async function pluginPath(K, subscribe) {
	const w = await buildWorld(K);
	const view = w.ecs.solid.fields(w.Pos, ["x", "y"]);
	KEEP.push(view);
	const counter = { runs: 0, sink: 0 };
	if (subscribe) {
		const { createRoot, createEffect } = await import("solid-js");
		const ids = w.ids;
		createRoot(() => {
			for (let i = 0; i < N; i++) {
				// One cell for each row, made in the row's own scope, the way a
				// `<For>` row body binds it.
				const cell = view.cell(ids[i]);
				createEffect(() => {
					const row = cell();
					if (row !== undefined) counter.sink += row.x;
					counter.runs++;
				});
			}
		});
	}
	return {
		counter,
		tick: () => {
			w.st.frame++;
			w.ecs.update(0.016);
		}
	};
}

/** Warm up, then time SAMPLES ticks. The world stays alive across the samples,
 * and nothing spawns or despawns inside the timed region. */
function timeTicks(p, warmup) {
	for (let i = 0; i < warmup; i++) p.tick();
	const before = p.counter.runs;
	const ts = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now();
		p.tick();
		ts.push(performance.now() - t0);
	}
	globalThis.__sink = p.counter.sink;
	return { ts, woke: (p.counter.runs - before) / SAMPLES };
}

async function run(name) {
	if (name === "check") return { name, check: await selfCheck() };
	await assertClientSolid();
	const mode = name.split(":")[1];
	const K = mode === "idle" ? 0 : mode === "nosub" ? NOSUB_K : Number(mode.slice(1));
	const subscribe = mode !== "nosub";
	const p = await pluginPath(K, subscribe);
	// `idle` moves no row, so it takes the cap and warms the tick itself.
	const warmup = warmupTicks(K);
	const { ts, woke } = timeTicks(p, warmup);
	return { name, K, subscribe, warmup, woke, median: median(ts), spread: iqr(ts) };
}

const which = variantArg();
if (which) {
	try {
		emit(await run(which));
	} catch (e) {
		emit({ name: which, blocked: String(e && e.stack ? e.stack : e) });
	}
} else {
	const ms = (v) => v.toFixed(3);
	const ns = (v, k) => (k === 0 ? "," : ((v * 1e6) / k).toFixed(1));
	const spread = (s) => `${ms(s.p25)}-${ms(s.p75)}`;
	const take = (v) => runVariant(import.meta.url, v, NODE_ARGS);

	console.log(`P23-solid, ECS state into SolidJS: what the solid plugin costs per tick`);
	console.log(
		`      ${N.toLocaleString()} entities, one component of two f32 fields, one effect per entity, node only\n`
	);

	const c = take("check");
	if (c.blocked) {
		console.log(`  self-check blocked: ${c.blocked.split("\n")[0]}`);
		process.exit(1);
	}
	console.log(
		`  self-check: one effect inside createRoot ran ${c.check.created} time, then ${c.check.first}, then ${c.check.second}, after two signal writes.`
	);
	console.log(
		`  ${c.check.ok ? "The client build is loaded." : "The server build is loaded, and every row below is void."}\n`
	);
	if (!c.check.ok) process.exit(1);

	const row = (r) => {
		if (r.blocked) return `  ${r.name.padEnd(14)} blocked: ${r.blocked.split("\n")[0]}`;
		return `  ${r.name.padEnd(14)} ${ms(r.median).padEnd(10)} ${ns(r.median, r.K).padEnd(14)} ${spread(r.spread).padEnd(18)} ${r.woke}`;
	};
	const head = `  ${"variant".padEnd(14)} ${"ms/tick".padEnd(10)} ${"ns/dirty row".padEnd(14)} ${"p25-p75".padEnd(18)} effects woken`;

	console.log(`  d: K of ${N.toLocaleString()} rows written by id, N effects subscribed. The whole tick call.`);
	console.log(
		`  warm-up: ${WARM_VISITS.toLocaleString()} row visits before the samples, capped at ${WARMUP_CAP} ticks.`
	);
	console.log(head);
	for (const K of DENSITIES) console.log(row(take(`plugin:d${K}`)));

	console.log(`\n  idle: the same world, nothing written, N effects subscribed.`);
	console.log(head);
	console.log(row(take("plugin:idle")));

	console.log(`\n  nosub: K = ${NOSUB_K.toLocaleString()}, no effect subscribed. The publish without a reader.`);
	console.log(head);
	console.log(row(take("plugin:nosub")));

	console.log(`\n  Numbers are for this machine and this build. Read the ratios and the positions.`);
}
