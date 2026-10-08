import {
  DraftReviewExecutionBinding, DraftReviewExecutionClaim, DraftReviewExecutionTargetIdentity,
  ReviewProviderRequestIdentity, settleSpecStepResult,
} from "../definition.js";
import { SpecReviewExecutionRequiredResult, SpecReviewPassedResult, SpecReviewAdvisoryResult,
  SpecReviewRejectedResult } from "../engine/step-result.js";
import { SpecReviewStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { recoverStepSettlementReceipt } from "./definition-lifecycle-failure.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { claimDraftReviewExecution } from "./draft-review-execution-claim.js";
import { ReviewWorkUnitManifest } from "./review-work-unit-values.js";
import { CurrentFlowStateInvariantError, ActivityReviewPublication, NodeResult,
  assertDraftSettlementReceiptTransition } from "./current-flow-state.js";
import { CurrentFlowStateConflictError } from "./current-flow-state-conflict-error.js";
import { SpecReviewExecutionAdmission, SpecReviewExecutionClaimPreparation,
  SpecReviewPublicationPreparation, ReviewExecutionClaimPreparation, ReviewExecutionAdmission } from "./spec-review-operations-values.js";

export class SpecReviewOperations {
  static prepareExecutionClaim(input) {
    const binding = new SpecReviewStepBinding({ flowManager: input.flowManager, specId: input.state.specId });
    return prepareReviewExecutionClaim({ ...input, binding, ResultClass: SpecReviewExecutionRequiredResult,
      PreparationClass: SpecReviewExecutionClaimPreparation });
  }

  static commitExecutionClaim(preparation) {
    if (!(preparation instanceof SpecReviewExecutionClaimPreparation)) {
      throw new TypeError("Spec Review claim requires its prepared execution identity");
    }
    return new SpecReviewExecutionAdmission(commitReviewExecutionClaim(preparation));
  }

  static publish({ flowManager, specId, commandResult }) {
    const binding = new SpecReviewStepBinding({ flowManager, specId });
    const identity = flowManager.draftStepExecutionState({ binding }).executionIdentity();
    if (!(identity?.stepResult instanceof SpecReviewExecutionRequiredResult)) {
      throw new StepAdmissionRefusal("Spec Review publication requires its persisted execution selection");
    }
    const input = {
      binding,
      stepResult: identity.stepResult,
      settlement: identity.settlement,
      commandResult,
    };
    try {
      return flowManager.settleSpecStepResult(input);
    } catch (error) {
      if (error instanceof CurrentFlowStateConflictError
        || error instanceof CurrentFlowStateInvariantError) throw error;
      const receipt = recoverStepSettlementReceipt(flowManager, input, error);
      return { state: flowManager.canonicalState(specId), receipt };
    }
  }

  static async preparePublication({ flowManager, state }) {
    const latest = flowManager.canonicalState(state.specId);
    if (latest.current?.at(-1) !== "spec-review") {
      const result = await this.terminalReplay({ flowManager, state: latest });
      return result === null ? null : new SpecReviewPublicationPreparation({ result });
    }
    const binding = new SpecReviewStepBinding({ flowManager, specId: state.specId });
    const execution = flowManager.draftStepExecutionState({ binding });
    if (execution.lifecycle?.phase !== "publication") return null;
    const read = flowManager.readCurrentSpecReviewInput({
      specId: state.specId, consumerNodeId: binding.stepId,
    });
    const activity = flowManager.activityLedger(state.specId).find((entry) => (
      entry.id === read.descriptor?.activityId
      && entry.result?.draftSettlementReceipt?.id === execution.receiptId
    ));
    if (activity === undefined || !read.persisted || read.review.audit.at(-1)?.stage !== "spec-review") {
      throw new Error("Spec Review publication does not match its execution receipt");
    }
    return new SpecReviewPublicationPreparation({ binding, reviewDigest: read.review.digest });
  }

  static resultFromStepResult(stepResult, reviewDigest) {
    const verdict = stepResult instanceof SpecReviewRejectedResult ? "REJECTED"
      : stepResult instanceof SpecReviewAdvisoryResult ? "ADVISORY"
        : stepResult instanceof SpecReviewPassedResult ? "PASS" : null;
    if (verdict === null) throw new TypeError("Spec Review projection requires an accepted Step Result");
    return {
      result: "ok", changed: [],
      artifacts: { phase: "spec", verdict, canonicalVerdict: verdict, reviewDigest },
    };
  }

  /** Exact terminal replay is read-only and cannot select another Result. */
  static async terminalReplay({ flowManager, state }) {
    if (state?.current?.at(-1) !== "spec-triage"
      && !(state?.current === null && state.nextAction()?.nodeId === "spec-triage")) return null;
    const activities = flowManager.activityLedger(state.specId);
    const terminalActivity = activities.findLast((entry) => (
      entry.nodeId === "spec-review"
      && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal"
    )) ?? null;
    const terminalResult = terminalActivity === null ? null : new NodeResult(terminalActivity.result);
    const terminal = terminalResult?.draftSettlementReceipt ?? null;
    if (terminal === null) return null;
    if (terminal.binding.runId !== state.runId
      || terminal.binding.specId !== state.specId
      || terminal.binding.stepId !== "spec-review"
      || terminal.binding.attemptId !== terminalActivity.attemptId
      || terminal.binding.attemptSequence !== terminalActivity.sequence
      || state.findNode("spec-review")?.result?.draftSettlementReceipt?.id !== terminal.id
      || terminal.targetStepId !== "spec-triage") {
      throw new Error("Spec Review terminal replay has no exact terminal settlement");
    }
    const publication = activities.findLast((entry) => {
      const receipt = entry.result?.draftSettlementReceipt;
      return entry.nodeId === "spec-review"
        && receipt?.executionLifecycle?.phase === "publication"
        && receipt.binding.runId === terminal.binding.runId
        && receipt.binding.specId === terminal.binding.specId
        && receipt.binding.stepId === terminal.binding.stepId
        && receipt.binding.attemptId === terminal.binding.attemptId
        && receipt.binding.attemptSequence === terminal.binding.attemptSequence;
    });
    if (publication !== undefined) {
      const publishedResult = new NodeResult(publication.result);
      const publishedReceipt = publishedResult.draftSettlementReceipt;
      if (publication.attemptId !== terminal.binding.attemptId
        || publication.sequence !== terminal.binding.attemptSequence
        || publishedReceipt.executionLifecycle?.phase !== "publication") {
        throw new CurrentFlowStateConflictError("Spec Review publication does not match its terminal Attempt");
      }
      assertDraftSettlementReceiptTransition([publishedReceipt], terminal);
    }
    const read = flowManager.readCurrentSpecReview({
      specId: state.specId, consumerNodeId: "spec-triage",
    });
    if (read === null || publication?.id !== read.descriptor?.activityId
      || read.descriptor.hash !== read.review.digest
      || publication.reviewPublication?.stage !== "spec-review") {
      throw new Error("Spec Review terminal replay has no exact canonical publication");
    }
    new ActivityReviewPublication(publication.reviewPublication).assertReview(read.review, {
      specId: state.specId,
      revision: read.review.identity.revision.value,
      bytes: read.bytes,
    });
    const selected = terminalResult.stepResult;
    const settlement = settleSpecStepResult("spec-review", selected);
    if (settlement.kind !== terminal.settlementKind
      || settlement.targetStepId !== terminal.targetStepId
      || settlement.connector.name !== terminal.connector?.name
      || JSON.stringify(settlement.effects.toJSON()) !== JSON.stringify(terminal.effects?.toJSON())) {
      throw new Error("Spec Review terminal replay conflicts with its canonical Result");
    }
    return this.resultFromStepResult(selected, read.review.digest);
  }

}

/** Acquire one exact immutable semantic Review claim for any registered Review leaf. */
export function prepareReviewExecutionClaim({ flowManager, binding, state, manifest, skipConfirm,
  ResultClass, PreparationClass = ReviewExecutionClaimPreparation }) {
  if (!(manifest instanceof ReviewWorkUnitManifest)
    || manifest.runId !== state.runId || manifest.specId !== state.specId
    || manifest.attemptId !== state.attempt?.id
    || manifest.nodeId !== (binding.nodeId ?? binding.stepId)
    || binding.runId !== state.runId || binding.specId !== state.specId) {
    throw new StepAdmissionRefusal("Review execution requires its exact work unit manifest");
  }
  const executionState = flowManager.draftStepExecutionState({ binding });
  const current = executionState.lifecycle;
  const target = new DraftReviewExecutionTargetIdentity(manifest.target.toJSON());
  const executionBinding = current === null
    ? executionState.reviewBinding({
        manifestDigest: manifest.digest, inputDigest: manifest.inputDigest, target,
      })
    : new DraftReviewExecutionBinding({
        executionGeneration: current.executionGeneration,
        manifestDigest: manifest.digest, inputDigest: manifest.inputDigest, target,
      });
  if (current !== null && !current.binding.equals(executionBinding)) {
    throw new StepAdmissionRefusal("the rebuilt Review work unit differs from its durable execution binding");
  }
  if (current !== null && !["checkpoint", "claimed"].includes(current.phase)) {
    throw new StepAdmissionRefusal("the Review execution already has a durable publication");
  }
  const request = new ReviewProviderRequestIdentity({ skipConfirm });
  if (current?.phase === "claimed" && !current.claim.request?.equals(request)) {
    throw new StepAdmissionRefusal("the Review provider request differs from its durable claim");
  }
  return new PreparationClass({
    flowManager, binding, executionBinding, request, ResultClass,
    recoveredClaim: current?.phase === "claimed", needsCheckpoint: current === null,
  });
}

/** Save the acquired provider claim without recomputing its execution selection. */
export function commitReviewExecutionClaim(preparation) {
  if (!(preparation instanceof ReviewExecutionClaimPreparation)) {
    throw new TypeError("Review claim requires its prepared execution identity");
  }
  const { flowManager, binding, executionBinding, request, recoveredClaim } = preparation;
  const identity = flowManager.draftStepExecutionState({ binding }).executionIdentity();
  if (!(identity?.stepResult instanceof preparation.ResultClass)) {
    throw new Error("Review execution lacks its persisted Step selection");
  }
  claimDraftReviewExecution({
    flowManager,
    binding,
    stepResult: identity.stepResult,
    settlement: identity.settlement,
    executionBinding,
    executionClaim: new DraftReviewExecutionClaim({ request }),
  });
  const persistedClaim = flowManager.draftStepExecutionState({ binding }).lifecycle.claim;
  return new ReviewExecutionAdmission({
    request: persistedClaim.request,
    recoveredClaim,
  });
}
