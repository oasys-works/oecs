# vs — a comparison of oecs and seven other ECS libraries

This tool compares oecs with **bitECS 0.4.0**, **koota 0.6.6**, **becsy 0.15.5**,
**miniplex 2.0.0**, **harmony-ecs 0.0.12**, **wolf-ecs 2.1.3** and **piecs 0.4.0**.
The `raw` row uses raw typed arrays. It shows the best possible result, and it is
not an entry in the comparison. Use this tool only for local work. It is not a part
of the package.

The date of the last release is important when you read the table. Three of the
seven libraries had their last release in **May 2022**: harmony, wolf and piecs.

| library | version | last publish |
| --- | --- | --- |
| koota | 0.6.6 | 2026-05 |
| bitECS | 0.4.0 | 2025-12 |
| becsy | 0.15.5 | 2025-03 |
| miniplex | 2.0.0 | 2023-07 |
| harmony-ecs | 0.0.12 | 2022-05 |
| piecs | 0.4.0 | 2022-05 |
| wolf-ecs | 2.1.3 | 2022-05 |

```
cd bench/vs && npm ci             # install the pinned versions first — refer to the note below
node bench/vs/vs.mjs --null       # calibrate first: each ratio must show approximately 1.00×
node bench/vs/vs.mjs --rounds 9   # make the comparison (a multiple of the number of libraries)
node bench/vs/probe-query.mjs     # find if the cost is the loop or the acquisition of the query
node bench/vs/probe-oecs.mjs      # find why oecs is slow for access by id and for fragmented data
```

**Use `npm ci`, and do not use `npm install`.** `package.json` gives a `^` range for
becsy, koota, miniplex and thyseus. Therefore a plain install can give versions that
are different from the versions in the table above, and the table is then a record of
a different measurement. `package-lock.json` pins the documented versions. thyseus is
a dependency of this directory, but it is not an entry in the table — refer to the
note about thyseus below.

The tool uses each other library as its author released it, and it makes no
changes. The libraries come from `bench/vs/node_modules`. The tool makes a bundle
of oecs from `src/` in the worktree, with `__DEV__ = false`. Thus the development
guards are not in the measured code, because the released package also removes
them.

## Results

Run the tool to get the values. This file records the positions only, because a
value is correct for one machine, one version of Node and one release. The last
run used node v24.12.0, Darwin arm64 and **oecs 0.5.4**. The `raw` row is a limit,
and not an entry in the comparison.

| case | the fastest library | the position of oecs |
| --- | --- | --- |
| `iter2` — 2-comp SoA update | harmony | second |
| `iter_frag` — over 64 archetypes | harmony | second |
| `read_by_id` — one field by id | bitECS, wolf and piecs, together at the `raw` limit | last |
| `has` — membership by id | bitECS | second |
| `spawn` — create with 2 comps | piecs | second |
| `despawn` | piecs | second |
| `add_remove` — tag on/off | piecs | second |

**oecs is second in six of the seven rows, and last in one.** The row where oecs is
last is `read_by_id`, where every library is faster.

Three libraries give a better result than oecs in some row. harmony is faster for
iteration, and piecs is faster for the structural operations; both had their last
release in 2022. bitECS is faster for `has`, and bitECS has maintenance. Do not say
that only the libraries with no maintenance give a better result: `has` and
`read_by_id` are both counter-examples.

If you compare oecs only with the libraries that have **maintenance** — bitECS,
koota and becsy — oecs is **first in five of the seven rows**. It is second for
`has`, behind bitECS. It is last for `read_by_id`.

## How to read the unusual values

- **piecs keeps no component data.** `createComponentId()` gives a bit, and the
  caller keeps the arrays. Therefore a structural operation in piecs moves an
  entity id, but the same operation in oecs moves `f64` columns. The `read_by_id`
  value of piecs is a read from the array of the caller. No row is an equal
  comparison.
- **miniplex uses objects (AoS).** An entity is an object. Therefore `read_by_id` is
  only a read of a property, and it is very fast. For the same reason, iteration and
  `add_remove` are slow.
- **The `has` row of miniplex uses `Query.has(entity)`, and not a property read.**
  The two are very different, and the choice changes the position of miniplex in
  that row by a large amount. A property read is the natural idiom for a miniplex
  user, but it is not a call to the library: it prices the LAYOUT of miniplex, and
  this row prices a membership API. wolf-ecs is reported as absent in the same row,
  because wolf-ecs has no membership call at all. miniplex HAS one, so the row uses
  it, and the two libraries then get the same rule. With the property read instead,
  miniplex is first in this row by a large factor. `cases.mjs` records both.
  - A miniplex query connects to the world only when something reads its entities,
    and `has()` does not do that read. Therefore the case must call `connect()`.
    Without it, every `has()` gives `false`, and the row measures a search of an
    empty bucket. The cross-library checksum found this condition.
- **becsy operates far from its design point.** Component access uses an accessor
  for each entity, and becsy also makes checks against the declared access. becsy
  exists to run systems on more than one core. This measurement uses one thread and
  one system. Therefore its `iter2` value shows the cost of the accessor API of
  becsy. It is not a statement about the library. The table has `iter2` only. The
  notes about becsy in `cases.mjs` tell you why the other six cases need entity
  references that the test must hold.
- **harmony is faster than oecs in both iteration rows.** harmony
  gives the caller an array of column tuples for each archetype, and the caller can
  read the array by index. Therefore harmony makes no cursor for each chunk. A
  library with maintenance could use the same method and get the same result. Refer
  to `probe-oecs.mjs`.
- **The table does not include thyseus 0.18.0.** We installed thyseus and made
  probes. The struct components of thyseus need its compiler transform, and we did
  not make them operate without it. A value from a different method would measure
  that method.

## The two rows that need an explanation

**`read_by_id`: oecs is much slower, and one part of the cause is the layout.**
bitECS, wolf-ecs and piecs put component data in an array, and the index is the
entity id. Therefore a read of one field of entity `e` is `x[e]`. This is the raw
baseline, and all three libraries operate at it. oecs puts the rows together in each
archetype. Therefore the same read must first find the archetype and the row of the
entity. That operation cannot have a cost of zero. So oecs cannot reach the raw
baseline.

This row reads the ids in the SEQUENCE OF THEIR CREATION, and its name says so. The
name was `random_read` before, and that name was not correct: no implementation
makes a permutation of the ids. A measurement with one seeded permutation, equal for
every library, gives this result: the libraries that use the entity id as the index
show no change at all, and oecs becomes a little slower. At N = 10,000 the arrays of
those libraries fit in the cache, and thus the sequence of the reads makes no
difference to them. But oecs must find the archetype and the row for each entity, and
a scattered sequence makes that operation more expensive. Therefore a permutation
would make the difference in this row LARGER, and not smaller. The case keeps the
sequential form, because `bench/suite.mjs` measures the same paths in the same
sequence, and `cases.mjs` exists to be comparable with it.

But the layout does not explain the full difference. Run `bench/run.mjs access/` to
get the cost of each path, for a component with two `f64` fields. This is the order,
from the fastest to the slowest:

1. `ecs.cursorRead(Pos).at(id).x`
2. `ecs.refRead(Pos, id).x`
3. `ecs.getField(id, Pos, "x")`

The three paths do the same work, and they use the same layout. Therefore the
difference between them is not the layout:

- `getField` finds the archetype, the row **and the name of the field** at each
  call. `probe-fieldname.mjs` measures the operation to find the name alone. That
  operation is the largest part of the cost, and a flat `Int32Array` in its place
  is much cheaper.
- `refRead` finds the archetype and the row one time for each entity. But it makes
  an object for each entity, and that allocation costs as much as the operation it
  removes.
- A **cursor** finds the archetype and the row one time for each entity, and it
  allocates nothing. Therefore it is much faster than the other two.

This row measured `getField` before. That was the incorrect path for a comparison,
because the rule of this file is that each library uses the method that its own
documentation recommends, and bitECS puts its column outside the loop. A cursor is
the equivalent, and it made this row much faster.

The iteration rows show the other effect of the same layout. The libraries that use
the entity id as the index need memory in proportion to the highest entity id. oecs
needs memory in proportion to the number of entities that are alive.

**`iter_frag`: fragmentation increases the cost for oecs, and the cause is the
construction of a cursor for each chunk.** `probe-oecs.mjs` puts an equal number of
rows into 1 archetype, then into 8 archetypes, then into 64 archetypes. With an
empty callback body, the cost stays near zero at each of the three shapes.
Therefore the dispatch and the callback are not the cost. With `x[i] += 2` in the
body, the cost increases with each step. The cause is the construction of the
`cols.mut(Pos)` cursor for each chunk, because the test does this one time for each
archetype, and not one time for the pass. harmony is faster in this row, because it
gives the caller an array of tuples for each archetype. harmony makes no cursor.

## Rules for an equal comparison

Each rule below changed a value. Therefore this file records them.

- **One process for each measurement of a library and a case.** All the ECS
  libraries in one process give many shapes at each measured call site. No library
  operates in this condition. `bench/ab/child.mjs` uses the same rule.
- **Each round changes the sequence of the libraries.** Thus no library is always
  first, when the CPU is cold. No library is always last, when the CPU is hot. The
  tool shows the median of the best value of each round, and it also shows the
  spread from the minimum value to the maximum value.
  - **Use a number of rounds that divides by the number of libraries.** The rotation
    moves the start of the list by one position for each round. Therefore each
    library gets an equal share of the positions ONLY at 9 rounds, 18 rounds, and so
    on. At 5 rounds the last four libraries are never first, and three of those four
    are the libraries that give a better result than oecs. The tool gives a warning
    for that condition. A measurement at 5 rounds and at 9 rounds moved no ratio
    outside its own spread, so the effect is small here. Use the multiple anyway,
    because the claim above is then true and not approximately true.
- **Calibration, at the FULL WIDTH of the comparison.** `--null` runs oecs in every
  position of the library list, and it gives each position a different label. Each
  ratio must show approximately 1.00×. **The spread of that run is the noise
  threshold. A difference smaller than the threshold is not a result.** Run `--null`
  first, on the same machine and in the same session as the comparison.
  - The width matters, and this rule is the result of a measurement. `--null` ran
    only two positions before. Therefore a null round had a small part of the length
    of a real round, and it made much less heat. That short null gave a threshold
    that was approximately three times smaller than the threshold from a null run at
    the full width, and some rows of the table have margins inside that difference.
    Always calibrate at the width that you will measure.
  - The spread of `iter2` across all the libraries is only a little more than this
    threshold, so do not rank the iteration row without the calibration.
- **Each library uses the best method in its own documentation.** oecs makes
  entities from a `template`. Therefore piecs uses `prefabricate`, and bitECS uses
  `addComponents`. oecs reads `read_by_id` with a **cursor** that the tool makes
  outside the loop, and not with `getField`. bitECS also puts its column outside
  its loop, and the cursor is the equivalent operation. This change made the
  `read_by_id` row much faster, and it is the largest single change in this list.
  Two separate calls to `addComponent` made piecs much slower than `prefabricate`.
  The same change made bitECS only a little slower. Thus the change to bitECS is
  inside the noise, but the change to piecs is not. The test reads harmony by
  index, and not with the `for..of` loop in the README of harmony, because the
  allocation of the iterator costs much more. If a library has no API for a case,
  the table shows `—`. The test writes no substitute, because a substitute measures
  itself. Where a library HAS the call, the case must use the call: refer to the note
  about `Query.has` of miniplex above.
- **An absent case and a failed measurement are different.** A library with no API
  for a case shows `— (no API for this case)`. A measurement that did not run shows
  `✗ FAILED`, with the reason, and the tool then says that the table is not complete.
  The tool put both conditions into one message before. Therefore a library that was
  not installed read as a gap in the design of that library.
- **Checksums across the libraries.** Four of the seven cases add a value after an
  equal number of runs, and all the libraries must agree about the sum. The two
  iteration cases add the column that they change. `read_by_id` and `has` add their
  own results, and both must give exactly `20 × N` for every library: each library
  seeds the field to `1` on all N entities, and each library holds the component on
  all of them. This rule is necessary, because it found three incorrect results that
  looked correct:
  - bitECS `iter2` was **much too slow**. The storage arrays had the size of the
    number of entities, but bitECS gives ids from `1` to `N`. Therefore one index
    was outside the array. A store to an index outside a typed array does not throw
    an error, and it does not write the value. It removes the value, and it also
    makes the engine deoptimize the loop. `assertIdsFit` now makes a check for this
    condition.
  - koota `iter_frag` was **very much too slow**. The value
    of a koota entity holds a world id in its high bits, but the stores use only the
    id as the index. Therefore `store.x[packedValue]` read `undefined`, and it wrote
    into an array with holes in dictionary mode. `entities[i].id()` is the index in
    the documentation. The checksum gave NaN until the test used that method.
  - miniplex `has` measured **nothing**. A miniplex query connects to the world only
    when something reads its entities, and `has()` does not do that read. Therefore
    every call gave `false`, and the loop searched an empty bucket. The checksum was
    `0` where every other library gave `20 × N`. `connect()` in the setup corrects
    it. This error appeared on the FIRST run after the two new checksums, which is
    the reason to have them.

  All three errors were mine, and all three made oecs look better than it is. The
  timings showed none of them.

  `spawn`, `despawn` and `add_remove` still have no checksum. The only check for
  those three is that they do not throw an error.

## What this comparison does not measure

- **Only the functions that all the APIs have.** Relations, observers, change
  detection, snapshots, determinism and the host write seam have no equivalent in
  most of the seven competitors. A comparison of features must include them, but
  this comparison cannot. bitECS 0.4 is the only competitor with its own relations
  and observers.
- **Checksums cover 4 of the 7 cases** — the two iteration rows, `read_by_id` and
  `has`. For the three structural cases, the only check is that they do not throw an
  error.
- **One machine, one version of Node, N = 10,000, one thread.** The comparison uses
  no browser and no Deno. It also uses no larger number of entities, where the
  behaviour of the allocator is the largest cost.
- **The values above come from the working tree**, and not from HEAD. The tool used
  `--from`, and the version was 0.5.4 before its release. Use `--from` again to
  measure a different checkout.
