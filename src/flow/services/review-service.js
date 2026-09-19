import {
  attachedCanonicalCommandResultArtifact,
  CanonicalCommandAttemptArtifactHistory,
} from "../lib/canonical-command-result.js";
import { DraftReviewArtifactDocument, DraftReviewEvidenceSet } from "../lib/draft-review-artifacts.js";
import { draftReviewRouteForStepId } from "../lib/draft-review-routes.js";
import { readCoveragePassDraftCompletionFacts } from "../lib/draft-completion-connector.js";
import { readCurrentGateTransitionFacts } from "../lib/gate-transition-facts.js";
import {
  DRAFT_STEP_ERROR_CATEGORY,
  resolveDraftCoverageRepairCompletion,
  resolveGateTransition,
} from "../definition.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../engine/step-output.js";
import {
  DraftGateEvaluationBinding,
  DraftReviewStepBinding,
} from "../engine/connectors/draft/draft-step-binding.js";
import { DraftStepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { persistReviewTransitionFacts } from "../lib/review-transition-persistence.js";

function hasCommittedStepOutput(flowManager, binding, stepOutput) {
  const node = flowManager.canonicalState(binding.specId)?.findNode(binding.stepId) ?? null;
  const persisted = node?.result?.stepOutput;
  if (node?.attemptSequence !== binding.attempt.sequence
    || persisted === null || persisted === undefined) return false;
  const activity = flowManager.activityLedger(binding.specId).findLast((entry) => (
    entry.nodeId === binding.stepId
      && entry.attemptId === binding.attempt.id
      && entry.sequence === binding.attempt.sequence
      && entry.result?.stepOutput !== null
      && entry.result?.stepOutput !== undefined
  ));
  return activity !== undefined
    && JSON.stringify(activity.result.stepOutput) === JSON.stringify(stepOutput.toJSON())
    && JSON.stringify(persisted.toJSON?.() ?? persisted) === JSON.stringify(stepOutput.toJSON());
}

function hasPublishedCommandResult(flowManager, binding, commandResult) {
  const attached = attachedCanonicalCommandResultArtifact(commandResult);
  if (attached === null) return false;
  let source;
  try {
    source = flowManager.readProducerArtifact({
      specId: binding.specId,
      nodeId: binding.stepId,
      logicalKey: attached.logicalKey,
      optional: true,
    });
    if (source === null) return false;
    const publication = flowManager.activityLedger(binding.specId).find((entry) => (
      entry.id === source.descriptor?.activityId
        && entry.nodeId === binding.stepId
        && entry.attemptId === binding.attempt.id
        && entry.sequence === binding.attempt.sequence
    ));
    if (publication === undefined) return false;
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: attached.logicalKey,
      bytes: source.bytes,
    });
    return history.current.attempt === binding.attempt.sequence
      && JSON.stringify(history.current.payload) === JSON.stringify(attached.payload);
  } catch {
    return false;
  }
}

/** Validate and publish the bound Draft Review command result. */
export class ReviewService {
  constructor({ flowManager, binding, commandResult }) {
    if (!flowManager || typeof flowManager.publishCurrentAttemptResult !== "function") {
      throw new TypeError("ReviewService requires canonical Review publication");
    }
    if (!(binding instanceof DraftReviewStepBinding)) {
      throw new TypeError("ReviewService requires a typed Draft review binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("ReviewService binding belongs to a different FlowManager");
    }
    const route = draftReviewRouteForStepId(binding.stepId);
    if (route === null) throw new Error(`ReviewService has no draft review route for ${binding.stepId}`);
    this.flowManager = flowManager;
    this.binding = binding;
    this.route = route;
    this.commandResult = commandResult;
    Object.freeze(this);
  }

  /** Validate the existing command result against its bound Draft revision. */
  inspectReviewResult(result = this.commandResult) {
    const state = this.#assertCurrent(this.route.reviewStepId);
    const artifact = attachedCanonicalCommandResultArtifact(result);
    if (artifact?.logicalKey !== this.route.reviewLogicalKey) {
      throw new Error("draft review command result does not match the bound review route");
    }
    const document = DraftReviewArtifactDocument.fromStored(artifact.payload);
    if (!(this.binding instanceof DraftReviewStepBinding)
      || JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new Error("draft review command result does not match the bound canonical Draft revision");
    }
    this.#validate({ state, review: document });
    return document;
  }

  /**
   * Persist the command observation and the Step-selected outcome.  The
   * coverage PASS connector is a distinct Store operation because it carries
   * the completed Draft forward without rewriting its bytes.
   */
  commitReviewResult(stepOutput, inspectedReview = null) {
    if (!(stepOutput instanceof StepOutput) || stepOutput.type === STEP_OUTPUT_TYPE.ERROR) {
      throw new TypeError("Draft Review completion requires a non-error StepOutput");
    }
    const document = inspectedReview ?? this.inspectReviewResult();
    if (!(document instanceof DraftReviewArtifactDocument)) {
      throw new TypeError("Draft Review completion requires an inspected review document");
    }
    this.#assertCurrent(this.route.reviewStepId);
    if (JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(this.binding.revision)) {
      throw new Error("draft review completion does not match the bound canonical Draft revision");
    }
    try {
      this.flowManager.publishCurrentAttemptResult({
        specId: this.binding.specId,
        commandResult: this.commandResult,
      });
    } catch (error) {
      if (!hasPublishedCommandResult(this.flowManager, this.binding, this.commandResult)) {
        throw new DraftStepPersistenceFailure(error);
      }
    }
    try {
      // Retry accounting is an observation of this published result. Keep it
      // before the Step settlement so a metric write failure leaves the exact
      // Attempt active and can be retried from the same canonical result.
      persistReviewTransitionFacts({
        flowManager: this.flowManager,
        flowState: this.flowManager.loadReadOnly(this.binding.specId),
        specId: this.binding.specId,
      }, this.commandResult);
      if (this.route.key === "coverage" && stepOutput.type === STEP_OUTPUT_TYPE.COMPLETED) {
        const facts = readCoveragePassDraftCompletionFacts({
          flowManager: this.flowManager,
          specId: this.binding.specId,
          sourceStepId: this.binding.stepId,
        });
        this.flowManager.confirmDraftCoverageRepairCompletion({
          specId: this.binding.specId,
          decision: resolveDraftCoverageRepairCompletion(facts),
          draft: facts.draft,
          stepOutput,
        });
      } else {
        this.flowManager.confirmCurrentAttempt({ specId: this.binding.specId, stepOutput });
      }
      return document;
    } catch (error) {
      if (hasCommittedStepOutput(this.flowManager, this.binding, stepOutput)) {
        return document;
      }
      throw new DraftStepPersistenceFailure(error);
    }
  }

  /** Persist a Step execution error against this exact bound Attempt. */
  commitStepError(stepOutput) {
    if (!(stepOutput instanceof StepOutput) || stepOutput.type !== STEP_OUTPUT_TYPE.ERROR) {
      throw new TypeError("Draft Review Step Error requires an error StepOutput");
    }
    const error = stepOutput.error;
    try {
      this.binding.assertCurrent();
      this.flowManager.failCurrentAttempt({
        specId: this.binding.specId,
        failure: {
          category: DRAFT_STEP_ERROR_CATEGORY,
          code: error?.code || "DRAFT_REVIEW_STEP_ERROR",
          message: stepOutput.error.message,
          retryable: false,
          retryKind: null,
        },
        stepOutput,
      });
    } catch (cause) {
      if (hasCommittedStepOutput(this.flowManager, this.binding, stepOutput)) return;
      throw new DraftStepPersistenceFailure(cause);
    }
  }

  #assertCurrent(expectedStepId) {
    if (this.binding.stepId !== expectedStepId) {
      throw new Error(`ReviewService ${expectedStepId} operation requires its bound Step`);
    }
    return this.binding.assertCurrent();
  }

  #validate({ state, review }) {
    const evidence = new DraftReviewEvidenceSet({
      route: this.route,
      state,
      reviewFile: { document: review.toJSON() },
    });
    const issues = evidence.validateReview({ validateBinding: false });
    if (issues.length > 0) throw new Error(issues.join("; "));
  }
}

/** Persist one evaluated Draft Gate and the Step-selected transition. */
export class GateService {
  constructor({ flowManager, binding, commandResult }) {
    if (!flowManager || typeof flowManager.publishCurrentAttemptResult !== "function"
      || typeof flowManager.commitDraftGateTransition !== "function") {
      throw new TypeError("GateService requires canonical Gate publication and settlement");
    }
    if (!(binding instanceof DraftGateEvaluationBinding)) {
      throw new TypeError("GateService requires a typed Draft Gate evaluation binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("GateService binding belongs to a different FlowManager");
    }
    if (attachedCanonicalCommandResultArtifact(commandResult)?.logicalKey !== "draft.gate") {
      throw new Error("GateService requires the evaluated Draft Gate result");
    }
    this.flowManager = flowManager;
    this.binding = binding;
    this.commandResult = commandResult;
    Object.freeze(this);
  }

  /**
   * Make the common command's observation durable once and return the
   * Definition-selected disposition for the Step to turn into StepOutput.
   */
  async prepareGateResult() {
    this.binding.assertCurrent();
    try {
      this.flowManager.publishCurrentAttemptResult({
        specId: this.binding.specId,
        commandResult: this.commandResult,
      });
    } catch (error) {
      if (!hasPublishedCommandResult(this.flowManager, this.binding, this.commandResult)) {
        throw new DraftStepPersistenceFailure(error);
      }
    }
    // Resolving the published observation is part of Step evaluation. A
    // stale or malformed observation must become the Step's Error result;
    // only publication failure is a persistence failure.
    const decision = this.#decision();
    return decision;
  }

  /** Apply the previously prepared, Definition-selected Gate transition. */
  async commitGateResult({ decision, stepOutput }) {
    if (!(stepOutput instanceof StepOutput) || stepOutput.type === STEP_OUTPUT_TYPE.ERROR) {
      throw new TypeError("Draft Gate completion requires a non-error StepOutput");
    }
    try {
      return await this.flowManager.commitDraftGateTransition({
        specId: this.binding.specId,
        decision,
        stepOutput,
      });
    } catch (error) {
      if (hasCommittedStepOutput(this.flowManager, this.binding, stepOutput)) {
        return this.flowManager.canonicalState(this.binding.specId);
      }
      throw new DraftStepPersistenceFailure(error);
    }
  }

  /** Persist a Step execution error against this exact bound Attempt. */
  commitStepError(stepOutput) {
    if (!(stepOutput instanceof StepOutput) || stepOutput.type !== STEP_OUTPUT_TYPE.ERROR) {
      throw new TypeError("Draft Gate Step Error requires an error StepOutput");
    }
    const error = stepOutput.error;
    try {
      this.binding.assertCurrent();
      this.flowManager.failCurrentAttempt({
        specId: this.binding.specId,
        failure: {
          category: DRAFT_STEP_ERROR_CATEGORY,
          code: error?.code || "DRAFT_GATE_STEP_ERROR",
          message: stepOutput.error.message,
          retryable: false,
          retryKind: null,
        },
        stepOutput,
      });
    } catch (cause) {
      if (hasCommittedStepOutput(this.flowManager, this.binding, stepOutput)) return;
      throw new DraftStepPersistenceFailure(cause);
    }
  }

  #decision() {
    const facts = readCurrentGateTransitionFacts({
      flowManager: this.flowManager,
      flowState: this.flowManager.loadReadOnly(this.binding.specId),
      phase: "draft",
    });
    if (facts === null) throw new Error("Draft Gate result was not published for its bound Attempt");
    return resolveGateTransition(facts);
  }
}
