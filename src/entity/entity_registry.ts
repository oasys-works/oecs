/***
 *
 * EntityRegistry - Allocates and recycles generational entity IDs.
 * See docs/DESIGN.md [opt:1, opt:9] for ID layout and growth strategy.
 *
 ***/

import {
  EntityID,
  MAX_GENERATION,
  get_entity_generation,
  create_entity_id,
  get_entity_index,
} from "./entity";
import { ECS_ERROR, ECSError } from "../utils/error";

export const INITIAL_CAPACITY = 64;

export class EntityRegistry {
  private generations: number[] = new Array(INITIAL_CAPACITY).fill(0);
  private high_water = 0;
  private free_indices: number[] = [];
  private alive_count = 0;

  //=========================================================
  // Queries
  //=========================================================

  /** Number of entities currently alive. */
  public get count(): number {
    return this.alive_count;
  }

  /**
   * Check whether an ID refers to a living entity.
   *
   * Two conditions must hold:
   *   1. The index falls within the allocated range.
   *   2. The generation baked into the ID matches the
   *      current generation for that index.
   *
   * If the seat was recycled (generation bumped), any old
   * ID that still carries the previous generation will
   * correctly return false here.
   */
  public is_alive(id: EntityID): boolean {
    const index = get_entity_index(id);
    return (
      index < this.high_water &&
      this.generations[index] === get_entity_generation(id)
    );
  }

  //=========================================================
  // Mutations
  //=========================================================

  /**
   * Allocate a new entity.
   *
   * If there are recycled seats available we reuse one
   * (its generation was already bumped during destroy).
   * Otherwise we advance the high-water mark, growing
   * the backing buffer if needed, and start the fresh
   * seat at generation 0.
   */
  public create_entity(): EntityID {
    let index: number;
    let generation: number;

    if (this.free_indices.length > 0) {
      index = this.free_indices.pop()!;
      generation = this.generations[index]; // already bumped during destroy
    } else {
      index = this.high_water++;
      if (index >= this.generations.length) {
        this.grow();
      }
      this.generations[index] = 0;
      generation = 0;
    }

    this.alive_count++;
    return create_entity_id(index, generation);
  }

  /**
   * Destroy a living entity.
   *
   * Bumps the generation for this index (wrapping at
   * MAX_GENERATION) so that the old ID becomes stale,
   * then pushes the index onto the free list for reuse.
   *
   * Throws if the entity is already dead - destroying
   * the same ID twice is always a logic error.
   */
  public destroy(id: EntityID): void {
    const index = get_entity_index(id);
    const generation = get_entity_generation(id);

    if (index >= this.high_water || this.generations[index] !== generation) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_CANT_DESTROY_DEAD);
      return;
    }

    this.generations[index] = (generation + 1) & MAX_GENERATION;
    this.free_indices.push(index);
    this.alive_count--;
  }

  //=========================================================
  // Internal
  //=========================================================

  // optimization*9
  private grow(): void {
    const next = new Array(this.generations.length * 2).fill(0);
    for (let i = 0; i < this.generations.length; i++) next[i] = this.generations[i];
    this.generations = next;
  }
}
