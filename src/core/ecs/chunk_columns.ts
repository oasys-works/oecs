/***
 * The `forEachColumns` cursor.
 *
 * One instance per pass, re-pointed at each matched archetype. Its four
 * methods run once per archetype per pass, never per row, so the inner loop
 * of a chunk body pays nothing for them. `query.ts` and `changed_query.ts`
 * both allocate one, and each hands it to the chunk body of `forEachColumns`.
 *
 * The class is public API, so a field added here widens the shipped surface.
 ***/

import type { Archetype } from "./archetype";
import type {
	ColumnsForSchema,
	ComponentDef,
	DeclaredQueryTerm,
	MutableColumnsForSchema,
	SchemaOf
} from "./component";
import type { QueryResolver } from "./query_cache";
import { componentLabel } from "./debug_names";
import { ECSError, ECS_ERROR } from "./utils/error";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

/**
 * forEachColumns cursor. One instance is allocated per `forEachColumns`
 * pass and reused across every matched archetype in that pass. Only `arch` and
 * `tick` are re-pointed per archetype, so the inner loop allocates nothing.
 * Per-call (not cached on the query) so a nested `forEachColumns` on the same query
 * gets its own cursor and can't re-point an outer pass's position. `.mut(def)`
 * and `.read(def)` resolve a whole component's columns at once into a field-keyed
 * object (a per-archetype-per-component cache refreshed in place), hiding the
 * change tick. Destructure the group immediately. Don't retain it across calls.
 */
export class ChunkColumns<
	out Defs extends readonly ComponentDef<any>[] = readonly ComponentDef<any>[]
> {
	/** @internal */ arch!: Archetype;
	/** The change tick this pass stamps. Store it into a row of `ticks(def)`
	 * to record that row for an entity-level `onSet`. */
	tick = 0;
	/** The change tick of the previous run of the system this pass runs in,
	 * and 0 on its first run or on the host. A row of `ticksRead(def)` above it
	 * changed since that run. */
	since = 0;
	/** @internal */ resolver!: QueryResolver;

	/** Mutable column group, `const { x, y } = cols.mut(Pos)`. Stamps the tick.
	 * `def` must be a term of the iterating query. */
	public mut<D extends ComponentDef<any>>(
		def: D & DeclaredQueryTerm<Defs, D>
	): MutableColumnsForSchema<SchemaOf<D>> {
		return this.arch.columnGroupMut(def, this.tick);
	}

	/** Read-only column group, `const { vx, vy } = cols.read(Vel)`. No tick bump.
	 * `def` must be a term of the iterating query. */
	public read<D extends ComponentDef<any>>(
		def: D & DeclaredQueryTerm<Defs, D>
	): ColumnsForSchema<SchemaOf<D>> {
		return this.arch.columnGroupRead(def);
	}

	/** The row tick column of `def` for this archetype, the record a raw column
	 * loop makes for an entity-level `onSet`: `t[i] = cols.tick` beside the
	 * write of row `i`. One typed-array store per row, where `ctx.markChanged`
	 * is a call and a list push. Taking the column marks the archetype changed
	 * and asks the drain of this frame to scan every archetype of `def` that a
	 * writer stamped, so take it only in a loop that stores into it. Throws
	 * when no entity-level `onSet` observer tracks `def`, because the column
	 * exists for tracked components only. `def` must be a term of the
	 * iterating query. */
	public ticks<D extends ComponentDef<any>>(def: D & DeclaredQueryTerm<Defs, D>): Uint32Array {
		const arch = this.arch;
		const cid = def.id as number;
		const t = arch.rowTicks[cid];
		if (t === undefined) throw rowTicksNotTrackedError("cols.ticks", def, cid);
		if (DEV) accessCheck.assertWrite(def);
		arch.changedTick[cid] = this.tick;
		this.resolver.noteScan(cid);
		return t;
	}

	/** The row tick column of `def` for this archetype, read-only: the row
	 * grain of change detection. A row `i` with `t[i] > cols.since` changed
	 * since the previous run of this system, through any write path that
	 * records (`setField`, `ref`, a cursor, `markChanged`, or a store into
	 * `ticks(def)`). No stamp, no scan request. Throws when `def` has no row
	 * ticks: `ecs.trackRows(def)` turns them on. `def` must be a term of the
	 * iterating query. */
	public ticksRead<D extends ComponentDef<any>>(
		def: D & DeclaredQueryTerm<Defs, D>
	): Readonly<Uint32Array> {
		const arch = this.arch;
		const cid = def.id as number;
		const t = arch.rowTicks[cid];
		if (t === undefined) throw rowTicksNotTrackedError("cols.ticksRead", def, cid);
		if (DEV) accessCheck.assertRead(def);
		return t;
	}
}

function rowTicksNotTrackedError(op: string, def: ComponentDef<any>, cid: number): ECSError {
	return new ECSError(
		ECS_ERROR.ROW_TICKS_NOT_TRACKED,
		`${op}: ${componentLabel(def)} has no row ticks. Call ecs.trackRows(def), or register an onSet observer with granularity "entity", before the loop`,
		{ component: cid }
	);
}
