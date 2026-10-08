import { NonGateTargetBinding } from "./non-gate-transition.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { ReviewWorkUnitManifest } from "./review-work-unit-values.js";
import { AgentProcessStopEvidence, AgentProviderCompletionEvidence } from "../../lib/agent-failure.js";
import { AgentResponseProtocolEvidence } from "../../lib/agent-response-protocol.js";

/** Original boundary-classified failure; no retry or continuation is selected here. */
export class ReviewStepFailureRecord {
  constructor(value) {
    if (!["tooling", "source-integrity"].includes(value?.category) || typeof value.code !== "string" || typeof value.message !== "string"
      || typeof value.retryable !== "boolean" || ![null, "tooling"].includes(value.retryKind)
      || value.category === "source-integrity" && (value.retryable || value.retryKind !== null)) {
      throw new TypeError("Review failure record requires classified canonical facts");
    }
    this.category = value.category;
    this.code = value.code;
    this.message = value.message;
    this.retryable = value.retryable;
    this.retryKind = value.retryKind;
    this.agentStopEvidence = value.agentStopEvidence == null ? null : AgentProcessStopEvidence.from(value.agentStopEvidence);
    this.agentProviderCompletionEvidence = value.agentProviderCompletionEvidence == null ? null : AgentProviderCompletionEvidence.from(value.agentProviderCompletionEvidence);
    this.responseProtocolEvidence = value.responseProtocolEvidence == null ? null : AgentResponseProtocolEvidence.from(value.responseProtocolEvidence);
    this.agentFailureKind = value.agentFailureKind ?? null;
    this.recoveryHint = value.recoveryHint ?? null;
    this.attemptCount = value.attemptCount ?? null;
    this.maxAttempts = value.maxAttempts ?? null;
    Object.freeze(this);
  }
  toJSON() {
    return { category: this.category, code: this.code, message: this.message,
      retryable: this.retryable, retryKind: this.retryKind,
      ...(this.agentStopEvidence === null ? {} : { agentStopEvidence: this.agentStopEvidence.toJSON() }),
      ...(this.agentProviderCompletionEvidence === null ? {} : { agentProviderCompletionEvidence: this.agentProviderCompletionEvidence.toJSON() }),
      ...(this.responseProtocolEvidence === null ? {} : { responseProtocolEvidence: this.responseProtocolEvidence.toJSON() }),
      ...(this.agentFailureKind === null ? {} : { agentFailureKind: this.agentFailureKind }),
      ...(this.recoveryHint === null ? {} : { recoveryHint: this.recoveryHint }),
      ...(this.attemptCount === null ? {} : { attemptCount: this.attemptCount, maxAttempts: this.maxAttempts }) };
  }
}

/** Exact stopped Review observation supplied to a registered Step and its Error Result. */
export class ReviewStepFailureObservation {
  constructor({ identity, stepId, taskId = null, failure, manifest = null,
    executionManifestDigest = null, checkpointDigest = null, diagnostics = null }) {
    if (!(identity instanceof NonGateTargetBinding) || !["task-review", "impl-review"].includes(stepId)
      || (stepId === "task-review") !== (taskId !== null)
      || (taskId === null ? identity.stepId !== stepId
        : !new TaskStepIdentity({ taskId, role: "review" }).matchesNode(identity.stepId))
      || manifest !== null && (!(manifest instanceof ReviewWorkUnitManifest)
        || manifest.runId !== identity.runId || manifest.specId !== identity.specId
        || manifest.nodeId !== identity.stepId || manifest.attemptId !== identity.attempt.id)) {
      throw new TypeError("Review failure observation requires its exact responsibility and Attempt");
    }
    this.identity = identity;
    this.stepId = stepId;
    this.taskId = taskId;
    this.failure = failure instanceof ReviewStepFailureRecord ? failure : new ReviewStepFailureRecord(failure);
    this.manifest = manifest;
    this.executionManifestDigest = executionManifestDigest;
    this.checkpointDigest = checkpointDigest;
    this.diagnostics = diagnostics === null ? null : Object.freeze(structuredClone(diagnostics));
    Object.freeze(this);
  }
  toJSON() {
    return { identity: this.identity.toJSON(), stepId: this.stepId, taskId: this.taskId,
      failure: this.failure.toJSON(), manifest: this.manifest?.toJSON() ?? null,
      executionManifestDigest: this.executionManifestDigest, checkpointDigest: this.checkpointDigest,
      diagnostics: this.diagnostics };
  }
  toError() {
    const error = new Error(this.failure.message);
    error.code = this.failure.code;
    error.data = { ...(this.diagnostics ?? {}), reviewFailure: this.toJSON() };
    return error;
  }
  static fromJSON(value) {
    return new ReviewStepFailureObservation({ ...value, identity: new NonGateTargetBinding(value.identity),
      failure: new ReviewStepFailureRecord(value.failure),
      manifest: value.manifest === null ? null : new ReviewWorkUnitManifest(value.manifest) });
  }
}
