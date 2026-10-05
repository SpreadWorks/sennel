import { CanonicalFlowArtifactBaseline, CanonicalWorkerSpecPublication } from "../lib/current-flow-state.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state-conflict-error.js";
import { SpecReviewSettlementApplication } from "../lib/spec-step-connection.js";
import { StepErrorDecision } from "../definition.js";

/** Apply one selected Spec worker settlement and return its durable receipt. */
export class SpecSettlementWriter {
  #flowManager;
  #request;
  #binding;
  #preparation;
  #handoffCoordinator;
  #outcome = null;
  #application = null;
  #publication = null;

  constructor({ flowManager, request, binding, preparation, handoffCoordinator, publication,
    application = null }) {
    this.#flowManager = flowManager;
    this.#request = request;
    this.#binding = binding;
    this.#preparation = preparation;
    this.#handoffCoordinator = handoffCoordinator;
    this.#publication = publication;
    this.#application = application;
  }

  async settleInitial({ stepResult, settlement, selection }) {
    const error = settlement instanceof StepErrorDecision;
    const application = error ? null : this.#application;
    if (!error && !(application instanceof SpecReviewSettlementApplication)) {
      throw new TypeError("Spec route connector did not return its typed application");
    }
    this.#application = application;
    const input = { binding: this.#binding, stepResult, settlement, specSelection: selection,
      application, ...this.#publication, specRecord: application?.publication,
      lifecycleResult: error ? null : this.#publication.lifecycleResult };
    const replayed = this.#outcome !== null;
    this.#injectBeforePublication(replayed);
    const committed = this.#flowManager.commitSpecStepResult(input);
    this.#outcome = this.#handoffCoordinator.completeSpecWorkerHandoff({
      request: this.#request, preparation: this.#preparation,
      stepResult, receipt: committed.receipt, replayed,
    });
    if (this.#outcome?.receipt === null || this.#outcome?.receipt === undefined) {
      throw new StepPersistenceFailure(new Error("Spec worker did not return its durable settlement receipt"));
    }
    return this.#outcome;
  }

  async settleReviewWorker({ stepResult, settlement, selection }) {
    const error = settlement instanceof StepErrorDecision;
    if (!error && await new settlement.connector().connect() !== settlement.targetStepId) {
      throw new TypeError("Spec Review worker connector did not select the settled target");
    }
    const facts = this.#preparation.facts;
    const parameters = { revision: facts.review.identity.revision.toString() };
    this.#publication = error ? {
      lifecycleResult: null, references: undefined, artifactWrites: [], artifactBaselines: [],
    } : {
      ...this.#publication,
      specRecord: selection.candidate === undefined ? undefined
        : new CanonicalWorkerSpecPublication(selection.candidate.spec),
      artifactWrites: [{ logicalKey: "spec.review", parameters,
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(selection.review.toJSON(), null, 2)}\n`, "utf8") }],
      artifactBaselines: [new CanonicalFlowArtifactBaseline({
        logicalKey: "spec.review", parameters,
        digest: facts.reviewDigest, byteLength: facts.reviewByteLength,
      })],
    };
    const input = { binding: this.#binding, stepResult, settlement,
      specReviewWorkerSelection: selection, ...this.#publication };
    const replayed = this.#outcome !== null;
    this.#injectBeforePublication(replayed);
    const committed = this.#flowManager.commitSpecStepResult(input);
    this.#outcome = this.#handoffCoordinator.completeSpecWorkerHandoff({
      request: this.#request, preparation: this.#preparation,
      stepResult, receipt: committed.receipt, replayed,
    });
    return this.#outcome;
  }

  #injectBeforePublication(replayed) {
    if (replayed) return;
    try {
      this.#handoffCoordinator.faultInjector({
        phase: "before-worker-handoff-publication", stepId: this.#binding.stepId,
      });
    } catch (cause) {
      if (cause instanceof CurrentFlowStateConflictError) throw cause;
      throw new StepPersistenceFailure(cause);
    }
  }
}
