import fs from "node:fs";
import path from "node:path";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";

/** Observe the coordinator's existing receipt-based closure, without reclaiming it. */
export function waitForRuntimeHostClosure({ mainRoot, executionRoot = mainRoot, executionId, ownerLock }) {
  let watcher;
  let timer;
  const closed = new Promise((resolve, reject) => {
    const check = () => {
      try {
        const inventory = ProcessExecutionRuntime.inspect({ mainRoot, executionRoot });
        const execution = inventory?.executions.find(entry => entry.executionId === executionId);
        if (inventory?.slot === null && execution?.status === "closed" && !fs.existsSync(ownerLock)) {
          resolve(inventory);
        }
      } catch (cause) { reject(cause); }
    };
    watcher = fs.watch(path.dirname(ownerLock), check);
    timer = setTimeout(() => reject(new Error("Complete receipt host-loss closure was not saved")), 10000);
    check();
  });
  return closed.finally(() => { watcher?.close(); clearTimeout(timer); });
}
