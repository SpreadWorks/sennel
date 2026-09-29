import {
  DraftExecutionSettlement,
  DraftReviewExecutionBinding,
  DraftReviewExecutionClaim,
  DraftReviewExecutionTargetIdentity,
  DraftStepExecutionLifecycle,
  ReviewProviderRequestIdentity,
  settleSpecStepResult,
} from "../definition.js";
import {
  SpecReviewExecutionRequiredResult,
  SpecReviewPassedResult,
  SpecReviewAdvisoryResult,
  SpecReviewRejectedResult,
  StepResult,
} from "../engine/step-result.js";
import { SpecReviewStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { recoverStepSettlementReceipt } from "../lib/definition-lifecycle-failure.js";
import { StepAdmissionRefusal } from "../lib/step-admission-refusal.js";
import { ReviewService } from "./review-service.js";
import { ReviewWorkUnitManifest } from "../lib/review-work-unit-values.js";
import {
  CurrentFlowStateInvariantError,
  ActivityReviewPublication,
  NodeResult,
  assertDraftSettlementReceiptTransition,
} from "../lib/current-flow-state.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state-conflict-error.js";

export class SpecReviewExecutionAdmission {
  constructor({ request, recoveredClaim }) {
    if (!(request instanceof ReviewProviderRequestIdentity) || typeof recoveredClaim !== "boolean") {
      throw new TypeError("Spec Review execution admission requires its request and claim status");
    }
    this.request = request;
    this.recoveredClaim = recoveredClaim;
    Object.freeze(this);
  }
}

export class SpecReviewExecutionClaimPreparation {
  constructor({ flowManager, binding, executionBinding, request, recoveredClaim, needsCheckpoint }) {
    if (!(binding instanceof SpecReviewStepBinding) || binding.flowManager !== flowManager
      || !(executionBinding instanceof DraftReviewExecutionBinding)
      || !(request instanceof ReviewProviderRequestIdentity)
      || typeof recoveredClaim !== "boolean" || typeof needsCheckpoint !== "boolean"
      || (recoveredClaim && needsCheckpoint)) {
      throw new TypeError("Spec Review claim preparation requires its exact binding and request");
    }
    this.flowManager = flowManager;
    this.binding = binding;
    this.executionBinding = executionBinding;
    this.request = request;
    this.recoveredClaim = recoveredClaim;
    this.needsCheckpoint = needsCheckpoint;
    Object.freeze(this);
  }
}

export class SpecReviewPublicationPreparation {
  constructor({ binding = null, reviewDigest = null, result = null }) {
    if (result === null
      ? !(binding instanceof SpecReviewStepBinding) || typeof reviewDigest !== "string" || reviewDigest.length === 0
      : binding !== null || reviewDigest !== null || result?.result !== "ok"
        || result.artifacts?.phase !== "spec" || typeof result.artifacts.reviewDigest !== "string") {
      throw new TypeError("Spec Review publication preparation requires a binding or an exact replay");
    }
    this.binding = binding;
    this.reviewDigest = reviewDigest;
    this.result = result;
    Object.freeze(this);
  }

  get completed() { return this.result !== null; }
}

/** Canonical I/O and settlement for one revision-bound Spec Review Attempt. */
export class SpecReviewService {
  #flowManager;
  #binding;
  #executionBinding;
  #manifest;

  static prepareExecutionClaim({ flowManager, state, manifest, skipConfirm }) {
    if (!(manifest instanceof ReviewWorkUnitManifest)
      || manifest.runId !== state.runId || manifest.specId !== state.specId
      || manifest.attemptId !== state.attempt?.id) {
      throw new StepAdmissionRefusal("Spec Review execution requires its exact work unit manifest");
    }
    const binding = new SpecReviewStepBinding({ flowManager, specId: state.specId });
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
      throw new StepAdmissionRefusal("the rebuilt Spec Review work unit differs from its durable execution binding");
    }
    if (current !== null && !["checkpoint", "claimed"].includes(current.phase)) {
      throw new StepAdmissionRefusal("the Spec Review execution already has a durable publication");
    }
    const request = new ReviewProviderRequestIdentity({ skipConfirm });
    if (current?.phase === "claimed" && !current.claim.request?.equals(request)) {
      throw new StepAdmissionRefusal("the Spec Review provider request differs from its durable claim");
    }
    return new SpecReviewExecutionClaimPreparation({
      flowManager, binding, executionBinding, request,
      recoveredClaim: current?.phase === "claimed", needsCheckpoint: current === null,
    });
  }

  static commitExecutionClaim(preparation) {
    if (!(preparation instanceof SpecReviewExecutionClaimPreparation)) {
      throw new TypeError("Spec Review claim requires its prepared execution identity");
    }
    const { flowManager, binding, executionBinding, request, recoveredClaim } = preparation;
    const identity = flowManager.draftStepExecutionState({ binding }).executionIdentity();
    if (!(identity?.stepResult instanceof SpecReviewExecutionRequiredResult)) {
      throw new Error("Spec Review execution lacks its persisted Step selection");
    }
    ReviewService.claimExecution({
      flowManager,
      binding,
      stepResult: identity.stepResult,
      settlement: identity.settlement,
      executionBinding,
      executionClaim: new DraftReviewExecutionClaim({ request }),
    });
    const persistedClaim = flowManager.draftStepExecutionState({ binding }).lifecycle.claim;
    return new SpecReviewExecutionAdmission({
      request: persistedClaim.request,
      recoveredClaim,
    });
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

  constructor({ flowManager, binding, executionBinding = null, manifest = null } = {}) {
    if (!(binding instanceof SpecReviewStepBinding) || binding.flowManager !== flowManager) {
      throw new TypeError("SpecReviewService requires its canonical review binding");
    }
    if ((executionBinding === null) !== (manifest === null)
      || (executionBinding !== null && (!(manifest instanceof ReviewWorkUnitManifest)
        || manifest.digest !== executionBinding.manifestDigest
        || manifest.inputDigest !== executionBinding.inputDigest))) {
      throw new TypeError("SpecReviewService execution requires its exact typed work unit");
    }
    this.#flowManager = flowManager;
    this.#binding = binding;
    this.#executionBinding = executionBinding;
    this.#manifest = manifest;
    Object.freeze(this);
  }

  inspectReview() {
    this.#binding.assertCurrent();
    if (this.#executionBinding !== null) return this.#manifest;
    const read = this.#flowManager.readCurrentSpecReviewInput({
      specId: this.#binding.specId,
      consumerNodeId: this.#binding.stepId,
    });
    if (!read.persisted || read.review.audit.at(-1)?.stage !== "spec-review") {
      throw new Error("Spec Review settlement requires its durable accepted publication");
    }
    return read.review;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#binding.stepId) {
      throw new TypeError("SpecReviewService requires its Step Result");
    }
    const settlement = settleSpecStepResult(this.#binding.stepId, stepResult);
    if (this.#executionBinding !== null && !(settlement instanceof DraftExecutionSettlement)) {
      throw new TypeError("Spec Review execution requires its Execution settlement");
    }
    const input = {
      binding: this.#binding,
      stepResult,
      settlement,
      ...(this.#executionBinding === null ? {} : {
        executionLifecycle: DraftStepExecutionLifecycle.checkpoint(this.#executionBinding),
      }),
    };
    try {
      const committed = this.#executionBinding === null
        ? this.#flowManager.settleSpecStepResult(input)
        : this.#flowManager.checkpointDraftStepExecution({
          binding: this.#binding,
          stepResult,
          settlement,
          executionBinding: this.#executionBinding,
        });
      return committed.receipt;
    } catch (error) {
      return recoverStepSettlementReceipt(this.#flowManager, input, error);
    }
  }
}
