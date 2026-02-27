/***
 * Resource — Typed singleton storage with SoA layout.
 *
 * Resources are global singletons that don't belong to any entity.
 * Think: time, input state, camera config, game settings.
 *
 * A ResourceChannel is a single row of SoA columns — same layout as
 * an EventChannel but with exactly one entry (row 0) instead of a
 * growable array. The reader exposes scalar values via property
 * getters on column[0], so `time.delta` returns a number, not an array.
 *
 * Usage:
 *
 *   const Time = world.register_resource(["delta", "elapsed"] as const, { delta: 0, elapsed: 0 });
 *   ctx.set_resource(Time, { delta: dt, elapsed: total });
 *   const time = ctx.resource(Time);
 *   // time.delta → number, time.elapsed → number
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";
import type { ComponentFields } from "./component";
import { RESOURCE_ROW } from "./utils/constants";

export type ResourceID = Brand<number, "resource_id">;
export const as_resource_id = (value: number) =>
  validate_and_cast<number, ResourceID>(
    value,
    is_non_negative_integer,
    "ResourceID must be a non-negative integer",
  );

declare const __resource_schema: unique symbol;

export type ResourceDef<F extends ComponentFields = ComponentFields> =
  ResourceID & { readonly [__resource_schema]: F };

export type ResourceReader<F extends ComponentFields> = {
  readonly [K in F[number]]: number;
};

export class ResourceChannel {
  public readonly field_names: string[];
  public readonly field_index: Record<string, number>;
  public readonly columns: number[][];
  // any: type-erased storage — channel is stored in Map<number, ResourceChannel>, F is lost
  public readonly reader: ResourceReader<any>;

  constructor(field_names: string[], initial: Record<string, number>) {
    this.field_names = field_names;
    this.field_index = Object.create(null);
    this.columns = [];
    for (let i = 0; i < field_names.length; i++) {
      this.field_index[field_names[i]] = i;
      this.columns.push([initial[field_names[i]] ?? 0]);
    }

    // any: partially-constructed ResourceReader<F> — dynamically assigned getters become mapped type
    const reader: any = Object.create(null);
    const cols = this.columns;
    for (let i = 0; i < field_names.length; i++) {
      const col = cols[i];
      Object.defineProperty(reader, field_names[i], {
        get() {
          return col[RESOURCE_ROW];
        },
        enumerable: true,
      });
    }
    this.reader = reader;
  }

  public write(values: Record<string, number>): void {
    const names = this.field_names;
    const cols = this.columns;
    for (let i = 0; i < names.length; i++) {
      if (names[i] in values) cols[i][RESOURCE_ROW] = values[names[i]];
    }
  }

  public read_field(field_index: number): number {
    return this.columns[field_index][RESOURCE_ROW];
  }

  public write_field(field_index: number, value: number): void {
    this.columns[field_index][RESOURCE_ROW] = value;
  }
}
