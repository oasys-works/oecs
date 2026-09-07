# vs, a comparison of oecs and seven other ECS libraries

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
cd bench/vs && npm ci             # install the pinned versions first, refer to the note below
node bench/vs/vs.mjs --null       # calibrate first: each ratio must show approximately 1.00×
node bench/vs/vs.mjs --rounds 10  # make the comparison (a multiple of the number of entries, now ten)
node bench/vs/probe-query.mjs     # find if the cost is the loop or the acquisition of the query
node bench/vs/probe-oecs.mjs      # find why oecs is slow for access by id and for fragmented data
node bench/vs/probe-sparse-iter.mjs   # find where the `oecs-sparse` entry loses the iteration rows
node bench/vs/probe-sparse-spawn.mjs  # find where the `oecs-sparse` entry loses the spawn row
```

**Use `npm ci`, and do not use `npm install`.** `package.json` gives a `^` range for
becsy, koota, miniplex and thyseus. Therefore a plain install can give versions that
differ from the versions in the table above. The table is then a record of a
different measurement. `package-lock.json` pins the documented versions. The thyseus
package is a dependency of this directory, but it is not an entry in the table.
Refer to the note about thyseus below.

The tool uses each other library as its author released it, and it makes no
changes. The libraries come from `bench/vs/node_modules`. For oecs, the tool starts
`scripts/build.mjs`, which is the build of the package. It measures the artifact
that npm gives to a user. Thus the development guards are not in the measured code.
Both sides of the comparison have the form of a released build.

An earlier method made a bundle of `src/` with esbuild. That bundle gave `__DEV__`
the value of the release. But it kept each guard as a branch that is always false.
Therefore the guards were in the measured code, and they made each function larger.
The table below comes from a run with the artifacts. The position of oecs in
each row is the same as the position that the earlier method gave. The guards
changed the values, but they did not change the order.

## The two oecs entries

oecs takes part twice, because it offers two storage layouts, and each row of the table favours
one of them.

- **`oecs`** keeps its components packed by archetype, which is the layout for a column loop. This
  is the entry that the table above describes.
- **`oecs-sparse`** keeps the same data in sparse components: one typed array for each field,
  indexed by entity, outside the archetype. That is the layout of bitECS, wolf and piecs. So this
  entry is the equal comparison for the rows that read by id or that move membership. On the two
  iteration rows it walks the member list through `forEachEntity`. The driver of that walk,
  and not the layout, is what it pays for. Refer to the section about the sparse rows below. Each
  entity carries a dense tag, `Slot`. The sparse walk then has a dense base to filter against,
  which is the documented form.

Read the two entries as one library with a choice for each component, and not as two competitors.

## Results

Run the tool to get the values. This file records the positions only. A value is
correct for one machine, one version of Node and one release. The last
run used node v24.12.0, Darwin arm64 and **oecs 0.6.0**. The 0.6.0 run gave every position the 0.5.4 run gave. The `raw` row is a limit,
and not an entry in the comparison.

| case | the fastest library | `oecs` (packed) | `oecs-sparse` (id-indexed) |
| --- | --- | --- | --- |
| `iter2`, 2-comp SoA update | harmony | second | last but one |
| `iter_frag`, over 64 archetypes | harmony | second | last |
| `read_by_id`, one field by id | bitECS, wolf and piecs, together at the `raw` limit | last | sixth, near the limit |
| `has`, membership by id | **oecs** | first | second |
| `spawn`, create with 2 comps | piecs, with oecs inside the calibration spread | second | third |
| `despawn` | piecs | second | third |
| `add_remove`, tag on or off | **oecs-sparse** | third, with piecs inside the calibration spread | first |

**Read the two oecs rows as one library with a choice for each component.** The packed
entry is second on the two iteration rows and on `spawn` and `despawn`. It is first on
`has`, and last on `read_by_id`. The id-indexed entry is first on `add_remove`, second on `has`, and near
the raw limit on `read_by_id`. It loses the iteration rows in the driver of `forEachEntity`, and
the `spawn` row in the row build of `addSparse`. `probe-sparse-iter.mjs` and
`probe-sparse-spawn.mjs` split both costs, and the section about the sparse rows below gives the
result. A component that a system reads by id belongs in the second layout. A component
that a system sweeps belongs in the first.

Three other libraries give a better result than a packed oecs component in some row. The
harmony entry is faster for iteration, and piecs is faster for `spawn` and `despawn`. Both
had their last release in 2022. The `spawn` gap to piecs is inside the spread of the null
run. The `add_remove` gap between the packed entry and piecs is also inside that spread.
Both rows are ties. Three libraries read by id at the raw limit: bitECS, wolf and piecs. An
id-indexed layout gives that limit, and a packed layout cannot.

Compare oecs only with the libraries that have **maintenance**, which are bitECS, koota
and becsy. The packed entry is then first in six of the seven rows, and last in
`read_by_id`. The id-indexed entry is first in `read_by_id` against koota, and second
against bitECS.

Run `node bench/vs/vs.mjs --null` before you read a row. The spread of the null run is the
noise floor of that row. On this machine the `despawn` and `add_remove` rows had a wide
floor in the last run.

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
  user, but it is not a call to the library. It prices the layout of miniplex,
  and this row prices a membership API. The table reports wolf-ecs as absent in the
  same row. That library has no membership call at all. The miniplex library has
  one, so the row uses it. The two libraries then get the same rule. With the
  property read instead, miniplex is first in this row by a large factor.
  `cases.mjs` records both.
  - A miniplex query connects to the world only when something reads its entities,
    and `has()` does not do that read. Therefore the case must call `connect()`.
    Without it, every `has()` gives `false`, and the row measures a search of an
    empty bucket. The cross-library checksum found this condition.
- **becsy operates far from its design point.** Component access uses an accessor
  for each entity, and becsy also makes checks against the declared access. The
  becsy library exists to run systems on more than one core. This measurement uses
  one thread and one system. Therefore its `iter2` value shows the cost of the
  accessor API of becsy. It is not a statement about the library. The table has
  `iter2` only. The notes about becsy in `cases.mjs` give the reason. The other six
  cases need entity references that the test must hold.
- **harmony is faster than oecs in both iteration rows.** The library
  gives the caller an array of column tuples for each archetype. The caller can
  read the array by index. Therefore harmony makes no cursor for each chunk. A
  library with maintenance could use the same method and get the same result. Refer
  to `probe-oecs.mjs`.
- **The table does not include thyseus 0.18.0.** We installed thyseus and made
  probes. The struct components of thyseus need its compiler transform, and we did
  not make them operate without it. A value from a different method would measure
  that method.

## The two rows that need an explanation

**`read_by_id`: oecs is much slower, and one part of the cause is the layout.**
The libraries bitECS, wolf-ecs and piecs put component data in an array. The index
is the entity id. Therefore a read of one field of entity `e` is `x[e]`. This is the raw
baseline, and all three libraries operate at it. oecs puts the rows together in each
archetype. Therefore the same read must first find the archetype and the row of the
entity. That operation cannot have a cost of zero. So oecs cannot reach the raw
baseline.

This row reads the ids in the sequence of their creation, and its name says so. The
name was `random_read` before, and that name was not correct: no implementation
makes a permutation of the ids. A measurement with one seeded permutation, equal for
every library, gives this result. The libraries that use the entity id as the index
show no change at all. The oecs entry becomes a little slower. At N = 10,000 the
arrays of those libraries fit in the cache. Thus the sequence of the reads makes no
difference to them. But oecs must find the archetype and the row for each entity. A
scattered sequence makes that operation more expensive. Therefore a permutation
would make the difference in this row larger, and not smaller. The case keeps the
sequential form. `bench/suite.mjs` measures the same paths in the same
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

This row measured `getField` before. That was the incorrect path for a comparison.
The rule of this file is that each library uses the method that its own
documentation recommends. The bitECS library puts its column outside the loop. A
cursor is the equivalent, and it made this row much faster.

The iteration rows show the other effect of the same layout. The libraries that use
the entity id as the index need memory in proportion to the highest entity id. The
oecs world needs memory in proportion to the number of entities that are alive.

**`iter_frag`: fragmentation increases the cost for oecs, and the cause is the
construction of a cursor for each chunk.** `probe-oecs.mjs` puts an equal number of
rows into 1 archetype, then into 8 archetypes, then into 64 archetypes. With an
empty callback body, the cost stays near zero at each of the three shapes.
Therefore the dispatch and the callback are not the cost. With `x[i] += 2` in the
body, the cost increases with each step. The cause is the construction of the
`cols.mut(Pos)` cursor for each chunk. The test does this one time for each
archetype, and not one time for the pass. The harmony library is faster in this row.
It gives the caller an array of tuples for each archetype. It makes no cursor.

## The two sparse rows that need an explanation

**`iter2`, the `oecs-sparse` entry: the driver of `forEachEntity` is the cost, and not the
layout.** `probe-sparse-iter.mjs` runs the entry, then the same driver with an empty callback.
It then runs a loop over the member list of `Pos` with the filters the query keeps. It then
runs the same loop without the filters. The empty callback costs about as much as the real
one. So the body of `forEachSparseMatch` is the loss. It pays for the loops over the term
lists, and for the read of the generation. It also composes an id for each entity. The loop
with no filter ties bitECS, wolf and piecs. So the gather through the id list is not the loss.
A loop that keeps the filters of the query recovers about half, and it stays far behind those
three libraries. Their query returns a member list. The library keeps that list up to date on
each add and remove. A filter at each entity cannot reach that. A tighter iteration form
closes half of the gap. The rest needs a member list that the world maintains for the
intersection. The other option is a walk over one store with no dense term.

**`spawn`, the `oecs-sparse` entry: the row build by field name is the cost, and not the number
of calls.** `probe-sparse-spawn.mjs` spawns the `Slot` template alone, then with one `addSparse`,
then with two. It then spawns with two direct calls to `setRow`. These calls skip the liveness
check and the store lookup. It spawns last with two joins and positional column writes. Each
`addSparse` costs about as much as the whole packed spawn. The direct calls to `setRow` recover
about a quarter of the excess. A batched `addSparse` with the same values object can recover no
more. The
positional writes bring the sparse spawn level with the packed one. The difference is the lookup
of each field by name in the values object, inside `SparseComponentStore.setRow`. A template that
carries sparse defaults as a positional row would close this row.

Both probes read private fields of the store, so each floor is a little lower than an API can
reach. Run them after `vs.mjs` made the artifact. Each variant runs in its own process.

## Rules for an equal comparison

Each rule below changed a value. Therefore this file records them.

- **One process for each measurement of a library and a case.** All the ECS
  libraries in one process give many shapes at each measured call site. No library
  operates in this condition. `bench/ab/child.mjs` uses the same rule.
- **Each round changes the sequence of the libraries.** Thus no library is always
  first, when the CPU is cold. No library is always last, when the CPU is hot. The
  tool shows the median of the best value of each round. It also shows the
  spread from the minimum value to the maximum value.
  - **Use a number of rounds that is a multiple of the number of entries.** The
    rotation moves the start of the list by one position for each round. The list
    holds ten entries. Therefore each entry gets an equal share of the positions
    only at 10 rounds, 20 rounds, and so on. At the default of 5 rounds the last
    five entries are never first. Two of those five, harmony and piecs, give a
    better result than oecs in some row. The tool gives a warning for that
    condition, and it names the multiple to use. An earlier measurement at 5 rounds and at 9 rounds moved no
    ratio outside its own spread, so the effect is small here. Use the multiple
    anyway, because the claim above is then true and not approximately true.
- **Calibration, at the full width of the comparison.** `--null` runs oecs in every
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
  `addComponents`. The oecs entry reads `read_by_id` with a **cursor** that the tool
  makes outside the loop, and not with `getField`. The bitECS library also puts its
  column outside its loop, and the cursor is the equivalent operation. This change made the
  `read_by_id` row much faster, and it is the largest single change in this list.
  Two separate calls to `addComponent` made piecs much slower than `prefabricate`.
  The same change made bitECS only a little slower. Thus the change to bitECS is
  inside the noise, but the change to piecs is not. The test reads harmony by
  index, and not with the `for..of` loop in the README of harmony. The
  allocation of the iterator costs much more. If a library has no API for a case,
  the table shows `none`. The test writes no substitute, because a substitute measures
  itself. Where a library has the call, the case must use the call. Refer to the note
  about `Query.has` of miniplex above.
- **An absent case and a failed measurement are different.** A library with no API
  for a case shows `none (no API for this case)`. A measurement that did not run shows
  `✗ FAILED`, with the reason. The tool then says that the table is not complete.
  The tool put both conditions into one message before. Therefore a library that was
  not installed read as a gap in the design of that library.
- **Checksums across the libraries.** Four of the seven cases add a value after an
  equal number of runs. All the libraries must agree about the sum. The two
  iteration cases add the column that they change. `read_by_id` and `has` add their
  own results. Both must give exactly `20 × N` for every library. Each library
  seeds the field to `1` on all N entities. Each library holds the component on
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
    it. This error appeared on the first run after the two new checksums, which is
    the reason to have them.

  All three errors were mine, and all three made oecs look better than it is. The
  timings showed none of them.

  `spawn`, `despawn` and `add_remove` still have no checksum. The only check for
  those three is that they do not throw an error.

## What this comparison does not measure

- **Only the functions that all the APIs have.** Relations, observers, change
  detection, snapshots, determinism and the host write seam have no equivalent in
  most of the seven competitors. A comparison of features must include them, but
  this comparison cannot. The bitECS 0.4 release is the only competitor with its own
  relations and observers.
- **Checksums cover 4 of the 7 cases**, the two iteration rows, `read_by_id` and
  `has`. For the three structural cases, the only check is that they do not throw an
  error.
- **One machine, one version of Node, N = 10,000, one thread.** The comparison uses
  no browser and no Deno. It also uses no larger number of entities, where the
  behaviour of the allocator is the largest cost.
- **The values above come from the working tree**, and not from HEAD. The tool used
  `--from`, and the version was 0.5.4 before its release. Use `--from` again to
  measure a different checkout.
