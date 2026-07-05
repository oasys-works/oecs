/**
 * Record / replay over the host command log (#702) — slice 5 (final) of the
 * host → ECS write seam (#681). The deterministic-sim payoff the write seam was
 * always pointing at: because every world mutation crosses ONE chokepoint
 * (`applyHostCommand`, drained by the blessed apply system at the schedule
 * head, §85), logging the `HostCommand`s applied each tick — alongside that
 * tick's `dt` and the session `seed` — is enough to replay a whole session
 * deterministically. Record/replay, save/load, and deterministic debugging fall
 * out of the command stream, independent of any network.
 *
 * Two pieces:
 *   - {@link HostCommandRecorder} — a {@link HostCommandSink} the apply system
 *     feeds (wire it via `installHostCommandSeam(world, { recorder })`). It
 *     buckets commands by tick, separating seed-time (PRE_STARTUP) drains from
 *     per-frame (PRE_UPDATE) drains, and captures both transports (typed queue +
 *     `onCommand`-bound ring ops) since both flow through the one apply path.
 *   - {@link replayCommandLog} — re-applies a {@link CommandLog} against a
 *     FRESH world (built identically: same components/systems, same `seed`),
 *     reproducing the original run tick-for-tick.
 *
 * **Correctness is verifiable, not asserted.** Under the determinism opt-in
 * (ADR-0020, `new ECS({ deterministic: true })`), `world.snapshots.stateHash()` is a
 * canonical digest of world state. Record a session, replay it from the same
 * seed, and the per-tick `stateHash` sequences must be identical — the
 * round-trip test that proves replay fidelity. With determinism off the replay
 * still reproduces state (same commands, same dt, same deferred flush), but
 * `stateHash` is unavailable so the check is structural, not hash-based.
 *
 * **The log is plain, serializable data.** `HostCommand` is mostly plain data;
 * the non-serializable members are a `spawn`'s `onSpawned` callback (which the
 * recorder strips — a replayed spawn reproduces the same id deterministically, so
 * downstream commands that reference it still resolve) and each `ComponentDef`
 * (a callable handle). {@link serializeCommandLog} / {@link deserializeCommandLog}
 * round-trip the log through JSON: `EntityID` rides as the plain number it is, and
 * a def is tagged by its numeric `.id` and reconstructed on parse (replay only
 * reads `def.id`, and the fresh world re-registers components in the same order).
 *
 * See `docs/ideas/host-ecs-write-seam.md` (slice 5) and PATTERNS §85.
 */
import { asComponentId, makeComponentDef, type ComponentDef } from "./component";
import { ECS_ERROR, ECSError } from "./utils/error";
import type { ECS } from "./ecs";
import type { HostCommand, HostCommandQueue, HostCommandSink } from "./host_commands";

/** One recorded update tick: the commands the apply system drained at this
 * tick's update-phase head, plus the `dt` passed to `world.update(dt)`. Replay
 * MUST re-issue `update(dt)` for every recorded tick — even an empty one — since
 * `dt` itself drives the sim (movement, timers), not just the commands. */
export interface RecordedTick {
	/** The ECS tick (`ctx.ecsTick`) this bucket belongs to. */
	readonly tick: number;
	/** The `dt` `world.update(dt)` was called with for this tick. */
	readonly dt: number;
	/** Commands applied this tick, in apply order (typed queue first, then ring),
	 * `onSpawned` stripped. */
	readonly commands: readonly HostCommand[];
}

/**
 * A recorded session: the `seed` it ran under, the seed-time commands drained at
 * startup, and the per-tick command stream. Plain, serializable data — the
 * record-side mirror of the typed `HostCommand` vocabulary. Replay it with
 * {@link replayCommandLog}; persist it with {@link serializeCommandLog}.
 */
export interface CommandLog {
	/** Session seed — the implementer's deterministic input (e.g. an RNG seed).
	 * Opaque to the engine (the core tick takes only `dt`); carried so a replay
	 * rebuilds the world the same way the original was built. */
	readonly seed: number;
	/** Commands drained at the PRE_STARTUP head (seed-time edits), applied before
	 * the first update tick. Enqueued BEFORE `world.startup()` on replay. */
	readonly startup: readonly HostCommand[];
	/** One entry per update tick, in order. */
	readonly ticks: readonly RecordedTick[];
}

/** Drop a `spawn`'s `onSpawned` callback so the recorded command is plain,
 * serializable data. Every other command is already plain — returned as-is. */
function stripOnSpawned(cmd: HostCommand): HostCommand {
	return cmd.kind === "spawn" && cmd.onSpawned !== undefined
		? { kind: "spawn", components: cmd.components }
		: cmd;
}

/** Internal mutable bucket — exposed through the readonly {@link RecordedTick}. */
interface MutableTick {
	readonly tick: number;
	readonly dt: number;
	readonly commands: HostCommand[];
}

/**
 * The record side of record/replay: a {@link HostCommandSink} the apply system
 * feeds. Construct one with the session `seed`, hand it to
 * `installHostCommandSeam(world, { recorder })`, and it accumulates the
 * command stream as the ECS ticks. Read it back with {@link log} (a live view,
 * ready to {@link serializeCommandLog serialize}).
 *
 * Bucketing: STARTUP-phase drains (which never call {@link openTick}) append to
 * the {@link startup} bucket; each update-phase drain {@link openTick}s its tick
 * — multiple update-phase drains in one tick reuse the same bucket (keyed by the
 * ECS tick), so a frame's commands stay together. The apply system runs every
 * tick, so every tick's `dt` is recorded even when no commands were applied.
 *
 * One recorder per session — don't share across worlds.
 */
export class HostCommandRecorder implements HostCommandSink {
	/** Session seed, echoed into the produced {@link CommandLog}. */
	public readonly seed: number;
	private readonly _startup: HostCommand[] = [];
	private readonly _ticks: MutableTick[] = [];
	/** Where {@link record} appends. Defaults to the startup bucket (seed-time
	 * drains happen before any `openTick`); each `openTick` repoints it. */
	private sink: HostCommand[] = this._startup;

	constructor(seed = 0) {
		this.seed = seed;
	}

	openTick(tick: number, dt: number): void {
		const last = this._ticks[this._ticks.length - 1];
		// Same tick again (a second update-phase drain this frame) → reuse its
		// bucket so the frame's commands stay in one entry.
		if (last !== undefined && last.tick === tick) {
			this.sink = last.commands;
			return;
		}
		const commands: HostCommand[] = [];
		this._ticks.push({ tick, dt, commands });
		this.sink = commands;
	}

	readonly record = (cmd: HostCommand): void => {
		this.sink.push(stripOnSpawned(cmd));
	};

	/** A live {@link CommandLog} view over the accumulated stream — not a copy.
	 * Serialize it (which deep-copies through JSON) before mutating the world
	 * further if you need a stable snapshot. */
	log(): CommandLog {
		return { seed: this.seed, startup: this._startup, ticks: this._ticks };
	}
}

/** JSON tag for a serialized component def — carries only its numeric id (a def
 *  is a callable at runtime, so it can't be JSON'd directly). Reconstructed into
 *  a fresh callable def on parse; replay only ever reads `def.id`, and the replay
 *  world re-registers components in the same order, so ids line up. The tag is
 *  in-band, so a command's *values* map (`Record<string, number>`, with arbitrary
 *  field names) could carry this exact key and be mis-revived as a def — the
 *  serializer refuses that collision rather than emit a log that can't round-trip
 *  (see {@link serializeCommandLog}). */
const DEF_TAG = "__component_def";

/** Serialize a {@link CommandLog} to a JSON string. `EntityID` is a plain number
 * and round-trips as-is; a `ComponentDef` is a callable, so the replacer writes
 * it as `{ [DEF_TAG]: id }`. (The recorder already stripped `onSpawned`, the
 * only other non-serializable member.)
 *
 * Throws {@link ECS_ERROR.COMMAND_LOG_TAG_COLLISION} if any non-def object in the
 * log (i.e. a command's `values` map) owns a field named {@link DEF_TAG}: the
 * reviver tags defs in-band, so such a value would be silently revived as a def,
 * dropping the real field data. Field names are arbitrary, so this is reachable;
 * failing here keeps the round-trip lossless instead of corrupting on parse. */
export function serializeCommandLog(log: CommandLog): string {
	return JSON.stringify(log, (_key, value) => {
		if (typeof value === "function" && "id" in value) {
			return { [DEF_TAG]: (value as ComponentDef).id };
		}
		// A plain (non-def) object carrying the sentinel key collides with a
		// serialized def. `deserializeCommandLog` keys solely off the presence of
		// DEF_TAG, so it would rebuild this `values` map into a `ComponentDef` and
		// lose the data. Refuse to produce a log that can't faithfully round-trip.
		// (The `{ [DEF_TAG]: id }` objects this replacer returns are not re-passed
		// to it, so they don't trip this guard.)
		if (value !== null && typeof value === "object" && DEF_TAG in value) {
			throw new ECSError(
				ECS_ERROR.COMMAND_LOG_TAG_COLLISION,
				`Cannot serialize the command log: a value object owns a field named ` +
					`"${DEF_TAG}", the reserved tag the serializer uses for component defs. ` +
					`Rename that component field so the log can round-trip losslessly.`
			);
		}
		return value;
	});
}

/** Parse a {@link CommandLog} from {@link serializeCommandLog} output. */
export function deserializeCommandLog(json: string): CommandLog {
	// boundary: JSON ingress — the serialized form is structurally a CommandLog,
	// with EntityID carried as a plain number and each ComponentDef tagged by the
	// replacer; the reviver reconstructs a callable def from its id. The producer
	// is `serializeCommandLog`.
	return JSON.parse(json, (_key, value) => {
		if (value !== null && typeof value === "object" && DEF_TAG in value) {
			return makeComponentDef(asComponentId((value as Record<string, number>)[DEF_TAG]));
		}
		return value;
	}) as CommandLog;
}

/** Outcome of {@link replayCommandLog}. */
export interface ReplayResult {
	/** Seed-time commands re-applied before the first tick. */
	readonly startupCommands: number;
	/** Update ticks replayed. */
	readonly ticks: number;
	/** Per-tick `stateHash` captured after each `update`, in tick order — empty
	 * unless the world is deterministic (or `hash` was forced). Compare against
	 * the original run's per-tick hashes to prove the replay matched (ADR-0020). */
	readonly stateHashes: readonly number[];
}

/** Options for {@link replayCommandLog}. */
export interface ReplayOptions {
	/** Capture `world.snapshots.stateHash()` after each tick. Defaults to the world's
	 * `deterministic` flag — a deterministic world is hashed, a non-deterministic
	 * one is not (its `stateHash` would throw, ADR-0020). Force `true` only on a
	 * deterministic world. */
	readonly hash?: boolean;
}

/**
 * Replay a recorded {@link CommandLog} against `world`, reproducing the original
 * session tick-for-tick. `world` must be FRESH and NOT yet started, built
 * identically to the recorded run (same components registered in the same order,
 * same systems, same `seed` from `log.seed`) and seam-installed — pass the
 * `HostCommandQueue` `installHostCommandSeam` returned as `queue`. The driver
 * owns startup: it enqueues the seed-time commands, calls `world.startup()`
 * (which drains them at PRE_STARTUP), then for each recorded tick enqueues that
 * tick's commands and calls `world.update(dt)` with the recorded `dt`.
 *
 * Determinism (ADR-0020): with `{ deterministic: true }` the per-tick
 * `stateHashes` this returns must equal the original run's — that equality is
 * replay fidelity. Identity caveat (§85): a despawned-then-respawned entity gets
 * a fresh id, but because spawn order is reproduced, every recorded id still
 * resolves to the same entity on replay.
 */
export function replayCommandLog(
	world: ECS,
	queue: HostCommandQueue,
	log: CommandLog,
	opts?: ReplayOptions
): ReplayResult {
	// Seed-time edits drain at PRE_STARTUP — enqueue them BEFORE startup so the
	// PRE_STARTUP apply-system head drains them, exactly as the original did.
	for (const cmd of log.startup) queue.push(cmd);
	world.startup();

	const wantHash = opts?.hash ?? world.snapshots.deterministic;
	const stateHashes: number[] = [];
	for (const t of log.ticks) {
		for (const cmd of t.commands) queue.push(cmd);
		world.update(t.dt);
		if (wantHash) stateHashes.push(world.snapshots.stateHash());
	}
	return { startupCommands: log.startup.length, ticks: log.ticks.length, stateHashes };
}
