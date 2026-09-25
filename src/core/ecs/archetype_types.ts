/***
 * The archetype identity and the read-only row window, as types.
 *
 * A leaf. It imports the component and entity shapes and nothing else from the
 * world, so a module that needs the shape of an archetype does not reach for
 * `archetype.ts` and its class. `archetype.ts` re-exports both names, so a
 * caller outside the package sees no move.
 *
 * The split exists because these two names travel far. The change feed, the
 * observer seam and the plugin seam all describe an archetype without ever
 * building one. Naming `archetype.ts` from those files puts every one of them
 * in the same import component as the storage code, which blocks extracting any
 * of them. `src/__tests__/import_graph.test.ts` pins what is left.
 ***/

import type { Brand } from "../../type_primitives";
import type {
	ComponentID,
	ComponentDef,
	ComponentSchema,
	SchemaOf,
	DeclaredQueryTerm,
	ReadonlyColumn
} from "./component";
import type { ReadonlyEntityIDArray } from "./entity";

export type ArchetypeID = Brand<number, "archetype_id">;

/**
 * Public, read-only window onto an archetype's rows. This is the only
 * surface `Query.archetypes`, `Query.forEachArchetype`, and `ChangedQuery.forEachArchetype`
 * hand to callers, the concrete `Archetype` (with its structural mutators
 * `swapRemoveRow`, `moveEntityFrom`, `writeFields`, `setEdge`, and the
 * mutable `getColumnMut`) stays internal so query iteration can't bypass the
 * deferred-flush path that prevents iterator invalidation. This is the same
 * back door that is closed for `Store` and closed again for `Query`.
 *
 * `id` is the archetype's opaque identity (not a mutator), exposed so the
 * public `ECS.batchAddComponent` and `batchRemoveComponent` API can target an
 * archetype without the caller holding a concrete `Archetype` reference.
 */
export interface ArchetypeView<
	out Defs extends readonly ComponentDef<any>[] = readonly ComponentDef<any>[]
> {
	/** Opaque archetype identity. Pass to `ECS.batchAddComponent` and
	 * `ECS.batchRemoveComponent`. */
	readonly id: ArchetypeID;
	/** Number of **enabled** entities, the default-iteration bound. Rows
	 * `0..entityCount-1` are enabled. Disabled rows (if any) sit contiguously at
	 * `entityCount..totalCount-1`. `forEachArchetype` SoA loops read this, so they skip
	 * disabled rows for free. Use `totalCount` to span disabled rows too. */
	readonly entityCount: number;
	/** Total live rows, enabled + disabled. Equal to `entityCount` unless
	 * some rows are disabled. Use for full-state work (serialization, snapshot,
	 * determinism) that must see every entity regardless of enabled state. */
	readonly totalCount: number;
	/** Number of disabled rows = `totalCount - entityCount`. */
	readonly disabledCount: number;
	/** Raw entity ID buffer (packed `EntityID`s). Valid data at indices
	 * 0..totalCount-1 (enabled rows first, then disabled). */
	readonly entityIds: ReadonlyEntityIDArray;
	/** True if this archetype's mask includes the given component. */
	hasComponent(id: ComponentID): boolean;
	/** Get a single field's column (read-only). Valid data: indices
	 * 0..entityCount-1. `def` must be a term of the iterating query. The
	 * bare-`ArchetypeView` default stays permissive. */
	getColumnRead<D extends ComponentDef<any>, K extends string & keyof SchemaOf<D>>(
		def: D & DeclaredQueryTerm<Defs, D>,
		field: K
	): ReadonlyColumn;
	/** Tuple fetch of several of one component's columns,
	 * `const [q, r] = arch.getColumnsRead(HexPos, "q", "r")`. One small
	 * array allocation per call. See the class doc on `Archetype`. */
	getColumnsRead<
		D extends ComponentDef<any>,
		const K extends readonly (string & keyof SchemaOf<D>)[]
	>(
		def: D & DeclaredQueryTerm<Defs, D>,
		...fields: K
	): { [I in keyof K]: ReadonlyColumn };
	/** Get a single field's column **if this archetype has the component**,
	 * else `undefined`, the optional-query fetch-if-present accessor.
	 * The absent branch is expected (resolve the column pointer per archetype
	 * span: present ⇒ column, absent ⇒ `undefined`), not an error. Same
	 * advisory-readonly view and `reads`-access-check as `getColumnRead`. */
	getOptionalColumnRead<S extends ComponentSchema, K extends string & keyof S>(
		def: ComponentDef<S>,
		field: K
	): ReadonlyColumn | undefined;
}
