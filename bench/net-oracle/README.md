# net-oracle — a deterministic oracle for the simulation of the ECS

This is a simulation with a long run time. It reduces a net in lockstep against an independent
reference model, and it checks the result at each tick. It uses these mechanisms continuously, but
the unit tests use them one at a time only:

- **archetype migration** — rows that move between archetypes under continuous change
- **relation mutation** — a change of target on an exclusive relation, maintenance of the reverse
  index, sets of targets on a multi relation, and each of the three `onDeleteTarget` policies
  (`clear`, `delete`, and `orphan`)
- **observers** — structural `onAdd` and `onRemove` callbacks that maintain a derived set, and this
  includes an entity that a cascade destroys *indirectly*

Use this tool only for local work, as you use the other tools in `bench/`. It is not a part of the
package.

In this document, **pressure** means continuous use of a mechanism during a run.

```
node bench/net-oracle/run.mjs            # the selected suite, about 15 s
node bench/net-oracle/run.mjs --soak     # millions of rewrites
node bench/net-oracle/mutants.mjs        # show that the oracle finds a bug
pnpm exec vitest run bench/net-oracle    # a small part of the suite, for CI (about 5 s)
```

## The simulation

The simulation is **the interaction combinators of Lafont**. There are three types of agent (γ, or
`CON`; δ, or `DUP`; and ε, or `ERA`), and the six rewrite rules over their unordered pairs. There is
also an inactive `ROOT` agent, which holds the one free port of the net.

We did not select this workload because it is interesting. A cellular automaton such as the Game of
Life gives almost no pressure. Its set of entities is static: it creates no entity, it destroys no
entity, and it recycles no slot. An `Alive` tag gives one archetype edge only. The topology of the
neighbours is arithmetic on the index. Therefore such a workload uses **no relation**. It also has
no natural task for an observer. It would test only "change a tag, and run a query".

The reduction of an interaction net is the opposite. Each single rewrite:

- destroys 2 entities and creates a maximum of 4,
- changes the target of a maximum of 8 exclusive relations,
- writes about 12 `u8` columns,
- moves several rows between archetypes,

The simulation does each of these operations through `ctx.commands`. Each rewrite therefore causes a
flush, and each flush dispatches the observers. Thus each tick does work.

You can also check this system in a way that rules of our own invention do not permit. The system is
**strongly confluent**. It has linearity, it has binary interaction, and its rules have no
ambiguity. Together, these three properties give one result: each sequence of reductions reaches the
same normal form, and it uses the same number of rewrites. Therefore the oracle needs no reference
implementation, and it needs no known answer. Refer to layer 5 below.

## How the ECS stores the net (and why)

| Concept | The representation in the ECS | What it puts pressure on |
| --- | --- | --- |
| the type of an agent | the `CON`, `DUP`, `ERA`, and `ROOT` tags | 4 base archetypes |
| the *agent* at the end of a port | the `P0`, `P1`, and `P2` exclusive relations, with `onDeleteTarget: "clear"` | exclusive replacement and the reverse index, with a change of target at each rewrite |
| the *index* at the end of a port | the `Slot { s0, s1, s2: u8 }` column | a second, independent record of the same fact — the two must agree |
| membership of an active pair | the `Redex` tag, which **observers alone** maintain | the dispatch of a structural observer |
| bookkeeping of age | the `Fresh` tag, then `Age { ticks: i32 }` | more archetype edges; and an `i32` column that each tick writes |

We divide each wire across a *relation*, which says which agent, and a *column*, which says which
port. That division is deliberate: it records one fact two times, through two subsystems that have
no link. So a bug in either subsystem is a disagreement that we can detect.

### The layer for provenance

The ports of the net are all *exclusive* relations with `"clear"`. Therefore they do not use a large
part of the relation API. A second population of entities uses the remainder. This population is an
audit log of the rewrites, and it keeps its records by epoch. `prov.mjs` checks this log, and it uses
the same method that `ref.mjs` uses for the net:

| Concept | The representation in the ECS | What it puts pressure on |
| --- | --- | --- |
| one record for each rewrite | `Record { rule: u8 }` | a second changing population beside the agents |
| one epoch for each N ticks | `Epoch { index: i32 }` | entities with a long life among entities with a short life |
| a record to its epoch | `InEpoch`, exclusive, with **`onDeleteTarget: "delete"`** | **the cascade**: removal of an epoch destroys its records indirectly |
| a record to the agents that it created | `Produced`, **multi**, with `"clear"` | **sets of targets on a multi relation**, and a set that becomes smaller because a *target* died |
| an epoch to the earlier epochs | `EpochAncestors`, **multi**, with **`"orphan"`** | **the documented growth of the reverse index**, and `relations.compact()` |
| the set of live records | the `Record` observers **alone** maintain it | a record dies only indirectly. So this proves that a cascade runs `onRemove` for each entity that it destroys |

We keep a fixed window of epochs and destroy the remainder. That gives:

- a cascade for which we know exactly which entities it destroys;
- growth of the reverse index with a reclaim count that we know exactly;
- a live population with a limit, which is about 1000 records at the settings of the suite.

The key of an epoch is an **index** that only increases, and it is not an entity id. This choice
makes a model of the orphan policy possible. The orphan policy is *about* dead handles. A model that
recycled ids, as the ECS does, cannot find the difference between a dead handle and a handle that it
used again.

`--prov=0` removes the complete layer. `--epoch=N`, `--retain=N` and `--compact=N` adjust it.

`Fresh` and `Age` have no meaning for the interaction net. They exist to make the archetype graph
wider, and the suite reaches 13 different archetypes. The reference model copies their rules
exactly, so we check them, and we do not ignore them. The suite promotes `Fresh` in `PRE_UPDATE`,
one tick *after* it creates the agent. So `Fresh` is still present at the tick boundary where the
comparison happens. A promotion in the same tick would leave it untested.

## The layers of the oracle

1. **Self-consistency (the ECS alone).** Each port connects to a live port that connects back. A
   port that must not exist holds no relation and no slot. The reverse index of the relations agrees
   with the forward links. This layer needs no reference. So it continues to operate even with a
   bug in the mapping of ids in the harness itself.
2. **Lockstep (the ECS against the reference).** At each tick, and through a bijection of the ids,
   we compare the type of each agent, each port link, `Fresh` and `Age`, the census, and the count
   of wire loops. This finds the first tick that differs, and, with `--batch=1`, the first rewrite
   that differs.
3. **Canonical form (with no bijection).** We give new numbers to both nets by a breadth-first
   search from `ROOT`, and we compare them as strings. Therefore two nets agree if and only if they
   are isomorphic, for each possible allocation of the ids. The bijection of the ids cannot hide an
   error from this check.
4. **The queues of the observers.** We never calculate either derived set again. The `onAdd` and
   `onRemove` callbacks build both sets alone. We then compare each set against a new scan of the
   ECS *and* against the reference. That gives three independent derivations of one set. The
   `Redex` queue covers the usual structural transitions. The `Record` set covers *indirect*
   destruction, because a record dies only by a cascade.
5. **The cascade, the multi sets, and the orphan reclaim.** We predict exactly which entities the
   removal of an epoch destroys. We compare each `Produced` set of targets element by element, and we
   assert that its order increases. We check that `cascadeOf` predicts exactly which entities a
   despawn destroys. We then make three assertions about `compact()`. It reclaims an **exactly
   predicted** number of dead keys in the reverse index. A second call has no effect. It also makes
   no change to `stateHash`, and no change to any dangling forward link.
6. **A closed form.** You can calculate the number of rewrites of the generator for an erasure tree
   by hand (`2^(depth+1)`). Therefore the two implementations can be incorrect together, and the run
   still fails. This is the only layer that is external to BOTH implementations, and thus it is the
   deepest check that this harness has.
7. **Confluence, across the reduction orders.** `confluence()` reduces one net in several sequences,
   and it requires equal numbers of rewrites and equal normal forms.

   This layer sits BESIDE the closed form, and not above it. Layer 2 ends each order with an
   unconditional `compare(...)`, and that comparison is a complete structural isomorphism: a total
   bijection over the live agents, the type of each agent, each port link, `Fresh`, `Age` and the
   census. Each tick also asserts that the ECS applied the number of rewrites that the reference
   planned. Therefore each order already pins its ECS result to its own reference, in the same run.
   An ECS that loses a link, mis-migrates a row or drops an entity fails layer 2 first, whether or
   not the fault depends on the order.

   What is left is a comparison of the two REFERENCE results with each other. That is a real oracle,
   and it is the only layer that can find a fault that `spec.mjs` and `ref.mjs` hold together —
   which is the failure mode that a comparison of two implementations cannot see, because the two
   sides agree. Do not bill this layer as the deepest check of the ECS.
8. **Metamorphism of a snapshot.** We call `stateHash`, then `capture`, then we write ONE
   DETERMINISTIC BYTE into one slot of one agent, then we call `restore`. We then require the same
   hash and the same data. The write is what makes this check necessary. Without it, a `restore`
   that did nothing would pass the check, and it would give no error. The harness also requires the
   hash to MOVE for that one byte, and thus the layer cannot become vacuous without a report. One
   deterministic byte is enough, and it keeps the run reproducible from its seed alone.
9. **Floors for non-vacuity.** Assertions across the suite show that the run applied pressure. They
   cover the total number of rewrites, the ticks, the number of different archetypes, the number of
   observer calls, and the number of snapshots. They also show that each rule ran, and that a
   minimum of one net became 2 times larger. Without these floors, a harness that does nothing
   passes each layer above, and it shows nothing.

## Proof that the oracle finds a bug

`mutants.mjs` puts known ECS bugs into a **built bundle**, and never into the source tree, so that
it is safe against a working directory with changes. It requires that the oracle catches each one:

The table below names the mechanism that fires first, and it says whether that mechanism is an
ORACLE layer or an error of the ENGINE. An engine error is a real detection — the bug is fatal — but
it is not evidence about the oracle, and one of them exists only in a development build. `mutants.mjs`
now reports both counts, and it no longer treats every nonzero exit as a catch by the oracle.

| Mutant | Caught by | Kind |
| --- | --- | --- |
| swap-remove does not update the back pointer to the entity row | self-consistency, rewrite 4 | oracle |
| swap-remove moves the id but not the column data | symmetry of the links, rewrite 4 | oracle |
| the row plane reports a capacity that is more than its cached value | `StoreGrowError` at scale | engine |
| the row plane keeps a view of the entity ids that is out of date after a growth | the post-condition of the reserve on its own capacity (dev); self-consistency (prod) | engine (dev) / oracle (prod) |
| the reserve tests the term of the entity id, so a column never grows | the access check for an undeclared write, at scale (dev); an unrelated engine error (prod) | engine |
| an exclusive replacement leaves the old entry in the reverse index | the check of the reverse index, rewrite 4 | oracle |
| the structural dispatch never runs `onRemove` | the observer queue against a new scan, tick 2 | oracle |
| the structural dispatch runs `onAdd` two times | the invariant of the record observer | oracle |
| `"delete"` destroys the target but not its sources | the set of entities that the cascade destroys, tick 33 | oracle |
| `"clear"` leaves the relation on each source | the comparison of the `Produced` set, rewrite 4 | oracle |
| a forward set on a multi relation keeps a target with no link | the comparison of the `Produced` set, rewrite 4 | oracle |
| `targetsOf` on a multi relation loses its ascending sort | the assertion about the order, rewrite 4 | oracle |
| `compact()` reclaims entries but reports zero | the exact reclaim count | oracle |
| `compact()` also removes live targets | the exact reclaim count | oracle |

### The build that the battery uses

The battery uses a DEVELOPMENT build by default, because the guards of that build give more
mechanisms a chance to fire. The released package is a PRODUCTION build, so
`node bench/net-oracle/mutants.mjs --prod` runs the same battery against `__DEV__ = false`. Both
builds were measured, and this is the result:

| build | caught by an oracle layer | caught by an engine error | escaped |
| --- | --- | --- | --- |
| development | 11 of 14 | 3 of 14 | 0 |
| production | 12 of 14 | 2 of 14 | 0 |

Every mutant fails in the production build as well, so the choice of the default costs no coverage.
Two results need a note:

- `the row plane keeps a view of the entity ids that is out of date` moves from an engine assertion
  to the SELF-CONSISTENCY layer of the oracle in a production build. The DEV guard fires first in a
  development build, and thus it hides the oracle behind it.
- `the reserve tests the term of the entity id` is attributed above to the access check for an
  undeclared write. **That check is `if (DEV)`-gated end to end, and the released package does not
  contain it.** In a production build the mutant still fails, but through an unrelated engine error
  and not through an oracle layer. Read that row as "this bug is fatal", and not as "the oracle
  finds this bug".

The mutants on the growth path **escaped** the first set of mutants, because a small net does not
use more than the prepared capacity of its archetype. Therefore the set now includes `erase:14` and a
case for growth. This result also shows most clearly why the floors for non-vacuity are a part of the
harness, and not an addition of no value. `erase:14` alone still catches all three of these mutants.
Each other mutant fails on `erase:8`.

The set of mutants does not cover one path, and this is intentional. That path is the reserve that
synchronizes the row plane again if a growth **throws an error**. The oracle runs the heap profile,
where `growHandler` is null, and no code in the growth path throws an error. Therefore a mutant in
that path reports ESCAPED because no scenario reaches it, and not because no oracle covers it. Unit
tests (`archetype_row_plane.test.ts`) hold that path instead.

A mutant is a patch of text against the bundle that the build makes. Therefore **a change to the
mechanism of a mutant makes that mutant invalid, and gives no message**. `mutants.mjs` prevents this
condition. If a pattern does not match one time exactly, `mutants.mjs` reports the mutant as out of
date, and it counts the mutant as an escape. It does not skip the mutant.

Note the last two mutants. The oracle catches them only because it asserts the reclaim count
**exactly**. A test of `>= 0` would let both of them pass. It would also not find the interaction
between `compact()` and `restore()` below.

## One result that this file records

The exact assertion on the reclaim count found a behavior that is very unusual, and that is
correct: **a `compact()` call does not survive a snapshot and a restore.** The reverse index is
*derived*. So `restore` builds it again from the **forward** links that survive. Under `"orphan"`,
those links still carry the dangling dead handles, by design. Each key of a dead target that an
earlier `compact()` reclaimed therefore returns after a restore.

`relation.ts` documents that behavior, and the behavior is correct. We record it here because it is
the kind of interaction that a model that a person built from the documentation alone would get
wrong. `RefProv.noteRestored()` is where the harness accounts for it.

## The generators

| `--net=` | What it is | The answer |
| --- | --- | --- |
| `erase:D` | an eraser aimed at a binary `CON` tree of depth `D` | a **closed form**: `2^(D+1)` rewrites, 2 agents, and 0 loops |
| `dup:D` | a duplicator aimed at a tree of depth `D`, with one copy erased | pressure from growth; the reference is the oracle |
| `random:seed,nCon,nDup,nEra` | a random perfect matching over a random mixture of agents | the reduction has no known end; the behaviour is open |

Random nets are the only generator that makes `CON~CON` and `DUP~DUP` pairs. They are also the only
source of growth with no limit, because some seeds give more than 800,000 live agents.

## Known gaps

The harness does **not** cover the items below. This document states them, so that no person gives
more meaning to a successful run than it has:

- **The `onDisable` and `onEnable` observers.** No code here disables an entity. The division into
  enabled rows and disabled rows is a separate path for the placement of a row, and its observers run
  one time for each net transition in each drain. The harness uses neither the path nor the
  observers. `bench/fuzz.mjs` does disable an entity and enable an entity, but it does this from the
  host. Therefore *its* coverage also runs no observer. This is a true gap in both tools.
- **The `onSet` observers.** The harness uses the structural callbacks alone, which are `onAdd` and
  `onRemove`. `onSet` is derived change detection, with its own paths for archetype granularity and
  entity granularity, and this includes the dirty list for each row that entity granularity turns
  on. The harness drives none of that.
- **The `changed()` queries.** The harness writes the `Slot` and `Age` columns constantly, so the
  engine *does set* the change-detection ticks. But nothing reads them.
- **`hierarchy()` past depth 1, and `maxDepth`.** The `InEpoch` tree goes from an epoch to a record.
  So the harness checks `ancestorsOf`, `cascadeOf`, and `hierarchy`, but over chains of two
  levels alone. A deep chain, truncation by `maxDepth`, and the `RELATION_CYCLE` guard are
  untested. The assertion on `hierarchy` checks the COUNT of the walk and the epoch of each entity
  that it yields. It cannot check that a parent comes before its children: the query selects
  `Record` entities, and a parent is an `Epoch` entity, so no parent is in the result set.
- **A dead key in the reverse index of a port relation.** `assertSelfConsistent` compares
  `sourcesOf(e, P[p])` for the LIVE agents alone. Therefore an entry that stays in the reverse index
  under a key that names a DEAD entity is not reached, for `P0..P2`. The `relation-reverse-leak`
  mutant is caught, but that mutant leaves the old entry on a target that is still live, which is a
  different shape. Dead-key leakage has cover for `EpochAncestors` alone, through the prediction of
  the orphan reclaim count. A mutant that skips the deletion of a reverse key when a `"clear"`
  target dies would show whether this gap is reachable.
- **The float columns, and the non-deterministic world profile.** A deterministic world rejects a
  float column, and both this harness and `bench/fuzz.mjs` use `{ deterministic: true }`. Therefore
  every column here is `u8` or `i32`, and no `f64` column has cover from either tool — while every
  case in `bench/suite.mjs` and `bench/vs/cases.mjs` uses `f64`. The gap is thin, because a column
  type selects only the constructor of the typed array in `makeView`: the code for a row move, a
  swap-remove, a growth and a snapshot is the same below the type layer, and the unit tests cover
  `f64` in many files. But it is a gap, and the default world profile is the one with no cover.
- **The sparse components, the events, the resources, the host write path, and the
  `SharedArrayBuffer` profile.** The harness runs the default heap profile alone.

This list included four more gaps before, and the provenance layer closed them: sets of targets on a
multi relation, the `"delete"` cascade, `"orphan"` with `relations.compact()`, and the helpers that
do a traversal.

## The relation to `bench/fuzz.mjs`

`fuzz.mjs` does random structural operations *from the host*, against a `Map` model. It is an
addition to this harness, and not a repetition of it, because it cannot reach the mechanisms that
this harness covers:

- Each operation in `fuzz.mjs` is **immediate**. But a structural observer runs only for a deferred
  operation in the schedule. Therefore `fuzz.mjs` gives no coverage of the observers.
- It uses no relation.
- It runs no system. Therefore it uses no `ctx.commands`, it has no sequence of a flush, and it makes
  no structural change during an iteration.
- A random operation has no *semantic* invariant to break. Therefore `fuzz.mjs` finds damage to the
  storage, but it does not find an incorrect result from the simulation.

## The files

| File | Role |
| --- | --- |
| `spec.mjs` | the types of agent, the rule table, and the rewrite algorithm — **both sides share it** |
| `ref.mjs` | the reference net: flat typed arrays, a free list, and an incremental index of the active pairs |
| `prov.mjs` | the reference model for the provenance layer (epochs, records, the cascade, and the orphan keys) |
| `world.mjs` | the net and the provenance layer, in the ECS — the implementation under test |
| `nets.mjs` | the generators, and validation of a `NetSpec` |
| `driver.mjs` | the oracles: lockstep, comparison, confluence, snapshot, compact, and the floors for pressure |
| `run.mjs` | the CLI: the selected suite, `--soak`, and one case |
| `mutants.mjs` | injection of a bug — it proves that the oracle fails when it must |
| `oracle.test.mjs` | a small part of the suite, for CI, against the live TypeScript sources |

Both sides share `spec.mjs`, and this is intentional. The item under test is the *storage* of a net
in the ECS. It is not our ability to write the rules of an interaction net two times. Examine the
alternative, where each side calculates the connections itself. A difference between the two sets of
rules then looks like a bug in the ECS. A bug in the ECS can also stay hidden behind a bug in the
rules that has the opposite effect. `ref.assertConsistent()` makes an independent check of the
shared specification. That check finds the one failure that an oracle with two implementations
cannot find in a different way.

## How to debug a divergence

```
# exact attribution: one rewrite for each tick, and verify each tick
node bench/net-oracle/run.mjs --net=<case> --seed=<n> --batch=1 --verify=1
```

`--batch=1` puts one rewrite in each flush. So the tick number that the harness reports *is* the
rewrite number. A failure names the agent, the port, and the values on both sides.
