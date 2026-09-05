/**
 * `@oasys/oecs/solid`, the SolidJS plugin.
 *
 * `solid()` reads the store's change feed and writes Solid signals and stores
 * directly. Nothing sits between the store and Solid.
 */
export {
	solid,
	type ECSSolid,
	type RowReader,
	type SolidPlugin,
	type SolidComponentView,
	type SolidGrain,
	type SolidSingletonView,
	type SolidViewOptions
} from "./solid";
