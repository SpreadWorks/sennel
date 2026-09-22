import { CanonicalFlowArtifactBaseline, CanonicalWorkerSpecPublication } from "../lib/current-flow-state.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../lib/spec-review-artifacts.js";
import { SpecWorkerStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { StepResult, StepErrorResult, SpecTriageCompletedResult, SpecRepairChangedResult, SpecRepairUnchangedResult } from "../engine/step-result.js";
import { settleSpecStepResult, StepRoute, StepErrorDecision } from "../definition.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";

/** Immutable, validated inputs captured from one sealed Review worker handoff. */
export class SpecReviewWorkerFacts {
  constructor({ stepId, spec, review, delta, reviewDigest, reviewByteLength } = {}) {
    if (!["spec-triage", "spec-repair"].includes(stepId)
      || !spec || typeof spec !== "object" || Array.isArray(spec)
      || !(review instanceof CanonicalSpecReview)
      || !(delta instanceof SpecReviewDelta) || delta.stage !== stepId
      || typeof reviewDigest !== "string" || !Number.isSafeInteger(reviewByteLength)) {
      throw new TypeError("Spec Review worker facts require bound canonical inputs");
    }
    delta.assertCurrent(review);
    this.stepId = stepId;
    this.spec = structuredClone(spec);
    this.review = review;
    this.delta = delta;
    this.reviewDigest = reviewDigest;
    this.reviewByteLength = reviewByteLength;
    Object.freeze(this.spec);
    Object.freeze(this);
  }
}

/** Pure Step selection: semantic Result and its exact canonical candidates. */
export class SpecReviewWorkerSelection {
  constructor({ result, review, specRecord = undefined } = {}) {
    if (!(result instanceof SpecTriageCompletedResult
      || result instanceof SpecRepairChangedResult
      || result instanceof SpecRepairUnchangedResult)
      || !(review instanceof CanonicalSpecReview)
      || (specRecord !== undefined && !(specRecord instanceof CanonicalWorkerSpecPublication))
      || (result instanceof SpecRepairChangedResult) !== (specRecord !== undefined)) {
      throw new TypeError("Spec Review worker selection requires matching Result and publication");
    }
    this.result = result;
    this.review = review;
    this.specRecord = specRecord;
    Object.freeze(this);
  }
}

/** Handoff I/O and canonical settlement for Spec Triage and Repair. */
export class SpecReviewWorkerService {
  #selection = null;
  #outcome = null;
  #publication = null;

  static async prepare({ ctx, request, Connector, handoffCoordinator } = {}) {
    const preparation = handoffCoordinator.prepareSpecWorker({ ctx, request });
    if (preparation.completed) return preparation;
    const binding = await new Connector(request).connect();
    return new SpecReviewWorkerService({ ctx, request, binding, preparation, handoffCoordinator });
  }

  constructor({ ctx, request, binding, preparation, handoffCoordinator } = {}) {
    if (!(binding instanceof SpecWorkerStepBinding)
      || binding.flowManager !== ctx?.flowManager
      || !(preparation?.facts instanceof SpecReviewWorkerFacts)
      || preparation.request !== request
      || typeof handoffCoordinator?.completeSpecWorkerHandoff !== "function") {
      throw new TypeError("Spec Review worker service requires its prepared handoff");
    }
    this.ctx = ctx;
    this.request = request;
    this.binding = binding;
    this.preparation = preparation;
    this.handoffCoordinator = handoffCoordinator;
  }

  inspectWorkerCompletion() {
    this.binding.assertCurrent();
    return this.preparation.facts;
  }

  adoptWorkerSelection(facts, selection) {
    if (facts !== this.preparation.facts || !(selection instanceof SpecReviewWorkerSelection)
      || selection.result.stepId !== this.binding.stepId
      || !selection.review.identity.equals(facts.review.identity)) {
      throw new TypeError("Spec Review worker selection does not match its handoff");
    }
    this.binding.assertCurrent();
    this.#selection = selection;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId
      || (!(stepResult instanceof StepErrorResult) && this.#selection?.result !== stepResult)) {
      throw new TypeError("Spec Review worker publication requires its Step-selected Result");
    }
    const settlement = settleSpecStepResult(this.binding.stepId, stepResult);
    const errorSettlement = settlement instanceof StepErrorDecision;
    if (!errorSettlement && !(settlement instanceof StepRoute)) throw new TypeError("Spec Review worker requires its selected route");
    this.binding.assertCurrent();
    if (!errorSettlement && await new settlement.connector().connect() !== settlement.targetStepId) {
      throw new TypeError("Spec Review worker connector did not select the settled target");
    }
    const facts = this.preparation.facts;
    const parameters = { revision: facts.review.identity.revision.toString() };
    this.#publication ??= errorSettlement ? {
      lifecycleResult: null, references: undefined, artifactWrites: [], artifactBaselines: [],
    } : {
      ...this.preparation.settlementPublication(this.handoffCoordinator.now),
      specRecord: this.#selection.specRecord,
      artifactWrites: [{
        logicalKey: "spec.review", parameters, mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(this.#selection.review.toJSON(), null, 2)}\n`, "utf8"),
      }],
      artifactBaselines: [new CanonicalFlowArtifactBaseline({
        logicalKey: "spec.review", parameters,
        digest: facts.reviewDigest, byteLength: facts.reviewByteLength,
      })],
    };
    const input = { binding: this.binding, stepResult, settlement, ...this.#publication };
    const replayed = this.#outcome !== null;
    let committed;
    try {
      if (!replayed) this.handoffCoordinator.faultInjector({ phase: "before-worker-handoff-publication", stepId: this.binding.stepId });
      committed = this.ctx.flowManager.settleSpecStepResult(input);
    } catch (cause) {
      if (cause instanceof CurrentFlowStateConflictError) throw cause;
      const receipt = this.ctx.flowManager.findStepSettlementReceipt(input);
      if (receipt === null) throw new StepPersistenceFailure(cause);
      committed = { receipt };
    }
    this.#outcome = this.handoffCoordinator.completeSpecWorkerHandoff({
      request: this.request, preparation: this.preparation,
      stepResult, receipt: committed.receipt, replayed,
    });
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
}
