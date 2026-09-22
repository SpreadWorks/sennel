/**
 * src/flow/definition.js
 *
 * Single source of truth for the Spec-Driven Development flow structure.
 *
 * Every node carries the attributes that other modules previously derived
 * from context-rules.json, registry hooks, hardcoded constants, or prompt
 * literals. Adding / reordering steps is done here; consumers derive
 * behaviour from this data structure instead of maintaining parallel maps.
 *
 * Max depth: 3 (root list → branch → leaf). Traversal helpers enforce this.
 */

import { createHash } from "node:crypto";
import { isConditionalDraftWorkerStep } from "./lib/draft-conditional-worker.js";
import { SourceHandoffFailureFacts } from "./lib/source-handoff-failure.js";
import { NonblockingFailureClassification } from "./lib/nonblocking-evidence.js";
import {
  RequirementTestBudget,
  RequirementTestLifecycleAuthority,
  RequirementTestPlan,
  RequirementTestSemanticFinding,
  RequirementTestSourceAttempt,
} from "./lib/requirement-test-lifecycle.js";
import {
  RequirementTestCandidateBundle,
  RequirementTestGateObservation,
} from "./lib/requirement-test-artifacts.js";
import { TestReviewRepairFinding } from "./lib/test-review-repair.js";
import { SpecRevisionIdentity } from "./lib/spec-revision-identity.js";
import {
  REQUIREMENT_TEST_LEAF_IDS,
  RequirementTestInitializationDecision,
  RequirementTestLifecycleDecision,
} from "./lib/requirement-test-transition.js";
export {
  RequirementTestInitializationDecision,
  RequirementTestLifecycleDecision,
} from "./lib/requirement-test-transition.js";

import {
  ActivityFailure,
  CurrentFlowDefinition,
  DefinitionConditionalWorkerDisposition,
  DefinitionReviewDisposition,
  DefinitionFailurePolicy,
  FlowDefinitionNode as CurrentFlowDefinitionNode,
  NodeContract as CurrentFlowNodeContract,
} from "./lib/current-flow-state.js";
import { draftReviewRouteForKey, draftReviewRouteForRetryPhase, draftReviewRouteForStepId } from "./lib/draft-review-routes.js";
import {
  DraftCoverageRepairChangedResult,
  DraftCoverageRepairUnchangedResult,
  DraftCoverageReviewExecutionRequiredResult,
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  DraftCoverageTriageCompletedResult,
  DraftCreatedResult,
  DraftGateCarryForwardResult,
  DraftGatePassedResult,
  DraftGateRepairAppliedResult,
  DraftGateRepairCarryForwardResult,
  DraftGateRepairRequiredResult,
  DraftGateRepairWorkerRequiredResult,
  DraftQuestionsRepairChangedResult,
  DraftQuestionsRepairUnchangedResult,
  DraftQuestionsReviewExecutionRequiredResult,
  DraftQuestionsReviewFindingsResult,
  DraftQuestionsReviewPassedResult,
  DraftQuestionsTriageCompletedResult,
  DraftRefineAwaitingAnswerResult,
  DraftRefineCompletedResult,
  DraftRefineWorkerRequiredResult,
  SpecCreatedResult,
  StepErrorResult,
  StepResult,
  stepResultDigest,
} from "./engine/step-result.js";
import { DraftReviewConnector } from "./engine/connectors/draft/draft-review-connector.js";
import { DraftTriageConnector } from "./engine/connectors/draft/draft-triage-connector.js";
import { DraftRepairConnector } from "./engine/connectors/draft/draft-repair-connector.js";
import { DraftRefineConnector } from "./engine/connectors/draft/draft-refine-connector.js";
import { DraftSpecConnector } from "./engine/connectors/draft/draft-spec-connector.js";
import { SpecReviewConnector } from "./engine/connectors/spec/spec-review-connector.js";
import {
  flattenSteps,
  findFirstPendingLeaf,
  contiguousLeafRouteEffects,
} from "./lib/step-tree.js";
import { nonblockingRouteFor } from "./lib/nonblocking-route.js";
import { TaskStepIdentity } from "./lib/task-step-identity.js";
import { canonicalTaskContextKinds } from "./lib/task-context-kinds.js";
import { DefinitionFailureOwnership } from "./lib/definition-failure-ownership.js";
import {
  PlanGateRepairRoute,
  planGateRepairRouteForGateStep,
  planGateRepairResultLogicalKey,
} from "./lib/plan-gate-repair.js";
import { ReviewTransitionFacts } from "./lib/review-transition-facts.js";
import { DraftQuestionResumeReceipt } from "./lib/draft-question-resume-receipt.js";
import { DraftStepSettlementReceiptValue } from "./lib/draft-step-settlement-receipt.js";
export { DraftStepSettlementReceiptValue } from "./lib/draft-step-settlement-receipt.js";
import {
  DraftCompletionConnector,
} from "./lib/draft-completion-connector.js";
import {
  flowReviewRouteForPhase,
  reviewPhaseForFlowStepId,
} from "./lib/review-route.js";
import { sourceWorkerEffectSchemaRef } from "./lib/source-worker-effect-schema.js";
import {
  TaskExecutionBudget,
  TaskExecutionOverrunDecision,
  TaskExecutionOverrunFacts,
  TaskExecutionRoundPolicy,
  resolveTaskExecutionOverrun,
} from "./lib/task-execution-policy.js";
import {
  TaskNoChangeContinuationFacts,
  TaskNoChangeContinuationSelection,
  TaskReviewStageBinding,
  TaskReviewStageFacts,
  TaskReviewStageStepEffect,
  TaskReviewStageTransitionPlan,
  TaskReviewUnavailableEvidence,
  TaskReviewFailureFacts,
  TaskReviewFailurePlan,
  resolveTaskReviewFailure,
  createTaskReviewStageTransitionPlan,
  taskReviewStageEffects,
} from "./lib/task-review-stage-transition.js";

import {
  GateAttemptIdentity,
  GateCatalogPublication,
  GateFailureCategory,
  GateLineage,
  GateObservationConvergenceFacts,
  GatePostPublicationState,
  GateRecoveryEvidence,
  GateReviewFindingReadiness,
  GateRetryMetrics,
  SpecGateCycleProgress,
  GateProducerOwnership,
  GateTargetBinding,
  GateTaskLifecycle,
  TaskGateSettlementProgress,
  GateTransitionFacts,
} from "./lib/gate-transition.js";
import {
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateRepairPublication,
  NonGateRecoveryEvidence,
  NonGateRetryMetrics,
  NonGateSourcePublication,
  NonGateStepFacts,
  NonGateTargetBinding,
  NonGateTransitionFacts,
} from "./lib/non-gate-transition.js";
import {
  FinalRegressionArtifactDigest,
  FinalRegressionChangedFileSnapshot,
  FinalRegressionFailureProfileFact,
  FinalRegressionNonblockingPolicy,
  FinalRegressionProceedEvidence,
  FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID,
  FinalRegressionRetryHistory,
  FinalRegressionStepFacts,
} from "./lib/final-regression-transition.js";

export class RetryRecoveryBasis {
  constructor(value) {
    if (!["changed-input", "confirmed-timeout", "transient-provider"].includes(value)) {
      throw new Error("retry recovery basis is invalid");
    }
    this.value = value;
    Object.freeze(this);
  }

  static changedInput() { return new RetryRecoveryBasis("changed-input"); }
  static confirmedTimeout() { return new RetryRecoveryBasis("confirmed-timeout"); }
  static transientProvider() { return new RetryRecoveryBasis("transient-provider"); }
  static from(value) { return value instanceof RetryRecoveryBasis ? value : new RetryRecoveryBasis(value); }
  get changedInput() { return this.value === "changed-input"; }
  get confirmedTimeout() { return this.value === "confirmed-timeout"; }
  get transientProvider() { return this.value === "transient-provider"; }
  equals(other) { return other instanceof RetryRecoveryBasis && other.value === this.value; }
  toString() { return this.value; }
  toJSON() { return this.value; }
}

export class RetryRecoveryDecisionFacts {
  constructor({
    failure,
    disposition,
    routeKind,
    baselineAvailable,
    currentObservationAvailable,
    evidenceChanged,
    currentArtifactPresent,
    confirmedTimeoutConsumed,
    transientProviderConsumed,
    taskSourceAvailable,
  } = {}) {
    if (!(failure instanceof ActivityFailure)) throw new Error("retry recovery facts require a typed failure");
    if (disposition === null || typeof disposition !== "object" || typeof disposition.operation !== "string") {
      throw new Error("retry recovery facts require a Definition disposition");
    }
    if (!["review", "gate"].includes(routeKind)) throw new Error("retry recovery facts route kind is invalid");
    for (const [field, value] of Object.entries({
      baselineAvailable,
      currentObservationAvailable,
      evidenceChanged,
      currentArtifactPresent,
      confirmedTimeoutConsumed,
      transientProviderConsumed,
      taskSourceAvailable,
    })) {
      if (typeof value !== "boolean") throw new Error(`retry recovery facts ${field} must be boolean`);
    }
    this.failure = failure;
    this.disposition = disposition;
    this.routeKind = routeKind;
    this.baselineAvailable = baselineAvailable;
    this.currentObservationAvailable = currentObservationAvailable;
    this.evidenceChanged = evidenceChanged;
    this.currentArtifactPresent = currentArtifactPresent;
    this.confirmedTimeoutConsumed = confirmedTimeoutConsumed;
    this.transientProviderConsumed = transientProviderConsumed;
    this.taskSourceAvailable = taskSourceAvailable;
    Object.freeze(this);
  }
}

/** A stable Definition-owned explanation for an unavailable exhausted retry recovery. */
export class RetryRecoveryBlocker {
  constructor({ code, resumeInstruction } = {}) {
    if (![
      "RETRY_RECOVERY_BASELINE_UNAVAILABLE",
      "RETRY_RECOVERY_CURRENT_OBSERVATION_UNAVAILABLE",
      "RETRY_RECOVERY_CURRENT_ARTIFACT_PRESENT",
      "RETRY_RECOVERY_TRANSIENT_PROVIDER_CONSUMED",
      "RETRY_RECOVERY_CONFIRMED_TIMEOUT_CONSUMED",
      "RETRY_RECOVERY_TASK_SOURCE_UNAVAILABLE",
      "RETRY_RECOVERY_PROVIDER_QUIESCENCE_UNCONFIRMED",
      "RETRY_RECOVERY_NON_RECOVERABLE_FAILURE",
      "RETRY_RECOVERY_UNCHANGED_EVIDENCE_UNSUPPORTED",
      "RETRY_RECOVERY_STATE_CHANGED",
      "RETRY_RECOVERY_NOT_ACTIVE",
    ].includes(code)) {
      throw new Error("retry recovery blocker code is invalid");
    }
    if (typeof resumeInstruction !== "string" || resumeInstruction.trim() === "") {
      throw new Error("retry recovery blocker resume instruction is required");
    }
    this.code = code;
    this.resumeInstruction = resumeInstruction.trim();
    Object.freeze(this);
  }

  static baselineUnavailable() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_BASELINE_UNAVAILABLE",
      resumeInstruction: "Restore the durable retry baseline through the canonical producer path, then refresh next-action. Do not manufacture a baseline or reset retry counters.",
    });
  }

  static currentObservationUnavailable() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_CURRENT_OBSERVATION_UNAVAILABLE",
      resumeInstruction: "Restore the current canonical Review observation, then refresh next-action. Do not retry from an unobserved input.",
    });
  }

  static currentArtifactPresent() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_CURRENT_ARTIFACT_PRESENT",
      resumeInstruction: "Settle the exact current Attempt through its normal artifact transition, then refresh next-action. Do not use exhausted retry recovery after publication.",
    });
  }

  static transientProviderConsumed() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_TRANSIENT_PROVIDER_CONSUMED",
      resumeInstruction: "Resolve the provider issue or change durable canonical input before a new recovery lineage can be considered. Do not reuse the consumed transient-provider recovery.",
    });
  }

  static confirmedTimeoutConsumed() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_CONFIRMED_TIMEOUT_CONSUMED",
      resumeInstruction: "Record changed canonical evidence before another recovery can be considered. Do not reuse the consumed confirmed-timeout recovery.",
    });
  }

  static taskSourceUnavailable() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_TASK_SOURCE_UNAVAILABLE",
      resumeInstruction: "Restore and verify the Task Review source observation through its canonical checkpoint, then refresh next-action. Do not reset retry counters or edit recovery evidence.",
    });
  }

  static providerQuiescenceUnconfirmed() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_PROVIDER_QUIESCENCE_UNCONFIRMED",
      resumeInstruction: "Obtain trusted normal completion evidence with confirmed provider process-tree quiescence before considering unchanged-input recovery.",
    });
  }

  static nonRecoverableFailure() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_NON_RECOVERABLE_FAILURE",
      resumeInstruction: "Repair the terminal failure or change canonical evidence, then follow the Definition-selected lifecycle transition. Do not apply exhausted retry recovery to this failure.",
    });
  }

  static unchangedEvidenceUnsupported() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_UNCHANGED_EVIDENCE_UNSUPPORTED",
      resumeInstruction: "Provide changed canonical evidence or the required trusted provider-stop evidence, then refresh next-action. Do not retry unchanged unsupported input.",
    });
  }

  static stateChanged() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_STATE_CHANGED",
      resumeInstruction: "Refresh next-action from the latest canonical state before selecting a recovery.",
    });
  }

  static notActive() {
    return new RetryRecoveryBlocker({
      code: "RETRY_RECOVERY_NOT_ACTIVE",
      resumeInstruction: "Refresh next-action and follow the active canonical Attempt. No exhausted retry recovery is active for this state.",
    });
  }
}

export class RetryRecoveryPlan {
  constructor({ basis = null, reason, inputInvalid = false, blocker = null } = {}) {
    this.basis = basis === null ? null : RetryRecoveryBasis.from(basis);
    if (typeof reason !== "string" || reason.trim() === "") throw new Error("retry recovery plan reason is required");
    if (typeof inputInvalid !== "boolean") throw new Error("retry recovery plan inputInvalid must be boolean");
    if (blocker !== null && !(blocker instanceof RetryRecoveryBlocker)) {
      throw new Error("retry recovery plan blocker must be typed");
    }
    if (this.basis !== null && (inputInvalid || blocker !== null)) {
      throw new Error("available retry recovery plan cannot reject its input");
    }
    if (this.basis === null && blocker === null) {
      throw new Error("unavailable retry recovery plan requires a typed blocker");
    }
    this.reason = reason.trim();
    this.inputInvalid = inputInvalid;
    this.blocker = blocker;
    Object.freeze(this);
  }

  static blocked(reason, blocker = RetryRecoveryBlocker.nonRecoverableFailure()) {
    return new RetryRecoveryPlan({ reason, blocker });
  }
  static invalidInput(reason, blocker = RetryRecoveryBlocker.unchangedEvidenceUnsupported()) {
    return new RetryRecoveryPlan({ reason, inputInvalid: true, blocker });
  }
  static available(basis, reason) { return new RetryRecoveryPlan({ basis, reason }); }
  get available() { return this.basis !== null; }
}

/** The Definition's sole selection of exhausted retry recovery. */
export function resolveRetryRecovery(facts) {
  if (!(facts instanceof RetryRecoveryDecisionFacts)) {
    throw new Error("retry recovery resolver requires typed facts");
  }
  if (!facts.baselineAvailable) {
    return RetryRecoveryPlan.blocked("durable retry baseline is unavailable", RetryRecoveryBlocker.baselineUnavailable());
  }
  if (facts.failure.category === "semantic") {
    return RetryRecoveryPlan.blocked(
      "exhausted retry recovery is limited to tooling failures with changed evidence",
      RetryRecoveryBlocker.nonRecoverableFailure(),
    );
  }
  const recordableToolingFailure = facts.disposition.operation === "record"
    && facts.disposition.remaining === 0
    && ["tooling", "provider"].includes(facts.failure.category);
  if (!facts.currentObservationAvailable) {
    return RetryRecoveryPlan.blocked(
      "current retry recovery observation is unavailable",
      RetryRecoveryBlocker.currentObservationUnavailable(),
    );
  }
  if (facts.transientProviderConsumed) {
    return RetryRecoveryPlan.blocked(
      "transient provider recovery already consumed this evidence lineage",
      RetryRecoveryBlocker.transientProviderConsumed(),
    );
  }
  if (facts.confirmedTimeoutConsumed) {
    return RetryRecoveryPlan.blocked(
      "confirmed timeout recovery already consumed this evidence lineage",
      RetryRecoveryBlocker.confirmedTimeoutConsumed(),
    );
  }
  if (!facts.taskSourceAvailable) {
    return RetryRecoveryPlan.blocked(
      "Task Review source observation is unavailable",
      RetryRecoveryBlocker.taskSourceUnavailable(),
    );
  }
  if (facts.evidenceChanged && recordableToolingFailure) {
    return RetryRecoveryPlan.available(
      RetryRecoveryBasis.changedInput(),
      "Parent-derived canonical evidence changed.",
    );
  }
  // Unchanged-input provider recovery is only for a provider that stopped
  // before it published its current canonical result. Changed-input recovery
  // retains its existing semantics and may explicitly reevaluate new evidence.
  if (facts.currentArtifactPresent) {
    return RetryRecoveryPlan.blocked(
      "current Attempt canonical Review artifact is already present",
      RetryRecoveryBlocker.currentArtifactPresent(),
    );
  }
  if (!facts.evidenceChanged
    && facts.failure.code !== "AGENT_TIMEOUT"
    && facts.failure.retryable !== true) {
    return RetryRecoveryPlan.blocked(
      "the current terminal failure does not authorize unchanged exhausted tooling recovery",
      RetryRecoveryBlocker.nonRecoverableFailure(),
    );
  }
  if (!facts.evidenceChanged
    && facts.routeKind === "review"
    && facts.failure.code === "AGENT_TIMEOUT"
    && facts.failure.agentStopEvidence?.confirmed !== true) {
    return RetryRecoveryPlan.invalidInput(
      "changed evidence must differ unless unchanged Review input has a trusted confirmed timeout with an observed provider stop",
      RetryRecoveryBlocker.unchangedEvidenceUnsupported(),
    );
  }
  if (!recordableToolingFailure) {
    return RetryRecoveryPlan.blocked(
      "the Definition disposition does not authorize exhausted tooling recovery; trusted confirmed timeout evidence is required for unchanged Review input",
      RetryRecoveryBlocker.nonRecoverableFailure(),
    );
  }
  const transientProvider = facts.routeKind === "review"
    && facts.failure.retryableProviderCompletionBoundary
    && facts.failure.agentProviderCompletionEvidence?.confirmedQuiescence === true;
  if (transientProvider) {
    return RetryRecoveryPlan.available(
      RetryRecoveryBasis.transientProvider(),
      "A transient provider failure completed without publishing a Review artifact.",
    );
  }
  if (facts.routeKind === "review" && facts.failure.retryableProviderCompletionBoundary) {
    return RetryRecoveryPlan.invalidInput(
      "unchanged transient provider recovery requires trusted normal completion evidence with confirmed process-tree quiescence",
      RetryRecoveryBlocker.providerQuiescenceUnconfirmed(),
    );
  }
  const confirmedTimeout = facts.routeKind === "review"
    && facts.failure.code === "AGENT_TIMEOUT"
    && facts.failure.retryable === true
    && facts.failure.retryKind === "tooling"
    && facts.failure.agentStopEvidence?.confirmed === true;
  if (!confirmedTimeout) {
    return RetryRecoveryPlan.invalidInput(
      "changed evidence must differ unless unchanged Review input has a trusted confirmed timeout with an observed provider stop",
      RetryRecoveryBlocker.unchangedEvidenceUnsupported(),
    );
  }
  return RetryRecoveryPlan.available(
    RetryRecoveryBasis.confirmedTimeout(),
    "Confirmed provider timeout stopped before publishing a Review artifact.",
  );
}

// Facts are read by a focused boundary, but every Gate policy value and the
// only resolver live in this definition module. Commands, registry hooks,
// persistence, and next-action must consume this API instead of selecting a
// route themselves.
export {
  GateAttemptIdentity,
  GateCatalogPublication,
  GateFailureCategory,
  GateLineage,
  GateObservationConvergenceFacts,
  GatePostPublicationState,
  GateRecoveryEvidence,
  GateReviewFindingReadiness,
  GateRetryMetrics,
  SpecGateCycleProgress,
  GateProducerOwnership,
  GateTargetBinding,
  GateTaskLifecycle,
  TaskGateSettlementProgress,
  GateTransitionFacts,
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateRepairPublication,
  NonGateRecoveryEvidence,
  NonGateRetryMetrics,
  NonGateSourcePublication,
  NonGateStepFacts,
  NonGateTargetBinding,
  NonGateTransitionFacts,
  FinalRegressionArtifactDigest,
  FinalRegressionChangedFileSnapshot,
  FinalRegressionFailureProfileFact,
  FinalRegressionNonblockingPolicy,
  FinalRegressionProceedEvidence,
  FinalRegressionRetryHistory,
  FinalRegressionStepFacts,
  TaskExecutionBudget,
  TaskExecutionOverrunDecision,
  TaskExecutionOverrunFacts,
  TaskExecutionRoundPolicy,
  TaskNoChangeContinuationFacts,
  TaskNoChangeContinuationSelection,
  TaskReviewStageBinding,
  TaskReviewStageFacts,
  TaskReviewStageStepEffect,
  TaskReviewStageTransitionPlan,
  TaskReviewUnavailableEvidence,
  TaskReviewFailureFacts,
  TaskReviewFailurePlan,
};
export { selectTaskNoChangeContinuation, resolveTaskReviewFailure } from "./lib/task-review-stage-transition.js";
export { resolveTaskExecutionOverrun } from "./lib/task-execution-policy.js";

const REQUIREMENT_TEST_LEAVES = new Set(REQUIREMENT_TEST_LEAF_IDS);
const REQUIREMENT_TEST_STEP_OBSERVATIONS = new Set([
  "review_pass", "review_advisory", "semantic_rejection", "tooling_failure", "external_blocked",
]);
export const REQUIREMENT_TEST_SEMANTIC_LIMIT = 5;
export const REQUIREMENT_TEST_TOOLING_LIMIT = 3;

function requirementTestPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

/** Normalized non-Gate observation bound to one Requirement bundle revision. */
export class RequirementTestStepObservation {
  constructor({ requirementId, specRevision, bundleRevision = null, candidateDigest = null, sourceAttempt = null, semanticFindingFingerprint = null, kind } = {}) {
    if (typeof requirementId !== "string" || requirementId.trim() === "") {
      throw new Error("Requirement test observation requirementId is required");
    }
    this.requirementId = requirementId.trim();
    this.specRevision = specRevision;
    if (!this.specRevision || typeof this.specRevision.equals !== "function") {
      throw new Error("Requirement test observation Spec revision must be typed");
    }
    this.bundleRevision = bundleRevision === null
      ? null
      : requirementTestPositiveInteger(bundleRevision, "Requirement test observation bundle revision");
    if ((candidateDigest === null) !== (sourceAttempt === null)) {
      throw new Error("Requirement test observation candidate identity must be wholly present or absent");
    }
    if (candidateDigest !== null && !/^[a-f0-9]{64}$/.test(candidateDigest)) {
      throw new Error("Requirement test observation candidate digest is invalid");
    }
    if (sourceAttempt !== null && (typeof sourceAttempt.id !== "string" || sourceAttempt.id === ""
      || !Number.isSafeInteger(sourceAttempt.sequence) || sourceAttempt.sequence < 1)) {
      throw new Error("Requirement test observation source Attempt is invalid");
    }
    this.candidateDigest = candidateDigest;
    this.sourceAttempt = sourceAttempt === null ? null : Object.freeze({ id: sourceAttempt.id, sequence: sourceAttempt.sequence });
    if (!REQUIREMENT_TEST_STEP_OBSERVATIONS.has(kind)) {
      throw new Error("Requirement test step observation kind is invalid");
    }
    this.kind = kind;
    if (semanticFindingFingerprint !== null
      && (typeof semanticFindingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(semanticFindingFingerprint))) {
      throw new Error("Requirement test semantic observation fingerprint is invalid");
    }
    if ((kind === "semantic_rejection") !== (semanticFindingFingerprint !== null)) {
      throw new Error("Requirement test semantic rejection must bind one canonical finding fingerprint");
    }
    this.semanticFindingFingerprint = semanticFindingFingerprint;
    Object.freeze(this);
  }
}

/**
 * Parent-only structural rejection of a sealed Requirement candidate.
 * It is semantic evidence: the candidate remains immutable and repairable,
 * while Definition alone decides the bounded repair/defer route.
 */
export class RequirementTestStructuralRejectionObservation {
  constructor({ stepId, binding, candidate, finding } = {}) {
    if (!new Set(["test-generate", "test-repair"]).has(stepId)) {
      throw new Error("Requirement test structural rejection leaf is invalid");
    }
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("Requirement test structural rejection binding is required");
    }
    this.stepId = stepId;
    this.requirementId = String(binding.requirementId || "").trim();
    if (this.requirementId === "") throw new Error("Requirement test structural rejection Requirement is required");
    this.specRevision = binding.specRevision instanceof SpecRevisionIdentity
      ? binding.specRevision
      : new SpecRevisionIdentity(binding.specRevision);
    this.bundleRevision = requirementTestPositiveInteger(binding.bundleRevision, "Requirement test structural rejection bundle revision");
    this.sourceAttempt = binding.sourceAttempt instanceof RequirementTestSourceAttempt
      ? binding.sourceAttempt
      : RequirementTestSourceAttempt.fromJSON(binding.sourceAttempt);
    if (!(candidate instanceof RequirementTestCandidateBundle)
      || candidate.bundle.requirementId !== this.requirementId
      || !candidate.bundle.specRevision.equals(this.specRevision)
      || candidate.bundle.revision !== this.bundleRevision
      || candidate.bundle.lineage.sourceAttempt.id !== this.sourceAttempt.id
      || candidate.bundle.lineage.sourceAttempt.sequence !== this.sourceAttempt.sequence) {
      throw new Error("Requirement test structural rejection candidate does not match its binding");
    }
    const typedFinding = finding instanceof TestReviewRepairFinding ? finding : new TestReviewRepairFinding(finding);
    const document = typedFinding.document;
    if (document.requirementId !== this.requirementId
      || document.bundleRevision !== this.bundleRevision
      || document.candidateDigest !== candidate.digest
      || document.sourceAttempt?.id !== this.sourceAttempt.id
      || document.sourceAttempt?.sequence !== this.sourceAttempt.sequence
      || JSON.stringify(document.specRevision) !== JSON.stringify(this.specRevision.toJSON())) {
      throw new Error("Requirement test structural rejection finding does not bind its candidate");
    }
    this.candidate = candidate;
    this.finding = typedFinding;
    this.semanticFindingFingerprint = typedFinding.fingerprint;
    Object.freeze(this);
  }
}

/** Latest canonical plan and the exact observed leaf result consumed by Definition. */
export class RequirementTestLifecycleFacts {
  constructor({ authority, plan, leaf, observation, candidateBundle = null } = {}) {
    if (!(authority instanceof RequirementTestLifecycleAuthority)) {
      throw new Error("Requirement test lifecycle requires typed Store authority");
    }
    if (!(plan instanceof RequirementTestPlan)) throw new Error("Requirement test lifecycle requires a typed plan");
    if (!REQUIREMENT_TEST_LEAVES.has(leaf)) throw new Error("Requirement test lifecycle leaf is invalid");
    if (authority.leaf !== leaf) throw new Error("Requirement test lifecycle authority does not match its leaf");
    const workItem = plan.activeWorkItem();
    if (!workItem) throw new Error("Requirement test lifecycle requires one active work item");
    const isGate = observation instanceof RequirementTestGateObservation;
    const isCandidate = observation instanceof RequirementTestCandidateBundle;
    const isStep = observation instanceof RequirementTestStepObservation;
    const isStructural = observation instanceof RequirementTestStructuralRejectionObservation;
    if (leaf === "test-gate" ? !isGate : (leaf === "test-generate" || leaf === "test-repair") ? !isCandidate && !isStep && !isStructural : !isStep) {
      throw new Error("Requirement test lifecycle observation type does not match its leaf");
    }
    const observationRequirementId = isCandidate ? observation.bundle.requirementId : observation.requirementId;
    const observationSpecRevision = isCandidate ? observation.bundle.specRevision : observation.specRevision;
    if (observationRequirementId !== workItem.requirementId
      || !workItem.specRevision.equals(observationSpecRevision)) {
      throw new Error("Requirement test lifecycle observation has stale Requirement or Spec identity");
    }
    const observationKind = isCandidate ? "candidate_saved" : isStructural ? "structural_rejection" : observation.kind;
    let boundCandidate = candidateBundle;
    if (isCandidate || isStructural) {
      const observedCandidate = isStructural ? observation.candidate : observation;
      boundCandidate = observedCandidate;
      const producerAttempt = observedCandidate.bundle.lineage.sourceAttempt;
      if (producerAttempt.id !== authority.attempt.id
        || producerAttempt.sequence !== authority.attempt.sequence) {
        throw new Error("Requirement test candidate lineage does not match its active producer Attempt");
      }
      if (leaf === "test-generate") {
        if (workItem.status !== "in_progress" || observedCandidate.bundle.revision !== 1) {
          throw new Error("Requirement test generation candidate requires in-progress revision 1 facts");
        }
      } else if (workItem.status !== "reviewed"
        || observedCandidate.bundle.revision !== workItem.bundleRevision.revision + 1
        || observedCandidate.bundle.lineage.predecessorRevision !== workItem.bundleRevision.revision) {
        throw new Error("Requirement test repair candidate must immediately succeed the reviewed bundle");
      }
    } else {
      const expectedBundleRevision = workItem.bundleRevision?.revision ?? null;
      if (observation.bundleRevision !== expectedBundleRevision) {
        throw new Error("Requirement test lifecycle observation has a stale bundle revision");
      }
    }
    const permitted = new Map([
      ["test-generate", new Map([["candidate_saved", "in_progress"], ["structural_rejection", "in_progress"], ["tooling_failure", "in_progress"], ["external_blocked", "in_progress"]])],
      ["test-review", new Map([
        ["review_pass", "candidate_saved"], ["review_advisory", "candidate_saved"],
        ["semantic_rejection", "candidate_saved"], ["tooling_failure", "candidate_saved"], ["external_blocked", "candidate_saved"],
      ])],
      ["test-repair", new Map([
        ["candidate_saved", "reviewed"], ["structural_rejection", "reviewed"], ["tooling_failure", "reviewed"], ["external_blocked", "reviewed"],
      ])],
      ["test-gate", new Map([
        ["assertion_failed", "reviewed"], ["assertion_passed", "reviewed"], ["invalid_test", "reviewed"],
        ["skipped", "reviewed"], ["missing", "reviewed"], ["tooling_failure", "reviewed"],
      ])],
    ]);
    if (permitted.get(leaf).get(observationKind) !== workItem.status) {
      throw new Error("Requirement test lifecycle leaf, observation, and status do not match");
    }
    if (leaf !== "test-generate" && !isCandidate) {
      if (!(boundCandidate instanceof RequirementTestCandidateBundle)
        || JSON.stringify(boundCandidate.bundle.toJSON()) !== JSON.stringify(workItem.bundleRevision.toJSON())) {
        throw new Error("Requirement test lifecycle candidate bundle is not current");
      }
    }
    if ((leaf === "test-review" || leaf === "test-repair") && !isCandidate && !isStructural && (
      observation.candidateDigest !== boundCandidate.digest
      || observation.sourceAttempt?.id !== workItem.bundleRevision.lineage.sourceAttempt.id
      || observation.sourceAttempt?.sequence !== workItem.bundleRevision.lineage.sourceAttempt.sequence
    )) {
      throw new Error("Requirement test lifecycle observation is not bound to current candidate lineage");
    }
    if (isGate) {
      const lineageAttempt = workItem.bundleRevision.lineage.sourceAttempt;
      if (observation.candidateDigest !== boundCandidate.digest
        || observation.sourceAttempt.id !== lineageAttempt.id
        || observation.sourceAttempt.sequence !== lineageAttempt.sequence) {
        throw new Error("Requirement test Gate observation is not bound to current candidate lineage");
      }
    }
    this.authority = authority;
    this.plan = plan;
    this.leaf = leaf;
    this.workItem = workItem;
    this.observation = observation;
    this.observationKind = observationKind;
    this.candidateBundle = boundCandidate;
    Object.freeze(this);
  }
}

export function initializeRequirementTestLifecycle({ spec, specRevision } = {}) {
  let plan = RequirementTestPlan.fromApprovedSpec({ spec, specRevision });
  const first = plan.nextPendingWorkItem();
  if (first === null) {
    return new RequirementTestInitializationDecision({
      plan,
      target: "implement",
      skippedLeafIds: [...REQUIREMENT_TEST_LEAVES],
    });
  }
  plan = plan.withWorkItem(first.withState({ status: "in_progress" }));
  return new RequirementTestInitializationDecision({ plan, target: "test-generate" });
}

function requirementTestDecision(facts, input) {
  return new RequirementTestLifecycleDecision({ requirementId: facts.workItem.requirementId, ...input, facts });
}

function requirementTestTerminalDecision(facts, disposition, candidateBundle = null) {
  const nextStatus = disposition === "promote" ? "promoted" : "deferred";
  const afterSettlement = facts.plan.withWorkItem(facts.workItem.withState({ status: nextStatus }));
  // Generate may have staged later Requirements in the same Attempt.  Those
  // candidates are the next review frontier; only when none remain may a
  // still-pending Requirement claim a fresh generator Attempt.
  const staged = afterSettlement.activeWorkItem();
  const pending = afterSettlement.nextPendingWorkItem();
  return requirementTestDecision(facts, {
    disposition,
    target: staged ? "test-review" : pending ? "test-generate" : "implement",
    nextStatus,
    nextRequirementId: staged ? null : pending?.requirementId ?? null,
    acceptanceHandoff: disposition === "defer",
    candidateBundle,
  });
}

function requirementTestSemanticRetry(facts) {
  const budget = facts.workItem.budget;
  if (!(budget instanceof RequirementTestBudget)) throw new Error("Requirement test lifecycle budget must be typed");
  // A structural rejection can be the first generated candidate, before the
  // plan has recorded a bundle revision.  Its sealed candidate is the only
  // authority for the semantic finding's revision in that case.
  const bundleRevision = facts.candidateBundle?.bundle.revision
    ?? facts.workItem.bundleRevision?.revision;
  if (!Number.isSafeInteger(bundleRevision) || bundleRevision < 1) {
    throw new Error("Requirement test semantic retry requires a candidate bundle revision");
  }
  const finding = new RequirementTestSemanticFinding({
    requirementId: facts.workItem.requirementId,
    bundleRevision,
    fingerprint: facts.observation.semanticFindingFingerprint,
  });
  const duplicate = facts.workItem.hasSemanticFinding(finding);
  const candidateBundle = facts.observationKind === "structural_rejection" ? facts.candidateBundle : null;
  const budgetIncrement = facts.authority.autoApprove ? "autoSemantic" : "manualSemantic";
  const selectedAttempts = budget[budgetIncrement];
  if (duplicate || selectedAttempts < REQUIREMENT_TEST_SEMANTIC_LIMIT) {
    return requirementTestDecision(facts, {
      disposition: "semantic_retry", target: "test-repair", nextStatus: "reviewed",
      budgetIncrement: duplicate ? null : budgetIncrement, semanticFinding: duplicate ? null : finding,
      repairRequired: true, candidateBundle,
    });
  }
  return requirementTestTerminalDecision(facts, "defer", candidateBundle);
}

/** Sole Requirement-test route, compatibility, and retry-budget policy. */
export function resolveRequirementTestLifecycle(input) {
  const facts = input instanceof RequirementTestLifecycleFacts
    ? input
    : new RequirementTestLifecycleFacts(input);
  const observation = facts.observationKind;
  if (observation === "external_blocked") {
    return requirementTestDecision(facts, {
      disposition: "external_blocked",
      target: facts.leaf,
      nextStatus: facts.workItem.status,
      repairRequired: facts.leaf === "test-repair" ? true : null,
    });
  }
  if (observation === "candidate_saved") {
    const next = facts.leaf === "test-generate" ? facts.plan.nextPendingWorkItem() : null;
    if (next !== null) {
      return requirementTestDecision(facts, {
        disposition: "advance", target: "test-generate", nextStatus: "candidate_saved",
        nextRequirementId: next.requirementId, candidateBundle: facts.candidateBundle,
      });
    }
    return requirementTestDecision(facts, {
      disposition: "advance", target: "test-review", nextStatus: "candidate_saved",
      candidateBundle: facts.candidateBundle,
    });
  }
  if (observation === "review_pass" || observation === "review_advisory") {
    return requirementTestDecision(facts, {
      disposition: "advance", target: "test-gate", nextStatus: "reviewed", repairRequired: false,
    });
  }
  if (observation === "tooling_failure") {
    if (facts.workItem.budget.tooling < REQUIREMENT_TEST_TOOLING_LIMIT) {
      return requirementTestDecision(facts, {
        disposition: "tooling_retry", target: facts.leaf, nextStatus: facts.workItem.status,
        budgetIncrement: "tooling", repairRequired: facts.leaf === "test-repair" ? true : null,
      });
    }
    return requirementTestTerminalDecision(facts, "defer");
  }
  if (observation === "structural_rejection") return requirementTestSemanticRetry(facts);
  if (facts.leaf === "test-gate") {
    const expected = facts.workItem.expectation.value === "fail" ? "assertion_failed" : "assertion_passed";
    if (observation === expected) return requirementTestTerminalDecision(facts, "promote");
    // Gate records executable evidence only. Review owns canonical semantic
    // classification, so an incompatible observation reopens this exact
    // staged candidate rather than consuming a repair budget directly.
    return requirementTestDecision(facts, {
      disposition: "advance", target: "test-review", nextStatus: "candidate_saved",
    });
  }
  return requirementTestSemanticRetry(facts);
}

/** Definition-owned response to verified source handoff failure facts. */
export class SourceHandoffTransitionPlan {
  constructor({ facts, disposition }) {
    if (!(facts instanceof SourceHandoffFailureFacts)) throw new Error("source handoff plan requires typed failure facts");
    if (!["wait", "block", "rollback", "preserve", "quarantine", "converge-no-change"].includes(disposition)) {
      throw new Error("invalid source handoff disposition");
    }
    if (disposition === "rollback" && (facts.kind !== "rejected" || !facts.ownershipProven || !facts.workerStopped)) {
      throw new Error("source rollback requires proven ownership and a stopped worker");
    }
    if ((disposition === "preserve" && (facts.kind !== "rejected" || !facts.workerStopped))
      || (disposition === "wait" && facts.kind !== "temporary-unavailable")
      || (disposition === "quarantine" && facts.kind !== "authority-violation")) {
      throw new Error("source handoff disposition contradicts its failure facts");
    }
    if (disposition === "converge-no-change" && (
      facts.kind !== "rejected" || facts.identity?.stepId !== "task-repair"
      || !facts.ownershipProven || !facts.workerStopped
      || !((facts.code === "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID" && !facts.retryable)
        || (facts.providerFailed && !facts.toolingRecoveryAvailable))
    )) throw new Error("source handoff no-change convergence contradicts its failure facts");
    this.facts = facts;
    this.disposition = disposition;
    this.retryAfterSettlement = disposition === "rollback" && facts.retryable;
    this.failure = disposition === "quarantine" ? new ActivityFailure({
      category: "source-integrity", code: facts.code, message: facts.message,
      retryable: false, retryKind: null,
    }) : null;
    Object.freeze(this);
  }

  toJSON() {
    return {
      disposition: this.disposition, retryAfterSettlement: this.retryAfterSettlement,
      failure: this.failure?.toJSON() ?? null, facts: this.facts.toJSON(),
    };
  }
}

export function resolveSourceHandoffTransitionPlan({ facts, policy }) {
  if (!(facts instanceof SourceHandoffFailureFacts)) throw new Error("source handoff resolution requires typed facts");
  if (policy?.kind !== "source" || typeof policy.preservesRejectedSource !== "boolean") {
    throw new Error("source handoff resolution requires its source policy");
  }
  let disposition = "block";
  if (facts.kind === "temporary-unavailable") disposition = "wait";
  else if (facts.kind === "authority-violation") disposition = "quarantine";
  else if (facts.kind === "rejected") {
    if (policy.stepId === "task-repair" && facts.identity?.stepId === "task-repair"
      && facts.ownershipProven && facts.workerStopped
      && ((facts.code === "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID" && !facts.retryable)
        || (facts.providerFailed && !facts.toolingRecoveryAvailable))) disposition = "converge-no-change";
    else if (policy.preservesRejectedSource && facts.workerStopped) disposition = "preserve";
    else if (facts.ownershipProven && facts.workerStopped) disposition = "rollback";
  }
  return new SourceHandoffTransitionPlan({ facts, disposition });
}

/** Resolve the Task-local review funnel from canonical, binding-checked facts. */
export function resolveTaskReviewStageTransition(facts) {
  if (!(facts instanceof TaskReviewStageFacts)) {
    throw new Error("resolveTaskReviewStageTransition requires TaskReviewStageFacts");
  }
  const taskId = facts.binding.taskId;
  const reviewBudgetConsumed = facts.binding.stage === "review" && facts.verdict !== "UNAVAILABLE" ? 1 : 0;
  const plan = (operation, entries, targetRole = null, options = {}) => createTaskReviewStageTransitionPlan(facts, {
    operation,
    effects: taskReviewStageEffects(taskId, entries),
    targetStepId: targetRole === null ? null : `${taskId}-${targetRole}`,
    reviewBudgetConsumed,
    ...options,
  });
  if (facts.binding.stage === "review") {
    if (facts.verdict === "UNAVAILABLE") {
      return plan("review-unavailable-to-gate", [
        ["review", "done"],
        ["triage", "skipped", facts.reason],
        ["repair", "skipped", facts.reason],
      ], "gate", { acceptanceUnreviewed: true });
    }
    if (facts.findingCount > 0) {
      return plan("review-to-triage", [["review", "done"]], "triage");
    }
    if (facts.sourceNoChange) {
      if (!facts.noChangeContinuation?.eligible) {
        throw new Error("Task no-change completion requires canonical continuation evidence");
      }
      const reason = facts.noChangeContinuation.reason;
      return plan("review-no-change-complete", [
        ["review", "done"], ["triage", "skipped", reason], ["repair", "skipped", reason], ["gate", "skipped", reason],
      ]);
    }
    return plan("review-to-gate", [
      ["review", "done"],
      ["triage", "skipped", "Task Review has no findings."],
      ["repair", "skipped", "Task Review has no findings."],
    ], "gate");
  }
  if (facts.binding.stage === "triage") {
    if (facts.triageDisposition === "all-reject") {
      if (facts.sourceNoChange) {
        if (!facts.noChangeContinuation?.eligible) {
          throw new Error("Task no-change completion requires canonical continuation evidence");
        }
        const reason = facts.noChangeContinuation.reason;
        return plan("triage-no-change-complete", [
          ["triage", "done"], ["repair", "skipped", reason], ["gate", "skipped", reason],
        ]);
      }
      return plan("triage-all-reject-to-gate", [
        ["triage", "done"], ["repair", "skipped", facts.reason],
      ], "gate");
    }
    if (facts.sourceNoChange) {
      if (facts.taskRound === 2) {
        return plan("triage-no-change-to-gate", [
          ["triage", "done"],
          ["repair", "skipped", "The final implementation round made no source change; selected findings are carried to Task Gate."],
        ], "gate", { acceptanceUnreviewed: true });
      }
      return plan("triage-no-change-correction", [
        ["impl", "invalidated"], ["review", "invalidated"], ["triage", "invalidated"],
        ["repair", "invalidated"], ["gate", "invalidated"],
      ], "impl");
    }
    return plan("triage-to-repair", [["triage", "done"]], "repair");
  }
  if (facts.repairChanged === false && facts.reviewResultCount === 4 && !facts.acceptanceCarryForwardReady) {
    throw new Error("fourth Task repair no-change requires the unreviewed Acceptance handoff");
  }
  if (facts.reviewResultCount < 4) {
    return plan("repair-to-review", [
      ["review", "invalidated"], ["triage", "invalidated"], ["repair", "invalidated"], ["gate", "invalidated"],
    ], "review");
  }
  if (!facts.acceptanceCarryForwardReady) {
    throw new Error("fourth Task repair requires the unreviewed Acceptance handoff");
  }
  return plan("repair-unreviewed-to-gate", [["repair", "done"]], "gate", {
    acceptanceUnreviewed: true,
  });
}

const MAX_DEPTH = 3;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

class ScalarMaxAttempts {
  constructor(value) {
    if (!isPositiveInteger(value)) {
      throw new Error("invalid maxAttempts: expected a positive integer");
    }
    this.value = value;
    Object.freeze(this);
  }

  resolve() {
    return this.value;
  }
}

class ModeMaxAttempts {
  constructor(value) {
    if (!isPlainObject(value)) {
      throw new Error("invalid maxAttempts: expected exactly own auto/manual keys");
    }
    const keys = Object.keys(value);
    if (
      keys.length !== 2
      || !Object.hasOwn(value, "auto")
      || !Object.hasOwn(value, "manual")
    ) {
      throw new Error("invalid maxAttempts: expected exactly own auto/manual keys");
    }
    if (!isPositiveInteger(value.auto) || !isPositiveInteger(value.manual)) {
      throw new Error("invalid maxAttempts: auto/manual must be positive integers");
    }
    this.auto = value.auto;
    this.manual = value.manual;
    Object.freeze(this);
  }

  resolve(context = {}) {
    return context.autoApprove === true ? this.auto : this.manual;
  }
}

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function createMaxAttempts(value) {
  if (typeof value === "number") return new ScalarMaxAttempts(value);
  return new ModeMaxAttempts(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStepList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return Object.freeze(value.map((step) => requireString(step, field)));
}

function requireOptionalStepList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const steps = value.map((step) => requireString(step, field));
  if (new Set(steps).size !== steps.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze(steps);
}

function nonblockingSelectionDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const GATE_DISPOSITIONS = new Set([
  "pass", "retry", "repair", "defer", "external-blocked", "blocked", "recovery", "reconcile", "nonblocking", "advance",
]);
const GATE_TRANSITION_TOKEN = Symbol("definition-gate-transition");
export const SPEC_GATE_MAXIMUM_CYCLE = 4;
const NONBLOCKING_ELIGIBILITY_TOKEN = Symbol("definition-nonblocking-eligibility");
export { DraftCompletionConnector } from "./lib/draft-completion-connector.js";

export class GateTransitionDisposition {
  constructor(token, { operation, reason = null } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) {
      throw new Error("Gate dispositions are created only by the definition resolver");
    }
    this.operation = requireString(operation, "gate disposition operation");
    if (!GATE_DISPOSITIONS.has(this.operation)) throw new Error("gate disposition operation is invalid");
    this.reason = reason == null ? null : requireString(reason, "gate disposition reason");
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, reason: this.reason }; }
}

class GateDisposition extends GateTransitionDisposition {
  constructor(token, operation, reason = null) { super(token, { operation, reason }); }
}

export class GatePassDisposition extends GateDisposition {
  constructor(token) { super(token, "pass"); }
}
export class GateRetryDisposition extends GateDisposition {
  constructor(token) { super(token, "retry"); }
}
export class GateRepairDisposition extends GateDisposition {
  constructor(token) { super(token, "repair"); }
}
export class GateDeferDisposition extends GateDisposition {
  constructor(token) { super(token, "defer"); }
}
/** Draft semantic exhaustion carries findings forward without offering advisory activation. */
export class DraftGateCarryForwardDisposition extends GateDeferDisposition {
  constructor(token) { super(token); }
}
export class GateExternalBlockedDisposition extends GateDisposition {
  constructor(token, reason) { super(token, "external-blocked", reason); }
}
export class GateBlockedDisposition extends GateDisposition {
  constructor(token, reason) { super(token, "blocked", reason); }
}
export class GateRecoveryDisposition extends GateDisposition {
  constructor(token) { super(token, "recovery"); }
}
export class GateReconcilePublicationDisposition extends GateDisposition {
  constructor(token) { super(token, "reconcile"); }
}
export class GateNonblockingDisposition extends GateDisposition {
  constructor(token) { super(token, "nonblocking"); }
}
export class GateAdvanceDisposition extends GateDisposition {
  constructor(token) { super(token, "advance"); }
}

export class GateStepUpdate {
  constructor({ stepId, status } = {}) {
    this.stepId = requireString(stepId, "gate step update stepId");
    this.status = requireString(status, "gate step update status");
    if (!["in_progress", "done"].includes(this.status)) {
      throw new Error("gate step update status is invalid");
    }
    Object.freeze(this);
  }

  toJSON() { return { stepId: this.stepId, status: this.status }; }
}

/** Definition-owned durable Gate retry metric mutation. */
export class GateRetryMetricEffect {
  constructor({ operation, phase } = {}) {
    this.operation = requireString(operation, "gate retry metric operation");
    this.phase = requireString(phase, "gate retry metric phase");
    if (!["increment", "reset"].includes(this.operation)) {
      throw new Error("gate retry metric operation is invalid");
    }
    if (!GATE_PHASE_DEFINITIONS.has(this.phase)) {
      throw new Error("gate retry metric phase is invalid");
    }
    Object.freeze(this);
  }
  toJSON() { return { operation: this.operation, phase: this.phase }; }
}

/** A sealed Task lifecycle consequence; adapters may apply but never select it. */
export class GateTaskLifecycleEffect {
  constructor({ operation, taskId, successorStepId, resetStepIds = [] } = {}) {
    this.operation = requireString(operation, "gate Task lifecycle operation");
    if (!new Set(["complete-and-advance", "repair-task-impl", "defer-and-advance"]).has(this.operation)) {
      throw new Error("gate Task lifecycle operation is invalid");
    }
    this.taskId = requireString(taskId, "gate Task lifecycle taskId");
    this.successorStepId = requireString(successorStepId, "gate Task lifecycle successorStepId");
    if (!Array.isArray(resetStepIds) || resetStepIds.some((stepId) => typeof stepId !== "string" || stepId === "")) {
      throw new Error("gate Task lifecycle reset Step ids are invalid");
    }
    this.resetStepIds = Object.freeze([...resetStepIds]);
    if (this.operation === "repair-task-impl" && JSON.stringify(this.resetStepIds) !== JSON.stringify([
      `${this.taskId}-impl`, `${this.taskId}-review`, `${this.taskId}-triage`, `${this.taskId}-repair`, `${this.taskId}-gate`,
    ])) throw new Error("gate Task repair lifecycle must reset only its materialized Task Steps");
    if (this.operation !== "repair-task-impl" && this.resetStepIds.length !== 0) {
      throw new Error("non-repair Task lifecycle must not reset Task Steps");
    }
    Object.freeze(this);
  }

  toJSON() {
    return { operation: this.operation, taskId: this.taskId, successorStepId: this.successorStepId, resetStepIds: [...this.resetStepIds] };
  }
}

/** Static report wording; transition routes are selected by Gate decisions. */
export class GatePhaseDefinition {
  constructor({ phase, passPrescription, failurePrescription } = {}) {
    this.phase = requireString(phase, "gate phase definition phase");
    this.passPrescription = requireString(passPrescription, "gate phase definition pass prescription");
    this.failurePrescription = requireString(failurePrescription, "gate phase definition failure prescription");
    Object.freeze(this);
  }
  toJSON() {
    return {
      phase: this.phase,
      passPrescription: this.passPrescription,
      failurePrescription: this.failurePrescription,
    };
  }
}

const GATE_PHASE_DEFINITIONS = new Map([
  ["draft", new GatePhaseDefinition({ phase: "draft", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the draft evidence selected by Definition." })],
  ["spec", new GatePhaseDefinition({ phase: "spec", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the specification evidence selected by Definition." })],
  // task-spec is a flow-level validation command. It cannot materialize or
  // enter a Task lifecycle; only the existing spec approval route may admit
  // Task impl/review/triage/repair/gate leaves.
  ["task-spec", new GatePhaseDefinition({ phase: "task-spec", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Return to the flow-level specification approval path." })],
  ["task-impl", new GatePhaseDefinition({ phase: "task-impl", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the Task implementation selected by Definition." })],
  ["integration", new GatePhaseDefinition({ phase: "integration", passPrescription: "Continue with the Definition-selected Gate action.", failurePrescription: "Repair the integration evidence selected by Definition." })],
]);

function gatePhaseDefinition(phase) {
  const definition = GATE_PHASE_DEFINITIONS.get(phase);
  if (definition === undefined) throw new Error(`missing Gate phase definition: ${phase}`);
  return definition;
}

/** Return diagnostic wording only; callers receive no route identifier. */
export function gateReportPrescription(phase, result) {
  if (result !== "pass" && result !== "fail") throw new Error("gate report prescription requires pass or fail");
  const definition = gatePhaseDefinition(phase);
  return result === "pass" ? definition.passPrescription : definition.failurePrescription;
}

/** A sealed Definition-owned recovery route, never a runner-selected rewind. */
export class GateRecoveryEffect {
  constructor({ operation, sourceStepId, targetStepId } = {}) {
    this.operation = requireString(operation, "gate recovery operation");
    this.sourceStepId = requireString(sourceStepId, "gate recovery source Step");
    this.targetStepId = requireString(targetStepId, "gate recovery target Step");
    if (this.operation !== "rewind-test-evidence"
      || this.sourceStepId !== "impl-gate"
      || this.targetStepId !== "test-execute") {
      throw new Error("gate recovery effect is invalid");
    }
    Object.freeze(this);
  }
  toJSON() { return { operation: this.operation, sourceStepId: this.sourceStepId, targetStepId: this.targetStepId }; }
}

/** The exact acceptance-backed route selected for an advisory Gate result. */
export class GateNonblockingHandoff {
  constructor({ sourceStepId, targetStepId, taskId = null } = {}) {
    this.sourceStepId = requireString(sourceStepId, "gate nonblocking source Step");
    this.targetStepId = requireString(targetStepId, "gate nonblocking target Step");
    this.taskId = taskId == null ? null : requireString(taskId, "gate nonblocking Task id");
    const route = nonblockingRouteFor(this.sourceStepId);
    if (route?.kind !== "gate" || route.taskScoped !== (this.taskId !== null)) {
      throw new Error("gate nonblocking handoff is not acceptance-backed");
    }
    if (route.targetStep !== null && route.targetStep !== this.targetStepId) {
      throw new Error("gate nonblocking handoff target is invalid");
    }
    Object.freeze(this);
  }
  toJSON() {
    return {
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      ...(this.taskId === null ? {} : { taskId: this.taskId }),
    };
  }
}

/** Stable identity of the recovery facts that authorized a Gate advisory. */
class GateNonblockingSelectionIdentity {
  constructor(token, { strictDecision, handoff, resultKind } = {}) {
    if (token !== GATE_TRANSITION_TOKEN
      || !(strictDecision instanceof GateTransitionDecision)
      || !(handoff instanceof GateNonblockingHandoff)) {
      throw new Error("Gate nonblocking selection identity requires a Definition decision and handoff");
    }
    if (!["quality", "tooling", "unavailable"].includes(resultKind)) {
      throw new Error("Gate nonblocking selection identity result kind is invalid");
    }
    this.strictDecision = strictDecision;
    this.handoff = handoff;
    this.resultKind = resultKind;
    Object.freeze(this);
  }

  toJSON() {
    const {
      snapshotRevision: _snapshotRevision,
      nonblocking: _nonblocking,
      ...recoveryFacts
    } = this.strictDecision.facts.toJSON();
    return {
      disposition: this.strictDecision.disposition.toJSON(),
      recoveryFacts,
      resultKind: this.resultKind,
      handoff: this.handoff.toJSON(),
    };
  }
}

/** One sealed action effect selected for an eligible advisory decision. */
export class DefinitionNonblockingDecisionEffect {
  constructor(token, { action, sourceStepId, targetStepId, skippedStepIds = [] } = {}) {
    if (token !== NONBLOCKING_ELIGIBILITY_TOKEN) {
      throw new Error("nonblocking decision effects are created only by Definition");
    }
    if (!["repair", "retry", "continue"].includes(action)) {
      throw new Error("nonblocking decision effect action is invalid");
    }
    this.action = action;
    this.operation = action === "continue" ? "continue" : "restart-source";
    this.sourceStepId = requireString(sourceStepId, "nonblocking decision effect source Step");
    this.targetStepId = requireString(targetStepId, "nonblocking decision effect target Step");
    this.skippedStepIds = requireOptionalStepList(skippedStepIds, "nonblocking decision effect skipped Steps");
    if (this.operation === "restart-source"
      && (this.targetStepId !== this.sourceStepId || this.skippedStepIds.length !== 0)) {
      throw new Error("nonblocking restart effect must target only its source Step");
    }
    this.nextAction = action === "continue" ? "refresh-next-action" : `run-${this.sourceStepId}`;
    Object.freeze(this);
  }

  toJSON() {
    return {
      action: this.action,
      operation: this.operation,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      skippedStepIds: this.skippedStepIds,
      nextAction: this.nextAction,
    };
  }
}

/** Typed proof that Definition selected an acceptance-backed strict stop. */
export class DefinitionNonblockingEligibility {
  constructor(token, {
    sourceStep,
    resultKind,
    blocker,
    continueTargetStepId = null,
    skippedStepIds = null,
    selectedFindingFingerprints = [],
    gateDecision = null,
    selection = null,
  } = {}) {
    if (token !== NONBLOCKING_ELIGIBILITY_TOKEN) {
      throw new Error("nonblocking eligibility is created only by Definition");
    }
    this.sourceStep = requireString(sourceStep, "nonblocking eligibility source Step");
    if (nonblockingRouteFor(this.sourceStep) === null) {
      throw new Error("nonblocking eligibility requires an acceptance-backed route");
    }
    if (!["quality", "tooling", "unavailable"].includes(resultKind)) {
      throw new Error("nonblocking eligibility result kind is invalid");
    }
    this.resultKind = resultKind;
    this.blocker = requireString(blocker, "nonblocking eligibility blocker");
    if (selection === null || typeof selection !== "object") {
      throw new Error("nonblocking eligibility requires its Definition selection");
    }
    this.definitionDigest = nonblockingSelectionDigest(selection);
    const route = nonblockingRouteFor(this.sourceStep);
    this.continueTargetStepId = requireString(
      continueTargetStepId ?? route.targetStep,
      "nonblocking continuation target Step",
    );
    const skipped = skippedStepIds ?? route.skippedSteps;
    this.skippedStepIds = requireOptionalStepList(skipped, "nonblocking continuation skipped Steps");
    this.selectedFindingFingerprints = requireOptionalStepList(
      selectedFindingFingerprints,
      "nonblocking selected finding fingerprints",
    );
    this.allowedActions = Object.freeze(resultKind === "quality"
      ? ["repair", "continue"]
      : ["retry", "continue"]);
    this.acceptancePublication = resultKind === "quality" && ["gate", "review"].includes(route.kind)
      ? "semantic-findings"
      : "nonblocking-handoff";
    if (!["semantic-findings", "nonblocking-handoff"].includes(this.acceptancePublication)) {
      throw new Error("nonblocking acceptance publication is invalid");
    }
    if (gateDecision !== null && !(gateDecision instanceof GateTransitionDecision)) {
      throw new Error("nonblocking Gate decision must be typed or null");
    }
    this.gateDecision = gateDecision;
    if (new.target === DefinitionNonblockingEligibility) Object.freeze(this);
  }

  effectFor(action) {
    if (!this.allowedActions.includes(action)) {
      throw new Error(`nonblocking action ${action} is not selected by Definition`);
    }
    return new DefinitionNonblockingDecisionEffect(NONBLOCKING_ELIGIBILITY_TOKEN, {
      action,
      sourceStepId: this.sourceStep,
      targetStepId: action === "continue" ? this.continueTargetStepId : this.sourceStep,
      skippedStepIds: action === "continue" ? this.skippedStepIds : Object.freeze([]),
    });
  }

  toJSON() {
    return {
      sourceStep: this.sourceStep,
      resultKind: this.resultKind,
      blocker: this.blocker,
      allowedActions: this.allowedActions,
      continueTargetStepId: this.continueTargetStepId,
      skippedStepIds: this.skippedStepIds,
      ...(this.selectedFindingFingerprints.length > 0 && {
        selectedFindingFingerprints: this.selectedFindingFingerprints,
      }),
      acceptancePublication: this.acceptancePublication,
      definitionDigest: this.definitionDigest,
    };
  }
}

export function reviewNonblockingEligibilityForDisposition({ stepId, disposition } = {}) {
  if (!(disposition instanceof DefinitionReviewDisposition)
    || !["external-blocked", "defer"].includes(disposition.operation)) return null;
  if (nonblockingRouteFor(stepId)?.kind !== "review") return null;
  return new DefinitionNonblockingEligibility(NONBLOCKING_ELIGIBILITY_TOKEN, {
    sourceStep: stepId,
    resultKind: disposition.operation === "external-blocked" ? "tooling" : "quality",
    blocker: disposition.operation === "external-blocked"
      ? "Review tooling recovery is unavailable."
      : "Review recovery is exhausted with acceptance-backed findings.",
    selection: disposition.toJSON(),
    selectedFindingFingerprints: disposition.operation === "defer"
      ? disposition.sourceFingerprints
      : [],
  });
}

/** Definition policy for acceptance-backed checks without a retry reducer. */
export function acceptanceBoundaryNonblockingEligibility({ sourceStep, resultKind } = {}) {
  if (!["retro", "acceptance-review"].includes(sourceStep)) return null;
  if (nonblockingRouteFor(sourceStep) === null) return null;
  return new DefinitionNonblockingEligibility(NONBLOCKING_ELIGIBILITY_TOKEN, {
    sourceStep,
    resultKind,
    blocker: sourceStep === "acceptance-review"
      ? "Acceptance requires an explicit disposition of the recorded blocker."
      : "Retrospective completion has unresolved acceptance evidence and no ordinary retry route.",
    selection: { sourceStep, resultKind, disposition: "acceptance-boundary" },
  });
}

/**
 * Select advisory eligibility for the active canonical Step. The supplied
 * reader may only expose typed facts; this Definition owns every route and
 * disposition branch.
 */
export function resolveActiveNonblockingEligibility({ sourceStep, evidence, flowState, reader } = {}) {
  const route = nonblockingRouteFor(sourceStep);
  if (route === null || reader === null || typeof reader !== "object") return null;
  if (route.kind === "gate") {
    const observed = reader.gateFacts(route);
    if (observed === null) return null;
    const facts = observed.nonblocking
      ? GateTransitionFacts.fromPersisted({ ...observed.toJSON(), nonblocking: false })
      : observed;
    const strictDecision = resolveTaskGateSettlementRecovery(facts)
      ?? resolveGatePublicationRecovery(facts)
      ?? resolveGateTransition(facts);
    return gateNonblockingEligibilityForDecision(strictDecision);
  }
  if (route.kind === "review") {
    const facts = reader.reviewFacts(route);
    if (facts === null) return null;
    return reviewNonblockingEligibilityForDisposition({
      stepId: sourceStep,
      disposition: resolveReviewTransition({ stepId: sourceStep, flowState, facts }),
    });
  }
  if (sourceStep === "test-result-review") {
    const observed = reader.testChainFacts(route);
    if (observed === null) return null;
    const facts = observed.nonblocking
      ? new NonGateTransitionFacts({ ...observed.toJSON(), nonblocking: false, stepFacts: observed.stepFacts })
      : observed;
    return nonGateNonblockingEligibilityForDecision(resolveNonGateTransition(facts, testResultReviewTransitionDefinition));
  }
  if (route.kind === "regression") {
    const observed = reader.finalRegressionFacts(route);
    if (observed === null) return null;
    const facts = observed.nonblocking
      ? new NonGateTransitionFacts({ ...observed.toJSON(), nonblocking: false, stepFacts: observed.stepFacts })
      : observed;
    return nonGateNonblockingEligibilityForDecision(resolveNonGateTransition(
      facts,
      FINAL_REGRESSION_STEP_DEFINITION,
    ));
  }
  return acceptanceBoundaryNonblockingEligibility({
    sourceStep,
    resultKind: evidence?.resultKind,
  });
}

/** Definition-owned proof that one strict Gate stop has an acceptance route. */
export class GateNonblockingEligibility extends DefinitionNonblockingEligibility {
  constructor(token, { strictDecision, gateDecision, resultKind, handoff } = {}) {
    if (token !== GATE_TRANSITION_TOKEN
      || !(strictDecision instanceof GateTransitionDecision)
      || !(gateDecision instanceof GateTransitionDecision)
      || gateDecision.disposition.operation !== "nonblocking") {
      throw new Error("Gate nonblocking eligibility is created only by the definition resolver");
    }
    const strictDisposition = strictDecision.disposition;
    if (!["defer", "external-blocked", "blocked"].includes(strictDisposition.operation)) {
      throw new Error("Gate nonblocking eligibility requires an exhausted or unavailable strict disposition");
    }
    if (!(handoff instanceof GateNonblockingHandoff)) {
      throw new Error("Gate nonblocking eligibility requires an acceptance-backed handoff");
    }
    super(NONBLOCKING_ELIGIBILITY_TOKEN, {
      sourceStep: handoff.sourceStepId,
      resultKind,
      blocker: strictDisposition.reason || "Strict Gate recovery is exhausted.",
      continueTargetStepId: handoff.targetStepId,
      gateDecision,
      selection: new GateNonblockingSelectionIdentity(GATE_TRANSITION_TOKEN, {
        strictDecision,
        handoff,
        resultKind,
      }),
    });
    this.strictDisposition = strictDisposition;
    this.handoff = handoff;
    Object.freeze(this);
  }

  toJSON() {
    return {
      strictDisposition: this.strictDisposition.toJSON(),
      ...super.toJSON(),
      handoff: this.handoff.toJSON(),
    };
  }
}

export class GateStepUpdatePlan {
  constructor(token, { action, phaseDefinition, updates, taskLifecycle = null, repairConnector = null, recoveryEffect = null, nonblockingHandoff = null, retryMetric = null } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) {
      throw new Error("Gate step update plans are created only by the definition resolver");
    }
    if (!(action instanceof GateTransitionAction)) throw new Error("gate step update plan requires a typed Action");
    if (!(phaseDefinition instanceof GatePhaseDefinition)) throw new Error("gate step update plan requires a typed phase definition");
    if (!Array.isArray(updates) || updates.some((entry) => !(entry instanceof GateStepUpdate))) {
      throw new Error("gate step update plan requires typed updates");
    }
    if (retryMetric !== null && !(retryMetric instanceof GateRetryMetricEffect)) throw new Error("gate step update retry metric must be typed");
    if (taskLifecycle !== null && !(taskLifecycle instanceof GateTaskLifecycleEffect)) {
      throw new Error("gate step update plan requires typed Task lifecycle effect");
    }
    if (repairConnector !== null && !(repairConnector instanceof PlanGateRepairConnector)) {
      throw new Error("gate step update plan requires a typed plan Gate repair connector");
    }
    if (recoveryEffect !== null && !(recoveryEffect instanceof GateRecoveryEffect)) {
      throw new Error("gate step update plan requires typed recovery effect");
    }
    if (nonblockingHandoff !== null && !(nonblockingHandoff instanceof GateNonblockingHandoff)) {
      throw new Error("gate step update plan requires typed nonblocking handoff");
    }
    this.action = action;
    this.phaseDefinition = phaseDefinition;
    this.updates = Object.freeze([...updates]);
    this.taskLifecycle = taskLifecycle;
    this.repairConnector = repairConnector;
    this.recoveryEffect = recoveryEffect;
    this.nonblockingHandoff = nonblockingHandoff;
    this.retryMetric = retryMetric;
    Object.freeze(this);
  }

  toJSON() {
    return {
      action: this.action.toJSON(),
      phaseDefinition: this.phaseDefinition.toJSON(),
      updates: this.updates.map((entry) => entry.toJSON()),
      taskLifecycle: this.taskLifecycle?.toJSON() ?? null,
      repairConnector: this.repairConnector?.toJSON() ?? null,
      recoveryEffect: this.recoveryEffect?.toJSON() ?? null,
      nonblockingHandoff: this.nonblockingHandoff?.toJSON() ?? null,
      retryMetric: this.retryMetric?.toJSON() ?? null,
    };
  }
}

/** Definition-sealed route from one failed Gate Attempt to its repair worker. */
export class PlanGateRepairConnector {
  constructor(token, { facts, route, taskLifecycle = null } = {}) {
    if (token !== GATE_TRANSITION_TOKEN
      || !(facts instanceof GateTransitionFacts)
      || !(route instanceof PlanGateRepairRoute)
      || (facts.recoveryEvidence.kind !== "repair" && facts.phase !== "draft")) {
      throw new Error("plan Gate repair connectors are created only by Definition");
    }
    if (route.phase !== facts.phase || route.gateStepId !== facts.target.stepId) {
      throw new Error("plan Gate repair connector route does not match its Gate facts");
    }
    if ((facts.scope === "task") !== (taskLifecycle instanceof GateTaskLifecycleEffect)) {
      throw new Error("plan Gate repair connector Task lifecycle is inconsistent");
    }
    if (taskLifecycle !== null && (
      taskLifecycle.operation !== "repair-task-impl"
      || taskLifecycle.successorStepId !== route.targetStepId
      || stableGateJson(taskLifecycle.resetStepIds) !== stableGateJson(route.resetStepIds)
    )) throw new Error("plan Gate repair connector does not match its sealed Task lifecycle");
    this.phase = route.phase;
    this.sourceGateStepId = route.gateStepId;
    this.sourceAttempt = facts.currentAttempt;
    this.resultLogicalKey = planGateRepairResultLogicalKey(route);
    this.resultArtifactId = facts.catalogPublication.artifactId;
    this.catalogFingerprint = facts.catalogPublication.fingerprint;
    this.targetStepId = route.targetStepId;
    this.resetStepIds = Object.freeze([...route.resetStepIds]);
    this.taskLifecycle = taskLifecycle;
    Object.freeze(this);
  }

  toJSON() {
    return {
      phase: this.phase,
      sourceGateStepId: this.sourceGateStepId,
      sourceAttempt: this.sourceAttempt.toJSON(),
      resultLogicalKey: this.resultLogicalKey,
      resultArtifactId: this.resultArtifactId,
      catalogFingerprint: this.catalogFingerprint,
      targetStepId: this.targetStepId,
      resetStepIds: [...this.resetStepIds],
      taskLifecycle: this.taskLifecycle?.toJSON() ?? null,
    };
  }
}

/** Stable, persisted-fact-only identity for a Definition-selected Gate route. */
export class GateActionIdentity {
  constructor(token, { runId, specId, taskId = null, stepId, attempt, catalogFingerprint, factsFingerprint, selectedFingerprint, operation } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) throw new Error("Gate Action identities are created only by the definition resolver");
    this.runId = requireString(runId, "gate Action runId");
    this.specId = requireString(specId, "gate Action specId");
    this.taskId = taskId == null ? null : requireString(taskId, "gate Action taskId");
    this.stepId = requireString(stepId, "gate Action stepId");
    this.attempt = attempt instanceof GateAttemptIdentity ? attempt : new GateAttemptIdentity(attempt);
    this.catalogFingerprint = requireString(catalogFingerprint, "gate Action catalog fingerprint");
    this.factsFingerprint = requireString(factsFingerprint, "gate Action facts fingerprint");
    this.selectedFingerprint = requireString(selectedFingerprint, "gate Action selected fingerprint");
    this.operation = requireString(operation, "gate Action operation");
    if (!GATE_DISPOSITIONS.has(this.operation)) throw new Error("gate Action operation is invalid");
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof GateActionIdentity
      && this.runId === other.runId
      && this.specId === other.specId
      && this.taskId === other.taskId
      && this.stepId === other.stepId
      && this.attempt.matches(other.attempt)
      && this.catalogFingerprint === other.catalogFingerprint
      && this.factsFingerprint === other.factsFingerprint
      && this.selectedFingerprint === other.selectedFingerprint
      && this.operation === other.operation;
  }

  toJSON() {
    return {
      runId: this.runId, specId: this.specId, ...(this.taskId === null ? {} : { taskId: this.taskId }), stepId: this.stepId, attempt: this.attempt.toJSON(),
      catalogFingerprint: this.catalogFingerprint, factsFingerprint: this.factsFingerprint,
      selectedFingerprint: this.selectedFingerprint, operation: this.operation,
    };
  }
}

export class GateTransitionAction {
  constructor(token, { identity } = {}) {
    if (token !== GATE_TRANSITION_TOKEN || !(identity instanceof GateActionIdentity)) {
      throw new Error("Gate Actions are created only by the definition resolver");
    }
    this.identity = identity;
    Object.freeze(this);
  }

  toJSON() { return { identity: this.identity.toJSON() }; }
}

export class GateTransitionDecision {
  constructor(token, { facts, disposition, advance = null, plan } = {}) {
    if (token !== GATE_TRANSITION_TOKEN) {
      throw new Error("Gate transition decisions are created only by definition resolver");
    }
    if (!(facts instanceof GateTransitionFacts)) throw new Error("gate decision requires typed facts");
    if (!(disposition instanceof GateTransitionDisposition)) throw new Error("gate decision requires typed disposition");
    if (advance !== null && !(advance instanceof GateAdvanceDisposition)) {
      throw new Error("gate decision advance must be typed");
    }
    if (!(plan instanceof GateStepUpdatePlan)) throw new Error("gate decision requires typed plan");
    if (plan.action.identity.operation !== disposition.operation) {
      throw new Error("gate decision plan Action does not match disposition");
    }
    this.facts = facts;
    this.disposition = disposition;
    this.advance = advance;
    this.plan = plan;
    Object.freeze(this);
  }

  toJSON() {
    return {
      facts: this.facts.toJSON(),
      disposition: this.disposition.toJSON(),
      advance: this.advance?.toJSON() ?? null,
      plan: this.plan.toJSON(),
    };
  }
}

/** One Definition-owned answer to whether a Gate provider may be called. */
export class GateEvaluationAdmission {
  constructor({ facts = null, recoveryDecision = null, transitionDecision = null } = {}) {
    if (facts !== null && !(facts instanceof GateTransitionFacts)) {
      throw new Error("Gate evaluation admission requires typed facts or no published Gate result");
    }
    if (recoveryDecision !== null && !(recoveryDecision instanceof GateTransitionDecision)) {
      throw new Error("Gate evaluation admission recovery decision must be typed");
    }
    if (transitionDecision !== null && !(transitionDecision instanceof GateTransitionDecision)) {
      throw new Error("Gate evaluation admission transition decision must be typed");
    }
    if (facts === null && (recoveryDecision !== null || transitionDecision !== null)) {
      throw new Error("unpublished Gate evaluation admission cannot select a decision");
    }
    if (recoveryDecision !== null && transitionDecision !== null) {
      throw new Error("Gate evaluation admission selects one recovery or transition decision");
    }
    this.facts = facts;
    this.recoveryDecision = recoveryDecision;
    this.transitionDecision = transitionDecision;
    Object.freeze(this);
  }

  get admitted() { return this.facts === null; }
  get selectedDecision() { return this.recoveryDecision ?? this.transitionDecision; }

  toJSON() {
    return {
      admitted: this.admitted,
      ...(this.selectedDecision === null ? {} : {
        selectedOperation: this.selectedDecision.disposition.operation,
        recovery: this.recoveryDecision !== null,
      }),
    };
  }
}

/** Public command outcome derived from a sealed Gate decision, not runner policy. */
export class GatePublicOutcomeProjection {
  constructor({ failureCode = null, nextStepId = null } = {}) {
    this.failureCode = failureCode == null ? null : requireString(failureCode, "gate public failure code");
    this.nextStepId = nextStepId == null ? null : requireString(nextStepId, "gate public next Step");
    Object.freeze(this);
  }
  get failed() { return this.failureCode !== null; }
  toJSON() {
    return {
      failed: this.failed,
      failureCode: this.failureCode,
      nextStepId: this.nextStepId,
    };
  }
}

export function projectGatePublicOutcome(decision) {
  if (!(decision instanceof GateTransitionDecision)) throw new Error("gate public projection requires a definition decision");
  const recovery = decision.plan.recoveryEffect;
  if (recovery !== null) {
    return new GatePublicOutcomeProjection({ nextStepId: recovery.targetStepId });
  }
  if (!["external-blocked", "blocked"].includes(decision.disposition.operation)) {
    return new GatePublicOutcomeProjection();
  }
  const phase = decision.facts.phase;
  const sourceCode = decision.facts.failure?.code ?? "GATE_EXTERNAL_BLOCKED";
  if (decision.facts.failure?.category === "local") {
    return new GatePublicOutcomeProjection({ failureCode: "GATE_LOCAL_INPUT_INVALID" });
  }
  return new GatePublicOutcomeProjection({
    failureCode: ["draft", "spec", "task-spec"].includes(phase) || sourceCode === "GATE_EXTERNAL_BLOCKED"
      ? "STEP_EXTERNAL_BLOCKED"
      : sourceCode,
  });
}

function stableGateJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableGateJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableGateJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskLifecycleEffect(facts, disposition) {
  if (facts.taskLifecycle === null) return null;
  const lifecycle = facts.taskLifecycle;
  if (disposition.operation === "pass") return new GateTaskLifecycleEffect({
    operation: "complete-and-advance", taskId: lifecycle.taskId, successorStepId: lifecycle.successorStepId,
  });
  if (disposition.operation === "defer" || disposition.operation === "nonblocking") return new GateTaskLifecycleEffect({
    operation: "defer-and-advance", taskId: lifecycle.taskId, successorStepId: lifecycle.successorStepId,
  });
  if (disposition.operation === "repair") return new GateTaskLifecycleEffect({
    operation: "repair-task-impl", taskId: lifecycle.taskId, successorStepId: lifecycle.implStepId,
    resetStepIds: [
      lifecycle.implStepId,
      lifecycle.reviewStepId,
      lifecycle.triageStepId,
      lifecycle.repairStepId,
      lifecycle.gateStepId,
    ],
  });
  return null;
}

function gatePlan(facts, disposition, { status = "in_progress", updates = null, recoveryEffect = null, nonblockingHandoff = null, retryMetric = null } = {}) {
  const phaseDefinition = gatePhaseDefinition(facts.phase);
  const selectedUpdates = updates ?? [new GateStepUpdate({ stepId: facts.target.stepId, status })];
  const lifecycle = taskLifecycleEffect(facts, disposition);
  const repairConnector = disposition.operation === "repair"
    ? new PlanGateRepairConnector(GATE_TRANSITION_TOKEN, {
      facts,
      route: planGateRepairRouteForGateStep(facts.target.stepId),
      taskLifecycle: lifecycle,
    })
    : null;
  const selectedFingerprint = createHash("sha256").update(stableGateJson({
    disposition: disposition.toJSON(), phaseDefinition: phaseDefinition.toJSON(), updates: selectedUpdates.map((entry) => entry.toJSON()), taskLifecycle: lifecycle?.toJSON() ?? null,
    repairConnector: repairConnector?.toJSON() ?? null,
    recoveryEffect: recoveryEffect?.toJSON() ?? null, nonblockingHandoff: nonblockingHandoff?.toJSON() ?? null, retryMetric: retryMetric?.toJSON() ?? null,
  })).digest("hex");
  const identity = new GateActionIdentity(GATE_TRANSITION_TOKEN, {
    runId: facts.producer.runId,
    specId: facts.producer.specId,
    taskId: facts.target.taskId,
    stepId: facts.target.stepId,
    attempt: facts.currentAttempt,
    catalogFingerprint: facts.catalogPublication.fingerprint,
    factsFingerprint: createHash("sha256").update(stableGateJson(facts.toJSON())).digest("hex"),
    selectedFingerprint,
    operation: disposition.operation,
  });
  return new GateStepUpdatePlan(GATE_TRANSITION_TOKEN, {
    action: new GateTransitionAction(GATE_TRANSITION_TOKEN, { identity }), phaseDefinition, updates: selectedUpdates, taskLifecycle: lifecycle,
    repairConnector, recoveryEffect, nonblockingHandoff, retryMetric,
  });
}

function gateDecision(facts, disposition, options = {}) {
  const { advance = null } = options;
  return new GateTransitionDecision(GATE_TRANSITION_TOKEN, {
    facts, disposition, advance, plan: gatePlan(facts, disposition, options),
  });
}

function gateNonblockingSourceStep(facts) {
  if (facts.scope === "task") return "task-gate";
  if (facts.phase === "draft") return "draft-gate";
  if (facts.phase === "spec" || facts.phase === "task-spec") return "spec-gate";
  if (facts.phase === "integration") return "impl-gate";
  return null;
}

/**
 * Select advisory eligibility only from the sealed strict decision. Callers
 * may project this proof, but cannot manufacture it from a blocked directive.
 */
export function gateNonblockingEligibilityForDecision(decision) {
  if (!(decision instanceof GateTransitionDecision)) {
    throw new Error("Gate nonblocking eligibility requires a Definition decision");
  }
  const facts = decision.facts;
  if (facts.result !== "fail" || facts.integrityFailure !== null) return null;
  if (decision.disposition instanceof DraftGateCarryForwardDisposition) return null;
  if (!["defer", "external-blocked", "blocked"].includes(decision.disposition.operation)) return null;
  const sourceStepId = gateNonblockingSourceStep(facts);
  const route = sourceStepId === null ? null : nonblockingRouteFor(sourceStepId);
  if (route?.kind !== "gate") return null;
  const targetStepId = facts.scope === "task"
    ? facts.taskLifecycle?.successorStepId ?? null
    : route.targetStep;
  if (targetStepId === null) return null;
  const category = facts.failure?.category;
  const resultKind = category === "semantic"
    ? "quality"
    : category === "local" ? "unavailable" : "tooling";
  const enabledFacts = facts.nonblocking
    ? facts
    : GateTransitionFacts.fromPersisted({ ...facts.toJSON(), nonblocking: true });
  const handoff = new GateNonblockingHandoff({
    sourceStepId,
    targetStepId,
    taskId: facts.target.taskId,
  });
  const selectedGateDecision = gateDecision(
    enabledFacts,
    new GateNonblockingDisposition(GATE_TRANSITION_TOKEN),
    { nonblockingHandoff: handoff },
  );
  return new GateNonblockingEligibility(GATE_TRANSITION_TOKEN, {
    strictDecision: decision,
    gateDecision: selectedGateDecision,
    resultKind,
    handoff,
  });
}

function selectGateNonblockingDecision(facts, strictDecision) {
  if (facts.nonblocking !== true) return strictDecision;
  const eligibility = gateNonblockingEligibilityForDecision(strictDecision);
  if (eligibility === null) return strictDecision;
  return gateDecision(facts, new GateNonblockingDisposition(GATE_TRANSITION_TOKEN), {
    nonblockingHandoff: eligibility.handoff,
  });
}

/**
 * The definition's phase-neutral Gate policy. Phase migrations may add their
 * own facts, but execution and projection layers cannot choose a disposition.
 */
function resolveGateClassification(facts) {
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGateTransition requires GateTransitionFacts");
  }
  if (facts.integrityFailure !== null) {
    return gateDecision(facts, new GateBlockedDisposition(GATE_TRANSITION_TOKEN, facts.integrityFailure));
  }
  // A PASS evaluator result cannot erase an unresolved implementation-review
  // obligation. The typed readiness reader binds review, triage and repair
  // lineage before Definition decides whether the integration Gate may pass.
  if (facts.phase === "integration" && facts.result === "pass" && !facts.reviewReadiness.allowsPass) {
    return gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN,
      "unresolved_review_findings",
    ));
  }
  if (facts.result === "pass") {
    return gateDecision(facts, new GatePassDisposition(GATE_TRANSITION_TOKEN), {
      advance: new GateAdvanceDisposition(GATE_TRANSITION_TOKEN), status: "done",
      retryMetric: new GateRetryMetricEffect({ operation: "reset", phase: facts.phase }),
    });
  }
  if (facts.result === "recovered" || facts.recoveryEvidence.kind === "recovered") {
    const recoveryEffect = facts.phase === "integration"
      ? new GateRecoveryEffect({ operation: "rewind-test-evidence", sourceStepId: facts.target.stepId, targetStepId: "test-execute" })
      : null;
    return gateDecision(facts, new GateRecoveryDisposition(GATE_TRANSITION_TOKEN), {
      updates: [], recoveryEffect,
    });
  }
  if (facts.failure.category === "tooling") {
    const strict = gateDecision(facts, new GateExternalBlockedDisposition(
      GATE_TRANSITION_TOKEN, facts.failure.code || "tooling_failure",
    ));
    return selectGateNonblockingDecision(facts, strict);
  }
  if (facts.failure.category === "local") {
    const strict = gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN, facts.failure.code || "local_input_invalid",
    ));
    return selectGateNonblockingDecision(facts, strict);
  }
  if (facts.phase === "spec" && facts.specCycle.cycle >= SPEC_GATE_MAXIMUM_CYCLE) {
    const strict = gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN,
      `Spec Gate cycle ${facts.specCycle.cycle} reached maximum ${SPEC_GATE_MAXIMUM_CYCLE}.`,
    ));
    return selectGateNonblockingDecision(facts, strict);
  }
  // The draft phase is a bounded authoring funnel. Once the same evidence
  // survives a repair, or all five Gate evaluations have been consumed, the
  // unresolved finding must continue to the acceptance-backed Spec rather
  // than selecting another repair or stopping the Flow.
  if (facts.phase === "draft"
    && (facts.observationConvergence?.sameEvidence || facts.retry.exhausted)) {
    return gateDecision(facts, new DraftGateCarryForwardDisposition(GATE_TRANSITION_TOKEN));
  }
  // A current canonical repair receipt is stronger evidence than a raw
  // semantic retry for every repairable Gate. Repeating the evaluator against
  // the same evidence cannot converge; only the selected repair can change it.
  // Task execution rounds remain bounded separately.
  if (facts.recoveryEvidence.kind === "repair"
    && (facts.scope !== "task" || !facts.taskBudget.finalRound)) {
    return gateDecision(facts, new GateRepairDisposition(GATE_TRANSITION_TOKEN));
  }
  // Draft Gate semantic findings enter the bounded authoring repair loop on
  // their first ordinary observation. Other Gate phases retain their retry
  // budget policy below.
  if (facts.phase === "draft") {
    return gateDecision(facts, new GateRepairDisposition(GATE_TRANSITION_TOKEN));
  }
  if (facts.scope === "task"
    && facts.taskBudget.finalRound
    && facts.recoveryEvidence.kind === "repair") {
    const strict = gateDecision(facts, new GateDeferDisposition(GATE_TRANSITION_TOKEN));
    return selectGateNonblockingDecision(facts, strict);
  }
  // A new Task observation may still use its bounded round. A recurrence in
  // the final round cannot: the same semantic observation already survived a
  // changed repair, so another provider retry cannot add evidence.
  if (facts.scope === "task"
    && facts.taskBudget.finalRound
    && facts.observationConvergence?.allRecurring) {
    const strict = gateDecision(facts, new GateDeferDisposition(GATE_TRANSITION_TOKEN));
    return selectGateNonblockingDecision(facts, strict);
  }
  // A no-progress repair leaves the original evidence in force. Preserve the
  // Definition-selected stop rather than creating a fresh Attempt, metric or
  // provider call for that same observation.
  if (facts.observationConvergence?.sameEvidence) {
    const strict = gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN,
      "same_gate_observation_without_changed_repair",
    ));
    return selectGateNonblockingDecision(facts, strict);
  }
  if (!facts.retry.exhausted) {
    return gateDecision(facts, new GateRetryDisposition(GATE_TRANSITION_TOKEN), {
      retryMetric: new GateRetryMetricEffect({ operation: "increment", phase: facts.phase }),
    });
  }
  if (facts.scope === "task" && !facts.taskBudget.finalRound) {
    return gateDecision(facts, new GateBlockedDisposition(
      GATE_TRANSITION_TOKEN,
      "missing_plan_gate_repair_evidence",
    ));
  }
  // The failed Attempt remains current until the canonical settlement command
  // records its finding.  `defer` therefore has no premature status advance.
  const strict = gateDecision(facts, new GateDeferDisposition(GATE_TRANSITION_TOKEN));
  return selectGateNonblockingDecision(facts, strict);
}

export function resolveGateTransition(facts) {
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGateTransition requires GateTransitionFacts");
  }
  return resolveGateClassification(facts);
}

/**
 * Select the one recovery action that is available after result publication
 * and before the post hook has classified that result.  This is intentionally
 * separate from the semantic Gate decision: the post hook still receives the
 * same Definition-owned pass/fail plan it would have selected uninterrupted.
 */
export function resolveGatePublicationRecovery(facts) {
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGatePublicationRecovery requires GateTransitionFacts");
  }
  if (facts.integrityFailure !== null) return null;
  // Non-Task Gates retain their original publication-only recovery path:
  // no classification is needed until the normal transition reducer runs.
  if (facts.scope !== "task") {
    return facts.postPublication.requiresReconciliation
      ? gateDecision(facts, new GateReconcilePublicationDisposition(GATE_TRANSITION_TOKEN), { updates: [] })
      : null;
  }
  const classified = resolveGateClassification(facts);
  const taskSettlementIncomplete = facts.taskSettlementProgress.requiresReconciliation({
    classificationRequired: facts.result === "fail",
    metricEffect: classified.plan.retryMetric,
    issueLogRequired: facts.result === "pass" || facts.result === "fail",
    terminalLifecycleRequired: classified.plan.updates.some((update) => update.status === "done"),
  });
  if (!facts.postPublication.requiresReconciliation && !taskSettlementIncomplete) return null;
  return gateDecision(facts, new GateReconcilePublicationDisposition(GATE_TRANSITION_TOKEN), {
    updates: [],
  });
}

/** Task Gate-only alias that keeps post-publication settlement policy in Definition. */
export function resolveTaskGateSettlementRecovery(facts) {
  if (!(facts instanceof GateTransitionFacts) || facts.scope !== "task") return null;
  return resolveGatePublicationRecovery(facts);
}

/**
 * Gate commands and their provider-call guard share this exact admission
 * decision. Only absence of a canonical published result admits evaluation.
 */
export function resolveGateEvaluationAdmission(facts = null) {
  if (facts === null) return new GateEvaluationAdmission();
  if (!(facts instanceof GateTransitionFacts)) {
    throw new Error("resolveGateEvaluationAdmission requires GateTransitionFacts or null");
  }
  const recovery = resolveTaskGateSettlementRecovery(facts)
    ?? resolveGatePublicationRecovery(facts);
  if (recovery !== null) {
    return new GateEvaluationAdmission({ facts, recoveryDecision: recovery });
  }
  return new GateEvaluationAdmission({ facts, transitionDecision: resolveGateTransition(facts) });
}

// Non-Gate transition policy is intentionally independent from the Gate
// transition policy above.  A Step contributes typed evidence, while this
// reducer alone selects the disposition, plan and stable Action identity.
/**
 * Finalization recovery is deliberately a Definition decision, not an
 * incidental side effect of the next-action reader.  The facts are small
 * value objects because this boundary crosses the canonical store, the main
 * repository and the runtime log.
 */
const FINALIZATION_RECOVERY_TOKEN = Symbol("definition-finalization-recovery");
const FINALIZATION_RECOVERY_OPERATIONS = new Set([
  "ordinary-execute", "exact-outbox-recovery", "interrupted-sync-settlement",
  "pre-sync-conflict-repair", "blocked", "exhausted",
]);

export class FinalizationRecoveryTargetFact {
  constructor({ scope, stepId } = {}) {
    if (scope !== "flow") throw new Error("finalization recovery target must be flow scoped");
    if (!new Set(["report", "finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]).has(stepId)) {
      throw new Error("finalization recovery target step is invalid");
    }
    this.scope = scope;
    this.stepId = stepId;
    Object.freeze(this);
  }
}

export class FinalizationOutboxFact {
  constructor({ idempotencyKey = null, status = "missing", attempt = 0, failure = null, recovery = null, exactRecoveryReceipt = null } = {}) {
    if (!new Set(["missing", "pending", "done", "failed"]).has(status)) throw new Error("finalization outbox status is invalid");
    if (idempotencyKey !== null) requireString(idempotencyKey, "finalization outbox idempotencyKey");
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("finalization outbox attempt is invalid");
    if (status === "missing" && (idempotencyKey !== null || attempt !== 0 || failure !== null)) {
      throw new Error("missing finalization outbox cannot carry persisted identity or outcome facts");
    }
    if (status !== "missing" && (idempotencyKey === null || attempt < 1)) {
      throw new Error("persisted finalization outbox requires identity and attempt facts");
    }
    if (status === "failed") requireString(failure, "finalization outbox failure");
    if (status !== "failed" && failure !== null) throw new Error("only failed finalization outbox may carry a failure");
    if (recovery !== null && (typeof recovery !== "object" || Array.isArray(recovery))) throw new Error("finalization outbox recovery is invalid");
    const receipt = exactRecoveryReceipt === null
      ? null
      : exactRecoveryReceipt instanceof FinalizationExactRecoveryReceiptFact
        ? exactRecoveryReceipt
        : new FinalizationExactRecoveryReceiptFact(exactRecoveryReceipt);
    if (receipt !== null && (receipt.idempotencyKey !== idempotencyKey || receipt.attempt !== attempt)) {
      throw new Error("finalization exact recovery receipt must bind its outbox identity and attempt");
    }
    this.idempotencyKey = idempotencyKey;
    this.status = status;
    this.attempt = attempt;
    this.failure = failure;
    this.recovery = recovery === null ? null : Object.freeze(structuredClone(recovery));
    this.exactRecoveryReceipt = receipt;
    Object.freeze(this);
  }
}

export class FinalizationExactRecoveryReceiptFact {
  constructor({ idempotencyKey, attempt, failure, recoveryKey = null } = {}) {
    this.idempotencyKey = requireString(idempotencyKey, "finalization exact recovery receipt idempotencyKey");
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("finalization exact recovery receipt attempt is invalid");
    this.attempt = attempt;
    this.failure = requireString(failure, "finalization exact recovery receipt failure");
    this.recoveryKey = recoveryKey === null ? null : requireString(recoveryKey, "finalization exact recovery receipt recoveryKey");
    Object.freeze(this);
  }
}

export class FinalizationDurableProofFact {
  constructor({ durable = false } = {}) {
    if (typeof durable !== "boolean") throw new Error("finalization durable proof must be boolean");
    this.durable = durable;
    Object.freeze(this);
  }
}

export class FinalizationOperationLockFact {
  constructor({ status = "not-acquired" } = {}) {
    if (!new Set(["not-acquired", "busy", "available"]).has(status)) throw new Error("finalization operation lock status is invalid");
    this.status = status;
    Object.freeze(this);
  }
}

export class FinalizationMainAuthorityFact {
  constructor({ mainRoot, authorityRoot } = {}) {
    this.mainRoot = requireString(mainRoot, "finalization main authority root");
    this.authorityRoot = requireString(authorityRoot, "finalization state authority root");
    Object.freeze(this);
  }

  ownsMainState() {
    return this.authorityRoot === this.mainRoot;
  }
}

export class FinalizationPreSyncFact {
  constructor({ state = null } = {}) {
    if (state !== null && !new Set(["rebased", "needs-repair", "unavailable"]).has(state)) {
      throw new Error("finalization pre-sync state is invalid");
    }
    this.state = state;
    Object.freeze(this);
  }
}

export class InterruptedFinalizeSyncRuntimeLogFact {
  constructor({ receipt = null } = {}) {
    if (receipt !== null && (typeof receipt !== "object" || Array.isArray(receipt))) throw new Error("interrupted finalize-sync runtime receipt is invalid");
    if (receipt !== null) {
      const fields = Object.keys(receipt).sort();
      if (JSON.stringify(fields) !== JSON.stringify(["command", "complete", "runId", "sequence", "startedAt"].sort())) {
        throw new Error("interrupted finalize-sync runtime receipt fields are invalid");
      }
      requireString(receipt.runId, "interrupted finalize-sync runtime receipt runId");
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) throw new Error("interrupted finalize-sync runtime receipt sequence is invalid");
      if (receipt.command !== "flow run finalize-sync") throw new Error("interrupted finalize-sync runtime receipt command is invalid");
      requireString(receipt.startedAt, "interrupted finalize-sync runtime receipt startedAt");
      if (Number.isNaN(Date.parse(receipt.startedAt))) throw new Error("interrupted finalize-sync runtime receipt startedAt is invalid");
      if (receipt.complete !== false) throw new Error("interrupted finalize-sync runtime receipt must be incomplete");
    }
    this.receipt = receipt === null ? null : Object.freeze(structuredClone(receipt));
    Object.freeze(this);
  }
}

export class FinalizationRecoveryFacts {
  constructor({ target, outbox, durableProof, operationLock, mainAuthority, interruptedRuntimeLog = new InterruptedFinalizeSyncRuntimeLogFact(), preSync = new FinalizationPreSyncFact() } = {}) {
    if (!(target instanceof FinalizationRecoveryTargetFact)) throw new Error("finalization recovery requires a typed target");
    if (!(outbox instanceof FinalizationOutboxFact)) throw new Error("finalization recovery requires typed outbox facts");
    if (!(durableProof instanceof FinalizationDurableProofFact)) throw new Error("finalization recovery requires durable proof facts");
    if (!(operationLock instanceof FinalizationOperationLockFact)) throw new Error("finalization recovery requires operation lock facts");
    if (!(mainAuthority instanceof FinalizationMainAuthorityFact)) throw new Error("finalization recovery requires main authority facts");
    if (!(interruptedRuntimeLog instanceof InterruptedFinalizeSyncRuntimeLogFact)) throw new Error("finalization recovery requires runtime log facts");
    if (!(preSync instanceof FinalizationPreSyncFact)) throw new Error("finalization recovery requires pre-sync facts");
    this.target = target;
    this.outbox = outbox;
    this.durableProof = durableProof;
    this.operationLock = operationLock;
    this.mainAuthority = mainAuthority;
    this.interruptedRuntimeLog = interruptedRuntimeLog;
    this.preSync = preSync;
    Object.freeze(this);
  }
}

export class FinalizationRecoveryDecision {
  constructor(token, { facts, operation, reason = null } = {}) {
    if (token !== FINALIZATION_RECOVERY_TOKEN) throw new Error("finalization recovery decisions are created only by Definition");
    if (!(facts instanceof FinalizationRecoveryFacts)) throw new Error("finalization recovery decision requires typed facts");
    if (!FINALIZATION_RECOVERY_OPERATIONS.has(operation)) throw new Error("finalization recovery operation is invalid");
    this.facts = facts;
    this.operation = operation;
    this.reason = reason === null ? null : requireString(reason, "finalization recovery reason");
    Object.freeze(this);
  }
}

/** Select exactly one finalization route from canonical, immutable facts. */
export function resolveFinalizationRecovery(facts) {
  if (!(facts instanceof FinalizationRecoveryFacts)) throw new Error("resolveFinalizationRecovery requires typed facts");
  const { target, outbox, operationLock, mainAuthority, interruptedRuntimeLog, preSync } = facts;
  const recoveryPending = (target.stepId === "finalize-sync" && outbox.status === "pending" && interruptedRuntimeLog.receipt !== null)
    || outbox.status === "failed";
  if (recoveryPending && operationLock.status === "busy") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "operation_lock_busy" });
  }
  if (["finalize-sync", "finalize-cleanup"].includes(target.stepId) && recoveryPending && !mainAuthority.ownsMainState()) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "main_authority_required" });
  }
  if (target.stepId === "finalize-sync" && outbox.status === "pending" && interruptedRuntimeLog.receipt !== null) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "interrupted-sync-settlement" });
  }
  if (outbox.status !== "failed") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "ordinary-execute" });
  }
  if (preSync.state === "needs-repair") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "pre-sync-conflict-repair" });
  }
  if (preSync.state === "unavailable") {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "pre_sync_state_unavailable" });
  }
  const recoveryKey = outbox.recovery?.baseHead ?? null;
  if (outbox.exactRecoveryReceipt !== null && (recoveryKey === null || outbox.exactRecoveryReceipt.recoveryKey === recoveryKey)) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "exhausted", reason: "exact_recovery_consumed" });
  }
  if (target.stepId !== "finalize-merge" && !facts.durableProof.durable) {
    return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "blocked", reason: "durable_proof_unavailable" });
  }
  return new FinalizationRecoveryDecision(FINALIZATION_RECOVERY_TOKEN, { facts, operation: "exact-outbox-recovery" });
}

const NON_GATE_TRANSITION_TOKEN = Symbol("definition-non-gate-transition");
const NON_GATE_OPERATIONS = new Set([
  "advance", "keep-in-progress", "await-user-input", "retry", "repair",
  "record-and-proceed", "external-blocked", "blocked", "park",
]);

export class NonGateTransitionDisposition {
  constructor(token, { operation, reason = null } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate dispositions are created only by the definition resolver");
    }
    this.operation = requireString(operation, "non-Gate disposition operation");
    if (!NON_GATE_OPERATIONS.has(this.operation)) throw new Error("non-Gate disposition operation is invalid");
    this.reason = reason == null ? null : requireString(reason, "non-Gate disposition reason");
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, reason: this.reason }; }
}

class NonGateDisposition extends NonGateTransitionDisposition {
  constructor(token, operation, reason = null) { super(token, { operation, reason }); }
}

export class NonGateAdvanceDisposition extends NonGateDisposition { constructor(token) { super(token, "advance"); } }
export class NonGateKeepInProgressDisposition extends NonGateDisposition { constructor(token) { super(token, "keep-in-progress"); } }
export class NonGateAwaitUserInputDisposition extends NonGateDisposition { constructor(token, reason = null) { super(token, "await-user-input", reason); } }
export class NonGateRetryDisposition extends NonGateDisposition { constructor(token) { super(token, "retry"); } }
export class NonGateRepairDisposition extends NonGateDisposition { constructor(token) { super(token, "repair"); } }
export class NonGateRecordAndProceedDisposition extends NonGateDisposition { constructor(token) { super(token, "record-and-proceed"); } }
export class NonGateExternalBlockedDisposition extends NonGateDisposition { constructor(token, reason) { super(token, "external-blocked", reason); } }
export class NonGateBlockedDisposition extends NonGateDisposition { constructor(token, reason) { super(token, "blocked", reason); } }
export class NonGateParkDisposition extends NonGateDisposition { constructor(token, reason = null) { super(token, "park", reason); } }

/** A Definition-declared, guarded operator choice; it is not a route field. */
export class NonGateUserActionSelection {
  constructor({ actionId } = {}) {
    this.actionId = requireString(actionId, "non-Gate user action id");
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(this.actionId)) {
      throw new Error("non-Gate user action id is invalid");
    }
    Object.freeze(this);
  }

  toJSON() { return { actionId: this.actionId }; }
}

/**
 * A Step-specific Definition returns this declaration after interpreting its
 * own typed facts.  It is deliberately not a transition plan: only the
 * common Definition reducer below mints a sealed decision, plan and Action.
 */
export class NonGateTransitionSelection {
  constructor({ operation, reason = null, beforeActions = [], actions = [], exhaustedActions = [], userActions = [] } = {}) {
    this.operation = requireString(operation, "non-Gate selection operation");
    if (!NON_GATE_OPERATIONS.has(this.operation)) throw new Error("non-Gate selection operation is invalid");
    this.reason = reason == null ? null : requireString(reason, "non-Gate selection reason");
    for (const actionList of [beforeActions, actions, exhaustedActions]) {
      if (!Array.isArray(actionList) || actionList.some((action) => (
      !(action instanceof NonGateStepAction)
      || !Object.isFrozen(action)
      || action.apply === NonGateStepAction.prototype.apply
      || action.toJSON === NonGateStepAction.prototype.toJSON
      ))) throw new Error("non-Gate selection actions must be typed Step actions");
    }
    this.beforeActions = Object.freeze([...beforeActions]);
    this.actions = Object.freeze([...actions]);
    this.exhaustedActions = Object.freeze([...exhaustedActions]);
    if (!Array.isArray(userActions) || userActions.some((action) => !(action instanceof NonGateUserActionSelection))) {
      throw new Error("non-Gate selection user actions must be typed");
    }
    if (new Set(userActions.map((action) => action.actionId)).size !== userActions.length) {
      throw new Error("non-Gate selection user actions must be unique");
    }
    this.userActions = Object.freeze([...userActions]);
    Object.freeze(this);
  }
}

/** Extension base for Step-specific persistence actions selected by Definition. */
export class NonGateStepAction {
  constructor() {
    if (new.target === NonGateStepAction) throw new Error("non-Gate Step actions require a dedicated subclass");
  }

  apply() { throw new Error("non-Gate Step action subclasses must implement apply()"); }
  toJSON() { throw new Error("non-Gate Step action subclasses must implement toJSON()"); }
}

/**
 * Extension boundary for a non-Gate Step's Definition-owned policy.  A
 * producer supplies only its typed facts; this Definition selects a semantic
 * disposition, and the shared reducer remains the sole plan authority.
 */
export class NonGateStepDefinition {
  constructor({ stepId, factsType, select } = {}) {
    this.stepId = requireString(stepId, "non-Gate Step Definition stepId");
    if (typeof factsType !== "function" || !(factsType.prototype instanceof NonGateStepFacts)) {
      throw new Error("non-Gate Step Definition factsType must extend NonGateStepFacts");
    }
    if (typeof select !== "function") throw new Error("non-Gate Step Definition select must be a function");
    this.factsType = factsType;
    this.select = select;
    Object.freeze(this);
  }

  selectionFor(facts) {
    if (!(facts instanceof NonGateTransitionFacts) || facts.stepId !== this.stepId) {
      throw new Error("non-Gate Step Definition does not own these facts");
    }
    if (!(facts.stepFacts instanceof this.factsType)) {
      throw new Error("non-Gate Step Definition received incompatible typed Step facts");
    }
    const selection = this.select(facts.stepFacts, facts);
    if (!(selection instanceof NonGateTransitionSelection)) {
      throw new Error("non-Gate Step Definition must return NonGateTransitionSelection");
    }
    return selection;
  }
}

/**
 * Final regression owns its meaning here.  The runner supplies observations
 * and the registry applies this sealed result; neither is permitted to turn
 * a failure category into an independent route.
 */
function selectFinalRegressionTransition(stepFacts, facts = null) {
  if (!(stepFacts instanceof FinalRegressionStepFacts)) {
    throw new Error("final-regression Definition requires FinalRegressionStepFacts");
  }
  if (!stepFacts.changedFileSnapshot.current) {
    return new NonGateTransitionSelection({ operation: "blocked", reason: "stale_changed_file_snapshot" });
  }
  if (facts !== null && (
    stepFacts.retryHistory.used !== facts.retry.used
    || stepFacts.retryHistory.maximum !== facts.retry.maximum
  )) {
    return new NonGateTransitionSelection({ operation: "blocked", reason: "retry_history_mismatch" });
  }
  if (stepFacts.result === "pass" || stepFacts.result === "skipped") {
    return new NonGateTransitionSelection({ operation: "advance" });
  }
  if (stepFacts.recordAndProceed.accepted) {
    return new NonGateTransitionSelection({ operation: "record-and-proceed" });
  }
  if (stepFacts.failure.tooling) {
    return new NonGateTransitionSelection({
      operation: "external-blocked",
      reason: stepFacts.failure.kind || "tooling_failure",
      beforeActions: finalRegressionFailureActions(stepFacts),
    });
  }
  if (stepFacts.failure.currentChange) {
    if (stepFacts.retryHistory.exhausted) {
      return new NonGateTransitionSelection({
        operation: "await-user-input",
        reason: "retry_exhausted",
        beforeActions: finalRegressionFailureActions(stepFacts),
        userActions: [new NonGateUserActionSelection({ actionId: FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID })],
      });
    }
    return new NonGateTransitionSelection({
      operation: "repair",
      beforeActions: finalRegressionFailureActions(stepFacts, { retryable: true }),
    });
  }
  if (stepFacts.failure.existing) {
    return new NonGateTransitionSelection({
      operation: "await-user-input",
      beforeActions: finalRegressionFailureActions(stepFacts),
      userActions: [new NonGateUserActionSelection({ actionId: FINAL_REGRESSION_RECORD_AND_PROCEED_ACTION_ID })],
    });
  }
  return new NonGateTransitionSelection({
    operation: "blocked",
    reason: stepFacts.retryHistory.exhausted ? "retry_exhausted" : "unclassified_failure",
    beforeActions: finalRegressionFailureActions(stepFacts),
  });
}

/** The producer records the failure profile; Definition owns its settlement. */
function finalRegressionFailureAction(stepFacts, { retryable = false } = {}) {
  return new NonGateFailCurrentAttemptAction(NON_GATE_TRANSITION_TOKEN, {
    category: stepFacts.failure.category || "unknown",
    code: "FINAL_REGRESSION_FAILED",
    retryable,
    retryKind: retryable ? "semantic" : null,
    message: `final-regression failed (${stepFacts.failure.kind || "unknown"})`,
  });
}

function finalRegressionFailureActions(stepFacts, options = {}) {
  return stepFacts.failureRecorded ? [] : [finalRegressionFailureAction(stepFacts, options)];
}

export const FINAL_REGRESSION_STEP_DEFINITION = new NonGateStepDefinition({
  stepId: "final-regression",
  factsType: FinalRegressionStepFacts,
  select: selectFinalRegressionTransition,
});

/** Stable Action identity; it intentionally contains no clock or caller data. */
export class NonGateActionIdentity {
  constructor(token, { runId, specId, stepId, attempt, catalogFingerprint, factsFingerprint, selectedFingerprint, operation } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate Action identities are created only by the definition resolver");
    }
    this.runId = requireString(runId, "non-Gate Action runId");
    this.specId = requireString(specId, "non-Gate Action specId");
    this.stepId = requireString(stepId, "non-Gate Action stepId");
    this.attempt = attempt instanceof NonGateAttemptIdentity ? attempt : new NonGateAttemptIdentity(attempt);
    this.catalogFingerprint = requireString(catalogFingerprint, "non-Gate Action catalog fingerprint");
    this.factsFingerprint = requireString(factsFingerprint, "non-Gate Action facts fingerprint");
    this.selectedFingerprint = requireString(selectedFingerprint, "non-Gate Action selected fingerprint");
    this.operation = requireString(operation, "non-Gate Action operation");
    if (!NON_GATE_OPERATIONS.has(this.operation)) throw new Error("non-Gate Action operation is invalid");
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof NonGateActionIdentity
      && this.runId === other.runId
      && this.specId === other.specId
      && this.stepId === other.stepId
      && this.attempt.matches(other.attempt)
      && this.catalogFingerprint === other.catalogFingerprint
      && this.factsFingerprint === other.factsFingerprint
      && this.selectedFingerprint === other.selectedFingerprint
      && this.operation === other.operation;
  }

  toJSON() {
    return {
      runId: this.runId, specId: this.specId, stepId: this.stepId,
      attempt: this.attempt.toJSON(), catalogFingerprint: this.catalogFingerprint,
      factsFingerprint: this.factsFingerprint, operation: this.operation,
      selectedFingerprint: this.selectedFingerprint,
    };
  }
}

/** Stable identity for one Definition-selected guarded operator choice. */
export class NonGateUserActionIdentity {
  constructor(token, { transition, actionId } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(transition instanceof NonGateActionIdentity)) {
      throw new Error("non-Gate user Action identities are created only by the definition resolver");
    }
    this.transition = transition;
    this.actionId = requireString(actionId, "non-Gate user Action id");
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(this.actionId)) {
      throw new Error("non-Gate user Action id is invalid");
    }
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof NonGateUserActionIdentity
      && this.actionId === other.actionId
      && this.transition.matches(other.transition);
  }

  toJSON() { return { transition: this.transition.toJSON(), actionId: this.actionId }; }
}

export class NonGateTransitionAction {
  constructor(token, { identity } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(identity instanceof NonGateActionIdentity)) {
      throw new Error("non-Gate Actions are created only by the definition resolver");
    }
    this.identity = identity;
    Object.freeze(this);
  }

  toJSON() { return { identity: this.identity.toJSON() }; }
}

/** A guarded user action bound to the same immutable transition identity. */
export class NonGateUserAction {
  constructor(token, { identity } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(identity instanceof NonGateUserActionIdentity)) {
      throw new Error("non-Gate user Actions are created only by the definition resolver");
    }
    this.identity = identity;
    this.actionId = identity.actionId;
    Object.freeze(this);
  }

  toJSON() { return { identity: this.identity.toJSON() }; }
}

export class NonGateStepUpdate {
  constructor({ stepId, status } = {}) {
    this.stepId = requireString(stepId, "non-Gate step update stepId");
    this.status = requireString(status, "non-Gate step update status");
    if (!["in_progress", "done"].includes(this.status)) throw new Error("non-Gate step update status is invalid");
    Object.freeze(this);
  }

  toJSON() { return { stepId: this.stepId, status: this.status }; }
}

/** Typed plan effect; adapters apply it but cannot replace it with a route. */
export class NonGateSetStepStatusAction extends NonGateStepAction {
  constructor(token, { update } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN || !(update instanceof NonGateStepUpdate)) throw new Error("non-Gate status action requires a definition update");
    this.update = update;
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.setStepStatus(this.update, plan); }
  toJSON() { return { action: "set-step-status", update: this.update.toJSON() }; }
}

export class NonGateIncrementRetryAction extends NonGateStepAction {
  constructor(token, { stepId } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate retry action requires the definition resolver");
    this.stepId = requireString(stepId, "non-Gate retry action stepId");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.incrementRetry(this.stepId, plan); }
  toJSON() { return { action: "increment-retry", stepId: this.stepId }; }
}

/** Definition-selected settlement; the registry adapter cannot invent it. */
export class NonGateFailCurrentAttemptAction extends NonGateStepAction {
  constructor(token, { category, code, retryable, retryKind = null, message } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate failure action requires the definition resolver");
    this.category = requireString(category, "non-Gate failure category");
    this.code = requireString(code, "non-Gate failure code");
    if (typeof retryable !== "boolean") throw new Error("non-Gate failure retryable must be boolean");
    this.retryable = retryable;
    this.retryKind = retryKind == null ? null : requireString(retryKind, "non-Gate failure retry kind");
    this.message = requireString(message, "non-Gate failure message");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.failCurrentAttempt(this, plan); }
  toJSON() {
    return { action: "fail-current-attempt", category: this.category, code: this.code,
      retryable: this.retryable, retryKind: this.retryKind, message: this.message };
  }
}

/** Definition-selected advisory observation, applied while its Attempt is active. */
export class NonGateRecordNonblockingAction extends NonGateStepAction {
  constructor(token, { stepId } = {}) {
    super();
    if (token !== NON_GATE_TRANSITION_TOKEN) throw new Error("non-Gate nonblocking action requires the definition resolver");
    this.stepId = requireString(stepId, "non-Gate nonblocking stepId");
    Object.freeze(this);
  }
  apply(adapter, plan) { return adapter.recordNonblocking(this.stepId, plan); }
  toJSON() { return { action: "record-nonblocking", stepId: this.stepId }; }
}

/** Sealed typed authority consumed by persistence and command admission only. */
export class NonGateTransitionPlan {
  constructor(token, { action, actions, userActions = [] } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate transition plans are created only by the definition resolver");
    }
    if (!(action instanceof NonGateTransitionAction)) throw new Error("non-Gate plan requires a typed Action");
    if (!Array.isArray(actions) || actions.some((entry) => !(entry instanceof NonGateStepAction))) {
      throw new Error("non-Gate plan requires typed actions");
    }
    if (!Array.isArray(userActions) || userActions.some((entry) => !(entry instanceof NonGateUserAction))) {
      throw new Error("non-Gate plan requires typed user actions");
    }
    if (new Set(userActions.map((entry) => entry.actionId)).size !== userActions.length) {
      throw new Error("non-Gate plan user actions must be unique");
    }
    this.action = action;
    this.actions = Object.freeze([...actions]);
    this.userActions = Object.freeze([...userActions]);
    Object.freeze(this);
  }

  userActionFor(actionId) {
    const id = requireString(actionId, "non-Gate user Action lookup id");
    return this.userActions.find((action) => action.actionId === id) ?? null;
  }

  toJSON() {
    return {
      action: this.action.toJSON(), actions: this.actions.map((entry) => entry.toJSON()),
      userActions: this.userActions.map((entry) => entry.toJSON()),
    };
  }
}

export class NonGateTransitionDecision {
  constructor(token, { facts, disposition, plan } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN) {
      throw new Error("non-Gate transition decisions are created only by the definition resolver");
    }
    if (!(facts instanceof NonGateTransitionFacts)) throw new Error("non-Gate decision requires typed facts");
    if (!(disposition instanceof NonGateTransitionDisposition)) throw new Error("non-Gate decision requires typed disposition");
    if (!(plan instanceof NonGateTransitionPlan)) throw new Error("non-Gate decision requires typed plan");
    if (plan.action.identity.operation !== disposition.operation) throw new Error("non-Gate plan Action does not match disposition");
    this.facts = facts;
    this.disposition = disposition;
    this.plan = plan;
    Object.freeze(this);
  }

  toJSON() { return { facts: this.facts.toJSON(), disposition: this.disposition.toJSON(), plan: this.plan.toJSON() }; }
}

/**
 * Stable identity of the strict recovery facts that authorized a non-Gate
 * advisory. Version revision and the enabled policy bit describe the
 * transaction carrying the selection, not the selection itself.
 */
class NonGateNonblockingSelectionIdentity {
  constructor(token, { decision, resultKind } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(decision instanceof NonGateTransitionDecision)) {
      throw new Error("non-Gate nonblocking selection identity requires a Definition decision");
    }
    if (!["quality", "tooling", "unavailable"].includes(resultKind)) {
      throw new Error("non-Gate nonblocking selection identity result kind is invalid");
    }
    this.decision = decision;
    this.resultKind = resultKind;
    Object.freeze(this);
  }

  toJSON() {
    const {
      snapshotRevision: _snapshotRevision,
      nonblocking: _nonblocking,
      ...recoveryFacts
    } = this.decision.facts.toJSON();
    if (recoveryFacts.stepFacts?.values !== undefined) {
      const { catalogDigest: _catalogDigest, nonblocking: _stepPolicy, ...stepValues } = recoveryFacts.stepFacts.values;
      recoveryFacts.stepFacts = { ...recoveryFacts.stepFacts, values: stepValues };
    }
    const route = nonblockingRouteFor(this.decision.facts.stepId);
    return {
      disposition: this.decision.disposition.toJSON(),
      recoveryFacts,
      resultKind: this.resultKind,
      actions: this.decision.plan.actions.map((action) => action.toJSON()),
      userActions: this.decision.plan.userActions.map((action) => action.actionId),
      continuation: {
        targetStepId: route.targetStep,
        skippedStepIds: route.skippedSteps,
      },
    };
  }
}

/** Retrieve only a user action sealed into the selected Definition plan. */
export function selectedNonGateUserAction(decision, actionId) {
  if (!(decision instanceof NonGateTransitionDecision)) {
    throw new Error("non-Gate user action requires a Definition decision");
  }
  const action = decision.plan.userActionFor(actionId);
  if (action === null) {
    throw new Error("Definition does not select the requested non-Gate user action");
  }
  if (!action.identity.transition.matches(decision.plan.action.identity)) {
    throw new Error("non-Gate user action does not match the selected Definition Action");
  }
  return action;
}

function nonGatePlan(facts, disposition, { status = "in_progress", incrementRetry = false, beforeActions = [], stepActions = [], userActions = [], noEffects = false } = {}) {
  if (noEffects) {
    const identity = new NonGateActionIdentity(NON_GATE_TRANSITION_TOKEN, {
      runId: facts.runId, specId: facts.specId, stepId: facts.stepId, attempt: facts.currentAttempt,
      catalogFingerprint: facts.catalogPublication.fingerprint, factsFingerprint: nonGateFactsFingerprint(facts),
      selectedFingerprint: createHash("sha256").update(stableJson({ disposition: disposition.toJSON(), actions: [], userActions: userActions.map((entry) => entry.toJSON()) })).digest("hex"),
      operation: disposition.operation,
    });
    return new NonGateTransitionPlan(NON_GATE_TRANSITION_TOKEN, {
      action: new NonGateTransitionAction(NON_GATE_TRANSITION_TOKEN, { identity }), actions: [],
      userActions: userActions.map((entry) => new NonGateUserAction(NON_GATE_TRANSITION_TOKEN, {
        identity: new NonGateUserActionIdentity(NON_GATE_TRANSITION_TOKEN, { transition: identity, actionId: entry.actionId }),
      })),
    });
  }
  const update = new NonGateStepUpdate({ stepId: facts.stepId, status });
  const actions = [
    ...beforeActions,
    new NonGateSetStepStatusAction(NON_GATE_TRANSITION_TOKEN, { update }),
    ...(incrementRetry ? [new NonGateIncrementRetryAction(NON_GATE_TRANSITION_TOKEN, { stepId: facts.stepId })] : []),
    ...stepActions,
  ];
  const identity = new NonGateActionIdentity(NON_GATE_TRANSITION_TOKEN, {
    runId: facts.runId,
    specId: facts.specId,
    stepId: facts.stepId,
    attempt: facts.currentAttempt,
    catalogFingerprint: facts.catalogPublication.fingerprint,
    factsFingerprint: nonGateFactsFingerprint(facts),
    selectedFingerprint: createHash("sha256").update(stableJson({ disposition: disposition.toJSON(), actions: actions.map((entry) => entry.toJSON()), userActions: userActions.map((entry) => entry.toJSON()) })).digest("hex"),
    operation: disposition.operation,
  });
  return new NonGateTransitionPlan(NON_GATE_TRANSITION_TOKEN, {
    action: new NonGateTransitionAction(NON_GATE_TRANSITION_TOKEN, { identity }),
    actions,
    userActions: userActions.map((entry) => new NonGateUserAction(NON_GATE_TRANSITION_TOKEN, {
      identity: new NonGateUserActionIdentity(NON_GATE_TRANSITION_TOKEN, { transition: identity, actionId: entry.actionId }),
    })),
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonGateFactsFingerprint(facts) {
  return createHash("sha256").update(stableJson(facts.toJSON())).digest("hex");
}

function nonGateDecision(facts, disposition, options) {
  return new NonGateTransitionDecision(NON_GATE_TRANSITION_TOKEN, {
    facts,
    disposition,
    plan: nonGatePlan(facts, disposition, options),
  });
}

/** Deterministic, phase-neutral reducer for all non-Gate Step facts. */
export function resolveNonGateTransition(facts, stepDefinition) {
  if (!(facts instanceof NonGateTransitionFacts)) {
    throw new Error("resolveNonGateTransition requires NonGateTransitionFacts");
  }
  if (!(stepDefinition instanceof NonGateStepDefinition)) {
    throw new Error("resolveNonGateTransition requires a typed Step Definition");
  }
  if (facts.integrityFailure !== null) {
    return nonGateDecision(facts, new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, facts.integrityFailure), { noEffects: true });
  }
  if (facts.completion.partial) {
    return nonGateDecision(facts, new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, "partial_completion"), { noEffects: true });
  }
  const selection = stepDefinition.selectionFor(facts);
  const selectedDecision = (disposition, options = {}) => {
    const strictDecision = nonGateDecision(facts, disposition, {
      ...options,
      beforeActions: options.beforeActions ?? selection.beforeActions,
      stepActions: options.stepActions ?? selection.actions,
      userActions: options.userActions ?? selection.userActions,
    });
    const eligibility = nonGateNonblockingEligibilityForDecision(strictDecision);
    if (!facts.nonblocking || eligibility === null) return strictDecision;
    return nonGateDecision(facts, new NonGateAwaitUserInputDisposition(
      NON_GATE_TRANSITION_TOKEN,
      eligibility.blocker,
    ), {
      beforeActions: [new NonGateRecordNonblockingAction(NON_GATE_TRANSITION_TOKEN, { stepId: facts.stepId })],
    });
  };
  if (selection.operation === "advance") {
    if (!facts.completion.completed) return selectedDecision(new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, "completion_unconfirmed"));
    return selectedDecision(new NonGateAdvanceDisposition(NON_GATE_TRANSITION_TOKEN), { status: "done" });
  }
  if (selection.operation === "keep-in-progress") return selectedDecision(new NonGateKeepInProgressDisposition(NON_GATE_TRANSITION_TOKEN));
  if (selection.operation === "await-user-input") return selectedDecision(new NonGateAwaitUserInputDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason));
  if (selection.operation === "retry") {
    if (facts.retry.exhausted) return selectedDecision(new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, "retry_exhausted"), {
      stepActions: selection.exhaustedActions,
    });
    return selectedDecision(new NonGateRetryDisposition(NON_GATE_TRANSITION_TOKEN), { incrementRetry: true });
  }
  if (selection.operation === "repair") return selectedDecision(new NonGateRepairDisposition(NON_GATE_TRANSITION_TOKEN));
  if (selection.operation === "record-and-proceed") {
    return selectedDecision(new NonGateRecordAndProceedDisposition(NON_GATE_TRANSITION_TOKEN), { status: "done" });
  }
  if (selection.operation === "external-blocked") {
    return selectedDecision(new NonGateExternalBlockedDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason || "external_blocked"));
  }
  if (selection.operation === "park") {
    return selectedDecision(new NonGateParkDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason), { status: "done" });
  }
  return selectedDecision(new NonGateBlockedDisposition(NON_GATE_TRANSITION_TOKEN, selection.reason || "blocked"));
}

export function nonGateNonblockingEligibilityForDecision(decision) {
  if (!(decision instanceof NonGateTransitionDecision)) {
    throw new Error("non-Gate nonblocking eligibility requires a Definition decision");
  }
  if (decision.facts.integrityFailure !== null || decision.facts.completion.partial) return null;
  if (!["external-blocked", "blocked"].includes(decision.disposition.operation)) return null;
  const sourceStep = decision.facts.stepId;
  if (sourceStep === "final-regression"
    && ["stale_changed_file_snapshot", "retry_history_mismatch"].includes(decision.disposition.reason)) {
    return null;
  }
  if (nonblockingRouteFor(sourceStep) === null) return null;
  const resultKind = NonblockingFailureClassification.fromStepFacts(
    sourceStep,
    decision.facts.stepFacts,
  ).resultKind;
  return new DefinitionNonblockingEligibility(NONBLOCKING_ELIGIBILITY_TOKEN, {
    sourceStep,
    resultKind,
    blocker: decision.disposition.reason || "Strict recovery is exhausted or unavailable.",
    selection: new NonGateNonblockingSelectionIdentity(NON_GATE_TRANSITION_TOKEN, {
      decision,
      resultKind,
    }),
  });
}

function requireDigest(value, field) {
  const digest = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

/** One immutable catalog input consumed by the retro stale-evidence route. */
export class RetroStaleEvidencePublication {
  constructor({ logicalKey, relativePath, hash, activityId } = {}) {
    this.logicalKey = requireString(logicalKey, "retro stale evidence logicalKey");
    if (!new Set(["test.execute", "test.result.review"]).has(this.logicalKey)) {
      throw new Error("retro stale evidence logicalKey is invalid");
    }
    this.relativePath = requireString(relativePath, "retro stale evidence relativePath");
    this.hash = requireDigest(hash, "retro stale evidence hash");
    this.activityId = requireString(activityId, "retro stale evidence activityId");
    Object.freeze(this);
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      hash: this.hash,
      activityId: this.activityId,
    };
  }
}

/** Canonical facts for the fixed retro -> test-execute stale-evidence recovery. */
export class RetroStaleEvidenceRecoveryFacts {
  constructor({ runId, specId, stepId, attemptId, sequence, snapshotRevision, publications, artifactNames, previousFingerprint, currentFingerprint } = {}) {
    this.runId = requireString(runId, "retro stale evidence runId");
    this.specId = requireString(specId, "retro stale evidence specId");
    this.stepId = requireString(stepId, "retro stale evidence stepId");
    if (this.stepId !== "retro") throw new Error("retro stale evidence facts require the retro Step");
    this.attemptId = requireString(attemptId, "retro stale evidence Attempt id");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("retro stale evidence Attempt sequence is invalid");
    this.sequence = sequence;
    this.snapshotRevision = requireString(snapshotRevision, "retro stale evidence snapshot revision");
    if (!Array.isArray(publications) || publications.length !== 2) {
      throw new Error("retro stale evidence facts require exactly two catalog publications");
    }
    this.publications = Object.freeze(publications.map((entry) => (
      entry instanceof RetroStaleEvidencePublication ? entry : new RetroStaleEvidencePublication(entry)
    )).sort((left, right) => left.logicalKey.localeCompare(right.logicalKey)));
    if (new Set(this.publications.map((entry) => entry.logicalKey)).size !== this.publications.length) {
      throw new Error("retro stale evidence catalog publications must be unique");
    }
    if (!Array.isArray(artifactNames) || artifactNames.length === 0
      || artifactNames.some((entry) => typeof entry !== "string" || entry === "")) {
      throw new Error("retro stale evidence artifact names are required");
    }
    this.artifactNames = Object.freeze([...new Set(artifactNames)].sort());
    this.previousFingerprint = requireDigest(previousFingerprint, "retro stale evidence previous fingerprint");
    this.currentFingerprint = requireDigest(currentFingerprint, "retro stale evidence current fingerprint");
    if (this.previousFingerprint === this.currentFingerprint) {
      throw new Error("retro stale evidence recovery requires mismatched fingerprints");
    }
    this.catalogFingerprint = createHash("sha256").update(stableJson(this.publications.map((entry) => entry.toJSON()))).digest("hex");
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      snapshotRevision: this.snapshotRevision,
      publications: this.publications.map((entry) => entry.toJSON()),
      artifactNames: [...this.artifactNames],
      previousFingerprint: this.previousFingerprint,
      currentFingerprint: this.currentFingerprint,
      catalogFingerprint: this.catalogFingerprint,
    };
  }
}

export class RetroStaleEvidenceRecoveryEffect {
  constructor({ operation = "rewind-test-evidence", sourceStepId = "retro", targetStepId = "test-execute" } = {}) {
    this.operation = requireString(operation, "retro stale evidence recovery operation");
    this.sourceStepId = requireString(sourceStepId, "retro stale evidence recovery source Step");
    this.targetStepId = requireString(targetStepId, "retro stale evidence recovery target Step");
    if (this.operation !== "rewind-test-evidence" || this.sourceStepId !== "retro" || this.targetStepId !== "test-execute") {
      throw new Error("retro stale evidence recovery effect is invalid");
    }
    Object.freeze(this);
  }

  toJSON() { return { operation: this.operation, sourceStepId: this.sourceStepId, targetStepId: this.targetStepId }; }
}

export class RetroStaleEvidenceRecoveryActionIdentity {
  constructor(token, { facts, effect } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(facts instanceof RetroStaleEvidenceRecoveryFacts)
      || !(effect instanceof RetroStaleEvidenceRecoveryEffect)) {
      throw new Error("retro stale evidence recovery Action identity requires Definition facts and effect");
    }
    this.runId = facts.runId;
    this.specId = facts.specId;
    this.stepId = facts.stepId;
    this.attemptId = facts.attemptId;
    this.sequence = facts.sequence;
    this.snapshotRevision = facts.snapshotRevision;
    this.catalogFingerprint = facts.catalogFingerprint;
    this.factsFingerprint = createHash("sha256").update(stableJson(facts.toJSON())).digest("hex");
    this.selectedFingerprint = createHash("sha256").update(stableJson(effect.toJSON())).digest("hex");
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      snapshotRevision: this.snapshotRevision,
      catalogFingerprint: this.catalogFingerprint,
      factsFingerprint: this.factsFingerprint,
      selectedFingerprint: this.selectedFingerprint,
    };
  }
}

export class RetroStaleEvidenceRecoveryPlan {
  constructor(token, { facts, effect } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(facts instanceof RetroStaleEvidenceRecoveryFacts)
      || !(effect instanceof RetroStaleEvidenceRecoveryEffect)) {
      throw new Error("retro stale evidence recovery plan requires Definition facts and effect");
    }
    this.effect = effect;
    this.action = new RetroStaleEvidenceRecoveryActionIdentity(token, { facts, effect });
    Object.freeze(this);
  }

  toJSON() { return { effect: this.effect.toJSON(), action: this.action.toJSON() }; }
}

/** Sealed non-Gate recovery plan: retro only reports stale facts; Definition selects the rewind. */
export class RetroStaleEvidenceRecoveryDecision {
  constructor(token, { facts, plan } = {}) {
    if (token !== NON_GATE_TRANSITION_TOKEN || !(facts instanceof RetroStaleEvidenceRecoveryFacts)
      || !(plan instanceof RetroStaleEvidenceRecoveryPlan)) {
      throw new Error("retro stale evidence recovery decision requires a Definition plan");
    }
    this.facts = facts;
    this.plan = plan;
    Object.freeze(this);
  }

  toJSON() { return { facts: this.facts.toJSON(), plan: this.plan.toJSON() }; }
}

/** The sole selector for stale retro evidence; execution code cannot choose a rewind route. */
export function resolveRetroStaleEvidenceRecovery(facts) {
  if (!(facts instanceof RetroStaleEvidenceRecoveryFacts)) {
    throw new Error("resolveRetroStaleEvidenceRecovery requires typed retro stale evidence facts");
  }
  const effect = new RetroStaleEvidenceRecoveryEffect();
  return new RetroStaleEvidenceRecoveryDecision(NON_GATE_TRANSITION_TOKEN, {
    facts,
    plan: new RetroStaleEvidenceRecoveryPlan(NON_GATE_TRANSITION_TOKEN, { facts, effect }),
  });
}

// Approval and acceptance are deliberately not expressed as generic worker
// completion.  Their evidence is either a cataloged Spec publication or a
// canonical review/decision artifact, and their next route must remain owned
// by Definition even though the corresponding commands are setters.
const DEFINITION_ROUTE_TOKEN = Symbol("definition-route");

function digestText(value, field) {
  const text = requireString(value, field);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`${field} must be a SHA-256 digest`);
  return text;
}

function frozenStrings(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze([...value]);
}

/** A target is never inferred from the caller; it is bound to the active Attempt. */
export class DefinitionRouteTarget {
  constructor({ runId, specId, stepId, attemptId, sequence } = {}) {
    this.runId = requireString(runId, "definition route target runId");
    this.specId = requireString(specId, "definition route target specId");
    this.stepId = requireString(stepId, "definition route target stepId");
    this.attemptId = requireString(attemptId, "definition route target attemptId");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("definition route target sequence must be positive");
    this.sequence = sequence;
    Object.freeze(this);
  }

  toJSON() { return { runId: this.runId, specId: this.specId, stepId: this.stepId, attemptId: this.attemptId, sequence: this.sequence }; }
}

export class ApprovalRouteFacts {
  constructor({ target, specPublicationDigest, approvalRecord = null, requestedApproval = false, autoApprove = false } = {}) {
    this.target = target instanceof DefinitionRouteTarget ? target : new DefinitionRouteTarget(target);
    if (this.target.stepId !== "approval") throw new Error("approval facts require the approval target");
    this.specPublicationDigest = digestText(specPublicationDigest, "approval spec publication digest");
    if (approvalRecord !== null && (approvalRecord?.approved !== true || typeof approvalRecord.confirmed_at !== "string")) {
      throw new Error("approval record must be a canonical approved record");
    }
    if (typeof requestedApproval !== "boolean" || typeof autoApprove !== "boolean") throw new Error("approval route flags must be boolean");
    this.approvalRecord = approvalRecord === null ? null : Object.freeze(structuredClone(approvalRecord));
    this.requestedApproval = requestedApproval;
    this.autoApprove = autoApprove;
    Object.freeze(this);
  }

  get integrityFailure() {
    if (this.approvalRecord !== null && this.requestedApproval) return "approval_already_recorded";
    return null;
  }

  toJSON() { return { target: this.target.toJSON(), specPublicationDigest: this.specPublicationDigest, approvalRecord: this.approvalRecord, requestedApproval: this.requestedApproval, autoApprove: this.autoApprove }; }
}

export class AcceptanceReviewRouteFacts {
  constructor({ target, reviewArtifactDigest, requirementIds, findingDispositions, verdict, completed = true } = {}) {
    this.target = target instanceof DefinitionRouteTarget ? target : new DefinitionRouteTarget(target);
    if (this.target.stepId !== "acceptance-review") throw new Error("acceptance review facts require the acceptance-review target");
    this.reviewArtifactDigest = digestText(reviewArtifactDigest, "acceptance review artifact digest");
    this.requirementIds = frozenStrings(requirementIds, "acceptance requirement IDs");
    this.findingDispositions = frozenStrings(findingDispositions, "acceptance finding dispositions");
    this.verdict = requireString(verdict, "acceptance review verdict");
    if (!["pass", "repair_required", "user_decision_required", "blocked"].includes(this.verdict)) throw new Error("acceptance review verdict is invalid");
    if (typeof completed !== "boolean") throw new Error("acceptance review completed must be boolean");
    this.completed = completed;
    Object.freeze(this);
  }

  toJSON() { return { target: this.target.toJSON(), reviewArtifactDigest: this.reviewArtifactDigest, requirementIds: [...this.requirementIds], findingDispositions: [...this.findingDispositions], verdict: this.verdict, completed: this.completed }; }
}

export class AcceptanceDecisionRouteFacts {
  constructor({ target, reviewArtifactDigest, requirementIds, findingDispositions, decisionRecord = null, choice = null } = {}) {
    this.target = target instanceof DefinitionRouteTarget ? target : new DefinitionRouteTarget(target);
    if (this.target.stepId !== "acceptance-decision") throw new Error("acceptance decision facts require the acceptance-decision target");
    this.reviewArtifactDigest = digestText(reviewArtifactDigest, "acceptance decision review digest");
    this.requirementIds = frozenStrings(requirementIds, "acceptance decision requirement IDs");
    this.findingDispositions = frozenStrings(findingDispositions, "acceptance decision finding dispositions");
    if (choice !== null && !["accept_risk_and_continue", "abort"].includes(choice)) throw new Error("acceptance decision choice is invalid");
    if (decisionRecord !== null && (decisionRecord?.choice !== choice || decisionRecord?.reviewArtifactDigest !== this.reviewArtifactDigest)) {
      throw new Error("acceptance decision record is not bound to canonical review evidence");
    }
    this.choice = choice;
    this.decisionRecord = decisionRecord === null ? null : Object.freeze(structuredClone(decisionRecord));
    Object.freeze(this);
  }

  get integrityFailure() {
    if (this.choice === null && this.decisionRecord !== null) return "decision_record_without_choice";
    return null;
  }

  toJSON() { return { target: this.target.toJSON(), reviewArtifactDigest: this.reviewArtifactDigest, requirementIds: [...this.requirementIds], findingDispositions: [...this.findingDispositions], decisionRecord: this.decisionRecord, choice: this.choice }; }
}

export class DefinitionRoutePlan {
  constructor(token, { facts, route, reason = null } = {}) {
    if (token !== DEFINITION_ROUTE_TOKEN) throw new Error("Definition route plans are created only by the Definition resolver");
    this.facts = facts;
    this.route = requireString(route, "definition route");
    this.reason = reason === null ? null : requireString(reason, "definition blocked reason");
    Object.freeze(this);
  }
  toJSON() { return { route: this.route, facts: this.facts.toJSON(), ...(this.reason === null ? {} : { reason: this.reason }) }; }
}

export class AwaitApproval extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "await-approval" }); } apply(adapter) { return adapter.awaitApproval(this); } }
export class ConfirmAndAdvance extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "confirm-and-advance" }); } apply(adapter) { return adapter.confirmAndAdvance(this); } }
export class RepairAcceptanceToImplTriage extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "repair-acceptance-to-impl-triage" }); } apply(adapter) { return adapter.repairAcceptanceToImplTriage(this); } }
export class AwaitAcceptanceDecision extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "await-acceptance-decision" }); } apply(adapter) { return adapter.awaitAcceptanceDecision(this); } }
export class AdvanceFinalRegression extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "advance-final-regression" }); } apply(adapter) { return adapter.advanceFinalRegression(this); } }
export class Park extends DefinitionRoutePlan { constructor(token, facts) { super(token, { facts, route: "park" }); } apply(adapter) { return adapter.park(this); } }
export class Blocked extends DefinitionRoutePlan { constructor(token, facts, reason) { super(token, { facts, route: "blocked", reason }); } apply(adapter) { return adapter.blocked(this); } }

/**
 * Sole policy owner for the approval / acceptance boundary.  Setters and
 * registry post hooks may construct facts and apply this plan, but may not
 * branch on verdict, choice, or auto policy.
 */
export function resolveDefinitionRoute(facts) {
  if (facts instanceof ApprovalRouteFacts) {
    if (facts.integrityFailure !== null) return new Blocked(DEFINITION_ROUTE_TOKEN, facts, facts.integrityFailure);
    if (facts.approvalRecord !== null) return new ConfirmAndAdvance(DEFINITION_ROUTE_TOKEN, facts);
    // autoApprove is an approval policy fact; it never authorizes an
    // acceptance decision and never bypasses a stale/missing Spec binding.
    return facts.requestedApproval || facts.autoApprove
      ? new ConfirmAndAdvance(DEFINITION_ROUTE_TOKEN, facts)
      : new AwaitApproval(DEFINITION_ROUTE_TOKEN, facts);
  }
  if (facts instanceof AcceptanceReviewRouteFacts) {
    if (!facts.completed || facts.verdict === "blocked") return new Blocked(DEFINITION_ROUTE_TOKEN, facts, facts.completed ? "acceptance_blocked" : "partial_completion");
    if (facts.verdict === "repair_required") return new RepairAcceptanceToImplTriage(DEFINITION_ROUTE_TOKEN, facts);
    if (facts.verdict === "user_decision_required") return new AwaitAcceptanceDecision(DEFINITION_ROUTE_TOKEN, facts);
    return new AdvanceFinalRegression(DEFINITION_ROUTE_TOKEN, facts);
  }
  if (facts instanceof AcceptanceDecisionRouteFacts) {
    if (facts.integrityFailure !== null) return new Blocked(DEFINITION_ROUTE_TOKEN, facts, facts.integrityFailure);
    // This is intentionally tokenless and ignores autoApprove.
    if (facts.choice === null) return new AwaitAcceptanceDecision(DEFINITION_ROUTE_TOKEN, facts);
    return facts.choice === "accept_risk_and_continue"
      ? new AdvanceFinalRegression(DEFINITION_ROUTE_TOKEN, facts)
      : new Park(DEFINITION_ROUTE_TOKEN, facts);
  }
  throw new Error("Definition route facts are unsupported");
}

/**
 * The three test-chain leaves expose observations only.  Their route policy
 * is deliberately kept beside the common reducer so a registry hook cannot
 * reinterpret a result after it has been cataloged.
 */
export class TestChainProcessFacts {
  constructor({ started, exitCode, signal, timedOut, spawnError } = {}) {
    if (typeof started !== "boolean") throw new Error("test-chain process.started must be boolean");
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0)) {
      throw new Error("test-chain process.exitCode must be a non-negative integer or null");
    }
    if (signal !== null && (typeof signal !== "string" || signal === "")) throw new Error("test-chain process.signal must be a non-empty string or null");
    if (typeof timedOut !== "boolean") throw new Error("test-chain process.timedOut must be boolean");
    if (spawnError !== null && (typeof spawnError !== "string" || spawnError === "")) throw new Error("test-chain process.spawnError must be a non-empty string or null");
    this.started = started;
    this.exitCode = exitCode;
    this.signal = signal;
    this.timedOut = timedOut;
    this.spawnError = spawnError;
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof TestChainProcessFacts) return value;
    return new TestChainProcessFacts(value ?? { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null });
  }

  // A cataloged process record is an external observation. Incomplete
  // combinations cannot prove a semantic test outcome, so keep the Flow
  // externally blocked rather than allowing a producer to advance.
  get toolingFailure() {
    return !this.started
      || this.spawnError !== null
      || this.signal !== null
      || this.timedOut
      || this.exitCode === null;
  }
  toJSON() { return { started: this.started, exitCode: this.exitCode, signal: this.signal, timedOut: this.timedOut, spawnError: this.spawnError }; }
}

export class TestExecuteStepFacts extends NonGateStepFacts {
  constructor({ summary = [], regression = {}, rawAvailable = false, testSourceRevision = "unavailable", repairFingerprint = "unavailable", rawEvidenceFingerprint = "unavailable", catalogDigest = "unavailable", process = null } = {}) {
    if (!Array.isArray(summary) || regression === null || typeof regression !== "object" || Array.isArray(regression)) throw new Error("test-execute observations are invalid");
    if (typeof rawAvailable !== "boolean" || typeof testSourceRevision !== "string" || testSourceRevision === "" || typeof repairFingerprint !== "string" || repairFingerprint === "" || typeof rawEvidenceFingerprint !== "string" || rawEvidenceFingerprint === "" || typeof catalogDigest !== "string" || catalogDigest === "") {
      throw new Error("test-execute immutable evidence is required");
    }
    const processFacts = TestChainProcessFacts.from(process);
    const regressionProcess = regression.process == null ? null : TestChainProcessFacts.from(regression.process);
    super({ kind: "test-execute", values: { summary, regression, rawAvailable, testSourceRevision, repairFingerprint, rawEvidenceFingerprint, catalogDigest, process: processFacts.toJSON(), regressionProcess: regressionProcess?.toJSON() ?? null, toolingFailure: processFacts.toolingFailure || regressionProcess?.toolingFailure === true } });
  }

  get toolingFailure() { return this.value("toolingFailure"); }
  get rawAvailable() { return this.value("rawAvailable"); }
  get process() { return TestChainProcessFacts.from(this.value("process")); }
  get regressionProcess() { return this.value("regressionProcess") === null ? null : TestChainProcessFacts.from(this.value("regressionProcess")); }
}

export class TestResultReviewStepFacts extends NonGateStepFacts {
  constructor({ verdict, checkedItems = [], rawAvailable = false, testSourceRevision = "unavailable", sourceRepairFingerprint = "unavailable", sourceRawEvidenceFingerprint = "unavailable", repairFingerprint = "unavailable", rawEvidenceFingerprint = "unavailable", catalogDigest = "unavailable", toolingFailure = false } = {}) {
    if (!["pass", "fail"].includes(verdict)) throw new Error("test-result-review verdict is invalid");
    if (typeof toolingFailure !== "boolean") throw new Error("test-result-review toolingFailure must be boolean");
    if (!Array.isArray(checkedItems) || typeof rawAvailable !== "boolean") throw new Error("test-result-review observations are invalid");
    if (checkedItems.length === 0 || checkedItems.some((item) => item?.result !== "pass" && item?.result !== "fail")) {
      throw new Error("test-result-review requires pass/fail checked observations");
    }
    if ((verdict === "fail") !== checkedItems.some((item) => item.result === "fail")) {
      throw new Error("test-result-review verdict must match its checked observations");
    }
    for (const [value, field] of [[testSourceRevision, "test source revision"], [sourceRepairFingerprint, "source repair fingerprint"], [sourceRawEvidenceFingerprint, "source raw evidence fingerprint"], [repairFingerprint, "repair fingerprint"], [rawEvidenceFingerprint, "raw evidence fingerprint"], [catalogDigest, "catalog digest"]]) {
      if (typeof value !== "string" || value === "") throw new Error(`test-result-review ${field} is required`);
    }
    super({ kind: "test-result-review", values: { verdict, checkedItems, rawAvailable, testSourceRevision, sourceRepairFingerprint, sourceRawEvidenceFingerprint, repairFingerprint, rawEvidenceFingerprint, catalogDigest, toolingFailure } });
  }

  get verdict() { return this.value("verdict"); }
  get toolingFailure() { return this.value("toolingFailure"); }
  get rawAvailable() { return this.value("rawAvailable"); }
}

function failureAction({ category, code, retryable, retryKind = null, message }) {
  return new NonGateFailCurrentAttemptAction(NON_GATE_TRANSITION_TOKEN, { category, code, retryable, retryKind, message });
}

function testChainSelection({ stepId, failed, toolingFailure, nonblocking }) {
  if (toolingFailure) return new NonGateTransitionSelection({
    operation: "external-blocked",
    reason: "tooling_failure",
    actions: [failureAction({ category: "tooling", code: "TEST_CHAIN_TOOLING_FAILURE", retryable: false, message: "Test-chain tooling failed." })],
  });
  if (!failed) return new NonGateTransitionSelection({ operation: "advance" });
  if (nonblocking) return new NonGateTransitionSelection({
    // Advisory mode records the immutable observation, but its acceptance
    // disposition remains an explicit nonblocking decision.  It must not
    // complete the active producer or auto-advance the Flow.
    operation: "await-user-input",
    beforeActions: [new NonGateRecordNonblockingAction(NON_GATE_TRANSITION_TOKEN, { stepId })],
  });
  return new NonGateTransitionSelection({
    operation: "retry", reason: "semantic_test_failure",
    actions: [failureAction({ category: "semantic", code: "TEST_CHAIN_REJECTED", retryable: true, retryKind: "semantic", message: "Test-chain evidence was rejected." })],
    exhaustedActions: [failureAction({ category: "semantic", code: "TEST_CHAIN_RETRY_EXHAUSTED", retryable: false, message: "Test-chain semantic retry budget is exhausted." })],
  });
}

export const testExecuteTransitionDefinition = new NonGateStepDefinition({
  stepId: "test-execute",
  factsType: TestExecuteStepFacts,
  select(stepFacts) {
    // A completed execution always hands its immutable observation to the
    // result reviewer. Regression semantics are owned by that reviewer and
    // later gates, not by the executor.
    return testChainSelection({ stepId: "test-execute", failed: false, toolingFailure: stepFacts.toolingFailure, nonblocking: false });
  },
});

export const testResultReviewTransitionDefinition = new NonGateStepDefinition({
  stepId: "test-result-review",
  factsType: TestResultReviewStepFacts,
  select(stepFacts, facts) {
    return testChainSelection({
      stepId: "test-result-review",
      failed: stepFacts.verdict === "fail",
      toolingFailure: stepFacts.toolingFailure,
      nonblocking: false,
    });
  },
});

const STEP_STATUSES = new Set(["pending", "in_progress", "done", "skipped"]);

export class SetStepStatus {
  constructor({ step, status, suppressAutoPromotion = false, taskSourceFingerprint = null }) {
    this.step = requireString(step, "step");
    this.status = requireString(status, "status");
    if (!STEP_STATUSES.has(this.status)) throw new Error(`invalid status: ${this.status}`);
    if (typeof suppressAutoPromotion !== "boolean") {
      throw new Error("suppressAutoPromotion must be boolean");
    }
    this.suppressAutoPromotion = suppressAutoPromotion;
    if (taskSourceFingerprint !== null && (this.status !== "skipped" || !/^[a-f0-9]{64}$/.test(taskSourceFingerprint))) {
      throw new Error("Task source fingerprint is valid only for a skipped lifecycle action");
    }
    this.taskSourceFingerprint = taskSourceFingerprint;
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.setStepStatus(this.step, this.status, this);
  }

  forStep(step) {
    const scopedStep = requireString(step, "step");
    if (scopedStep === this.step) return this;
    return new SetStepStatus({
      step: scopedStep,
      status: this.status,
      suppressAutoPromotion: this.suppressAutoPromotion,
      taskSourceFingerprint: this.taskSourceFingerprint,
    });
  }
}

const DEFINITION_LIFECYCLE_PLAN_TOKEN = Symbol("definition-lifecycle-plan");

export class DefinitionLifecyclePlan {
  constructor(token, { event, currentStepId, actions }) {
    if (token !== DEFINITION_LIFECYCLE_PLAN_TOKEN) {
      throw new Error("DefinitionLifecyclePlan is created only by the definition resolver");
    }
    if (!Array.isArray(actions)) throw new Error("actions must be an array");
    const lifecycleActions = [...actions];
    const hasStepTransition = lifecycleActions.some((action) => action instanceof SetStepStatus);
    this.event = requireString(event, "event");
    this.currentStepId = currentStepId == null && !hasStepTransition
      ? null
      : requireString(currentStepId, "currentStepId");
    this.actions = Object.freeze(lifecycleActions);
    Object.freeze(this);
  }

  allows(action) {
    return this.actions.includes(action);
  }

  forStepAlias({ sourceStep, targetStep }) {
    const source = requireString(sourceStep, "sourceStep");
    const target = requireString(targetStep, "targetStep");
    if (source === target) return this;
    const actions = this.actions.map((action) => (
      action instanceof SetStepStatus && action.step === source
        ? action.forStep(target)
        : action
    ));
    const currentStepId = this.currentStepId === source ? target : this.currentStepId;
    if (currentStepId === this.currentStepId && actions.every((action, index) => action === this.actions[index])) {
      return this;
    }
    return new DefinitionLifecyclePlan(DEFINITION_LIFECYCLE_PLAN_TOKEN, {
      event: this.event,
      currentStepId,
      actions,
    });
  }
}

export class KeepInProgress {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.keepInProgress(this.step);
  }
}

export class IncrementMetric {
  constructor({ phase, counter }) {
    this.phase = requireString(phase, "phase");
    this.counter = requireString(counter, "counter");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.incrementMetric(this.phase, this.counter);
  }
}

/** Persist a non-terminal current Review result selected by definition lifecycle. */
export class PersistReviewResult {
  constructor() {
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.persistReviewResult();
  }
}

export class AppendIssueLog {
  constructor({ source }) {
    this.source = requireString(source, "source");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.appendIssueLog(this.source);
  }
}

export class SkipSteps {
  constructor({ steps }) {
    this.steps = requireStepList(steps, "steps");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.skipSteps([...this.steps]);
  }
}

export class ResetSteps {
  constructor({ steps }) {
    this.steps = requireStepList(steps, "steps");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.resetSteps([...this.steps]);
  }
}

export class RunLifecycleHook {
  constructor({ module, handler, args = null }) {
    this.module = requireString(module, "module");
    this.handler = requireString(handler, "handler");
    this.args = args == null ? null : Object.freeze({ ...args });
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.runLifecycleHook(this.module, this.handler, this.args);
  }
}

export class BeginOutboxEffect {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.beginOutboxEffect(this.step);
  }
}

export class CompleteOutboxEffect {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.completeOutboxEffect(this.step);
  }
}

export class FailOutboxEffect {
  constructor({ step }) {
    this.step = requireString(step, "step");
    Object.freeze(this);
  }

  apply(adapter) {
    return adapter.failOutboxEffect(this.step);
  }
}

export function applyLifecycleActions(adapter, actions) {
  for (const action of actions) action.apply(adapter);
}

const FINALIZE_SUCCESS_STATUSES = new Set(["done", "completed", "skipped"]);
const IMPL_REVIEW_RESET_RANGE = Object.freeze([
  "test-execute",
  "test-result-review",
  "impl-review",
  "impl-triage",
  "impl-repair",
  "impl-gate",
  "retro",
  "acceptance-review",
  "acceptance-decision",
  "final-regression",
  "report",
  "finalize-commit",
  "finalize-merge",
  "finalize-sync",
  "finalize-cleanup",
]);
const REJECTED_IMPL_REVIEW_RESET_STEPS = Object.freeze([
  "impl-repair",
  "impl-gate",
]);

export function countReviewAttempts(metrics, phase) {
  if (!Array.isArray(metrics)) return 0;
  let count = 0;
  for (const entry of metrics) {
    if (entry?.phase !== phase || entry?.counter !== "reviewRetry" || entry?.taskId != null) continue;
    count = entry.reset === true ? 0 : count + (entry.delta ?? 1);
  }
  return count;
}

/**
 * The definition owns the only policy that turns persisted review facts into
 * a recovery route. Readers may establish whether canonical evidence exists;
 * they must not choose between repair and an exhausted retry disposition.
 */
export function resolveReviewTransition({
  stepId,
  flowState,
  facts,
} = {}) {
  // Draft Reviews settle only through their concrete StepResult. They must
  // never enter the generic retry/defer/blocked Review policy.
  if (draftReviewRouteForStepId(stepId) !== null) return null;
  const phase = stepId === "task-review" ? "impl" : reviewPhaseForFlowStepId(stepId);
  if (phase === null || !(facts instanceof ReviewTransitionFacts)) return null;
  if (facts.phase !== phase) throw new Error("review transition facts phase does not match step");
  // The Spec funnel is deliberately not a semantic retry/recovery loop. Its
  // three workers always advance the same revision-scoped review in order;
  // transport recovery remains at the execution boundary.
  if (phase === "spec") return null;
  // Requirement-scoped test reviews are governed exclusively by
  // resolveRequirementTestLifecycle(). The generic flow-review policy must
  // not expose the retired whole-flow test repair route.
  if (phase === "test") return null;
  if (flowState?.policy?.nonblocking?.enabled === true) return null;
  if (facts.toolingOutcome) {
    return new DefinitionReviewDisposition({ operation: "external-blocked", phase });
  }
  if (facts.verdict !== "REJECTED") {
    return null;
  }
  // Task-local REJECTED results are consumed only by the five-stage Task
  // review connector. The flow-scoped review recovery policy has no Task
  // compatibility route.
  if (facts.scope === "task") return null;
  const maxAttempts = resolveMaxAttempts({ scope: facts.scope, stepId, context: flowState }) ?? 1;
  const attempts = facts.scope === "task"
    ? facts.attemptCount
    : countReviewAttempts(flowState?.metrics, phase);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("review transition facts have no usable attempt count");
  }
  if (attempts < maxAttempts) {
    return new DefinitionReviewDisposition({ operation: "retry", phase });
  }
  if (facts.deferralEvidence.available) {
    return new DefinitionReviewDisposition({
      operation: "defer",
      phase,
      attempts,
      maxAttempts,
      sourceFingerprints: facts.deferralEvidence.sourceFingerprints,
    });
  }
  if (attempts >= maxAttempts) {
    return new DefinitionReviewDisposition({ operation: "blocked", phase, attempts, maxAttempts });
  }
  return null;
}

const CONDITIONAL_WORKER_SETTLEMENT_TOKEN = Symbol("definition-conditional-worker-settlement");

/** Immutable authority for one no-worker settlement at the canonical boundary. */
export class ConditionalWorkerSettlementPlan {
  constructor(token, { disposition, flowState, evidenceDigest = null } = {}) {
    if (token !== CONDITIONAL_WORKER_SETTLEMENT_TOKEN
      || !(disposition instanceof DefinitionConditionalWorkerDisposition)
      || !["skip-worker", "complete-worker"].includes(disposition.operation)) {
      throw new Error("conditional worker settlement requires a Definition-selected terminal disposition");
    }
    this.disposition = disposition;
    this.runId = requireString(flowState?.runId, "conditional worker settlement runId");
    this.specId = requireString(flowState?.specId, "conditional worker settlement specId");
    if (!Number.isSafeInteger(flowState?.confirmationOrder) || flowState.confirmationOrder < 1) {
      throw new Error("conditional worker settlement confirmation order is invalid");
    }
    this.confirmationOrder = flowState.confirmationOrder;
    if (evidenceDigest !== null && !/^[a-f0-9]{64}$/.test(evidenceDigest)) {
      throw new Error("conditional worker settlement evidence digest is invalid");
    }
    this.evidenceDigest = evidenceDigest;
    Object.freeze(this);
  }

  get stepId() { return this.disposition.stepId; }
  get status() { return this.disposition.operation === "skip-worker" ? "skipped" : "done"; }
}

export function createConditionalWorkerSettlementPlan({ disposition, flowState, evidenceDigest = null } = {}) {
  return new ConditionalWorkerSettlementPlan(CONDITIONAL_WORKER_SETTLEMENT_TOKEN, {
    disposition,
    flowState,
    evidenceDigest,
  });
}

/** Definition-owned completion statuses for an exhausted deferred Review. */
export function resolveReviewDeferralLifecycle({ scope, stepId, disposition } = {}) {
  if (!(disposition instanceof DefinitionReviewDisposition) || disposition.operation !== "defer") return [];
  if (scope === "task") return [];
  if (scope !== "flow") throw new Error("review deferral lifecycle scope is invalid");
  const phase = reviewPhaseForFlowStepId(stepId);
  if (["draft-questions", "draft-coverage"].includes(phase)) return [];
  if (phase === null || phase !== disposition.phase) {
    throw new Error("review deferral lifecycle does not match the definition disposition");
  }
  const actions = [new SetStepStatus({ step: stepId, status: "done" })];
  if (phase === "impl") {
    actions.push(
      new SetStepStatus({ step: "impl-triage", status: "done" }),
      new SetStepStatus({ step: "impl-repair", status: "done" }),
    );
  }
  return actions;
}

function isFinalizeSuccess(result) {
  return FINALIZE_SUCCESS_STATUSES.has(String(result?.status || result?.data?.status || ""));
}

function gateStepIdForPhase(phase) {
  return Object.fromEntries(collectGatePhaseEntries())[phase] || "spec-gate";
}

function draftReviewRouteForInput(input = {}) {
  const retryPhase = input.result?.artifacts?.retryPhase
    || (String(input.phase || "").startsWith("draft-") ? input.phase : null);
  return draftReviewRouteForRetryPhase(retryPhase || "draft-questions");
}

/**
 * Review result persistence records the current result before lifecycle
 * actions run. Definition therefore projects this result as the next metric
 * entry and retains an exhausted rejected flow Review for guarded settlement.
 */
function rejectedFlowReviewReachesExhaustion(input, phase, stepId) {
  if (input.result?.artifacts?.verdict !== "REJECTED") return false;
  if (input.result?.artifacts?.taskId != null) return false;
  const maxAttempts = resolveMaxAttempts({ scope: "flow", stepId, context: input.flowState }) ?? 1;
  return countReviewAttempts(input.flowState?.metrics, phase) + 1 >= maxAttempts;
}

function reviewStepIdForInput(input = {}) {
  const phase = input.result?.artifacts?.phase || input.phase;
  if (phase === "draft" || phase === "draft-questions" || phase === "draft-coverage") {
    return draftReviewRouteForInput(input).reviewStepId;
  }
  return flowReviewRouteForPhase(phase)?.reviewStepId || input.currentStepId || null;
}

export function resolveRuntimeStep(input = {}) {
  const command = input.command || input.action;
  if (command === "run-review") return reviewStepIdForInput(input);
  if (command === "run-gate") return gateStepIdForPhase(input.phase || input.result?.artifacts?.phase);
  if (command === "report") return "report";
  if (String(command || "").startsWith("finalize-")) return command;
  return input.currentStepId || null;
}

function resolvePlanReviewLifecycle(input) {
  const phase = input.result?.artifacts?.phase || input.phase;
  const verdict = input.result?.artifacts?.verdict;
  const toolingOutcome = input.result?.artifacts?.toolingOutcome;
  if (phase === "draft" || phase === "draft-questions" || phase === "draft-coverage") {
    // Draft Review lifecycle is committed by the typed Step/Service boundary.
    // Keeping this plan empty prevents generic hooks from settling a result
    // without its StepResult and canonical route receipt.
    return [];
  }
  const actions = [];
  // Tooling observations also need their typed ExternalBlocked persistence;
  // the persistence adapter deliberately does not consume semantic budget.
  const recordRetry = true;
  if (phase === "spec") {
    if (["PASS", "ADVISORY", "REJECTED"].includes(verdict)) {
      actions.push(new SetStepStatus({ step: "spec-review", status: "done" }));
    }
    return actions;
  }
  if (phase === "test") {
    if (input.flowState?.policy?.nonblocking?.enabled === true && (verdict === "REJECTED" || toolingOutcome)) {
      // A test-review advisory decision must create the same durable
      // acceptance handoff as retry exhaustion before it can advance.
      return actions;
    }
    if (verdict === "PASS" || verdict === "ADVISORY") {
      actions.push(new SetStepStatus({ step: "test-review", status: "done" }));
    } else if (toolingOutcome) {
      actions.push(new AppendIssueLog({ source: "test-review-tooling-failure" }));
    }
    if (recordRetry) actions.unshift(new IncrementMetric({ phase, counter: "reviewRetry" }));
    return actions;
  }
  if (recordRetry) actions.push(new IncrementMetric({ phase, counter: "reviewRetry" }));
  return actions;
}

function resolveImplReviewLifecycle(input) {
  const artifacts = input.result?.artifacts;
  const flowScoped = artifacts?.phase === "impl" && artifacts?.taskId == null;
  if (input.result?.artifacts?.deferred === true) {
    if (!flowScoped) return [];
    return [
      new SetStepStatus({ step: "impl-triage", status: "done" }),
      new SetStepStatus({ step: "impl-repair", status: "done" }),
    ];
  }
  const verdict = input.result?.artifacts?.verdict;
  const toolingOutcome = input.result?.artifacts?.toolingOutcome;
  const proposalCount = input.result?.artifacts?.proposalCount ?? 0;
  const actions = [];
  if (input.flowState?.policy?.nonblocking?.enabled === true && input.result?.artifacts?.phase === "impl" && (
    verdict === "REJECTED" || toolingOutcome
  )) {
    // Evidence stays authoritative; the agent records repair/retry/continue
    // through the guarded nonblocking decision command.
    return actions;
  }
  if (input.result?.artifacts?.phase === "impl") {
    if (toolingOutcome) {
      actions.push(new IncrementMetric({ phase: "impl", counter: "reviewRetry" }));
      return actions;
    }
    // Task-local review publication is settled by the typed review-funnel
    // connector. The generic lifecycle hook must not invent a parallel route.
    if (!flowScoped) return actions;
    if (flowScoped && rejectedFlowReviewReachesExhaustion(
      input,
      "impl",
      input.currentStepId || "impl-review",
    )) {
      return [
        new PersistReviewResult(),
        new IncrementMetric({ phase: "impl", counter: "reviewRetry" }),
      ];
    }
    if (verdict === "PASS" || verdict === "ADVISORY") {
      actions.push(
        new SetStepStatus({ step: input.currentStepId || "impl-review", status: "done" }),
        new SetStepStatus({ step: "impl-triage", status: "done" }),
        new SetStepStatus({ step: "impl-repair", status: "done" }),
        new SetStepStatus({ step: "impl-gate", status: "in_progress" }),
      );
    } else if (flowScoped && verdict === "REJECTED") {
      actions.push(
        new ResetSteps({ steps: REJECTED_IMPL_REVIEW_RESET_STEPS }),
        new SetStepStatus({ step: input.currentStepId || "impl-review", status: "done" }),
        new SetStepStatus({ step: "impl-triage", status: "in_progress" }),
      );
    }
    actions.unshift(new IncrementMetric({ phase: "impl", counter: "reviewRetry" }));
    return actions;
  }
  if (!input.dryRun && proposalCount > 0) {
    actions.push(new ResetSteps({ steps: IMPL_REVIEW_RESET_RANGE }));
    return actions;
  }
  actions.push(new SetStepStatus({ step: input.currentStepId || "impl-review", status: "done" }));
  return actions;
}

function resolveReviewLifecycle(input) {
  if (input.result?.artifacts?.deferred === true) return [];
  if (input.phase === "draft" || input.phase === "spec" || input.phase === "test") {
    return resolvePlanReviewLifecycle(input);
  }
  return resolveImplReviewLifecycle(input);
}

function resolveGateLifecycle(input) {
  if (input.event === "gate:pre") {
    const active = findActiveNode(input.flowState || {});
    const taskStep = TaskStepIdentity.fromStateNode(input.flowState, active?.stepId);
    const step = input.phase === "task-impl" && taskStep?.definitionId === "task-gate"
      ? taskStep.nodeId
      : gateStepIdForPhase(input.phase);
    return [new SetStepStatus({ step, status: "in_progress" })];
  }

  // Gate execution errors are observations, not a second transition policy.
  // A post lifecycle must receive the sealed Decision made after the canonical
  // result was published; every other event leaves state untouched here.
  if (input.event !== "gate:post") return [];
  if (!(input.gateTransitionDecision instanceof GateTransitionDecision)) {
    throw new Error("gate post lifecycle requires a Definition-selected GateTransitionDecision");
  }

  const decision = input.gateTransitionDecision;
  if (decision.facts.phase === "draft") return [];
  if (decision.facts.scope === "task") {
    const progress = decision.facts.taskSettlementProgress;
    if (decision.plan.retryMetric !== null && !progress.hasMetric(decision.plan.retryMetric)) {
      return [new IncrementMetric({
        phase: decision.plan.retryMetric.phase,
        counter: "gateRetry",
      })];
    }
    if ((decision.facts.result === "pass" || decision.facts.result === "fail") && !progress.issueLogRecorded) {
      return [new AppendIssueLog({ source: "gate-result" })];
    }
    return decision.plan.updates.map((update) => new SetStepStatus({
      step: update.stepId,
      status: update.status,
    }));
  }
  const actions = decision.plan.updates.map((update) => new SetStepStatus({
    step: update.stepId,
    status: update.status,
  }));
  if (decision.plan.retryMetric !== null) {
    actions.push(new IncrementMetric({
      phase: decision.plan.retryMetric.phase,
      counter: "gateRetry",
    }));
  }
  if (decision.facts.result === "fail") actions.push(new AppendIssueLog({ source: "gate-result" }));
  return actions;
}

function finalizeMergeMetadataPreflightAction() {
  return new RunLifecycleHook({
    module: "finalize",
    handler: "assertFinalizeMergeMetadataMutationSafe",
  });
}

function resolveFinalizeLifecycle(input) {
  const command = input.command || input.currentStepId || input.targetStepId;
  if (input.event === "finalize:interrupted" && command === "finalize-sync") {
    return [new SetStepStatus({ step: command, status: "skipped" })];
  }
  if (input.event === "finalize:pre") {
    const actions = [];
    if (command === "finalize-merge") {
      actions.push(finalizeMergeMetadataPreflightAction());
    } else if (command === "finalize-sync") {
      actions.push(new RunLifecycleHook({ module: "finalize", handler: "resolveMainRepoFlowManager" }));
    }
    if (command === "finalize-merge") {
      actions.push(new RunLifecycleHook({
        module: "finalize",
        handler: "prepareFinalizeMerge",
        args: { steps: ["finalize-sync", "finalize-cleanup"] },
      }));
      // Record the idempotency key before RunFinalizeMergeCommand can start
      // the merge. The post lifecycle begins the same identity again after
      // authority switches to main, which is how the pending entry is carried
      // into main's flow state without a clean-path metadata-only commit.
      actions.push(new BeginOutboxEffect({ step: command }));
    } else {
      actions.push(new BeginOutboxEffect({ step: command }));
    }
    return actions;
  }
  if (input.event === "finalize:onError") {
    const actions = [];
    if (command === "finalize-merge") {
      actions.push(finalizeMergeMetadataPreflightAction());
    } else if (command === "finalize-sync") {
      actions.push(new RunLifecycleHook({ module: "finalize", handler: "resolveMainRepoFlowManager" }));
    } else if (command === "finalize-cleanup") {
      actions.push(new RunLifecycleHook({ module: "finalize", handler: "resolveCleanupOutboxFlowManager" }));
    }
    if (command === "finalize-merge") {
      actions.push(new FailOutboxEffect({ step: command }));
      actions.push(new SkipSteps({ steps: ["finalize-sync", "finalize-cleanup"] }));
    } else {
      actions.push(new FailOutboxEffect({ step: command }));
      if (command === "finalize-sync") {
        actions.push(new SetStepStatus({ step: command, status: "skipped" }));
      }
    }
    actions.push(new RunLifecycleHook({ module: "finalize", handler: "finalizeOnError", args: { command } }));
    if (command === "finalize-merge") {
      actions.push(new RunLifecycleHook({
        module: "finalize",
        handler: "commitFinalizeMergeConflictMetadata",
      }));
    }
    return actions;
  }
  if (!isFinalizeSuccess(input.result)) return [new FailOutboxEffect({ step: command })];
  const actions = [];
  if (command === "finalize-merge" || command === "finalize-sync" || command === "finalize-cleanup") {
    actions.push(new RunLifecycleHook({
      module: "finalize",
      handler: "resolveMainRepoFlowManager",
      args: command === "finalize-merge" ? { unlessPr: true } : null,
    }));
  }
  if (command === "finalize-merge") {
    actions.push(
      new BeginOutboxEffect({ step: command }),
      new RunLifecycleHook({ module: "finalize", handler: "ensureFinalizeMergeInProgress" }),
      new RunLifecycleHook({ module: "finalize", handler: "recordMergeOutcome" }),
      new RunLifecycleHook({
        module: "finalize",
        handler: "resetSkippedDownstreamSteps",
        args: { steps: ["finalize-sync", "finalize-cleanup"] },
      }),
    );
  }
  actions.push(new SetStepStatus({
    step: command,
    status: "done",
    // A retried merge restores its downstream leaves for the next normal
    // command; it does not begin finalize-sync as part of merge completion.
    suppressAutoPromotion: command === "finalize-merge",
  }));
  actions.push(new CompleteOutboxEffect({ step: command }));
  return actions;
}

function resolveReportLifecycle(input) {
  if (input.event === "report:pre") return [new BeginOutboxEffect({ step: "report" })];
  if (input.event === "report:onError") return [new FailOutboxEffect({ step: "report" })];
  if (input.result?.result !== "ok") return [new FailOutboxEffect({ step: "report" })];
  return [
    new SetStepStatus({ step: "report", status: "done" }),
    new CompleteOutboxEffect({ step: "report" }),
  ];
}

function resolveAcceptanceReviewLifecycle(input) {
  if (input.event !== "acceptance-review:post") return [];
  // A mechanically blocked review deliberately retains its active Attempt:
  // it is evidence for a later retry/recovery, not a completed acceptance.
  if (input.result?.verdict === "blocked") return [];
  return [new SetStepStatus({ step: "acceptance-review", status: "done" })];
}

function resolveLifecycleForNode(node, input = {}) {
  if (input.event === "acceptance-review:post" || node.id === "acceptance-review") {
    return resolveAcceptanceReviewLifecycle(input);
  }
  if (input.event === "review:post" || node.action === "run-review") return resolveReviewLifecycle(input);
  if (input.event === "gate:post" || node.action === "run-gate") return resolveGateLifecycle(input);
  if (String(input.event || "").startsWith("report:") || node.action === "run-report") {
    return resolveReportLifecycle(input);
  }
  if (String(input.event || "").startsWith("finalize:") || String(node.action || "").startsWith("run-finalize-")) {
    return resolveFinalizeLifecycle(input);
  }
  return [];
}

export function resolveLifecycle(input = {}) {
  if (input.event === "review:task-gate-handoff") {
    const step = input.currentStepId || input.targetStepId;
    if (typeof step !== "string" || step === "") throw new Error("Task Review Gate handoff lifecycle requires its current Task Review step");
    return [new SetStepStatus({ step, status: "done" })];
  }
  if (input.event === "set-step:impl-triage") {
    return [
      new SetStepStatus({ step: "impl-repair", status: "done" }),
      new SetStepStatus({ step: "impl-gate", status: "in_progress" }),
    ];
  }
  if ([
    "gate:defer",
    "gate:phase-inference",
    "review:defer",
    "finalize-cleanup:complete",
    "definition:keep-in-progress",
    "definition:skip-steps",
    "test-execute:post",
    "test-result-review:post",
    "retro:post",
    "final-regression:post",
  ].includes(input.event)) {
    return [new SetStepStatus({ step: input.targetStepId, status: input.status })];
  }
  const stepId = input.currentStepId || resolveRuntimeStep(input);
  const taskStep = TaskStepIdentity.fromStateNode(input.flowState, stepId);
  const definitionStepId = taskStep?.definitionId ?? stepId;
  const node = definitionStepId ? (getFlowNode(definitionStepId) || getTaskNode(definitionStepId)) : null;
  if (!node) return [];
  const actions = node.resolveLifecycle({
    ...input,
    currentStepId: definitionStepId,
  });
  if (taskStep === null) return actions;
  return actions.map((action) => (
    action instanceof SetStepStatus && new Set(["task-impl", "task-review", "task-triage", "task-repair", "task-gate"]).has(action.step)
      ? action.forStep(`${taskStep.taskId}-${action.step.slice("task-".length)}`)
      : action
  ));
}

export function resolveLifecyclePlan(input = {}) {
  let actions = resolveLifecycle(input);
  const currentStepId = input.currentStepId || resolveRuntimeStep(input) || input.targetStepId || null;
  if (input.settleInProgressAsDone === true) {
    actions = actions.map((action) => (
      action instanceof SetStepStatus
        && action.step === currentStepId
        && action.status === "in_progress"
        ? new SetStepStatus({ step: action.step, status: "done" })
        : action
    ));
  }
  return new DefinitionLifecyclePlan(DEFINITION_LIFECYCLE_PLAN_TOKEN, {
    event: input.event,
    currentStepId,
    actions,
  });
}

export class FlowExecutionCommand {
  constructor(subcommand, ...args) {
    const tokens = [subcommand, ...args];
    if (tokens.some((token) => (
      typeof token !== "string" || token.trim() === "" || /\s/.test(token)
    ))) {
      throw new Error("flow execution command tokens must be non-empty strings without whitespace");
    }
    this.subcommand = subcommand;
    this.args = Object.freeze([...args]);
    this.tokens = Object.freeze(["sennel", "flow", "run", ...tokens]);
    Object.freeze(this);
  }

  toString() {
    return this.tokens.join(" ");
  }

  runArguments() {
    return [...this.tokens.slice(3)];
  }
}

/** The one authority permitted to terminally handle a parent command failure. */
export const DEFINITION_FAILURE_OWNERS = Object.freeze([
  DefinitionFailureOwnership.dispatcherPrimary(),
  DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  DefinitionFailureOwnership.commandExclusive(),
  DefinitionFailureOwnership.lifecycleOutbox(),
]);

class FlowNode {
  constructor({
    id,
    label,
    action,
    instructionsKey,
    contextKinds = [],
    outputSchemaRef = null,
    requiresApproval = false,
    autoApproveChoiceId = null,
    skippable = false,
    maxAttempts = 1,
    toolingMaxAttempts = null,
    fallbacks = null,
    children = null,
    sideEffects = null,
    gatePhase = null,
    failurePolicy = null,
    failureTargetId = null,
    definitionLifecycleOwned = false,
    executionCommand = null,
    failureOwnership = null,
  }) {
    this.id = id;
    this.label = label;
    this.action = action;
    this.instructionsKey = instructionsKey;
    this.contextKinds = Object.freeze([...contextKinds]);
    this.outputSchemaRef = outputSchemaRef;
    this.requiresApproval = requiresApproval;
    if (autoApproveChoiceId !== null && (requiresApproval !== true || autoApproveChoiceId !== "1")) {
      throw new Error("autoApproveChoiceId must be choice id=1 on an approval-required step");
    }
    this.autoApproveChoiceId = autoApproveChoiceId;
    this.skippable = skippable;
    this.maxAttempts = createMaxAttempts(maxAttempts);
    this.toolingMaxAttempts = toolingMaxAttempts == null ? null : createMaxAttempts(toolingMaxAttempts);
    this.fallbacks = fallbacks ? Object.freeze([...fallbacks]) : null;
    this.children = children ? Object.freeze(children.map((c) => Object.freeze(c))) : null;
    this.sideEffects = sideEffects ? Object.freeze([...sideEffects]) : null;
    this.gatePhase = gatePhase ? Object.freeze([...gatePhase]) : null;
    this.definitionLifecycleOwned = definitionLifecycleOwned === true;
    if (this.definitionLifecycleOwned && !this.action.startsWith("run-")) {
      throw new Error(`definition lifecycle-owned action must start with run-: ${this.action}`);
    }
    if (
      this.definitionLifecycleOwned
      && !(executionCommand instanceof FlowExecutionCommand)
    ) {
      throw new Error(`definition lifecycle-owned step must declare executionCommand: ${this.id}`);
    }
    if (!this.definitionLifecycleOwned && executionCommand !== null) {
      throw new Error(`only definition lifecycle-owned steps may declare executionCommand: ${this.id}`);
    }
    this.executionCommand = executionCommand;
    this.failureOwnership = failureOwnership === null
      ? null
      : DefinitionFailureOwnership.from(failureOwnership);
    if (this.definitionLifecycleOwned && !(this.failureOwnership instanceof DefinitionFailureOwnership)) {
      throw new Error(`definition lifecycle-owned step must declare failureOwnership: ${this.id}`);
    }
    if (!this.definitionLifecycleOwned && this.failureOwnership !== null) {
      throw new Error(`only definition lifecycle-owned steps may declare failureOwnership: ${this.id}`);
    }
    if (failurePolicy === null && failureTargetId !== null) {
      throw new Error(`failureTargetId requires a failurePolicy: ${this.id}`);
    }
    const parsedFailurePolicy = failurePolicy === null
      ? null
      : new DefinitionFailurePolicy(failurePolicy, { targetNodeId: failureTargetId });
    this.failurePolicy = parsedFailurePolicy?.value ?? null;
    this.failureTargetId = parsedFailurePolicy?.targetNodeId ?? null;
  }

  get isBranch() { return this.children != null; }
  get isLeaf() { return this.children == null; }

  resolveMaxAttempts(context = {}) {
    return this.maxAttempts.resolve(context);
  }

  resolveToolingMaxAttempts(context = {}) {
    return this.toolingMaxAttempts?.resolve(context) ?? null;
  }

  resolveLifecycle(input = {}) {
    return resolveLifecycleForNode(this, input);
  }
}

const DRAFT_QUESTIONS_ROUTE = draftReviewRouteForKey("questions");
const DRAFT_COVERAGE_ROUTE = draftReviewRouteForKey("coverage");

/**
 * The complete state effect of a Draft route.  The route resolver derives
 * this from the Definition once, then persistence carries these exact IDs to
 * the state machine.  State never infers a skip or reset range from topology.
 */
export class StepRouteEffects {
  constructor({ skipStepIds = [], resetStepIds = [] } = {}) {
    for (const [field, stepIds] of Object.entries({ skipStepIds, resetStepIds })) {
      if (!Array.isArray(stepIds) || stepIds.some((stepId) => typeof stepId !== "string" || stepId === "")) {
        throw new TypeError(`Step route ${field} must contain Step IDs`);
      }
      if (new Set(stepIds).size !== stepIds.length) throw new TypeError(`Step route ${field} must not contain duplicates`);
    }
    if (skipStepIds.some((stepId) => resetStepIds.includes(stepId))) {
      throw new TypeError("Step route effects cannot skip and reset the same Step");
    }
    this.skipStepIds = Object.freeze([...skipStepIds]);
    this.resetStepIds = Object.freeze([...resetStepIds]);
    Object.freeze(this);
  }

  toJSON() {
    return { skipStepIds: [...this.skipStepIds], resetStepIds: [...this.resetStepIds] };
  }
}

function draftRouteEffects(sourceStepId, targetStepId) {
  return new StepRouteEffects(contiguousLeafRouteEffects(
    collectFlowLeafIds(), sourceStepId, targetStepId,
  ));
}

const STEP_SETTLEMENT_TOKEN = Symbol("Definition-selected Step settlement");

/** A complete Definition-selected disposition for one concrete Step Result. */
export class StepSettlement {
  constructor(token, result, kind) {
    if (new.target === StepSettlement) throw new TypeError("StepSettlement is abstract");
    if (token !== STEP_SETTLEMENT_TOKEN) {
      throw new TypeError("Step settlements must be selected by Definition");
    }
    if (!(result instanceof StepResult)) throw new TypeError("Step settlement requires its concrete Result");
    this.sourceStepId = result.stepId;
    this.resultKind = result.kind;
    this.resultType = result.type;
    this.kind = requireString(kind, "step settlement kind");
  }
}

/** A Definition-selected target connection; only this settlement owns a Connector. */
export class StepRoute extends StepSettlement {
  constructor(token, { result, targetStepId, connector, effects }) {
    super(token, result, "target-connection");
    this.targetStepId = requireString(targetStepId, "step route target");
    if (typeof connector !== "function") throw new TypeError("step route requires a Connector");
    this.connector = connector;
    this.effects = effects instanceof StepRouteEffects ? effects : new StepRouteEffects(effects);
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      sourceStepId: this.sourceStepId,
      targetStepId: this.targetStepId,
      effects: this.effects.toJSON(),
    };
  }

}

export class DraftNextRoute extends StepRoute {}
export class DraftBranchRoute extends StepRoute {}
export class DraftLoopRoute extends StepRoute {}
export class SpecNextRoute extends StepRoute {}

export class DraftExecutionSettlement extends StepSettlement {
  constructor(token, result) {
    super(token, result, "execution");
    Object.freeze(this);
  }

  toJSON() { return { kind: this.kind, sourceStepId: this.sourceStepId }; }
}

export class DraftAwaitUserDecision extends StepSettlement {
  constructor(token, result) {
    if (!(result instanceof DraftRefineAwaitingAnswerResult)) {
      throw new TypeError("only draft-refine awaiting-answer may await user input");
    }
    super(token, result, "await");
    this.stepId = result.stepId;
    Object.freeze(this);
  }

  toJSON() { return { kind: this.kind, sourceStepId: this.sourceStepId }; }
}

/** Failure category reserved for a persisted terminal StepResult Error. */
export const STEP_RESULT_ERROR_CATEGORY = "step-result-error";

export class StepErrorDecision extends StepSettlement {
  constructor(token, result) {
    if (!(result instanceof StepErrorResult)) {
      throw new TypeError("error decision requires an Error Result");
    }
    super(token, result, "failure");
    this.stepId = result.stepId;
    this.error = result.error;
    Object.freeze(this);
  }

  toJSON() { return { kind: this.kind, sourceStepId: this.sourceStepId }; }
}

/**
 * Content identity for the durable publications owned by one Draft settlement.
 *
 * A Result and Definition-selected Settlement alone are not enough to make a
 * retry exact: the same binding could otherwise silently accept different
 * artifact bytes or optimistic baselines after the original transaction has
 * committed.  The Store supplies only canonical publication intent here; this
 * value deliberately has no knowledge of unrelated command-local inputs.
 */
export class DraftStepSettlementPublication {
  constructor(intent = {}) {
    if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
      throw new TypeError("Draft settlement publication identity requires an object");
    }
    let canonical;
    try {
      canonical = JSON.parse(JSON.stringify(intent));
    } catch (error) {
      throw new TypeError(`Draft settlement publication identity must be JSON-serializable: ${error.message}`);
    }
    this.digest = createHash("sha256").update(stableJson(canonical)).digest("hex");
    Object.freeze(this);
  }

  toJSON() { return { digest: this.digest }; }
}

/** Exact canonical question selected by one persisted Await Result. */
export class DraftAwaitQuestionIdentity {
  constructor({ questionId, questionRevision, sourceDigest, sourceByteLength } = {}) {
    this.questionId = requireString(questionId, "Draft Await question ID");
    if (!Number.isSafeInteger(questionRevision) || questionRevision < 0) {
      throw new TypeError("Draft Await question revision is invalid");
    }
    if (typeof sourceDigest !== "string" || !SHA256_DIGEST.test(sourceDigest)) {
      throw new TypeError("Draft Await source digest is invalid");
    }
    if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0) {
      throw new TypeError("Draft Await source byte length is invalid");
    }
    this.questionRevision = questionRevision;
    this.sourceDigest = sourceDigest;
    this.sourceByteLength = sourceByteLength;
    Object.freeze(this);
  }

  toJSON() {
    return {
      questionId: this.questionId,
      questionRevision: this.questionRevision,
      sourceDigest: this.sourceDigest,
      sourceByteLength: this.sourceByteLength,
    };
  }
}

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const GIT_TREE_DIGEST = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DRAFT_EXECUTION_PHASES = new Set(["checkpoint", "claimed", "publication", "terminal"]);

function requireDraftExecutionDigest(value, field, pattern = SHA256_DIGEST) {
  const digest = requireString(value, field).toLowerCase();
  if (!pattern.test(digest)) throw new TypeError(`${field} is invalid`);
  return digest;
}

function requireExactObject(value, fields, field) {
  if (!isPlainObject(value)
    || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new TypeError(`${field} has invalid fields`);
  }
  return value;
}

/** Immutable ReviewWorkUnitManifest target identity used at execution admission. */
export class DraftReviewExecutionTargetIdentity {
  constructor({ treeSha, targetStateDigest } = {}) {
    this.treeSha = requireDraftExecutionDigest(treeSha, "Draft review execution target treeSha", GIT_TREE_DIGEST);
    this.targetStateDigest = requireDraftExecutionDigest(targetStateDigest, "Draft review execution target state digest");
    Object.freeze(this);
  }

  toJSON() { return { treeSha: this.treeSha, targetStateDigest: this.targetStateDigest }; }

  equals(other) {
    return other instanceof DraftReviewExecutionTargetIdentity
      && this.treeSha === other.treeSha
      && this.targetStateDigest === other.targetStateDigest;
  }

  static fromJSON(value) {
    return new this(requireExactObject(value, ["treeSha", "targetStateDigest"], "Draft review execution target"));
  }
}

/** Generation-bound identity of a canonical Draft review work unit. */
export class DraftReviewExecutionBinding {
  constructor({ executionGeneration, manifestDigest, inputDigest, target } = {}) {
    if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 0) {
      throw new TypeError("Draft review execution generation is invalid");
    }
    this.kind = "review";
    this.executionGeneration = executionGeneration;
    this.manifestDigest = requireDraftExecutionDigest(manifestDigest, "Draft review execution manifest digest");
    this.inputDigest = requireDraftExecutionDigest(inputDigest, "Draft review execution input digest");
    this.target = target instanceof DraftReviewExecutionTargetIdentity
      ? target : DraftReviewExecutionTargetIdentity.fromJSON(target);
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      executionGeneration: this.executionGeneration,
      manifestDigest: this.manifestDigest,
      inputDigest: this.inputDigest,
      target: this.target.toJSON(),
    };
  }

  /**
   * A saved review checkpoint or claim authorizes only this exact
   * reconstructed worker contract.  The execution generation is part of the
   * comparison so callers cannot replay one generation as another.
   */
  equals(other) {
    return other instanceof DraftReviewExecutionBinding
      && this.executionGeneration === other.executionGeneration
      && this.manifestDigest === other.manifestDigest
      && this.inputDigest === other.inputDigest
      && this.target.equals(other.target);
  }
}

/** Generation-bound identity from which a WorkerArtifactHandoffRequest is materialized. */
export class DraftWorkerExecutionBinding {
  constructor({ executionGeneration, inputDigest, inputRevision } = {}) {
    if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 0) {
      throw new TypeError("Draft worker execution generation is invalid");
    }
    this.kind = "worker";
    this.executionGeneration = executionGeneration;
    this.inputDigest = requireDraftExecutionDigest(inputDigest, "Draft worker execution input digest");
    this.inputRevision = requireDraftExecutionDigest(inputRevision, "Draft worker execution input revision");
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      executionGeneration: this.executionGeneration,
      inputDigest: this.inputDigest,
      inputRevision: this.inputRevision,
    };
  }

  equals(other) {
    return other instanceof DraftWorkerExecutionBinding
      && this.executionGeneration === other.executionGeneration
      && this.inputDigest === other.inputDigest
      && this.inputRevision === other.inputRevision;
  }
}

function draftExecutionBindingFromJSON(value) {
  if (!isPlainObject(value)) throw new TypeError("Draft execution binding must be an object");
  if (value.kind === "review") {
    requireExactObject(value, ["kind", "executionGeneration", "manifestDigest", "inputDigest", "target"], "Draft review execution binding");
    return new DraftReviewExecutionBinding(value);
  }
  if (value.kind === "worker") {
    requireExactObject(value, ["kind", "executionGeneration", "inputDigest", "inputRevision"], "Draft worker execution binding");
    return new DraftWorkerExecutionBinding(value);
  }
  throw new TypeError("Draft execution binding kind is invalid");
}

/** First claim for a review generation; the manifest itself is the exact request. */
export class DraftReviewExecutionClaim {
  constructor() {
    this.kind = "review";
    Object.freeze(this);
  }

  toJSON() { return { kind: this.kind }; }
}

/** First claim for the exact worker request which may be materialized after commit. */
export class DraftWorkerExecutionClaim {
  constructor({ dispatchInvocationId, generatedAt, actionDigest, requestDigest } = {}) {
    this.kind = "worker";
    this.dispatchInvocationId = requireString(dispatchInvocationId, "Draft worker dispatch invocation ID");
    if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
      throw new TypeError("Draft worker generatedAt is invalid");
    }
    this.generatedAt = new Date(generatedAt).toISOString();
    this.actionDigest = requireDraftExecutionDigest(actionDigest, "Draft worker action digest");
    this.requestDigest = requireDraftExecutionDigest(requestDigest, "Draft worker request digest");
    Object.freeze(this);
  }

  toJSON() {
    return {
      kind: this.kind,
      dispatchInvocationId: this.dispatchInvocationId,
      generatedAt: this.generatedAt,
      actionDigest: this.actionDigest,
      requestDigest: this.requestDigest,
    };
  }
}

function draftExecutionClaimFromJSON(value) {
  if (!isPlainObject(value)) throw new TypeError("Draft execution claim must be an object");
  if (value.kind === "review") {
    requireExactObject(value, ["kind"], "Draft review execution claim");
    return new DraftReviewExecutionClaim();
  }
  if (value.kind === "worker") {
    requireExactObject(value, ["kind", "dispatchInvocationId", "generatedAt", "actionDigest", "requestDigest"], "Draft worker execution claim");
    return new DraftWorkerExecutionClaim(value);
  }
  throw new TypeError("Draft execution claim kind is invalid");
}

/** One durable point in the execution generation lifecycle. */
export class DraftStepExecutionLifecycle {
  constructor({ phase, binding, claim = null } = {}) {
    if (!DRAFT_EXECUTION_PHASES.has(phase)) throw new TypeError("Draft execution lifecycle phase is invalid");
    if (!(binding instanceof DraftReviewExecutionBinding) && !(binding instanceof DraftWorkerExecutionBinding)) {
      throw new TypeError("Draft execution lifecycle requires a typed binding");
    }
    if (claim !== null && !(claim instanceof DraftReviewExecutionClaim) && !(claim instanceof DraftWorkerExecutionClaim)) {
      throw new TypeError("Draft execution lifecycle claim is invalid");
    }
    if ((phase === "checkpoint") !== (claim === null)) {
      throw new TypeError("Draft execution checkpoint is the only unclaimed lifecycle phase");
    }
    if (claim !== null && claim.kind !== binding.kind) {
      throw new TypeError("Draft execution claim does not match its binding kind");
    }
    this.phase = phase;
    this.binding = binding;
    this.claim = claim;
    Object.freeze(this);
  }

  get executionGeneration() { return this.binding.executionGeneration; }

  claimed(claim) { return new DraftStepExecutionLifecycle({ phase: "claimed", binding: this.binding, claim }); }
  published() { return new DraftStepExecutionLifecycle({ phase: "publication", binding: this.binding, claim: this.claim }); }
  terminal() { return new DraftStepExecutionLifecycle({ phase: "terminal", binding: this.binding, claim: this.claim }); }

  toJSON() {
    return {
      phase: this.phase,
      binding: this.binding.toJSON(),
      claim: this.claim?.toJSON() ?? null,
    };
  }

  equals(other) {
    return other instanceof DraftStepExecutionLifecycle
      && stableJson(this.toJSON()) === stableJson(other.toJSON());
  }

  static checkpoint(binding) {
    return new this({ phase: "checkpoint", binding });
  }

  static fromJSON(value) {
    requireExactObject(value, ["phase", "binding", "claim"], "Draft execution lifecycle");
    return new this({
      phase: value.phase,
      binding: draftExecutionBindingFromJSON(value.binding),
      claim: value.claim === null ? null : draftExecutionClaimFromJSON(value.claim),
    });
  }
}

/** Canonical read model for restart-safe generation selection and claim recovery. */
export class DraftStepExecutionState {
  #executionIdentity;

  constructor({ binding, receipt = null } = {}) {
    if (binding?.runId === undefined || binding?.specId === undefined
      || typeof binding?.stepId !== "string" || typeof binding?.attempt?.id !== "string"
      || !Number.isSafeInteger(binding?.attempt?.sequence)) {
      throw new TypeError("Draft execution state requires its exact Attempt binding");
    }
    if (receipt !== null && (!(receipt instanceof DraftStepSettlementReceiptValue)
      || receipt.executionLifecycle == null)) {
      throw new TypeError("Draft execution state receipt must be typed");
    }
    const selectedReceiptId = receipt?.id ?? null;
    const selectedLifecycle = receipt === null
      ? null
      : DraftStepExecutionLifecycle.fromJSON(
          receipt.executionLifecycle.toJSON?.() ?? receipt.executionLifecycle,
        );
    if (selectedReceiptId !== null && !SHA256_DIGEST.test(selectedReceiptId)) {
      throw new TypeError("Draft execution state receipt ID is invalid");
    }
    if (selectedLifecycle !== null && !(selectedLifecycle instanceof DraftStepExecutionLifecycle)) {
      throw new TypeError("Draft execution state lifecycle must be typed");
    }
    if ((selectedReceiptId === null) !== (selectedLifecycle === null)) {
      throw new TypeError("Draft execution state receipt and lifecycle must be present together");
    }
    if (receipt !== null && (
      receipt.binding.runId !== binding.runId
      || receipt.binding.specId !== binding.specId
      || receipt.binding.stepId !== binding.stepId
      || receipt.binding.attemptId !== binding.attempt.id
      || receipt.binding.attemptSequence !== binding.attempt.sequence
      || receipt.id !== selectedReceiptId
    )) {
      throw new TypeError("Draft execution state receipt does not match its Attempt binding");
    }
    this.flowBinding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence,
    });
    this.receiptId = selectedReceiptId;
    this.lifecycle = selectedLifecycle;
    this.#executionIdentity = receipt?.settlementKind === "execution"
      ? draftStepExecutionIdentity(binding, receipt)
      : null;
    Object.freeze(this);
  }

  get nextGeneration() {
    return this.lifecycle?.phase === "terminal"
      ? null : this.lifecycle === null ? 0 : this.lifecycle.executionGeneration + 1;
  }

  reviewBinding({ manifestDigest, inputDigest, target } = {}) {
    if (this.nextGeneration === null) throw new TypeError("terminal Draft execution has no next generation");
    return new DraftReviewExecutionBinding({
      executionGeneration: this.nextGeneration,
      manifestDigest,
      inputDigest,
      target,
    });
  }

  workerBinding({ inputDigest, inputRevision } = {}) {
    if (this.nextGeneration === null) throw new TypeError("terminal Draft execution has no next generation");
    return new DraftWorkerExecutionBinding({
      executionGeneration: this.nextGeneration,
      inputDigest,
      inputRevision,
    });
  }

  /** Rehydrate only the Result and Settlement selected by the persisted receipt. */
  executionIdentity() {
    return ["checkpoint", "claimed", "publication"].includes(this.lifecycle?.phase)
      ? this.#executionIdentity
      : null;
  }

  toJSON() {
    return {
      flowBinding: { ...this.flowBinding },
      receiptId: this.receiptId,
      lifecycle: this.lifecycle?.toJSON() ?? null,
      nextGeneration: this.nextGeneration,
    };
  }
}

/** Durable identity of one Result and its already-selected settlement. */
export class DraftStepSettlementReceipt extends DraftStepSettlementReceiptValue {
  constructor({ binding, result, settlement, publication, executionLifecycle = null, awaitQuestion = null } = {}) {
    super();
    if (!(result instanceof StepResult) || !(settlement instanceof StepSettlement)) {
      throw new TypeError("Step settlement receipt requires a Result and Settlement");
    }
    if (!(publication instanceof DraftStepSettlementPublication)) {
      throw new TypeError("Draft settlement receipt requires its publication identity");
    }
    if (binding?.runId === undefined || binding?.specId === undefined
      || binding?.stepId !== result.stepId || settlement.sourceStepId !== result.stepId
      || settlement.resultKind !== result.kind || settlement.resultType !== result.type
      || typeof binding.attempt?.id !== "string" || !Number.isSafeInteger(binding.attempt?.sequence)) {
      throw new TypeError("Draft settlement receipt requires the exact Result binding");
    }
    if (executionLifecycle !== null && !(executionLifecycle instanceof DraftStepExecutionLifecycle)) {
      throw new TypeError("Draft settlement receipt execution lifecycle must be typed");
    }
    const reviewExecution = result instanceof DraftQuestionsReviewExecutionRequiredResult
      || result instanceof DraftCoverageReviewExecutionRequiredResult;
    const workerExecution = result instanceof DraftRefineWorkerRequiredResult
      || result instanceof DraftGateRepairWorkerRequiredResult;
    if (executionLifecycle !== null
      && ((reviewExecution && !(executionLifecycle.binding instanceof DraftReviewExecutionBinding))
        || (workerExecution && !(executionLifecycle.binding instanceof DraftWorkerExecutionBinding)))) {
      throw new TypeError("Draft settlement receipt execution binding does not match its Step Result");
    }
    const executionSettlement = settlement instanceof DraftExecutionSettlement;
    const awaitSettlement = settlement instanceof DraftAwaitUserDecision;
    if (awaitSettlement !== (awaitQuestion instanceof DraftAwaitQuestionIdentity)) {
      throw new TypeError("Draft Await settlement receipt requires its exact question identity");
    }
    const executionPhase = executionLifecycle?.phase ?? null;
    if ((["checkpoint", "claimed"].includes(executionPhase) && !executionSettlement)
      || (executionSettlement && !["checkpoint", "claimed", "publication"].includes(executionPhase))
      || (executionPhase === "publication" && !(executionSettlement || awaitSettlement))
      || (executionPhase === "terminal" && (executionSettlement || awaitSettlement))) {
      throw new TypeError("Draft settlement receipt execution phase does not match its Settlement");
    }
    this.binding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence,
    });
    this.resultKind = result.kind;
    this.resultType = result.type;
    this.resultDigest = stepResultDigest(result);
    this.settlementKind = settlement.kind;
    this.targetStepId = settlement instanceof StepRoute ? settlement.targetStepId : null;
    this.effects = settlement instanceof StepRoute ? settlement.effects : null;
    this.connector = settlement instanceof StepRoute
      ? Object.freeze({ name: settlement.connector.name })
      : null;
    this.publicationDigest = publication.digest;
    this.executionLifecycle = executionLifecycle;
    this.awaitQuestion = awaitQuestion;
    const identity = {
      binding: this.binding,
      resultKind: this.resultKind,
      resultType: this.resultType,
      resultDigest: this.resultDigest,
      settlementKind: this.settlementKind,
      targetStepId: this.targetStepId,
      effects: this.effects?.toJSON() ?? null,
      connector: this.connector,
      publicationDigest: this.publicationDigest,
      executionLifecycle: this.executionLifecycle?.toJSON() ?? null,
      awaitQuestion: this.awaitQuestion?.toJSON() ?? null,
    };
    this.id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    Object.freeze(this);
  }

  toJSON() {
    return {
      id: this.id,
      binding: { ...this.binding },
      resultKind: this.resultKind,
      resultType: this.resultType,
      resultDigest: this.resultDigest,
      settlementKind: this.settlementKind,
      targetStepId: this.targetStepId,
      effects: this.effects?.toJSON() ?? null,
      connector: this.connector === null ? null : { ...this.connector },
      publicationDigest: this.publicationDigest,
      executionLifecycle: this.executionLifecycle?.toJSON() ?? null,
      awaitQuestion: this.awaitQuestion?.toJSON() ?? null,
    };
  }
}

const DRAFT_STEP_EXECUTION_IDENTITY_TOKEN = Symbol("draft-step-execution-identity");

/** Step-selected execution identity rehydrated from one exact persisted receipt. */
export class DraftStepExecutionIdentity {
  constructor(token, { binding, receipt } = {}) {
    if (token !== DRAFT_STEP_EXECUTION_IDENTITY_TOKEN
      || !(receipt instanceof DraftStepSettlementReceiptValue)
      || receipt.binding?.runId !== binding?.runId
      || receipt.binding?.specId !== binding?.specId
      || receipt.binding?.stepId !== binding?.stepId
      || receipt.binding?.attemptId !== binding?.attempt?.id
      || receipt.binding?.attemptSequence !== binding?.attempt?.sequence
      || typeof receipt.id !== "string" || !SHA256_DIGEST.test(receipt.id)
      || receipt.settlementKind !== "execution") {
      throw new TypeError("Draft execution identity requires its exact persisted receipt");
    }
    const lifecycle = DraftStepExecutionLifecycle.fromJSON(
      receipt.executionLifecycle?.toJSON?.() ?? receipt.executionLifecycle,
    );
    if (!["checkpoint", "claimed", "publication"].includes(lifecycle.phase)) {
      throw new TypeError("Draft execution identity requires an executable lifecycle phase");
    }
    const stepResult = StepResult.fromStored(binding.stepId, {
      kind: receipt.resultKind,
      type: receipt.resultType,
    });
    if (stepResultDigest(stepResult) !== receipt.resultDigest) {
      throw new TypeError("Draft execution identity Result digest is invalid");
    }
    const settlement = settleDraftStepResult(binding.stepId, stepResult);
    if (!(settlement instanceof DraftExecutionSettlement)
      || settlement.kind !== receipt.settlementKind
      || settlement.resultKind !== receipt.resultKind
      || settlement.resultType !== receipt.resultType) {
      throw new TypeError("Draft execution identity Settlement is invalid");
    }
    this.receiptId = receipt.id;
    this.stepResult = stepResult;
    this.settlement = settlement;
    Object.freeze(this);
  }

  matches(stepResult, settlement) {
    return stepResult instanceof StepResult
      && settlement instanceof DraftExecutionSettlement
      && stepResult.stepId === this.stepResult.stepId
      && stepResultDigest(stepResult) === stepResultDigest(this.stepResult)
      && settlement.kind === this.settlement.kind
      && settlement.sourceStepId === this.settlement.sourceStepId
      && settlement.resultKind === this.settlement.resultKind
      && settlement.resultType === this.settlement.resultType;
  }
}

function draftStepExecutionIdentity(binding, receipt) {
  return new DraftStepExecutionIdentity(DRAFT_STEP_EXECUTION_IDENTITY_TOKEN, { binding, receipt });
}

function draftRefineReceiptMatchesBinding(receipt, binding) {
  return receipt?.binding?.runId === binding.runId
    && receipt.binding.specId === binding.specId
    && receipt.binding.stepId === "draft-refine"
    && receipt.binding.attemptId === binding.attempt.id
    && receipt.binding.attemptSequence === binding.attempt.sequence;
}

/**
 * Typed read model for the latest persisted draft-refine Result and same-Attempt
 * resume authority. Consumers ask semantic questions instead of interpreting
 * Result and Settlement string pairs independently.
 */
export class DraftRefineStepState {
  #selection;
  #settlement;
  #executionIdentity;

  constructor({
    binding,
    settlement = null,
    resume = null,
    resumeAfterSettlement = false,
    autoApprove = false,
  } = {}) {
    if (binding?.stepId !== "draft-refine"
      || typeof binding?.runId !== "string" || binding.runId === ""
      || typeof binding?.specId !== "string" || binding.specId === ""
      || typeof binding?.attempt?.id !== "string" || binding.attempt.id === ""
      || !Number.isSafeInteger(binding?.attempt?.sequence) || binding.attempt.sequence < 1) {
      throw new TypeError("Draft refine state requires its exact Attempt binding");
    }
    if (typeof resumeAfterSettlement !== "boolean") {
      throw new TypeError("Draft refine state resume ordering must be boolean");
    }
    if (typeof autoApprove !== "boolean") {
      throw new TypeError("Draft refine state requires the canonical autoApprove policy");
    }
    if (settlement !== null && !(settlement instanceof DraftStepSettlementReceiptValue)) {
      throw new TypeError("Draft refine settlement must be a typed receipt");
    }
    if (resume !== null && !(resume instanceof DraftQuestionResumeReceipt)) {
      throw new TypeError("Draft refine resume authority must be a typed receipt");
    }
    if (settlement !== null && !draftRefineReceiptMatchesBinding(settlement, binding)) {
      throw new TypeError("Draft refine settlement does not match its Attempt binding");
    }
    if (resume !== null && !draftRefineReceiptMatchesBinding(resume, binding)) {
      throw new TypeError("Draft refine resume receipt does not match its Attempt binding");
    }
    if (settlement === null) {
      if (resume !== null || resumeAfterSettlement) {
        throw new TypeError("Draft refine resume authority requires its persisted Await settlement");
      }
      this.#selection = "step-selection-required";
    } else {
      const workerExecution = settlement.resultKind === "draft-refine-worker-required"
        && settlement.resultType === "loop-required"
        && settlement.settlementKind === "execution"
        && settlement.awaitQuestion === null;
      const awaitingAnswer = settlement.resultKind === "draft-refine-awaiting-answer"
        && settlement.resultType === "user-input-required"
        && settlement.settlementKind === "await"
        && settlement.awaitQuestion !== null;
      if (!workerExecution && !awaitingAnswer) {
        throw new TypeError("Draft refine state has no resumable persisted Step Result");
      }
      const consumesLatestAwait = resume?.awaitReceiptId === settlement.id;
      if (resumeAfterSettlement !== consumesLatestAwait) {
        throw new TypeError("Draft refine resume ordering does not match its Await receipt");
      }
      if (resumeAfterSettlement && !awaitingAnswer) {
        throw new TypeError("Draft refine resume authority can consume only an Await settlement");
      }
      this.#selection = resumeAfterSettlement || (awaitingAnswer && autoApprove)
        ? "step-selection-required"
        : workerExecution ? "worker-execution" : "await-user-answer";
    }
    this.binding = Object.freeze({
      runId: binding.runId,
      specId: binding.specId,
      stepId: binding.stepId,
      attemptId: binding.attempt.id,
      attemptSequence: binding.attempt.sequence,
    });
    this.#settlement = settlement;
    this.#executionIdentity = this.#selection === "worker-execution"
      ? draftStepExecutionIdentity(binding, settlement)
      : null;
    this.resumeReceiptId = resume?.id ?? null;
    Object.freeze(this);
  }

  get requiresStepSelection() { return this.#selection === "step-selection-required"; }

  executionIdentity() {
    return this.#executionIdentity;
  }

  awaitQuestionIdentity() {
    return this.#selection === "await-user-answer"
      ? new DraftAwaitQuestionIdentity(this.#settlement.awaitQuestion)
      : null;
  }

  awaitReceiptFor({ questionId, questionRevision } = {}) {
    const identity = this.awaitQuestionIdentity();
    return identity !== null
      && identity.questionId === questionId
      && identity.questionRevision === questionRevision
      ? this.#settlement
      : null;
  }

  dispositionForQuestion(question = null) {
    if (this.requiresStepSelection) return null;
    if (this.#selection === "worker-execution") {
      return new DefinitionConditionalWorkerDisposition({
        stepId: "draft-refine",
        operation: "execute-worker",
      });
    }
    const identity = this.awaitQuestionIdentity();
    if (question?.id !== identity.questionId
      || question.revision !== identity.questionRevision
      || typeof question.question !== "string" || question.question.trim() === "") {
      throw new TypeError("Draft refine Await receipt does not select the canonical pending question");
    }
    return new DefinitionConditionalWorkerDisposition({
      stepId: "draft-refine",
      operation: "await-user-answer",
      questionId: identity.questionId,
      question: question.question,
      questionRevision: identity.questionRevision,
    });
  }
}

/** Select exactly one settlement from a concrete semantic Draft Step Result. */
export function settleDraftStepResult(stepId, result) {
  if (!(result instanceof StepResult) || result.stepId !== stepId) {
    throw new TypeError("draft settlement requires the Step's concrete Result");
  }
  if (result instanceof StepErrorResult) {
    return new StepErrorDecision(STEP_SETTLEMENT_TOKEN, result);
  }
  const route = (Route, targetStepId, connector) => {
    return new Route(STEP_SETTLEMENT_TOKEN, {
      result,
      targetStepId,
      connector,
      effects: draftRouteEffects(stepId, targetStepId),
    });
  };
  if (result instanceof DraftCreatedResult) {
    return route(DraftNextRoute, DRAFT_QUESTIONS_ROUTE.reviewStepId, DraftReviewConnector);
  }
  if (result instanceof DraftQuestionsReviewExecutionRequiredResult
    || result instanceof DraftCoverageReviewExecutionRequiredResult
    || result instanceof DraftRefineWorkerRequiredResult
    || result instanceof DraftGateRepairWorkerRequiredResult) {
    return new DraftExecutionSettlement(STEP_SETTLEMENT_TOKEN, result);
  }
  if (result instanceof DraftQuestionsReviewPassedResult) {
    return route(DraftNextRoute, "draft-refine", DraftRefineConnector);
  }
  if (result instanceof DraftQuestionsReviewFindingsResult) {
    return route(DraftBranchRoute, "draft-questions-triage", DraftTriageConnector);
  }
  if (result instanceof DraftQuestionsTriageCompletedResult) {
    return route(DraftNextRoute, "draft-questions-repair", DraftRepairConnector);
  }
  if (result instanceof DraftQuestionsRepairChangedResult) {
    return route(DraftLoopRoute, "draft-questions-review", DraftReviewConnector);
  }
  if (result instanceof DraftQuestionsRepairUnchangedResult) {
    return route(DraftNextRoute, "draft-refine", DraftRefineConnector);
  }
  if (result instanceof DraftRefineAwaitingAnswerResult) {
    return new DraftAwaitUserDecision(STEP_SETTLEMENT_TOKEN, result);
  }
  if (result instanceof DraftRefineCompletedResult) {
    return route(DraftNextRoute, "draft-coverage-review", DraftReviewConnector);
  }
  if (result instanceof DraftCoverageReviewPassedResult) {
    return route(DraftNextRoute, "draft-gate", DraftCompletionConnector);
  }
  if (result instanceof DraftCoverageReviewFindingsResult) {
    return route(DraftBranchRoute, "draft-coverage-triage", DraftTriageConnector);
  }
  if (result instanceof DraftCoverageTriageCompletedResult) {
    return route(DraftNextRoute, "draft-coverage-repair", DraftRepairConnector);
  }
  if (result instanceof DraftCoverageRepairChangedResult) {
    return route(DraftLoopRoute, "draft-coverage-review", DraftReviewConnector);
  }
  if (result instanceof DraftCoverageRepairUnchangedResult) {
    return route(DraftNextRoute, "draft-gate", DraftCompletionConnector);
  }
  if (result instanceof DraftGateRepairRequiredResult) {
    return route(DraftLoopRoute, "draft-gate-repair", PlanGateRepairConnector);
  }
  if (result instanceof DraftGatePassedResult || result instanceof DraftGateCarryForwardResult) {
    return route(DraftNextRoute, "spec", DraftSpecConnector);
  }
  if (result instanceof DraftGateRepairAppliedResult || result instanceof DraftGateRepairCarryForwardResult) {
    return route(DraftNextRoute, "draft-coverage-review", DraftReviewConnector);
  }
  throw new TypeError(`${stepId} has no settlement for ${result.kind}`);
}

/** Select exactly one settlement from a concrete semantic Spec Step Result. */
export function settleSpecStepResult(stepId, result) {
  if (!(result instanceof StepResult) || result.stepId !== stepId) {
    throw new TypeError("spec settlement requires the Step's concrete Result");
  }
  if (result instanceof StepErrorResult) {
    return new StepErrorDecision(STEP_SETTLEMENT_TOKEN, result);
  }
  if (result instanceof SpecCreatedResult) {
    return new SpecNextRoute(STEP_SETTLEMENT_TOKEN, {
      result,
      targetStepId: "spec-review",
      connector: SpecReviewConnector,
      effects: new StepRouteEffects(contiguousLeafRouteEffects(
        collectFlowLeafIds(), stepId, "spec-review",
      )),
    });
  }
  throw new TypeError(`${stepId} has no settlement for ${result.kind}`);
}

const DRAFT_REVIEW_ROUTE_EXPECTATIONS = Object.freeze([
  Object.freeze({
    route: DRAFT_QUESTIONS_ROUTE,
    triageStepId: "draft-questions-triage",
    repairStepId: "draft-questions-repair",
  }),
  Object.freeze({
    route: DRAFT_COVERAGE_ROUTE,
    triageStepId: "draft-coverage-triage",
    repairStepId: "draft-coverage-repair",
  }),
]);
for (const expectation of DRAFT_REVIEW_ROUTE_EXPECTATIONS) {
  if (
    expectation.route.triageStepId !== expectation.triageStepId
    || expectation.route.repairStepId !== expectation.repairStepId
  ) {
    throw new Error(`draft review route mismatch: ${expectation.triageStepId}`);
  }
}
const PLAN_REVIEW_MAX_ATTEMPTS_BY_ID = Object.freeze({
  "draft-questions-review": Object.freeze({ auto: 1, manual: 1 }),
  "draft-coverage-review": Object.freeze({ auto: 1, manual: 1 }),
  "spec-review": Object.freeze({ auto: 4, manual: 4 }),
  "test-review": Object.freeze({ auto: 5, manual: 5 }),
});

function createPlanReviewNode({ id, label, contextKinds, executionCommand }) {
  const maxAttempts = PLAN_REVIEW_MAX_ATTEMPTS_BY_ID[id];
  return new FlowNode({
    id,
    label,
    action: "run-review",
    instructionsKey: `plan.${id}`,
    contextKinds,
    outputSchemaRef: "next-action/review.schema.json",
    maxAttempts,
    toolingMaxAttempts: 1,
    failurePolicy: "retry",
    definitionLifecycleOwned: true,
    executionCommand,
    failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  });
}

function createDraftReviewLeafNode({ id, label }) {
  return new FlowNode({
    id,
    label,
    action: "write-draft",
    instructionsKey: `plan.${id}`,
    contextKinds: ["draft", "issue", "guardrail"],
    outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
    maxAttempts: 1,
  });
}

function createDraftReviewRouteNodes(route) {
  return [
    createDraftReviewLeafNode({
      id: route.triageStepId,
      label: `${route.label} triage`,
    }),
    createDraftReviewLeafNode({
      id: route.repairStepId,
      label: `${route.label} repair`,
    }),
  ];
}

// ── FLOW_DEFINITION ─────────────────────────────────────────────────────────

const FLOW_DEFINITION = Object.freeze([
  new FlowNode({
    id: "plan",
    label: "Plan",
    children: [
      new FlowNode({
        id: "branch",
        label: "Branch",
        action: "create-branch",
        instructionsKey: "plan.branch",
        contextKinds: [],
        skippable: true,
      }),
      new FlowNode({
        id: "prepare-spec",
        label: "Prepare spec",
        action: "prepare-spec",
        instructionsKey: "plan.prepare-spec",
        contextKinds: [],
      }),
      new FlowNode({
        id: "draft",
        label: "Draft",
        action: "write-draft",
        instructionsKey: "plan.draft",
        contextKinds: ["issue", "guardrail", "project_overview"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      createPlanReviewNode({
        id: "draft-questions-review",
        label: "Review (draft questions)",
        contextKinds: ["draft", "issue"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "draft"),
      }),
      ...createDraftReviewRouteNodes(DRAFT_QUESTIONS_ROUTE),
      new FlowNode({
        id: "draft-refine",
        label: "Draft refine",
        action: "write-draft",
        instructionsKey: "plan.draft-refine",
        contextKinds: ["draft", "issue", "guardrail", "project_overview"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "draft-gate-repair",
        label: "Draft Gate repair",
        action: "write-draft",
        instructionsKey: "plan.draft-gate-repair",
        contextKinds: ["draft", "issue", "guardrail", "project_overview"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      createPlanReviewNode({
        id: "draft-coverage-review",
        label: "Review (draft coverage)",
        contextKinds: ["draft", "issue"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "draft"),
      }),
      ...createDraftReviewRouteNodes(DRAFT_COVERAGE_ROUTE),
      new FlowNode({
        id: "draft-gate",
        label: "Gate (draft)",
        action: "run-gate",
        instructionsKey: "plan.draft-gate",
        contextKinds: ["draft", "guardrail"],
        outputSchemaRef: "next-action/gate.schema.json",
        maxAttempts: 5,
        gatePhase: ["draft"],
        failurePolicy: "step-definition",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("gate"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "spec",
        label: "Spec",
        action: "write-spec",
        instructionsKey: "plan.spec",
        contextKinds: ["draft", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
      }),
      createPlanReviewNode({
        id: "spec-review",
        label: "Review (spec)",
        contextKinds: ["spec", "guardrail"],
        executionCommand: new FlowExecutionCommand("review", "--phase", "spec"),
      }),
      new FlowNode({
        id: "spec-triage",
        label: "Spec review triage",
        action: "write-spec",
        instructionsKey: "plan.spec-triage",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "spec-repair",
        label: "Spec repair",
        action: "write-spec",
        instructionsKey: "plan.spec-repair",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "spec-gate",
        label: "Gate (spec)",
        action: "run-gate",
        instructionsKey: "plan.spec-gate",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/gate.schema.json",
        maxAttempts: 5,
        gatePhase: ["spec", "task-spec"],
        failurePolicy: "step-definition",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("gate"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "approval",
        label: "Approval",
        action: "await-approval",
        instructionsKey: "plan.approval",
        contextKinds: ["spec"],
        outputSchemaRef: "next-action/approval.schema.json",
        requiresApproval: true,
        autoApproveChoiceId: "1",
        sideEffects: ["syncSpecTasks"],
      }),
      new FlowNode({
        id: "test-generate",
        label: "Generate Requirement Test",
        action: "write-tests",
        instructionsKey: "plan.test",
        contextKinds: ["spec", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
      }),
      new FlowNode({
        id: "test-review",
        label: "Review Requirement Test",
        action: "run-review",
        instructionsKey: "plan.test-review",
        contextKinds: ["spec", "test", "guardrail"],
        outputSchemaRef: "next-action/review.schema.json",
        maxAttempts: 1,
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("review", "--phase", "test"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "test-repair",
        label: "Repair Requirement Test",
        action: "write-tests",
        instructionsKey: "plan.test-repair",
        contextKinds: ["spec", "test", "guardrail"],
        outputSchemaRef: "next-action/worker-artifact-handoff.schema.json",
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "test-gate",
        label: "Gate Requirement Test",
        action: "run-requirement-test-gate",
        instructionsKey: "plan.test-gate",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/requirement-test-gate.schema.json",
        maxAttempts: 3,
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("requirement-test-gate"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
    ],
  }),

  new FlowNode({
    id: "impl",
    label: "Implementation",
    children: [
      new FlowNode({
        id: "implement",
        label: "Implement",
        action: "run-impl",
        instructionsKey: "impl.implement",
        contextKinds: ["spec", "test", "overview"],
        outputSchemaRef: sourceWorkerEffectSchemaRef("implement"),
        maxAttempts: 3,
      }),
      new FlowNode({
        id: "test-execute",
        label: "Test Execute",
        action: "run-test-execute",
        instructionsKey: "impl.test-execute",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/test-execute.schema.json",
        maxAttempts: 3,
        failurePolicy: "test-chain-retry",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("test-execute"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      new FlowNode({
        id: "test-result-review",
        label: "Test Result Review",
        action: "run-test-result-review",
        instructionsKey: "impl.test-result-review",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/test-result-review.schema.json",
        maxAttempts: 3,
        failurePolicy: "test-chain-retry",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("test-result-review"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      new FlowNode({
        id: "impl-review",
        label: "Review",
        action: "run-review",
        instructionsKey: "impl.impl-review",
        contextKinds: ["spec", "diff", "testlog"],
        outputSchemaRef: "next-action/review.schema.json",
        maxAttempts: 4,
        toolingMaxAttempts: 1,
        failurePolicy: "retry",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("review", "--phase", "impl"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "impl-triage",
        label: "Implementation review triage",
        action: "write-impl-triage",
        instructionsKey: "impl.impl-triage",
        contextKinds: ["spec", "diff"],
        outputSchemaRef: sourceWorkerEffectSchemaRef("impl-triage"),
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "impl-repair",
        label: "Implementation repair",
        action: "run-impl-repair",
        instructionsKey: "impl.impl-repair",
        contextKinds: ["spec", "diff"],
        outputSchemaRef: sourceWorkerEffectSchemaRef("impl-repair"),
        maxAttempts: 3,
      }),
      new FlowNode({
        id: "impl-gate",
        label: "Gate (impl)",
        action: "run-gate",
        instructionsKey: "impl.impl-gate",
        contextKinds: ["spec", "diff", "testlog"],
        outputSchemaRef: "next-action/gate.schema.json",
        maxAttempts: 5,
        gatePhase: ["integration", "task-impl"],
        failurePolicy: "block",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("gate"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "retro",
        label: "Retrospective",
        action: "run-retro",
        instructionsKey: "impl.retro",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/retro.schema.json",
        maxAttempts: 2,
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("retro"),
        failureOwnership: DefinitionFailureOwnership.dispatcherPrimary(),
      }),
      new FlowNode({
        id: "acceptance-review",
        label: "Acceptance Review",
        action: "run-acceptance-review",
        instructionsKey: "impl.acceptance-review",
        contextKinds: ["spec", "diff", "test", "issue-log", "retro", "report"],
        outputSchemaRef: "next-action/acceptance-review.schema.json",
        maxAttempts: 1,
        sideEffects: ["promoteFinalRegression"],
        failurePolicy: "amend-spec",
        failureTargetId: "spec",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("acceptance-review"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "acceptance-decision",
        label: "Acceptance decision",
        action: "set-acceptance-decision",
        instructionsKey: "impl.acceptance-decision",
        contextKinds: ["spec", "diff", "test"],
        outputSchemaRef: "next-action/acceptance-review.schema.json",
        // This is a guarded, tokenless user-decision scene.  Its typed
        // await_user_decision directive is assembled by get-next-action;
        // it must never receive an approval token or autoApprove treatment.
        maxAttempts: 1,
      }),
      new FlowNode({
        id: "final-regression",
        label: "Final Regression",
        action: "run-final-regression",
        instructionsKey: "impl.final-regression",
        contextKinds: ["spec", "test"],
        outputSchemaRef: "next-action/final-regression.schema.json",
        maxAttempts: 2,
        // CurrentFlowState has no cataloged artifact facts.  It exposes a
        // route-neutral cursor only; FINAL_REGRESSION_STEP_DEFINITION owns
        // every failed route once the canonical facts boundary is available.
        failurePolicy: "step-definition",
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("final-regression"),
        failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
      }),
      new FlowNode({
        id: "report",
        label: "Report",
        action: "run-report",
        instructionsKey: "impl.report",
        contextKinds: ["spec", "diff", "test", "issue-log", "retro"],
        outputSchemaRef: "next-action/report.schema.json",
        maxAttempts: 2,
        definitionLifecycleOwned: true,
        executionCommand: new FlowExecutionCommand("report"),
        failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
      }),
      new FlowNode({
        id: "finalize",
        label: "Finalize",
        children: [
          new FlowNode({
            id: "finalize-commit",
            label: "Commit",
            action: "run-finalize-commit",
            instructionsKey: "impl.finalize-commit",
            contextKinds: ["spec", "diff"],
            outputSchemaRef: "next-action/finalize.schema.json",
            requiresApproval: true,
            autoApproveChoiceId: "1",
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-commit"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
          new FlowNode({
            id: "finalize-merge",
            label: "Merge",
            action: "run-finalize-merge",
            instructionsKey: "impl.finalize-merge",
            contextKinds: ["spec", "diff"],
            outputSchemaRef: "next-action/finalize.schema.json",
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-merge"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
          new FlowNode({
            id: "finalize-sync",
            label: "Sync",
            action: "run-finalize-sync",
            instructionsKey: "impl.finalize-sync",
            contextKinds: ["spec"],
            outputSchemaRef: "next-action/finalize.schema.json",
            // An interrupted sync has no durable worker result to retry. The
            // recovery path records its failed outbox Activity, then skips
            // this leaf so cleanup can retain the persisted evidence.
            skippable: true,
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-sync"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
          new FlowNode({
            id: "finalize-cleanup",
            label: "Cleanup",
            action: "run-finalize-cleanup",
            instructionsKey: "impl.finalize-cleanup",
            contextKinds: ["spec"],
            outputSchemaRef: "next-action/finalize.schema.json",
            definitionLifecycleOwned: true,
            executionCommand: new FlowExecutionCommand("finalize-cleanup"),
            failureOwnership: DefinitionFailureOwnership.lifecycleOutbox(),
          }),
        ],
      }),
    ],
  }),
]);

// ── TASK_DEFINITION ─────────────────────────────────────────────────────────

const TASK_DEFINITION = Object.freeze([
  new FlowNode({
    id: "task-impl",
    label: "Task impl",
    action: "run-impl",
    instructionsKey: "task.task-impl",
    contextKinds: canonicalTaskContextKinds("task-impl"),
    outputSchemaRef: sourceWorkerEffectSchemaRef("task-impl"),
    maxAttempts: 2,
  }),
  new FlowNode({
    id: "task-review",
    label: "Task review",
    action: "run-review",
    instructionsKey: "task.task-review",
    contextKinds: canonicalTaskContextKinds("task-review"),
    outputSchemaRef: "next-action/review.schema.json",
    maxAttempts: 4,
    toolingMaxAttempts: 1,
    failurePolicy: "retry",
    definitionLifecycleOwned: true,
    executionCommand: new FlowExecutionCommand("review", "--phase", "impl"),
    failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  }),
  new FlowNode({
    id: "task-triage",
    label: "Task review filter",
    action: "filter-task-review",
    instructionsKey: "task.task-review-filter",
    contextKinds: canonicalTaskContextKinds("task-triage"),
    outputSchemaRef: null,
    skippable: true,
    maxAttempts: 1,
  }),
  new FlowNode({
    id: "task-repair",
    label: "Task repair",
    action: "run-task-repair",
    instructionsKey: "task.task-repair",
    contextKinds: canonicalTaskContextKinds("task-repair"),
    outputSchemaRef: sourceWorkerEffectSchemaRef("task-repair"),
    skippable: true,
    maxAttempts: 3,
    toolingMaxAttempts: 1,
    failurePolicy: "retry-block",
  }),
  new FlowNode({
    id: "task-gate",
    label: "Task gate",
    action: "run-gate",
    instructionsKey: "impl.impl-gate",
    contextKinds: canonicalTaskContextKinds("task-gate"),
    outputSchemaRef: "next-action/gate.schema.json",
    skippable: true,
    maxAttempts: 5,
    failurePolicy: "block",
    definitionLifecycleOwned: true,
    executionCommand: new FlowExecutionCommand("gate"),
    failureOwnership: DefinitionFailureOwnership.commandPrimaryWithDispatcherFallback(),
  }),
]);

// ── Gate-phase collection ───────────────────────────────────────────────────

/**
 * Collect [phase, stepId] pairs from all gate nodes across FLOW_DEFINITION
 * and TASK_DEFINITION. Order follows definition order.
 */
export function collectGatePhaseEntries() {
  const entries = [];
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.children) {
        walk(node.children, depth + 1);
      } else if (node.gatePhase) {
        for (const phase of node.gatePhase) {
          entries.push([phase, node.id]);
        }
      }
    }
  }
  walk(FLOW_DEFINITION, 1);
  walk(TASK_DEFINITION, 1);
  return entries;
}

export function collectFlowLeafIds() {
  return collectLeafIds(FLOW_DEFINITION);
}

export function flowLeafIdsBetween(startId, endId) {
  const ids = collectFlowLeafIds();
  const start = ids.indexOf(startId);
  const end = ids.indexOf(endId);
  if (start < 0 || end < start) throw new Error(`flow definition range not found: ${startId}..${endId}`);
  return ids.slice(start, end + 1);
}

export function collectTaskLeafIds() {
  return collectLeafIds(TASK_DEFINITION);
}

export function deriveFlowPhaseMap() {
  return derivePhaseMap(FLOW_DEFINITION);
}

export function getFlowDefinitionOrder() {
  return collectFlowLeafIds();
}

export function getTaskDefinitionOrder() {
  return collectTaskLeafIds();
}

export function collectFlowNodes() {
  return [...FLOW_DEFINITION];
}

export function collectTaskNodes() {
  return [...TASK_DEFINITION];
}

const ADVISORY_SKIPPABLE_LEAF_IDS = new Set([
  "branch",
  "draft-questions-triage", "draft-questions-repair",
  "draft-coverage-triage", "draft-coverage-repair",
  "impl-triage", "impl-repair",
  "acceptance-decision",
]);

function definitionLeafIds(scope) {
  return scope === "task" ? collectTaskLeafIds() : collectFlowLeafIds();
}

function definitionNodeIsSkippable(scope, stepId) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.skippable === true || ADVISORY_SKIPPABLE_LEAF_IDS.has(stepId);
}

/**
 * Produce the explicit input contract for the next-generation state model.
 *
 * This is intentionally an adapter, not a converter: it reads the production
 * definition only and never reads or rewrites the currently deployed
 * flow.json.  The migration work can therefore select this contract without a
 * legacy-schema fallback or a double-write bridge.
 */
export function buildCurrentFlowDefinition() {
  // These fixed leaves may be bypassed only by the typed Requirement-test
  // initialization Activity when the approved Spec has no testable work.
  const requirementTestInitializationSkippable = new Set(REQUIREMENT_TEST_LEAF_IDS);
  const existingImplementationCompletion = new Set(["implement"]);
  const finalizationRouteLeaves = new Set(["finalize-sync", "finalize-cleanup"]);
  const taskOverrunRecoveryLeaves = new Set(["task-review", "task-triage", "task-repair"]);
  const taskStageBypassLeaves = new Set(["task-triage", "task-repair", "task-gate"]);
  const draftReviewBypassLeaves = new Set([
    DRAFT_QUESTIONS_ROUTE.triageStepId, DRAFT_QUESTIONS_ROUTE.repairStepId,
    DRAFT_COVERAGE_ROUTE.triageStepId, DRAFT_COVERAGE_ROUTE.repairStepId,
  ]);
  const transitionsFor = ({ skippable = false, conditionalWorker = false, triageNoRepair = false, taskStageBypass = false, draftReviewBypass = false, requirementTestInitialization = false, existingImplementation = false, finalizationRoute = false, taskOverrunRecovery = false, failurePolicy = null } = {}) => [
    "pending:in_progress",
    "in_progress:done",
    ...(skippable ? ["in_progress:skipped"] : []),
    // The impl-repair leaf may be skipped only by the typed all-reject
    // implementation-triage Activity. It can be pending on the normal
    // review route or invalidated on the acceptance-repair route.
    ...(triageNoRepair ? ["pending:skipped", "invalidated:skipped"] : []),
    ...(taskStageBypass ? ["pending:skipped", "invalidated:skipped"] : []),
    ...(draftReviewBypass ? ["pending:skipped", "invalidated:skipped"] : []),
    ...(conditionalWorker ? ["pending:skipped", "invalidated:skipped"] : []),
    // Reopening a draft invalidates every downstream leaf. Approval of the
    // revised Spec must still be able to apply the same typed empty-lifecycle
    // decision without manufacturing an intermediate pending state.
    ...(requirementTestInitialization ? ["pending:skipped", "invalidated:skipped"] : []),
    // This is consumed only by the Definition-selected stale Task-overrun
    // recovery Activity, which closes an accidentally opened extra round.
    ...(taskOverrunRecovery ? ["invalidated:done"] : []),
    ...(existingImplementation ? ["pending:done"] : []),
    // These suffix leaves are skipped/reset only by the typed
    // finalization-downstream Activity while finalize-merge is active.  The
    // definition still declares their reachable states so replay validation
    // remains an authority check rather than a persistence exception.
    ...(finalizationRoute ? ["pending:skipped", "skipped:pending"] : []),
    ...(["retry", "record", "step-definition"].includes(failurePolicy)
      ? ["in_progress:failed", "failed:in_progress", "failed:invalidated"]
      : []),
    "done:in_progress",
    "skipped:in_progress",
    "invalidated:in_progress",
    "pending:invalidated",
    "in_progress:invalidated",
    "done:invalidated",
    "skipped:invalidated",
  ];
  const transitionContract = (node, scope) => new CurrentFlowNodeContract({
    // Existing maxAttempts counts the initial Attempt.  The next-generation
    // contract keeps only retry budgets, so it subtracts that initial work.
    semanticRetryLimit: node.resolveMaxAttempts({ autoApprove: false }) - 1,
    // null remains an explicit zero-budget tooling policy in NodeContract.
    toolingRetryLimit: node.resolveToolingMaxAttempts({ autoApprove: false }),
    transitions: transitionsFor({
      ...node,
      triageNoRepair: node.id === "impl-repair",
      skippable: definitionNodeIsSkippable(scope, node.id),
      conditionalWorker: isConditionalDraftWorkerStep(node.id),
      requirementTestInitialization: requirementTestInitializationSkippable.has(node.id),
      existingImplementation: existingImplementationCompletion.has(node.id),
      finalizationRoute: finalizationRouteLeaves.has(node.id),
      taskOverrunRecovery: scope === "task" && taskOverrunRecoveryLeaves.has(node.id),
      taskStageBypass: scope === "task" && taskStageBypassLeaves.has(node.id),
      draftReviewBypass: scope === "flow" && draftReviewBypassLeaves.has(node.id),
    }),
    // Context requirements stay definition-owned. Current Attempt claims may
    // cover them as completed operations or typed incomplete operations, but
    // never copy the contract into flow.json.
    resourceContract: { required: node.contextKinds, authority: "definition" },
  });
  const actionMetadata = (node, sourceScopes) => ({
    action: node.action ?? null,
    instructionsKey: node.instructionsKey ?? null,
    contextKinds: [...node.contextKinds],
    outputSchemaRef: node.outputSchemaRef ?? null,
    requiresApproval: node.requiresApproval === true,
    autoApproveChoiceId: node.autoApproveChoiceId ?? null,
    maxAttempts: node.resolveMaxAttempts({ autoApprove: false }),
    sideEffects: node.sideEffects ? [...node.sideEffects] : null,
    failurePolicy: new DefinitionFailurePolicy(node.failurePolicy ?? "block", {
      targetNodeId: node.failureTargetId ?? null,
    }),
    executionCommand: node.executionCommand?.toString() ?? null,
    failureOwnership: node.failureOwnership,
    artifactAuthority: { sourceScopes },
  });
  const adapt = (node, kind = "step", sourceScopes = ["all_tasks", "flow"], scope = "flow") => new CurrentFlowDefinitionNode({
    kind,
    id: node.id,
    key: node.instructionsKey || node.id,
    contract: transitionContract(node, scope),
    steps: (node.children || []).map((child) => adapt(child, "step", sourceScopes, scope)),
    action: node.children ? null : actionMetadata(node, sourceScopes),
  });
  return new CurrentFlowDefinition({
    root: new CurrentFlowDefinitionNode({
      kind: "flow",
      id: "flow",
      key: "flow",
      contract: new CurrentFlowNodeContract({
        semanticRetryLimit: 0,
        toolingRetryLimit: null,
        resourceContract: { required: [], authority: "definition" },
        transitions: transitionsFor(),
      }),
      steps: FLOW_DEFINITION.map((node) => adapt(node, "step", ["all_tasks", "flow"], "flow")),
    }),
    taskTemplate: new CurrentFlowDefinitionNode({
      kind: "task",
      id: "task",
      key: "task",
      contract: new CurrentFlowNodeContract({
        semanticRetryLimit: 0,
        toolingRetryLimit: null,
        resourceContract: { required: [], authority: "definition" },
        transitions: transitionsFor(),
      }),
      steps: TASK_DEFINITION.map((node) => adapt(node, "step", ["same_task", "flow"], "task")),
    }),
    dynamicTaskContainerId: "impl",
    dynamicTaskInsertionAfterId: "implement",
  });
}

export function getFlowNode(id) {
  return resolveNodeFor(FLOW_DEFINITION, id);
}

export function getTaskNode(id) {
  return resolveNodeFor(TASK_DEFINITION, id);
}

/**
 * A straight-line source producer may carry an advisory only when Definition
 * guarantees a later, non-skippable quality checkpoint. Cyclic Task repair
 * uses the selected Task Review funnel plan below instead of this static map.
 */
export class SourceQualityIssueRecoveryRoute {
  constructor({ sourceStep, recoveryStep, scope } = {}) {
    this.sourceStep = requireString(sourceStep, "source quality issue source Step");
    this.recoveryStep = requireString(recoveryStep, "source quality issue recovery Step");
    if (!new Set(["flow", "task"]).has(scope)) throw new Error("source quality issue recovery scope is invalid");
    this.scope = scope;
    const source = scope === "task" ? getTaskNode(sourceStep) : getFlowNode(sourceStep);
    const recovery = scope === "task" ? getTaskNode(recoveryStep) : getFlowNode(recoveryStep);
    if (source === null || recovery === null) throw new Error("source quality issue recovery route is absent from the Definition");
    const leaves = definitionLeafIds(scope);
    if (leaves.indexOf(sourceStep) < 0 || leaves.indexOf(recoveryStep) <= leaves.indexOf(sourceStep)) {
      throw new Error("source quality issue recovery Step must be a forward Definition leaf");
    }
    if (definitionNodeIsSkippable(scope, recoveryStep)) throw new Error("source quality issue recovery Step must not be skippable");
    Object.freeze(this);
  }
  toJSON() { return { sourceStep: this.sourceStep, recoveryStep: this.recoveryStep, scope: this.scope }; }
}

const SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN = Symbol("source-quality-issue-recovery-plan");

/** A concrete quality checkpoint selected by Definition for one source result. */
export class SourceQualityIssueRecoveryPlan {
  constructor(token, { sourceStep, recoveryStep, scope, taskReviewStagePlan = null } = {}) {
    if (token !== SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN) {
      throw new Error("source quality issue recovery plans are created only by Definition");
    }
    this.sourceStep = requireString(sourceStep, "source quality issue source Step");
    this.recoveryStep = requireString(recoveryStep, "source quality issue recovery Step");
    if (!new Set(["flow", "task"]).has(scope)) throw new Error("source quality issue recovery scope is invalid");
    this.scope = scope;
    this.taskReviewStagePlan = taskReviewStagePlan;
    if (sourceStep === "task-repair") {
      if (!(taskReviewStagePlan instanceof TaskReviewStageTransitionPlan)
        || taskReviewStagePlan.facts.binding.stage !== "repair"
        || taskReviewStagePlan.facts.binding.sourceStepId !== `${taskReviewStagePlan.facts.binding.taskId}-repair`
        || taskReviewStagePlan.targetStepId !== recoveryStep
        || !new Set(["repair-to-review", "repair-unreviewed-to-gate"]).has(taskReviewStagePlan.operation)) {
        throw new Error("Task repair quality recovery must use its selected Task Review funnel plan");
      }
    } else if (taskReviewStagePlan !== null) {
      throw new Error("only Task repair quality recovery may carry a Task Review funnel plan");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      sourceStep: this.sourceStep,
      recoveryStep: this.recoveryStep,
      scope: this.scope,
      taskReviewStagePlan: this.taskReviewStagePlan?.toJSON() ?? null,
    };
  }
}

const SOURCE_QUALITY_ISSUE_RECOVERY_ROUTES = new Map([
  ["implement", new SourceQualityIssueRecoveryRoute({ sourceStep: "implement", recoveryStep: "impl-review", scope: "flow" })],
  ["impl-repair", new SourceQualityIssueRecoveryRoute({ sourceStep: "impl-repair", recoveryStep: "impl-gate", scope: "flow" })],
  ["task-impl", new SourceQualityIssueRecoveryRoute({ sourceStep: "task-impl", recoveryStep: "task-review", scope: "task" })],
]);

export function sourceQualityIssueRecoveryForStep(stepId) {
  if (typeof stepId !== "string") return null;
  return SOURCE_QUALITY_ISSUE_RECOVERY_ROUTES.get(stepId) ?? null;
}

export function resolveSourceQualityIssueRecoveryPlan({ sourceStep, taskId = null, taskReviewStagePlan = null } = {}) {
  if (sourceStep === "task-repair") {
    if (!(taskReviewStagePlan instanceof TaskReviewStageTransitionPlan)) {
      throw new Error("Task repair quality recovery requires its selected Task Review funnel plan");
    }
    return new SourceQualityIssueRecoveryPlan(SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN, {
      sourceStep,
      recoveryStep: taskReviewStagePlan.targetStepId,
      scope: "task",
      taskReviewStagePlan,
    });
  }
  const route = sourceQualityIssueRecoveryForStep(sourceStep);
  if (route === null) return null;
  const recoveryStep = route.scope === "task"
    ? `${requireString(taskId, "source quality issue Task")}-${route.recoveryStep.slice("task-".length)}`
    : route.recoveryStep;
  return new SourceQualityIssueRecoveryPlan(SOURCE_QUALITY_ISSUE_RECOVERY_PLAN_TOKEN, {
    sourceStep,
    recoveryStep,
    scope: route.scope,
  });
}

const TASK_REVIEW_STAGE_COMPLETION_PLAN_TOKEN = Symbol("task-review-stage-completion-plan");

/** One Definition decision binds Task stage advancement and any quality checkpoint. */
export class TaskReviewStageCompletionPlan {
  constructor(token, { transition, qualityRecovery = null, sourceQualityIssueCount = 0 } = {}) {
    if (token !== TASK_REVIEW_STAGE_COMPLETION_PLAN_TOKEN
      || !(transition instanceof TaskReviewStageTransitionPlan)) {
      throw new Error("Task Review stage completion plans are created only by Definition");
    }
    if (!Number.isSafeInteger(sourceQualityIssueCount) || sourceQualityIssueCount < 0) {
      throw new Error("Task Review stage source quality issue count is invalid");
    }
    if ((sourceQualityIssueCount > 0) !== (qualityRecovery instanceof SourceQualityIssueRecoveryPlan)) {
      throw new Error("Task Review stage quality issues require exactly one selected recovery plan");
    }
    if (qualityRecovery !== null && qualityRecovery.taskReviewStagePlan !== transition) {
      throw new Error("Task Review stage quality recovery must share its transition decision");
    }
    this.transition = transition;
    this.qualityRecovery = qualityRecovery;
    this.sourceQualityIssueCount = sourceQualityIssueCount;
    Object.freeze(this);
  }

  toJSON() {
    return {
      transition: this.transition.toJSON(),
      qualityRecovery: this.qualityRecovery?.toJSON() ?? null,
      sourceQualityIssueCount: this.sourceQualityIssueCount,
    };
  }
}

export function resolveTaskReviewStageCompletion({ facts, sourceQualityIssueCount = 0 } = {}) {
  const transition = resolveTaskReviewStageTransition(facts);
  const sourceStep = `task-${facts.binding.stage}`;
  const qualityRecovery = sourceQualityIssueCount === 0
    ? null
    : resolveSourceQualityIssueRecoveryPlan({ sourceStep, taskReviewStagePlan: transition });
  return new TaskReviewStageCompletionPlan(TASK_REVIEW_STAGE_COMPLETION_PLAN_TOKEN, {
    transition,
    qualityRecovery,
    sourceQualityIssueCount,
  });
}

export function resolveMaxAttempts({ scope = "flow", stepId, context = {} }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.resolveMaxAttempts(context) ?? null;
}

export function resolveToolingMaxAttempts({ scope = "flow", stepId, context = {} }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.resolveToolingMaxAttempts(context) ?? null;
}

export function resolveSideEffects({ scope = "flow", stepId }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.sideEffects ? [...node.sideEffects] : null;
}

export function isDefinitionLifecycleOwnedStep({ scope = "flow", stepId }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  return node?.definitionLifecycleOwned === true;
}

/**
 * Resolve the definition-owned command for a leaf that mutates canonical Flow
 * state.  The returned value keeps argv tokenized; callers must never recover
 * a command by parsing a human-readable instruction string.
 */
export function resolveDispatcherOwnedFlowAction({ scope = "flow", stepId }) {
  const node = scope === "task" ? getTaskNode(stepId) : getFlowNode(stepId);
  if (node?.definitionLifecycleOwned !== true) return null;
  return Object.freeze({
    action: node.action,
    executionCommand: node.executionCommand,
  });
}

export function deriveFlowPrereqs(targetId) {
  return derivePrereqs(FLOW_DEFINITION, targetId);
}

export function getFlowBranchLeafIds(parentId) {
  const parent = getFlowNode(parentId);
  if (!parent?.children) return [];
  return flattenSteps(parent.children).map((step) => step.id);
}

// ── Traversal helpers ───────────────────────────────────────────────────────

function assertDepth(depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(`definition depth exceeds maximum (${MAX_DEPTH})`);
  }
}

/**
 * Collect all leaf node IDs from a definition tree in document order.
 */
export function collectLeafIds(definition) {
  const ids = [];
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.children) {
        walk(node.children, depth + 1);
      } else {
        ids.push(node.id);
      }
    }
  }
  walk(definition, 1);
  return ids;
}

/**
 * Derive a phase map (leaf id → branch id) from a definition tree.
 */
export function derivePhaseMap(definition) {
  const map = {};
  function walk(nodes, parentId, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.children) {
        walk(node.children, node.id, depth + 1);
      } else {
        map[node.id] = parentId;
      }
    }
  }
  walk(definition, null, 1);
  return map;
}

/**
 * Look up a node by id (any depth) in the definition tree.
 */
export function resolveNodeFor(definition, id) {
  function walk(nodes, depth) {
    assertDepth(depth);
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = walk(node.children, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(definition, 1);
}

/**
 * Find the currently active (in_progress) leaf in a nested steps structure,
 * matching against the definition tree for navigation.
 *
 * Returns `{ scope: "flow"|"task", taskId, stepId }` or null.
 */
export function findActiveNode({ steps, tasks, currentTaskId }) {
  if (currentTaskId != null && Array.isArray(tasks)) {
    const task = tasks.find((t) => t.id === currentTaskId);
    if (task && Array.isArray(task.steps)) {
      const step = findLatestInProgressLeaf(task.steps, TASK_DEFINITION);
      if (step) return { scope: "task", taskId: currentTaskId, stepId: step.id };
    }
  }
  const step = findLatestInProgressLeaf(steps, FLOW_DEFINITION);
  if (step) return { scope: "flow", taskId: null, stepId: step.id };
  return null;
}

export function taskIdForResolvedStep(activeNode, targetStepId) {
  return activeNode?.stepId === targetStepId ? activeNode.taskId : null;
}

const MAX_IN_PROGRESS_STEP_SCAN = 500;
const DEFINITION_ORDER_CACHE = new WeakMap();

function scanLatestInProgressLeaf(steps, order, state, depth = 1) {
  assertDepth(depth);
  if (!Array.isArray(steps)) return state;
  for (const s of steps) {
    state.scanned += 1;
    if (state.scanned > MAX_IN_PROGRESS_STEP_SCAN) {
      throw new Error(`too many flow steps while resolving active step (max ${MAX_IN_PROGRESS_STEP_SCAN})`);
    }
    if (s.children) {
      scanLatestInProgressLeaf(s.children, order, state, depth + 1);
      continue;
    }
    if (s.status === "in_progress") {
      if (!order.has(s.id)) {
        if (!state.unknownStep) state.unknownStep = s;
        continue;
      }
      const index = order.get(s.id);
      if (!state.step || index >= state.index) {
        state.step = s;
        state.index = index;
      }
    }
  }
  return state;
}

function orderMapForDefinition(definition) {
  let order = DEFINITION_ORDER_CACHE.get(definition);
  if (!order) {
    order = new Map(collectLeafIds(definition).map((id, idx) => [id, idx]));
    DEFINITION_ORDER_CACHE.set(definition, order);
  }
  return order;
}

export function findLatestInProgressLeaf(steps, definition = FLOW_DEFINITION) {
  const order = orderMapForDefinition(definition);
  const selected = scanLatestInProgressLeaf(
    steps,
    order,
    { step: null, unknownStep: null, index: -1, scanned: 0 },
  );
  return selected.unknownStep || selected.step;
}

/**
 * Derive the next action envelope fields from the definition for a given step.
 *
 * Returns definition-owned action metadata, including the declared executionCommand,
 * for the step identified by `scope` ("flow" or "task") and `stepId`.
 */
export function deriveNextAction({ scope = "flow", stepId, context = {} }) {
  const def = scope === "task" ? TASK_DEFINITION : FLOW_DEFINITION;
  const node = resolveNodeFor(def, stepId);
  if (!node) return null;
  return {
    action: node.action,
    instructionsKey: node.instructionsKey,
    contextKinds: [...node.contextKinds],
    outputSchemaRef: node.outputSchemaRef,
    requiresApproval: node.requiresApproval,
    autoApproveChoiceId: node.autoApproveChoiceId,
    maxAttempts: node.resolveMaxAttempts(context),
    sideEffects: node.sideEffects ? [...node.sideEffects] : null,
    failurePolicy: node.failurePolicy,
    executionCommand: node.executionCommand?.toString() ?? null,
  };
}

/**
 * Build initial nested steps from the definition tree.
 * Branch nodes get `{ id, status: "pending", children: [...] }`;
 * leaf nodes get `{ id, status: "pending" }`.
 *
 * The first leaf is promoted to "in_progress".
 */
export function buildInitialNestedSteps(definition = FLOW_DEFINITION) {
  function buildNode(node) {
    if (node.children) {
      return { id: node.id, status: "pending", children: node.children.map(buildNode) };
    }
    return { id: node.id, status: "pending" };
  }
  const steps = definition.map(buildNode);
  const firstLeaf = findFirstPendingLeaf(steps);
  if (firstLeaf) firstLeaf.status = "in_progress";
  return steps;
}

/**
 * Build initial task-level steps from TASK_DEFINITION.
 */
export function buildInitialTaskSteps() {
  return TASK_DEFINITION.map((node) => ({ id: node.id, status: "pending" }));
}

/**
 * Derive prerequisite step ids for a given target step from the definition.
 * Prerequisites are all leaf steps in branches that appear before the target's
 * branch in the definition.
 */
export function derivePrereqs(definition, targetId) {
  const targetBranchIdx = findBranchIndexForLeaf(definition, targetId);
  if (targetBranchIdx < 0) return [];

  const prereqs = [];
  for (let i = 0; i < targetBranchIdx; i++) {
    const branch = definition[i];
    if (branch.children) {
      const lastLeaf = getLastLeaf(branch.children);
      if (lastLeaf) prereqs.push(lastLeaf.id);
    }
  }
  return prereqs;
}

function findBranchIndexForLeaf(definition, leafId) {
  for (let i = 0; i < definition.length; i++) {
    const branch = definition[i];
    if (branch.id === leafId) return i;
    if (branch.children && resolveNodeFor([branch], leafId)) return i;
  }
  return -1;
}

function getLastLeaf(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.children) {
      const found = getLastLeaf(n.children);
      if (found) return found;
    } else {
      return n;
    }
  }
  return null;
}

/**
 * Check if a step is a branch containing a leaf with the given id.
 * Returns the branch node or null.
 */
export function findBranchForLeaf(definition, leafId) {
  for (const branch of definition) {
    if (branch.children && resolveNodeFor([branch], leafId)) return branch;
  }
  return null;
}

export { FlowNode };

/** Explicit orphan reconciliation is not an automatic retry or semantic acceptance. */
export class TaskReviewReconciliationDecision {
  constructor({ state, catalog, activities }) {
    const nodeId = state.current?.at(-1);
    const node = nodeId ? state.findNode(nodeId) : null;
    const attempt = state.attempt;
    if (node?.key !== "task.task-review" || node.status !== "in_progress" || !attempt?.failure
      || !["tooling", "provider"].includes(attempt.failure.category)
      || state.failureDisposition()?.operation !== "record") {
      throw new Error("Definition does not authorize orphaned Task Review reconciliation");
    }
    const taskId = nodeId.slice(0, -"-review".length);
    const introduction = activities.find(a => a.nodeId === nodeId && a.transition.attempt?.id === attempt.id);
    const failure = activities.find(a => a.nodeId === nodeId && a.attemptId === attempt.id && a.transition.operation === "fail_attempt");
    if (!introduction || !["recover_attempt", "rewind"].includes(introduction.transition.operation) || !failure
      || catalog.artifacts.some(a => (["retry.recovery.baseline", "retry.recovery.receipt"].includes(a.logicalKey) && a.relativePath.endsWith(`/${attempt.id}.json`))
        || (a.logicalKey === "task.review" && a.relativePath === `steps/impl/${taskId}/review/result.json`)
        || (a.logicalKey === "task.review.reconciliation" && a.relativePath.startsWith(`steps/impl/${taskId}/review/recovery/reconciliations/`)))) {
      throw new Error("Task Review reconciliation requires an unpublished recovered Attempt without a baseline or prior reconciliation");
    }
    this.taskId = taskId;
    this.nodeId = nodeId;
    this.operation = "reconcile-task-review";
    Object.freeze(this);
  }
}

export function resolveTaskReviewReconciliation(facts) {
  return new TaskReviewReconciliationDecision(facts);
}
