import crypto from "node:crypto";
/** The immutable worker input format shared by planning and handoff storage. */
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";

export const MAX_WORKER_ARTIFACT_INPUT_BYTES = 2 * 1024 * 1024;

export function specGateRepairInputFormatUnavailable(message = "Spec Gate repair requires its versioned selected-input descriptor") {
  return new WorkerArtifactHandoffError("recovery-required", "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE",
    message, { retryable: false, recoveryPossible: false, data: { failureKind: "step-admission" } });
}

export function workerArtifactStableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(workerArtifactStableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${workerArtifactStableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The raw-byte digest shared by handoff codecs and their immutable source blobs. */
export function workerArtifactDigest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Reject stored fields that a typed constructor would otherwise normalize or omit. */
export function assertWorkerArtifactStoredValue(value, canonical, label) {
  if (workerArtifactStableStringify(value) !== workerArtifactStableStringify(canonical)) {
    throw new TypeError(`${label} contains unknown, missing or noncanonical fields`);
  }
}
