/***
 * Event — Typed event channels with SoA storage.
 *
 * Events are fire-and-forget messages that systems emit within a frame
 * and other systems can read during the same frame. They are auto-cleared
 * at the start of each update cycle.
 *
 * Events use SoA (Structure of Arrays) layout matching the component
 * pattern: each field is a separate number[] column, and a shared reader
 * object exposes named field arrays plus a length property.
 *
 * Signals are zero-field events — they carry no payload, just a count
 * of how many times they were emitted.
 *
 * Usage:
 *
 *   const Damage = world.register_event(["target", "amount"] as const);
 *   ctx.emit(Damage, { target: entityId, amount: 50 });
 *
 *   const dmg = ctx.read(Damage);
 *   for (let i = 0; i < dmg.length; i++) {
 *     const target = dmg.target[i];
 *     const amount = dmg.amount[i];
 *   }
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";
import type { ComponentFields, ColumnsForSchema } from "./component";

export type EventID = Brand<number, "event_id">;
export const as_event_id = (value: number) =>
  validate_and_cast<number, EventID>(
    value,
    is_non_negative_integer,
    "EventID must be a non-negative integer",
  );

// Phantom symbol for the field schema — never exists at runtime.
declare const __event_schema: unique symbol;

export type EventDef<F extends ComponentFields = ComponentFields> =
  EventID & { readonly [__event_schema]: F };

/** Reader view over an event channel's SoA columns. */
export type EventReader<F extends ComponentFields> = { length: number } & ColumnsForSchema<F>;

export class EventChannel {
  readonly field_names: string[];
  readonly columns: number[][];
  readonly reader: EventReader<any>;

  constructor(field_names: string[]) {
    this.field_names = field_names;
    this.columns = [];
    for (let i = 0; i < field_names.length; i++) {
      this.columns.push([]);
    }

    // Build the reader object: { length: 0, [field]: columns[i] }
    const reader: any = { length: 0 };
    for (let i = 0; i < field_names.length; i++) {
      reader[field_names[i]] = this.columns[i];
    }
    this.reader = reader;
  }

  emit(values: Record<string, number>): void {
    const names = this.field_names;
    const cols = this.columns;
    for (let i = 0; i < names.length; i++) {
      cols[i].push(values[names[i]]);
    }
    this.reader.length++;
  }

  /** Emit a signal (zero-field event). */
  emit_signal(): void {
    this.reader.length++;
  }

  clear(): void {
    this.reader.length = 0;
    const cols = this.columns;
    for (let i = 0; i < cols.length; i++) {
      cols[i].length = 0;
    }
  }
}
