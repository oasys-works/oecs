import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR } from "../../utils/error";

/**
 * `spawn`, `spawnMany` and `template` each have one usual misuse. Before these
 * guards, every misuse went to the store. The store then failed with a
 * `TypeError` about an internal field. That error named the wrong place, and it
 * did not tell the caller what to do.
 *
 * The types reject each misuse. An untyped call site does not, and the JSDoc on
 * `spawn` showed the array shape for years after the shape changed. So these
 * tests use `as never` on purpose: they cover the JavaScript caller and the
 * caller who copied the old example.
 */
function setup() {
	const ecs = new ECS({ memory: { columnCapacity: 64 } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
	return { ecs, Pos, Vel };
}

describe("template misuse gives a message that names the fix", () => {
	it("spawn rejects a component definition", () => {
		const { ecs, Pos } = setup();
		expect(() => ecs.spawn(Pos as never)).toThrowError(/spawn: expected a template/);
		expect(() => ecs.spawn(Pos as never)).toThrowError(/component definition/);
		expect(() => ecs.spawn(Pos as never)).toThrowError(/spawnBundle/);
	});

	it("spawn rejects a bundle", () => {
		const { ecs, Pos } = setup();
		expect(() => ecs.spawn(Pos({ x: 1, y: 2 }) as never)).toThrowError(/spawn: expected a template/);
		expect(() => ecs.spawn(Pos({ x: 1, y: 2 }) as never)).toThrowError(/bundle/);
	});

	it("spawnMany rejects a component definition", () => {
		const { ecs, Pos } = setup();
		expect(() => ecs.spawnMany(Pos as never, 4)).toThrowError(/spawnMany: expected a template/);
	});

	it("template rejects the pre-0.5 array of entries", () => {
		const { ecs, Pos } = setup();
		// The exact shape the stale `spawn` JSDoc example used.
		expect(() => ecs.template([{ def: Pos, values: { x: 0, y: 0 } }] as never)).toThrowError(
			/template: got an array/
		);
		expect(() => ecs.template([{ def: Pos, values: { x: 0, y: 0 } }] as never)).toThrowError(
			/pre-0\.5/
		);
	});

	it("carries the INVALID_TEMPLATE category", () => {
		const { ecs, Pos } = setup();
		try {
			ecs.spawn(Pos as never);
			expect.unreachable("spawn should have thrown");
		} catch (e) {
			expect((e as { category: ECS_ERROR }).category).toBe(ECS_ERROR.INVALID_TEMPLATE);
		}
	});

	it("the correct calls still work", () => {
		const { ecs, Pos, Vel } = setup();
		// The shape the fixed JSDoc example shows.
		const Bullet = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 0 }));
		const b = ecs.spawn(Bullet, { x: 5 });
		expect(ecs.getField(b, Pos, "x")).toBe(5);
		expect(ecs.getField(b, Vel, "vx")).toBe(1);

		const many = ecs.spawnMany(Bullet, 3);
		expect(many).toHaveLength(3);

		// And the no-template path the message points at.
		const c = ecs.spawnBundle(Pos({ x: 9, y: 9 }));
		expect(ecs.getField(c, Pos, "x")).toBe(9);

		// A bare spawn still makes an empty entity.
		expect(ecs.isAlive(ecs.spawn())).toBe(true);
	});
});
