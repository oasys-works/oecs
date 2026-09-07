/***
 * `ChangedQuery`, the change-detection view over a `Query`.
 *
 * `Query.changed(...defs)` mints one and the query cache holds it. The
 * wrapper is thin: composition re-derives the underlying query and re-wraps,
 * and iteration filters each matched archetype on its per-component changed
 * tick before it calls the body.
 *
 * It reaches the underlying query through its published members only
 * (`nonEmptyArchs`, `lastRunTick`, `changeTick`, `resolver`, `terms`,
 * `includesDisabled`, `assertDenseOnly`), so the file adds no seam. It never
 * constructs a `Query`, which is why the import is type-only.
 ***/

import type { ArchetypeView } from "./archetype";
import { _setIterAllRows } from "./archetype";
import type { ComponentDef } from "./component";
import type { Query } from "./query";
import { ChunkColumns } from "./chunk_columns";
import { ECSError, ECS_ERROR } from "./utils/error";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

export class ChangedQuery<Defs extends readonly ComponentDef[]> {
	private readonly _query: Query<Defs>;
	private readonly _changedIds: number[];

	constructor(query: Query<Defs>, changedIds: number[]) {
		this._query = query;
		this._changedIds = changedIds;
		if (DEV) {
			for (let i = 0; i < changedIds.length; i++) {
				if (!query.include.has(changedIds[i])) {
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`changed() component ${changedIds[i]} is not in the query's include mask. Require it with and() before changed()`
					);
				}
			}
		}
	}

	// --- Composition, a ChangedQuery is a chainable filter, not a dead end.
	// Each verb refines the underlying query and re-wraps, so the dense mask and
	// query-cache identity are reused, because the base derive is cached. Only
	// the thin wrapper is freshly allocated. `_changedIds` carry through unchanged and
	// stay ⊆ the include mask (which only ever grows, via `and`), so the
	// constructor's dev guard always still holds. Same set result as refining
	// before `changed()`, `q.changed(P).not(D)` ≡ `q.not(D).changed(P)`,
	// but it no longer matters which order you write it.

	/** Also require these components (mirrors `Query.and`). */
	public and<D extends ComponentDef[]>(...comps: D): ChangedQuery<[...Defs, ...D]> {
		return new ChangedQuery(this._query.and(...comps), this._changedIds);
	}

	/** Exclude archetypes holding any of these (mirrors `Query.not`). */
	public not(...comps: ComponentDef[]): ChangedQuery<Defs> {
		return new ChangedQuery(this._query.not(...comps), this._changedIds);
	}

	/** Require at least one of these (mirrors `Query.or`). */
	public or(...comps: ComponentDef[]): ChangedQuery<Defs> {
		return new ChangedQuery(this._query.or(...comps), this._changedIds);
	}

	/** Permit optional-component data access in the loop (mirrors `Query.optional`). */
	public optional(...defs: ComponentDef[]): ChangedQuery<Defs> {
		return new ChangedQuery(this._query.optional(...defs), this._changedIds);
	}

	public forEach(cb: (arch: ArchetypeView<Defs>) => void): void {
		// Mirror Query.forEach's include-disabled handling: publish the
		// all-rows flag so the SoA loop's `arch.entityCount` spans disabled rows.
		// Cold branch split out to keep the flag dance off the inlined hot body.
		if (this._query.includesDisabled) {
			this._forEachIncludeDisabled(cb);
			return;
		}
		// Default path: inline `_forEachInner`'s body rather than delegate,
		// for the same reason as `Query.forEach`. This is a megamorphic call site
		// V8 will not inline through, so the delegate hop is a real per-call cost.
		// Keep byte-identical to `_forEachInner`. Do not re-introduce the hop.
		const lastTick = this._query.lastRunTick();
		const archs = this._query.nonEmptyArchs();
		const ids = this._changedIds;
		if (DEV) {
			// A changed-query loop is still iterating the underlying query, so it must
			// publish the same optional scope `Query.forEach` does, otherwise
			// `getOptionalColumnRead` falls into `assertOptionalFetch`'s lenient
			// no-scope branch and the `.optional(T)` gate never fires here.
			// Dev-only. Prod runs the bare loop below byte-for-byte.
			accessCheck.enterOptionalScope(this._query.terms.optionalTerms);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch.changedTick[ids[j]] > lastTick) {
							arch.iterDepth++;
							try {
								cb(arch);
							} finally {
								arch.iterDepth--;
							}
							break;
						}
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		for (let i = 0; i < archs.length; i++) {
			const arch = archs[i];
			for (let j = 0; j < ids.length; j++) {
				if (arch.changedTick[ids[j]] > lastTick) {
					cb(arch);
					break;
				}
			}
		}
	}

	/** The chunk form of `forEach`: the changed archetypes, as column groups.
	 * The row grain sits inside: `cols.ticksRead(def)` is the row tick column,
	 * and a row above `cols.since` changed since the previous run of the
	 * system. `def` needs row ticks (`ecs.trackRows`). Same include-disabled
	 * handling as `Query.forEachChunk`. */
	public forEachChunk(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		if (this._query.includesDisabled) {
			const prev = _setIterAllRows(true);
			try {
				this._forEachChunkInner(cb);
			} finally {
				_setIterAllRows(prev);
			}
			return;
		}
		this._forEachChunkInner(cb);
	}

	/** @internal, the body of `forEachChunk`: `Query._forEachChunkInner` with
	 * the change-tick filter of `forEach` in front of each archetype. */
	private _forEachChunkInner(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		const q = this._query;
		const view = new ChunkColumns<Defs>();
		view.tick = q.changeTick();
		view.since = q.lastRunTick();
		view.resolver = q.resolver();
		const lastTick = view.since;
		const archs = q.nonEmptyArchs();
		const ids = this._changedIds;
		if (DEV) {
			q.assertDenseOnly("changed().forEachChunk");
			accessCheck.enterOptionalScope(q.terms.optionalTerms);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch.changedTick[ids[j]] > lastTick) {
							view.arch = arch;
							arch.iterDepth++;
							try {
								cb(view, arch.entityCount);
							} finally {
								arch.iterDepth--;
							}
							break;
						}
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		for (let i = 0; i < archs.length; i++) {
			const arch = archs[i];
			for (let j = 0; j < ids.length; j++) {
				if (arch.changedTick[ids[j]] > lastTick) {
					view.arch = arch;
					cb(view, arch.entityCount);
					break;
				}
			}
		}
	}

	/** @internal, cold `includeDisabled` wrapper, split out of `forEach`
	 * so the all-rows flag dance stays out of the inlined hot body. */
	private _forEachIncludeDisabled(cb: (arch: ArchetypeView<Defs>) => void): void {
		const prev = _setIterAllRows(true);
		try {
			this._forEachInner(cb);
		} finally {
			_setIterAllRows(prev);
		}
	}

	/** @internal, the `includeDisabled` delegate for `forEach`. The
	 * default path inlines this body directly into `forEach` to dodge a
	 * megamorphic delegate hop. This copy survives only for the rare all-rows
	 * path, which needs the `_setIterAllRows` `finally` wrap. */
	private _forEachInner(cb: (arch: ArchetypeView<Defs>) => void): void {
		const lastTick = this._query.lastRunTick();
		const archs = this._query.nonEmptyArchs();
		const ids = this._changedIds;
		if (DEV) {
			// A changed-query loop is still iterating the underlying query, so it must
			// publish the same optional scope `Query.forEach` does, otherwise
			// `getOptionalColumnRead` falls into `assertOptionalFetch`'s lenient
			// no-scope branch and the `.optional(T)` gate never fires here.
			// Dev-only. Prod runs the bare loop below byte-for-byte.
			accessCheck.enterOptionalScope(this._query.terms.optionalTerms);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch.changedTick[ids[j]] > lastTick) {
							arch.iterDepth++;
							try {
								cb(arch);
							} finally {
								arch.iterDepth--;
							}
							break;
						}
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		for (let i = 0; i < archs.length; i++) {
			const arch = archs[i];
			for (let j = 0; j < ids.length; j++) {
				if (arch.changedTick[ids[j]] > lastTick) {
					cb(arch);
					break;
				}
			}
		}
	}
}
