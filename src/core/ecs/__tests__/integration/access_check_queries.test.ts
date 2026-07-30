// The `queries ⊆ reads ∪ writes` registration lint.
//
// `SystemConfig.queries` is an OPTIONAL declaration of the components a system
// iterates via `ctx.query(...)`. The runtime `accessCheck` already throws at
// the first iteration if a system reads a component it never declared; this
// lint moves that failure forward to `registerSystem` by checking the two
// declarations agree. A query term reads each listed component's presence /
// columns, so every id in `queries` must appear in `reads ∪ writes`.
//
// The lint runs in `__DEV__` only (dead-code-eliminated in production, like the
// rest of `accessCheck`), is skipped for `exclusive` systems (full access), and
// never fires for the bare-fn / 2-arg `registerSystem` overloads (which carry no
// `queries`). These tests pin all of that.

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, type ECSError } from "../../utils/error";
import type { SystemConfig } from "../../system";
import type { SystemContext } from "../../query";

/** Minimal dense-empty config; spread and override per test. */
function base(overrides: Partial<SystemConfig>): SystemConfig {
	return {
		reads: [],
		writes: [],
		fn: (_ctx: SystemContext, _dt: number) => {},
		...overrides
	};
}

/** The undeclared component ids the lint message lists in its `[…]` block.
 * Parsing the bracket avoids false matches against other digits. */
function undeclaredIds(message: string): number[] {
	const m = message.match(/\[([0-9,\s]*)\]/);
	if (m === null) return [];
	return m[1]
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => !Number.isNaN(n));
}

describe("queries ⊆ reads ∪ writes lint", () => {
	it("registers cleanly when every queried component is in reads", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);
		expect(() =>
			world.registerSystem(base({ reads: [Pos, Vel], queries: [[Pos, Vel]] }))
		).not.toThrow();
	});

	it("registers cleanly when a queried component is covered by writes (write ⇒ read)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		expect(() => world.registerSystem(base({ writes: [Pos], queries: [[Pos]] }))).not.toThrow();
	});

	it("throws when a queried component is in neither reads nor writes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);
		expect(() => world.registerSystem(base({ reads: [Pos], queries: [[Pos, Vel]] }))).toThrow();
	});

	it("throws QUERY_ACCESS_UNDECLARED naming the system and the offending id", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const Vel = world.registerComponent(["vx"] as const);
		try {
			world.registerSystem(base({ name: "mover", reads: [Pos], queries: [[Pos, Vel]] }));
			expect.unreachable("registration should have thrown");
		} catch (e) {
			const err = e as ECSError;
			expect(err.category).toBe(ECS_ERROR.QUERY_ACCESS_UNDECLARED);
			expect(err.message).toContain("'mover'");
			// Only the undeclared Vel is listed; the declared Pos is not.
			expect(undeclaredIds(err.message)).toEqual([Vel.id]);
		}
	});

	it("flags undeclared ids across multiple query groups, deduped", () => {
		const world = new ECS();
		const A = world.registerComponent(["a"] as const);
		const B = world.registerComponent(["b"] as const);
		try {
			// B appears in two groups but is undeclared — it should be listed once.
			world.registerSystem(base({ reads: [A], queries: [[A, B], [B]] }));
			expect.unreachable("registration should have thrown");
		} catch (e) {
			expect(undeclaredIds((e as ECSError).message)).toEqual([B.id]);
		}
	});

	it("does not lint when queries is undefined (opt-in declaration)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		// reads/writes empty and no queries decl — nothing to validate at registration
		// (a real read would still throw at runtime via accessCheck).
		expect(() => world.registerSystem(base({ reads: [Pos] }))).not.toThrow();
	});

	it("does not lint an empty queries array", () => {
		const world = new ECS();
		expect(() => world.registerSystem(base({ queries: [] }))).not.toThrow();
	});

	it("skips the lint for exclusive systems (full access)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		// reads/writes empty but exclusive grants full access — a queries decl
		// must not be rejected.
		expect(() => world.registerSystem(base({ exclusive: true, queries: [[Pos]] }))).not.toThrow();
	});
});
