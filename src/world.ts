/***
 *
 * World - Unified ECS facade
 *
 * Composes Store + SystemRegistry + Schedule + SystemContext into a
 * single entry point that owns the full ECS lifecycle. External code
 * creates a World, registers components/systems, calls startup(),
 * then update(dt) each frame.
 *
 * Systems receive a SystemContext (not the World) — the World is not
 * exposed inside system functions.
 *
 ***/

import { Store } from "./store/store";
import { SystemRegistry } from "./system/system_registry";
import { Schedule, type SCHEDULE } from "./schedule/schedule";
import { SystemContext } from "./query/query";
import type { ComponentRegistry } from "./component/component_registry";
import type { EntityID } from "./entity/entity";
import type {
  ComponentDef,
  ComponentSchema,
  SchemaValues,
} from "./component/component";
import type { SystemConfig, SystemDescriptor } from "./system/system";
import type { SystemEntry } from "./schedule/schedule";

//=========================================================
// World
//=========================================================

export class World {
  private readonly store: Store;
  private readonly system_registry: SystemRegistry;
  private readonly schedule: Schedule;
  private readonly ctx: SystemContext;

  constructor() {
    this.store = new Store();
    this.system_registry = new SystemRegistry();
    this.schedule = new Schedule();
    this.ctx = new SystemContext(this.store);
  }

  //=========================================================
  // Component registration
  //=========================================================

  register_component<S extends ComponentSchema>(schema: S): ComponentDef<S> {
    return this.store.register_component(schema);
  }

  //=========================================================
  // Entity lifecycle
  //=========================================================

  create_entity(): EntityID {
    return this.store.create_entity();
  }

  /** Deferred destroy — entity stays alive until the next flush. */
  destroy_entity(id: EntityID): void {
    this.store.destroy_entity_deferred(id);
  }

  is_alive(id: EntityID): boolean {
    return this.store.is_alive(id);
  }

  get entity_count(): number {
    return this.store.entity_count;
  }

  //=========================================================
  // Component operations (immediate, for setup/spawning)
  //=========================================================

  add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: SchemaValues<S>,
  ): void {
    this.store.add_component(entity_id, def, values);
  }

  add_components(
    entity_id: EntityID,
    entries: { def: ComponentDef<ComponentSchema>; values: Record<string, number> }[],
  ): void {
    this.store.add_components(entity_id, entries);
  }

  remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
  ): void {
    this.store.remove_component(entity_id, def);
  }

  has_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
  ): boolean {
    return this.store.has_component(entity_id, def);
  }

  //=========================================================
  // Data access
  //=========================================================

  get components(): ComponentRegistry {
    return this.store.get_component_registry();
  }

  //=========================================================
  // System registration
  //=========================================================

  register_system(config: SystemConfig): SystemDescriptor {
    return this.system_registry.register(config);
  }

  add_systems(
    label: SCHEDULE,
    ...entries: (SystemDescriptor | SystemEntry)[]
  ): void {
    this.schedule.add_systems(label, ...entries);
  }

  remove_system(system: SystemDescriptor): void {
    this.schedule.remove_system(system);
    this.system_registry.remove(system.id);
  }

  //=========================================================
  // Execution
  //=========================================================

  /** Initialize all systems and run startup phases. */
  startup(): void {
    this.system_registry.init_all(this.store);
    this.schedule.run_startup(this.ctx);
  }

  /** Run update phases for one frame. */
  update(delta_time: number): void {
    this.schedule.run_update(this.ctx, delta_time);
  }

  //=========================================================
  // Cleanup
  //=========================================================

  /** Dispose all systems and clear the schedule. */
  dispose(): void {
    this.system_registry.dispose_all();
    this.schedule.clear();
  }
}
