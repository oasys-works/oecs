/**
 * Reactive struct — per-field channels for a flat, fixed-shape record.
 *
 * The third collection shape after `reactiveMap`. A
 * struct has a FIXED set of fields of heterogeneous type, keyed by a known field
 * name; each declared field gets its own signal. Reading `proxy.field` inside a
 * tracked scope subscribes to that field *alone*, so a per-frame write of an
 * unchanged field (the no-op skip) wakes nobody and a changed field wakes only its
 * readers — never the whole struct. There is no structure signal (the field set
 * never changes), which makes it the cheapest of the shapes.
 *
 * Shape vs the others: use `reactiveMap` for a dynamic key set of homogeneous
 * values; use the struct for a fixed set of heterogeneous fields. The struct is the
 * read target for singleton/ephemeral UI state — net status + latency, FPS/mem,
 * wave timer — bridged from a singleton entity's component via
 * `@oasys/oecs/reactive-sync`'s `syncSingletonToStruct`, and
 * rendered through `@oasys/oecs/solid`'s `fromKernelStruct`.
 *
 * `eq` is per-field `Object.is` by default (matching `signal`); pass an `eq` map to
 * override individual fields (e.g. a content `eq` for an object-valued field).
 *
 * The returned proxy is ENUMERABLE: `Object.keys(proxy)` / spread yield the field
 * set so a consumer (e.g. `fromKernelStruct`) can discover the fields without being
 * told twice. Enumeration (`ownKeys` / `getOwnPropertyDescriptor`) never subscribes;
 * a property *read* (the `get` trap) does.
 */
import { signal } from "./kernel";
import { DEV } from "../dev_flag";

/** Per-field setters: `set.field(value)`. */
export type StructSetters<T> = { readonly [K in keyof T]: (v: T[K]) => void };
/** Optional per-field equality overrides. */
export type StructEq<T> = { readonly [K in keyof T]?: (a: T[K], b: T[K]) => boolean };

export function reactiveStruct<T extends object>(
	initial: T,
	eq: StructEq<T> = {}
): readonly [proxy: Readonly<T>, set: StructSetters<T>] {
	const reads = {} as { [K in keyof T]: () => T[K] };
	const set = {} as { -readonly [K in keyof T]: (v: T[K]) => void };
	// `Object.keys(initial) as Array<keyof T>`: `initial` is the trusted source of
	// the type, so every runtime key is a declared field of T (the keyof-boundary
	// cast — same one `services/client/.../ui_struct.ts` uses).
	const keys = Object.keys(initial) as Array<keyof T>;
	// Membership set for the proxy traps — O(1), and (unlike `k in reads`) it never
	// counts inherited `Object.prototype` keys (`toString`, `constructor`, …) as fields.
	const fieldSet = new Set<string | symbol>(keys as Array<string | symbol>);
	for (const k of keys) {
		const [get, write] = signal<T[keyof T]>(
			initial[k],
			eq[k] as ((a: T[keyof T], b: T[keyof T]) => boolean) | undefined
		);
		reads[k] = get;
		set[k] = write;
	}
	const proxy = new Proxy({} as T, {
		// A field read subscribes; a NON-field key must not throw. `JSON.stringify`
		// (`toJSON`), `await proxy` (`then`), `String(proxy)` (`Symbol.toPrimitive`)
		// and `for..of` (`Symbol.iterator`) all probe keys that aren't fields — fall
		// through to the (empty) target so they see the ordinary undefined/inherited
		// value instead of calling `undefined()`. `fieldSet` (not `k in reads`) so
		// inherited `toString`/`constructor` aren't mistaken for fields.
		get: (target, k) => (fieldSet.has(k) ? reads[k as keyof T]() : Reflect.get(target, k)),
		has: (_, k) => fieldSet.has(k),
		// Enumerable without subscribing: enumeration calls `ownKeys` +
		// `getOwnPropertyDescriptor`, never `get`, so `Object.keys(proxy)` returns
		// the field set and tracks nothing. The descriptor is an ACCESSOR whose `get`
		// reads the live signal, so `{...proxy}` / `Object.values(proxy)` /
		// `Object.getOwnPropertyDescriptor(proxy, f).value` see the current value
		// (a value-less descriptor would normalize to `value: undefined`). Non-field
		// keys report no own descriptor. The target is the empty (extensible) object,
		// so these configurable own keys satisfy the Proxy invariants.
		ownKeys: () => keys as Array<string | symbol>,
		getOwnPropertyDescriptor: (_, k) =>
			fieldSet.has(k)
				? { get: () => reads[k as keyof T](), enumerable: true, configurable: true }
				: undefined,
		// Writes go through `set.field(v)` — the proxy is a READ surface, and its
		// public type says so (`Readonly<T>`). The trap backs the
		// type for JS callers / policed casts: without it, a field assignment threw
		// an opaque "Cannot redefine property" (the accessor descriptor above has no
		// setter) and a TYPO'D field silently stuck on the hidden target as a
		// non-reactive value.
		set: (_, k) => {
			if (DEV) {
				throw new TypeError(
					`reactiveStruct proxy is read-only: use set.${String(k)}(value) — ` +
						`the setters tuple returned alongside the proxy`
				);
			}
			return false; // TypeError in strict mode, from the runtime
		}
	});
	return [proxy, set];
}
