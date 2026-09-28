/**
 * The shipped bundle, held to the surface and to the production behaviour.
 *
 * Every other test in this repository runs `src/` under vitest, and vitest
 * hard-codes `define: { __DEV__: true }` (vitest.config.ts). Two things follow.
 * The bundle in `dist/` is what a consumer installs, and no other test loads a
 * byte of it. The production branch of every `if (DEV)` guard is unreachable
 * from an ordinary test, because `__DEV__` is substituted before the transform.
 * This file closes both gaps against the real artifact.
 *
 * The probes run in a child `node` process, not through vitest's module
 * pipeline. A dynamic import inside a test would hand the bundle back to vite
 * to transform, and the thing under test is the emitted file exactly as node
 * loads it.
 *
 * The build runs here when `dist/` is missing or older than `src/`, so this
 * gate cannot pass against a stale artifact. The build is cheap.
 *
 * `dist/index.js` is the production variant (`DEV` folds to `false`, the guards
 * are eliminated). `dist/index.development.js` is the `/dev` variant, which
 * keeps them. The pair is the only place the two branches meet in one test.
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	INTERNAL_EXPORTS,
	PLUGIN_EXPORTS,
	PRIMITIVES_EXPORTS,
	ROOT_EXPORTS,
	SHARED_EXPORTS,
	WORKER_EXPORTS
} from "./public_api_surface";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = join(ROOT, "dist");
const PLUGINS = join(DIST, "plugins");
const PROD = join(DIST, "index.js");
const DEV_BUILD = join(DIST, "index.development.js");

/** The newest source mtime, test files excluded. A test edit must not force a
 * rebuild, because no test file reaches the bundle. */
function newestSourceMs(dir: string): number {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		const p = join(dir, entry.name);
		newest = Math.max(newest, entry.isDirectory() ? newestSourceMs(p) : statSync(p).mtimeMs);
	}
	return newest;
}

function buildIfStale(): void {
	if (existsSync(PROD) && statSync(PROD).mtimeMs >= newestSourceMs(join(ROOT, "src"))) return;
	for (const script of ["scripts/build.mjs", "scripts/postbuild.mjs"]) {
		execFileSync(process.execPath, [join(ROOT, script)], { cwd: ROOT, stdio: "pipe" });
	}
}

/** Run one harness against one entry, under plain node, and read its JSON. */
function probe(source: string, timeout?: number): Record<string, unknown> {
	const dir = mkdtempSync(join(tmpdir(), "oecs-dist-"));
	try {
		const entry = join(dir, "probe.mjs");
		writeFileSync(entry, source);
		const out = execFileSync(process.execPath, [entry], { cwd: ROOT, encoding: "utf8", timeout });
		return JSON.parse(out) as Record<string, unknown>;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const SURFACE = `
const root = await import(${JSON.stringify(PROD)});
const internal = await import(${JSON.stringify(join(DIST, "internal.js"))});
const dev = await import(${JSON.stringify(DEV_BUILD)});
const { createRequire } = await import("node:module");
const require = createRequire(${JSON.stringify(join(ROOT, "package.json"))});
const cjs = require(${JSON.stringify(join(DIST, "index.cjs"))});
const keys = (m) => Object.keys(m).sort();
// Every plugin ships four bundles under one name. The lock reads three of
// them: the production module, the development module, and the CJS file.
const plugins = {};
for (const name of ${JSON.stringify(Object.keys(PLUGIN_EXPORTS))}) {
	const file = (suffix) => ${JSON.stringify(PLUGINS + "/")} + name + suffix;
	plugins[name] = {
		prod: keys(await import(file(".js"))),
		dev: keys(await import(file(".development.js"))),
		cjs: keys(require(file(".cjs")))
	};
}
console.log(JSON.stringify({
	root: keys(root),
	internal: keys(internal),
	dev: keys(dev),
	cjs: keys(cjs),
	primitives: keys(await import(${JSON.stringify(join(DIST, "primitives.js"))})),
	shared: keys(await import(${JSON.stringify(join(DIST, "shared.js"))})),
	worker: keys(await import(${JSON.stringify(join(DIST, "worker.js"))})),
	plugins
}));
`;

/** The dev guards the two build variants answer differently, once per variant.
 * `t` returns the category an ECSError carried, or the plain value production
 * produced. */
const guards = (entry: string) => `
const { ECS } = await import(${JSON.stringify(entry)});
const t = (fn) => {
	try {
		const v = fn();
		return typeof v === "number" && Number.isNaN(v) ? "NaN" : String(v);
	} catch (err) {
		return "threw:" + (err.category ?? err.name);
	}
};
const out = {};
{
	const w = new ECS();
	const Pos = w.registerComponent({ x: "f64" });
	const Vel = w.registerComponent({ v: "f64" });
	const e = w.spawn();
	w.addComponent(e, Pos, { x: 7 });
	out.readOwnField = t(() => w.getField(e, Pos, "x"));
	out.readAbsentComponent = t(() => w.getField(e, Vel, "v"));
	out.readAbsentField = t(() => w.getField(e, Pos, "nope"));
}
{
	const w = new ECS();
	const Pos = w.registerComponent({ x: "f64" });
	const q = w.query(Pos);
	out.singleOfZero = t(() => q.singleEntity());
	const a = w.spawn();
	w.addComponent(a, Pos, { x: 1 });
	out.singleOfOne = t(() => String(q.singleEntity() === a));
	const b = w.spawn();
	w.addComponent(b, Pos, { x: 2 });
	out.singleOfTwo = t(() => String(q.singleEntity() === a));
}
console.log(JSON.stringify(out));
`;

/** A world with every plugin installed, and one fault raised from inside
 * each of three plugin modules. Each plugin bundle is a separate rollup
 * graph. A copied error class would answer `false` to `instanceof` here, even
 * though the same source declared it. */
const pluginFaults = (core: string, eventsMod: string, snapshotsMod: string, load: string) => `
const root = ${load}(${JSON.stringify(core)});
const { events } = ${load}(${JSON.stringify(eventsMod)});
const { snapshots } = ${load}(${JSON.stringify(snapshotsMod)});
const w = root.ECS.create({ deterministic: true, plugins: [events(), snapshots()] });
const caught = (fn) => {
	try {
		fn();
		return undefined;
	} catch (err) {
		return err;
	}
};
const emit = caught(() => w.events.emit(root.eventKey("unregistered"), { x: 1 }));
const restore = caught(() => w.snapshots.restore(new Uint8Array(8)));
const sparse = caught(() => w.snapshots.restoreSparse(new Uint8Array(8)));
console.log(JSON.stringify({
	emitCategory: emit?.category,
	emitIsECSError: emit instanceof root.ECSError,
	emitPassesGuard: root.isEcsError(emit),
	restoreIsECSRestoreError: restore instanceof root.ECSRestoreError,
	sparseIsSparseRestoreError: sparse instanceof root.SparseRestoreError
}));
`;

/** An observer whose declared access covers one tag, writing a second component
 * from its callback. The world runs the callback inside the same access span a
 * system gets, so the undeclared write must be refused. A copied `accessCheck`
 * holds no span, and the write goes through. */
const observerAccessSpan = `
const root = await import(${JSON.stringify(DEV_BUILD)});
const { observers } = await import(${JSON.stringify(join(PLUGINS, "observers.development.js"))});
const world = root.ECS.create({ plugins: [observers()] });
const Tag = world.registerTag();
const Other = world.registerComponent({ v: "f64" });
const access = (defs) => ({
	reads: defs, writes: defs, spawns: [], despawns: [], transitions: [],
	resourceReads: [], resourceWrites: [], sparseReads: [], sparseWrites: [],
	relationReads: [], relationWrites: []
});
let undeclaredAdd = "no throw";
let ran = false;
world.observe(Tag, {
	access: access([Tag]),
	onAdd: (eid, ctx) => {
		ran = true;
		try {
			ctx.commands.add(eid, Other);
		} catch (err) {
			undeclaredAdd = err.category ?? err.name;
		}
	}
});
const e = world.spawn();
world.addSystems(
	root.SCHEDULE.UPDATE,
	world.registerSystem({ ...access([Tag]), fn: (ctx) => ctx.commands.add(e, Tag) })
);
world.startup();
world.update(1 / 60);
console.log(JSON.stringify({ ran, undeclaredAdd }));
`;

/** One shared world driven by two workers of the shipped worker entry, against
 * the same world driven by the sequential body. The kernel is written beside
 * the probe, because a worker loads it by URL.
 *
 * No `workerUrl`, on purpose. The pool derives the entry from where its own
 * module landed, and the plugin now lands one directory below the entry the
 * worker sits beside. Every other parallel test passes an explicit URL, so this
 * is the only place that resolution runs. */
const poolFromDist = (dist: string, suffix: string) => `
const { writeFileSync } = await import("node:fs");
const kernel = new URL("./kernel.mjs", import.meta.url);
writeFileSync(kernel, "export function step(x, vx, begin, end, dt) { for (let i = begin; i < end; i++) x[i] = x[i] + vx[i] * dt; }");

const { ECS, SCHEDULE } = await import(${JSON.stringify(join(dist, "index" + suffix + ".js"))});
const { snapshots } = await import(${JSON.stringify(join(dist, "plugins", "snapshots" + suffix + ".js"))});
const { workers } = await import(${JSON.stringify(join(dist, "plugins", "workers" + suffix + ".js"))});

function build() {
	const ecs = ECS.create({
		deterministic: true,
		memory: { backing: "shared", maxBytes: 16 * 1024 * 1024 },
		plugins: [snapshots(), workers()]
	});
	const Pos = ecs.registerComponent({ x: "i32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: "i32" }, { name: "Vel" });
	const template = ecs.template(Pos({ x: 0 }), Vel({ vx: 0 }));
	ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem({
		reads: [Vel],
		writes: [Pos],
		queries: [[Pos, Vel]],
		parallel: {
			kernel: { js: kernel.href, export: "step" },
			columns: [[Pos, "x"], [Vel, "vx"]],
			minRows: 1
		},
		fn: (ctx, dt) => {
			ecs.query(Pos, Vel).forEachColumns((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				for (let i = 0; i < count; i++) p.x[i] = p.x[i] + v.vx[i] * dt;
			});
		}
	}));
	ecs.startup();
	for (let i = 0; i < 512; i++) ecs.spawn(template);
	let n = 0;
	ecs.query(Pos, Vel).forEachColumns((cols, count) => {
		const p = cols.mut(Pos);
		const v = cols.mut(Vel);
		for (let i = 0; i < count; i++, n++) {
			p.x[i] = n % 97;
			v.vx[i] = (n % 13) - 6;
		}
	});
	return ecs;
}

const sequential = build();
for (let f = 0; f < 4; f++) sequential.update(2);

const pooled = build();
const pool = await pooled.workers.attach({ count: 2 });
await pool.settled();
for (let f = 0; f < 4; f++) pooled.update(2);
const attached = pool.count;
await pool.detach();

console.log(JSON.stringify({
	attached,
	sequentialHash: sequential.snapshots.stateHash(),
	parallelHash: pooled.snapshots.stateHash()
}));
`;

/** Every static specifier one emitted module names. Rollup writes each import
 * at the start of a line. A specifier inside a retained doc comment does not
 * match, because a `*` indents it. */
function staticImports(file: string): string[] {
	const src = readFileSync(file, "utf8");
	const found = new Set<string>();
	for (const re of [
		/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
		/^\s*import\s*["']([^"']+)["']/gm,
		/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g
	]) {
		for (const m of src.matchAll(re)) found.add(m[1]);
	}
	return [...found].sort();
}

const ERROR_NAMES = `
const root = await import(${JSON.stringify(PROD)});
const named = new root.ECSError("ENTITY_NOT_ALIVE", "entity 1 is not alive");
const saved = Error.captureStackTrace;
delete Error.captureStackTrace;
let bare;
try {
	const err = new root.ECSError("ENTITY_NOT_ALIVE", "entity 2 is not alive");
	bare = { category: err.category, message: err.message, name: err.name };
} catch (err) {
	bare = { threw: String(err) };
} finally {
	Error.captureStackTrace = saved;
}
console.log(JSON.stringify({ name: named.name, bare }));
`;

const REFUSED_ATTACH = `
const { readFileSync } = await import("node:fs");
const { ECS, SCHEDULE } = await import(${JSON.stringify(PROD)});
const { workers } = await import(${JSON.stringify(join(PLUGINS, "workers.js"))});
const module = new WebAssembly.Module(readFileSync(${JSON.stringify(join(ROOT, "src/core/ecs/__tests__/fixtures/kernel_emitted.wasm"))}));
const ecs = ECS.create({ memory: { backing: "shared", maxBytes: 16 * 1024 * 1024 }, plugins: [workers()] });
const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
const Vel = ecs.registerComponent({ vx: "i32", vy: "i32" }, { name: "Vel" });
ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem({
	reads: [Vel],
	writes: [Pos],
	queries: [[Pos, Vel]],
	parallel: {
		kernel: { wasm: module, export: "integrate_i32" },
		columns: [[Pos, "x"], [Pos, "y"], [Vel, "vx"], [Vel, "vy"]],
		minRows: 1
	},
	fn: () => {}
}));
let category = null;
try {
	await ecs.workers.attach({ count: 2, workerUrl: ${JSON.stringify(join(DIST, "worker.js"))} });
} catch (err) {
	category = err.category;
}
console.log(JSON.stringify({ category, released: ecs.workers.pool === null }));
`;

describe("the shipped bundle", () => {
	beforeAll(() => {
		buildIfStale();
	}, 120_000);

	it("exports the same surface as the sources, on every entry", () => {
		const keys = probe(SURFACE) as Record<string, string[]> & {
			plugins: Record<string, Record<"prod" | "dev" | "cjs", string[]>>;
		};
		expect(keys.root).toEqual([...ROOT_EXPORTS]);
		expect(keys.dev).toEqual([...ROOT_EXPORTS]);
		expect(keys.cjs).toEqual([...ROOT_EXPORTS]);
		expect(keys.internal).toEqual([...INTERNAL_EXPORTS]);
		expect(keys.primitives).toEqual([...PRIMITIVES_EXPORTS]);
		expect(keys.shared).toEqual([...SHARED_EXPORTS]);
		expect(keys.worker).toEqual([...WORKER_EXPORTS]);
		expect(Object.keys(keys.plugins).sort()).toEqual(Object.keys(PLUGIN_EXPORTS).sort());
		for (const [name, list] of Object.entries(PLUGIN_EXPORTS)) {
			expect(keys.plugins[name].prod, `plugins/${name}.js`).toEqual([...list]);
			expect(keys.plugins[name].dev, `plugins/${name}.development.js`).toEqual([...list]);
			expect(keys.plugins[name].cjs, `plugins/${name}.cjs`).toEqual([...list]);
		}
	});

	it("keeps the dev guards in the development variant", () => {
		const out = probe(guards(DEV_BUILD));
		expect(out.readOwnField).toBe("7");
		expect(out.readAbsentComponent).toBe("threw:COMPONENT_NOT_REGISTERED");
		expect(out.readAbsentField).toBe("threw:FIELD_NOT_REGISTERED");
		expect(out.singleOfZero).toBe("threw:QUERY_NOT_SINGLETON");
		expect(out.singleOfOne).toBe("true");
		expect(out.singleOfTwo).toBe("threw:QUERY_NOT_SINGLETON");
	});

	it("drops the dev guards in the production variant, and degrades as documented", () => {
		const out = probe(guards(PROD));
		// The one case both builds share. A guard that changed a correct read
		// would show up here first.
		expect(out.readOwnField).toBe("7");
		// A read of a component the entity does not hold, or of a field the
		// component does not declare, returns NaN. `getField` documents the
		// throw as dev-only, so production reads the column that is not there.
		expect(out.readAbsentComponent).toBe("NaN");
		expect(out.readAbsentField).toBe("NaN");
		// `singleEntity` skips the count and returns the first match, and
		// `undefined` when nothing matches.
		expect(out.singleOfZero).toBe("undefined");
		expect(out.singleOfOne).toBe("true");
		expect(out.singleOfTwo).toBe("true");
	});

	it("throws the root's error classes out of a plugin, as ESM", () => {
		const out = probe(
			pluginFaults(PROD, join(PLUGINS, "events.js"), join(PLUGINS, "snapshots.js"), "await import")
		);
		expect(out.emitCategory).toBe("EVENT_NOT_REGISTERED");
		expect(out.emitIsECSError).toBe(true);
		expect(out.emitPassesGuard).toBe(true);
		expect(out.restoreIsECSRestoreError).toBe(true);
		expect(out.sparseIsSparseRestoreError).toBe(true);
	});

	it("throws the root's error classes out of a plugin, as CJS", () => {
		const prelude = `
const { createRequire } = await import("node:module");
const req = createRequire(${JSON.stringify(join(ROOT, "package.json"))});
`;
		const out = probe(
			prelude +
				pluginFaults(
					join(DIST, "index.cjs"),
					join(PLUGINS, "events.cjs"),
					join(PLUGINS, "snapshots.cjs"),
					"req"
				)
		);
		expect(out.emitCategory).toBe("EVENT_NOT_REGISTERED");
		expect(out.emitIsECSError).toBe(true);
		expect(out.emitPassesGuard).toBe(true);
		expect(out.restoreIsECSRestoreError).toBe(true);
		expect(out.sparseIsSparseRestoreError).toBe(true);
	});

	it("runs an observer callback inside the core's access span", () => {
		const out = probe(observerAccessSpan);
		expect(out.ran).toBe(true);
		expect(out.undeclaredAdd).toBe("ACCESS_UNDECLARED");
	});

	it("binds every plugin bundle to the core artifact, not to a copy", () => {
		const files = readdirSync(PLUGINS)
			.filter((name) => name.endsWith(".js") || name.endsWith(".cjs"))
			.map((name) => join(PLUGINS, name));
		expect(files.length).toBeGreaterThan(0);
		const outside: string[] = [];
		for (const file of files) {
			for (const spec of staticImports(file)) {
				const target = relative(DIST, resolve(dirname(file), spec));
				if (!target.startsWith("plugins/") && !/^(index|internal)\./.test(target)) {
					outside.push(`${relative(DIST, file)} -> ${spec}`);
				}
			}
		}
		expect(outside).toEqual([]);
	});

	it("carries no second error base in any plugin bundle", () => {
		// A plugin bundle that compiled its own `AppError` would give the program
		// two prototype chains under one error name. Every fault a plugin throws
		// is an `ECSError` bound from the core artifact, so no plugin file may
		// name the base or the assertion class that used to reach it.
		//
		// Both names survive minification. `AppError` is an import binding from
		// an external module, and `AssertionError` is the string literal the
		// class writes to `name`.
		const files = readdirSync(PLUGINS)
			.filter((name) => name.endsWith(".js") || name.endsWith(".cjs"))
			.map((name) => join(PLUGINS, name));
		expect(files.length).toBeGreaterThan(0);
		const carriers: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			if (text.includes("AppError") || text.includes("AssertionError")) {
				carriers.push(relative(DIST, file));
			}
		}
		expect(carriers).toEqual([]);
	});

	it("ships the worker entry as its own bundle, in every variant", () => {
		// `workers.attach` resolves the entry as the sibling of the module the pool
		// ships in, with the same variant and format suffixes. A missing file, or
		// one under another name, breaks that resolution and no test that starts a
		// worker would notice, because the tests start theirs from the source.
		const entries = ["worker.js", "worker.cjs", "worker.development.js", "worker.development.cjs"];
		for (const entry of entries) {
			expect(existsSync(join(DIST, entry))).toBe(true);
		}
		// A worker is another thread, so it shares no module instance with the
		// core. It must carry its own copy and import nothing at all.
		for (const entry of entries) {
			expect(staticImports(join(DIST, entry))).toEqual([]);
		}
	});

	it("names no node builtin in a specifier a bundler resolves", () => {
		// The pool and the worker entry both reach `node:worker_threads`, and both
		// ship in a bundle an app may compile for the browser. A specifier a
		// bundler can resolve makes it report an externalized node builtin and
		// ship a stub for a branch the browser never runs. `node_threads.ts` keeps
		// the specifier out of reach, and the emitted files are where that shows.
		const entries = [
			"index.js",
			"index.cjs",
			"index.development.js",
			"index.development.cjs",
			"plugins/workers.js",
			"plugins/workers.cjs",
			"plugins/workers.development.js",
			"plugins/workers.development.cjs",
			"worker.js",
			"worker.cjs",
			"worker.development.js",
			"worker.development.cjs"
		];
		const reachable: string[] = [];
		for (const entry of entries) {
			const src = readFileSync(join(DIST, entry), "utf8");
			for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["'`](node:[^"'`]+)["'`]/g)) {
				reachable.push(`${entry} -> ${m[1]}`);
			}
			// The other half of the same regression. A specifier this build does
			// not list as external is replaced by a stub that holds nothing, and
			// node then loads the stub instead of the builtin.
			if (src.includes("__vite-browser-external")) reachable.push(`${entry} -> browser stub`);
		}
		expect(reachable).toEqual([]);
	});

	it("starts a pool of workers out of the shipped artifact", () => {
		// The bundles reach the node threads module through a call, not through a
		// specifier, and rollup rewrites a dynamic import in both output formats.
		// Every other parallel test runs the source, so this is the only place
		// the emitted form of that call is exercised.
		const out = probe(poolFromDist(DIST, ""));
		expect(out.attached).toBe(2);
		expect(out.parallelHash).toBe(out.sequentialHash);
	});

	it("sends the development plugin at the development worker", () => {
		// `defaultWorkerUrl` carries this module's own suffix chain onto the
		// worker beside the package entry, so `plugins/workers.development.js`
		// must resolve to `worker.development.js`. A rollup split that moved the
		// pool into a hashed chunk would drop the `.development` suffix and send
		// this world at the production worker, and both workers run a kernel, so
		// a plain end-to-end run would still pass.
		//
		// The copy without the production worker is what makes the mistake loud.
		// The attach fails on a missing module rather than succeeding quietly.
		const dir = mkdtempSync(join(tmpdir(), "oecs-devworker-"));
		try {
			const copy = join(dir, "dist");
			cpSync(DIST, copy, { recursive: true });
			rmSync(join(copy, "worker.js"));
			const out = probe(poolFromDist(copy, ".development"));
			expect(out.attached).toBe(2);
			expect(out.parallelHash).toBe(out.sequentialHash);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves the core chunk graph at the three chunks it ships", () => {
		// The count is the contract. Each name is rollup's own, taken from one
		// module the chunk holds, so a source move that changes which module
		// rollup picks renames a chunk without changing what ships. The
		// primitives chunk answered to `typed_arrays` until `phase.ts` split off
		// `schedule.ts` and moved the topological sort into the same group.
		for (const entry of [PROD, DEV_BUILD]) {
			const chunks = staticImports(entry).filter((spec) => spec.startsWith("."));
			expect(chunks.map((spec) => spec.replace(/-[\w-]{8}\.js$/, ".js")).sort()).toEqual([
				"./host_commands.js",
				"./shared.js",
				"./topological_sort.js"
			]);
		}
	});
	it("names its errors with a literal, and delivers a fault without captureStackTrace", () => {
		// A production build renames the class, so a name read off the constructor
		// is one minified letter. captureStackTrace is a V8 extension, and a browser
		// engine without it must still hand the caller the category.
		const out = probe(ERROR_NAMES) as { name: string; bare: Record<string, string> };
		expect(out.name).toBe("ECSError");
		expect(out.bare.category).toBe("ENTITY_NOT_ALIVE");
		expect(out.bare.name).toBe("ECSError");
	});
	it("ends its workers when the attach is refused, so the process can exit", () => {
		// A wasm kernel cannot load on the shared backing, so the attach rejects.
		// The workers it started were left alive, and a live worker thread keeps a
		// process alive, so the child here never exited and the run timed out.
		const out = probe(REFUSED_ATTACH, 20_000) as { category: string; released: boolean };
		expect(out.category).toBe("PARALLEL_KERNEL_FAILED");
		expect(out.released).toBe(true);
	});
});
