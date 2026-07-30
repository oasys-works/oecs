# bench — tools that measure oecs and test oecs

Use these tools only for local work. They are not a part of the package.

## Which build each tool uses

There are two ways to make the library, and a tool uses one of them. The two groups
of tools make a DIFFERENT choice, and each choice is correct for its group. Do not
assume that one sentence covers all of them.

| way | file | what it makes |
| --- | --- | --- |
| the artifacts | `dist.mjs` | Starts `scripts/build.mjs`, which is the build of the package. The result is the file that npm gives to a user. |
| a bundle of `src/` | `build.mjs` | One ESM file from esbuild. It gives `__DEV__` a value, but it keeps each guard as a branch. |

The difference is important. `build.mjs` gives the flag a value, and thus the guards
do not RUN. But it does not remove them, and thus the guards are still in the code.
The build of the package removes each guard and its body. A guard makes its function
larger, and the size of a function controls the decisions of the compiler about it.

| tool | build | why |
| --- | --- | --- |
| `ab/ref.mjs`, `ab/bundles.mjs` | the artifacts | A measurement must show the code of the released package, and not code that no user receives. |
| `vs/vs.mjs` | the artifacts | The same reason. Each other library comes from `node_modules` as a released build, and thus both sides of the comparison have the same form. |
| `run.mjs` | a bundle of `src/` | This tool is still on the old method. Use `ab/` for a result. Refer to the warning below. |
| `profile.mjs` | a bundle of `src/` | No property makes this necessary. The artifacts keep the name of each function, and thus this tool can move to the artifacts. |
| `net-oracle/run.mjs` | a bundle of `src/`: development, or production with `--prod` | More guards give more mechanisms a chance to find a fault. |
| `net-oracle/mutants.mjs` | a bundle of `src/`: development, or production with `--prod` | The same reason. This tool also replaces a text in the bundle, which the form of `src/` makes possible. |
| `fuzz.mjs` | a bundle of `src/`: development, or production with `--prod` | The same reason. |
| `net-oracle/oracle.test.mjs` | `src/` (vitest sets `__DEV__ = true`) | The same reason. This file tests the CODE IN THE TREE, and `net-oracle/run.mjs` tests a bundle. It is NOT a part of `pnpm test`: the root `vitest.config.ts` collects `src/**` alone, so a person runs it through `bench/net-oracle/vitest.config.ts`. |

Therefore **`ab/` and `vs/` measure the artifacts, and the correctness tools use the
development path by default.** A development guard that finds a fault is not
evidence that the released package finds it. Run the `--prod` form of the
correctness tools before you make a claim about the shipped build. `--prod` gives
the correct RESULT for those tools, because the guards do not run. The mutant
battery finds all its mutants in both builds, and `net-oracle/README.md` records
which mechanism fires in each.

**`run.mjs` measures a bundle of `src/`, and therefore its values are not the values
of the released package.** The guards are in the code that it measures. Do not
compare a value from `run.mjs` with a value from `ab/`, and do not put a value from
`run.mjs` in a claim about the package. Use `run.mjs` to find a large change, and
then use `ab/` for the result.

## The directories

| directory | function |
| --- | --- |
| `ab/` | Compares two builds of oecs. Use it to find if a change made the code faster. |
| `vs/` | Compares oecs with seven other ECS libraries for JavaScript. |
| `net-oracle/` | Reduces an interaction net, and compares each step with a reference model. It also covers the change detection, the row partition, the host write seam, the events, the resources, the sparse components, and the `f64` and `SharedArrayBuffer` profiles. |

Each directory has a `README.md` file with more data about the tool.

## The files in this directory

| file | function |
| --- | --- |
| `dist.mjs` | Makes the artifacts of the package, and copies them for one tool. `ab/` and `vs/` use it. |
| `build.mjs` | Makes one ESM bundle of `src/index.ts` with esbuild. The correctness tools use it. |
| `suite.mjs` | Holds the benchmark cases. `run.mjs` and `ab/` use the same cases. |
| `harness.mjs` | Does the warmup and the timed samples for `run.mjs`. |
| `run.mjs` | Measures one build. It can also keep a baseline, and compare with a baseline. |
| `profile.mjs` | Runs one scenario for the CPU profiler of Node. |
| `readprof.mjs` | Reads a `.cpuprofile` file. Shows the functions that have the highest self time. |
| `readlines.mjs` | Reads a `.cpuprofile` file. Shows the self time of each line in one function. |
| `fuzz.mjs` | Does random structural operations. Compares the result with an independent model. |
| `report.mjs` | Makes an HTML page about one comparison from the past. The data is in the file. |

`report.mjs` is a record, and not a tool. The numbers are constants in the file. To
make a page about a new comparison, you must put the new numbers into the file.

## How to use the tools

```
node bench/run.mjs                            # measure the working tree
node bench/run.mjs iter                       # measure only the cases that match "iter"
node bench/run.mjs --save base                # measure, and keep a baseline
node bench/run.mjs --cmp base                 # measure, and compare with the baseline
node bench/ab/ref.mjs --null                  # calibrate the comparison equipment
node bench/ab/ref.mjs                         # compare the working tree with HEAD
node bench/fuzz.mjs 1 4000                    # 4000 random operations, from seed 1
node bench/fuzz.mjs --prod 1 4000             # the same seeds, against the shipped build
node bench/vs/vs.mjs --rounds 9               # compare oecs with the other libraries
node bench/net-oracle/run.mjs                 # find errors with the reference model
node bench/net-oracle/run.mjs --prod          # the same, against the shipped build
node bench/net-oracle/mutants.mjs --prod      # the mutant battery, against the shipped build

# the same oracle layers against the LIVE TypeScript sources, through vitest.
# `pnpm test` does NOT run this; the root vitest configuration keeps `bench/` out.
pnpm exec vitest run --config bench/net-oracle/vitest.config.ts
```

Use the same filter for a calibration and for the comparison that follows it. Use a
number of rounds that divides by the number of libraries for `vs/`, and an even
number of rounds for `ab/`. Both tools give a warning if you do not.

Add `--dev` to `node bench/run.mjs` to give the guards permission to run. Do not
compare a run that has `--dev` with a run that does not. The guards do work, and
thus the two runs measure different operations.

To make a CPU profile, use the profiler of Node, and then read the file:

```
node --cpu-prof --cpu-prof-dir=bench/.out/prof bench/profile.mjs addComponent
node bench/readprof.mjs bench/.out/prof/<name>.cpuprofile
node bench/readlines.mjs bench/.out/prof/<name>.cpuprofile addComponent src/core/ecs/ecs.ts
```

## The output files

Each tool writes its files to a `.out/` directory. Git does not track these
directories. The bundles, the CPU profiles and the baselines are large. You can
delete a `.out/` directory at any time, because the tools make the files again.

## Before you make a claim about performance

1. Calibrate the equipment. Use `--null` for `ab/`, and `--null` for `vs/`. Use the
   same filter, the same libraries and the same number of rounds that the comparison
   will use. A calibration that is narrower or shorter than the comparison reports a
   floor that is too small.
2. Read the largest difference that the calibration shows. This value is the noise
   floor of the machine.
3. Do not make a claim about a difference that is smaller than the noise floor.
4. Read the spread of each row. A large spread shows that the rounds do not agree.
   **One row can be much noisier than the summary number.** `ab/ref.mjs --null`
   reports the largest |Δ| and the widest middle half separately, and the second
   number is often many times the first. A delta on one row must clear that row's own
   middle half, and not only the summary.
5. Look at the cases with a fresh world in the setup. If a timed loop makes the store
   allocate, the row measures the allocator, and its value is not stable. To make an
   archetype in the setup is not the same as to give it a capacity — refer to
   `ab/README.md`.
