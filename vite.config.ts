import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import fs from "fs";
import path from "path";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === "build"
      ? [dts({ tsconfigPath: "./tsconfig.build.json" })]
      : []),
  ],

  define: {
    __DEV__: command === "build" ? "false" : "true",
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
    lib: {
      // Multi-entry, one per published subpath. Keys are src-relative paths so
      // the emitted .js/.cjs and the vite-plugin-dts .d.ts (which mirrors src/)
      // land at matching paths — the `exports` map points both at the same path.
      entry: {
        index: path.resolve(__dirname, "src/index.ts"),
        shared: path.resolve(__dirname, "src/shared.ts"),
        "core/reactive/index": path.resolve(
          __dirname,
          "src/core/reactive/index.ts",
        ),
        "extensions/reactive/index": path.resolve(
          __dirname,
          "src/extensions/reactive/index.ts",
        ),
        "extensions/editor/index": path.resolve(
          __dirname,
          "src/extensions/editor/index.ts",
        ),
        "extensions/solid/index": path.resolve(
          __dirname,
          "src/extensions/solid/index.ts",
        ),
        primitives: path.resolve(__dirname, "src/primitives.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "js" : "cjs"}`,
    },
    rollupOptions: {
      // solid-js is an optional peerDependency — never bundle it.
      external: ["solid-js"],
    },
  },
}));
