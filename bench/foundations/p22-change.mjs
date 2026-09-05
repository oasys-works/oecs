/**
 * P22, what does change detection cost at the row grain, and where does the
 * cost sit?
 *
 * The engine has two grains. The archetype grain is one integer store per
 * mutable accessor, and it is free. The entity grain is opt in: a write path
 * that knows the entity pushes it onto a dirty list behind a dedup byte, and
 * the observer drains the list at the tick tail. That design came from the
 * substrate study, which measured a per-element observable setter against a
 * raw write plus an int push, and the push won. The study never measured the
 * third shape: a raw write plus one typed-array store into a tick column that
 * rides the row plane. This probe does.
 *
 * Nothing in `bench/` measured either grain before this file.
 *
 * Four groups, one variant per process:
 *
 *   w:*   the dense write path, one f32 store per row over every row, plus the
 *         record that makes the row visible to an entity-grain consumer
 *   b:*   the by-id write path, shuffled, every entity once
 *   d:*   the drain, K of N rows dirty, at five densities
 *   o:*   the idle tax, many entity observers and nothing dirty
 *
 * The hand-written candidates (`tickcol`, `bitset`, `scan`) reach past the
 * library on purpose. They measure a body the library could own, not a
 * suggestion that a user write it.
 */
import { emit, iqr, median, runVariant, variantArg } from "./harness.mjs";

const N = 200_000;
const SAMPLES = 20;
const WARMUP = 6;
const INDEX_MASK = (1 << 20) - 1;

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

/** A world of N entities with one f32 component, one system that runs `body`,
 * and an optional entity-grain onSet observer with an empty callback. Returns
 * the pieces the variants need. `loopMs` accumulates the time the system body
 * spent, so a variant can split the write path from the tick tail. */
async function build({ observer, body }) {
	const { ECS, SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const { observers } = await import(new URL("../../dist/capabilities/observers.js", import.meta.url).href);
	// Every world here installs the observer capability, even a variant that never
	// observes. One construction path keeps the comparison on the bodies.
	const ecs = ECS.create({ memory: { entities: N }, plugins: [observers()] });
	KEEP.push(ecs);
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const q = ecs.query(Pos);
	let fired = 0;
	if (observer) {
		ecs.observe(Pos, {
			granularity: "entity",
			access: { reads: [Pos], writes: [] },
			onSet: () => {
				fired++;
			}
		});
	}
	const st = { loopMs: 0, ctx: null, tick: 0 };
	const sys = ecs.registerSystem({
		reads: [Pos],
		writes: [Pos],
		fn: (ctx) => {
			st.ctx = ctx;
			st.tick = ctx.ecsTick;
			const t0 = performance.now();
			body(ctx);
			st.loopMs += performance.now() - t0;
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.startup();
	const T = ecs.template(Pos({ x: 0, y: 0, z: 0 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
	// No settle update here: the body closes over the handle this returns.
	return { ecs, Pos, q, ids, st, firedCount: () => fired };
}

/** Warm up, then time SAMPLES updates. Returns the per-update total and the
 * per-update system-body time, both medians with spread. */
function timeUpdates(w) {
	for (let i = 0; i < WARMUP; i++) w.ecs.update(0.016);
	const total = [];
	const loop = [];
	for (let i = 0; i < SAMPLES; i++) {
		w.st.loopMs = 0;
		const t0 = performance.now();
		w.ecs.update(0.016);
		total.push(performance.now() - t0);
		loop.push(w.st.loopMs);
	}
	return { total, loop };
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

function stat(ts) {
	return { median: median(ts), spread: iqr(ts) };
}

// ── w: the dense write path ────────────────────────────────────────────────

async function denseWrite(kind) {
	// Hand-written candidates for the record. One Uint32Array of ticks per row,
	// or one bit per row. Both sized to the archetype, not to the entity index.
	const tickcol = new Uint32Array(N);
	const bits = new Uint32Array((N + 31) >>> 5);
	const observer = kind === "mark" || kind === "ticks";
	const w = await build({
		observer,
		body: (ctx) => {
			const tick = ctx.ecsTick;
			w.q.forEachChunk((cols, count) => {
				const { x } = cols.mut(w.Pos);
				const eids = cols.arch.entityIds;
				if (kind === "raw") {
					for (let i = 0; i < count; i++) x[i] += 1;
				} else if (kind === "mark" || kind === "mark-off") {
					for (let i = 0; i < count; i++) {
						x[i] += 1;
						ctx.markChanged(eids[i], w.Pos);
					}
				} else if (kind === "tickcol") {
					for (let i = 0; i < count; i++) {
						x[i] += 1;
						tickcol[i] = tick;
					}
				} else if (kind === "ticks") {
					// The library's row record: the tick column of the archetype.
					const t = cols.ticks(w.Pos);
					const now = cols.tick;
					for (let i = 0; i < count; i++) {
						x[i] += 1;
						t[i] = now;
					}
				} else if (kind === "bitset") {
					for (let i = 0; i < count; i++) {
						x[i] += 1;
						bits[i >>> 5] |= 1 << (i & 31);
					}
				}
			});
		}
	});
	const { total, loop } = timeUpdates(w);
	return {
		name: `w:${kind}`,
		rows: N,
		loop: stat(loop),
		total: stat(total),
		fired: w.firedCount()
	};
}

// ── b: the by-id write path ────────────────────────────────────────────────

async function byIdWrite(kind) {
	const order = shuffledOrder(N);
	const idxstamp = new Uint32Array(1 << 20);
	const observer = kind === "setfield-tracked" || kind === "cursor-mark" || kind === "cursor-tracked";
	let cur = null;
	const w = await build({
		observer,
		body: (ctx) => {
			const ids = w.ids;
			const Pos = w.Pos;
			const tick = ctx.ecsTick;
			if (kind === "setfield" || kind === "setfield-tracked") {
				for (let i = 0; i < N; i++) ctx.setField(ids[order[i]], Pos, "x", i);
			} else if (kind === "cursor" || kind === "cursor-tracked") {
				// `cursor-tracked` registers an entity observer: the record a
				// mutable `at()` makes when the component is tracked.
				if (cur === null) cur = ctx.cursor(Pos);
				for (let i = 0; i < N; i++) cur.at(ids[order[i]]).x = i;
			} else if (kind === "cursor-mark") {
				if (cur === null) cur = ctx.cursor(Pos);
				for (let i = 0; i < N; i++) {
					const id = ids[order[i]];
					cur.at(id).x = i;
					ctx.markChanged(id, Pos);
				}
			} else if (kind === "cursor-idxstamp") {
				// The conservative record a mutable `at()` could make: one store,
				// keyed by entity index like the dedup byte is today.
				if (cur === null) cur = ctx.cursor(Pos);
				for (let i = 0; i < N; i++) {
					const id = ids[order[i]];
					cur.at(id).x = i;
					idxstamp[id & INDEX_MASK] = tick;
				}
			}
		}
	});
	const { total, loop } = timeUpdates(w);
	return {
		name: `b:${kind}`,
		rows: N,
		loop: stat(loop),
		total: stat(total),
		fired: w.firedCount()
	};
}

// ── d: the drain at five densities ─────────────────────────────────────────

const DENSITIES = [1, 200, 2_000, 20_000, 200_000];

async function drain(kind, K) {
	const stride = Math.max(1, Math.floor(N / K));
	if (kind === "list" || kind === "base") {
		// Today's mechanism end to end: K marks in the system, then the tick
		// tail drains, radix-sorts, checks liveness and fires K empty callbacks.
		// `base` runs the same K calls with no observer, so the marks are gated
		// off and the difference is the whole entity-grain cost.
		const w = await build({
			observer: kind === "list",
			body: (ctx) => {
				const ids = w.ids;
				const Pos = w.Pos;
				for (let j = 0, i = 0; j < K; j++, i += stride) ctx.markChanged(ids[i], Pos);
			}
		});
		const { total } = timeUpdates(w);
		return { name: `d:${kind}:${K}`, K, total: stat(total), fired: w.firedCount() };
	}
	if (kind === "ticks") {
		// The library's scan drain end to end: K row stamps through `cols.ticks`
		// in a chunk loop, then the tick tail scans the plane, radix-sorts and
		// fires K empty callbacks. The chunk loop runs over every row either way.
		const w = await build({
			observer: true,
			body: () => {
				w.q.forEachChunk((cols, count) => {
					const t = cols.ticks(w.Pos);
					const now = cols.tick;
					for (let i = 0; i < count; i += stride) t[i] = now;
				});
			}
		});
		const { total } = timeUpdates(w);
		return { name: `d:ticks:${K}`, K, total: stat(total), fired: w.firedCount() };
	}
	if (kind === "scan") {
		// The tick-column candidate: K stores, then one pass over N rows that
		// collects the changed rows in row order. No sort, no dedup, no clear.
		const tickcol = new Uint32Array(N);
		const eids = new Uint32Array(N);
		for (let i = 0; i < N; i++) eids[i] = i;
		const out = new Uint32Array(N);
		let tick = 1;
		const ts = timeIt(() => {
			tick++;
			for (let j = 0, i = 0; j < K; j++, i += stride) tickcol[i] = tick;
			let n = 0;
			for (let i = 0; i < N; i++) if (tickcol[i] === tick) out[n++] = eids[i];
			return n;
		});
		return { name: `d:scan:${K}`, K, total: stat(ts) };
	}
	if (kind === "scanbits") {
		// The bitset candidate: K read-modify-writes, then a word walk that skips
		// zero words. Cleared at the drain, so it serves one consumer.
		const bits = new Uint32Array((N + 31) >>> 5);
		const eids = new Uint32Array(N);
		for (let i = 0; i < N; i++) eids[i] = i;
		const out = new Uint32Array(N);
		const ts = timeIt(() => {
			for (let j = 0, i = 0; j < K; j++, i += stride) bits[i >>> 5] |= 1 << (i & 31);
			let n = 0;
			for (let wi = 0; wi < bits.length; wi++) {
				let word = bits[wi];
				if (word === 0) continue;
				bits[wi] = 0;
				const base = wi << 5;
				while (word !== 0) {
					const low = word & -word;
					const b = 31 - Math.clz32(low);
					out[n++] = eids[base + b];
					word ^= low;
				}
			}
			return n;
		});
		return { name: `d:scanbits:${K}`, K, total: stat(ts) };
	}
	if (kind === "handlist") {
		// The list candidate with nothing else around it: K dedup-and-push, then
		// clear the marks. What `list` pays on top of this is the library.
		const marks = new Uint8Array(1 << 20);
		const list = new Uint32Array(N);
		const ts = timeIt(() => {
			let n = 0;
			for (let j = 0, i = 0; j < K; j++, i += stride) {
				if (marks[i] === 0) {
					marks[i] = 1;
					list[n++] = i;
				}
			}
			for (let j = 0; j < n; j++) marks[list[j]] = 0;
			return n;
		});
		return { name: `d:handlist:${K}`, K, total: stat(ts) };
	}
	throw new Error(`unknown drain kind ${kind}`);
}

// ── s: the sparse row grain ────────────────────────────────────────────────

/** The by-id write path of a sparse component, shuffled, every member once,
 * through the mutable sparse cursor and through `setSparseField`, with and
 * without an entity-level onSet observer. The cursor's `at()` is the fastest
 * read by id the engine has, so its record must stay near free while nothing
 * tracks the component, and it must be one store more once something does. */
async function sparseWrite(kind) {
	const { ECS, SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const { observers } = await import(new URL("../../dist/capabilities/observers.js", import.meta.url).href);
	const ecs = ECS.create({ memory: { entities: N }, plugins: [observers()] });
	KEEP.push(ecs);
	const Pos = ecs.registerComponent({ x: "f32" });
	const Cool = ecs.registerSparseComponent({ v: "f32" });
	let fired = 0;
	if (kind.endsWith("-tracked")) {
		ecs.observe(Cool, {
			granularity: "entity",
			access: { sparseReads: [Cool], reads: [], writes: [] },
			onSet: () => {
				fired++;
			}
		});
	}
	const order = shuffledOrder(N);
	const st = { loopMs: 0 };
	let cur = null;
	const sys = ecs.registerSystem({
		reads: [Pos],
		writes: [],
		sparseReads: [Cool],
		sparseWrites: [Cool],
		fn: (ctx) => {
			const t0 = performance.now();
			if (kind === "cursor" || kind === "cursor-tracked") {
				if (cur === null) cur = ctx.sparseCursor(Cool);
				for (let i = 0; i < N; i++) cur.at(ids[order[i]]).v = i;
			} else if (kind === "cursorread") {
				if (cur === null) cur = ctx.sparseCursorRead(Cool);
				let s = 0;
				for (let i = 0; i < N; i++) s += cur.at(ids[order[i]]).v;
				st.sink = s;
			} else if (kind === "setfield" || kind === "setfield-tracked") {
				for (let i = 0; i < N; i++) ctx.setSparseField(ids[order[i]], Cool, "v", i);
			}
			st.loopMs += performance.now() - t0;
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.startup();
	const T = ecs.template(Pos({ x: 0 }));
	const ids = new Uint32Array(N);
	for (let i = 0; i < N; i++) {
		ids[i] = ecs.spawn(T);
		ecs.addSparse(ids[i], Cool, { v: 0 });
	}
	const w = { ecs, st };
	const { total, loop } = timeUpdates(w);
	return { name: `s:${kind}`, rows: N, loop: stat(loop), total: stat(total), fired };
}

// ── o: the idle tax ────────────────────────────────────────────────────────

async function idle(M) {
	const { ECS, SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const { observers } = await import(new URL("../../dist/capabilities/observers.js", import.meta.url).href);
	const ecs = ECS.create({ memory: { entities: 1024 }, plugins: [observers()] });
	KEEP.push(ecs);
	const defs = [];
	for (let i = 0; i < 32; i++) defs.push(ecs.registerComponent({ v: "f32" }));
	const before = process.memoryUsage().arrayBuffers;
	for (let i = 0; i < M; i++) {
		ecs.observe(defs[i], { granularity: "entity", access: { reads: [defs[i]], writes: [] }, onSet: () => {} });
	}
	const after = process.memoryUsage().arrayBuffers;
	const sys = ecs.registerSystem({ reads: [], writes: [], fn: () => {} });
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.startup();
	const T = ecs.template(defs[0]({ v: 0 }));
	for (let i = 0; i < 64; i++) ecs.spawn(T);
	const ts = timeIt(() => {
		ecs.update(0.016);
		return 1;
	});
	return { name: `o:${M}`, M, total: stat(ts), bufferBytes: after - before };
}


// ── a: the facts, no timing ────────────────────────────────────────────────

/** Which write paths reach an entity-grain onSet, what the archetype grain
 * reports for an acquisition with no write, and how many ticks one write is
 * reported on. Printed as facts, so the reader can disbelieve the timings
 * above with the semantics in hand. */
async function facts() {
	const { ECS, SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const { observers } = await import(new URL("../../dist/capabilities/observers.js", import.meta.url).href);
	const lines = [];

	// Which paths an entity-grain onSet sees.
	{
		const ecs = ECS.create({ memory: { entities: 1000 }, plugins: [observers()] });
		const Pos = ecs.registerComponent({ x: "f32" });
		const fired = [];
		ecs.observe(Pos, { granularity: "entity", access: { reads: [Pos], writes: [] }, onSet: (e) => fired.push(e) });
		const q = ecs.query(Pos);
		const changed = q.changed(Pos);
		let seen = 0;
		let mode = "none";
		let ids = [];
		const writer = ecs.registerSystem({
			reads: [Pos],
			writes: [Pos],
			fn: (ctx) => {
				if (mode === "ref") ctx.ref(Pos, ids[0]).x = 5;
				else if (mode === "cursor") ctx.cursor(Pos).at(ids[1]).x = 6;
				else if (mode === "mut, no write") q.forEachChunk((cols) => void cols.mut(Pos));
				else if (mode === "setField") ctx.setField(ids[2], Pos, "x", 7);
				else if (mode === "markChanged") ctx.markChanged(ids[3], Pos);
			}
		});
		const reader = ecs.registerSystem({
			reads: [Pos],
			writes: [],
			fn: () => {
				seen = 0;
				changed.forEach(() => seen++);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, writer, reader);
		ecs.startup();
		const T = ecs.template(Pos({ x: 0 }));
		for (let i = 0; i < 4; i++) ids.push(ecs.spawn(T));
		ecs.update(0.016);
		ecs.update(0.016);
		for (const m of ["ref", "cursor", "mut, no write", "setField", "markChanged"]) {
			mode = m;
			fired.length = 0;
			ecs.update(0.016);
			lines.push(
				`${m.padEnd(14)} entity onSet fired for ${fired.length} of 1 written, changed(Pos) saw ${seen} archetype`
			);
		}
		lines.push(`values landed: ${[0, 1, 2].map((i) => ecs.getField(ids[i], Pos, "x")).join(" ")}`);
	}

	// How many ticks one write is reported on, by system order.
	for (const writerFirst of [true, false]) {
		const ecs = ECS.create({ memory: { entities: 1000 }, plugins: [observers()] });
		const Pos = ecs.registerComponent({ x: "f32" });
		const changed = ecs.query(Pos).changed(Pos);
		let tick = 0;
		const seen = [];
		let id = 0;
		const writer = ecs.registerSystem({
			reads: [Pos],
			writes: [Pos],
			fn: (ctx) => {
				if (tick === 3) ctx.setField(id, Pos, "x", 1);
			}
		});
		const reader = ecs.registerSystem({
			reads: [Pos],
			writes: [],
			fn: () => {
				let n = 0;
				changed.forEach(() => n++);
				if (n) seen.push(tick);
			}
		});
		if (writerFirst) ecs.addSystems(SCHEDULE.UPDATE, writer, reader);
		else ecs.addSystems(SCHEDULE.UPDATE, reader, writer);
		ecs.startup();
		id = ecs.spawn(ecs.template(Pos({ x: 0 })));
		for (tick = 0; tick < 8; tick++) ecs.update(0.016);
		lines.push(
			`one write at tick 3, ${writerFirst ? "writer before reader" : "reader before writer"}: reader saw changed on ticks ${seen.join(", ")}`
		);
	}

	// Sparse components.
	{
		const ecs = ECS.create({ memory: { entities: 1000 }, plugins: [observers()] });
		const S = ecs.registerSparseComponent({ v: "f32" });
		const Pos = ecs.registerComponent({ x: "f32" });
		try {
			ecs.observe(S, { granularity: "entity", access: { reads: [], writes: [] }, onSet: () => {} });
			lines.push("observe(sparse): accepted");
		} catch (e) {
			lines.push(`observe(sparse): throws "${e.message}"`);
		}
		try {
			ecs.query(Pos).withSparse(S).changed(S);
			lines.push("changed(sparse): accepted, and nothing stamps a sparse column, so it never matches");
		} catch (e) {
			lines.push(`changed(sparse): throws "${e.message}"`);
		}
	}
	return { name: "a:facts", lines };
}

// ── driver ─────────────────────────────────────────────────────────────────

async function run(name) {
	const [g, kind, k] = name.split(":");
	if (g === "w") return denseWrite(kind);
	if (g === "b") return byIdWrite(kind);
	if (g === "d") return drain(kind, Number(k));
	if (g === "o") return idle(Number(kind));
	if (g === "s") return sparseWrite(kind);
	if (g === "a") return facts();
	throw new Error(`unknown variant ${name}`);
}

const which = variantArg();
if (which) {
	try {
		emit(await run(which));
	} catch (e) {
		emit({ name: which, blocked: String(e && e.stack ? e.stack : e) });
	}
} else {
	const ns = (ms, rows) => ((ms * 1e6) / rows).toFixed(2);
	const ms = (v) => v.toFixed(3);
	const spread = (s) => `${ms(s.p25)}-${ms(s.p75)}`;

	console.log(`P22, change detection at the row grain: where the cost sits`);
	console.log(`      ${N.toLocaleString()} entities, one component of three f32 fields, node only\n`);

	console.log(`  a: the facts, on the artifact.`);
	const f = runVariant(import.meta.url, "a:facts");
	if (f.blocked) console.log(`  blocked: ${f.blocked.split("\n")[0]}`);
	else for (const l of f.lines) console.log(`  ${l}`);
	console.log("");

	console.log(`  w: the dense write path. One f32 store per row, plus the record.`);
	console.log(`     loop = the system body alone. total = the whole update, tick tail included.`);
	console.log(`  ${"variant".padEnd(18)} ${"loop ns/row".padEnd(12)} ${"vs raw".padEnd(8)} ${"total ms".padEnd(10)} ${"p25-p75".padEnd(16)} fired`);
	let raw = null;
	for (const k of ["raw", "mark-off", "mark", "ticks", "tickcol", "bitset"]) {
		const r = runVariant(import.meta.url, `w:${k}`);
		if (r.blocked) {
			console.log(`  ${r.name.padEnd(18)} blocked: ${r.blocked.split("\n")[0]}`);
			continue;
		}
		if (k === "raw") raw = r;
		const ratio = raw ? (r.loop.median / raw.loop.median).toFixed(2) + "x" : "";
		console.log(
			`  ${r.name.padEnd(18)} ${ns(r.loop.median, N).padEnd(12)} ${ratio.padEnd(8)} ${ms(r.total.median).padEnd(10)} ${spread(r.total.spread).padEnd(16)} ${r.fired}`
		);
	}

	console.log(`\n  b: the by-id write path, shuffled, every entity once.`);
	console.log(`  ${"variant".padEnd(22)} ${"loop ns/row".padEnd(12)} ${"vs cursor".padEnd(10)} ${"total ms".padEnd(10)} ${"p25-p75".padEnd(16)} fired`);
	let cursor = null;
	for (const k of ["cursor", "cursor-tracked", "cursor-idxstamp", "cursor-mark", "setfield", "setfield-tracked"]) {
		const r = runVariant(import.meta.url, `b:${k}`);
		if (r.blocked) {
			console.log(`  ${r.name.padEnd(22)} blocked: ${r.blocked.split("\n")[0]}`);
			continue;
		}
		if (k === "cursor") cursor = r;
		const ratio = cursor ? (r.loop.median / cursor.loop.median).toFixed(2) + "x" : "";
		console.log(
			`  ${r.name.padEnd(22)} ${ns(r.loop.median, N).padEnd(12)} ${ratio.padEnd(10)} ${ms(r.total.median).padEnd(10)} ${spread(r.total.spread).padEnd(16)} ${r.fired}`
		);
	}

	console.log(`\n  d: the drain. K of ${N.toLocaleString()} rows dirty. Whole-update ms for base, list and ticks,`);
	console.log(`     loop ms for the hand-written candidates. list minus base is the by-id entity grain end to end,`);
	console.log(`     ticks is the row record and the scan drain end to end (a chunk loop over every row either way).`);
	console.log(`  ${"K".padEnd(8)} ${"base".padEnd(9)} ${"list".padEnd(9)} ${"list-base".padEnd(10)} ${"ticks".padEnd(9)} ${"handlist".padEnd(9)} ${"scan".padEnd(9)} ${"scanbits".padEnd(9)} fired`);
	for (const K of DENSITIES) {
		const base = runVariant(import.meta.url, `d:base:${K}`);
		const list = runVariant(import.meta.url, `d:list:${K}`);
		const ticks = runVariant(import.meta.url, `d:ticks:${K}`);
		const hand = runVariant(import.meta.url, `d:handlist:${K}`);
		const scan = runVariant(import.meta.url, `d:scan:${K}`);
		const sb = runVariant(import.meta.url, `d:scanbits:${K}`);
		const any = [base, list, ticks, hand, scan, sb].find((r) => r.blocked);
		if (any) {
			console.log(`  ${String(K).padEnd(8)} blocked: ${any.blocked.split("\n")[0]}`);
			continue;
		}
		console.log(
			`  ${String(K).padEnd(8)} ${ms(base.total.median).padEnd(9)} ${ms(list.total.median).padEnd(9)} ${ms(list.total.median - base.total.median).padEnd(10)} ${ms(ticks.total.median).padEnd(9)} ${ms(hand.total.median).padEnd(9)} ${ms(scan.total.median).padEnd(9)} ${ms(sb.total.median).padEnd(9)} ${list.fired}`
		);
	}

	console.log(`\n  s: the sparse by-id write path, shuffled, every member once.`);
	console.log(`  ${"variant".padEnd(22)} ${"loop ns/row".padEnd(12)} ${"vs cursorread".padEnd(14)} ${"total ms".padEnd(10)} ${"p25-p75".padEnd(16)} fired`);
	let sread = null;
	for (const k of ["cursorread", "cursor", "cursor-tracked", "setfield", "setfield-tracked"]) {
		const r = runVariant(import.meta.url, `s:${k}`);
		if (r.blocked) {
			console.log(`  ${r.name.padEnd(22)} blocked: ${r.blocked.split("\n")[0]}`);
			continue;
		}
		if (k === "cursorread") sread = r;
		const ratio = sread ? (r.loop.median / sread.loop.median).toFixed(2) + "x" : "";
		console.log(
			`  ${r.name.padEnd(22)} ${ns(r.loop.median, N).padEnd(12)} ${ratio.padEnd(14)} ${ms(r.total.median).padEnd(10)} ${spread(r.total.spread).padEnd(16)} ${r.fired}`
		);
	}

	console.log(`\n  o: the idle tax. M entity observers on M components, nothing dirty, one empty system.`);
	console.log(`  ${"M".padEnd(4)} ${"update ms".padEnd(10)} ${"p25-p75".padEnd(16)} buffer bytes added by the observers`);
	for (const M of [0, 1, 8, 32]) {
		const r = runVariant(import.meta.url, `o:${M}`);
		if (r.blocked) {
			console.log(`  ${String(M).padEnd(4)} blocked: ${r.blocked.split("\n")[0]}`);
			continue;
		}
		console.log(`  ${String(M).padEnd(4)} ${ms(r.total.median).padEnd(10)} ${spread(r.total.spread).padEnd(16)} ${r.bufferBytes.toLocaleString()}`);
	}
	console.log(`\n  Numbers are for this machine and this build. Read the ratios and the positions.`);
}
