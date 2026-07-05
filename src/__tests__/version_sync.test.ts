/** Locks `VERSION` to the manifests so a release bump can't drift (M21). */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../version";

describe("VERSION export", () => {
	it("matches package.json and jsr.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		const jsr = JSON.parse(readFileSync(new URL("../../jsr.json", import.meta.url), "utf8"));
		expect(VERSION).toBe(pkg.version);
		expect(VERSION).toBe(jsr.version);
	});
});
