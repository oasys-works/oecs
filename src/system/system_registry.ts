/***
 *
 * SystemRegistry - Owns system descriptors and manages lifecycle.
 * Assigns SystemIDs, calls lifecycle hooks (on_added, on_removed, dispose).
 *
 ***/

import type { Store } from "../store";
import { ECS_ERROR, ECSError } from "../utils/error";
import {
  as_system_id,
  type SystemConfig,
  type SystemDescriptor,
  type SystemID,
} from "./system";

//=========================================================
// SystemRegistry
//=========================================================

export class SystemRegistry {
  private systems: Map<SystemID, SystemDescriptor> = new Map();
  private next_id = 0;

  /**
   * Register a system and assign it a SystemID.
   * Returns a frozen SystemDescriptor - the identity handle.
   */
  public register(config: SystemConfig): SystemDescriptor {
    const id = as_system_id(this.next_id++);

    const descriptor: SystemDescriptor = Object.freeze(
      Object.assign({ id }, config),
    );

    this.systems.set(id, descriptor);
    return descriptor;
  }

  /**
   * Get a system descriptor by ID.
   */
  public get(id: SystemID): SystemDescriptor {
    const descriptor = this.systems.get(id);
    if (__DEV__) {
      if (!descriptor) {
        throw new ECSError(
          ECS_ERROR.SYSTEM_NOT_FOUND,
          `System with ID ${id} not found`,
        );
      }
    }
    return descriptor!;
  }

  /**
   * Remove a system by ID. Calls on_removed if defined.
   */
  public remove(id: SystemID): void {
    const descriptor = this.systems.get(id);
    if (!descriptor) return;

    descriptor.on_removed?.();
    this.systems.delete(id);
  }

  /**
   * Initialize all registered systems with the store reference.
   * Calls on_added(store) on every system.
   */
  public init_all(store: Store): void {
    for (const descriptor of this.systems.values()) {
      descriptor.on_added?.(store);
    }
  }

  /**
   * Dispose all systems. Calls dispose() then on_removed() on each,
   * then clears the registry.
   */
  public dispose_all(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.dispose?.();
      descriptor.on_removed?.();
    }
    this.systems.clear();
  }

  /**
   * Get all registered system descriptors.
   */
  public get_all(): SystemDescriptor[] {
    return [...this.systems.values()];
  }

  /**
   * Number of registered systems.
   */
  public get count(): number {
    return this.systems.size;
  }
}
