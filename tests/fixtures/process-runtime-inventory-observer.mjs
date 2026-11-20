import { parentPort, workerData } from "node:worker_threads";
import { ProcessExecutionRuntime } from "../../src/lib/process-execution-runtime.js";
import { ProcessLock } from "../../src/lib/process-lock.js";

const state = new Int32Array(workerData.state);
const inspect = ProcessLock.prototype.inspect;
ProcessLock.prototype.inspect = function () {
  const observation = inspect.call(this);
  if (this.kind === "process-runtime-admission" && observation !== null) {
    // Release the actual producer only after the reader has captured its
    // published admission. This wrapper preserves the real lock observation.
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
  }
  return observation;
};

parentPort.postMessage({ phase: "ready" });
Atomics.wait(state, 0, 0);
try {
  const inventory = ProcessExecutionRuntime.inspect({ mainRoot: workerData.mainRoot });
  parentPort.postMessage({ inventory });
} catch (cause) {
  parentPort.postMessage({ error: { code: cause.code, message: cause.message } });
} finally {
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
}
