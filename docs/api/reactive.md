# Reactive UI seam

> **Optional.** The `ECS` is framework-agnostic and never pulls a UI library. This seam is three separate, opt-in entry points that bridge ECS state into a reactive UI **without** re-rendering everything each frame. Import only what you use.

```
ECS ──observers──▶ @oasys/oecs/reactive-sync ──▶ @oasys/oecs/reactive ──▶ @oasys/oecs/solid ──▶ SolidJS
     (publish only dirty)   (reactive collections)   (signals kernel)      (adapter)
```

The pieces compose but stand alone: use the kernel by itself, drive React through `toExternalStore`, or wire the full pipe into Solid.

## `@oasys/oecs/reactive` — the signals kernel

A zero-dependency, fine-grained, glitch-free reactive kernel — the same machine class as the ECS observer system, at finer granularity. Values are pulled lazily; a recompute that produces an equal value bumps nobody.

```ts
import { signal, computed, effect, batch } from "@oasys/oecs/reactive";

const [count, setCount] = signal(0);
const doubled = computed(() => count() * 2);
const stop = effect(() => console.log("doubled =", doubled()));  // runs now, and on change
setCount(5);                     // effect re-runs → "doubled = 10"
batch(() => { setCount(6); setCount(7); });  // one flush → effect runs once
stop();                          // dispose the effect
```

```ts
signal<T>(initial: T, eq?: (a: T, b: T) => boolean): readonly [() => T, (v: T) => void];
computed<T>(fn: () => T, eq?: (a: T, b: T) => boolean): () => T;
effect(fn: () => void): () => void;      // returns a disposer
batch(fn: () => void): void;             // coalesce writes into one flush
untrack<T>(fn: () => T): T;              // read without subscribing
root<T>(fn: (dispose: () => void) => T): T;   // manual ownership scope
onCleanup(fn: () => void): void;         // register teardown with the owner in scope
```

- **`signal`** — a writable atom. A same-value write (per `eq`, default `Object.is`) is a no-op that wakes nobody.
- **`computed`** — a lazy derived value; recomputes on read only when a dependency actually changed. Diamonds resolve with one consistent recompute (glitch-free).
- **`effect`** — runs once immediately to collect dependencies, then re-runs when any tracked dep changes.
- **`batch`** — coalesce all writes inside `fn` into a single flush.
- **`untrack`** / **`root`** / **`onCleanup`** — escape tracking, create a manual teardown scope, register cleanups. `root`/`onCleanup` are only needed outside a framework adapter that owns scope for you.

> [!WARNING]
> An effect that writes a signal it reads cascades; past an internal cap the flush **throws** ("did not settle"). A throwing effect doesn't poison its siblings (each is isolated; the first error re-throws after the flush drains). A read inside a dependency cycle returns the *stale* value rather than throwing.

### Reactive collections

Per-key/per-slot channels, so a reader of one key subscribes to that key alone — `O(changed)`, not `O(all)`.

```ts
reactiveMap<K, V>(eq?): ReactiveMap<K, V>;        // get/set/delete/has/size/keys
reactiveStruct<T>(initial, eq?): readonly [proxy: T, set: StructSetters<T>];  // fixed heterogeneous fields
reactiveArray<T>(initial?, eq?): ReactiveArray<T>;  // get/set/push/pop/splice/length/snapshot/reconcile
```

- **`reactiveMap`** — keyed collection; a reader of key `K` wakes only when `K` changes. `reactiveArray.reconcile(next)` and `reactiveStruct`'s per-field signals give the same fine granularity for ordered and fixed-shape data.

> [!WARNING]
> **Pass a content `eq` for object values.** Under the default `Object.is`, a projection that returns a fresh object each tick compares unequal every time and wakes every subscriber every frame. Use `shallow` (from `reactive-sync`) or a hand-written comparator. For `reactiveMap`, note `undefined` is the absent sentinel — use `delete`, not `set(key, undefined)`. For `reactiveArray`, `set(i)` out of range is a no-op (dev warns) — grow with `push`/`splice`/`reconcile`.

### Framework interop

```ts
subscribe<T>(accessor: () => T, onChange: (value: T) => void): () => void;
toExternalStore<T>(accessor: () => T): { subscribe(cb): () => void; getSnapshot(): T };
```

`subscribe` fires `onChange` at most once per coalesced change (not on subscribe — read the initial value yourself). `toExternalStore` produces the exact `useSyncExternalStore` shape for React (its snapshot is referentially stable between changes, so React won't loop).

## `@oasys/oecs/reactive-sync` — ECS → reactive bridge

Drains ECS [observers](./observers.md) into reactive collections, publishing **only dirty** entities/columns each tick (`O(changed)`). Each `sync*` returns a `dispose()` and seeds synchronously on registration.

```ts
import { syncComponentToMap, shallow, batchedUpdate } from "@oasys/oecs/reactive-sync";

const positions = syncComponentToMap(ecs, Pos, (row) => ({ x: row.field("x"), y: row.field("y") }),
  { eq: shallow });               // → positions.map : ReactiveMap<EntityID, {x,y}>

batchedUpdate(ecs, 1 / 60);        // = batch(() => ecs.update(dt)) — one tick, one coalesced UI flush
```

```ts
syncComponentToMap<S, V>(ecs, def, project, opts?): EcsMapSync<V>;         // one component → map
syncFieldsToMap<S, F>(ecs, def, fields, opts?): EcsMapSync<{…}>;            // sugar: field list → {field: value}
syncJoinToMap<V>(ecs, defs, project, opts?): EcsMapSync<V>;                 // multi-component join (never stale)
syncSingletonToStruct<S, F>(ecs, def, eid, fields, opts?): SingletonStructSync;  // one entity → reactiveStruct
syncSingletonToArray<S>(ecs, def, eid, fields, opts?): SingletonArraySync;       // one entity → reactiveArray
shallow(a, b): boolean;            // the recommended eq for object projections
batchedUpdate(ecs, dt): void;
```

- **`syncComponentToMap`** — the workhorse. `grain: "entity"` (default) drains per-entity dirty rows; `grain: "column"` sweeps the archetype SoA for high-churn components. Reading a *second* component in the projection goes stale — use `syncJoinToMap`, which subscribes all defs.
- **`syncFieldsToMap`** — sugar with an automatic `shallow` eq; convenient, but builds a fresh object per dirty row, so for high churn prefer `syncComponentToMap` with a scalar/hand-`eq` projection.
- **singleton syncs** — for one entity's component as UI state (net status, FPS, wave timer).

> [!WARNING]
> A projection returning a fresh object under default `Object.is` wakes every frame — pass `eq: shallow` (or a scalar projection). This is the single most common reactive-sync mistake.

## `@oasys/oecs/solid` — SolidJS adapter

Bridges kernel values into SolidJS. **`solid-js` is an optional peer dependency** — only this entry pulls it.

```ts
import { fromKernel, fromKernelMap } from "@oasys/oecs/solid";

fromKernel<T>(accessor: () => T): Accessor<T>;                       // kernel value → Solid signal
fromKernelMap<K, V>(map: ReactiveMap<K, V>): { keys; cell(key) };    // keyed collection → <For>
fromKernelStruct<T>(struct: T): T;                                   // reactiveStruct → per-field Solid tracking
fromKernelArray<T>(arr: ReactiveArray<T>): Accessor<readonly T[]>;   // reactiveArray → <Index each>
```

```tsx
const view = fromKernelMap(positions.map);
<For each={view.keys()}>{(id) => {
  const p = view.cell(id);           // subscribes to this entity's row alone
  return <circle cx={p()?.x} cy={p()?.y} />;
}}</For>
```

> [!WARNING]
> Key a Solid `<For>` on the stable `EntityID`, never on a per-tick value object; use `<For>` (keyed) for entity collections and `<Index>` only for positional arrays via `fromKernelArray`. Call `fromKernel*` inside a component or `root` so teardown has an owner.

## See also

- [observers](./observers.md) — what reactive-sync drains
- [change detection](./change-detection.md) — the dirty tracking behind `O(changed)`
- [host-write seam](./host-write-seam.md) — the write side (UI → ECS) that pairs with this read side
- [editor](./editor.md) — undo/redo + field handles that combine both sides
