/**
 * One worker of the shadow-stack probe. It instantiates the module over the
 * host's memory and runs its own row range on every barrier release.
 *
 * The one thing that changes between the two lanes is `stackTop`. When it is
 * null the worker leaves `__stack_pointer` where the link put it, which is what
 * a pool did before the engine assigned regions. When it holds an address the
 * worker moves the global there, which is the fix.
 *
 * The worker never touches the store. It reads four column offsets from its
 * start message and writes only inside them.
 */
import { parentPort, workerData } from "node:worker_threads";
import { workerLoop } from "../par/pool.mjs";

const ctl = new Int32Array(workerData.control);
const memory = workerData.memory;
const instance = new WebAssembly.Instance(workerData.module, { env: { memory } });
if (workerData.stackTop !== null) instance.exports.__stack_pointer.value = workerData.stackTop;

const call = instance.exports[workerData.exportName];
const [px, py, vx, vy] = workerData.columns;
const rows = workerData.rows;
const index = workerData.index;
const count = workerData.workerCount;
const dt = workerData.dt;
const begin = Math.floor((rows * index) / count);
const end = Math.floor((rows * (index + 1)) / count);

parentPort.postMessage({ ready: index, stackPointer: instance.exports.__stack_pointer.value });

workerLoop(ctl, () => {
	call(px, py, vx, vy, begin, end, dt);
});
