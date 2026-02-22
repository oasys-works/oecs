import { defineConfig, type Plugin } from "vite";
import dts from "vite-plugin-dts";
import fs from "fs";
import path from "path";

/**
 * Replace __DEV__ / __PROD__ with runtime process.env checks so
 * consumers' bundlers can tree-shake dev-only code paths.
 */
function replaceDevGlobals(): Plugin {
  return {
    name: "replace-dev-globals",
    transform(code, id) {
      if (id.includes("node_modules")) return null;
      const result = code.replace(
        /\b__DEV__\b/g,
        'process.env.NODE_ENV !== "production"',
      );
      return result !== code ? result : null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === "build"
      ? [replaceDevGlobals(), dts({ tsconfigPath: "./tsconfig.build.json" })]
      : []),
  ],

  define:
    command === "build"
      ? {}
      : {
          __DEV__: "true",
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
      entry: path.resolve(__dirname, "src/index.ts"),
      formats: ["es", "cjs"],
      fileName: (format) => (format === "es" ? "index.js" : "index.cjs"),
    },
  },
}));
