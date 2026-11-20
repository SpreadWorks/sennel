import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { AtomicFile } from "../../src/lib/atomic-file.js";
import { ProcessExecutionRuntime, ProcessExecutionControlFailure } from "../../src/lib/process-execution-runtime.js";
import { managedMonotonicNow } from "../../src/lib/managed-stop-operation.js";
import { InitialInventoryObservationGate, InitialInventoryCatchCheckpoint }
  from "../support/infrastructure/initial-inventory-observation.js";

const gate = new InitialInventoryObservationGate(workerData.state);
const checkpoint = new InitialInventoryCatchCheckpoint(workerData.checkpoint);
const prefix = path.join(workerData.mainRoot, ".sennel", "process-runtime") + path.sep;
const original = AtomicFile.prototype.readSnapshot;
const reads = [];
let startedAt = null;
let timingPremise = true;

function boundedError(cause) {
  return { name: cause.name, code: cause.code, reason: cause.reason, message: cause.message,
    typedControlFailure: cause instanceof ProcessExecutionControlFailure,
    stack: String(cause.stack).split("\n").slice(0, 10).join("\n") };
}

AtomicFile.prototype.readSnapshot = function () {
  if (!this.filePath.startsWith(prefix) || path.basename(this.filePath) !== "registry.json") {
    return Reflect.apply(original, this, []);
  }
  const stack = new Error("Actual registry snapshot caller").stack;
  const entry = { ordinal: reads.length + 1, filePath: this.filePath,
    catchSide: checkpoint.matches(stack), stack, captureCompleted: false,
    startedElapsedMs: managedMonotonicNow() - startedAt };
  reads.push(entry);
  if (entry.ordinal === 3) {
    // Release only scheduling. Even an unexpected callsite delegates normally
    // and is reported as a failed premise, never made into a catch observation.
    gate.mark("after");
    timingPremise = gate.waitWithinObservation("done", startedAt) && timingPremise;
  }
  let snapshot;
  try {
    snapshot = Reflect.apply(original, this, []);
    entry.captureCompleted = true;
    entry.completedElapsedMs = managedMonotonicNow() - startedAt;
    entry.snapshot = snapshot === null ? null : {
      digest: snapshot.digest, identity: snapshot.identity.toJSON(), bytes: snapshot.byteLength,
    };
  } catch (cause) {
    entry.captureError = boundedError(cause);
    throw cause;
  }
  if (entry.ordinal === 1) {
    gate.mark("before");
    timingPremise = gate.waitWithinObservation("stage", startedAt) && timingPremise;
  }
  return snapshot;
};

gate.mark("ready");
if (!gate.wait("start")) {
  AtomicFile.prototype.readSnapshot = original;
  gate.abort();
  parentPort.postMessage({ setupInterrupted: true, reads });
} else {
  startedAt = managedMonotonicNow();
  let inventory, error;
  try { inventory = ProcessExecutionRuntime.inspect({ mainRoot: workerData.mainRoot }); }
  catch (cause) { error = boundedError(cause); }
  finally {
    AtomicFile.prototype.readSnapshot = original;
    // Unblock producer cleanup on any real error or unmet fixture premise.
    gate.abort();
  }
  parentPort.postMessage({ inventory, error, reads, timingPremise,
    elapsedMs: managedMonotonicNow() - startedAt, checkpoint: checkpoint.toJSON() });
}
