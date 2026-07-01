import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, isEcsError } from "../../utils/error";
import { STORE_DESCRIPTOR_COMPONENT_LIMIT } from "../../../store";

// #381: the SAB archetype descriptor carries a COMPONENT_MASK_WORDS-word
// component mask (STORE_DESCRIPTOR_COMPONENT_LIMIT = 128 bits). Components past
// that limit cannot be represented, and the Zig side matches archetypes on the
// mask alone, so an overflow would silently conflate distinct archetypes.
// registerComponent must reject the overflow loudly instead.
describe("Component-count cap (SAB descriptor mask width)", () => {
	it("allows exactly STORE_DESCRIPTOR_COMPONENT_LIMIT registrations", () => {
		const world = new ECS();
		for (let i = 0; i < STORE_DESCRIPTOR_COMPONENT_LIMIT; i++) {
			expect(() => world.registerComponent([`f${i}`] as const)).not.toThrow();
		}
	});

	it("throws COMPONENT_LIMIT_EXCEEDED on the one past the limit", () => {
		const world = new ECS();
		for (let i = 0; i < STORE_DESCRIPTOR_COMPONENT_LIMIT; i++) {
			world.registerComponent([`f${i}`] as const);
		}

		try {
			world.registerComponent(["overflow"] as const);
			expect.unreachable("registering past the limit should throw");
		} catch (error) {
			expect(isEcsError(error)).toBe(true);
			if (isEcsError(error)) {
				expect(error.category).toBe(ECS_ERROR.COMPONENT_LIMIT_EXCEEDED);
				expect(error.context).toMatchObject({
					componentCount: STORE_DESCRIPTOR_COMPONENT_LIMIT,
					limit: STORE_DESCRIPTOR_COMPONENT_LIMIT
				});
			}
		}
	});

	it("keeps the last representable component (top mask bit) fully usable end-to-end", () => {
		const world = new ECS();
		// Fill every bit but the last, then register the boundary component at
		// the top mask bit (bit STORE_DESCRIPTOR_COMPONENT_LIMIT - 1).
		for (let i = 0; i < STORE_DESCRIPTOR_COMPONENT_LIMIT - 1; i++) {
			world.registerComponent([`f${i}`] as const);
		}
		const Boundary = world.registerComponent(["v"] as const);

		const e = world.createEntity();
		world.addComponent(e, Boundary, { v: 42 });
		world.flush();

		expect(world.getField(e, Boundary, "v")).toBe(42);
	});
});
