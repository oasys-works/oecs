/***
 * System — Function-based system types.
 *
 * Systems are plain functions, not classes. A SystemConfig defines the
 * system's update function and optional lifecycle hooks.
 * World.register_system() assigns a unique SystemID and returns a frozen
 * SystemDescriptor — the identity handle used for scheduling and ordering.
 *
 * Lifecycle:
 *   on_added(ctx)    — called once during world.startup()
 *   fn(ctx, dt)      — called every frame by the schedule
 *   on_removed()     — called when the system is unregistered
 *   dispose()        — called during world.dispose()
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";
import type { SystemContext } from "./query";

export type SystemID = Brand<number, "system_id">;

export const as_system_id = (value: number) =>
  validate_and_cast<number, SystemID>(
    value,
    is_non_negative_integer,
    "SystemID must be a non-negative integer",
  );

export type SystemFn = (ctx: SystemContext, delta_time: number) => void;

export interface SystemConfig {
  fn: SystemFn;
  name?: string;
  on_added?: (ctx: SystemContext) => void;
  on_removed?: () => void;
  dispose?: () => void;
}

export interface SystemDescriptor extends Readonly<SystemConfig> {
  readonly id: SystemID;
}
