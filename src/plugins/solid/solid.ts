/***
 * The solid plugin. ECS state into Solid signals.
 *
 * A view reads the store's change feed and writes Solid. Nothing sits between
 * them. The observers plugin is out of the path.
 *
 * A row is one Solid signal, made on the first `cell(id)` and kept. The first
 * design wrote a Solid store keyed by entity id, which gave a reader a nested
 * field read that tracked one field. A probe put that publish above the
 * signal-per-row publish at every density, so the store went. A signal per row
 * costs one setter call to publish and one node to track, and a reader tracks
 * the whole row rather than a field of it.
 *
 * Everything publishes at the settle point, the tail of `update()`. A
 * structural event arrives mid-tick and records an entity id into a per-view
 * pending set. Nothing reaches Solid inside the flush. At settle the whole
 * plugin publishes inside one Solid `batch`, so a tick is one Solid flush
 * whatever the number of views. An entity spawned and despawned in one tick
 * never appears, and a published value is the final value of the tick.
 *
 * What this module refuses. Dense components only: a sparse definition is a
 * number at run time, the wrong shape for a cursor and for the dense change
 * feed, so every entry point throws a `TypeError` on one. Joins are out of
 * scope: a view subscribes to one component, so a projection that reads a
 * second component goes stale, because no change of that second component
 * republishes the row. A projection that returns a function: a Solid setter
 * reads a function argument as an updater, and the publish passes the value
 * straight through to keep the path free of a per-row closure.
 *
 * A bare world reserves no `solid` slot. TypeScript refuses `ecs.solid` on a
 * world that did not install the plugin, and that is the whole guard.
 *
 * Hot path at settle. The readers, the cursor, the pending set and the value
 * map are built once for each view and reused, so the per-entity path allocates
 * nothing of its own. What a projection allocates is the caller's choice.
 ***/

import { batch, createSignal, type Accessor } from "solid-js";
import { createStore, type Store } from "solid-js/store";
import type {
	ArchetypeView,
	Plugin,
	PluginHost,
	ChangeFeed,
	ComponentDef,
	ComponentSchema,
	EntityID,
	ObservationFlags,
	ReadonlyColumn,
	ReadonlyComponentCursor,
	StructuralObserverEvents
} from "../../core/ecs";

/**
 * A read cursor over one entity's single-component state, handed to a
 * projection. `field` reads a column under the `"column"` grain, and it reads
 * by id through a cursor under the `"entity"` grain.
 *
 * The cursor is a reused mutable singleton, valid only during the synchronous
 * `project` call for the current row. Read what you need and return. A captured
 * reader reads the next row, because the next row mutates it in place.
 */
export interface RowReader<S extends ComponentSchema> {
	/** The entity of the row being projected. */
	readonly eid: EntityID;
	/** Read one field of the projected component, for the current row. */
	field<K extends string & keyof S>(name: K): number;
}

/** This plugin's key in the store's per-consumer observation records. It
 * is the plugin name, which is what keeps two consumers apart. */
const SOLID_CONSUMER = "solid";

/** Per-component grain of the set half of a view. */
export type SolidGrain = "entity" | "column";

/** The world surface this plugin adds. */
export interface SolidPlugin {
	readonly solid: ECSSolid;
}

/** One component projected into one Solid signal per entity. */
export interface SolidComponentView<V> {
	/** The row's live value, as one Solid signal. The first call for an id
	 * makes that signal, seeded with the value the view holds now, and every
	 * later call returns the same accessor. Bind it once for each row, in the
	 * row's own scope, and never inside a jsx expression that re-evaluates.
	 *
	 * `undefined` while the view does not hold the id. A cell outlives a
	 * delete, so the same accessor reports the row leaving and returning, and
	 * the view keeps every cell a caller ever asked for. */
	cell(id: EntityID): Accessor<V | undefined>;
	/** The live key set, for a keyed `<For each={view.keys()}>`. A new array
	 * only when membership changed. */
	readonly keys: Accessor<readonly EntityID[]>;
	dispose(): void;
}

export interface SolidViewOptions<V = unknown> {
	/** `"entity"` publishes the rows the by-id write paths recorded. `"column"`
	 * republishes every enabled row of an archetype whose column changed, and
	 * costs the write path nothing. Default `"entity"`. */
	grain?: SolidGrain;
	/** Publish the current enabled members at creation. Default `true`. */
	seedExisting?: boolean;
	/** Value equality for each cell, handed to Solid as the signal's `equals`.
	 * An equal publish wakes nobody. Default is Solid's own `===`, so a
	 * projection that returns a fresh object every tick wakes its reader every
	 * tick unless it passes one. `fields` supplies its own. */
	eq?: (a: V, b: V) => boolean;
}

/** One entity's fields, published into a Solid store with no key. */
export interface SolidSingletonView<V extends object> {
	readonly value: Store<V>;
	dispose(): void;
}

/** The `ecs.solid` facade. Each entry point returns a view and its disposer. */
export interface ECSSolid {
	/** Project one component into one signal per entity. `project` runs once
	 * per published entity, and the reader it receives is a reused singleton:
	 * read what you need and return, never capture it. The projected value must
	 * not be a function, which a Solid setter reads as an updater. */
	component<S extends ComponentSchema, V>(
		def: ComponentDef<S>,
		project: (row: RowReader<S>) => V,
		opts?: SolidViewOptions<V>
	): SolidComponentView<V>;
	/** Sugar over {@link component}: publish a fixed field list as a
	 * `{ field: value }` record, with an `eq` that compares those fields. A
	 * fresh record per published entity, so prefer a scalar projection for a
	 * high-churn component. */
	fields<S extends ComponentSchema, const F extends readonly (string & keyof S)[]>(
		def: ComponentDef<S>,
		fields: F,
		opts?: SolidViewOptions<{ [K in F[number]]: number }>
	): SolidComponentView<{ [K in F[number]]: number }>;
	/** Publish one entity's fields into a keyless Solid store. A remove or a
	 * disable of that entity resets the fields to the values the store held at
	 * creation.
	 *
	 * A store, and not a signal per field: one entity carries a fixed key set,
	 * a publish writes only the fields that moved, and a reader tracks the
	 * field it reads. None of that sits on the per-entity path. */
	singleton<S extends ComponentSchema, const F extends readonly (string & keyof S)[]>(
		def: ComponentDef<S>,
		eid: EntityID,
		fields: F,
		opts?: { seedExisting?: boolean }
	): SolidSingletonView<{ [K in F[number]]: number }>;
}

/** What the plugin drives at the settle point, and what it merges flags
 * over. A component view and a singleton view both answer this. */
interface InstalledView {
	readonly cid: number;
	/** True when this view needs the row grain, which turns on the row tick
	 * plane and the dirty list of its component. */
	readonly wantsSet: boolean;
	/** Entity ids the structural hook recorded this tick, resolved and cleared
	 * at settle. */
	readonly pending: Set<EntityID>;
	publish(run: number): void;
}

/**
 * Reader over one entity, backed by a read-only cursor the view holds. `at`
 * re-resolves the archetype and the row, so a field read is a property read on
 * the cursor. One instance for each view, reused by mutable fields.
 */
class CursorRowReader<S extends ComponentSchema> implements RowReader<S> {
	public eid: EntityID = 0 as EntityID;
	private readonly _cols: Readonly<Record<string, number>>;
	constructor(cursor: ReadonlyComponentCursor<S>) {
		this._cols = cursor as unknown as Readonly<Record<string, number>>;
	}
	field<K extends string & keyof S>(name: K): number {
		return this._cols[name];
	}
}

/**
 * Reader over one archetype's columns, the column grain's row sweep. `bind`
 * drops the previous column cache, so a field read after the first row of an
 * archetype is a map lookup and an array index.
 */
class ColumnRowReader<S extends ComponentSchema> implements RowReader<S> {
	public eid: EntityID = 0 as EntityID;
	public row = 0;
	private readonly _cols = new Map<string, ReadonlyColumn>();
	private _arch!: ArchetypeView;
	private readonly _def: ComponentDef<S>;
	constructor(def: ComponentDef<S>) {
		this._def = def;
	}
	bind(arch: ArchetypeView): void {
		this._arch = arch;
		this._cols.clear();
	}
	field<K extends string & keyof S>(name: K): number {
		let col = this._cols.get(name);
		if (col === undefined) {
			col = this._arch.getColumnRead(this._def, name);
			this._cols.set(name, col);
		}
		return col[this.row];
	}
}

/** The component id of a dense definition, or a fault naming the call.
 *
 * A sparse definition is a number at run time and a dense one is a callable
 * carrying `id`. The types keep them apart and the runtime cannot, so an
 * untyped call site reaches this. */
function denseCid(def: unknown, api: string): number {
	const id = (def as { id?: unknown } | null | undefined)?.id;
	if (typeof id !== "number") {
		throw new TypeError(
			`${api}: the definition is not a dense component, got ${String(def)}. Pass a dense component definition`
		);
	}
	return id;
}

class ComponentView<S extends ComponentSchema, V> implements InstalledView, SolidComponentView<V> {
	public readonly keys: Accessor<readonly EntityID[]>;
	public readonly pending = new Set<EntityID>();
	public readonly cid: number;
	public readonly wantsSet: boolean;

	private readonly _owner: SolidViews;
	private readonly _changes: ChangeFeed;
	private readonly _def: ComponentDef<S>;
	private readonly _project: (row: RowReader<S>) => V;
	private readonly _cursor: ReadonlyComponentCursor<S>;
	private readonly _entityReader: CursorRowReader<S>;
	private readonly _columnReader: ColumnRowReader<S> | null;
	private readonly _setKeys: (value: readonly EntityID[]) => void;
	/** What the view holds now, and the seed of a cell made later. The key set
	 * is derived from it, so a publish or a delete that changes its size marks
	 * the key signal dirty. */
	private readonly _values = new Map<EntityID, V>();
	/** The cells a caller asked for. Two maps rather than one of pairs, so the
	 * publish takes one lookup and the accessor lookup stays off that path. */
	private readonly _cellGet = new Map<EntityID, Accessor<V | undefined>>();
	private readonly _cellSet = new Map<EntityID, (value: V | undefined) => void>();
	private readonly _equals: ((a: V | undefined, b: V | undefined) => boolean) | undefined;
	private _keysDirty = false;
	private _baseline: number;
	private _disposed = false;

	constructor(
		owner: SolidViews,
		host: PluginHost,
		cid: number,
		def: ComponentDef<S>,
		project: (row: RowReader<S>) => V,
		grain: SolidGrain,
		eq: ((a: V, b: V) => boolean) | undefined
	) {
		this._owner = owner;
		this._changes = host.changes;
		this.cid = cid;
		this._def = def;
		this._project = project;
		this.wantsSet = grain === "entity";
		this._cursor = host.world.cursorRead(def);
		this._entityReader = new CursorRowReader<S>(this._cursor);
		this._columnReader = grain === "column" ? new ColumnRowReader<S>(def) : null;
		// A cell also holds `undefined`, which the caller's `eq` never sees. The
		// identity compare in front answers the absent-to-absent case and leaves
		// `eq` the two-value case it was written for. Built once for the view.
		this._equals =
			eq === undefined
				? undefined
				: (a, b) => a === b || (a !== undefined && b !== undefined && eq(a, b));
		// Everything the seed publishes is current, so the column grain starts
		// above every stamp the plane already holds. A baseline of zero would
		// republish each archetype the world ever touched at the first settle.
		this._baseline = host.store.changeTick;
		const [keys, setKeys] = createSignal<readonly EntityID[]>([]);
		this.keys = keys;
		this._setKeys = setKeys as unknown as (value: readonly EntityID[]) => void;
	}

	cell(id: EntityID): Accessor<V | undefined> {
		let get = this._cellGet.get(id);
		if (get === undefined) {
			const seed = this._values.get(id);
			// The options object goes in only with an `eq` in it. Solid merges the
			// argument over its own defaults, so `{ equals: undefined }` would drop
			// the identity compare instead of asking for it.
			const [read, write] =
				this._equals === undefined
					? createSignal<V | undefined>(seed)
					: createSignal<V | undefined>(seed, { equals: this._equals });
			get = read;
			this._cellGet.set(id, read);
			// A Solid setter reads a function argument as an updater, so the cast
			// states what the module refuses: a projection that returns a function.
			this._cellSet.set(id, write as unknown as (value: V | undefined) => void);
		}
		return get;
	}

	/** Publish every current enabled member. Cold path, and the caller wraps it
	 * in a `batch`. */
	seed(): void {
		const eids = this._changes.collectEnabledWith(this.cid);
		for (let i = 0; i < eids.length; i++) this._publishOne(eids[i]);
		this._flushKeys();
	}

	publish(run: number): void {
		if (this._columnReader !== null) {
			this._changes.forEachChangedArchetype(this.cid, this._baseline, this._onArchetype);
			// A stamp equal to `run` came from this pass, so the next one leaves it
			// alone. A host write between frames stamps above `run` and is reported.
			this._baseline = run;
		} else {
			const res = this._changes.drainSet(this.cid, run);
			// A scanned row sits inside the enabled partition of a live archetype,
			// so it is alive, a member and enabled by construction.
			const scanned = res.scanned;
			for (let i = 0; i < scanned.length; i++) this._publishOne(scanned[i]);
			const listed = res.listed;
			for (let i = 0; i < listed.length; i++) {
				const eid = listed[i];
				if (this._isPublishable(eid)) this._publishOne(eid);
			}
		}
		if (this.pending.size !== 0) {
			this.pending.forEach(this._resolvePending);
			this.pending.clear();
		}
		this._flushKeys();
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._owner._remove(this);
	}

	/** One archetype of the column grain. Bound once, so the sweep allocates no
	 * closure per tick. */
	private readonly _onArchetype = (arch: ArchetypeView): void => {
		const reader = this._columnReader!;
		reader.bind(arch);
		const eids = arch.entityIds;
		const n = arch.entityCount;
		for (let i = 0; i < n; i++) {
			reader.row = i;
			const eid = eids[i] as EntityID;
			reader.eid = eid;
			this._writeRow(eid, this._project(reader));
		}
	};

	/** One entity the structural hook recorded. Bound once, for the same
	 * reason as `_onArchetype`. */
	private readonly _resolvePending = (eid: EntityID): void => {
		if (this._isPublishable(eid)) this._publishOne(eid);
		else this._deleteOne(eid);
	};

	private _isPublishable(eid: EntityID): boolean {
		const changes = this._changes;
		return changes.isAlive(eid) && changes.hasComponent(eid, this._def) && !changes.isDisabled(eid);
	}

	private _publishOne(eid: EntityID): void {
		this._cursor.at(eid);
		this._entityReader.eid = eid;
		this._writeRow(eid, this._project(this._entityReader));
	}

	private _writeRow(eid: EntityID, value: V): void {
		// One hash, not two. A `set` that grew the map added a key, which is the
		// membership change the key signal reports.
		const before = this._values.size;
		this._values.set(eid, value);
		if (this._values.size !== before) this._keysDirty = true;
		const set = this._cellSet.get(eid);
		if (set !== undefined) set(value);
	}

	/** Drop the row. A row the view never held writes nothing, so a spawn and a
	 * despawn inside one tick leave Solid untouched. */
	private _deleteOne(eid: EntityID): void {
		if (!this._values.delete(eid)) return;
		this._keysDirty = true;
		const set = this._cellSet.get(eid);
		if (set !== undefined) set(undefined);
	}

	private _flushKeys(): void {
		if (!this._keysDirty) return;
		this._keysDirty = false;
		this._setKeys(Array.from(this._values.keys()));
	}
}

class SingletonView<S extends ComponentSchema, V extends object>
	implements InstalledView, SolidSingletonView<V>
{
	public readonly value: Store<V>;
	public readonly pending = new Set<EntityID>();
	public readonly cid: number;
	public readonly wantsSet = true;

	private readonly _owner: SolidViews;
	private readonly _changes: ChangeFeed;
	private readonly _def: ComponentDef<S>;
	private readonly _eid: EntityID;
	private readonly _fields: readonly string[];
	/** The values the store held at creation, the reset target of a remove and
	 * of a disable. A Solid store has no row to delete here, so the channel
	 * states its empty value instead of a blind zero. */
	private readonly _defaults: readonly number[];
	private readonly _cursor: ReadonlyComponentCursor<S>;
	private readonly _cols: Readonly<Record<string, number>>;
	private readonly _write: (field: string, value: number) => void;
	private _disposed = false;

	constructor(
		owner: SolidViews,
		host: PluginHost,
		cid: number,
		def: ComponentDef<S>,
		eid: EntityID,
		fields: readonly string[]
	) {
		this._owner = owner;
		this._changes = host.changes;
		this.cid = cid;
		this._def = def;
		this._eid = eid;
		this._fields = fields;
		this._cursor = host.world.cursorRead(def);
		this._cols = this._cursor as unknown as Readonly<Record<string, number>>;
		const initial: Record<string, number> = {};
		for (let i = 0; i < fields.length; i++) initial[fields[i]] = 0;
		const [value, setValue] = createStore<V>(initial as V);
		this.value = value;
		this._write = setValue as unknown as (field: string, next: number) => void;
		const defaults: number[] = [];
		for (let i = 0; i < fields.length; i++) defaults.push(initial[fields[i]]);
		this._defaults = defaults;
	}

	/** Publish the target's current fields, when it is there to read. Cold
	 * path, and the caller wraps it in a `batch`. */
	seed(): void {
		if (this._isPublishable()) this._publish();
	}

	publish(run: number): void {
		const res = this._changes.drainSet(this.cid, run);
		const scanned = res.scanned;
		let hit = false;
		for (let i = 0; i < scanned.length; i++) if (scanned[i] === this._eid) hit = true;
		if (!hit) {
			const listed = res.listed;
			for (let i = 0; i < listed.length; i++) {
				if (listed[i] === this._eid && this._isPublishable()) hit = true;
			}
		}
		if (hit) this._publish();
		if (this.pending.size !== 0) {
			if (this.pending.has(this._eid)) {
				if (this._isPublishable()) this._publish();
				else this._reset();
			}
			this.pending.clear();
		}
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._owner._remove(this);
	}

	private _isPublishable(): boolean {
		const changes = this._changes;
		const eid = this._eid;
		return changes.isAlive(eid) && changes.hasComponent(eid, this._def) && !changes.isDisabled(eid);
	}

	private _publish(): void {
		this._cursor.at(this._eid);
		const fields = this._fields;
		for (let i = 0; i < fields.length; i++) this._write(fields[i], this._cols[fields[i]]);
	}

	private _reset(): void {
		const fields = this._fields;
		for (let i = 0; i < fields.length; i++) this._write(fields[i], this._defaults[i]);
	}
}

/** The service behind `ecs.solid`. It owns the live views, the merged
 * observation ask of each component, and the one settle hook of the
 * plugin. */
class SolidViews implements ECSSolid {
	private readonly _host: PluginHost;
	private readonly _views: InstalledView[] = [];
	private readonly _byCid = new Map<number, InstalledView[]>();

	constructor(host: PluginHost) {
		this._host = host;
		host.changes.addStructuralHook(this._onStructural);
		host.onSettle(this._onSettle);
	}

	component<S extends ComponentSchema, V>(
		def: ComponentDef<S>,
		project: (row: RowReader<S>) => V,
		opts: SolidViewOptions<V> = {}
	): SolidComponentView<V> {
		const cid = denseCid(def, "solid.component");
		const view = new ComponentView<S, V>(
			this,
			this._host,
			cid,
			def,
			project,
			opts.grain ?? "entity",
			opts.eq
		);
		this._add(view);
		if (opts.seedExisting ?? true) batch(() => view.seed());
		return view;
	}

	fields<S extends ComponentSchema, const F extends readonly (string & keyof S)[]>(
		def: ComponentDef<S>,
		fields: F,
		opts: SolidViewOptions<{ [K in F[number]]: number }> = {}
	): SolidComponentView<{ [K in F[number]]: number }> {
		type V = { [K in F[number]]: number };
		// One fresh record per published entity. Named in the doc comment, so a
		// caller on a high-churn component reaches for a scalar projection.
		const project = (row: RowReader<S>): V => {
			const out: Record<string, number> = {};
			for (let i = 0; i < fields.length; i++) out[fields[i]] = row.field(fields[i]);
			return out as V;
		};
		// The listed fields, compared by name. A fresh record per publish would
		// wake every reader every tick under Solid's `===`, and a key walk would
		// pay for names this list already holds.
		const eq =
			opts.eq ??
			((a: V, b: V): boolean => {
				const x = a as Record<string, number>;
				const y = b as Record<string, number>;
				for (let i = 0; i < fields.length; i++) if (x[fields[i]] !== y[fields[i]]) return false;
				return true;
			});
		const cid = denseCid(def, "solid.fields");
		const view = new ComponentView<S, V>(
			this,
			this._host,
			cid,
			def,
			project,
			opts.grain ?? "entity",
			eq
		);
		this._add(view);
		if (opts.seedExisting ?? true) batch(() => view.seed());
		return view;
	}

	singleton<S extends ComponentSchema, const F extends readonly (string & keyof S)[]>(
		def: ComponentDef<S>,
		eid: EntityID,
		fields: F,
		opts: { seedExisting?: boolean } = {}
	): SolidSingletonView<{ [K in F[number]]: number }> {
		type V = { [K in F[number]]: number };
		const cid = denseCid(def, "solid.singleton");
		const view = new SingletonView<S, V>(this, this._host, cid, def, eid, fields);
		this._add(view);
		if (opts.seedExisting ?? true) batch(() => view.seed());
		return view;
	}

	/** Drop a view and recompute its component's ask. Idempotent through the
	 * view's own disposed flag. */
	_remove(view: InstalledView): void {
		const i = this._views.indexOf(view);
		if (i >= 0) this._views.splice(i, 1);
		const bucket = this._byCid.get(view.cid);
		if (bucket !== undefined) {
			const j = bucket.indexOf(view);
			if (j >= 0) bucket.splice(j, 1);
			if (bucket.length === 0) this._byCid.delete(view.cid);
		}
		this._reconfigure(view.cid);
	}

	private _add(view: InstalledView): void {
		this._views.push(view);
		let bucket = this._byCid.get(view.cid);
		if (bucket === undefined) {
			bucket = [];
			this._byCid.set(view.cid, bucket);
		}
		bucket.push(view);
		this._reconfigure(view.cid);
	}

	/** The OR of every live view's ask for `cid`. All-false on the last
	 * dispose, which is the same as never asking. Cold path. */
	private _reconfigure(cid: number): void {
		const bucket = this._byCid.get(cid);
		let live = false;
		let set = false;
		if (bucket !== undefined) {
			for (let i = 0; i < bucket.length; i++) {
				live = true;
				if (bucket[i].wantsSet) set = true;
			}
		}
		const flags: ObservationFlags = {
			add: live,
			remove: live,
			disable: live,
			enable: live,
			set
		};
		this._host.changes.configureObservation(SOLID_CONSUMER, cid, flags);
	}

	/** Record the round's structural events, and write nothing. A view resolves
	 * them at settle, so an entity that arrives and leaves inside one tick
	 * never reaches Solid. */
	private readonly _onStructural = (ev: StructuralObserverEvents): void => {
		if (this._views.length === 0) return;
		this._record(ev.addComp, ev.addEid, ev.addLen);
		this._record(ev.remComp, ev.remEid, ev.remLen);
		this._record(ev.disComp, ev.disEid, ev.disLen);
		this._record(ev.enaComp, ev.enaEid, ev.enaLen);
	};

	private _record(comps: number[], eids: number[], len: number): void {
		for (let i = 0; i < len; i++) {
			const bucket = this._byCid.get(comps[i]);
			if (bucket === undefined) continue;
			const eid = eids[i] as EntityID;
			for (let v = 0; v < bucket.length; v++) bucket[v].pending.add(eid);
		}
	}

	/** The run tick of the settle in progress. It reaches `_publishAll` through
	 * a field so the batched body can be bound once. */
	private _run = 0;

	private readonly _publishAll = (): void => {
		const views = this._views;
		const run = this._run;
		for (let i = 0; i < views.length; i++) views[i].publish(run);
	};

	/** One Solid flush for the whole plugin, whatever the number of views.
	 * A world with no view calls `batch` never. */
	private readonly _onSettle = (run: number): void => {
		if (this._views.length === 0) return;
		this._run = run;
		batch(this._publishAll);
	};
}

/**
 * The solid plugin, for `ECS.create({ plugins: [solid()] })`. It requires
 * no other plugin, and observers are not involved.
 *
 * A world that installs it carries `ecs.solid`. A world that does not carries
 * no member of that name, so `ecs.solid` is a compile error rather than a
 * fault at run time. There is no reserved slot to name the missing import.
 */
export function solid(): Plugin<SolidPlugin> {
	return {
		name: "solid",
		requires: [],
		install(host: PluginHost): SolidPlugin {
			return { solid: new SolidViews(host) };
		}
	};
}
