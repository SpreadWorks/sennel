import path from "node:path";
import { RepairFingerprintManifest, buildRepairStateManifest } from "./repair-state-identity.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { FlowTargetIdentity } from "../../lib/flow-target-identity-authority.js";
import { flowStateSpecLocation } from "../../lib/flow-workspace.js";

function requiredSpecPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("repair fingerprint requires a manager-bound spec path");
  }
  return value.trim();
}

/** One current canonical source; command views never supply historical authority. */
class FlowRepairFingerprintCapture {
  constructor({ root, artifactRoot, specPath, state, flowManager }) {
    if (state === null) throw new CurrentFlowStateConflictError("Flow fingerprint requires its selected state");
    this.flowManager = flowManager;
    this.expected = state;
    this.location = flowManager.specLocation(state.specId);
    this.executionRoot = path.resolve(root);
    const selected = flowStateSpecLocation(state);
    if (path.resolve(artifactRoot ?? root) !== this.location.repositoryRoot
      || specPath !== this.location.relativeSpecFile
      || (selected !== null && (selected.repositoryRoot !== this.location.repositoryRoot
        || selected.relativeFlowStateFile !== this.location.relativeFlowStateFile))) {
      throw new CurrentFlowStateConflictError("Flow fingerprint roots or Version differ from their canonical source");
    }
    this.identity = FlowTargetIdentity.active(state, state.execution.mode, this.location.specRoot);
    Object.freeze(this);
  }
  #accept(state) {
    this.identity.assertState(state, { specRoot: this.location.specRoot });
    if (state.flowVersionId !== this.expected.flowVersionId) {
      throw new CurrentFlowStateConflictError("Flow fingerprint Version identity changed before capture");
    }
    if (this.executionRoot !== path.resolve(this.flowManager.executionRoot(state))) {
      throw new CurrentFlowStateConflictError("Flow fingerprint execution root differs from its canonical source");
    }
    return state;
  }
  state() {
    // The existing reader owns freshness/lock reuse. A typed value alone does
    // not prove that its originating catalog lock is still held.
    return this.flowManager.readCanonicalTransitionView({ specId: this.expected.specId,
      read: (view) => this.#accept(view.state) });
  }
}

/**
 * Capture the execution target used to bind review and test evidence.
 * Durable artifacts are excluded by the manifest builder; callers must pass
 * the Version-resolved spec path rather than asking this value API to infer a
 * legacy sibling from projected Flow state.
 */
export function buildRepairFingerprint({ root, artifactRoot = null, specPath, state = null, flowManager = null, truncated = false } = {}) {
  if (truncated) throw new Error("truncated repair fingerprint is not valid evidence");
  specPath = requiredSpecPath(specPath);
  if (flowManager !== null) state = new FlowRepairFingerprintCapture({
    root, artifactRoot, specPath, state, flowManager,
  }).state();
  // This adapter performs native source reads after its canonical reader callback.
  return buildRepairStateManifest({ root, artifactRoot, specPath, state, pinMissingBaseline: false });
}

export function assertRepairFingerprint({ artifact, fingerprint, label = "artifact" } = {}) {
  const current = fingerprint instanceof RepairFingerprintManifest
    ? fingerprint
    : new RepairFingerprintManifest(fingerprint);
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`${label} must be an object`);
  }
  if (artifact.repairFingerprint !== current.hash) {
    throw new Error(`${label} repairFingerprint mismatch: expected ${current.hash}, got ${artifact.repairFingerprint}`);
  }
  return artifact;
}
