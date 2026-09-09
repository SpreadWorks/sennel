import { SourceMutationManifest } from "./worker-artifact-handoff.js";

/** Facts observed after an admitted Task source worker failed, before any retry. */
export class TaskSourceFailureObservation {
  constructor({ request, error, mutationAuthority, agentError = null }) {
    if (!request.policy.preservesRejectedSource) throw new Error("Task source failure requires a Task triage or repair request");
    this.request = request;
    this.error = error;
    this.agentError = agentError;
    this.manifest = null;
    this.integrityFailure = null;
    try {
      mutationAuthority.assertSourceCanonicalTransaction(request);
      this.manifest = SourceMutationManifest.capture({ baseline: request.sourceMutationBaseline });
    } catch (cause) {
      this.integrityFailure = cause;
    }
    Object.freeze(this);
  }

  failure() {
    const sourceChanged = this.integrityFailure !== null || this.manifest.mutations.length > 0;
    const semantic = !sourceChanged && this.agentError === null && this.error.data?.failureKind === "semantic";
    return {
      category: sourceChanged ? "source-integrity" : semantic ? "semantic" : "tooling",
      code: sourceChanged ? "TASK_SOURCE_STAGE_INTEGRITY_FAILURE" : this.error.code,
      message: this.integrityFailure?.message ?? this.error.message,
      retryable: !sourceChanged,
      retryKind: sourceChanged ? null : semantic ? "semantic" : "tooling",
    };
  }

  record(flowManager, { sourceHandoffSettlement = null } = {}) {
    const state = flowManager.canonicalState(this.request.specId);
    const expected = this.request.sourceMutationBaseline.attempt;
    if (state?.runId !== this.request.runId || state.attempt?.id !== expected.id || state.attempt?.sequence !== expected.sequence || state.attempt?.nodeId !== expected.nodeId) return false;
    if (state.attempt.failure !== null) return false;
    return flowManager.failCurrentAttemptIfCurrent({
      specId: this.request.specId,
      expectedRunId: this.request.runId,
      expectedAttempt: expected,
      failure: this.failure(),
      sourceHandoffSettlement,
      result: {
        outcome: "failed", summary: this.error.message, confirmedAt: new Date().toISOString(),
        artifactRefs: [{ kind: "worker-handoff-request", id: this.request.requestDigest }],
      },
    });
  }
}
