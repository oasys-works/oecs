/***
 * Schedule — System execution lifecycle with topological ordering.
 *
 * Systems are organized into 7 phases:
 *   PRE_STARTUP  → STARTUP → POST_STARTUP  (run once via world.startup())
 *   FIXED_UPDATE                            (run at fixed timestep via world.update(dt))
 *   PRE_UPDATE   → UPDATE  → POST_UPDATE   (run every frame via world.update(dt))
 *
 * Within each phase, systems are topologically sorted using Kahn's
 * algorithm, respecting before/after ordering constraints. Insertion
 * order is used as a stable tiebreaker for deterministic execution.
 *
 * After all systems in a phase complete, SystemContext.flush() is called
 * automatically, applying deferred structural changes before the next phase.
 *
 * The sort result is cached per phase and invalidated when systems are
 * added or removed.
 *
 * Usage:
 *
 *   world.add_systems(SCHEDULE.UPDATE, moveSys, {
 *     system: renderSys,
 *     ordering: { after: [moveSys] },
 *   });
 *
 ***/

import type { SystemContext } from "./query";
import type { SystemDescriptor } from "./system";
import { ECS_ERROR, ECSError } from "./utils/error";

export enum SCHEDULE {
  PRE_STARTUP = "PRE_STARTUP",
  STARTUP = "STARTUP",
  POST_STARTUP = "POST_STARTUP",
  FIXED_UPDATE = "FIXED_UPDATE",
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

export interface SystemOrdering {
  before?: SystemDescriptor[];
  after?: SystemDescriptor[];
}

export interface SystemEntry {
  system: SystemDescriptor;
  ordering?: SystemOrdering;
}

interface SystemNode {
  descriptor: SystemDescriptor;
  insertion_order: number;
  before: Set<SystemDescriptor>;
  after: Set<SystemDescriptor>;
}

export class Schedule {
  private label_systems: Map<SCHEDULE, SystemNode[]> = new Map();
  private sorted_cache: Map<SCHEDULE, SystemDescriptor[]> = new Map();
  private system_index: Map<SystemDescriptor, SCHEDULE> = new Map();
  private next_insertion_order = 0;

  constructor() {
    for (let i = 0; i < STARTUP_LABELS.length; i++) {
      this.label_systems.set(STARTUP_LABELS[i], []);
    }
    this.label_systems.set(SCHEDULE.FIXED_UPDATE, []);
    for (let i = 0; i < UPDATE_LABELS.length; i++) {
      this.label_systems.set(UPDATE_LABELS[i], []);
    }
  }

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

  remove_system(system: SystemDescriptor): void {
    const label = this.system_index.get(system);
    if (label === undefined) return;

    const nodes = this.label_systems.get(label)!;
    const index = nodes.findIndex((n) => n.descriptor === system);
    if (index !== -1) {
      // Swap-and-pop removal
      const last = nodes.length - 1;
      if (index !== last) {
        nodes[index] = nodes[last];
      }
      nodes.pop();

      // Clean up ordering references from remaining nodes
      for (const node of nodes) {
        node.before.delete(system);
        node.after.delete(system);
      }
    }

    this.system_index.delete(system);
    this.sorted_cache.delete(label);
  }

  run_startup(ctx: SystemContext): void {
    for (const label of STARTUP_LABELS) {
      this.run_label(label, ctx, 0);
    }
  }

  run_update(ctx: SystemContext, delta_time: number): void {
    for (const label of UPDATE_LABELS) {
      this.run_label(label, ctx, delta_time);
    }
  }

  run_fixed_update(ctx: SystemContext, fixed_dt: number): void {
    this.run_label(SCHEDULE.FIXED_UPDATE, ctx, fixed_dt);
  }

  has_fixed_systems(): boolean {
    return this.label_systems.get(SCHEDULE.FIXED_UPDATE)!.length > 0;
  }

  get_all_systems(): SystemDescriptor[] {
    const all: SystemDescriptor[] = [];
    for (const nodes of this.label_systems.values()) {
      for (const node of nodes) {
        all.push(node.descriptor);
      }
    }
    return all;
  }

  has_system(system: SystemDescriptor): boolean {
    return this.system_index.has(system);
  }

  clear(): void {
    for (const nodes of this.label_systems.values()) {
      nodes.length = 0;
    }
    this.sorted_cache.clear();
    this.system_index.clear();
  }

  private run_label(
    label: SCHEDULE,
    ctx: SystemContext,
    delta_time: number,
  ): void {
    const sorted = this.get_sorted(label);
    for (let i = 0; i < sorted.length; i++) {
      sorted[i].fn(ctx, delta_time);
    }
    // Flush deferred changes after each phase so the next phase sees a consistent state
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

  /**
   * Kahn's algorithm: BFS-based topological sort.
   * Uses insertion_order as a stable tiebreaker (lower insertion order runs first).
   */
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
      // "this system runs before X" → edge: this → X
      for (const target of node.before) {
        if (!node_set.has(target)) continue;
        adjacency.get(node.descriptor)!.add(target);
        in_degree.set(target, in_degree.get(target)! + 1);
      }

      // "this system runs after X" → edge: X → this
      for (const dep of node.after) {
        if (!node_set.has(dep)) continue;
        adjacency.get(dep)!.add(node.descriptor);
        in_degree.set(node.descriptor, in_degree.get(node.descriptor)! + 1);
      }
    }

    // Seed the ready queue with all nodes that have zero in-degree.
    // Sort descending by insertion_order so pop() yields the lowest (earliest) first.
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
      // Re-sort after each addition to maintain insertion-order tiebreaking
      ready.sort((a, b) => insertion_order.get(b)! - insertion_order.get(a)!);
    }

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
