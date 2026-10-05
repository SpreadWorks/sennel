import { DraftCompletionConnector, DraftExecutionSettlement, settleDraftStepResult } from "../definition.js";
import { StepResult } from "../engine/step-result.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { createDraftCompletionSettlementApplication } from "../lib/draft-completion-connector.js";
import { DraftGatePublicationIntent } from "../lib/draft-gate-prospective.js";
import { DraftReviewInput } from "./draft-review-input.js";
import { DraftReviewSettlementWriter } from "./draft-review-settlement-writer.js";
import { DraftGateInput } from "./draft-gate-input.js";
import { DraftGateSettlementWriter } from "./draft-gate-settlement-writer.js";

/** Map an already validated Draft Review to its Step Result and save it. */
export class ReviewService {
  static argumentTypes = [DraftReviewInput, DraftReviewSettlementWriter];
  #input;
  #writer;

  constructor(input, writer) {
    if (!(input instanceof DraftReviewInput) || !(writer instanceof DraftReviewSettlementWriter)) {
      throw new TypeError("ReviewService requires a typed review input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  requiresReviewExecution() {
    return this.#input.executionBinding !== null || this.#input.publicationPending;
  }

  inspectReviewResult() {
    if (this.#input.document === null) throw new Error("Draft review has no validated terminal result");
    return this.#input.document;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("ReviewService requires its bound Step's concrete Result");
    }
    const settlement = settleDraftStepResult(this.#input.stepId, stepResult);
    if (this.requiresReviewExecution() && !(settlement instanceof DraftExecutionSettlement)) {
      throw new StepPersistenceFailure(new Error("Draft review pre-execution Step must select an Execution settlement"));
    }
    const draftCompletionApplication = settlement.connector === DraftCompletionConnector
      ? createDraftCompletionSettlementApplication(this.#input.completionFacts)
      : null;
    return this.#writer.settle({ stepResult, settlement, draftCompletionApplication });
  }
}

/** Map prospective Draft Gate facts and save the selected publication. */
export class GateService {
  static argumentTypes = [DraftGateInput, DraftGateSettlementWriter];
  #input;
  #writer;

  constructor(input, writer) {
    if (!(input instanceof DraftGateInput) || !(writer instanceof DraftGateSettlementWriter)) {
      throw new TypeError("GateService requires a typed Gate input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  assertGateResultAdmission() { return this.#input.facts; }
  inspectGateFacts() { return this.#input.facts; }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("GateService requires its bound Step's concrete Result");
    }
    const settlement = settleDraftStepResult(this.#input.stepId, stepResult);
    const gatePublication = stepResult.error === null
      ? new DraftGatePublicationIntent({ facts: this.#input.facts,
        issue: this.#input.issuePublication }) : null;
    return this.#writer.settle({ stepResult, settlement, gatePublication });
  }
}
