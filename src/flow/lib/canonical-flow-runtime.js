/**
 * Canonical Flow Version 1 runtime.
 *
 * This is the production-facing boundary for a persisted Flow.  It owns the
 * Version resolver and turns lifecycle requests into typed Activities; command
 * code never derives a root flow.json path or writes a state document itself.
 */

import { DEFAULT_FLOW_SPEC_DIR, FlowWorkspace } from "../../lib/flow-workspace.js";
import { FlowVersion } from "../../lib/flow-version.js";
import {
  ActivityTransition,
  CurrentAttemptIdentity,
  CurrentFlowDefinition,
  CurrentFlowState,
  CurrentFlowStateInvariantError,
  CurrentFlowVersionStore,
  FlowActivity,
} from "./current-flow-state.js";
import {
  containsRetryRecoveryArtifactWrite,
  RetryRecoveryArtifactPublication,
} from "./retry-recovery.js";
import { DeferredFlowFindingsPublication } from "./flow-findings.js";
import { TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION } from "./task-gate-classification-recovery.js";

const TYPE_FOR_OPERATION = Object.freeze({
  add_task: "task_added",
  add_approval_task: "task_added",
  start_attempt: "attempt_started",
  retry_attempt: "attempt_retried",
  retry_gate_attempt: "attempt_retried",
  retry_recovery_attempt: "attempt_recovered",
  update_attempt: "attempt_updated",
  [TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION]: "recovery",
  fail_attempt: "attempt_failed",
  record_failure: "failure_recorded",
  confirm_attempt: "result_confirmed",
  complete_draft_completion: "result_confirmed",
  complete_task_review_stage: "result_confirmed",
  advance_task_review_stage: "result_confirmed",
  complete_acceptance_decision_noop: "result_confirmed",
  rewind: "recovery",
  rewind_test_evidence: "recovery",
  repair_test_review: "recovery",
  settle_test_review_repair_timeout: "result_confirmed",
  repair_scenario_validity: "recovery",
  repair_implementation: "recovery",
  triage_implementation_for_repair: "recovery",
  triage_implementation_no_repair: "recovery",
  repair_acceptance_review: "recovery",
  preimplementation_bootstrap: "recovery",
  recover_existing_implementation: "recovery",
  reopen_draft_preimplementation: "recovery",
  reopen_draft_task_addition: "recovery",
  reopen_draft_spec_correction: "recovery",
  plan_gate_repair: "recovery",
  recover_attempt: "recovery",
  recover_missing_producer_artifact: "recovery",
  recover_task_execution_overrun: "recovery",
  park_flow: "flow_parked",
  resume_flow: "flow_resumed",
  finalize_flow: "flow_finalized",
  set_policy: "policy_updated",
  publish_artifacts: "artifacts_published",
  publish_plugin_artifacts: "artifacts_published",
  publish_upgrade_result: "artifacts_published",
  update_spec_record: "spec_record_updated",
  begin_outbox: "outbox_started",
  reopen_outbox: "outbox_reopened",
  complete_outbox: "outbox_completed",
  fail_outbox: "outbox_failed",
  record_dispatch_approval: "dispatch_approval_recorded",
  record_metric: "metric_recorded",
  record_note: "note_recorded",
  record_nonblocking: "nonblocking_recorded",
  continue_nonblocking: "nonblocking_recorded",
  accept_final_regression_failure: "failure_accepted",
  defer_failed_review: "failure_accepted",
  defer_failed_gate: "failure_accepted",
  skip_finalize_downstream: "finalization_downstream_updated",
  reset_finalize_downstream: "finalization_downstream_updated",
  recover_interrupted_finalize_sync: "recovery",
});

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CurrentFlowStateInvariantError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredAttempt(value, field) {
  if (value === null || value === undefined) {
    throw new CurrentFlowStateInvariantError(`${field} requires an Attempt`);
  }
  return value;
}

function requiredPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CurrentFlowStateInvariantError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Resolves only `<specRoot>/<specId>/001`.  Version selection is deliberately
 * not a caller option: production Flow Version 1 has one canonical current
 * authority, and migration code uses the same `CurrentFlowVersionStore` API.
 */
export class CanonicalFlowRuntime {
  #stores = new Map();

  constructor({ repositoryRoot, executionRoot = repositoryRoot, specRoot = DEFAULT_FLOW_SPEC_DIR, definition, versionStoreFaultInjector = null } = {}) {
    if (!(definition instanceof CurrentFlowDefinition)) {
      throw new CurrentFlowStateInvariantError("CanonicalFlowRuntime requires a CurrentFlowDefinition");
    }
    this.workspace = new FlowWorkspace({ repositoryRoot, executionRoot, specRoot });
    this.definition = definition;
    if (versionStoreFaultInjector !== null && typeof versionStoreFaultInjector !== "function") {
      throw new CurrentFlowStateInvariantError("CanonicalFlowRuntime version Store fault injector must be a function or null");
    }
    this.versionStoreFaultInjector = versionStoreFaultInjector;
    Object.freeze(this);
  }

  location(specId) {
    return this.workspace.canonicalVersion(requiredText(specId, "specId"), new FlowVersion(1));
  }

  store(specId) {
    const location = this.location(specId);
    const key = location.specId.toString();
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = new CurrentFlowVersionStore({
        location,
        definition: this.definition,
        ...(this.versionStoreFaultInjector && { faultInjector: this.versionStoreFaultInjector }),
      });
      this.#stores.set(key, store);
    }
    return store;
  }

  #freshStore(specId) {
    const location = this.location(specId);
    const key = location.specId.toString();
    // A Version store captures directory identities once it has opened the
    // root.  Creation may legitimately follow a cleanup/recreation of that
    // root, so it must start with an uncaptured Store rather than reuse the
    // old authority.
    this.#stores.delete(key);
    return this.store(key);
  }

  createFresh({ specId, flowId, flowVersionId, runId, request, issue = null, execution, lifecycle, policy, specRecord, issueSnapshot = null } = {}) {
    return this.#freshStore(specId).createFresh({
      flowId,
      flowVersionId,
      runId,
      request,
      issue,
      execution,
      lifecycle,
      policy,
      specRecord,
      issueSnapshot,
    });
  }

  load(specId) {
    return this.store(specId).load();
  }

  loadSnapshot(specId) {
    return this.store(specId).loadSnapshot();
  }
  readCurrentSpecReview(specId) {
    return this.store(specId).readCurrentSpecReview();
  }
  readCurrentSpecReviewInput(specId) {
    return this.store(specId).readCurrentSpecReviewInput();
  }
  loadTransitionSnapshot(specId) {
    return this.store(specId).loadTransitionSnapshot();
  }
  readCanonicalTransitionView(specId, read) {
    return this.store(specId).readCanonicalTransitionView(read);
  }

  assertWritable(specId) {
    return this.store(specId).assertWritable();
  }

  writeRuntimeArtifact({ specId, nodeId, artifact, expectedAttempt = null } = {}) {
    return this.store(specId).writeRuntimeArtifact({ nodeId, artifact, expectedAttempt });
  }

  activities(specId) {
    return this.store(specId).activities();
  }

  catalog(specId) {
    return this.store(specId).catalog();
  }

  apply(specId, activity, {
    taskSpec,
    specRecord,
    artifactWrites,
    artifactRemovals,
    artifactBaselines,
    testSourceBaseline,
    sourceWorkerUpgrade,
    admission,
    retryRecoveryPublication = undefined,
  } = {}) {
    const canonicalActivity = FlowActivity.canonical(activity);
    const retryPublication = retryRecoveryPublication === undefined
      ? null
      : retryRecoveryPublication;
    if (retryPublication !== null && !(retryPublication instanceof RetryRecoveryArtifactPublication)) {
      throw new CurrentFlowStateInvariantError("canonical retry recovery publication must be typed");
    }
    if (retryPublication === null && containsRetryRecoveryArtifactWrite(artifactWrites)) {
      throw new CurrentFlowStateInvariantError(
        "retry recovery artifacts require the dedicated canonical retry transition",
      );
    }
    if (retryPublication !== null) {
      retryPublication.assertFor({
        state: this.#state(specId),
        activity: canonicalActivity,
        artifactWrites,
      });
    }
    return this.store(specId).apply({
      activity: canonicalActivity,
      ...(taskSpec !== undefined && { taskSpec }),
      ...(specRecord !== undefined && { specRecord }),
      ...(artifactWrites !== undefined && { artifactWrites }),
      ...(artifactRemovals !== undefined && { artifactRemovals }),
      ...(artifactBaselines !== undefined && { artifactBaselines }),
      ...(testSourceBaseline !== undefined && { testSourceBaseline }),
      ...(sourceWorkerUpgrade !== undefined && { sourceWorkerUpgrade }),
      ...(admission !== undefined && { admission }),
    });
  }

  addTask({ specId, activityId, taskId, key, taskSpec = undefined } = {}) {
    const state = this.#state(specId);
    const nodeId = state.definition.dynamicTaskContainerId;
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId,
      transition: {
        operation: "add_task",
        nodeId,
        task: { id: requiredText(taskId, "taskId"), key: requiredText(key, "task key") },
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { taskSpec });
  }

  /** Persist one approval-owned Task admission with its typed authority. */
  addApprovalTask({ specId, activityId, taskId, key, taskSpec = undefined, admission } = {}) {
    const state = this.#state(specId);
    const nodeId = state.definition.dynamicTaskContainerId;
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId,
      transition: {
        operation: "add_approval_task",
        nodeId,
        task: {
          id: requiredText(taskId, "taskId"),
          key: requiredText(key, "task key"),
          ...(admission?.activitySource === undefined
            ? {}
            : { approvalSource: admission.activitySource.toJSON() }),
        },
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { taskSpec, admission });
  }

  startAttempt({ specId, activityId, nodeId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites = undefined, admission = undefined, retryRecoveryPublication = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId,
      operation: "start_attempt",
      attempt: requiredAttempt(attempt, "startAttempt"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      admission,
      retryRecoveryPublication,
    });
  }

  retryAttempt({ specId, activityId, attempt, artifactWrites = undefined, timing = null, provider = null, model = null, effort = null, usage = null, references, retryRecoveryPublication = undefined, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "retry_attempt",
      attempt: requiredAttempt(attempt, "retryAttempt"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      retryRecoveryPublication, admission,
    });
  }

  retryGateAttempt({ specId, activityId, attempt, references, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId, nodeId: this.#currentNodeId(state), operation: "retry_gate_attempt",
      attempt: requiredAttempt(attempt, "retryGateAttempt"), references, admission,
    });
  }

  retryRecoveryAttempt({ specId, activityId, attempt, artifactWrites = undefined, timing = null, provider = null, model = null, effort = null, usage = null, references, retryRecoveryPublication = undefined, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "retry_recovery_attempt",
      attempt: requiredAttempt(attempt, "retryRecoveryAttempt"),
      admission,
      timing, provider, model, effort, usage, references, artifactWrites, retryRecoveryPublication,
    });
  }

  updateAttempt({ specId, activityId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "update_attempt",
      attempt: requiredAttempt(attempt, "updateAttempt"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
    });
  }

  recoverTaskGateClassification({ specId, activityId, attempt, references, admission } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION,
      attempt: requiredAttempt(attempt, "recoverTaskGateClassification"),
      references,
      admission,
    });
  }

  failAttempt({ specId, activityId, failure, result, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites = undefined, artifactRemovals = undefined, expectedAttempt = null, admission = undefined } = {}) {
    const state = this.#state(specId);
    const expected = expectedAttempt === null ? null : CurrentAttemptIdentity.from(expectedAttempt);
    if (expected !== null && !expected.matches(state)) return null;
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "fail_attempt",
      attempt: null,
      failure,
      result,
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      artifactRemovals,
      admission,
    });
  }

  recordFailure({ specId, activityId, result, timing = null, provider = null, model = null, effort = null, usage = null, references, expectedAttempt = null, admission = undefined } = {}) {
    const state = this.#state(specId);
    const expected = expectedAttempt === null ? null : CurrentAttemptIdentity.from(expectedAttempt);
    if (expected !== null && !expected.matchesFailed(state)) return null;
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "record_failure",
      attempt: null,
      result,
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      admission,
    });
  }

  confirmAttempt({ specId, activityId, result, status = "done", timing = null, provider = null, model = null, effort = null, usage = null, references, specRecord, artifactWrites, artifactRemovals, artifactBaselines, testSourceBaseline, sourceWorkerUpgrade = undefined, admission = undefined, gateTaskLifecycle = null } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "confirm_attempt",
      attempt: null,
      result,
      status,
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      specRecord,
      artifactWrites,
      artifactRemovals,
      artifactBaselines,
      testSourceBaseline,
      sourceWorkerUpgrade,
      admission,
      gateTaskLifecycle,
    });
  }

  /** Publish one Task review-funnel result and apply its sealed connector atomically. */
  completeTaskReviewStage({ specId, activityId, result, plan, targetAttempt = null, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites, artifactBaselines, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: plan?.targetStepId == null ? "complete_task_review_stage" : "advance_task_review_stage",
      attempt: targetAttempt,
      result,
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      artifactBaselines,
      admission,
      taskReviewStagePlan: plan,
    });
  }

  /** One journal entry: publish connector output, confirm source, and expose the target. */
  completeDraftCompletion({ specId, activityId, result, receipt, references, artifactWrites, artifactRemovals, artifactBaselines, admission } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "draft-coverage-repair",
      operation: "complete_draft_completion",
      result,
      status: "done",
      references,
      artifactWrites,
      artifactRemovals,
      artifactBaselines,
      admission,
      stepConnectionReceipt: receipt?.toJSON?.() ?? receipt,
    });
  }

  completeAcceptanceDecisionNoOp({ specId, activityId, result, timing = null, references, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: this.#currentNodeId(state),
      operation: "complete_acceptance_decision_noop",
      attempt: null,
      result,
      status: "done",
      timing,
      references,
      admission,
    });
  }

  rewind({ specId, activityId, nodeId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites = undefined, admission = undefined, retryRecoveryPublication = undefined, expectedAttempt = null } = {}) {
    const state = this.#state(specId);
    const expected = expectedAttempt === null ? null : CurrentAttemptIdentity.from(expectedAttempt);
    if (expected !== null && !expected.matchesFailed(state)) return null;
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId,
      operation: "rewind",
      attempt: requiredAttempt(attempt, "rewind"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      admission,
      retryRecoveryPublication,
    });
  }

  /** Reset the fixed retro test-evidence route in one Version Store Activity. */
  rewindTestEvidence({ specId, activityId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "test-execute",
      operation: "rewind_test_evidence",
      attempt: requiredAttempt(attempt, "rewindTestEvidence"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
    });
  }

  /** Atomically replace rejected test-review evidence with a new test Attempt. */
  repairTestReview({ specId, activityId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "test",
      operation: "repair_test_review",
      attempt: requiredAttempt(attempt, "repairTestReview"),
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      provider,
      model,
      effort,
      usage,
      references,
    });
  }

  settleTimedOutTestReviewRepair({ specId, activityId, attempt, result, timing = null, references } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "test",
      operation: "settle_test_review_repair_timeout",
      attempt: requiredAttempt(attempt, "settleTimedOutTestReviewRepair"),
      result,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      references,
    });
  }

  /** Atomically retain scenario repair evidence and reopen the test handoff. */
  repairScenarioValidity({ specId, activityId, attempt, failure, result, timing = null, references, artifactWrites = undefined, artifactBaselines = undefined, admission = undefined } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "scenario-validity",
      operation: "repair_scenario_validity",
      attempt: requiredAttempt(attempt, "repairScenarioValidity"),
      failure,
      result,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      references,
      artifactWrites,
      artifactBaselines,
      admission,
    });
  }

  /** Atomically record a material implementation repair and restart test execution. */
  repairImplementation({ specId, activityId, attempt, result, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites = undefined, sourceWorkerUpgrade = undefined } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "impl-repair",
      operation: "repair_implementation",
      attempt: requiredAttempt(attempt, "repairImplementation"),
      result,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      sourceWorkerUpgrade,
    });
  }

  triageImplementationNoRepair({ specId, activityId, attempt, result, timing = null, references, artifactWrites = undefined, sourceWorkerUpgrade = undefined } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "impl-triage",
      operation: "triage_implementation_no_repair",
      attempt: requiredAttempt(attempt, "triageImplementationNoRepair"),
      result,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      references,
      artifactWrites,
      sourceWorkerUpgrade,
    });
  }

  triageImplementationForRepair({ specId, activityId, attempt, result, timing = null, references, artifactWrites = undefined, sourceWorkerUpgrade = undefined } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "impl-triage",
      operation: "triage_implementation_for_repair",
      attempt: requiredAttempt(attempt, "triageImplementationForRepair"),
      result,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      references,
      artifactWrites,
      sourceWorkerUpgrade,
    });
  }

  repairAcceptanceReview({ specId, activityId, attempt, result, timing = null, references, artifactWrites = undefined, admission = undefined } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId, nodeId: "acceptance-review", operation: "repair_acceptance_review",
      attempt: requiredAttempt(attempt, "repairAcceptanceReview"), result,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 }, references, artifactWrites, admission,
    });
  }

  /** Atomically apply the definition-owned scenario-validity bootstrap route. */
  preimplementationBootstrap({ specId, activityId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "implement",
      operation: "preimplementation_bootstrap",
      attempt: requiredAttempt(attempt, "preimplementationBootstrap"),
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      provider,
      model,
      effort,
      usage,
      references,
    });
  }

  /** Atomically revalidate an existing implementation and start test execution. */
  recoverExistingImplementation({ specId, activityId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "test-execute",
      operation: "recover_existing_implementation",
      attempt: requiredAttempt(attempt, "recoverExistingImplementation"),
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      provider,
      model,
      effort,
      usage,
      references,
    });
  }

  /** Apply one fixed draft-reopen route; route selection remains Store-owned. */
  reopenDraft({ specId, activityId, route, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references } = {}) {
    const state = this.#state(specId);
    if (!new Set(["preimplementation", "task-addition", "spec-correction"]).has(route)) {
      throw new CurrentFlowStateInvariantError("canonical draft reopen route is invalid");
    }
    const now = new Date().toISOString();
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "draft",
      operation: route === "task-addition"
        ? "reopen_draft_task_addition"
        : route === "spec-correction"
          ? "reopen_draft_spec_correction"
          : `reopen_draft_${route}`,
      attempt: requiredAttempt(attempt, "reopenDraft"),
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      provider,
      model,
      effort,
      usage,
      references,
    });
  }

  /** Atomically record guarded evidence and replace an active gate Attempt. */
  planGateRepair({ specId, activityId, nodeId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites = undefined, admission = undefined, gateTaskLifecycle = null } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId,
      operation: "plan_gate_repair",
      attempt: requiredAttempt(attempt, "planGateRepair"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      admission,
      gateTaskLifecycle,
    });
  }

  recover({ specId, activityId, nodeId, attempt, timing = null, provider = null, model = null, effort = null, usage = null, references, artifactWrites = undefined, admission = undefined, retryRecoveryPublication = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId,
      operation: "recover_attempt",
      attempt: requiredAttempt(attempt, "recover"),
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      artifactWrites,
      admission,
      retryRecoveryPublication,
    });
  }

  /** Restore a producer's recorded failed Attempt after a legacy consumer claim. */
  recoverMissingProducerArtifact({ specId, activityId, producerNodeId, attempt, timing = null, references, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: requiredText(producerNodeId, "missing producer artifact producerNodeId"),
      operation: "recover_missing_producer_artifact",
      attempt: requiredAttempt(attempt, "recoverMissingProducerArtifact"),
      timing,
      references,
      admission,
    });
  }

  recoverInterruptedFinalizeSync({ specId, activityId, cleanupAttempt, outbox, timing = null, references, artifactWrites = undefined } = {}) {
    const state = this.#state(specId);
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: "finalize-cleanup",
      attemptId: cleanupAttempt.id,
      sequence: cleanupAttempt.sequence,
      timing,
      references,
      transition: {
        operation: "recover_interrupted_finalize_sync",
        nodeId: "finalize-cleanup",
        task: null,
        attempt: cleanupAttempt,
        status: null,
        policy: null,
        outbox,
        approval: null,
        nonblocking: null,
        finalizeSteps: null,
      },
    }), { artifactWrites });
  }

  park({ specId, activityId } = {}) { return this.#applyLifecycle(specId, activityId, "park_flow"); }
  resume({ specId, activityId } = {}) { return this.#applyLifecycle(specId, activityId, "resume_flow"); }
  finalize({ specId, activityId } = {}) { return this.#applyLifecycle(specId, activityId, "finalize_flow"); }

  setPolicy({ specId, activityId, policy } = {}) {
    const state = this.#state(specId);
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      policy,
      transition: {
        operation: "set_policy",
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }));
  }

  /**
   * Publish durable producer output without inventing a second state update.
   * The Version Store atomically appends this Activity, writes the bytes, and
   * replaces their catalog descriptors under the active leaf's ownership.
   */
  publishArtifacts({ specId, activityId, nodeId, artifactWrites, artifactRemovals = undefined, artifactBaselines = undefined, testSourceBaseline = undefined, expectedAttempt = null, references = undefined, admission = undefined } = {}) {
    const state = this.#state(specId);
    const target = requiredText(nodeId, "artifact publication nodeId");
    const expected = expectedAttempt === null ? null : CurrentAttemptIdentity.from(expectedAttempt);
    // A non-pass producer may append its own diagnostic output after its
    // Attempt is marked failed. Both active forms retain the exact identity;
    // a replacement or stale Attempt remains forbidden.
    if (expected !== null && !expected.matches(state) && !expected.matchesFailed(state)) {
      throw new CurrentFlowStateInvariantError("canonical producer Attempt changed before artifact publication");
    }
    if (!Array.isArray(artifactWrites) || artifactWrites.length === 0) {
      throw new CurrentFlowStateInvariantError("artifact publication requires one or more artifact writes");
    }
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: target,
      attemptId: expected?.id ?? null,
      sequence: expected?.sequence ?? null,
      references,
      transition: {
        operation: "publish_artifacts",
        nodeId: target,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { artifactWrites, artifactRemovals, artifactBaselines, testSourceBaseline, admission });
  }

  /**
   * Publish the one system-owned upgrade result.  Unlike a Step producer,
   * upgrade is an external command and therefore records its Activity at the
   * Flow root while the Version Store supplies the `system` catalog claim.
   */
  publishUpgradeResult({ specId, activityId, artifactWrite } = {}) {
    const state = this.#state(specId);
    if (artifactWrite?.logicalKey !== "upgrade.result") {
      throw new CurrentFlowStateInvariantError("canonical upgrade publication requires upgrade.result");
    }
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      transition: {
        operation: "publish_upgrade_result",
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { artifactWrites: [artifactWrite] });
  }

  publishPluginArtifacts({ specId, activityId, artifactWrites } = {}) {
    const state = this.#state(specId);
    if (!Array.isArray(artifactWrites) || artifactWrites.length === 0) {
      throw new CurrentFlowStateInvariantError("plugin artifact publication requires one or more artifact writes");
    }
    if (artifactWrites.some((write) => write?.artifact?.logicalKey !== "plugin.lifecycle.artifact")) {
      throw new CurrentFlowStateInvariantError("plugin artifact publication accepts only plugin.lifecycle.artifact writes");
    }
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      transition: {
        operation: "publish_plugin_artifacts",
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { artifactWrites });
  }

  /**
   * Replace the authoritative Spec through its narrow typed writer. The
   * Store validates both the active Task leaf and the exact Spec record;
   * callers cannot turn this into a generic flow.json mutation.
   */
  updateSpecRecord({ specId, activityId, nodeId, specRecord } = {}) {
    const state = this.#state(specId);
    const target = requiredText(nodeId, "canonical Spec update nodeId");
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: target,
      transition: {
        operation: "update_spec_record",
        nodeId: target,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { specRecord });
  }

  /**
   * Persist only an unfinished side effect in flow.json.  The matching
   * Activity retains its durable history and protects crash recovery from a
   * second, callback-defined outbox format.
   */
  beginOutbox({ specId, activityId, outbox } = {}) {
    return this.#applyOutbox(specId, activityId, "begin_outbox", outbox);
  }

  reopenOutbox({ specId, activityId, outbox, timing = null } = {}) {
    return this.#applyOutbox(specId, activityId, "reopen_outbox", outbox, timing);
  }

  completeOutbox({ specId, activityId, outbox } = {}) {
    return this.#applyOutbox(specId, activityId, "complete_outbox", outbox);
  }

  failOutbox({ specId, activityId, outbox, failure } = {}) {
    return this.#applyOutbox(specId, activityId, "fail_outbox", {
      ...outbox,
      failure: failure ?? outbox?.failure ?? null,
    });
  }

  finalizeDownstream({ specId, activityId, operation, stepIds } = {}) {
    if (!["skip_finalize_downstream", "reset_finalize_downstream"].includes(operation)) {
      throw new CurrentFlowStateInvariantError("finalization downstream operation is invalid");
    }
    const state = this.#state(specId);
    const now = new Date().toISOString();
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      timing: { startedAt: now, finishedAt: now, durationMs: 0 },
      transition: {
        operation,
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
        finalizeSteps: stepIds,
      },
    }));
  }

  /** Record one exact explicit-dispatch receipt in the durable Activity ledger. */
  recordDispatchApproval({ specId, activityId, approval } = {}) {
    const state = this.#state(specId);
    if (approval === null || typeof approval !== "object" || Array.isArray(approval)) {
      throw new CurrentFlowStateInvariantError("dispatch approval requires a receipt object");
    }
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      timing: (() => {
        const now = new Date().toISOString();
        return { startedAt: now, finishedAt: now, durationMs: 0 };
      })(),
      transition: {
        operation: "record_dispatch_approval",
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        approval,
        nonblocking: null,
      },
    }));
  }

  /** Persist a non-state-changing observation in the authoritative ledger. */
  recordMetric({ specId, activityId, nodeId = null, metric, timing = null, admission = undefined } = {}) {
    return this.#recordObservation(specId, activityId, "record_metric", { nodeId, metric, timing, admission });
  }

  /** Persist a human note in the same ledger and recovery order as metrics. */
  recordNote({ specId, activityId, nodeId = null, note, timing = null } = {}) {
    return this.#recordObservation(specId, activityId, "record_note", { nodeId, note, timing });
  }

  /** Persist one immutable advisory evidence fact without creating flow.json state. */
  recordNonblocking({ specId, activityId, nodeId, nonblocking, timing = null, artifactWrites = undefined, artifactBaselines = undefined, admission = undefined } = {}) {
    const state = this.#state(specId);
    const target = requiredText(nodeId, "nonblocking nodeId");
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: target,
      timing: timing ?? (() => {
        const now = new Date().toISOString();
        return { startedAt: now, finishedAt: now, durationMs: 0 };
      })(),
      transition: {
        operation: "record_nonblocking",
        nodeId: target,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
        nonblocking,
      },
    }), { artifactWrites, artifactBaselines, admission });
  }

  continueNonblocking({ specId, activityId, nodeId, nonblocking, skippedNodeIds = [] } = {}) {
    const state = this.#state(specId);
    const target = requiredText(nodeId, "nonblocking continuation nodeId");
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: target,
      operation: "continue_nonblocking",
      result: {
        outcome: "passed",
        summary: "explicit nonblocking continuation",
        confirmedAt: new Date().toISOString(),
        artifactRefs: [],
      },
      references: { evaluations: [], findings: [], repairs: skippedNodeIds.map((id) => ({ id, label: "nonblocking route skip" })), artifacts: [] },
      nonblocking,
    });
  }

  acceptFinalRegressionFailure({ specId, activityId, attempt, result, artifactWrites = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId: "final-regression",
      operation: "accept_final_regression_failure",
      attempt: requiredAttempt(attempt, "final-regression acceptance"),
      result,
      artifactWrites,
    });
  }

  deferFailedReview(input = {}) {
    if (Object.hasOwn(input, "artifactWrites") || Object.hasOwn(input, "artifactBaselines")) {
      throw new CurrentFlowStateInvariantError("canonical Review deferral accepts only a deferred flow.findings publication");
    }
    const { specId, activityId, nodeId, attempt, result, findingsPublication } = input;
    if (!(findingsPublication instanceof DeferredFlowFindingsPublication)) {
      throw new CurrentFlowStateInvariantError("canonical Review deferral requires a deferred flow.findings publication");
    }
    const { artifactWrites, artifactBaselines } = findingsPublication.settlementArtifacts();
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId,
      operation: "defer_failed_review",
      attempt: requiredAttempt(attempt, "Review deferral settlement"),
      result,
      artifactWrites,
      artifactBaselines,
    });
  }

  deferFailedGate(input = {}) {
    if (Object.hasOwn(input, "artifactWrites") || Object.hasOwn(input, "artifactBaselines")) {
      throw new CurrentFlowStateInvariantError("canonical Gate settlement accepts only its deferred flow.findings publication");
    }
    const { specId, activityId, nodeId, attempt, result, findingsPublication, gateTaskLifecycle = null, admission = undefined } = input;
    if (!(findingsPublication instanceof DeferredFlowFindingsPublication)) {
      throw new CurrentFlowStateInvariantError("canonical Gate settlement requires a deferred flow.findings publication");
    }
    const { artifactWrites, artifactBaselines } = findingsPublication.settlementArtifacts();
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId, nodeId, operation: "defer_failed_gate",
      attempt: requiredAttempt(attempt, "Gate deferral settlement"), result, artifactWrites, artifactBaselines, gateTaskLifecycle, admission,
    });
  }

  /** Persist the Definition-selected closure of an accidentally opened Task round. */
  recoverTaskExecutionOverrun({ specId, activityId, nodeId, attempt, references, admission = undefined } = {}) {
    const state = this.#state(specId);
    return this.#applyAttemptTransition(specId, state, {
      id: activityId,
      nodeId,
      operation: "recover_task_execution_overrun",
      attempt: requiredAttempt(attempt, "Task execution overrun recovery"),
      references,
      admission,
    });
  }

  /** Read-only restart resolution; callers decide whether a resume Activity is needed. */
  restart(specId) {
    const state = this.#state(specId);
    return Object.freeze({
      state,
      lifecycle: state.lifecycle.state,
      nextAction: state.lifecycle.state === "active" ? state.nextAction() : null,
      resumable: state.lifecycle.state === "parked",
      finalized: state.lifecycle.state === "finalized",
    });
  }

  #applyLifecycle(specId, activityId, operation) {
    const state = this.#state(specId);
    // Lifecycle facts need an ordered durable timestamp.  In particular,
    // completed-Flow consumers must derive their date axis from the
    // flow_finalized Activity rather than from a mutable flow.json field or
    // filesystem metadata.
    const now = new Date().toISOString();
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      timing: { startedAt: now, finishedAt: now, durationMs: 0 },
      transition: {
        operation,
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
      },
    }));
  }

  #applyOutbox(specId, activityId, operation, outbox, timing = null) {
    const state = this.#state(specId);
    if (outbox === null || typeof outbox !== "object" || Array.isArray(outbox)) {
      throw new CurrentFlowStateInvariantError("outbox transition requires an outbox object");
    }
    const normalized = {
      id: requiredText(outbox.id, "outbox id"),
      operation: requiredText(outbox.operation, "outbox operation"),
      attempt: requiredPositiveInteger(outbox.attempt, "outbox attempt"),
      result: outbox.result ?? null,
      failure: outbox.failure ?? null,
      failureCode: outbox.failureCode ?? null,
      recovery: outbox.recovery ?? null,
      exactRecoveryReceipt: outbox.exactRecoveryReceipt ?? null,
    };
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: state.root.id,
      timing: timing ?? (() => {
        const now = new Date().toISOString();
        return { startedAt: now, finishedAt: now, durationMs: 0 };
      })(),
      transition: {
        operation,
        nodeId: state.root.id,
        task: null,
        attempt: null,
        status: null,
        outbox: normalized,
        nonblocking: null,
      },
    }));
  }

  #recordObservation(specId, activityId, operation, { nodeId = null, metric = null, note = null, timing = null, admission = undefined } = {}) {
    const state = this.#state(specId);
    const now = new Date().toISOString();
    const target = nodeId === null ? state.root.id : requiredText(nodeId, "observation nodeId");
    return this.apply(specId, this.#activity(state, {
      id: activityId,
      nodeId: target,
      timing: timing ?? { startedAt: now, finishedAt: now, durationMs: 0 },
      metric,
      note,
      transition: {
        operation,
        nodeId: target,
        task: null,
        attempt: null,
        status: null,
        nonblocking: null,
      },
    }), { admission });
  }

  #applyAttemptTransition(specId, state, {
    id,
    nodeId,
    operation,
    attempt,
    result = null,
    failure = null,
    status = null,
    timing,
    provider,
    model,
    effort,
    usage,
    references,
    specRecord = undefined,
    artifactWrites = undefined,
    artifactRemovals = undefined,
    artifactBaselines = undefined,
    testSourceBaseline = undefined,
    sourceWorkerUpgrade = undefined,
    nonblocking = null,
    admission = undefined,
    retryRecoveryPublication = undefined,
    gateTaskLifecycle = null,
    stepConnectionReceipt = null,
    taskReviewStagePlan = null,
  }) {
    const target = requiredText(nodeId, "transition nodeId");
    const node = state.findNode(target);
    if (node === null) throw new CurrentFlowStateInvariantError(`transition node is not part of this Flow: ${target}`);
    const transitionAttempt = ["start_attempt", "rewind", "rewind_test_evidence", "repair_test_review", "settle_test_review_repair_timeout", "repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "preimplementation_bootstrap", "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition", "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "recover_missing_producer_artifact", "recover_task_execution_overrun", "retry_attempt", "retry_gate_attempt", "retry_recovery_attempt", "update_attempt", TASK_GATE_CLASSIFICATION_RECOVERY_OPERATION, "accept_final_regression_failure", "defer_failed_review", "defer_failed_gate", "advance_task_review_stage"].includes(operation)
      ? attempt
      : null;
    const activityAttempt = operation === "complete_draft_completion"
      ? stepConnectionReceipt?.sourceAttempt ?? null
      : new Set(["repair_scenario_validity", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "repair_acceptance_review", "recover_missing_producer_artifact", "recover_task_execution_overrun", "defer_failed_review", "defer_failed_gate", "advance_task_review_stage"]).has(operation)
      ? state.attempt ?? attempt
      : ["start_attempt", "rewind", "rewind_test_evidence", "repair_test_review", "settle_test_review_repair_timeout", "preimplementation_bootstrap", "recover_existing_implementation", "reopen_draft_preimplementation", "recover_existing_implementation", "reopen_draft_preimplementation", "reopen_draft_task_addition", "reopen_draft_spec_correction", "plan_gate_repair", "recover_attempt", "retry_recovery_attempt", "accept_final_regression_failure"].includes(operation)
      ? attempt
      : state.attempt;
    if (activityAttempt === null) {
      throw new CurrentFlowStateInvariantError(`${operation} requires a current Attempt`);
    }
    const activity = this.#activity(state, {
      id,
      nodeId: target,
      result,
      failure,
      timing,
      provider,
      model,
      effort,
      usage,
      references,
      attemptId: activityAttempt.id,
      sequence: activityAttempt.sequence,
      transition: {
        operation,
        nodeId: target,
        task: null,
        attempt: transitionAttempt,
        status,
        nonblocking,
        gateTaskLifecycle,
        stepConnectionReceipt,
        taskReviewStagePlan,
      },
    });
    const resolvedArtifactWrites = retryRecoveryPublication == null
      ? artifactWrites
      : retryRecoveryPublication.artifactWrites;
    return this.apply(specId, activity, {
      specRecord,
      artifactWrites: resolvedArtifactWrites,
      artifactRemovals,
      artifactBaselines,
      testSourceBaseline,
      sourceWorkerUpgrade,
      admission,
      retryRecoveryPublication,
    });
  }

  #activity(state, {
    id,
    nodeId,
    attemptId = null,
    sequence = null,
    result = null,
    failure = null,
    timing = null,
    provider = null,
    model = null,
    effort = null,
    usage = null,
    metric = null,
    note = null,
    policy = null,
    outbox = null,
    approval = null,
    nonblocking = null,
    references = { evaluations: [], findings: [], repairs: [], artifacts: [] },
    transition,
  }) {
    const parsedTransition = transition instanceof ActivityTransition
      ? transition
      : new ActivityTransition({
        ...transition,
        policy: transition.policy ?? policy,
        outbox: transition.outbox ?? outbox,
        approval: transition.approval ?? approval,
        nonblocking: transition.nonblocking ?? nonblocking,
      });
    const node = state.findNode(nodeId);
    if (node === null) throw new CurrentFlowStateInvariantError(`Activity node is not part of this Flow: ${nodeId}`);
    return new FlowActivity({
      id: requiredText(id, "activityId"),
      nodeId,
      nodeKey: node.key,
      attemptId,
      sequence,
      confirmationOrder: state.confirmationOrder + 1,
      type: TYPE_FOR_OPERATION[parsedTransition.operation],
      transition: parsedTransition,
      result,
      timing,
      failure,
      provider,
      model,
      effort,
      usage,
      references,
      metric,
      note,
      reviewPublication: null,
    });
  }

  #state(specId) {
    const state = this.load(specId);
    if (!(state instanceof CurrentFlowState)) {
      throw new CurrentFlowStateInvariantError("canonical Flow Version state is missing");
    }
    return state;
  }

  #currentNodeId(state) {
    if (state.current === null) throw new CurrentFlowStateInvariantError("operation requires a current Flow node");
    return state.current.at(-1);
  }
}
