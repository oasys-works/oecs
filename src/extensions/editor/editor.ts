/**
 * editor — the host write seam's EDITOR layer, layer 2 of the seam.
 *
 * Reified undo/redo built on the shipped typed `HostCommandQueue`. Each
 * editor action becomes a TRANSACTION carrying its `forward` commands and their
 * `inverse` — both plain `HostCommand` data on the ONE bus. `undo()`/`redo()`
 * enqueue the inverse/forward like any other write, so they apply at the next
 * schedule head through the same `applyHostCommand` dispatch — undo is **just
 * another command**, never a direct mutation. That is the whole point: an editor
 * gets structural safety + coalescing for free because it never leaves the bus.
 *
 * Lives in `engine-extensions`, NOT engine core: undo/redo is application policy,
 * and core has nothing to gain from it (the design doc's explicit call). The only
 * dependency is `../../core/ecs` — no reactive kernel, no UI framework
 * (the field-handle reads through a caller-supplied thunk; see `field_handle.ts`).
 *
 * Two findings the original write-seam prototype surfaced (now removed — this
 * layer supersedes it), both folded in:
 *
 *   1. **Spawn-undo needs the apply-time id.** A spawn's inverse is "despawn the
 *      created entity," but the id only exists after the deferred create flushes.
 *      So the spawn transaction records an empty inverse slot and finalizes it in
 *      the `onSpawned` callback the apply system fires (`HostCommand.onSpawned`).
 *      The finalizer re-fires on every redo, so the inverse always tracks the
 *      CURRENT id (a redo re-spawns under a new id). The symmetric trick covers
 *      despawn-redo: the inverse respawn rewrites the forward despawn's target so
 *      `despawn → undo(respawn) → redo(despawn)` removes the RESPAWNED entity, not
 *      the dead original. Identity is not preserved across despawn/undo — the data
 *      round-trips, the id does not (a real editor remaps references on top).
 *
 *   2. **`setField` inverses need a tiny editor-side shadow.** When several edits
 *      stack before a tick commits, each set's inverse must be the value that set
 *      REPLACED, not the last committed value. A per-`(entity, component, field)`
 *      shadow, seeded from the read channel (`FieldReader`), gets this right; undo
 *      and redo keep it in step.
 *
 * See `docs/api/editor.md`.
 */
import type {
	ComponentDef,
	ComponentHandle,
	ComponentSchema,
	EntityID,
	CompleteFieldValues,
	HostCommand,
	HostCommandQueue,
	SpawnEntry,
	SpawnEntries
} from "../../core/ecs";

/**
 * Reads the committed value of one `(entity, component, field)` slot — the editor
 * uses it to seed a `setField` inverse with the value the edit replaced. Wire it
 * to the reactive read channel (e.g. a `reactiveMap`/`reactiveStruct` projection)
 * or to `ecs.getField`; `undefined` for an unknown slot falls back to `0`.
 */
export type FieldReader = (entityId: EntityID, def: ComponentDef, field: string) => number | undefined;

/**
 * A reified, undoable unit of editor work: the `forward` commands and their
 * `inverse`, both plain `HostCommand` data on the one bus. The arrays are mutable
 * internally (the spawn/despawn id finalizers patch a slot at apply time) but the
 * type handed back from {@link Editor.transaction} is read-only.
 */
export interface EditorTransaction {
	readonly forward: readonly HostCommand[];
	readonly inverse: readonly HostCommand[];
}

/** Internal, mutable transaction the id-finalizers patch in place. */
interface MutableTxn {
	forward: HostCommand[];
	inverse: HostCommand[];
}

/** `(entity, component, field)` → string key for the setField shadow. */
function fieldKey(entityId: EntityID, def: ComponentHandle, field: string): string {
	return `${entityId}:${def.id}:${field}`;
}

/** Builder → in-flight transaction. Module-scoped so the mutable escape hatch
 * never appears on the published `TransactionBuilder` type. */
const txns = new WeakMap<TransactionBuilder, MutableTxn>();

/**
 * Accumulates the `forward`/`inverse` commands for ONE transaction. Each method
 * appends a forward command and its inverse, computing the inverse from the
 * shadow / read channel where needed. Spawn and despawn install id-finalizers
 * (via `HostCommand.onSpawned`) that patch the apply-time id into the right slot.
 *
 * Obtained from {@link Editor.transaction}; not constructed directly.
 */
export class TransactionBuilder {
	/** Values staged by THIS build, layered over the editor's shared shadow. Kept
	 * transaction-local so an aborted build (the callback throws before commit)
	 * leaves the shared shadow untouched — a phantom staged value would poison
	 * `pendingField` and seed the NEXT edit's inverse with a value the world never
	 * held. The one merge point into the shared shadow is commit's `applyShadow`. */
	private readonly staged = new Map<string, number>();

	/** @internal */
	constructor(
		private readonly readField: FieldReader,
		private readonly shadow: Map<string, number>
	) {
		txns.set(this, { forward: [], inverse: [] });
	}

	private get _txn(): MutableTxn {
		return txns.get(this)!;
	}

	/**
	 * Spawn an entity carrying `components`. Inverse: despawn the created entity,
	 * finalized once the spawn applies (the id only exists post-flush). `onSpawned`
	 * also forwards the new id to the caller. The finalizer re-fires on redo, so the
	 * inverse tracks the current id.
	 */
	spawn<Defs extends readonly ComponentDef[]>(
		components: SpawnEntries<Defs>,
		onSpawned?: (entityId: EntityID) => void
	): this;
	spawn(components: readonly SpawnEntry[], onSpawned?: (entityId: EntityID) => void): this {
		// One STABLE inverse object whose `eid` the finalizer MUTATES in place, rather
		// than replacing the slot with a fresh object. `undo()` enqueues this object by
		// reference, and `applyHostCommand` reads `eid` at apply time — so a second
		// undo/redo issued before `ecs.update()` (more than one per frame) still
		// resolves to the live id: the paired respawn's `onSpawned` runs earlier in
		// the same drain and updates this `eid` before the despawn applies. Replacing
		// the slot instead left an already-enqueued despawn pointing at the dead
		// original → `ENTITY_NOT_ALIVE` / leaked entity.
		const inverseDespawn: { kind: "despawn"; eid: EntityID } = {
			kind: "despawn",
			eid: 0 as EntityID
		};
		this._txn.inverse.push(inverseDespawn);
		this._txn.forward.push({
			kind: "spawn",
			components,
			onSpawned: (entityId) => {
				inverseDespawn.eid = entityId;
				onSpawned?.(entityId);
			}
		});
		return this;
	}

	/**
	 * Despawn `entityId`. Inverse: respawn from `restore` (the components+values to
	 * recreate — read them from the channel before despawning). Undo respawns the
	 * DATA, not the identity: the new entity gets a fresh id, and the respawn's
	 * `onSpawned` rewrites this despawn's target so redo removes the respawned
	 * entity rather than the dead original.
	 */
	despawn<Defs extends readonly ComponentDef[]>(entityId: EntityID, restore: SpawnEntries<Defs>): this;
	despawn(entityId: EntityID, restore: readonly SpawnEntry[]): this {
		// Symmetric with `spawn`: one STABLE forward despawn whose `eid` the respawn's
		// `onSpawned` mutates in place, so a redo enqueued before the respawn applies
		// still despawns the RESPAWNED entity (resolved at apply time), not the dead
		// original.
		const forwardDespawn: { kind: "despawn"; eid: EntityID } = { kind: "despawn", eid: entityId };
		this._txn.forward.push(forwardDespawn);
		this._txn.inverse.push({
			kind: "spawn",
			components: restore,
			onSpawned: (newEntityId) => {
				forwardDespawn.eid = newEntityId;
			}
		});
		return this;
	}

	/**
	 * Set `field` of `def` on `entityId` to `value`. Inverse: set it back to the value
	 * this edit replaced — read from the staged overlay / shadow (so stacked edits,
	 * within one build or before a commit, invert correctly) or, failing that, the
	 * read channel (`0` if unknown).
	 */
	setField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		value: number
	): this {
		const key = fieldKey(entityId, def, field);
		const old =
			this.staged.get(key) ??
			this.shadow.get(key) ??
			this.readField(entityId, def as ComponentDef, field) ??
			0;
		this.staged.set(key, value);
		this._txn.forward.push({ kind: "set_field", eid: entityId, def: def as ComponentDef, field, value });
		this._txn.inverse.push({ kind: "set_field", eid: entityId, def: def as ComponentDef, field, value: old });
		return this;
	}

	/** Attach `def` (with complete `values`) to `entityId`. Inverse: remove it.
	 * Bare `add` — the namespaced-handle grammar (matches `ctx.commands.add` and
	 * the queue's `add`), not `addComponent`. */
	add<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): this {
		this._txn.forward.push({ kind: "add_component", eid: entityId, def: def as ComponentDef, values });
		this._txn.inverse.push({ kind: "remove_component", eid: entityId, def: def as ComponentDef });
		return this;
	}

	/**
	 * Detach `def` from `entityId`. Inverse: re-add it from `restore` (the field values
	 * to recreate — read them from the channel before removing). Bare `remove` — see `add`.
	 */
	remove<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		restore: CompleteFieldValues<S>
	): this {
		this._txn.forward.push({ kind: "remove_component", eid: entityId, def: def as ComponentDef });
		this._txn.inverse.push({
			kind: "add_component",
			eid: entityId,
			def: def as ComponentDef,
			values: restore
		});
		return this;
	}

	/** Disable `entityId`. Inverse: enable it. */
	disable(entityId: EntityID): this {
		this._txn.forward.push({ kind: "disable", eid: entityId });
		this._txn.inverse.push({ kind: "enable", eid: entityId });
		return this;
	}

	/** Enable `entityId`. Inverse: disable it. */
	enable(entityId: EntityID): this {
		this._txn.forward.push({ kind: "enable", eid: entityId });
		this._txn.inverse.push({ kind: "disable", eid: entityId });
		return this;
	}
}

/**
 * The editor's undo/redo manager over a {@link HostCommandQueue}. Each action is a
 * reified {@link EditorTransaction} pushed onto the undo stack; `undo()`/`redo()`
 * enqueue its inverse/forward on the SAME bus. The single-action methods
 * (`spawn`, `setField`, …) are sugar for one-command transactions; `transaction`
 * groups several into one undo entry.
 *
 * Construct with the queue and a {@link FieldReader} for the committed read
 * channel (used to seed `setField` inverses).
 */
export class Editor {
	private readonly undoStack: MutableTxn[] = [];
	private readonly redoStack: MutableTxn[] = [];
	/** onChange subscribers — see {@link onChange}. */
	private readonly listeners: (() => void)[] = [];
	/** Per-`(entity, component, field)` shadow of edited values, for inverse correctness. */
	private readonly shadow = new Map<string, number>();

	constructor(
		private readonly queue: HostCommandQueue,
		private readonly readField: FieldReader
	) {}

	/**
	 * Group several actions into ONE undo entry. Build them on the passed
	 * {@link TransactionBuilder}; the whole group commits (enqueues its forward
	 * commands) and lands on the undo stack atomically, clearing the redo stack.
	 */
	transaction(build: (tx: TransactionBuilder) => void): EditorTransaction {
		const builder = new TransactionBuilder(this.readField, this.shadow);
		build(builder);
		return this.commit(txns.get(builder)!);
	}

	/** Spawn `components` as its own undo entry. `onSpawned` reports the new id. */
	spawn<Defs extends readonly ComponentDef[]>(
		components: SpawnEntries<Defs>,
		onSpawned?: (entityId: EntityID) => void
	): EditorTransaction;
	spawn(
		components: readonly SpawnEntry[],
		onSpawned?: (entityId: EntityID) => void
	): EditorTransaction {
		return this.transaction((tx) => tx.spawn(components, onSpawned));
	}

	/** Despawn `entityId` as its own undo entry; `restore` recreates it on undo. */
	despawn<Defs extends readonly ComponentDef[]>(
		entityId: EntityID,
		restore: SpawnEntries<Defs>
	): EditorTransaction;
	despawn(entityId: EntityID, restore: readonly SpawnEntry[]): EditorTransaction {
		return this.transaction((tx) => tx.despawn(entityId, restore));
	}

	/** Set one field as its own undo entry. */
	setField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		value: number
	): EditorTransaction {
		return this.transaction((tx) => tx.setField(entityId, def, field, value));
	}

	/** Attach a component as its own undo entry. Bare `add` (see `TransactionBuilder.add`). */
	add<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): EditorTransaction {
		return this.transaction((tx) => tx.add(entityId, def, values));
	}

	/** Detach a component as its own undo entry; `restore` re-adds it on undo. Bare `remove`. */
	remove<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		restore: CompleteFieldValues<S>
	): EditorTransaction {
		return this.transaction((tx) => tx.remove(entityId, def, restore));
	}

	/** Disable `entityId` as its own undo entry. */
	disable(entityId: EntityID): EditorTransaction {
		return this.transaction((tx) => tx.disable(entityId));
	}

	/** Enable `entityId` as its own undo entry. */
	enable(entityId: EntityID): EditorTransaction {
		return this.transaction((tx) => tx.enable(entityId));
	}

	/**
	 * Undo the most recent transaction: enqueue its inverse commands (in reverse
	 * order — a group unwinds last-action-first) on the bus and move it to the redo
	 * stack. Returns `false` if the undo stack is empty.
	 */
	undo(): boolean {
		const txn = this.undoStack.pop();
		if (txn === undefined) return false;
		const inverse = txn.inverse.slice().reverse();
		for (const cmd of inverse) this.queue.push(cmd);
		this.applyShadow(inverse);
		this.redoStack.push(txn);
		this.notify();
		return true;
	}

	/**
	 * Redo the most recently undone transaction: re-enqueue its forward commands on
	 * the bus and move it back to the undo stack. Returns `false` if the redo stack
	 * is empty.
	 */
	redo(): boolean {
		const txn = this.redoStack.pop();
		if (txn === undefined) return false;
		for (const cmd of txn.forward) this.queue.push(cmd);
		this.applyShadow(txn.forward);
		this.undoStack.push(txn);
		this.notify();
		return true;
	}

	/** Drop both stacks (e.g. on load). Does not touch the world. */
	clear(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.shadow.clear();
		this.notify();
	}

	/** Current stack depths — for an "Undo (3)" / "Redo" affordance. */
	depths(): { undo: number; redo: number } {
		return { undo: this.undoStack.length, redo: this.redoStack.length };
	}

	/** `true` when `undo()` would do something — allocation-free. */
	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	/** `true` when `redo()` would do something — allocation-free. */
	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/**
	 * Subscribe to undo/redo-stack changes: fires after every commit, undo,
	 * redo, and clear — the push signal an "Undo (3)" affordance needs instead
	 * of polling `depths()` per frame. Returns an unsubscribe function.
	 * Callbacks run synchronously in subscription order; read `canUndo` /
	 * `canRedo` / `depths()` inside.
	 */
	onChange(cb: () => void): () => void {
		this.listeners.push(cb);
		return () => {
			const i = this.listeners.indexOf(cb);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}

	private notify(): void {
		for (const cb of this.listeners.slice()) cb();
	}

	/** Read one committed `(entity, component, field)` slot through the reader
	 * this editor was constructed with — the default read for `fieldHandle`
	 * when no channel thunk is supplied. */
	committedField(entityId: EntityID, def: ComponentDef, field: string): number | undefined {
		return this.readField(entityId, def, field);
	}

	/**
	 * The pending value the editor believes for a field that the committed read
	 * channel has NOT caught up to yet (the shadow), or `undefined` if none. Lets an
	 * inspector echo an edit between the `set` and the tick that commits it.
	 *
	 * Self-resolving: once the read channel reports the shadowed value (the edit
	 * landed) — or reports `undefined` (the slot is gone: entity despawned or
	 * component removed) — the entry is dropped and this returns `undefined`, so
	 * `pending` does not outlive its set→commit window and shadow a later external
	 * write, nor a dead slot's lifetime. The one
	 * residual: if an external write changes the field to a *different* value within
	 * the same window before this is next consulted, `pending` can read stale until
	 * the next edit to the slot. `value` (the read channel) is always the source of
	 * truth; `pending` is only the optimistic bridge.
	 */
	pendingField(entityId: EntityID, def: ComponentHandle, field: string): number | undefined {
		const key = fieldKey(entityId, def, field);
		const shadowed = this.shadow.get(key);
		if (shadowed === undefined) return undefined;
		// Reconcile-on-read: the committed channel reporting the shadowed value means
		// the edit has landed, so the echo is done. Pruning is safe for inverse
		// correctness — the next setField's `old` falls back to readField, which
		// now returns the same number the shadow held. An `undefined` committed read
		// means the slot no longer exists (entity despawned / component removed):
		// prune too, or the entry echoes a value for a dead slot forever and leaks.
		const committed = this.readField(entityId, def as ComponentDef, field);
		if (committed === shadowed || committed === undefined) {
			this.shadow.delete(key);
			return undefined;
		}
		return shadowed;
	}

	/** Enqueue forward commands, record the transaction, clear redo, sync shadow. */
	private commit(txn: MutableTxn): EditorTransaction {
		// An empty transaction (its build added nothing) is a no-op: don't push a
		// phantom undo entry that `undo()` would pop to enqueue nothing, and don't
		// wipe the redo stack for an edit that touches the world not at all.
		if (txn.forward.length === 0) return txn;
		for (const cmd of txn.forward) this.queue.push(cmd);
		this.applyShadow(txn.forward);
		this.undoStack.push(txn);
		this.redoStack.length = 0;
		this.notify();
		return txn;
	}

	/** Keep the setField shadow in step with the commands just enqueued. */
	private applyShadow(cmds: readonly HostCommand[]): void {
		for (const cmd of cmds) {
			if (cmd.kind === "set_field") {
				this.shadow.set(fieldKey(cmd.eid, cmd.def, cmd.field), cmd.value);
			}
		}
	}
}
