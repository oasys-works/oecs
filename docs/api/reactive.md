# The reactive UI connection

> **Optional.** The `ECS` does not depend on a framework, and it never imports a UI library. This
> connection is three separate, optional entry points. Together they bring ECS state into a
> reactive UI **without** a full render in each frame. Import only what you use.

```
ECS ──observers──▶ @oasys/oecs/reactive-sync ──▶ @oasys/oecs/reactive ──▶ @oasys/oecs/solid ──▶ SolidJS
     (publish only the changed)  (reactive collections)   (signals kernel)      (adapter)
```

The parts compose, but each part also operates alone. You can use the kernel by itself, drive React
through `toExternalStore`, or connect the full chain into Solid.

## `@oasys/oecs/reactive` — the signals kernel

This is a reactive kernel with no dependencies. It is fine-grained and glitch-free, and it is the
same class of machine as the observer system of the ECS, at a finer level of detail. It pulls
values when a reader needs them. A recompute that gives an equal value starts nothing.

```ts
import { signal, computed, effect, batch } from "@oasys/oecs/reactive";

const [count, setCount] = signal(0);
const doubled = computed(() => count() * 2);
const stop = effect(() => console.log("doubled =", doubled()));  // runs now, and on each change
setCount(5);                     // the effect runs again → "doubled = 10"
batch(() => { setCount(6); setCount(7); });  // one flush → the effect runs one time
stop();                          // dispose of the effect
```

```ts
signal<T>(initial: T, eq?: (a: T, b: T) => boolean): readonly [() => T, (v: T) => void];
computed<T>(fn: () => T, eq?: (a: T, b: T) => boolean): () => T;
effect(fn: () => void): () => void;      // gives a function that disposes of it
batch(fn: () => void): void;             // put the writes together into one flush
untrack<T>(fn: () => T): T;              // read without a subscription
root<T>(fn: (dispose: () => void) => T): T;   // a manual scope for ownership
onCleanup(fn: () => void): void;         // register teardown with the owner in scope
```

- **`signal`** is a writable value. A write of the same value, by `eq`, which is `Object.is` by
  default, does nothing and starts nothing.
- **`computed`** is a derived value that the kernel calculates when a reader needs it. It
  recalculates on a read only when a dependency truly changed. A diamond shape in the graph
  resolves with one consistent recompute, which is what "glitch-free" means.
- **`effect`** runs one time immediately, to collect its dependencies. It then runs again when a
  tracked dependency changes.
- **`batch`** puts each write inside `fn` together into one flush.
- **`untrack`**, **`root`**, and **`onCleanup`** let you read and record no dependency, make a
  manual scope for teardown, and register cleanup functions. You need `root` and `onCleanup` only
  outside a
  framework adapter that owns the scope for you.

> [!WARNING]
> An effect that writes a signal that it reads causes a cascade. Past an internal limit, the flush
> **throws** ("did not settle"). An effect that throws does not damage the other effects: the
> kernel isolates each one, and it throws the first error again after the flush drains. A read
> inside a cycle of dependencies gives the *old* value, and it does not throw.

### Reactive collections

These give a channel for each key or each slot. So a reader of one key subscribes to that key
alone, which is `O(changed)`, and not `O(all)`.

```ts
reactiveMap<K, V>(eq?): ReactiveMap<K, V>;        // get/set/delete/has/size/keys
reactiveStruct<T>(initial, eq?): readonly [proxy: T, set: StructSetters<T>];  // fixed fields of different types
reactiveArray<T>(initial?, eq?): ReactiveArray<T>;  // get/set/push/pop/splice/length/snapshot/reconcile
```

- **`reactiveMap`** is a collection with keys. A reader of key `K` starts again only when `K`
  changes. `reactiveArray.reconcile(next)`, and the signal for each field in `reactiveStruct`, give
  the same fine level of detail for ordered data and for data with a fixed shape.

> [!WARNING]
> **Give an `eq` function that compares content when the values are objects.** Under the default
> `Object.is`, a projection that gives a new object in each tick compares as unequal each time, and
> it starts each subscriber in each frame. Use `shallow` from `reactive-sync`, or write your own
> comparator. For `reactiveMap`, note that `undefined` means "absent": use `delete`, and not
> `set(key, undefined)`. For `reactiveArray`, a `set(i)` call that is out of range does nothing,
> and it gives a warning in development. To make the array longer, use `push`, `splice`, or
> `reconcile`.

### Interoperation with a framework

```ts
subscribe<T>(accessor: () => T, onChange: (value: T) => void): () => void;
toExternalStore<T>(accessor: () => T): { subscribe(cb): () => void; getSnapshot(): T };
```

`subscribe` calls `onChange` a maximum of one time for each set of changes that the kernel put
together. It does not call it at the time of the subscription, so read the initial value yourself.
`toExternalStore` gives the exact shape that `useSyncExternalStore` in React needs. Its snapshot
keeps the same reference between two changes, so React does not loop.

## `@oasys/oecs/reactive-sync` — the bridge from the ECS to the kernel

This drains the ECS [observers](./observers.md) into reactive collections. In each tick it
publishes **only the changed** entities and columns, which is `O(changed)`. Each `sync*` function
gives you a `dispose()` function, and it sets the initial values synchronously at registration.

```ts
import { syncComponentToMap, shallow, batchedUpdate } from "@oasys/oecs/reactive-sync";

const positions = syncComponentToMap(ecs, Pos, (row) => ({ x: row.field("x"), y: row.field("y") }),
  { eq: shallow });               // → positions.map : ReactiveMap<EntityID, {x,y}>

batchedUpdate(ecs, 1 / 60);        // = batch(() => ecs.update(dt)) — one tick, one UI flush
```

```ts
syncComponentToMap<S, V>(ecs, def, project, opts?): EcsMapSync<V>;         // one component → a map
syncFieldsToMap<S, F>(ecs, def, fields, opts?): EcsMapSync<{…}>;            // a shorter form: a field list → {field: value}
syncJoinToMap<V>(ecs, defs, project, opts?): EcsMapSync<V>;                 // a join of several components (never out of date)
syncSingletonToStruct<S, F>(ecs, def, eid, fields, opts?): SingletonStructSync;  // one entity → a reactiveStruct
syncSingletonToArray<S>(ecs, def, eid, fields, opts?): SingletonArraySync;       // one entity → a reactiveArray
shallow(a, b): boolean;            // the recommended eq for a projection that gives an object
batchedUpdate(ecs, dt): void;
```

- **`syncComponentToMap`** is the primary function. With `grain: "entity"`, the default, it drains
  the dirty rows for each entity. With `grain: "column"`, it examines the archetype columns, which
  is better for a component that changes frequently. If the projection reads a *second* component,
  the result becomes out of date. Use `syncJoinToMap` instead, because it subscribes to each
  definition.
- **`syncFieldsToMap`** is a shorter form with an automatic `shallow` comparator. It is convenient,
  but it builds a new object for each dirty row. So, when the changes are frequent, use
  `syncComponentToMap` with a scalar projection, or with a comparator that you write.
- **The singleton functions** put the component of one entity into UI state, for example network
  status, frame rate, or a wave timer.

> [!WARNING]
> A projection that gives a new object, under the default `Object.is`, starts each subscriber in
> each frame. Give `eq: shallow`, or use a scalar projection. This is the most frequent error with
> `reactive-sync`.

## `@oasys/oecs/solid` — the SolidJS adapter

This brings the values of the kernel into SolidJS. **`solid-js` is an optional peer dependency**,
and only this entry point imports it.

```text
import { fromKernel, fromKernelMap } from "@oasys/oecs/solid";

fromKernel<T>(accessor: () => T): Accessor<T>;                       // a kernel value → a Solid signal
fromKernelMap<K, V>(map: ReactiveMap<K, V>): { keys; cell(key) };    // a collection with keys → <For>
fromKernelStruct<T>(struct: T): T;                                   // a reactiveStruct → Solid tracking for each field
fromKernelArray<T>(arr: ReactiveArray<T>): Accessor<readonly T[]>;   // a reactiveArray → <Index each>
```

```tsx
const view = fromKernelMap(positions.map);
<For each={view.keys()}>{(id) => {
  const p = view.cell(id);           // subscribes to the row of this entity alone
  return <circle cx={p()?.x} cy={p()?.y} />;
}}</For>
```

> [!WARNING]
> Key a Solid `<For>` on the stable `EntityID`. Never key it on a value object that changes in each
> tick. Use the keyed `<For>` for a collection of entities. Use `<Index>` only for a positional
> array, through `fromKernelArray`. Call each `fromKernel*` function inside a component or inside
> `root`, so that teardown has an owner.

## See also

- [observers](./observers.md) — what `reactive-sync` drains
- [change detection](./change-detection.md) — the dirty tracking behind `O(changed)`
- [the host write path](./host-write-seam.md) — the write side (UI to ECS) that pairs with this
  read side
- [editor](./editor.md) — undo, redo, and field handles, which use both sides
