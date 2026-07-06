/**
 * Host → ECS write seam (#681). The write-symmetric counterpart to the reactive
 * read bridge (`engine-extensions/reactive`, ADR-0022): a sanctioned path for
 * host / UI code — a level editor, a local sim's controls, dev tools, an
 * inspector, or (as one consumer among others) a server applying validated
 * commands — to mutate the world from OUTSIDE the system schedule.
 *
 * The shape, de-risked by a prototype (since removed, superseded by the shipped
 * seam + editor layer):
 *   - A host enqueues typed `HostCommand`s OFF-SCHEDULE. `enqueue` is pure — it
 *     only buffers; it can never touch the world from an arbitrary callback.
 *   - A blessed, `exclusive` command-apply system drains the queue at the
 *     schedule HEAD (PRE_STARTUP for seed-time, PRE_UPDATE every frame) through
 *     ONE dispatch (`applyHostCommand`), issuing `SystemContext` deferred ops
 *     so every change lands at the EXISTING phase-tail flush.
 *   - Observers then fire and the reactive read bridge publishes — one batched
 *     commit per tick (ADR-0024) closes the loop.
 *
 * Why a queue and not direct mutation: structural safety (the deferred-flush
 * apply point is the same one systems use), and a reified command stream that a
 * tools layer can stack for undo/redo or log for record/replay — all of which
 * hold with or without a server. See `docs/ideas/host-ecs-write-seam.md`.
 *
 * `HostCommand` is plain data on purpose: it is the shared contract the SAB
 * `command_ring` codec (the second transport — `HostCommandDispatcher` +
 * `ring_*_codec`, #700) decodes into and an editor/undo layer reifies — one
 * vocabulary, one `applyHostCommand` dispatch, regardless of transport. The
 * typed queue is the default for in-process hosts; the ring is the cross-thread
 * / wire path (the sim worker, later the server).
 */
import type { ComponentDef, ComponentSchema, CompleteFieldValues, FieldValues } from "./component";
import type { ECS } from "./ecs";
import type { EntityID } from "./entity";
import type { SystemContext } from "./query";
import type { SystemDescriptor } from "./system";
import { SCHEDULE } from "./schedule";
import { ECSError, ECS_ERROR } from "./utils/error";
import { assertNever } from "../../type_primitives";
import {
	COMMAND_OP_EMPTY,
	COMMAND_RING_SLOT_BYTES,
	CommandRingError,
	drainCommandRing,
	type PayloadCodec
} from "../store";
import { DEV } from "../../dev_flag";

/** One component to attach to a freshly spawned entity. `values` are required
 * and complete as a *strictness* choice, not a runtime need: since #716 every
 * attach path (deferred included — `writeFields`'s `?? 0`) zero-fills omitted
 * fields, same as templates. A host command is a reified, replayable record,
 * so it carries explicit intent for every field rather than relying on the
 * zero-fill; a tag component takes `{}`. Build type-safely with `spawnEntry`. */
export interface SpawnEntry {
	readonly def: ComponentDef;
	readonly values: FieldValues<ComponentSchema>;
}

/** Extracts the schema out of a `ComponentDef` handle. */
type SchemaOf<D extends ComponentDef> = D extends ComponentDef<infer S> ? S : ComponentSchema;

/** One schema-checked spawn entry: `values` is complete for its own def (see
 * the `SpawnEntry` doc — explicit intent per field, though the attach path
 * zero-fills since #716), and a tag takes exactly `{}`. */
export type SpawnEntryFor<D extends ComponentDef> = {
	readonly def: D;
	readonly values: CompleteFieldValues<SchemaOf<D>>;
};

/** The entries tuple for `HostCommandQueue.spawn` — each element's `values` is
 * checked against its own `def`'s schema. Unlike the authoring-side bundle
 * varargs (`StrictBundles` — `Partial`, a template/attach zero-fills omitted
 * fields), a host command demands complete values: it is a reified, replayable
 * record, so every field is explicit even though the attach path would
 * zero-fill (#716). This is the one attach surface that stays on entry-objects
 * — it is transport (record/replay, editor undo), not authoring. */
export type SpawnEntries<Defs extends readonly ComponentDef[]> = readonly [
	...{ [K in keyof Defs]: SpawnEntryFor<Defs[K]> }
];

/** Type-checked `SpawnEntry` constructor — keeps `values` aligned to `def`'s
 * schema at the call site even though the stored entry is schema-erased. */
export function spawnEntry<S extends ComponentSchema>(
	def: ComponentDef<S>,
	values: CompleteFieldValues<S>
): SpawnEntry {
	return { def: def as ComponentDef, values };
}

/**
 * A single world mutation, as plain data. Every transport (typed queue today, a
 * SAB ring codec tomorrow) and every consumer (editor undo, record/replay)
 * speaks this one vocabulary, applied by the one `applyHostCommand` dispatch.
 *
 * Component fields are `string` / `def: ComponentDef` (schema-erased) so the
 * union stays flat; the typed `HostCommandQueue` methods preserve type-safety at
 * the enqueue site. `applyHostCommand` re-applies them through `SystemContext`,
 * which type-checks because `ComponentDef` defaults its schema to
 * `ComponentSchema` (whose `keyof` is `string`).
 */
export type HostCommand =
	| {
			readonly kind: "spawn";
			readonly components: readonly SpawnEntry[];
			/** Fired with the new id once the spawn applies (the id only exists
			 * after the deferred create) — lets a producer/editor learn it. */
			readonly onSpawned?: (entityId: EntityID) => void;
	  }
	| { readonly kind: "despawn"; readonly eid: EntityID }
	| {
			readonly kind: "add_component";
			readonly eid: EntityID;
			readonly def: ComponentDef;
			readonly values: FieldValues<ComponentSchema>;
	  }
	| { readonly kind: "remove_component"; readonly eid: EntityID; readonly def: ComponentDef }
	| {
			readonly kind: "set_field";
			readonly eid: EntityID;
			readonly def: ComponentDef;
			readonly field: string;
			readonly value: number;
	  }
	| { readonly kind: "disable"; readonly eid: EntityID }
	| { readonly kind: "enable"; readonly eid: EntityID };

/**
 * THE ONE APPLY DISPATCH. Maps a `HostCommand` onto `SystemContext` ops. Only
 * ever called from inside the blessed apply system, which holds the `ctx` and is
 * `exclusive` (full access). Structural changes (`spawn`/`despawn`/component
 * add-remove) are deferred to the phase flush, exactly like a normal system's;
 * `setField` is immediate and bumps the change-tick. Returns the new entity for
 * `spawn`, otherwise `undefined`.
 *
 * That immediate/deferred split is a sharp edge: a `setField` targeting a
 * component the entity does NOT yet have — because an `add`/`spawn`
 * enqueued in the SAME drain is still pending its flush — would otherwise fail
 * deep in `getColumn` with an opaque "component not registered". The `DEV`
 * guard below turns that into an actionable message. The fix is structural, not a
 * retry: pass the value in `add`/`spawnEntry` (which carries complete
 * field values), or issue the `setField` on a later frame.
 */
export function applyHostCommand(ctx: SystemContext, cmd: HostCommand): EntityID | undefined {
	switch (cmd.kind) {
		case "spawn": {
			const eid = ctx.commands.spawn();
			for (const entry of cmd.components) {
				ctx.commands.add(eid, entry.def, entry.values);
			}
			cmd.onSpawned?.(eid);
			return eid;
		}
		case "despawn":
			ctx.commands.despawn(cmd.eid);
			return undefined;
		case "add_component":
			ctx.commands.add(cmd.eid, cmd.def, cmd.values);
			return undefined;
		case "remove_component":
			ctx.commands.remove(cmd.eid, cmd.def);
			return undefined;
		case "set_field":
			// `hasComponent` itself throws ENTITY_NOT_ALIVE in DEV for a dead
			// eid (a clear error already); a `false` return is the alive-but-missing
			// case the immediate/deferred split makes easy to hit (see the dispatch
			// doc above).
			if (DEV && !ctx.hasComponent(cmd.eid, cmd.def)) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_NOT_REGISTERED,
					`host set_field on entity ${cmd.eid} targets a component it does not have. ` +
						`If you added that component via a host command this same frame, the add is ` +
						`deferred to the phase flush while set_field is immediate — carry the value in ` +
						`add_component/spawn_entry instead of a separate set_field, or set it next frame. ` +
						`(#681 host write seam)`
				);
			}
			ctx.setField(cmd.eid, cmd.def, cmd.field, cmd.value);
			return undefined;
		case "disable":
			ctx.commands.disable(cmd.eid);
			return undefined;
		case "enable":
			ctx.commands.enable(cmd.eid);
			return undefined;
		default:
			// Exhaustiveness: a new HostCommand kind that misses a case here is a
			// compile error (and a hard throw for foreign/deserialized values) —
			// without this, an unhandled kind silently returned `undefined`.
			return assertNever(cmd, "HostCommand kind");
	}
}

/**
 * The host-facing write handle. Mutating methods ENQUEUE (off-schedule, pure);
 * nothing reaches the world until the apply system drains it at the next
 * schedule head. Mirrors Bevy's `Commands` ergonomics over the flat `HostCommand`
 * vocabulary. The returned-from-`installHostCommandSeam` instance is the
 * write counterpart to the reactive bridge's returned `reactiveMap`.
 */
export class HostCommandQueue {
	private readonly queued: HostCommand[] = [];

	/** Spawn an entity carrying `components`. `onSpawned` receives the new id
	 * once the spawn applies. Each entry's `values` is checked against its own
	 * `def`'s schema (`SpawnEntries`); the stored command stays schema-erased. */
	spawn<Defs extends readonly ComponentDef[]>(
		components: SpawnEntries<Defs>,
		onSpawned?: (entityId: EntityID) => void
	): this;
	spawn(components: readonly SpawnEntry[], onSpawned?: (entityId: EntityID) => void): this {
		this.queued.push({ kind: "spawn", components, onSpawned });
		return this;
	}

	despawn(entityId: EntityID): this {
		this.queued.push({ kind: "despawn", eid: entityId });
		return this;
	}

	/** Attach `def` (with complete `values`) to `entityId` (deferred to the
	 * drain). The namespaced-handle grammar — the queue is a commands buffer, so
	 * it drops the noun (`add`, not `addComponent`), matching `ctx.commands.add`
	 * and the queue's own bare `spawn`/`despawn`/`disable`/`enable`. Values are
	 * complete (transport carries explicit intent per field; see `spawnEntry`),
	 * unlike the authoring-side bundle sugar. */
	add<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): this {
		this.queued.push({ kind: "add_component", eid: entityId, def: def as ComponentDef, values });
		return this;
	}

	/** Detach `def` from `entityId` (deferred to the drain). Bare `remove`
	 * matching `ctx.commands.remove` — see `add`. */
	remove(entityId: EntityID, def: ComponentDef): this {
		this.queued.push({ kind: "remove_component", eid: entityId, def });
		return this;
	}

	/** Set `field` of `def` on `entityId`. Applied IMMEDIATELY at the drain, unlike
	 * the deferred structural ops — so `def` must already be on `entityId`. Do NOT
	 * `add`/`spawn` `def` and `setField` it in the same frame: the add is
	 * still pending its flush when the immediate set runs (carry the value in
	 * `add`/`spawnEntry` instead). `applyHostCommand` throws an
	 * actionable error in `DEV` if you do. */
	setField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		value: number
	): this {
		this.queued.push({ kind: "set_field", eid: entityId, def: def as ComponentDef, field, value });
		return this;
	}

	disable(entityId: EntityID): this {
		this.queued.push({ kind: "disable", eid: entityId });
		return this;
	}

	enable(entityId: EntityID): this {
		this.queued.push({ kind: "enable", eid: entityId });
		return this;
	}

	/** Enqueue a pre-built command. The path for a SAB-ring codec, an editor's
	 * reified inverse, or a replay log — all of which produce `HostCommand` data
	 * directly rather than calling the typed sugar above. */
	push(cmd: HostCommand): this {
		this.queued.push(cmd);
		return this;
	}

	/** Commands buffered but not yet applied. */
	get pending(): number {
		return this.queued.length;
	}

	/** Drop every buffered command without applying it (M15) — e.g. abandoning
	 * queued edits on a scene unload. Returns how many were dropped. Does not
	 * touch commands already drained into the world. */
	clear(): number {
		const n = this.queued.length;
		this.queued.length = 0;
		return n;
	}

	/**
	 * Apply and clear every buffered command. Called by the blessed apply system
	 * inside its schedule span; not part of the host-facing surface. Returns the
	 * count applied.
	 *
	 * `tap`, when present, is invoked with each command in apply order just before
	 * it is applied — the record/replay hook ({@link HostCommandRecorder}). It is
	 * an OPT-IN observer: the tap-free path keeps the original tight loop, so an
	 * un-recorded drain pays nothing (#702).
	 */
	drain(ctx: SystemContext, tap?: (cmd: HostCommand) => void): number {
		const n = this.queued.length;
		if (n === 0) return 0;
		// Snapshot length: a command's `onSpawned` could enqueue more — those run
		// next drain, not this one (keeps a frame's commands within one tick).
		if (tap === undefined) {
			for (let i = 0; i < n; i++) applyHostCommand(ctx, this.queued[i]);
		} else {
			for (let i = 0; i < n; i++) {
				const cmd = this.queued[i];
				tap(cmd);
				applyHostCommand(ctx, cmd);
			}
		}
		this.queued.splice(0, n);
		return n;
	}
}

// ===========================================================================
// SAB command_ring transport — the SECOND transport (#700).
//
// The typed `HostCommandQueue` above is the in-process transport. This is its
// cross-thread / wire counterpart: a producer on another thread (the sim
// worker, later the server applying validated commands) pushes opaque 15-byte
// slots into the SAB `command_ring`, and the apply system drains them through
// the SAME `applyHostCommand`. ONE opcode registry + ONE apply path, two
// serializations — do NOT fork the bus. See `docs/ideas/host-ecs-write-seam.md`
// + PATTERNS §85.
// ===========================================================================

/** Bytes of the payload region inside one `command_ring` slot (15). The slot's
 * leading byte is the opCode; `COMMAND_RING_SLOT_BYTES` (16) is the whole slot. */
export const HOST_COMMAND_PAYLOAD_BYTES = COMMAND_RING_SLOT_BYTES - 1;

/** Validate a ring opCode the way the SAB layer does everywhere — `0` is the
 * reserved empty-slot marker (`COMMAND_OP_EMPTY`) and can never carry a command;
 * codes are `u8`s in `[1, 255]`. */
function checkRingOpCode(opCode: number): void {
	if (opCode === COMMAND_OP_EMPTY) {
		throw new CommandRingError(
			`cannot bind op_code 0 (reserved as the command-ring empty-slot marker)`
		);
	}
	if (opCode < 0 || opCode > 0xff || !Number.isInteger(opCode)) {
		throw new CommandRingError(`command op_code must be a u8 in [1, 255] (got ${opCode})`);
	}
}

/** Write an `EntityID` into the leading `u32` of a fresh 15-byte payload. The id
 * rides as a `u32` because an `EntityID` is a 31-bit packed handle (20-bit index
 * | 11-bit generation) — it always fits, and packing it this way is what frees
 * room for an `f64` value within the 15-byte slot (the prototype's finding: a
 * naïve `(eid: f64, value: f64)` is 16 B and would NOT fit). */
function encodeEid(eid: EntityID): Uint8Array {
	const out = new Uint8Array(HOST_COMMAND_PAYLOAD_BYTES);
	new DataView(out.buffer).setUint32(0, eid, true);
	return out;
}

/** Read the leading `u32` of a payload back as an `EntityID`. */
function decodeEid(payload: Uint8Array): EntityID {
	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	// boundary: branded-ID bridging — a decoded `u32` is an `EntityID` handle.
	return dv.getUint32(0, true) as EntityID;
}

/**
 * Ring codec for a `setField` on a FIXED `(def, field)`. The component + field
 * are bound INTO the codec, not carried in the bytes — the consumer-owned-codec
 * rule (mirroring `command_dispatch`): the engine ships the mechanism, a
 * consumer's codec knows which component+field an opcode means.
 *
 *   Payload (15 B): `[ eid: u32 LE @0 ][ value: f64 LE @4 ][ _reserved: 3 B @12 ]`
 *
 * `value` rides as `f64` (covers every numeric column type losslessly within
 * range); the trailing 3 bytes stay zero. Packing the id as `u32` is what makes
 * `setField` fit the 15-byte slot.
 */
export function ringSetFieldCodec<S extends ComponentSchema>(
	def: ComponentDef<S>,
	field: string & keyof S
): PayloadCodec<HostCommand> {
	return {
		encode(cmd) {
			if (cmd.kind !== "set_field") {
				throw new CommandRingError(
					`ringSetFieldCodec encodes a "set_field" command (got "${cmd.kind}")`
				);
			}
			const out = new Uint8Array(HOST_COMMAND_PAYLOAD_BYTES);
			const dv = new DataView(out.buffer);
			dv.setUint32(0, cmd.eid, true);
			dv.setFloat64(4, cmd.value, true);
			return out;
		},
		decode(payload) {
			const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
			return {
				kind: "set_field",
				// boundary: branded-ID bridging — a decoded `u32` is an `EntityID` handle.
				eid: dv.getUint32(0, true) as EntityID,
				// schema-erased into the flat HostCommand union (the callable def is invariant in S).
				def: def as ComponentDef,
				field,
				value: dv.getFloat64(4, true)
			};
		}
	};
}

/** Ring codec for `despawn` — `[ eid: u32 LE @0 ]`, trailing 11 B reserved-zero. */
export function ringDespawnCodec(): PayloadCodec<HostCommand> {
	return {
		encode(cmd) {
			if (cmd.kind !== "despawn") {
				throw new CommandRingError(
					`ring_despawn_codec encodes a "despawn" command (got "${cmd.kind}")`
				);
			}
			return encodeEid(cmd.eid);
		},
		decode: (payload) => ({ kind: "despawn", eid: decodeEid(payload) })
	};
}

/** Ring codec for `disable` — `[ eid: u32 LE @0 ]`, trailing 11 B reserved-zero. */
export function ringDisableCodec(): PayloadCodec<HostCommand> {
	return {
		encode(cmd) {
			if (cmd.kind !== "disable") {
				throw new CommandRingError(
					`ring_disable_codec encodes a "disable" command (got "${cmd.kind}")`
				);
			}
			return encodeEid(cmd.eid);
		},
		decode: (payload) => ({ kind: "disable", eid: decodeEid(payload) })
	};
}

/** Ring codec for `enable` — `[ eid: u32 LE @0 ]`, trailing 11 B reserved-zero. */
export function ringEnableCodec(): PayloadCodec<HostCommand> {
	return {
		encode(cmd) {
			if (cmd.kind !== "enable") {
				throw new CommandRingError(
					`ring_enable_codec encodes an "enable" command (got "${cmd.kind}")`
				);
			}
			return encodeEid(cmd.eid);
		},
		decode: (payload) => ({ kind: "enable", eid: decodeEid(payload) })
	};
}

/**
 * Ring codec for `removeComponent` of a FIXED `def` — `[ eid: u32 LE @0 ]`, the
 * component bound into the codec (consumer-owned-codec rule). `spawn` /
 * `addComponent` are deliberately absent: they carry component field values
 * that don't fit the 15-byte slot generically, so they stay typed-transport-only
 * (the prototype's finding — the in-process queue has no width limit).
 */
export function ringRemoveComponentCodec(def: ComponentDef): PayloadCodec<HostCommand> {
	return {
		encode(cmd) {
			if (cmd.kind !== "remove_component") {
				throw new CommandRingError(
					`ringRemoveComponentCodec encodes a "remove_component" command (got "${cmd.kind}")`
				);
			}
			return encodeEid(cmd.eid);
		},
		decode: (payload) => ({ kind: "remove_component", eid: decodeEid(payload), def })
	};
}

/** A ctx-aware applier for one ring opcode: runs on the system `ctx` (which the
 * apply system holds) with the raw 15-byte payload. `tap`, when present, is the
 * record/replay hook (#702) — a generic, `onCommand`-bound applier decodes the
 * slot to a `HostCommand` and feeds it to `tap` before applying, so ring-sourced
 * commands land in the same log as typed-queue ones. A raw `on` applier (a
 * consumer's own non-`HostCommand` op, e.g. the game's `spawn_unit`) has no
 * `HostCommand` to surface and simply ignores `tap`. */
export type RingCommandApplier = (
	ctx: SystemContext,
	payload: Uint8Array,
	tap?: (cmd: HostCommand) => void
) => void;

/**
 * Drains the SAB `command_ring` as the second host-command transport, dispatching
 * each opcode to a bound applier. Two binding styles:
 *
 *   - `onCommand(op, codec)` — decode the slot to a `HostCommand` and run it
 *     through the ONE `applyHostCommand` (the same dispatch the typed queue
 *     uses). This is the generic cross-thread / wire host-write path.
 *   - `on(op, applier)` — a raw ctx-aware handler for a consumer's OWN ring ops
 *     that aren't generic host commands (e.g. the game's `spawn_unit`, which runs
 *     a BFS placement + game spawn). Same drain, same ring: the "one bus".
 *
 * Opcodes + codecs are CONSUMER-supplied — the engine ships the mechanism and the
 * `ring_*_codec` factories, never the opcode numbers (mirrors `command_dispatch`).
 *
 * Exactly ONE dispatcher should drain a given ring — a second drain would consume
 * the first's slots. The in-process apply system passes its dispatcher via
 * `installHostCommandSeam({ ring })`; a system that owns a timing-coupled drain
 * point (e.g. `wave_spawn`, which must drain between the spatial-index build and
 * the flow-field rebuild) constructs one and calls `drain` itself.
 */
export class HostCommandDispatcher {
	private readonly appliers = new Map<number, RingCommandApplier>();

	/** Bind a raw ctx-aware applier to `opCode`. Re-binding replaces. */
	on(opCode: number, applier: RingCommandApplier): this {
		checkRingOpCode(opCode);
		this.appliers.set(opCode, applier);
		return this;
	}

	/** Unbind `opCode` (M15). Returns whether a binding was removed; subsequent
	 * slots carrying it hit the unknown-opcode path. */
	off(opCode: number): boolean {
		return this.appliers.delete(opCode);
	}

	/** Bind a `HostCommand` codec to `opCode`: each matching slot is decoded and
	 * run through `applyHostCommand` — the SAME dispatch the typed queue uses.
	 * A drain-time `tap` (record/replay, #702) sees the decoded command before it
	 * applies, so ring-sourced commands share one log with the typed transport. */
	onCommand(opCode: number, codec: PayloadCodec<HostCommand>): this {
		return this.on(opCode, (ctx, payload, tap) => {
			const cmd = codec.decode(payload);
			tap?.(cmd);
			applyHostCommand(ctx, cmd);
		});
	}

	/** Drain every pending slot, dispatching each to its bound applier. Unbound
	 * opcodes are skipped (the read head still advances — matching
	 * `drainCommandRing` / `CommandDispatcher`). Returns slots drained. `tap`,
	 * when present, is forwarded to each applier as the record/replay hook (#702);
	 * only `onCommand`-bound (generic `HostCommand`) opcodes surface to it. */
	drain(
		ctx: SystemContext,
		view: DataView,
		ringOff: number,
		tap?: (cmd: HostCommand) => void
	): number {
		return drainCommandRing(view, ringOff, (opCode, payload) => {
			const applier = this.appliers.get(opCode);
			if (applier === undefined) return;
			applier(ctx, payload, tap);
		});
	}
}

/**
 * A per-tick sink the apply system feeds drained commands into — the record side
 * of record/replay (#702). Declared structurally HERE (not imported from
 * `command_log.ts`) so the seam needs no dependency on the recorder: the one-way
 * edge is `command_log` → `host_commands`, never back. {@link HostCommandRecorder}
 * is the in-tree implementation.
 *
 * The protocol the apply system follows: at each UPDATE-phase drain it calls
 * `openTick(tick, dt)` to open that tick's bucket; STARTUP-phase drains skip
 * `openTick`, so seed-time commands land in the recorder's startup bucket. Then
 * every applied command (both transports) is handed to `record`.
 */
export interface HostCommandSink {
	/** Open (or reuse) the bucket for update `tick` with its `dt`. Multiple drains
	 * in one tick (several update phases) reuse the one bucket. */
	openTick(tick: number, dt: number): void;
	/** Record one applied command, in apply order. Pre-bound so it can be passed
	 * straight as a drain `tap` without per-tick closure allocation. */
	readonly record: (cmd: HostCommand) => void;
}

/** Startup-phase labels — a drain at one of these is a seed-time drain, recorded
 * into the sink's startup bucket rather than an update tick (#702). */
const STARTUP_SCHEDULES: ReadonlySet<SCHEDULE> = new Set([
	SCHEDULE.PRE_STARTUP,
	SCHEDULE.STARTUP,
	SCHEDULE.POST_STARTUP
]);

/** Options for {@link installHostCommandSeam}. */
export interface HostCommandSeamOptions {
	/** Schedule phases whose head drains the queue. Default
	 * `[PRE_STARTUP, PRE_UPDATE]` — seed-time edits plus every frame. */
	readonly schedules?: readonly SCHEDULE[];
	/** Apply-system name (diagnostics). Default `"host_command_apply"`. */
	readonly name?: string;
	/** When provided, the apply system ALSO drains the world's SAB `command_ring`
	 * through this dispatcher at each schedule head — the cross-thread / wire
	 * transport, resolving to the same `applyHostCommand` as the typed queue.
	 * The ECS `Store` always allocates a ring; if one is somehow absent
	 * (`command_ring_off === 0`) the ring drain is a no-op. Bind opcodes with the
	 * `ring_*_codec` factories, or `dispatcher.on` for a consumer's own ops. */
	readonly ring?: HostCommandDispatcher;
	/** When provided, every command the apply system drains — from BOTH transports
	 * (typed queue + `onCommand`-bound ring ops) — is logged into this sink,
	 * tagged with the tick + `dt`, for record/replay (#702). Off by default: an
	 * un-recorded seam keeps the original tap-free drain and pays nothing.
	 * {@link HostCommandRecorder} is the in-tree sink; replay it with
	 * `replayCommandLog`. */
	readonly recorder?: HostCommandSink;
}

/**
 * Install the write seam on `world`: registers the blessed `exclusive`
 * command-apply system at the head of the given schedules and returns the
 * {@link HostCommandQueue} to enqueue into. Opt-in and explicit, symmetric to
 * the read bridge's `syncComponentToMap`.
 *
 * Call this BEFORE adding your own systems and BEFORE `ecs.startup()`: the
 * apply system must be registered first so insertion order runs it at the head
 * of its phase (the schedule has no dedicated "first" slot), and the PRE_STARTUP
 * drain only fires if it exists before startup.
 *
 * Lives in engine CORE (not extensions): unlike the read bridge there is no
 * external reactive kernel to quarantine — this is pure ECS plumbing over the
 * deferred buffers and `SystemContext` the core already owns.
 */
// queue → the apply-system descriptors its seam registered, for uninstall.
const seamSystems = new WeakMap<HostCommandQueue, SystemDescriptor[]>();

/**
 * Tear down a seam installed by {@link installHostCommandSeam} (M15): removes
 * its apply systems from the world's schedule and clears any still-buffered
 * commands. The queue itself stays usable as a buffer, but nothing drains it
 * until a new seam is installed. No-op (returns `false`) if `queue` was not
 * produced by `installHostCommandSeam` on this world.
 */
export function uninstallHostCommandSeam(ecs: ECS, queue: HostCommandQueue): boolean {
	const descs = seamSystems.get(queue);
	if (descs === undefined) return false;
	for (const desc of descs) ecs.removeSystem(desc);
	seamSystems.delete(queue);
	queue.clear();
	return true;
}

export function installHostCommandSeam(
	ecs: ECS,
	opts?: HostCommandSeamOptions
): HostCommandQueue {
	const queue = new HostCommandQueue();
	const installed: SystemDescriptor[] = [];
	seamSystems.set(queue, installed);
	const name = opts?.name ?? "host_command_apply";
	const ring = opts?.ring;
	const recorder = opts?.recorder;
	// The drain tap: the recorder's pre-bound `record`, or undefined (tap-free
	// drain). Stable across ticks — no per-tick allocation.
	const tap = recorder?.record;
	const schedules = opts?.schedules ?? [SCHEDULE.PRE_STARTUP, SCHEDULE.PRE_UPDATE];
	// A recorder logs each tick's `ecs.update(dt)` so `replayCommandLog` can
	// re-issue it. A FIXED_UPDATE drain receives the FIXED timestep, not the host's
	// variable update dt, so recording there would replay `update(fixedTimestep)`
	// and diverge — a different fixed sub-step count plus any dt-integrating system,
	// breaking the per-tick `stateHash` match that IS replay fidelity. Record only
	// from variable-update phases (PRE_UPDATE / UPDATE / POST_UPDATE). #725
	if (recorder !== undefined && schedules.includes(SCHEDULE.FIXED_UPDATE)) {
		throw new ECSError(
			ECS_ERROR.INVALID_RECORDER_SCHEDULE,
			`install_host_command_seam: a recorder cannot drain on SCHEDULE.FIXED_UPDATE — it would log the fixed-step dt instead of the host update(dt) and diverge on replay. Use a variable-update phase (PRE_UPDATE/UPDATE/POST_UPDATE).`
		);
	}
	// One descriptor per phase: a descriptor can only be scheduled once, and we
	// want the queue drained at the head of each listed phase. All share the one
	// queue, so a command enqueued before startup drains at PRE_STARTUP and a
	// command enqueued between ticks drains at the next PRE_UPDATE.
	for (const label of schedules) {
		const isUpdateDrain = !STARTUP_SCHEDULES.has(label);
		const apply = ecs.registerSystem({
			name: `${name}:${label}`,
			// `reads`/`writes` are required by `SystemConfig` but empty here: the
			// apply system declares nothing because it mutates components not known
			// at registration. Full world access: the host may queue mutations to
			// anything. The deferred-flush apply point is unchanged, so structural
			// safety holds; `exclusive` only waives the DEV access check.
			reads: [],
			writes: [],
			exclusive: true,
			fn: (ctx, dt) => {
				// Recording: open this update tick's bucket before draining so both
				// transports' commands log under it. A STARTUP-phase drain skips this,
				// landing seed-time commands in the recorder's startup bucket.
				if (recorder !== undefined && isUpdateDrain) recorder.openTick(ctx.ecsTick, dt);
				// Both transports resolve to the same `applyHostCommand`: the typed
				// in-process queue, then the SAB ring (cross-thread / wire) if bound.
				// `tap` (the recorder, if any) observes each in apply order.
				queue.drain(ctx, tap);
				if (ring !== undefined) {
					const buffer = ecs.columnStore;
					const ringOff = buffer.header.commandRingOff;
					if (ringOff !== 0) ring.drain(ctx, buffer.view, ringOff, tap);
				}
			}
		});
		ecs.addSystems(label, apply);
		installed.push(apply);
	}
	return queue;
}
