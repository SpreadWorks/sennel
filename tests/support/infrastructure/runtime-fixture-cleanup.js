import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { testTemporaryRoot } from "../../test-environment.js";
import { removeTmpDir } from "../builders/tmp-dir.js";

/** A retained control failure preserves its evidence even after a later exact receipt. */
export function removeQuiescentRuntimeFixture({ mainRoot, executionRoot = mainRoot,
  runId = null, specId = null, cleanup = () => removeTmpDir(mainRoot) }) {
  if (testTemporaryRoot().retained) return false;
  try {
    const main = path.resolve(mainRoot);
    for (const root of new Set([main, path.resolve(executionRoot)])) {
      let removed = false;
      if (root !== main && typeof runId === "string" && runId !== ""
        && typeof specId === "string" && specId !== "") {
        try { fs.lstatSync(root); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          removed = true;
        }
      }
      if (removed) ProcessExecutionRuntime.inspectRetainedClosedCheckout({ mainRoot: main, executionRoot: root, runId, specId });
      else ProcessExecutionRuntime.assertQuiescent({ mainRoot: main, executionRoot: root, runId, specId });
    }
  }
  catch {
    testTemporaryRoot().retainOnUnconfirmedExecution();
    return false;
  }
  cleanup();
  return true;
}

/** Test-owned control-child teardown only; no business stop receipt is supplied. */
export async function terminateFixtureCoordinator(runtime) {
  const child = runtime.control.child;
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit");
    child.ref(); child.kill(); await stopped;
  }
}
