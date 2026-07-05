/**
 * Reactive kernel — the engine UI seam's fine-grained, glitch-free reactive core
 * (ADR-0021). Zero dependencies; consumer owns rendering. See docs/api/reactive.md.
 */
export {
	signal,
	computed,
	effect,
	batch,
	untrack,
	root,
	onCleanup,
	type Accessor,
	type Setter
} from "./kernel";
export { reactiveMap, type ReactiveMap } from "./map";
export { reactiveStruct, type StructSetters, type StructEq } from "./struct";
export { reactiveArray, type ReactiveArray } from "./array";
export { subscribe, toExternalStore, type ExternalStore } from "./interop";
