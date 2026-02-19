/***
 *
 * System - Function-based system types
 *
 * Systems are plain functions, not abstract classes. A SystemConfig
 * defines the system's update function and optional lifecycle hooks.
 * World.register_system assigns a SystemID and returns a frozen
 * SystemDescriptor - the identity handle used for ordering constraints.
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";
import type { SystemContext } from "./query";
import type { Store } from "./store";

//=========================================================
// SystemID
//=========================================================

export type SystemID = Brand<number, "system_id">;

export const as_system_id = (value: number) =>
  validate_and_cast<number, SystemID>(
    value,
    is_non_negative_integer,
    "SystemID must be a non-negative integer",
  );

//=========================================================
// SystemFn
//=========================================================

export type SystemFn = (ctx: SystemContext, delta_time: number) => void;

//=========================================================
// SystemConfig (user provides this to register)
//=========================================================

export interface SystemConfig {
  fn: SystemFn;
  on_added?: (store: Store) => void;
  on_removed?: () => void;
  dispose?: () => void;
}

//=========================================================
// SystemDescriptor (returned by World.register_system)
//=========================================================

export interface SystemDescriptor extends Readonly<SystemConfig> {
  readonly id: SystemID;
}
