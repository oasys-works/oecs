import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import fs from "fs";
import path from "path";
import { bindToCoreArtifact, recordCoreGraph } from "./scripts/core_boundary";

// Two production-artifact variants are emitted from one config (see
// scripts/build.mjs): the default `production` build (`__DEV__:false`, guards
// DCE'd, plain `*.js` and `*.cjs`) and the `development` build (`__DEV__:true`,
// guards retained, `*.development.js` and `*.development.cjs`). The variant is
// selected via OECS_VARIANT. The dev server (`command !== "build"`) is always
// guards-on. Declarations are identical across variants, so `dts` runs only in
// the production pass and `emptyOutDir` clears the dir only on that first pass.
const DEV_BUILD = process.env.OECS_VARIANT === "development";

// The four plugin entries build in their own pass. Declaring them beside the core entries
// put them in one rollup graph, and rollup then split `index.js` into ten small
// chunks so the plugin bundles could share code with it. Those splits are
// real module boundaries at run time, and a measurement of `spawn` on the
// shipped artifact showed the cost. A separate pass leaves the core chunk graph
// exactly as it was, at the price of a little duplicated code in the plugin
// bundles, which are small and loaded once.
//
// Duplicated code is not always harmless. A module that carries a class, a
// singleton or a registry must exist once in a program. The plugin pass
// marks those external and resolves them to the core artifact.
// `scripts/core_boundary.ts` holds the classification and fails the build on a
// module it does not name.
const PLUGIN_BUILD = process.env.OECS_ENTRIES === "plugins";

// The worker entry builds in a third pass, for the same reason the plugins do:
// declared beside the core entries it would split `index.js` into shared
// chunks, and the dist test locks that chunk graph. It needs no classification
// pass either. A worker is another realm, so every module it compiles is a
// second copy by definition, and no `instanceof`, singleton or registry crosses
// the thread boundary.
const WORKER_BUILD = process.env.OECS_ENTRIES === "worker";

const SRC_DIR = path.resolve(__dirname, "src");
const VARIANT = DEV_BUILD ? "development" : "production";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === "build" && !DEV_BUILD && !PLUGIN_BUILD && !WORKER_BUILD
      ? [dts({ tsconfigPath: "./tsconfig.build.json" })]
      : []),
    ...(command === "build" && !WORKER_BUILD
      ? [
          PLUGIN_BUILD
            ? bindToCoreArtifact(SRC_DIR, VARIANT)
            : recordCoreGraph(SRC_DIR, VARIANT),
        ]
      : []),
  ],

  define: {
    __DEV__: command === "build" ? (DEV_BUILD ? "true" : "false") : "true",
  },

  resolve: {
    // alias for every top level directories in src
    alias: Object.fromEntries(
      fs
        .readdirSync(path.resolve(__dirname, "src"), { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => [
          dirent.name,
          path.resolve(__dirname, `./src/${dirent.name}`),
        ]),
    ),
  },

  build: {
    target: "es2022",
    // production pass wipes dist. The development pass adds its `*.development.*`
    // artifacts alongside without clearing the production output.
    emptyOutDir: !DEV_BUILD && !PLUGIN_BUILD && !WORKER_BUILD,
    lib: {
      // Multi-entry, one per published subpath. Keys are src-relative paths so
      // the emitted .js/.cjs and the vite-plugin-dts .d.ts (which mirrors src/)
      // land at matching paths, the `exports` map points both at the same path.
      entry: WORKER_BUILD
        ? { worker: path.resolve(__dirname, "src/worker.ts") }
        : PLUGIN_BUILD
        ? {
            "plugins/snapshots": path.resolve(
              __dirname,
              "src/plugins/snapshots.ts",
            ),
            "plugins/events": path.resolve(
              __dirname,
              "src/plugins/events.ts",
            ),
            "plugins/relations": path.resolve(
              __dirname,
              "src/plugins/relations.ts",
            ),
            "plugins/observers": path.resolve(
              __dirname,
              "src/plugins/observers.ts",
            ),
          }
        : {
            index: path.resolve(__dirname, "src/index.ts"),
            shared: path.resolve(__dirname, "src/shared.ts"),
            "plugins/editor/index": path.resolve(
              __dirname,
              "src/plugins/editor/index.ts",
            ),
            "plugins/solid/index": path.resolve(
              __dirname,
              "src/plugins/solid/index.ts",
            ),
            primitives: path.resolve(__dirname, "src/primitives.ts"),
            internal: path.resolve(__dirname, "src/internal.ts"),
          },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}${DEV_BUILD ? ".development" : ""}.${format === "es" ? "js" : "cjs"}`,
    },
    rollupOptions: {
      // solid-js is an optional peerDependency, never bundle it. `solid-js/store`
      // is a separate specifier, and it resolves to its own module, so leaving it
      // off this list compiles a second copy of the store into the solid plugin.
      //
      // `node:worker_threads` stays here even though `node_threads.ts` names no
      // specifier rollup can see. It is a tripwire. A literal specifier that
      // comes back reaches the emitted file, where the dist test fails on it.
      // Drop it and the same regression turns into a browser stub chunk, which
      // loads on node and holds no `Worker`.
      external: ["solid-js", "solid-js/store", "node:worker_threads"],
    },
  },
}));
