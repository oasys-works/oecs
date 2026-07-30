# net-oracle — a deterministic oracle for the simulation of the ECS

This is a simulation with a long run time. It reduces a net in lockstep against a reference model,
and it compares the two nets. The model is a separate implementation of the STORAGE. It shares the
rule table with the ECS side, and the last section of this file gives the reason.

Two groups of layers run at a different rate. The cheap layers run at EACH tick: the totals, the
channel of the events, and the change detection. The full comparison of each live agent runs at each
VERIFICATION tick, which `--verify=N` selects. The curated suite uses a value of 1 for the small
cases, and a larger value for the cases with many agents.

The harness uses these mechanisms continuously, but the unit tests use them one at a time only:

- **archetype migration** — rows that move between archetypes under continuous change
- **relation mutation** — a change of target on an exclusive relation, maintenance of the reverse
  index, sets of targets on a multi relation, and each of the three `onDeleteTarget` policies
  (`clear`, `delete`, and `orphan`)
- **structural observers** — `onAdd` and `onRemove` callbacks that maintain a derived set, and this
  includes an entity that a cascade destroys *indirectly*
- **change detection** — `onSet` observers at both granularities, `changed()` queries, and
  `ctx.markChanged`, against a model that says exactly which agents a tick wrote and which agents it
  marked
- **the verbs of a query** — `withRelation`, `withoutRelation`, `optional`, `singleEntity`,
  `firstEntity` and `forEachUntil`, each against a fact that the reference already holds
- **the partition of the enabled and the disabled rows** — `onDisable` and `onEnable` observers, and
  the rule that a default query must not show a disabled row
- **the host write seam** — the quarantine goes through `HostCommandQueue`, so the seam applies
  commands on each tick of each case
- **sparse components, events, resources and run conditions** — each one carries a fact that the
  reference model also holds

Use this tool only for local work, as you use the other tools in `bench/`. It is not a part of the
package, **and it is not a part of `pnpm test` or of the release gate.**

In this document, **pressure** means continuous use of a mechanism during a run.

```
node bench/net-oracle/run.mjs            # the selected suite, a short run
node bench/net-oracle/run.mjs --soak     # millions of rewrites
node bench/net-oracle/run.mjs --surface  # the probes for the API surface, and no simulation
node bench/net-oracle/mutants.mjs        # show that the oracle finds a bug

# the same layers against the LIVE TypeScript sources, through vitest
pnpm exec vitest run --config bench/net-oracle/vitest.config.ts
```

## The oracle is not in the gate

`vitest.config.ts` at the root collects `src/**` and nothing else. `bench/` is a local tool, so
`pnpm test` does not run the oracle, and no workflow runs it.

`oracle.test.mjs` is still a vitest file, for one reason: vitest resolves the sources in `src/`
directly and defines `__DEV__ = true`, so that file tests **the code in the tree**, with the access
checker and each internal assertion active. `run.mjs` tests **a bundle**, which is what
`mutants.mjs` needs. A file outside the `include` list of a configuration cannot run, not even by
its name. Therefore `bench/net-oracle/vitest.config.ts` exists, and the command above names it. No
script in `package.json` names it.

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
- writes about 12 `u8` columns, and increases an `i32` counter on each endpoint,
- moves several rows between archetypes.

The simulation does each of these operations through `ctx.commands`. Each rewrite therefore causes a
flush, and each flush dispatches the observers. Thus each tick does work.

You can also check this system in a way that rules of our own invention do not permit. The system is
**strongly confluent**. It has linearity, it has binary interaction, and its rules have no
ambiguity. Together, these three properties give one result: each sequence of reductions reaches the
same normal form, and it uses the same number of rewrites. Therefore the oracle needs no reference
implementation, and it needs no known answer. Refer to layer 7 below.

## How the ECS stores the net (and why)

| Concept | The representation in the ECS | What it puts pressure on |
| --- | --- | --- |
| the type of an agent | the `CON`, `DUP`, `ERA`, and `ROOT` tags | 4 base archetypes |
| the *agent* at the end of a port | the `P0`, `P1`, and `P2` exclusive relations, with `onDeleteTarget: "clear"` | exclusive replacement and the reverse index, with a change of target at each rewrite |
| the *index* at the end of a port | the `Slot { s0, s1, s2: u8 }` column | a second, independent record of the same fact — the two must agree |
| membership of an active pair | the `Redex` tag, which **observers alone** maintain, and the `Watch` **sparse** component | the dispatch of a structural observer, and a sparse add that is immediate beside a dense add that is deferred |
| bookkeeping of age | the `Fresh` tag, then `Age { ticks: i32 }` | more archetype edges; and an `i32` column that each tick writes |
| the count of the writes to an agent | the `Touch { seq: i32 }` column, through `ctx.updateField` | the read-modify-write path, and the model for the change detection |
| the count of the times the quarantine disabled an agent | the `Quar { count: u8 }` column, which the **HOST** writes | the `set_field` command of the write seam |
| membership of the quarantine | the `Tainted` tag, which the **HOST** adds and removes | the `add_component` and `remove_component` commands of the seam, and a wider archetype graph |

We divide each wire across a *relation*, which says which agent, and a *column*, which says which
port. That division is deliberate: it records one fact two times, through two subsystems that have
no link. So a bug in either subsystem is a disagreement that we can detect.

The suite reaches 26 different archetypes.

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
| a record to the record before it **in the same epoch** | `PrevRec`, exclusive, with `"clear"` | **a chain that is hundreds of levels deep**: `ancestorsOf` past depth 1, truncation by `maxDepth`, and the promise that a walk gives a parent before its children |
| the set of live records | the `Record` observers **alone** maintain it | a record dies only indirectly. So this proves that a cascade runs `onRemove` for each entity that it destroys |

We keep a fixed window of epochs and destroy the remainder. That gives:

- a cascade for which we know exactly which entities it destroys;
- growth of the reverse index with a reclaim count that we know exactly;
- a live population with a limit, which is about 1000 records at the settings of the suite.

The key of an epoch is an **index** that only increases, and it is not an entity id. This choice
makes a model of the orphan policy possible. The orphan policy is *about* dead handles. A model that
recycled ids, as the ECS does, cannot find the difference between a dead handle and a handle that it
used again.

`Fresh` and `Age` have no meaning for the interaction net. They exist to make the archetype graph
wider. The reference model copies their rules exactly, so we check them, and we do not ignore them.
The suite promotes `Fresh` in `PRE_UPDATE`, one tick *after* it creates the agent. So `Fresh` is
still present at the tick boundary where the comparison happens. A promotion in the same tick would
leave it untested.

`--prov=0` removes the complete layer. `--epoch=N`, `--retain=N` and `--compact=N` adjust it.

### The quarantine, and why it goes through the host write seam

Each tick disables a part of the live agents and enables about half of the agents that are already
disabled. The reference model holds the same set. That gives three things.

**It tests the partition of the rows.** A default query must not show a disabled row. The two
systems that read a default query are the promotion of `Fresh` and the bump of `Age`. Therefore a
disabled agent must not age and must keep `Fresh`. `compare()` reads `Age.ticks` **exactly** at each
verification tick. A disabled row that `eachChunk` still visits gives a divergence at the next tick.
This is the strongest assertion about the partition, and it is not a count.

The PHASE of the promotion is what makes the second half of that rule possible to break. A `disable`
command from the write seam is deferred, so it lands at the flush at the END of PRE_UPDATE. With the
promotion in PRE_UPDATE, the promotion reads the quarantine from before the toggles of the tick.
Then no agent is `Fresh` and disabled at one time, the skip in `promoteFresh` never runs, and no
archetype holds both `Fresh` and `Tainted`. Therefore the promotion is in UPDATE, and it is before
the rewrites. The floor `ticks with a row that is Fresh and disabled` keeps the state reachable.

**It tests the observers for the toggle.** `onDisable` and `onEnable` fire only for a **deferred**
toggle, and an immediate `ecs.disable()` from the host fires nothing. Therefore each toggle here goes
through `HostCommandQueue`, and the seam gets exercised on each tick of each case. A part of the
picks take the "disable, enable, disable in ONE drain" path: an observer fires one time for each NET
transition, so the ECS must collapse that sequence to a single `onDisable` call.

**It widens the archetype graph.** The host adds the `Tainted` tag with the same command that
disables the row, so the graph gains a dimension.

The quarantine has its OWN generator. It must not take a number from the generator that selects the
reduction order: `runCase` compares a run against a run of the reference alone at the same seed, and
a shared stream would give the two runs different orders. Two different orders of a **bounded**
prefix give two different nets, which is correct behaviour that looks like a fault.

## The layers of the oracle

1. **Self-consistency (the ECS alone).** Each port connects to a live port that connects back. A
   port that must not exist holds no relation and no slot. The reverse index of the relations agrees
   with the forward links, and `pairsOf` gives the same set of pairs that the forward links give. A
   DEAD entity holds no key in the reverse index of a `"clear"` relation. `sourcesOfAny` agrees with
   the same question asked one relation at a time. This layer needs no reference. So it continues to
   operate even with a bug in the mapping of ids in the harness itself.
2. **Lockstep (the ECS against the reference).** At each VERIFICATION tick, and through a bijection
   of the ids, we compare the type of each agent, each port link, `Fresh`, `Age`, `Touch.seq`,
   `Quar.count`, `Tainted`, the census, and the count of wire loops. This finds the first tick that
   differs. `--verify=1` makes each tick a verification tick, and `--batch=1` then finds the first
   rewrite that differs. The layers that run at each tick, whatever `--verify` holds, are the
   totals, the channel of the events, and the change detection of layer 9.

   Each rewrite also reads the ECS through the same adapter that drives the rewrite. Therefore a
   read that gives the wrong link changes the wiring on the ECS side, and this layer sees it. With
   `--batch<=4` the harness also verifies, BEFORE each rewrite, that the pair which the plan names
   is an active pair in the ECS.
3. **Canonical form (with no bijection).** We give new numbers to both nets by a breadth-first
   search from `ROOT`, and we compare them as strings. Therefore two nets agree if and only if they
   are isomorphic, for each possible allocation of the ids. The bijection of the ids cannot hide an
   error from this check.
4. **The queues of the observers.** We never calculate either derived set again. The `onAdd` and
   `onRemove` callbacks build both sets alone. We then compare each set against a new scan of the
   ECS *and* against the reference. That gives three independent derivations of one set. The
   `Redex` queue covers the usual structural transitions. The `Record` set covers *indirect*
   destruction, because a record dies only by a cascade.
5. **The cascade, the multi sets, the orphan reclaim, and the deep walk.** We predict exactly which
   entities the removal of an epoch destroys. We compare each `Produced` set of targets element by
   element, and we assert that its order increases. We check that `cascadeOf` predicts exactly which
   entities a despawn destroys. Over the `PrevRec` chain we check `ancestorsOf` and `rootOf` across
   hundreds of edges, we require a walk to give each parent before its children, and we require
   `maxDepth` to truncate to an exactly predicted count. We then make three assertions about
   `compact()`. It reclaims an **exactly predicted** number of dead keys in the reverse index. A
   second call has no effect. It also makes no change to `stateHash`, and no change to any dangling
   forward link.
6. **A closed form.** You can calculate the number of rewrites of the generator for an erasure tree
   by hand (`2^(depth+1)`). Therefore the two implementations can be incorrect together, and the run
   still fails. This is the only layer that is external to BOTH implementations, and thus it is the
   deepest check that this harness has.
7. **Confluence, across the reduction orders.** `confluence()` reduces one net in several sequences,
   and it requires equal numbers of rewrites and equal normal forms.

   This layer sits BESIDE the closed form, and not above it. Layer 2 ends each order with an
   unconditional `compare(...)`, and that comparison is a complete structural isomorphism: a total
   bijection over the live agents, the type of each agent, each port link, and each churn column.
   Each tick also asserts that the ECS applied the number of rewrites that the reference planned.
   Therefore each order already pins its ECS result to its own reference, in the same run. An ECS
   that loses a link, mis-migrates a row or drops an entity fails layer 2 first, whether or not the
   fault depends on the order.

   What is left is a comparison of the two REFERENCE results with each other. That is a real oracle,
   and it is the only layer that can find a fault that `spec.mjs` and `ref.mjs` hold together —
   which is the failure mode that a comparison of two implementations cannot see, because the two
   sides agree. Do not bill this layer as the deepest check of the ECS.
8. **Metamorphism of a snapshot.** We call `stateHash`, then `capture` and `captureSparse`, then we
   write ONE DETERMINISTIC BYTE into one slot of one agent and ONE into one sparse entry, then we
   call `restore` and `restoreSparse`. We then require the same hash and the same data. The two
   writes are what make this check necessary. Without them, a `restore` that did nothing would pass
   the check, and it would give no error. The harness also requires the hash to MOVE for each of the
   two bytes, and thus the layer cannot become vacuous without a report. One deterministic byte for
   each store is enough, and it keeps the run reproducible from its seed alone. The partition of the
   rows and the sparse store must both survive the round trip, so the quarantine and the `Watch` set
   are verified again after the restore.
9. **Change detection.** The reference counts `Touch.seq` in its OWN `setLink`, so the set of agents
   that a tick wrote comes from the model. The first three items below read that set, and thus the
   model gives their expected value. Items four and five compare TWO READS OF THE ECS with each
   other. Such a comparison is still an oracle, because the two reads take different paths in the
   engine, and the mutant `changed-tick-not-set-by-mut` fails item five. But the model does not give
   their expected value, and this file must not say that it does. The row-level part of item five
   does read the model, at each verification tick.

   Five things follow from that set:

   - an `onSet` observer WITH THE GRANULARITY OF AN ENTITY must report **exactly** that set, and the
     agents that layer 16 marked. Its dispatch drops a dead entity, an entity that lost the
     component, and a DISABLED entity, and the model applies the same three rules. Therefore the
     assertion is an equality in both directions. A mark joins THIS set alone. It does not join the
     archetype sets below, which is the point of layer 16.
   - an `onSet` observer WITH THE GRANULARITY OF AN ARCHETYPE must report each archetype that holds
     one of those agents. It may report more: a row that MOVES INTO an archetype also makes its
     columns changed, and the documentation says that the detection is conservative on purpose.
   - `changed(Touch)` must report the same archetypes. A default query gives the non-empty
     archetypes, and an archetype whose rows are ALL disabled is empty for it, so the
     `includeDisabled()` arm is what must reach those.
   - `changed(Touch).without(Fresh)` and `without(Fresh).changed(Touch)` must give ONE set, and no
     archetype in it may hold `Fresh`. The documentation promises that the order of the verbs does
     not matter.
   - `changed(Age)` is **exact in both directions**. `ageTick` asks for the mutable accessor of each
     archetype that its query gives, and the documentation says that the call sets the tick even
     when no write follows. The harness lists the same archetypes through `forEach` on the same
     query, so the expected value needs no model of the archetype graph.

10. **The idle tail.** Each layer above asks "did the ECS report the change". None of them asks "did
    the ECS report a change that did not happen". A layer that reported EVERY archetype at EVERY
    tick would pass all of them. After a net reaches its normal form the harness runs a few ticks
    with no rewrite. Those ticks write no column, so the `onSet` observers and `changed(Touch)` must
    go QUIET, and `changed(Age)` must stay busy because `ageTick` still runs. The first idle tick
    releases the complete quarantine, which also drives one bulk `enable`.

    The `changed-arch-reports-everything` mutant is caught by this layer alone.
11. **The partition of the enabled and the disabled rows.** `isDisabled` for each live agent; a
    default query gives exactly the enabled agents; `includeDisabled()` gives every agent; the set
    that `onDisable` and `onEnable` maintain alone; and the `Tainted` tag, which is present if and
    only if the agent is disabled. The exact comparison of `Age.ticks` in layer 2 is the assertion
    that the row partition kept a disabled row out of `eachChunk`.
12. **The events, the resources and the run conditions.** The rewrite system emits one event for
    each rewrite. A reader in POST_UPDATE drains the channel, and the count of the rows must be the
    count of the rewrites of THIS tick — which is the check on the automatic clear. The rule of each
    row must be the rule that the plan names, in order, and both entity ids of a row must be dead,
    because each rule destroys both members of the pair. A signal gives a count of 1 on a tick that
    rolled an epoch and 0 on every other tick. A resource holds a phase number that the DRIVER
    picks, so the driver knows the exact set of ticks on which `runIfResourceEq` must permit its
    system to run.
13. **The sparse components.** `Watch` is present if and only if the agent is in an active pair.
    `redexMaintain` maintains it with the same rule that it uses for the `Redex` tag, so one system
    drives a sparse add, which is immediate, beside a dense add, which is deferred. `withSparse`,
    `withoutSparse` and `includeDisabled().withSparse` are each compared with the model.
14. **The command log.** The recorder taps each command that the apply system drains, and the
    harness knows how many it enqueued. The log must then survive a round trip through
    `serializeCommandLog` and `deserializeCommandLog`. `surface.mjs` adds the replay itself.
15. **The verbs of a query, against the model that the net already holds.** Each item here
    reads a fact that the reference keeps. Therefore this layer adds no model of its own.

    - `withRelation` and `withoutRelation` — `PORTS` is [3, 3, 1, 1]. Therefore a CON and a
      DUP hold port 1, and an ERA and the ROOT do not. The relation of port 1 partitions the
      agents BY TYPE, and the reference holds the type of each agent. The arm with no
      `includeDisabled()` is the same set without the disabled agents. Therefore the pair also
      reads the row partition, through a term that is neither a component nor a sparse
      component.
    - `optional(Age)` — the query spans the archetypes that hold `Age` and the archetypes that
      do not, because a `Fresh` agent has no `Age` yet. The absent span must be exactly the
      `Fresh` agents, and the present span must carry the numbers that layer 2 reads through
      `getField`. The floors count both spans, so one span alone cannot pass this.
    - `singleEntity` — exactly one ROOT exists for the whole run. `nets.mjs` rejects any other
      number, no rule makes a ROOT, and a pair that holds the ROOT is inert.
    - `firstEntity` — a member of an active pair while the net reduces, and `undefined` in the
      idle tail. The tail is what makes the second half reachable.
    - `forEachUntil` — it must stop at the archetype that the predicate accepts, and it must
      report that it stopped. `forEach` over the same query gives the count of the archetypes.
    - `ctx.getResource` and `ctx.hasResource` — the driver picks the phase number.
      `surface.mjs` reads the host facade, `ecs.resources`, which is a different route.
16. **`ctx.markChanged`, and the difference between the two paths for the change detection.**
    `markChanged` records a row for the per-entity `onSet` observer. It makes NO change to the
    tick for the change on the archetype. The driver marks agents that it picks, so the model
    holds them. Therefore a marked agent must appear in the set with the granularity of an
    entity, and it must NOT put its archetype into `changed(Touch)`.

    The IDLE TAIL is where that difference is sharp. Those ticks write no column, so a mark is
    the only reason for a report. The per-entity layer must give exactly the marked agents, and
    each archetype layer must give nothing. A floor keeps the marked set non-empty there.
    With no mark the two paths agree, and the difference has no test.
17. **`ctx.removeRelation` and `ctx.hasRelation`, from inside a system.** A port of the net is
    exclusive, and a rewrite REPLACES its target with an `add`. Each other unlink in the net
    comes from `onDeleteTarget`. Therefore one system removes one `Produced` pair on each
    verification tick, and the model applies the same removal. `prov.mjs` compares that set
    element by element, so the expected value is exact. `ctx.hasRelation` asks whether the
    source holds ANY target, so its value after the call is "the set still holds something",
    and the model gives that number.

    `surface.mjs` covers `ecs.relations.remove`, which is the HOST route. These two are
    different paths, and the access check reads the second one against `relationWrites`.
18. **Floors for non-vacuity.** Assertions across the suite show that the run applied pressure. They
    cover the total number of rewrites, the ticks, the number of different archetypes, the number of
    observer calls, the number of snapshots, the calls of each `onSet` granularity, the toggles of
    the quarantine, the events, the runs of the gated system, the ticks of the idle tail, the depth
    of the deepest chain of records, the two spans of the `optional` query, the early stops of
    `forEachUntil`, the calls of `ctx.markChanged`, the calls of `ctx.removeRelation`, and the
    presence of the `f64` arm and the `SharedArrayBuffer` arm. They also show that each rule ran,
    and that a minimum of one net became 2 times larger.
    Without these floors, a harness that does nothing passes each layer above, and it shows nothing.

## The arms for the profile

The same layers run over three different worlds. Each arm is a case of the suite, so the arm gets the
complete oracle and not one call of one function.

| Arm | The world | Why |
| --- | --- | --- |
| the default | `{ deterministic: true }` over a plain `ArrayBuffer` | this is what the package ships |
| `f64` | `new ECS()`, with an `Age.fticks` column of type `f64` | A deterministic world REJECTS a float column, so this is the only arm that can cover one. `fticks` holds the same integer that `ticks` holds, and an integer below 2^53 is exact in `f64`. Therefore the comparison stays exact and the run stays reproducible. This arm gives up `stateHash`, `capture` and `restore`, because all three need determinism, so layer 8 is absent from it and `compactCheck` keeps the count and the idempotence alone. |
| `SharedArrayBuffer` | `{ deterministic: true, memory: { shared: {} } }` | This is the opt-in profile that a worker or a WASM compute backend needs. The option is on the ROOT entry, and `@oasys/oecs/shared` carries the allocators for a caller that wants to pass one. Each line of `world.mjs` after the constructor is the same for both backings, which is the point. |

## The probes for the API surface

`surface.mjs` holds 15 probes. Each one is small, and each one has an exact expected value. A probe
that only asked "did this throw" would pass against an ECS that gave the wrong answer, and that is
the failure mode of this whole tool.

Each probe gives back the COUNT of the assertions that it made, and `PROBES` holds a floor for each
one. The count is the delta of a counter that `eq` and `eqList` increase, so it is the count of the
comparisons that ran. A number in the text of the file cannot show that: a probe that returns early
still reports a number that is more than zero. `runSurface` and `oracle.test.mjs` both read the
floor.

They exist because some parts of the API cannot go into a net that must keep its meaning:

| Probe | What only a separate world can do |
| --- | --- |
| the traversal guards | A CYCLE in a relation. The net must have no cycle in its ports. `relation_service.ts` promises two behaviours: a loud `RELATION_CYCLE` in a development build, and a SAFE EARLY-OUT that never hangs in a production build, because the guard is `if (DEV)`-gated and the visited set is not. This probe pins both, and the proof of the second one is that the call returns. It also pins the meaning of `maxDepth` at its small values, where an error of one is easy to see. |
| the built-in relations | The DEFAULT cleanup policy of `registerChildOf` (`"delete"`, so a parent takes its subtree) and of `registerIsA` (`"clear"`, so an instance outlives its exemplar). A caller depends on both, and a change to either is silent. |
| the wildcard read | `forEachRelatedTo` inside a system that lists `ANY_RELATION` in `relationReads`, against the same question asked one relation at a time. |
| the templates and the batch paths | `batchAddComponent` takes an ARCHETYPE and not an entity. The net changes one agent at a time, so it cannot reach that path. |
| the vocabulary of the write seam | The `spawn` and `despawn` commands, `spawnEntry`, the `onSpawned` callback, `push`, `pending`, `clear`, and `uninstallHostCommandSeam`. The quarantine uses the other five kinds. |
| the replay of a command log | `replayCommandLog` needs a SECOND, fresh world. Record a session, write it as JSON, read it back, replay it, and require the hash of the state after each tick to be equal, tick for tick. This is a metamorphic oracle, and it needs no reference implementation. |
| the run conditions and the sets | `runEveryNTicks` reads the tick of the ECS, so the model must know that number. A world of its own makes the model a simple loop. It also covers `not`, `allOf`, `anyOf`, `runIfAnyMatch`, and a `systemSet` with `configureSet`. |
| the lifecycle of a resource, and the events | The present, absent, present axis, and the NAMED error for a read of an absent key. The simulation registers each resource one time. |
| the guard on a sparse restore | A restore into a world with a different sparse shape must give `SparseRestoreError`. The simulation restores into the world that made the bytes. |
| the frame trace | The harness queues an exactly known number of commands, and the observer therefore fires an exactly known number of times. Both numbers must appear in the trace. |
| the removal of a relation | `relations.remove`. A port of the net is exclusive, and a rewrite REPLACES its target with an `add`. Each other unlink comes from `onDeleteTarget`. Therefore the explicit unlink has no other cover, and neither has the rule that a call with NO target argument removes each target of that source. |
| the cursors and the refs | `ecs.cursor`, `cursorRead`, `ctx.ref`, `ctx.refRead` and `tryGetField`. The simulation writes each column through `eachChunk`, `setField` or `updateField`, so it never reaches this family. The probe also reads the tick for the change that `ctx.ref` sets, which is the line that one mutant escaped through. |
| the immediate toggle | `ecs.disable` and `ecs.enable`, from the HOST. An observer fires for a DEFERRED toggle only. The complete quarantine layer depends on that sentence, so the probe measures it: the immediate call moves the row and calls no observer, and the deferred call in the same world calls one. |
| the guard on a restore of the whole world | A MISTAKE. Layer 8 does a round trip that must SUCCEED, so it reads the good path alone. This probe damages the frame in six ways — the version, the magic, a buffer that is too short, one byte removed, one byte added, and damage inside the dense section — and it restores into a world with a different registration. Each call must give `ECSRestoreError`, and it must leave the world unchanged: the probe reads `stateHash` and a live field again after each refusal. It also pins `ECS_SNAPSHOT_VERSION` against the version word of a fresh capture. |
| the immediate component writes of the host | `ecs.removeComponent`, `ecs.addComponents` and `ecs.removeComponents`, called from the HOST and between the ticks. These call NO structural observer, so the simulation cannot use them: the sets that the observers maintain are the oracle of layer 4, and they would go out of step by design. The probe measures that difference against a deferred `ctx.commands` pair in the same world. It also compares the plural forms with the singular forms, which must give the same archetype. `fieldId` is here as well. |

## Proof that the oracle finds a bug

`mutants.mjs` puts known ECS bugs into a **built bundle**, and never into the source tree, so that
it is safe against a working directory with changes. It requires that the oracle catches each one.

The battery holds one case for the probes of the API surface, and that case is last. Each case
before it names a `--net=`, and a `--net=` run does not call `surface.mjs`. Therefore the battery
could not reach a probe before this case existed, and no probe had evidence that it catches a
fault.

The table below names the mechanism that fires first, and it says whether that mechanism is an
ORACLE layer or an error of the ENGINE. An engine error is a real detection — the bug is fatal — but
it is not evidence about the oracle. `mutants.mjs` reports both counts, and it does not treat every
nonzero exit as a catch by the oracle.

| Mutant | Caught by | Kind |
| --- | --- | --- |
| swap-remove does not update the back pointer to the entity row | the per-entity `onSet` against the model | oracle |
| swap-remove moves the id but not the column data | symmetry of the links | oracle |
| the row plane reports a capacity that is more than its cached value | `StoreGrowError` at scale | engine |
| the row plane keeps a view of the entity ids that is out of date after a growth | an engine error at scale | engine |
| the reserve tests the term of the entity id, so a column never grows | `StoreExtendError` at scale | engine |
| an exclusive replacement leaves the old entry in the reverse index | the check of the reverse index | oracle |
| the structural dispatch never runs `onRemove` | the observer queue against a new scan | oracle |
| the structural dispatch runs `onAdd` two times | the invariant of the record observer | oracle |
| `"delete"` destroys the target but not its sources | the set of entities that the cascade destroys | oracle |
| `"clear"` leaves the relation on each source | a dead agent still keys `Produced` | oracle |
| a forward set on a multi relation keeps a target with no link | the comparison of the `Produced` set | oracle |
| `targetsOf` on a multi relation loses its ascending sort | the comparison of the `Produced` set — the model sorts, so an unsorted result differs before the assertion about the order reads it | oracle |
| `compact()` reclaims entries but reports zero | the exact reclaim count | oracle |
| `compact()` also removes live targets | the exact reclaim count | oracle |
| the per-entity `onSet` drain returns before it calls anything | the exact set of the written entities | oracle |
| the per-entity `onSet` reports a DISABLED entity | the exact set of the written entities | oracle |
| the mutable column group does not set the change tick | the `onSet` observer on `Age` against the archetypes that `ageTick` visited | oracle |
| the archetype-granular `onSet` ignores its baseline and reports everything | **the idle tail** | oracle |
| `disableRow` moves the row but does not shrink the enabled region | the exact set of the written entities | oracle |
| a net toggle fans `onEnable` where it must fan `onDisable` | the invariant of the quarantine observer | oracle |
| `"clear"` leaves the reverse key of the DEAD target | **the cohort of the recently dead agents** | oracle |
| a hierarchy walk keeps the entities deeper than `maxDepth` | the exact count of the walk over the record chain | oracle |
| an event channel keeps its rows past the end of the update | the count of the rows against the count of the rewrites | oracle |
| the apply dispatch of the write seam ignores a `set_field` command | `Quar.count` against the model | oracle |
| `ctx.ref` does not set the tick for the change | the probe for the cursors and the refs | oracle |
| `relations.remove` with no target argument removes nothing | the probe for the removal of a relation | oracle |
| a restore of a world does not check the version of the snapshot | the probe for the restore of the whole world | oracle |
| the plural remove detaches the first component only | the probe for the immediate component writes | oracle |
| `ctx.removeRelation` removes every target instead of the named one | `ctx.hasRelation` after the explicit unlink | oracle |
| `ctx.hasRelation` reports a target for every source | the same layer, when the unlink took the last target | oracle |
| `ctx.markChanged` records no row | the exact set of the written entities | oracle |
| `ctx.markChanged` makes the whole archetype changed | **the idle tail** | oracle |
| `withRelation` keeps every row | the partition by port arity | oracle |
| `getOptionalColumnRead` reports every optional column as absent | the two spans of `optional(Age)` | oracle |
| `forEachUntil` visits every archetype and does not stop early | the count of the archetypes that the callback saw | oracle |

### The build that the battery uses

The battery uses a DEVELOPMENT build by default, because the guards of that build give more
mechanisms a chance to fire. The released package is a PRODUCTION build, so
`node bench/net-oracle/mutants.mjs --prod` runs the same battery against `__DEV__ = false`. Both
builds were measured, and this is the result:

| build | caught by an oracle layer | caught by an engine error | escaped |
| --- | --- | --- | --- |
| development | 32 of 35 | 3 of 35 | 0 |
| production | 32 of 35 | 3 of 35 | 0 |

The two builds now agree on the mechanism for each mutant, so the choice of the default costs no
coverage. The three that an engine error finds are all on the growth path of the row plane. Read
those three rows as "this bug is fatal", and not as "the oracle finds this bug". Unit tests
(`archetype_row_plane.test.ts`) hold that path instead.

The mutants on the growth path **escaped** the first set of mutants, because a small net does not
use more than the prepared capacity of its archetype. Therefore the set now includes `erase:14` and a
case for growth. This result also shows most clearly why the floors for non-vacuity are a part of the
harness, and not an addition of no value. `erase:14` alone still catches all three of these mutants.
Each other mutant fails on `erase:8`.

A mutant is a patch of text against the bundle that the build makes. Therefore **a change to the
mechanism of a mutant makes that mutant invalid, and gives no message**. `mutants.mjs` prevents this
condition. If a pattern does not match one time exactly, `mutants.mjs` reports the mutant as out of
date, and it counts the mutant as an escape. It does not skip the mutant.

There is a second way for a mutant to go stale, and one mutant in this set found it. The first
version of `changed-tick-not-set-by-mut` removed the line that sets the change tick from `ctx.ref`.
Its pattern matched exactly one time, so `mutants.mjs` accepted it, and the mutant ESCAPED — because
the harness wrote `Age` through `eachChunk` alone, and no case reached `ctx.ref`. **A pattern that
matches is not the same as a pattern that names code the harness runs.** The mutant now names
`columnGroupMut`, which is the path behind `cols.mut`.

The probe for the cursors and the refs closes that gap. The mutant `changed-tick-not-set-by-ref` now
holds the `ctx.ref` line, and the probe catches it. That mutant then found the same fault in the
FIRST version of the probe: the probe read `changed()` on the first tick of the world. There the
baseline of the reader is the start of the run, and the query reports each archetype whatever the
write path does. The probe now uses three quiet ticks to make the baseline current, and it reads the
result of one write after that.

## Two results that this file records

**A `compact()` call does not survive a snapshot and a restore.** The reverse index is *derived*. So
`restore` builds it again from the **forward** links that survive. Under `"orphan"`, those links
still carry the dangling dead handles, by design. Each key of a dead target that an earlier
`compact()` reclaimed therefore returns after a restore.

`relation.ts` documents that behavior, and the behavior is correct. We record it here because it is
the kind of interaction that a model that a person built from the documentation alone would get
wrong. `RefProv.noteRestored()` is where the harness accounts for it.

**A default `changed()` query cannot report an archetype whose rows are all disabled.** A default
query keeps the archetypes with one or more ENABLED rows, so an all-disabled archetype is empty for
it. The `onSet` observer with the granularity of an archetype takes a different path — it visits each
archetype with one or more ROWS — so it DOES report that archetype. Both are correct, and the
difference is not obvious from the documentation. `driver.changeCheck` keeps two expected sets for
that reason, and it checks the `includeDisabled().changed(Touch)` arm against the larger one.

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

- **A compute backend.** `attachBackend` and `backendHandle` route a system to a `ComputeBackend`
  instead of its TypeScript body. The engine ships the SEAM, and the worker and the compiled module
  are the consumer's to provide. Therefore this harness has nothing to attach, and the arm for the
  `SharedArrayBuffer` covers the backing that such a backend needs, and not the dispatch to it.
- **The SAB command ring.** `installHostCommandSeam` takes a `ring` option, and
  `HostCommandDispatcher` with the `ring_*_codec` factories decodes 15-byte slots from another
  thread into the same `applyHostCommand`. The harness drives the TYPED queue, which is the
  in-process transport. The ring needs a producer on a second thread, so it stays with the unit
  tests.
- **`FIXED_UPDATE`, and `FrameStepper`.** The harness calls `ecs.update(1)` and reads a variable
  timestep. The fixed-step accumulator, the limit on the count of the sub-steps, and the stepper for
  a frame are a separate path.
- **The reactive read bridge**, at `@oasys/oecs/reactive` and `extensions/reactive`. That is a
  separate entry with its own tests, and it is not the core.
- **The editor extension**, at `extensions/editor`. Same reason.
- **A resource that holds a value with a deep shape.** The resources here hold a number or a small
  record. A resource is out of `stateHash` and out of the snapshot, so its value is opaque to the
  engine, and the layer that a model could check is the lifecycle. `surface.mjs` checks that.
- **`configureSet` with an ordering across sets.** `surface.mjs` uses a set with a shared run
  condition, and it does not order one set against another.
- **A world with more than one `ECS` instance at one time.** `multi_world_isolation.test.ts` holds
  that.
- **`registerTag` and `registerSparseTag`.** A tag that wants a name for the debug output goes
  through `registerComponent({}, { name })`, because `registerTag()` takes no options. Therefore the
  harness uses the second form, and the first form has no cover here.
- **`publishArchetypeRowCounts`.** The snapshot service publishes the row counts itself.
- **`regionHandles`, `regionOffset`, `regionHandle` and `onStoreLayoutPublished`.** These belong to
  the seam for a compute backend, with `attachBackend` above.
- **`SabUnavailableError`.** The error needs an environment with no `SharedArrayBuffer`. The arm for
  the `SharedArrayBuffer` runs in an environment that has one.
- **`removeSystem`.** The schedule is fixed after `startup()`, so the harness never calls it, in the
  middle of a drive or at any other point.
- **`StoreRestoreError` through the root entry.** The guard of the ECS reads the same dense bytes,
  and it runs FIRST, because that is what keeps a refused restore non-mutating. Therefore damage in
  the dense section gives `ECSRestoreError`, and the probe for the restore of the whole world pins
  that order. The dense error class itself belongs to `restoreColumnStore`, which the root entry
  does not reach. The unit tests hold it.
- **`ctx.removeResource`, and a `singleEntity` call that must throw.** The simulation registers each
  resource one time, and a run that removed one would stop the gate that reads it. The throw of
  `singleEntity` is present in a DEVELOPMENT build alone: a production build skips the count and
  gives the first match. Therefore the net pins the identity of the one ROOT, which is the assertion
  in both builds, and the arm that must throw belongs in a probe.
- **`Query.and`, `anyOf` and `optional` with more than one component, and `ChangedQuery.and`.** The
  harness composes each query one verb at a time. The multi-argument forms fold through the same
  single-term cache, so they take the same path.

This list included eight more gaps before an earlier pass, and the layers above closed them: the
`onDisable` and `onEnable` observers, the `onSet` observers, the `changed()` queries, `hierarchy()`
past depth 1 with `maxDepth`, a dead key in the reverse index of a port relation, the float columns
with the world profile that has no determinism, the sparse components with the events and the
resources and the host write path, and the `SharedArrayBuffer` profile.

A later pass closed four more: `relations.remove`, the family of the cursors and the refs, the
immediate toggle from the host, and `entityIdAtRow`. The same pass made a row that is both `Fresh`
and disabled reachable. Before that change, no run reached that state, and the rule about it had no
test.

The most recent pass closed nine more. Six of them went into the simulation, because the net gives
each one an exact model. They are `withRelation` and `withoutRelation` through the arity of the
ports, `optional` through the agents that have no `Age` yet, `singleEntity` through the one ROOT,
`firstEntity` through the idle tail, `forEachUntil`, and the pair `ctx.getResource` and
`ctx.hasResource`.

Two more went into the simulation with a model of their own: `ctx.markChanged`, and the pair
`ctx.removeRelation` and `ctx.hasRelation` over a `Produced` set.

The last two went into `surface.mjs`. A net that must keep its meaning cannot hold them. They are
the refusal of a damaged snapshot, and the immediate component writes of the host, which call no
observer.

The combined snapshot of a world is NOT a gap, and an early reading of this file said that it was.
`snapshots.capture()` holds three sections — the dense columns, the sparse stores with the relations,
and the host bookkeeping — and `snapshots.restore()` mounts all three. Therefore layer 8 covers that
path. `captureSparse` and `restoreSparse` are the second, smaller path for the sparse half alone,
and layer 8 covers that also.

An earlier reading of this file said that layer 8 covered `ECS_SNAPSHOT_VERSION` and the checks that
fail closed. That was too strong. Layer 8 does a round trip that must SUCCEED, so it never gives
`restore` bytes that it must refuse, and it never reads the version word. The probe for the restore
of the whole world holds that half now.

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
| `ref.mjs` | the reference net: flat typed arrays, a free list, an incremental index of the active pairs, and the model for `Touch`, the quarantine and the archetype signature |
| `prov.mjs` | the reference model for the provenance layer (epochs, records, the cascade, the chain, and the orphan keys) |
| `world.mjs` | the net and the provenance layer, in the ECS — the implementation under test |
| `nets.mjs` | the generators, and validation of a `NetSpec` |
| `driver.mjs` | the oracles: lockstep, comparison, the change detection, the marks, the quarantine, the events, the sparse set, the verbs of a query, confluence, the snapshot, compact, the idle tail, and the floors for pressure |
| `surface.mjs` | the probes for the parts of the API that the simulation cannot reach, with a floor on the count of the assertions of each one |
| `run.mjs` | the CLI: the selected suite, `--soak`, and one case |
| `mutants.mjs` | injection of a bug — it proves that the oracle fails when it must. Its battery holds one case for the probes of the API surface, and that case is last. |
| `oracle.test.mjs` | the same layers against the live TypeScript sources, through vitest |
| `vitest.config.ts` | the configuration that makes `oracle.test.mjs` reachable. The root configuration keeps `bench/` OUT of `pnpm test`. |

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

Two options make a layer absent, and each one is useful when you want to know which layer sees a
fault first:

```
node bench/net-oracle/run.mjs --net=<case> --verify=1    # compare at each tick
node bench/net-oracle/run.mjs --net=<case> --prov=0      # no provenance layer
node bench/net-oracle/run.mjs --net=<case> --snap=0      # no snapshot round trip
node bench/net-oracle/run.mjs --net=<case> --float       # the arm with no determinism
node bench/net-oracle/run.mjs --net=<case> --sab         # the SharedArrayBuffer arm
```

One note about `--steps` with `--soak`. That option caps EVERY case of the soak, and each case of
the soak takes a snapshot on a cadence of hundreds of ticks. Therefore a soak that you cut short
reaches few ticks and few snapshots, and the floor for the count of the snapshots then reports that
the run applied too little pressure. That report is correct: a short run of the soak IS a run with
little pressure. Give the soak its own step budgets, or read the report as the note that it is.
