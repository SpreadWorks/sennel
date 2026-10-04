import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { AgentFileReference } from "../../lib/agent-file-reference.js";
import { RegularFileSnapshot, captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { workerArtifactStableStringify, MAX_WORKER_ARTIFACT_INPUT_BYTES,
  specGateRepairInputFormatUnavailable } from "./worker-artifact-input-format.js";
export { specGateRepairInputFormatUnavailable } from "./worker-artifact-input-format.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { SpecGateRepairSelectedContentIdentity } from "./spec-gate-repair-input-unavailable.js";
import { SpecGateRepairProgressReader } from "./spec-gate-repair-progress-reader.js";

export const SPEC_GATE_REPAIR_INPUT_NAME = "spec-gate-repair-context.json";

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw specGateRepairInputFormatUnavailable(`${label} has an invalid shape`);
  }
}

/** A catalog locator; no caller-controlled filesystem path can become canonical. */
export class SpecGateRepairInputSnapshotLocator {
  constructor({ logicalKey, attemptId, attemptSequence, generation, phase, fragment }) {
    if (logicalKey !== "spec.gate.repair.progress" || phase !== "checkpoint" || fragment !== "context"
      || typeof attemptId !== "string" || attemptId.trim() === ""
      || !Number.isSafeInteger(attemptSequence) || attemptSequence < 1
      || !Number.isSafeInteger(generation) || generation < 0) {
      throw specGateRepairInputFormatUnavailable("Spec Gate repair snapshot locator is invalid");
    }
    Object.assign(this, { logicalKey, attemptId, attemptSequence, generation, phase, fragment });
    Object.freeze(this);
  }
  static fromJSON(value) {
    exactKeys(value, ["logicalKey", "attemptId", "attemptSequence", "generation", "phase", "fragment"], "repair snapshot locator");
    return new this(value);
  }
  toJSON() { return { ...this }; }
}

/** Small wire capability for one exact selection; the selected body stays parent-owned. */
export class SpecGateRepairInputDescriptor {
  constructor({ formatVersion = 1, logicalName, selectionDigest, selectionBytes, canonicalLocator,
    deliveryMode, deliveryReference, selectedIdentity }, { executionRoot } = {}) {
    if (formatVersion !== 1 || logicalName !== SPEC_GATE_REPAIR_INPUT_NAME
      || !/^[a-f0-9]{64}$/.test(selectionDigest)
      || !Number.isSafeInteger(selectionBytes) || selectionBytes < 0 || selectionBytes > MAX_WORKER_ARTIFACT_INPUT_BYTES
      || !["inline", "file"].includes(deliveryMode)) throw specGateRepairInputFormatUnavailable();
    const locator = canonicalLocator instanceof SpecGateRepairInputSnapshotLocator ? canonicalLocator
      : SpecGateRepairInputSnapshotLocator.fromJSON(canonicalLocator);
    exactKeys(deliveryReference, ["projectRelativePath", "digest", "byteLength"], "repair delivery reference");
    const relative = deliveryReference.projectRelativePath;
    if (typeof relative !== "string" || relative === "" || relative.includes("\\")
      || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative
      || relative.startsWith("../") || relative === ".."
      || deliveryReference.digest !== selectionDigest || deliveryReference.byteLength !== selectionBytes) {
      throw specGateRepairInputFormatUnavailable("Spec Gate repair delivery reference is invalid");
    }
    this.formatVersion = 1;
    this.logicalName = logicalName;
    this.selectionDigest = selectionDigest;
    this.selectionBytes = selectionBytes;
    this.canonicalLocator = locator;
    this.deliveryMode = deliveryMode;
    this.deliveryReference = Object.freeze({ ...deliveryReference });
    if (!(selectedIdentity instanceof SpecGateRepairSelectedContentIdentity)) {
      exactKeys(selectedIdentity, ["baseRevision", "selectionDigest", "mode", "unitIds", "findingIdentities"], "selected input identity");
    }
    this.selectedIdentity = selectedIdentity instanceof SpecGateRepairSelectedContentIdentity ? selectedIdentity
      : new SpecGateRepairSelectedContentIdentity(selectedIdentity);
    if (this.selectedIdentity.selectionDigest !== this.selectionDigest) throw specGateRepairInputFormatUnavailable();
    if (executionRoot !== undefined && !path.isAbsolute(executionRoot)) throw specGateRepairInputFormatUnavailable();
    Object.freeze(this);
  }
  static fromJSON(value, options) {
    exactKeys(value, ["formatVersion", "logicalName", "selectionDigest", "selectionBytes", "canonicalLocator",
      "deliveryMode", "deliveryReference", "selectedIdentity"], "repair input descriptor");
    return new this(value, options);
  }
  toJSON() { return { formatVersion: this.formatVersion, logicalName: this.logicalName,
    selectionDigest: this.selectionDigest, selectionBytes: this.selectionBytes,
    canonicalLocator: this.canonicalLocator.toJSON(), deliveryMode: this.deliveryMode,
    deliveryReference: { ...this.deliveryReference }, selectedIdentity: this.selectedIdentity.toJSON() }; }
  deliveryPath(executionRoot) { return path.resolve(executionRoot, this.deliveryReference.projectRelativePath); }
  expectedReference(executionRoot, bytes) {
    const snapshot = new RegularFileSnapshot({ filePath: this.deliveryPath(executionRoot), bytes });
    this.assertBytes(snapshot.bytes);
    return AgentFileReference.fromSnapshot({ projectRoot: executionRoot, snapshot });
  }
  assertBytes(bytes) {
    if (bytes.length !== this.selectionBytes || createHash("sha256").update(bytes).digest("hex") !== this.selectionDigest) {
      throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_INPUT_SNAPSHOT_CHANGED",
        "Spec Gate repair selected snapshot bytes differ from the descriptor", { retryable: false, recoveryPossible: false });
    }
  }
  restoreDocument({ flowManager, executionRoot, binding, inputDescriptor, allowUnavailableDelivery = false }) {
    let bytes;
    if (flowManager) {
      const locator = this.canonicalLocator;
      const { document: saved } = new SpecGateRepairProgressReader({ flowManager,
        specId: binding.specId, attemptId: locator.attemptId, consumerNodeId: "spec-gate-repair" })
        .read(locator.generation, locator.phase);
      if (saved.runId !== binding.runId || saved.attemptSequence !== locator.attemptSequence
        || saved.inputDigest !== binding.inputDigest || saved.inputRevision !== binding.inputRevision
        || saved.requestDigest !== binding.requestDigest || saved.inputDescriptors.length !== 1
        || !isDeepStrictEqual(saved.inputDescriptors[0], inputDescriptor)
        || saved.context.baseRevision !== this.selectedIdentity.baseRevision) {
        throw specGateRepairInputFormatUnavailable("Spec Gate repair canonical selected snapshot has a foreign binding");
      }
      bytes = Buffer.from(workerArtifactStableStringify(saved.context), "utf8");
      this.assertBytes(bytes);
    }
    let delivery;
    try {
      delivery = captureRegularFile(this.deliveryPath(executionRoot),
        { label: "Spec Gate repair selected delivery", maxBytes: this.selectionBytes });
    } catch (error) {
      if (bytes === undefined || !allowUnavailableDelivery
        || !["ENOENT", "EACCES", "EPERM", "EIO"].includes(error.code)) throw error;
      return JSON.parse(bytes.toString("utf8"));
    }
    AgentFileReference.fromSnapshot({ projectRoot: executionRoot, snapshot: delivery });
    this.assertBytes(delivery.bytes);
    if (bytes !== undefined && !bytes.equals(delivery.bytes)) {
      throw specGateRepairInputFormatUnavailable("Spec Gate repair delivery differs from its canonical snapshot");
    }
    return JSON.parse((bytes ?? delivery.bytes).toString("utf8"));
  }
}
