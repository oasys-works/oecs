/**
 * Public-API snapshot, the root entry is a curated, explicit list, and
 * this test makes any widening (or narrowing) of the published runtime
 * surface an explicit diff in review. Type-only exports have no runtime
 * presence and are not covered here. The explicit export lists in
 * `src/index.ts` / `src/internal.ts` are their review surface.
 *
 * The lists live in `public_api_surface.ts`, because `dist_artifact.test.ts`
 * holds the shipped bundle to the same two lists.
 *
 * If this test fails because you intentionally changed the API: update the
 * list and treat the change as a semver event (root = stable surface,
 * `/internal` carries no guarantees but the list still documents it).
 */
import { describe, expect, it } from "vitest";
import * as root from "../index";
import * as internal from "../internal";
import { INTERNAL_EXPORTS, ROOT_EXPORTS } from "./public_api_surface";

describe("public API snapshot", () => {
	it("root runtime exports match the checked-in list", () => {
		expect(Object.keys(root).sort()).toEqual(ROOT_EXPORTS);
	});

	it("/internal runtime exports match the checked-in list", () => {
		expect(Object.keys(internal).sort()).toEqual(INTERNAL_EXPORTS);
	});

	it("internals do not leak through the root", () => {
		for (const name of INTERNAL_EXPORTS) {
			expect(ROOT_EXPORTS, `${name} must live on /internal only`).not.toContain(name);
		}
	});
});
