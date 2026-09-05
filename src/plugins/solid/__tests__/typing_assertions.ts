/***
 * Compile-time typing assertions for the solid plugin, never executed.
 * `tsc --noEmit` validates every `@ts-expect-error` on each typecheck, and
 * vitest never collects this file.
 ***/

import { ECS } from "../../../core/ecs/ecs";
import { solid } from "../index";
import type { ComponentDef, EntityID, SparseComponentDef } from "../../../core/ecs";

declare const Pos: ComponentDef<{ x: "f64"; y: "f64" }>;
declare const Cool: SparseComponentDef<{ v: "f64" }>;
declare const target: EntityID;

function worldSurface(): void {
	const world = ECS.create({ plugins: [solid()] });
	// The facade exists exactly when the plugin list installs the plugin.
	const view = world.solid.component(Pos, (row) => row.field("x"));
	const value: number | undefined = view.cell(target)();
	void value;

	const bare = new ECS();
	// @ts-expect-error. A world that installed no solid plugin carries no
	// `solid` member, which is the whole guard: there is no reserved slot.
	void bare.solid;
}

function rowTyping(): void {
	const world = ECS.create({ plugins: [solid()] });

	// `fields` types the row to the listed keys, and to nothing else. The row is
	// read with no annotation, so the inferred type is what carries the claim.
	const picked = world.solid.fields(Pos, ["x"]);
	const row = picked.cell(target)()!;
	const listed: number = row.x;
	void listed;
	// @ts-expect-error, 'y' is absent from the row because the list left it out
	void row.y;

	// `eq` sees the projected value, and nothing wider.
	void world.solid.fields(Pos, ["x"], { eq: (a, b) => a.x === b.x });
	// @ts-expect-error, 'y' is absent from the value `eq` compares
	void world.solid.fields(Pos, ["x"], { eq: (a, b) => a.y === b.y });

	// @ts-expect-error, 'z' is not a field of Pos
	void world.solid.fields(Pos, ["z"]);

	void world.solid.component(Pos, (r) => {
		// @ts-expect-error, 'z' is not a field of Pos
		return r.field("z");
	});

	const single = world.solid.singleton(Pos, target, ["x"]);
	const one: number = single.value.x;
	void one;
	// @ts-expect-error, 'y' is absent from the singleton for the same reason
	void single.value.y;
}

function sparseIsRefused(): void {
	const world = ECS.create({ plugins: [solid()] });
	// @ts-expect-error. A sparse definition is a number at run time, the wrong
	// shape for a cursor and for the dense change feed.
	void world.solid.component(Cool, (row) => row.field("v"));
	// @ts-expect-error, same refusal on the field-list entry point
	void world.solid.fields(Cool, ["v"]);
	// @ts-expect-error, and on the singleton entry point
	void world.solid.singleton(Cool, target, ["v"]);
}

void worldSurface;
void rowTyping;
void sparseIsRefused;
