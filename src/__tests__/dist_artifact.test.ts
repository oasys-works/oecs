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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { INTERNAL_EXPORTS, ROOT_EXPORTS } from "./public_api_surface";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = join(ROOT, "dist");
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
function probe(source: string): Record<string, unknown> {
	const dir = mkdtempSync(join(tmpdir(), "oecs-dist-"));
	try {
		const entry = join(dir, "probe.mjs");
		writeFileSync(entry, source);
		const out = execFileSync(process.execPath, [entry], { cwd: ROOT, encoding: "utf8" });
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
const cjs = createRequire(${JSON.stringify(join(ROOT, "package.json"))})(${JSON.stringify(join(DIST, "index.cjs"))});
console.log(JSON.stringify({
	root: Object.keys(root).sort(),
	internal: Object.keys(internal).sort(),
	dev: Object.keys(dev).sort(),
	cjs: Object.keys(cjs).sort()
}));
`;

/** Every dev guard the report names, once per build variant. `label` says which
 * category an ECSError carried, or the plain value production produced. */
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

describe("the shipped bundle", () => {
	beforeAll(() => {
		buildIfStale();
	}, 120_000);

	it("exports the same surface as the sources, on every entry", () => {
		const keys = probe(SURFACE) as Record<string, string[]>;
		expect(keys.root).toEqual([...ROOT_EXPORTS]);
		expect(keys.dev).toEqual([...ROOT_EXPORTS]);
		expect(keys.cjs).toEqual([...ROOT_EXPORTS]);
		expect(keys.internal).toEqual([...INTERNAL_EXPORTS]);
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
});
