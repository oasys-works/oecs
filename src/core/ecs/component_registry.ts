/***
 * Component registration: the metadata a component id resolves to, and the
 * checks a registration has to pass.
 *
 * Free functions over a `ComponentMeta[]`, not a class. The store keeps the
 * array, because a flush loop, a spawn and the observer dispatch all hoist it
 * to a local and read it per row. A class here would put a second load in
 * front of every one of those hoists for no gain, so the array stays where it
 * is and only the code that fills it moves.
 *
 * The array's length is the next component id. The two are assigned together
 * and nothing else writes either, so a separate counter would be a second
 * source of truth for one number.
 *
 * The field-name checks live here rather than beside the dense registration
 * alone, because a sparse registration runs the same two. A sparse component
 * keeps its own id space and its own store, and it still refuses a reserved
 * name and a float column on a deterministic world.
 *
 * Cold path, every function. A world registers its components at setup, and
 * `componentLabel` runs inside a throw expression.
 *
 * This module names no tangled type, so it stays out of the type-only import
 * component that `src/__tests__/import_graph.test.ts` pins.
 ***/

import { ECSError, ECS_ERROR } from "./utils/error";
import { setComponentDebugName } from "./debug_names";
import { fieldGids, RESERVED_FIELD_NAMES } from "./ref";
import {
	asComponentId,
	createComponentDef,
	type ComponentDef,
	type ComponentHandle
} from "./component";
import type { ComponentMeta } from "./store_types";
import { STORE_DESCRIPTOR_COMPONENT_LIMIT } from "../store/descriptor";
import type { TypedArrayTag } from "../../type_primitives";

/**
 * Reject a field named like an accessor's own state (`__cols`, `__row`): a ref
 * or cursor over the component would shadow its own state with the field, or
 * the field with its state. `kind` names the storage class in the fault,
 * either "component" or "sparse component".
 *
 * Always on, not `__DEV__` gated. Registration is cold.
 */
export function assertFieldNamesFree(fieldNames: readonly string[], kind: string): void {
	for (let i = 0; i < fieldNames.length; i++) {
		if (RESERVED_FIELD_NAMES.includes(fieldNames[i])) {
			throw new ECSError(
				ECS_ERROR.FIELD_NOT_REGISTERED,
				`Cannot register ${kind} field "${fieldNames[i]}": the name is reserved for the ` +
					`state of a ref or cursor. Rename the field.`,
				{ field: fieldNames[i], kind }
			);
		}
	}
}

/**
 * Reject an `f32` or an `f64` field on a `deterministic: true` world, at
 * registration. IEEE-754 rounds differently across hosts in the last place. A
 * float column in a fixed-update path is then a silent per-tick `stateHash`
 * divergence between client and server, the one thing the determinism opt-in
 * exists to prevent.
 *
 * A world that did not opt in skips the walk and keeps its floats, so the
 * default path pays nothing. The array shorthand defaults to `f64` and lands
 * here too, so a deterministic world must pass an explicit integer type.
 */
export function assertDeterministicFieldTypes(
	deterministic: boolean,
	fieldNames: readonly string[],
	fieldTypes: readonly TypedArrayTag[],
	kind: string
): void {
	if (!deterministic) return;
	for (let i = 0; i < fieldTypes.length; i++) {
		const t = fieldTypes[i];
		if (t === "f32" || t === "f64") {
			throw new ECSError(
				ECS_ERROR.NON_DETERMINISTIC_COLUMN_TYPE,
				`Cannot register ${kind} field "${fieldNames[i]}" as "${t}" on a ` +
					`{ deterministic: true } world: floating-point columns round differently ` +
					`across V8 / Bun / Zig (1-ULP IEEE-754), breaking cross-host stateHash ` +
					`agreement. Use an integer type (e.g. "i32"), represent ` +
					`fractional quantities as fixed-point (Q16.16). Note the array shorthand ` +
					`defaults to "f64", so pass an explicit integer type there.`,
				{ field: fieldNames[i], type: t, kind }
			);
		}
	}
}

/**
 * Append one component's metadata to `metas` and return its definition.
 *
 * The caller guarantees that `metas` is the world's live metadata array and
 * that nothing else appends to it. The id this hands out is the array's length
 * before the append.
 *
 * The archetype descriptor in the backing carries a fixed-width component
 * mask, and the Zig side matches archetypes on that mask alone. A component id
 * past the mask's width would be invisible there, so two archetypes that
 * differ only in such a component would conflate. This fails instead, and the
 * fault names `registerSparseComponent` as the remedy, because a sparse
 * component keeps its own id space and costs no mask bit.
 *
 * A rejected registration leaves no partial state. Both checks run before the
 * id is taken and before the append.
 */
export function appendComponentMeta<S extends Record<string, TypedArrayTag>>(
	metas: ComponentMeta[],
	deterministic: boolean,
	schema: S,
	name?: string
): ComponentDef<S> {
	if (metas.length >= STORE_DESCRIPTOR_COMPONENT_LIMIT) {
		throw new ECSError(
			ECS_ERROR.COMPONENT_LIMIT_EXCEEDED,
			`registerComponent exceeds the dense component limit of ` +
				`${STORE_DESCRIPTOR_COMPONENT_LIMIT}, because the archetype descriptor mask is ` +
				`that many bits wide. Register this component with registerSparseComponent, ` +
				`which keeps its own id space and costs no mask bit.`,
			{ componentCount: metas.length, limit: STORE_DESCRIPTOR_COMPONENT_LIMIT }
		);
	}
	const fieldNames = Object.keys(schema);
	const fieldTypes: TypedArrayTag[] = new Array(fieldNames.length);
	const fieldIndex: Record<string, number> = Object.create(null);
	for (let i = 0; i < fieldNames.length; i++) {
		fieldIndex[fieldNames[i]] = i;
		fieldTypes[i] = schema[fieldNames[i]];
	}
	assertFieldNamesFree(fieldNames, "component");
	assertDeterministicFieldTypes(deterministic, fieldNames, fieldTypes, "component");
	const id = asComponentId(metas.length);
	metas.push({
		name,
		fieldNames,
		fieldIndex,
		fieldTypes,
		fieldGid: fieldGids(fieldNames, fieldTypes),
		obsAdd: false,
		obsRem: false,
		obsDisable: false,
		obsEnable: false,
		rowTicks: false,
		trackDirty: false,
		drainTick: 0,
		scanTick: 0,
		listCap: 0,
		lastDrainRun: 0
	});
	const def = createComponentDef<S>(id);
	if (name !== undefined) setComponentDebugName(def, name);
	return def;
}

/** `'Pos' (component 5)` when the component was registered with a debug name,
 * else `component 5`, the label diagnostics interpolate. */
export function componentMetaLabel(metas: readonly ComponentMeta[], cid: number): string {
	const name = metas[cid]?.name;
	return name !== undefined ? `'${name}' (component ${cid})` : `component ${cid}`;
}

/**
 * The field index assigned to `(def, fieldName)` at registration. Indexes are
 * insertion-order, zero-based, and stable for the lifetime of the world. A
 * system that passes `(component_id, field_id)` pairs across the WASM FFI
 * resolves them once, at setup.
 */
export function fieldIdOfMeta(
	metas: readonly ComponentMeta[],
	def: ComponentHandle,
	fieldName: string
): number {
	const cid = def.id;
	const meta = metas[cid];
	if (meta === undefined) {
		throw new ECSError(
			ECS_ERROR.COMPONENT_NOT_REGISTERED,
			`field_id_of: component ${cid} is not registered`
		);
	}
	const idx = meta.fieldIndex[fieldName];
	if (idx === undefined) {
		throw new ECSError(
			ECS_ERROR.FIELD_NOT_REGISTERED,
			`field_id_of: component ${cid} has no field "${fieldName}"`
		);
	}
	return idx;
}
