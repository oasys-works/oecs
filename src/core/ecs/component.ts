/***
 * Component — Schema definition and phantom-typed handles.
 *
 * Components are defined as records mapping field names to typed array tags:
 *
 *   const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
 *   const Energy = ecs.registerComponent({ current: "i32", max: "i32" });
 *
 * Or via array shorthand (defaults to "f64"):
 *
 *   const Vel = ecs.registerComponent(["vx", "vy"] as const);
 *
 * At runtime, a ComponentDef<S> is just a ComponentID (branded number).
 * The generic S is erased but carried at compile-time, enabling
 * type-safe column access: the mutable arch.getColumn(Pos, "x", tick) returns
 * Float64Array, arch.getColumn(Energy, "current", tick) returns Int32Array.
 * The read-only arch.getColumnRead(...) returns a `ReadonlyColumn` view.
 *
 * Tag components (empty schema) participate in archetype matching
 * but store no data:
 *
 *   const Frozen = ecs.registerTag();
 *   ecs.addComponent(e, Frozen);    // no values needed
 *
 ***/

import {
	Brand,
	validateAndCast,
	isNonNegativeInteger,
	type TypedArrayTag
} from "../../type_primitives";

export type ComponentID = Brand<number, "component_id">;
export const asComponentId = (value: number) =>
	validateAndCast<number, ComponentID>(
		value,
		isNonNegativeInteger,
		"ComponentID must be a non-negative integer"
	);

/** Core schema type: maps field names to typed array tags. */
export type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;

/** Compile-time tag → TypedArray mapping. */
export type TagToTypedArray = {
	f32: Float32Array;
	f64: Float64Array;
	i8: Int8Array;
	i16: Int16Array;
	i32: Int32Array;
	u8: Uint8Array;
	u16: Uint16Array;
	u32: Uint32Array;
};

/** Maps schema fields to their value object: { x: number, y: number }. */
export type FieldValues<S extends ComponentSchema> = {
	readonly [K in keyof S]: number;
};

/**
 * Values argument tuple for attaching a component of schema `S` — empty for a
 * tag, a single optional partial-values map otherwise. A tag schema
 * (`Record<string, never>`) would otherwise degenerate: `keyof` an
 * index-signature record is `string`, so `Partial<FieldValues<…>>` collapses to
 * `Record<string, number>` and `Frozen({ anything: 1 })` compiles. The
 * conditional forbids values on tags outright; a schema-erased `ComponentDef`
 * falls into the valued branch, so untyped call sites keep the loose shape.
 */
export type ValuesArg<S extends ComponentSchema> = S extends Record<string, never>
	? []
	: [values?: Partial<FieldValues<S>>];

/**
 * `FieldValues` for APIs where the values object is required and complete
 * (`addComponent`'s valued overload, the host-seam `SpawnEntry`). Guards the
 * same tag degeneracy as `ValuesArg`: a tag accepts only the empty object
 * (`Record<string, never>` — every property typed `never`), so
 * `addComponent(e, Frozen, { x: 1 })` is a compile error while the
 * tag-overload-less call sites can still pass `{}`.
 */
export type CompleteFieldValues<S extends ComponentSchema> = S extends Record<string, never>
	? Record<string, never>
	: FieldValues<S>;

/**
 * Trailing-argument tuple for the attach surfaces (`ctx.commands.add`'s
 * explicit-values form, `ctx.addSparse`): a tag takes NO values argument, a valued schema REQUIRES a
 * complete one. Encodes the former tag/valued overload pair as one signature,
 * which the typed system seam needs — its `def` parameter is a single
 * declared-access-constrained type param, and per-schema overloads would
 * re-introduce the tag-vs-valued split on top of it.
 */
export type AttachValuesArg<S extends ComponentSchema> = S extends Record<string, never>
	? []
	: [values: CompleteFieldValues<S>];

/** Maps schema fields to their specific typed array columns. */
export type ColumnsForSchema<S extends ComponentSchema> = {
	readonly [K in keyof S]: TagToTypedArray[S[K]];
};

/**
 * Mutable sibling of `ColumnsForSchema` — the field-keyed column group handed
 * back by `eachChunk`'s `cols.mut(def)` (no `readonly`, since the whole point
 * is in-place writes). The change-tick is stamped once when the group is
 * resolved, so the per-row loop is plain typed-array indexing (§eachChunk).
 */
export type MutableColumnsForSchema<S extends ComponentSchema> = {
	[K in keyof S]: TagToTypedArray[S[K]];
};

// Phantom slot carrying the schema OUTSIDE the call signature (see ComponentDef).
declare const __schema: unique symbol;

/**
 * A component handle. **Callable**: `Pos({ x, y })` produces a `Bundle` (omitted
 * fields zero-fill at attach), so one varargs shape — `spawn(Pos({x,y}),
 * Vel({vx:1}), IsEnemy)` — replaces the older incompatible attach shapes. A bare
 * `Pos` (uncalled) still stands in for a tag / all-zero values wherever a
 * `BundleOrDef` is accepted.
 *
 * The numeric component id lives on `.id` (registration order). Consumers treat
 * the def as an opaque handle; internal code reads `def.id` where it needs the
 * raw id. The call signature's `S` makes `ComponentDef<{x:"f64"}>` distinct from
 * `ComponentDef<{vx:"f64"}>`.
 *
 * The optional `[__schema]` slot never exists at runtime; it re-states `S` in a
 * covariant tuple position so that a TAG def type is not a universal assignment
 * sink. Through the call signature alone every def is assignable to
 * `ComponentDef<Record<string, never>>` (the tag callable takes no required
 * args and any `Bundle` satisfies its return), which would let ONE tag in a
 * system's declared-access union admit every component at compile time
 * (§typestate — `DeclaredRead` and friends in system.ts). With the slot, a
 * valued schema is not assignable to the tag schema (`"f64" ⊀ never`), while
 * schema erasure (`ComponentDef<S>` → bare `ComponentDef`) still works because
 * every schema is assignable to `ComponentSchema`.
 *
 * Build one with `makeComponentDef`; never construct by hand.
 */
export interface ComponentDef<S extends ComponentSchema = ComponentSchema> {
	(...values: ValuesArg<S>): Bundle<S>;
	readonly id: ComponentID;
	readonly [__schema]?: [S];
}

/**
 * Recover a def's schema type: `SchemaOf<typeof Pos>` is `{x:"f64", y:"f64"}`.
 * The typed `SystemContext` methods (§typestate) constrain their `def`
 * parameter to the system's declared-access union and use this to type the
 * field argument, in place of taking `ComponentDef<S>` directly.
 */
export type SchemaOf<D> = D extends ComponentDef<infer S extends ComponentSchema> ? S : never;

/**
 * `unknown` if `D` is one of the query's declared terms, else an error tuple —
 * the query-seam sibling of system.ts's `DeclaredRead` (§typestate,
 * POLISH_AUDIT #6). `Query.eachChunk`'s cursor and `ArchetypeView`'s column
 * accessors intersect this into their `def` parameter so fetching a component
 * that is NOT a term of the iterating query fails to compile (previously
 * caught only by the dev-mode access check, and only when the system's
 * declaration was itself wrong). Same encoding rules as the system asserts:
 * stable `D extends ComponentDef<any>` constraints keep instantiations
 * mutually assignable, and the conditional keys on the signature's own `D`.
 */
export type DeclaredQueryTerm<Defs extends readonly ComponentDef<any>[], D> = [D] extends [
	Defs[number]
]
	? unknown
	: ["component is not a term of this query — add it with .and(...)", D];

/** Options bag accepted by `registerComponent` / `registerSparseComponent`. */
export interface ComponentRegisterOptions {
	/** Debug label for diagnostics — errors then read `'Pos' (component 5)`
	 * instead of `component 5`. Never affects behaviour, layout, or hashing. */
	readonly name?: string;
}

/**
 * Schema-erased component handle — just the `.id`. Internal, schema-agnostic
 * code (access checks, dirty-set notes, field-id lookup) takes this instead of
 * `ComponentDef`: the callable signature makes `ComponentDef<S>` *invariant* in
 * `S` (a generic `ComponentDef<S>` is not assignable to `ComponentDef`), but
 * every `ComponentDef<S>` is assignable to `ComponentHandle` because it carries
 * `.id`. Use it wherever only the id is read.
 */
export type ComponentHandle = { readonly id: ComponentID };

// ── Callable bundles (§bundles) ───────────────────────────────────────────
// A `Bundle` pairs a component def with the values to write. A `BundleOrDef` is
// therefore `Bundle | ComponentDef` — both objects now (the def is a callable),
// so the runtime tells them apart with a `typeof === "function"` test (a bare
// callable def vs a plain `{def, values}` bundle object).

// Shared frozen empty — assignable to `Partial<FieldValues<S>>` for any S (the
// empty object type has no index signature, so it satisfies all-optional props).
const NO_VALUES = Object.freeze({});

/**
 * Mint a callable `ComponentDef` for a freshly-registered component id. The
 * returned function produces a `Bundle` when called (`Pos({x,y})`) and carries
 * its numeric id on a non-enumerable `.id` (invisible to spreads / `JSON`).
 * The single cast bridges the function value to the branded handle type — the
 * `.id` is installed at runtime by `defineProperty` (§10c branded-ID boundary).
 */
export function makeComponentDef<S extends ComponentSchema>(id: ComponentID): ComponentDef<S> {
	const def = ((values?: Partial<FieldValues<S>>): Bundle<S> => ({
		def,
		values: values ?? NO_VALUES
	})) as unknown as ComponentDef<S>;
	Object.defineProperty(def, "id", { value: id, enumerable: false });
	return def;
}

export interface Bundle<S extends ComponentSchema = ComponentSchema> {
	readonly def: ComponentDef<S>;
	// Partial, mirroring `TemplateEntry.values` — an omitted field zero-fills at
	// attach (`writeFields`'s `?? 0`), so a bundle need not carry every field.
	readonly values: Partial<FieldValues<S>>;
}

/** Either a populated bundle or a bare def (tag / all-fields-zero). */
export type BundleOrDef<S extends ComponentSchema = ComponentSchema> = Bundle<S> | ComponentDef<S>;

/** Pair a component def with field values to attach. Omitted fields zero-fill;
 * a tag def takes no values (see `ValuesArg`). */
export function bundle<S extends ComponentSchema>(
	def: ComponentDef<S>,
	...values: ValuesArg<S>
): Bundle<S> {
	return { def, values: (values as [Partial<FieldValues<S>>?])[0] ?? NO_VALUES };
}

/** Extract the def from a `BundleOrDef`. A bare def is the callable; a bundle a plain object. */
export function bundleDef(item: BundleOrDef): ComponentDef {
	return typeof item === "function" ? item : item.def;
}

/** Extract the values from a `BundleOrDef` (a bare def contributes no values). */
export function bundleValues(item: BundleOrDef): Readonly<Record<string, number>> {
	return typeof item === "function" ? NO_VALUES : (item.values as Readonly<Record<string, number>>);
}

/**
 * Compile-time readonly view of a typed array column. Blocks index writes at
 * the type layer.
 *
 * **Advisory, not a runtime barrier:** the value behind this type is the live
 * mutable backing `TypedArray` (`Archetype.getColumnRead` returns
 * `.buf as unknown as ReadonlyColumn`), so a §10c-policed cast can still write
 * through. For mutation use the mutable `Archetype.getColumn` (tick-bumping).
 * Enforced by the escape-hatch lint, not the runtime.
 */
export interface ReadonlyColumn {
	readonly [index: number]: number;
	readonly length: number;
}

/**
 * Compile-time readonly view of a Uint32Array. Blocks index writes at the type
 * layer. **Advisory, not a runtime barrier** — same caveat as `ReadonlyColumn`:
 * the underlying value is the live mutable buffer.
 */
export interface ReadonlyUint32Array {
	readonly [index: number]: number;
	readonly length: number;
}
