import crypto from "node:crypto";
import { CurrentAttemptIdentity, CanonicalFlowArtifactWrite } from "./current-flow-state.js";
import { ReviewWorkUnitManifest } from "./review-work-unit.js";

export const TASK_REVIEW_RECONCILIATION_KEY = "task.review.reconciliation";
export function reconciliationDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Immutable proposal from a present-time observation, not past retry evidence. */
export class TaskReviewReconciliationProposal {
  #value;
  constructor(value) {
    const keys = ["runId", "specId", "issue", "taskId", "nodeId", "previousAttempt", "stateDigest", "catalogDigest", "sourceFingerprint", "snapshot", "baseline", "workUnits", "digest"];
    if (!value || Object.keys(value).sort().join() !== keys.sort().join()
      || !Array.isArray(value.workUnits)
      || ["stateDigest", "catalogDigest", "sourceFingerprint", "digest"].some(key => !/^[a-f0-9]{64}$/.test(value[key]))
      || value.digest !== reconciliationDigest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest")))) {
      throw new Error("Task Review reconciliation proposal schema or digest is invalid");
    }
    const previous = CurrentAttemptIdentity.from(value.previousAttempt);
    if (value.nodeId !== `${value.taskId}-review` || previous.nodeId !== value.nodeId
      || typeof value.runId !== "string" || !value.runId || typeof value.specId !== "string" || !value.specId
      || value.baseline.attemptId !== previous.id || value.baseline.attempt !== previous.sequence
      || value.baseline.runId !== value.runId || value.baseline.specId !== value.specId || value.baseline.issue !== value.issue
      || value.snapshot.attempt.id !== previous.id || value.snapshot.attempt.nodeId !== previous.nodeId
      || value.snapshot.attempt.sequence !== previous.sequence) {
      throw new Error("Task Review reconciliation proposal identities disagree");
    }
    this.#value = structuredClone(value);
    Object.freeze(this);
  }
  static create(value) { return new TaskReviewReconciliationProposal({ ...value, digest: reconciliationDigest(value) }); }
  toJSON() { return structuredClone(this.#value); }
  get digest() { return this.#value.digest; }
  get runId() { return this.#value.runId; }
  get specId() { return this.#value.specId; }
  get taskId() { return this.#value.taskId; }
  get stateDigest() { return this.#value.stateDigest; }
  get catalogDigest() { return this.#value.catalogDigest; }
  get previousAttempt() { return structuredClone(this.#value.previousAttempt); }
  get snapshot() { return structuredClone(this.#value.snapshot); }
  get workUnits() { return structuredClone(this.#value.workUnits); }
}

/** An explicit present-time input adoption, never a historical zero-effect claim. */
export class TaskReviewReconciliationRecord {
  #value;
  constructor(value) {
    const keys = ["version", "proposal", "currentAttempt", "reason", "digest"];
    if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()) || value.version !== 1) {
      throw new Error("invalid Task Review reconciliation record");
    }
    const { currentAttempt, reason } = value;
    const proposal = (value.proposal instanceof TaskReviewReconciliationProposal
      ? value.proposal : new TaskReviewReconciliationProposal(value.proposal)).toJSON();
    const previous = CurrentAttemptIdentity.from(proposal.previousAttempt);
    const next = CurrentAttemptIdentity.from(currentAttempt);
    if (proposal.nodeId !== `${proposal.taskId}-review` || previous.nodeId !== proposal.nodeId
      || next.nodeId !== previous.nodeId || next.sequence !== previous.sequence + 1 || next.id === previous.id
      || typeof reason !== "string" || reason.trim().length < 20 || reason.length > 500
      || typeof proposal.runId !== "string" || typeof proposal.specId !== "string"
      || proposal.digest !== reconciliationDigest(Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== "digest")))) {
      throw new Error("Task Review reconciliation identity or proposal is invalid");
    }
    for (const archived of proposal.workUnits) {
      const manifest = new ReviewWorkUnitManifest(archived.manifest);
      if (manifest.runId !== proposal.runId || manifest.specId !== proposal.specId
        || manifest.taskId !== proposal.taskId || manifest.nodeId !== proposal.nodeId
        || manifest.digest !== archived.manifestDigest || archived.inputs.length !== manifest.inputs.length) {
        throw new Error("Task Review reconciliation archive identity is invalid");
      }
      for (const [index, input] of manifest.inputs.entries()) {
        const saved = archived.inputs[index];
        const bytes = Buffer.from(saved.bytes, "base64");
        if (saved.relativePath !== input.relativePath || bytes.length !== input.byteLength
          || crypto.createHash("sha256").update(bytes).digest("hex") !== input.digest) {
          throw new Error("Task Review reconciliation archive bytes are invalid");
        }
      }
    }
    const unsigned = { version: 1, proposal, currentAttempt: next.toJSON(), reason };
    if (value.digest !== reconciliationDigest(unsigned)) throw new Error("Task Review reconciliation digest mismatch");
    this.#value = structuredClone({ ...unsigned, digest: value.digest });
    Object.freeze(this);
  }
  static create({ proposal, currentAttempt, reason }) {
    const value = { version: 1, proposal: proposal instanceof TaskReviewReconciliationProposal ? proposal.toJSON() : proposal,
      currentAttempt: CurrentAttemptIdentity.from(currentAttempt).toJSON(), reason };
    return new TaskReviewReconciliationRecord({ ...value, digest: reconciliationDigest(value) });
  }
  toJSON() { return structuredClone(this.#value); }
  get proposal() { return this.toJSON().proposal; }
  get currentAttempt() { return CurrentAttemptIdentity.from(this.#value.currentAttempt); }
  get previousAttempt() { return CurrentAttemptIdentity.from(this.#value.proposal.previousAttempt); }
  get artifactWrite() {
    return new CanonicalFlowArtifactWrite({
      logicalKey: TASK_REVIEW_RECONCILIATION_KEY,
      parameters: { taskId: this.#value.proposal.taskId, attemptId: this.currentAttempt.id },
      mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(this.toJSON(), null, 2)}\n`),
    });
  }
  assertPublication({ state, activity, baseline }) {
    if (!this.previousAttempt.matchesFailed(state) || this.proposal.runId !== state.runId
      || this.proposal.specId !== state.specId || this.proposal.stateDigest !== reconciliationDigest(state.toJSON())
      || activity.transition.operation !== "retry_recovery_attempt"
      || activity.attemptId !== this.currentAttempt.id || activity.sequence !== this.currentAttempt.sequence
      || activity.nodeId !== this.currentAttempt.nodeId
      || baseline.attemptId !== this.currentAttempt.id || baseline.attempt !== this.currentAttempt.sequence) {
      throw new Error("Task Review reconciliation does not bind its publication");
    }
    const expected = { ...this.proposal.baseline, attemptId: this.currentAttempt.id, attempt: this.currentAttempt.sequence };
    if (reconciliationDigest(baseline.toJSON()) !== reconciliationDigest(expected)) {
      throw new Error("Task Review reconciliation baseline differs from the approved current input");
    }
  }
}
