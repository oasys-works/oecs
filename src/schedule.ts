/***
 *
 * Schedule - System execution lifecycle management.
 * Systems sorted per-phase by topological order. See docs/DESIGN.md [opt:8].
 *
 ***/

import type { SystemContext } from "./query";
import type { SystemDescriptor } from "./system";
import { ECS_ERROR, ECSError } from "./utils/error";

//=========================================================
// Schedule phases
//=========================================================

export enum SCHEDULE {
  PRE_STARTUP = "PRE_STARTUP",
  STARTUP = "STARTUP",
  POST_STARTUP = "POST_STARTUP",
  PRE_UPDATE = "PRE_UPDATE",
  UPDATE = "UPDATE",
  POST_UPDATE = "POST_UPDATE",
}

const STARTUP_LABELS = [
  SCHEDULE.PRE_STARTUP,
  SCHEDULE.STARTUP,
  SCHEDULE.POST_STARTUP,
] as const;

const UPDATE_LABELS = [
  SCHEDULE.PRE_UPDATE,
  SCHEDULE.UPDATE,
  SCHEDULE.POST_UPDATE,
] as const;

//=========================================================
// Ordering constraints
//=========================================================

export interface SystemOrdering {
  before?: SystemDescriptor[];
  after?: SystemDescriptor[];
}

export interface SystemEntry {
  system: SystemDescriptor;
  ordering?: SystemOrdering;
}

//=========================================================
// Internal node
//=========================================================

interface SystemNode {
  descriptor: SystemDescriptor;
  insertion_order: number;
  before: Set<SystemDescriptor>;
  after: Set<SystemDescriptor>;
}

//=========================================================
// Schedule
//=========================================================

export class Schedule {
  private label_systems: Map<SCHEDULE, SystemNode[]> = new Map();
  private sorted_cache: Map<SCHEDULE, SystemDescriptor[]> = new Map();
  private system_index: Map<SystemDescriptor, SCHEDULE> = new Map();
  private next_insertion_order = 0;

  constructor() {
    for (let i = 0; i < STARTUP_LABELS.length; i++) {
      this.label_systems.set(STARTUP_LABELS[i], []);
    }
    for (let i = 0; i < UPDATE_LABELS.length; i++) {
      this.label_systems.set(UPDATE_LABELS[i], []);
    }
  }

  /**
   * Register one or more systems under a schedule phase.
   * Accepts bare SystemDescriptors or SystemEntry objects for ordering.
   */
  add_systems(
    label: SCHEDULE,
    ...entries: (SystemDescriptor | SystemEntry)[]
  ): void {
    for (const entry of entries) {
      const descriptor = "system" in entry ? entry.system : entry;
      const ordering = "system" in entry ? entry.ordering : undefined;

      if (__DEV__) {
        if (this.system_index.has(descriptor)) {
          throw new ECSError(
            ECS_ERROR.DUPLICATE_SYSTEM,
            `System ${descriptor.id} is already scheduled`,
          );
        }
      }

      const node: SystemNode = {
        descriptor,
        insertion_order: this.next_insertion_order++,
        before: new Set(ordering?.before ?? []),
        after: new Set(ordering?.after ?? []),
      };

      this.label_systems.get(label)!.push(node);
      this.system_index.set(descriptor, label);
      this.sorted_cache.delete(label);
    }
  }

  /**
   * Remove a system from the schedule.
   * Does NOT call lifecycle hooks - that is World's job.
   */
  remove_system(system: SystemDescriptor): void {
    const label = this.system_index.get(system);
    if (label === undefined) return;

    const nodes = this.label_systems.get(label)!;
    const index = nodes.findIndex((n) => n.descriptor === system);
    if (index !== -1) {
      const last = nodes.length - 1;
      if (index !== last) {
        nodes[index] = nodes[last];
      }
      nodes.pop();

      // Clean up dangling ordering references from remaining nodes
      for (const node of nodes) {
        node.before.delete(system);
        node.after.delete(system);
      }
    }

    this.system_index.delete(system);
    this.sorted_cache.delete(label);
  }

  /**
   * Run all startup phases in order: PRE_STARTUP -> STARTUP -> POST_STARTUP
   */
  run_startup(ctx: SystemContext): void {
    for (const label of STARTUP_LABELS) {
      this.run_label(label, ctx, 0);
    }
  }

  /**
   * Run all update phases in order: PRE_UPDATE -> UPDATE -> POST_UPDATE
   */
  run_update(ctx: SystemContext, delta_time: number): void {
    for (const label of UPDATE_LABELS) {
      this.run_label(label, ctx, delta_time);
    }
  }

  /**
   * Get all systems across all phases.
   */
  get_all_systems(): SystemDescriptor[] {
    const all: SystemDescriptor[] = [];
    for (const nodes of this.label_systems.values()) {
      for (const node of nodes) {
        all.push(node.descriptor);
      }
    }
    return all;
  }

  /**
   * Check if a system descriptor is scheduled.
   */
  has_system(system: SystemDescriptor): boolean {
    return this.system_index.has(system);
  }

  /**
   * Clear all systems from the schedule.
   */
  clear(): void {
    for (const nodes of this.label_systems.values()) {
      nodes.length = 0;
    }
    this.sorted_cache.clear();
    this.system_index.clear();
  }

  //=========================================================
  // Private
  //=========================================================

  private run_label(
    label: SCHEDULE,
    ctx: SystemContext,
    delta_time: number,
  ): void {
    const sorted = this.get_sorted(label);
    for (let i = 0; i < sorted.length; i++) {
      sorted[i].fn(ctx, delta_time);
    }
    ctx.flush();
  }

  private get_sorted(label: SCHEDULE): SystemDescriptor[] {
    const cached = this.sorted_cache.get(label);
    if (cached !== undefined) return cached;

    const nodes = this.label_systems.get(label)!;
    const sorted = this.topological_sort(nodes, label);
    this.sorted_cache.set(label, sorted);
    return sorted;
  }

  /** Topological sort using Kahn's algorithm. Uses insertion order as tiebreaker. */
  private topological_sort(
    nodes: SystemNode[],
    label: SCHEDULE,
  ): SystemDescriptor[] {
    if (nodes.length === 0) return [];

    const adjacency = new Map<SystemDescriptor, Set<SystemDescriptor>>();
    const in_degree = new Map<SystemDescriptor, number>();
    const insertion_order = new Map<SystemDescriptor, number>();
    const node_set = new Set<SystemDescriptor>();

    for (const node of nodes) {
      adjacency.set(node.descriptor, new Set());
      in_degree.set(node.descriptor, 0);
      insertion_order.set(node.descriptor, node.insertion_order);
      node_set.add(node.descriptor);
    }

    for (const node of nodes) {
      // "this system runs before X" -> edge: this -> X
      for (const target of node.before) {
        if (!node_set.has(target)) continue;
        adjacency.get(node.descriptor)!.add(target);
        in_degree.set(target, in_degree.get(target)! + 1);
      }

      // "this system runs after X" -> edge: X -> this
      for (const dep of node.after) {
        if (!node_set.has(dep)) continue;
        adjacency.get(dep)!.add(node.descriptor);
        in_degree.set(node.descriptor, in_degree.get(node.descriptor)! + 1);
      }
    }

    let ready: SystemDescriptor[] = [];
    for (const node of nodes) {
      if (in_degree.get(node.descriptor) === 0) ready.push(node.descriptor);
    }
    ready.sort((a, b) => insertion_order.get(b)! - insertion_order.get(a)!);

    const result: SystemDescriptor[] = [];

    while (ready.length > 0) {
      const current = ready.pop()!;
      result.push(current);
      for (const neighbor of adjacency.get(current)!) {
        const d = in_degree.get(neighbor)! - 1;
        in_degree.set(neighbor, d);
        if (d === 0) ready.push(neighbor);
      }
      ready.sort((a, b) => insertion_order.get(b)! - insertion_order.get(a)!);
    }

    // Cycle detection
    if (result.length !== nodes.length) {
      const result_set = new Set(result);
      const remaining = nodes
        .filter((n) => !result_set.has(n.descriptor))
        .map((n) => `system_${n.descriptor.id}`);

      throw new ECSError(
        ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY,
        `Circular system dependency detected in ${label}: [${remaining.join(", ")}]`,
      );
    }

    return result;
  }
}
