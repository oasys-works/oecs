/**
 * Public-API snapshot. Every published entry is a curated, explicit list, and
 * this test makes any widening or narrowing of the published runtime surface
 * an explicit diff in review. Type-only exports have no runtime presence and
 * are not covered here. The explicit export list in each entry file is its
 * review surface.
 *
 * The lists live in `public_api_surface.ts`, because `dist_artifact.test.ts`
 * holds the shipped bundle to the same lists.
 *
 * If this test fails because you changed the API on purpose, update the list
 * and treat the change as a semver event. The root and every plugin subpath
 * are the stable surface. `/internal` carries no guarantee, and the list
 * still documents it.
 */
import { describe, expect, it } from "vitest";
import * as root from "../index";
import * as internal from "../internal";
import * as primitives from "../primitives";
import * as shared from "../shared";
import * as worker from "../worker";
import * as editor from "../plugins/editor";
import * as events from "../plugins/events";
import * as observers from "../plugins/observers";
import * as relations from "../plugins/relations";
import * as snapshots from "../plugins/snapshots";
import * as solid from "../plugins/solid";
import * as workers from "../plugins/workers";
import {
	INTERNAL_EXPORTS,
	PLUGIN_EXPORTS,
	PRIMITIVES_EXPORTS,
	ROOT_EXPORTS,
	SHARED_EXPORTS,
	WORKER_EXPORTS
} from "./public_api_surface";

/** The plugin entries under test, keyed the way `PLUGIN_EXPORTS` is. A plugin
 * added to `src/plugins` without a list here fails the first case below. */
const PLUGIN_MODULES: Readonly<Record<string, object>> = {
	editor,
	events,
	observers,
	relations,
	snapshots,
	solid,
	workers
};

describe("public API snapshot", () => {
	it("root runtime exports match the checked-in list", () => {
		expect(Object.keys(root).sort()).toEqual(ROOT_EXPORTS);
	});

	it("/internal runtime exports match the checked-in list", () => {
		expect(Object.keys(internal).sort()).toEqual(INTERNAL_EXPORTS);
	});

	it("/primitives runtime exports match the checked-in list", () => {
		expect(Object.keys(primitives).sort()).toEqual(PRIMITIVES_EXPORTS);
	});

	it("/shared runtime exports match the checked-in list", () => {
		expect(Object.keys(shared).sort()).toEqual(SHARED_EXPORTS);
	});

	it("/worker exports nothing", () => {
		expect(Object.keys(worker).sort()).toEqual(WORKER_EXPORTS);
	});

	it("every plugin entry has a list, and matches it", () => {
		expect(Object.keys(PLUGIN_MODULES).sort()).toEqual(Object.keys(PLUGIN_EXPORTS).sort());
		for (const [name, mod] of Object.entries(PLUGIN_MODULES)) {
			expect(Object.keys(mod).sort(), `@oasys/oecs/${name}`).toEqual([...PLUGIN_EXPORTS[name]]);
		}
	});

	it("internals do not leak through any public entry", () => {
		const entries: Record<string, readonly string[]> = {
			root: ROOT_EXPORTS,
			primitives: PRIMITIVES_EXPORTS,
			shared: SHARED_EXPORTS,
			...PLUGIN_EXPORTS
		};
		for (const [entry, list] of Object.entries(entries)) {
			for (const name of INTERNAL_EXPORTS) {
				expect(list, `${name} must live on /internal only, not on ${entry}`).not.toContain(name);
			}
		}
	});
});
