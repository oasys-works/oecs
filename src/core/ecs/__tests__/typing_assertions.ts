/***
 * Compile-time typing assertions — never executed, never imported by a test
 * runner. `tsconfig.json` includes all of `src`, so `tsc --noEmit` checks this
 * file on every typecheck: an `@ts-expect-error` that stops erroring (a typing
 * regression loosened a signature) fails the build as "Unused '@ts-expect-error'
 * directive", and a positive case that stops compiling fails directly.
 *
 * Covers the schema-precision seams: `addComponents` entry checking, tag
 * components refusing values, and `registerEvent` field coverage.
 ***/

import type { ECS } from "../ecs";
import type { ComponentDef, ComponentSchema } from "../component";
import type { EntityID } from "../entity";
import type { EventKey } from "../event";
import type { HostCommandQueue } from "../host_commands";
import { spawnEntry } from "../host_commands";
import { bundle } from "../component";

declare const world: ECS;
declare const e: EntityID;
declare const Pos: ComponentDef<{ x: "f64"; y: "f64" }>;
declare const Vel: ComponentDef<{ vx: "f64"; vy: "f64" }>;
declare const Frozen: ComponentDef<Record<string, never>>;

// Wrapped in a never-exported, never-called function so runtime cost is nil
// and `noUnusedLocals` stays satisfied via the void reference below.
function addComponentsAssertions(): void {
	// Each entry's values are checked against its own def's schema.
	world.addComponents(e, [
		{ def: Pos, values: { x: 1, y: 2 } },
		{ def: Vel, values: { vx: 3 } } // partial: omitted fields zero-fill
	]);
	world.addComponents(e, [{ def: Pos }, { def: Frozen }]);

	// @ts-expect-error — 'vx' is a Vel field, not a Pos field
	world.addComponents(e, [{ def: Pos, values: { vx: 1 } }]);

	// @ts-expect-error — cross-entry mixup: Pos values on Vel
	world.addComponents(e, [{ def: Vel, values: { x: 1 } }]);

	// @ts-expect-error — tags carry no fields
	world.addComponents(e, [{ def: Frozen, values: { x: 1 } }]);

	// @ts-expect-error — field values are numbers
	world.addComponents(e, [{ def: Pos, values: { x: "one" } }]);
}

function tagValueAssertions(): void {
	// Valued defs: callable with partial values; tags: callable with none.
	void Pos({ x: 1 });
	void Pos();
	void Frozen();
	void bundle(Pos, { y: 2 });
	void bundle(Frozen);

	// @ts-expect-error — tag def call takes no values
	void Frozen({ x: 1 });

	// @ts-expect-error — bundle on a tag takes no values
	void bundle(Frozen, { x: 1 });

	// @ts-expect-error — misspelled field in a def-call bundle
	void Pos({ vx: 1 });

	// Template entries refuse values on tags too.
	void world.template([{ def: Pos, values: { x: 0, y: 0 } }, { def: Frozen }]);

	// @ts-expect-error — tag template entry carries no values
	void world.template([{ def: Frozen, values: { x: 1 } }]);
}

function componentDefVariance(): void {
	// A schema-typed def must stay assignable to the erased handle — internal
	// code (access declarations, command unions) depends on it.
	const erased: ComponentDef = Pos;
	const erasedTag: ComponentDef = Frozen;
	void erased;
	void erasedTag;
}

declare const ContactEvent: EventKey<{ a: EntityID; b: EntityID }>;
declare const ErasedEvent: EventKey<Record<string, number>>;

function registerEventAssertions(): void {
	// Complete cover, any order.
	world.registerEvent(ContactEvent, ["a", "b"]);
	world.registerEvent(ContactEvent, ["b", "a"]);

	// @ts-expect-error — under-registered: 'b' missing (emit would silently drop it)
	world.registerEvent(ContactEvent, ["a"]);

	// @ts-expect-error — foreign field
	world.registerEvent(ContactEvent, ["a", "b", "c"]);

	// A schema-erased key has no finite key set — the cover check is skipped.
	world.registerEvent(ErasedEvent, ["whatever"]);
}

declare const queue: HostCommandQueue;

function hostSeamAssertions(): void {
	// Entry values are complete and schema-checked per def; tags take exactly {}.
	queue.spawn([
		{ def: Pos, values: { x: 1, y: 2 } },
		{ def: Frozen, values: {} }
	]);
	void spawnEntry(Pos, { x: 1, y: 2 });

	// @ts-expect-error — misspelled field
	queue.spawn([{ def: Pos, values: { x: 1, yy: 2 } }]);

	// @ts-expect-error — cross-entry mixup: Pos values on Vel
	queue.spawn([{ def: Vel, values: { x: 1, y: 2 } }]);

	// @ts-expect-error — tag values must be empty
	queue.spawn([{ def: Frozen, values: { x: 1 } }]);

	// @ts-expect-error — junk values on a tag via the singular enqueue
	queue.addComponent(e, Frozen, { x: 1 });

	// @ts-expect-error — junk values on a tag via the immediate world API
	world.addComponent(e, Frozen, { x: 1 });
}

function noInferAssertions(): void {
	// The key is the sole source of truth for the payload/resource generic —
	// a wider value must error at the argument, not silently widen the
	// inferred type parameter.
	world.emit(ContactEvent, { a: e, b: e });

	// @ts-expect-error — extra payload field must not widen S
	world.emit(ContactEvent, { a: e, b: e, c: 1 });

	// @ts-expect-error — missing payload field
	world.emit(ContactEvent, { a: e });
}

function observeHandleAssertions<S extends ComponentSchema>(genericDef: ComponentDef<S>): void {
	// `observe` takes `ComponentHandle`, so a GENERIC `ComponentDef<S>` (whose
	// unresolved schema is not assignable to the erased `ComponentDef` — the
	// invariance ComponentHandle exists for) registers without a cast. This is
	// what the reactive bridge's generic sync functions rely on.
	void world.observe(genericDef, { onAdd: () => {} });
	void world.observe(Frozen, { onRemove: () => {} });
}

void addComponentsAssertions;
void tagValueAssertions;
void componentDefVariance;
void registerEventAssertions;
void hostSeamAssertions;
void noInferAssertions;
void observeHandleAssertions;
