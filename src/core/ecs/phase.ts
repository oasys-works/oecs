/***
 * Phase vocabulary. The names a caller uses to point at one slot of the frame.
 *
 * This file owns the seven built-in `SCHEDULE` members, the `Phase` handle
 * `ecs.addPhase` hands back, the loop a phase belongs to, and the two pure
 * classifiers over either spelling.
 *
 * It imports nothing. That is the point, and not an accident. A phase name is
 * the one piece of schedule vocabulary that `frame_trace.ts` and
 * `host_commands.ts` need, and reaching it through `schedule.ts` dragged the
 * whole schedule, the system descriptor and the run condition behind it. With
 * no import here the module sits outside every type cycle in `src`, and
 * `import_graph.test.ts` records the smaller tangle.
 *
 * It refuses state. `PhaseNode`, the object behind a handle, stays in
 * `schedule.ts` beside the drive loops that read its `plan` field.
 ***/

export enum SCHEDULE {
	PRE_STARTUP = "PRE_STARTUP",
	STARTUP = "STARTUP",
	POST_STARTUP = "POST_STARTUP",
	FIXED_UPDATE = "FIXED_UPDATE",
	PRE_UPDATE = "PRE_UPDATE",
	UPDATE = "UPDATE",
	POST_UPDATE = "POST_UPDATE"
}

/** Which drive runs a phase.
 *
 * `startup` runs once, from `ecs.startup()`. `fixed` runs once per fixed step,
 * inside the accumulator loop. `update` runs once per `ecs.update(dt)`. A
 * phase belongs to one loop for its life, because the loop decides the delta
 * time it receives and how often it runs. */
export type PhaseLoop = "startup" | "fixed" | "update";

/**
 * An opaque handle for one slot in the schedule, returned by `ecs.addPhase`.
 *
 * A phase is identified by **object identity**, not by name, exactly like a
 * `SystemSet`. Two `addPhase` calls with the same name are two phases. The
 * handle belongs to the world that made it, so passing one to another world's
 * `addSystems` is a fault and not silent cross-world scheduling.
 *
 * The seven built-ins have no handle. `SCHEDULE.UPDATE` names one directly,
 * and every place that takes a `SchedulePhase` takes either spelling. A string
 * enum member is already a string, so the built-in needs no wrapper object,
 * and a plugin author reads `after: [SCHEDULE.PRE_UPDATE]` without an import
 * of a handle table.
 */
export interface Phase {
	readonly name: string;
	readonly loop: PhaseLoop;
}

/** Where a new phase sits. `before` and `after` order it against other phases
 * of the same loop, and a target in another loop is dropped. A phase with
 * neither runs after every phase declared before it, so an unordered plugin
 * phase lands at the tail of its loop. */
export interface PhaseConfig {
	readonly loop: PhaseLoop;
	readonly before?: readonly SchedulePhase[];
	readonly after?: readonly SchedulePhase[];
}

/** Either spelling of a phase: a built-in `SCHEDULE` member, or the handle
 * `addPhase` returned. */
export type SchedulePhase = SCHEDULE | Phase;

/** The name a trace event carries for a phase. A built-in spells its `SCHEDULE`
 * member. A phase from `addPhase` spells the name it was given, so the set of
 * values is open and a consumer switching on it needs a default arm. */
export type PhaseName = SCHEDULE | (string & {});

/** The loop that drives either spelling of a phase.
 *
 * A handle from `addPhase` carries its loop. A built-in is one of seven, and
 * its loop is fixed at construction. Pure and cold, so a caller outside the
 * schedule classifies a phase without holding the world. `installHostCommandSeam`
 * is that caller. It refuses a recorder on a fixed-loop phase, and `addPhase`
 * can put a phase of any name in that loop. */
export function phaseLoopOf(phase: SchedulePhase): PhaseLoop {
	if (typeof phase !== "string") return phase.loop;
	switch (phase) {
		case SCHEDULE.PRE_STARTUP:
		case SCHEDULE.STARTUP:
		case SCHEDULE.POST_STARTUP:
			return "startup";
		case SCHEDULE.FIXED_UPDATE:
			return "fixed";
		case SCHEDULE.PRE_UPDATE:
		case SCHEDULE.UPDATE:
		case SCHEDULE.POST_UPDATE:
			return "update";
	}
}

/** The name either spelling of a phase carries, for a diagnostic and for a
 * system name. Pure and cold. */
export function phaseNameOf(phase: SchedulePhase): PhaseName {
	return typeof phase === "string" ? phase : phase.name;
}
