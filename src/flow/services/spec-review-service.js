import {
  DraftExecutionSettlement,
  DraftReviewExecutionBinding,
  DraftReviewExecutionClaim,
  DraftReviewExecutionTargetIdentity,
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
import { stepResultDigest } from "../engine/step-result.js";
import { SpecReviewStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { ReviewWorkUnitManifest } from "../lib/review-work-unit.js";
import {
  CurrentFlowStateConflictError,
  CurrentFlowStateInvariantError,
} from "../lib/current-flow-state.js";

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

/** Canonical I/O and settlement for one revision-bound Spec Review Attempt. */
export class SpecReviewService {
  static async claimExecution({ flowManager, state, manifest, skipConfirm }) {
    if (!(manifest instanceof ReviewWorkUnitManifest)
      || manifest.runId !== state.runId || manifest.specId !== state.specId
      || manifest.attemptId !== state.attempt?.id) {
      throw new TypeError("Spec Review execution requires its exact work unit manifest");
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
      throw new Error("the rebuilt Spec Review work unit differs from its durable execution binding");
    }
    if (current !== null && !["checkpoint", "claimed"].includes(current.phase)) {
      throw new Error("the Spec Review execution already has a durable publication");
    }
    const request = new ReviewProviderRequestIdentity({ skipConfirm });
    if (current?.phase === "claimed" && !current.claim.request?.equals(request)) {
      throw new Error("the Spec Review provider request differs from its durable claim");
    }
    let identity = executionState.executionIdentity();
    if (current === null) {
      const { StepFactory } = await import("../engine/step-factory.js");
      const { SpecReviewStep } = await import("../steps/spec/spec-review.js");
      const service = new this({ flowManager, binding, executionBinding, manifest });
      const selected = await new StepFactory()
        .provide(SpecReviewService, service).create(SpecReviewStep).execute();
      if (!(selected instanceof SpecReviewExecutionRequiredResult)) {
        throw new Error("Spec Review Step did not select execution");
      }
      identity = flowManager.draftStepExecutionState({ binding }).executionIdentity();
    }
    flowManager.claimDraftStepExecution({
      binding,
      stepResult: identity.stepResult,
      settlement: identity.settlement,
      executionBinding,
      executionClaim: new DraftReviewExecutionClaim({ request }),
    });
    const persistedClaim = flowManager.draftStepExecutionState({ binding }).lifecycle.claim;
    return new SpecReviewExecutionAdmission({
      request: persistedClaim.request,
      recoveredClaim: current?.phase === "claimed",
    });
  }

  static publish({ flowManager, specId, commandResult }) {
    const binding = new SpecReviewStepBinding({ flowManager, specId });
    const stepResult = new SpecReviewExecutionRequiredResult();
    const input = {
      binding,
      stepResult,
      settlement: settleSpecStepResult(binding.stepId, stepResult),
      commandResult,
    };
    try {
      return flowManager.settleSpecStepResult(input);
    } catch (error) {
      const receipt = flowManager.findStepSettlementReceipt(input);
      if (receipt !== null) return { state: flowManager.canonicalState(specId), receipt };
      if (error instanceof CurrentFlowStateConflictError
        || error instanceof CurrentFlowStateInvariantError) throw error;
      throw new StepPersistenceFailure(error);
    }
  }

  static async completePublication({ flowManager, state }) {
    const latest = flowManager.canonicalState(state.specId);
    if (latest.current?.at(-1) !== "spec-review") {
      return this.terminalReplay({ flowManager, state: latest });
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
    const { StepFactory } = await import("../engine/step-factory.js");
    const { SpecReviewStep } = await import("../steps/spec/spec-review.js");
    const service = new this({ flowManager, binding });
    let stepResult;
    try {
      stepResult = await new StepFactory()
        .provide(SpecReviewService, service).create(SpecReviewStep).execute();
    } catch (error) {
      const replay = await this.terminalReplay({
        flowManager, state: flowManager.canonicalState(state.specId),
      });
      if (replay !== null) return replay;
      throw error;
    }
    return this.resultFromStepResult(stepResult, read.review.digest);
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
    const terminal = activities.findLast((entry) => (
      entry.nodeId === "spec-review"
      && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal"
    ))?.result?.draftSettlementReceipt ?? null;
    if (terminal === null || terminal.binding.runId !== state.runId
      || terminal.targetStepId !== "spec-triage") return null;
    const publication = activities.findLast((entry) => {
      const receipt = entry.result?.draftSettlementReceipt;
      return receipt?.executionLifecycle?.phase === "publication"
        && receipt.binding.attemptId === terminal.binding.attemptId
        && receipt.binding.attemptSequence === terminal.binding.attemptSequence;
    });
    const read = flowManager.readCurrentSpecReview({
      specId: state.specId, consumerNodeId: "spec-triage",
    });
    if (read === null || publication?.id !== read.descriptor?.activityId) {
      throw new Error("Spec Review terminal replay has no exact canonical publication");
    }
    const { specReviewResult } = await import("../steps/spec/spec-review.js");
    const selected = specReviewResult(read.review);
    if (selected.kind !== terminal.resultKind || stepResultDigest(selected) !== terminal.resultDigest) {
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
    this.flowManager = flowManager;
    this.binding = binding;
    this.executionBinding = executionBinding;
    this.manifest = manifest;
    Object.freeze(this);
  }

  inspectReview() {
    this.binding.assertCurrent();
    if (this.executionBinding !== null) return this.manifest;
    const read = this.flowManager.readCurrentSpecReviewInput({
      specId: this.binding.specId,
      consumerNodeId: this.binding.stepId,
    });
    if (!read.persisted || read.review.audit.at(-1)?.stage !== "spec-review") {
      throw new Error("Spec Review settlement requires its durable accepted publication");
    }
    return read.review;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("SpecReviewService requires its Step Result");
    }
    const settlement = settleSpecStepResult(this.binding.stepId, stepResult);
    try {
      const committed = this.executionBinding === null
        ? this.flowManager.settleSpecStepResult({
          binding: this.binding,
          stepResult,
          settlement,
        })
        : this.flowManager.checkpointDraftStepExecution({
          binding: this.binding,
          stepResult,
          settlement,
          executionBinding: this.executionBinding,
        });
      if (this.executionBinding !== null && !(settlement instanceof DraftExecutionSettlement)) {
        throw new TypeError("Spec Review execution requires its Execution settlement");
      }
      return committed.receipt;
    } catch (error) {
      const receipt = this.flowManager.findStepSettlementReceipt({
        binding: this.binding,
        stepResult,
        settlement,
      });
      if (receipt !== null) return receipt;
      throw new StepPersistenceFailure(error);
    }
  }
}
