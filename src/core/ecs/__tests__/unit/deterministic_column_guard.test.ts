/**
 * #777 — the engine puts teeth on the determinism opt-in's float ban.
 *
 * A `{ deterministic: true }` world exists to keep per-tick `stateHash` in
 * agreement across hosts (ADR-0020). `f32`/`f64` columns break that — IEEE-754
 * rounds differently across V8 / Bun / Zig at the 1-ULP level — so registering
 * one on a deterministic world now throws `NON_DETERMINISTIC_COLUMN_TYPE` at
 * registration time, rather than surfacing as a silent cross-host divergence.
 * Non-deterministic worlds are unaffected (floats stay allowed).
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, isEcsError } from "../../utils/error";

function expectRejected(fn: () => void, field: string): void {
	let err: unknown;
	expect(fn).toThrow();
	try {
		fn();
	} catch (e) {
		err = e;
	}
	expect(isEcsError(err)).toBe(true);
	if (isEcsError(err)) {
		expect(err.category).toBe(ECS_ERROR.NON_DETERMINISTIC_COLUMN_TYPE);
		expect(err.message).toContain(`"${field}"`); // names the offending field
	}
}

describe("#777 determinism float-column guard", () => {
	it("rejects an f64 dense field on a deterministic world (record syntax), naming the field", () => {
		const world = new ECS({ deterministic: true });
		expectRejected(() => world.registerComponent({ x: "i32", heat: "f64" }), "heat");
	});

	it("rejects an f32 dense field on a deterministic world", () => {
		const world = new ECS({ deterministic: true });
		expectRejected(() => world.registerComponent({ temp: "f32" }), "temp");
	});

	it("rejects the array-shorthand f64 default on a deterministic world", () => {
		const world = new ECS({ deterministic: true });
		// No explicit type ⇒ the shorthand defaults to "f64" — the footgun #777 closes.
		expectRejected(() => world.registerComponent(["x", "y"]), "x");
	});

	it("allows the array shorthand with an explicit integer type on a deterministic world", () => {
		const world = new ECS({ deterministic: true });
		expect(() => world.registerComponent(["x", "y"], "i32")).not.toThrow();
	});

	it("rejects an f64 sparse field on a deterministic world, naming it a sparse component", () => {
		const world = new ECS({ deterministic: true });
		let err: unknown;
		try {
			world.registerSparseComponent({ ready_at: "f64" });
		} catch (e) {
			err = e;
		}
		expect(isEcsError(err)).toBe(true);
		if (isEcsError(err)) {
			expect(err.category).toBe(ECS_ERROR.NON_DETERMINISTIC_COLUMN_TYPE);
			expect(err.message).toContain("sparse component");
			expect(err.message).toContain('"ready_at"');
		}
	});

	it("allows integer dense and sparse columns on a deterministic world", () => {
		const world = new ECS({ deterministic: true });
		expect(() =>
			world.registerComponent({ x: "i32", y: "i16", flags: "u8", id: "u32" })
		).not.toThrow();
		expect(() => world.registerSparseComponent({ ready_at: "i32" })).not.toThrow();
		expect(() => world.registerTag()).not.toThrow();
	});

	it("leaves non-deterministic worlds unaffected — floats still allowed (dense + sparse + shorthand)", () => {
		const world = new ECS(); // default: deterministic = false
		expect(() => world.registerComponent({ x: "f64", y: "f64" })).not.toThrow();
		expect(() => world.registerComponent(["vx", "vy"])).not.toThrow(); // f64 default
		expect(() => world.registerSparseComponent({ cooldown: "f32" })).not.toThrow();
		expect(world.snapshots.deterministic).toBe(false);
	});

	it("rejecting a registration leaves no partial state — a retry with an integer type succeeds", () => {
		const world = new ECS({ deterministic: true });
		expect(() => world.registerComponent({ heat: "f64" })).toThrow();
		// The failed registration must not have consumed a component id or pushed
		// metas; the corrected one registers cleanly and is usable.
		const Cell = world.registerComponent({ heat: "i32" });
		const e = world.spawn();
		world.addComponent(e, Cell, { heat: 7 });
		expect(world.getField(e, Cell, "heat")).toBe(7);
	});
});
