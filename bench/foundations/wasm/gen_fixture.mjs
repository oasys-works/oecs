/**
 * Write the checked-in store-reader module the unit suite runs against.
 *
 * The suite needs a real module, and it must not build one: a compiler is not
 * a dependency of the test suite, and a module emitted at test time proves only
 * that the emitter and the test agree. The binary is checked in, so the test
 * compares the engine against bytes that were fixed before the change under
 * test.
 *
 * Regenerate it after any change to the emitter, to the module bodies, or to
 * the store's header and descriptor layout:
 *
 *   node bench/foundations/wasm/gen_fixture.mjs
 *
 * Then run the reader test. A layout change the module does not follow fails
 * the walk comparison there. That is the point of checking the binary in.
 *
 * The module imports `env.memory`, shared, with a maximum of `MAX_PAGES` pages.
 * A world the test builds must declare the same maximum, or the instantiation
 * fails.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitAbiModule } from "./abi_module.mjs";
import { MAX_PAGES } from "./world.mjs";

const OUT = fileURLToPath(
	new URL("../../../src/core/ecs/__tests__/fixtures/store_reader.wasm", import.meta.url)
);

const bytes = emitAbiModule({ minPages: 1, maxPages: MAX_PAGES });
mkdirSync(fileURLToPath(new URL("../../../src/core/ecs/__tests__/fixtures/", import.meta.url)), {
	recursive: true
});
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT}, ${bytes.length} bytes, maximum ${MAX_PAGES} pages`);
