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
import type { ArchetypeView } from "../archetype";
import type { ComponentDef, ComponentSchema } from "../component";
import type { EntityID } from "../entity";
import type { EventKey, EventReader } from "../event";
import type { HostCommandQueue } from "../host_commands";
import { spawnEntry } from "../host_commands";
import { bundle } from "../component";
import type { SystemContext } from "../query";
import type { SystemConfig } from "../system";
import type { SparseComponentDef } from "../sparse_store";
import type { RelationDef, RelationCardinality } from "../relation";
import type { ResourceKey } from "../resource";
import type { Template } from "../store";

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

// ═══ Compile-time access typing (§typestate, system.ts) ════════════════════
// The config-form registerSystem narrows `ctx` to the declared access
// surface; these assertions pin the enforcement AND the conversions that must
// keep compiling (helpers taking a bare SystemContext, dynamic configs, the
// explicit-annotation escape hatch).

declare const SPos: SparseComponentDef<{ x: "f64" }>;
declare const Rel: RelationDef;
declare const KeyA: ResourceKey<{ v: number }>;
declare const KeyB: ResourceKey<{ other: string }>;
declare const tpl: Template<[typeof Vel, typeof Frozen]>;

declare function permissiveHelper(ctx: SystemContext): void;

function typestateEnforcementAssertions(): void {
	world.registerSystem({
		reads: [Pos],
		writes: [Vel],
		spawns: [tpl],
		sparseWrites: [SPos],
		resourceReads: [KeyA],
		queries: [[Pos, Vel]],
		fn(ctx) {
			// Granted: declared reads, write-implies-read, declared writes.
			ctx.getField(e, Pos, "x");
			ctx.getField(e, Vel, "vx");
			ctx.setField(e, Vel, "vx", 1);
			ctx.updateField(e, Vel, "vy", (v) => v + 1);
			void ctx.ref(Vel, e);
			void ctx.refRead(Pos, e);
			// Granted: template-declared spawns authorise adds of its defs.
			ctx.addComponent(e, Frozen);
			ctx.addComponent(e, Vel, { vx: 0, vy: 0 });
			void ctx.commands.spawn(Vel({ vx: 1 }), Frozen);
			// Granted: sparse write implies sparse read.
			ctx.setSparseField(e, SPos, "x", 1);
			void ctx.getSparseField(e, SPos, "x");
			// Granted: declared resource read.
			void ctx.resource(KeyA);
			// A narrowed context flows into a permissive helper unchanged.
			permissiveHelper(ctx);

			// @ts-expect-error — Pos is read-only: not declared in writes
			ctx.setField(e, Pos, "x", 1);

			// @ts-expect-error — Frozen (a tag) is NOT a universal sink: getField
			// on a component outside reads/writes is rejected even though a tag
			// appears in the spawn template (the [__schema] slot, component.ts)
			ctx.getField(e, Frozen, "x");

			// @ts-expect-error — removeComponent needs despawns/transitions.remove
			ctx.removeComponent(e, Vel);

			// @ts-expect-error — no despawns declared: destroyEntity is blocked
			ctx.destroyEntity(e);

			// @ts-expect-error — no despawns declared: commands.despawn is blocked
			ctx.commands.despawn(e);

			// @ts-expect-error — no relation declared: relation writes are blocked
			ctx.addRelation(e, Rel, e);

			// @ts-expect-error — KeyA is declared read-only: setResource rejected
			ctx.setResource(KeyA, { v: 1 });

			// @ts-expect-error — KeyB is not declared at all
			void ctx.resource(KeyB);

			// @ts-expect-error — wrong field on a declared component
			ctx.getField(e, Pos, "vx");

			// @ts-expect-error — a tag takes no values argument
			ctx.addComponent(e, Frozen, { x: 1 });

			// @ts-expect-error — a valued component requires complete values
			ctx.addComponent(e, Vel);
		}
	});

	// Despawns grant destroy + remove; transitions feed add/remove.
	world.registerSystem({
		reads: [],
		writes: [],
		despawns: [Vel],
		transitions: [{ whenHas: [Pos], add: [Frozen], remove: [Vel] }],
		fn(ctx) {
			ctx.destroyEntity(e);
			ctx.commands.despawn(e);
			ctx.removeComponent(e, Vel);
			ctx.addComponent(e, Frozen);
		}
	});

	// @ts-expect-error — compile-time Phase D lint: query term ∉ reads ∪ writes
	world.registerSystem({ reads: [Pos], writes: [], queries: [[Vel]], fn() {} });
}

function typestateConversionAssertions(): void {
	// Escape hatch: an explicitly-annotated permissive ctx opts the system out
	// of compile-time narrowing (the runtime check still applies).
	world.registerSystem({
		reads: [],
		writes: [],
		fn(ctx: SystemContext) {
			ctx.setField(e, Pos, "x", 1);
		}
	});

	// A dynamically-built config (typed as plain SystemConfig) still registers,
	// with a permissive context.
	const dyn: SystemConfig = { reads: [], writes: [], fn: () => {} };
	void world.registerSystem(dyn);

	// `exclusive: true` keeps the fully permissive context (runtime bypass).
	world.registerSystem({
		reads: [],
		writes: [],
		exclusive: true,
		fn(ctx) {
			ctx.setField(e, Pos, "x", 1);
			ctx.destroyEntity(e);
		}
	});
}

function resourceKeyVarianceAssertions(): void {
	// Keys are invariant in T (resource.ts): a key must not widen, or
	// setResource could store a mismatched value behind a narrower key.
	// @ts-expect-error — covariant widening is a write hole
	const widened: ResourceKey<{ v: number | string }> = KeyA;
	void widened;

	// @ts-expect-error — keys with different T never cross-assign
	const crossed: ResourceKey<{ other: string }> = KeyA;
	void crossed;

	// Erasure now spells `any` (ResourceKey<unknown> no longer erases).
	const erased: ResourceKey<any> = KeyA;
	void erased;
}

function eventKeyVarianceAssertions(): void {
	// Event keys/defs are invariant in the payload schema (event.ts): a
	// covariantly-widened key would let `emit` under-fill the channel's
	// columns (the payload check runs against the WIDENED schema).
	// @ts-expect-error — dropping a field via widening is an emit hole
	const widened: EventKey<{ a: EntityID }> = ContactEvent;
	void widened;

	// Erased positions spell `any`.
	const erased: EventKey<any> = ContactEvent;
	void erased;
}

declare const Health: ComponentDef<{ hp: "i32" }>;
declare function archHelper(arch: ArchetypeView): void;

function queryTermAssertions(): void {
	// Column accessors are constrained to the query's terms (POLISH_AUDIT #6).
	const movers = world.query(Pos, Vel);
	movers.eachChunk((cols) => {
		const { x, y } = cols.mut(Pos);
		const { vx } = cols.read(Vel);
		void x; void y; void vx;
		// @ts-expect-error — Health is not a term of this query
		void cols.read(Health);
		// @ts-expect-error — mut on a non-term
		void cols.mut(Health);
	});
	movers.forEach((arch) => {
		void arch.getColumnRead(Pos, "x");
		void arch.getColumnsRead(Vel, "vx", "vy");
		// @ts-expect-error — Health is not a term of this query
		void arch.getColumnRead(Health, "hp");
		// @ts-expect-error — wrong field on a term
		void arch.getColumnRead(Pos, "hp");
		// A typed view still flows into a permissive helper.
		archHelper(arch);
	});
	// .and() extends the term set.
	movers.and(Health).eachChunk((cols) => {
		void cols.read(Health);
		void cols.read(Pos);
	});
	// Optional fetches stay compile-permissive (runtime #592 owns them): the
	// fetch-if-present accessor may name components outside the term set.
	movers.optional(Health).forEach((arch) => {
		void arch.getOptionalColumnRead(Health, "hp");
	});
}

declare const ExclusiveRel: RelationDef<"exclusive">;
declare const MultiRel: RelationDef<"multi">;

function relationCardinalityAssertions(): void {
	// The registerRelation overloads stamp the cardinality (POLISH_AUDIT #7).
	const excl = world.registerRelation();
	const excl2 = world.registerRelation({ onDeleteTarget: "delete" });
	const multi = world.registerRelation({ multi: true });
	const _e1: RelationDef<"exclusive"> = excl;
	const _e2: RelationDef<"exclusive"> = excl2;
	const _m: RelationDef<"multi"> = multi;
	void _e1; void _e2; void _m;

	// Exclusive-only surfaces accept only the exclusive brand.
	void world.targetOf(e, ExclusiveRel);
	void world.ancestorsOf(e, ExclusiveRel);
	void world.rootOf(e, ExclusiveRel);
	void world.cascadeOf(e, ExclusiveRel);

	// @ts-expect-error — targetOf on a multi relation (use targetsOf)
	void world.targetOf(e, MultiRel);
	// @ts-expect-error — traversal is exclusive-only
	void world.ancestorsOf(e, MultiRel);

	// Cardinality-agnostic surfaces take either; stamped handles erase to the
	// bare union (declaration lists, ANY_RELATION).
	world.addRelation(e, ExclusiveRel, e);
	world.addRelation(e, MultiRel, e);
	void world.targetsOf(e, MultiRel);
	const erased: RelationDef = MultiRel;
	const erased2: RelationDef<RelationCardinality> = ExclusiveRel;
	void erased; void erased2;
}

function eventReaderReadonlyAssertions(reader: EventReader<{ a: number }>): void {
	void reader.a[0];
	void reader.length;
	// @ts-expect-error — the reader is the channel's live shared view; a length
	// write would desync every other system (POLISH_AUDIT #5)
	reader.length = 0;
}

function facadeCardinalityAssertions(): void {
	// The grouped facades (H3 phase 2) mirror the typestate cardinality
	// surface — ecs.relations.register stamps the brand, and the facade's
	// exclusive-only traversal rejects a multi handle exactly like the flat
	// forms above. A facade must never be a typestate escape hatch.
	const fexcl = world.relations.register();
	const fmulti = world.relations.register({ multi: true });
	const _fe: RelationDef<"exclusive"> = fexcl;
	const _fm: RelationDef<"multi"> = fmulti;
	void _fe; void _fm;

	void world.relations.targetOf(e, ExclusiveRel);
	void world.relations.cascadeOf(e, ExclusiveRel);
	// @ts-expect-error — facade targetOf on a multi relation (use targetsOf)
	void world.relations.targetOf(e, MultiRel);
	// @ts-expect-error — facade traversal is exclusive-only
	void world.relations.ancestorsOf(e, MultiRel);
}

void addComponentsAssertions;
void tagValueAssertions;
void componentDefVariance;
void registerEventAssertions;
void hostSeamAssertions;
void noInferAssertions;
void observeHandleAssertions;
void typestateEnforcementAssertions;
void typestateConversionAssertions;
void resourceKeyVarianceAssertions;
void eventKeyVarianceAssertions;
void eventReaderReadonlyAssertions;
void relationCardinalityAssertions;
void queryTermAssertions;
void facadeCardinalityAssertions;
