import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

export default defineConfig({
  define: {
    __DEV__: true,
  },
  test: {
    environment: "node",
    // Collect ONLY from this checkout's `src/`. Every test in the repo lives
    // there, and the default scan starts at the project root — which picks up
    // any git worktree parked inside it. `.claude/worktrees/<branch>/src/` holds
    // a second full copy of the suite, so an unscoped run reports roughly twice
    // the file count and validates another branch alongside this one. A release
    // gate has to count this tree and nothing else.
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
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
});
