# bench — tools that measure oecs and test oecs

Use these tools only for local work. They are not a part of the package. Each tool
uses `build.mjs` to make a bundle of `src/`.

## Which build each tool uses

The two groups of tools make a DIFFERENT choice, and each choice is correct for its
group. Do not assume that one sentence covers all of them.

| tool | build | why |
| --- | --- | --- |
| `run.mjs`, `ab/`, `vs/`, `profile.mjs` | production (`__DEV__ = false`) | A measurement must show the code path of the released package. The development guards are not in that path. |
| `net-oracle/run.mjs` | development, or production with `--prod` | More guards give more mechanisms a chance to find a fault. |
| `net-oracle/mutants.mjs` | development, or production with `--prod` | The same reason. |
| `fuzz.mjs` | development, or production with `--prod` | The same reason. |
| `net-oracle/oracle.test.mjs` | development (vitest sets `__DEV__ = true`) | The same reason. |

Therefore **every measurement uses the production path, and the correctness tools
use the development path by default.** A development guard that finds a fault is
not evidence that the released package finds it. Run the `--prod` form of the
correctness tools before you make a claim about the shipped build. The mutant
battery finds all its mutants in both builds, and `net-oracle/README.md` records
which mechanism fires in each.

## The directories

| directory | function |
| --- | --- |
| `ab/` | Compares two builds of oecs. Use it to find if a change made the code faster. |
| `vs/` | Compares oecs with seven other ECS libraries for JavaScript. |
| `net-oracle/` | Reduces an interaction net, and compares each step with a reference model. |

Each directory has a `README.md` file with more data about the tool.

## The files in this directory

| file | function |
| --- | --- |
| `build.mjs` | Makes one ESM bundle of `src/index.ts` with esbuild. All the other tools use it. |
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
```

Use the same filter for a calibration and for the comparison that follows it. Use a
number of rounds that divides by the number of libraries for `vs/`, and an even
number of rounds for `ab/`. Both tools give a warning if you do not.

Add `--dev` to `node bench/run.mjs` to measure the build that has the development
guards. Do not compare a development build with a production build. The two builds
have different code.

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
