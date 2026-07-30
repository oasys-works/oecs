# ab — a paired comparison of two builds of oecs

This tool answers one question: is the new code faster than the old code? There
are two drivers and one measurement program. All of them use the same method. Use
this tool only for local work. It is not a part of the package.

| file | function |
| --- | --- |
| `ref.mjs` | The old code is a git ref. The driver puts the ref into a temporary worktree. |
| `bundles.mjs` | The old code is a build that you made before the change. |
| `child.mjs` | Measures one build in a new process. Both drivers start this program. |

Both sides are the ARTIFACTS of the package. `ref.mjs` starts `scripts/build.mjs`
for each side, and thus each side is the file that npm gives to a user. The
worktree of the ref goes into `bench/.out/`, and not into the temporary directory
of the system, because the build then finds `node_modules` in a parent directory.
`../dist.mjs` gives the full reason.

Give `bundles.mjs` the ENTRY file of a build, and not a single-file bundle from
`../build.mjs`. The entry file imports the chunks beside it, and therefore each
side must keep its own directory:

```
node bench/ab/bundles.mjs old/dist/index.js new/dist/index.js
```

The cases come from `../suite.mjs`. `../run.mjs` uses the same cases, but you must
not compare the `ns` column of `run.mjs` with the `ns` column of this tool. There
are two reasons, and each one is sufficient:

| tool | the build | the `ns` column |
| --- | --- | --- |
| `../run.mjs` | a bundle of `src/`, which keeps the guards as branches | the BEST of 9 samples, in one process |
| `ref.mjs`, `bundles.mjs` | the artifacts, which have no guards | the MEDIAN across the rounds of that best value |

The best value has the least noise, because noise only adds time. A median across
the rounds is higher than a best value, and it is more stable. Use this tool for
the difference between two builds, and for a claim about the package.

## How to make a comparison

1. Calibrate the equipment. Run `node bench/ab/ref.mjs --null`.
2. Read the two numbers of the calibration. The largest |Δ| is the floor of a
   median. The widest middle half is the floor of the worst row.
3. Make the comparison. Run `node bench/ab/ref.mjs`.
4. Compare each delta with the floor. A delta below the floor has no meaning. For a
   delta on ONE row, also compare it with that row's own middle half.

Do steps 1 and 3 on the same machine. Use the same filter for both steps. Keep the
temperature of the machine approximately equal.

```
node bench/ab/ref.mjs --null                  # calibrate: each row must show approximately 0%
node bench/ab/ref.mjs --null struct/          # calibrate the same cases that you will compare
node bench/ab/ref.mjs                         # compare the working tree with HEAD
node bench/ab/ref.mjs --ref main struct/      # compare with a different ref, and filter the cases
node bench/ab/ref.mjs --rounds 16             # use more rounds (an even number)
node bench/ab/bundles.mjs base.mjs work.mjs   # compare two bundles that you made before
node bench/ab/bundles.mjs same.mjs same.mjs   # calibrate this driver
```

Use `bundles.mjs` if the working tree has other changes that you did not make for
this test. `ref.mjs` compares the tree with a ref, and the difference includes
those other changes. `bundles.mjs` does not touch the tree.

## Why the design is like this

A null comparison uses the same code on both sides. The correct result is 0%. Each
time a null comparison gave a different result, we changed the design. These are
the results of those changes.

- **One process for each measurement.** Two variants in one process gave an error
  of some percent. A different sequence of the two variants did not remove the
  error. The two worlds get memory one after the other, and one of them gets a
  better position in the heap. A new process for each variant loads one `ECS`
  class only. Then each call site in the timed loop has one shape, as it has for a
  user of one version.
- **The rounds change the sequence of the two sides.** The frequency of the CPU
  and the temperature of the machine change slowly. These changes are then equal
  for both sides of a round.
- **The result is an ORDER-BALANCED median of ratios.** Each round measures both
  sides one after the other. Thus the ratio of a round is not sensitive to slow
  changes. A median then removes the round that had a garbage collection in the
  timed part. But the alternation of the sequence gives no protection by itself. A
  position bias — a difference between the first measurement of a round and the
  second — multiplies the ratios of one order and divides the ratios of the other.
  Therefore the ratios make two groups, and a median of all the rounds together
  falls in one group and keeps the full bias. The tool takes a median in EACH
  order, and it then multiplies the two medians and takes the square root. The bias
  cancels. For the same reason the number of the rounds must be even. The default
  is 12, and the tool gives a warning for an odd number.
- **The columns have a fixed capacity.** The store makes a column larger during a
  timed operation, and the cost of this operation is not stable. These cases gave
  a very large difference in a null comparison, and that difference was the
  largest source of noise in the tool. `suite.mjs` sets
  `columnCapacity`, and the store makes the columns larger during the setup. The
  setup is not part of the timed operation.
  - **To make an archetype is not the same as to give it a capacity.** A setup that
    moves one entity into the target archetype makes that archetype, but at the
    DEFAULT column capacity. The timed loop then moves the complete population into
    it, and the store makes the columns larger during the measurement. A null
    comparison does not find this condition, because a small number of grows across
    many operations stays below the noise. A counter on `growColumnStore` finds it.
    Set `columnCapacity` for these cases as well.

## How to read a row

Each row shows a delta (Δ) and a spread. The delta is the order-balanced median of
the ratios of the rounds. The spread shows the difference between the rounds, after
the tool moves the two orders onto one common centre. Therefore the spread shows
the noise between the rounds, and it does not show the position bias again.

`ref.mjs` also shows a verdict for each row:

- **FASTER** or **SLOWER** — the middle half of the rounds agrees about the sign of
  the delta.
- **NOISY** — the row cannot give a verdict. `ref.mjs` does not count these rows.

The two drivers show the spread in different ways:

- `ref.mjs` shows the interquartile range. This range includes the middle half of
  the rounds.
- `bundles.mjs` shows the minimum value and the maximum value. It has no verdict.

One round with a garbage collection makes the spread of `bundles.mjs` large. The
same round has a small effect on the range of `ref.mjs`. Always read the spread.
Do not read the delta only.
