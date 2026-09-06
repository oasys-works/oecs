/***
 * The observer seam. The registration shapes, the host record, and what the
 * world calls on an observer registry it did not build.
 *
 * The registry, the access-topological ordering and the dispatch live in the
 * observers plugin. This file holds the config a caller writes and the two
 * interfaces the seam needs.
 *
 * A world that installs no observers plugin holds `null` where the registry
 * goes. The store's structural flush is gated on its own observer counts,
 * which stay zero when nothing registers, so that world runs the flush loops
 * it ran before.
 ***/

import type { ArchetypeView } from "./archetype";
import type { ChangeFeed } from "./plugin";
import type { EntityID } from "./entity";
import type { FrameTraceSink } from "./frame_trace";
import type { SystemContext } from "./system_context";
import type { SystemAccessDeclaration, SystemDescriptor } from "./system";

/** What the observer registry needs from `Store`: the change feed every
 * consumer shares, plus the dev-only trace sink. `Store` implements this. The
 * registry holds only this view, so the compiler bounds what observer dispatch
 * can touch, and the registry is one consumer of the feed among others. */
export interface ObserverHost extends ChangeFeed {
	/** Dev-only frame-trace sink (`null` when unset, always null in prod). */
	readonly trace: FrameTraceSink | null;
}

/** What the world calls into an observer registry it did not build.
 *
 * `ECS.update` runs `dispatchSet` at the tick-tail detection point, through
 * the settle hook the install pushed. A `DEV` build reads `descriptors` once
 * per frame trace. Both are cold. The structural dispatch does not appear
 * here: the plugin subscribes to it through the change feed. */
export interface ObserverHooks {
	/** The synthesized descriptor of each registered observer, for the access
	 * check and the frame trace. */
	descriptors(): SystemDescriptor[];
	/** Fire the `onSet` observers for the change tick `run`. */
	dispatchSet(run: number): void;
}

/** Per-entity observer callback (onAdd, onRemove, onDisable and onEnable, and
 * per-entity onSet). */
export type ObserverFn = (entityId: EntityID, ctx: SystemContext) => void;
/** Archetype-granular onSet callback, fires once per changed archetype-column
 * the consumer iterates `arch.entityCount` rows itself. */
export type ArchetypeObserverFn = (arch: ArchetypeView, ctx: SystemContext) => void;

/** Fields common to every observer registration. `access` drives both the
 * dev-mode `accessCheck` and the access-topological firing order. It is merged
 * over an all-empty declaration, so a caller spells out only what it touches. */
interface ObserverConfigBase {
	onAdd?: ObserverFn;
	onRemove?: ObserverFn;
	/** Fires when an entity carrying this component is *disabled*, at the
	 * deferred toggle drain, once per net transition. Mirrors `onRemove`:
	 * a disable is a soft remove of the whole mask from default queries. An immediate
	 * host-side `ecs.disable()` does not fire (like immediate `addComponent`). */
	onDisable?: ObserverFn;
	/** Fires when an entity carrying this component is *enabled*, symmetric
	 * with `onDisable` / `onAdd`. */
	onEnable?: ObserverFn;
	/** Access surface the callbacks touch (reads, writes and spawns / …). Partial:
	 * merged over `_INTERNAL_EMPTY_ACCESS`. Undeclared access throws in `DEV`. */
	access?: Partial<SystemAccessDeclaration>;
	/** flecs-style replay of current matches on registration (onAdd only, seeds the
	 * *enabled* members. A disabled entity is absent, which matches the default-query
	 * semantics), for order-independence of register-vs-spawn. */
	yieldExisting?: boolean;
	/** Diagnostic label for this observer, surfaced by the frame-trace seam
	 * as the `observer_fired.observer` field, the same role a system's
	 * `name` plays. Optional and observe-only: it never touches `stateHash` or
	 * dispatch. Defaults to `observer(<component debug name>)` when the component
	 * was registered with a name, else `observer(<cid>)`. */
	name?: string;
}

/** Per-entity onSet: `onSet(eid, ctx)` fires once per changed entity, drained
 * from the opt-in per-row dirty list (registering this enables dirty tracking
 * for the component, the dirty list + dedup bit). */
export interface EntitySetObserverConfig extends ObserverConfigBase {
	onSet: ObserverFn;
	granularity: "entity";
}

/** Archetype-granular onSet (default): `onSet(arch, ctx)` fires once per
 * changed archetype-column (the change tick), in canonical archetype order. Free
 * write path. */
export interface ArchetypeSetObserverConfig extends ObserverConfigBase {
	onSet: ArchetypeObserverFn;
	granularity?: "archetype";
}

/** Structural-only observer, no onSet. */
export interface StructuralObserverConfig extends ObserverConfigBase {
	onSet?: undefined;
	granularity?: undefined;
}

export type ObserverConfig =
	| StructuralObserverConfig
	| EntitySetObserverConfig
	| ArchetypeSetObserverConfig;

/** Handle returned by `ecs.observe(...)`. `dispose()` unregisters. Safe to
 * call more than once. */
export interface ObserverHandle {
	dispose(): void;
	/** `using h = ecs.observe(C, {...})`, explicit-resource-management sugar
	 * over {@link dispose} (TC39 `Symbol.dispose`). */
	[Symbol.dispose](): void;
}
