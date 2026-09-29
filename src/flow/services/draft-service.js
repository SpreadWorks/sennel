import { STEP_RESULT_TYPE, StepResult } from "../engine/step-result.js";
import { DraftAwaitQuestionIdentity, DraftAwaitUserDecision, DraftCompletionConnector,
  DraftExecutionSettlement, settleDraftStepResult } from "../definition.js";
import { StepPersistenceFailure, rethrowStepSettlementFailure } from "../lib/definition-lifecycle-failure.js";
import { createDraftCompletionSettlementApplication } from "../lib/draft-completion-connector.js";
import { DraftRepairOperationsError } from "../lib/draft-repair-operations.js";
import { WorkerArtifactHandoffError } from "../lib/worker-artifact-handoff.js";
import { DraftWorkerInput } from "./draft-worker-input.js";
import { DraftSettlementWriter } from "./draft-settlement-writer.js";

const COMPLETED_WORKER_STEP_IDS = Object.freeze([
  "draft", "draft-questions-triage", "draft-coverage-triage",
]);

export class DraftWorkerCompletionFacts {
  constructor(stepId) {
    if (!COMPLETED_WORKER_STEP_IDS.includes(stepId)) {
      throw new TypeError("Draft worker completion facts require a completed worker Step");
    }
    this.stepId = stepId;
    Object.freeze(this);
  }
}

/** Selects and saves a Draft Step Result from prepared, typed observations. */
export class DraftService {
  static argumentTypes = [DraftWorkerInput, DraftSettlementWriter];
  #input;
  #writer;
  #workerOutcome = null;
  #repairCandidate = null;
  #executionSelection = null;

  constructor(input, writer) {
    if (!(input instanceof DraftWorkerInput) || !(writer instanceof DraftSettlementWriter)) {
      throw new TypeError("DraftService requires a typed input and settlement writer");
    }
    this.#input = input;
    this.#writer = writer;
  }

  requiresWorkerExecution() { return this.#input.executionBinding !== null; }

  inspectWorkerFacts() {
    if (!this.#input.prepared) throw new Error("Draft worker has no prepared facts");
    return this.#input;
  }

  adoptRepairCandidate(candidate) { this.#repairCandidate = candidate; }

  rejectInvalidRepair(error) {
    if (!(error instanceof DraftRepairOperationsError)) return;
    throw new WorkerArtifactHandoffError("invalid", error.code,
      `worker artifact payload failed ${this.#input.stepId} validation: ${error.message}`, {
        cause: error, retryable: false,
        data: { stepId: this.#input.stepId, draftRepairAudit: error.audit },
      });
  }

  inspectWorkerCompletion() {
    this.inspectWorkerFacts();
    if (!COMPLETED_WORKER_STEP_IDS.includes(this.#input.stepId)) {
      throw new Error("Draft worker completion does not match the bound Step");
    }
    return new DraftWorkerCompletionFacts(this.#input.stepId);
  }

  inspectPlanGateRepair() {
    if (this.#input.stepId !== "draft-gate-repair" || this.#input.planGateRepair === null) {
      throw new Error("draft-gate-repair has no canonical repair binding");
    }
    return this.#input.planGateRepair;
  }

  inspectDraftTransition() {
    if (this.#input.draftTransitionFacts === null) {
      throw new Error("Draft refine has no canonical transition facts");
    }
    return Object.freeze({ facts: this.#input.draftTransitionFacts,
      autoApprove: this.#input.autoApprove });
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.#input.stepId) {
      throw new TypeError("DraftService requires its bound Step's concrete Result");
    }
    if (stepResult.type !== STEP_RESULT_TYPE.ERROR && this.#input.repairInput !== null) {
      if (this.#repairCandidate === null) {
        throw new TypeError("Draft repair publication requires the Step-adopted candidate");
      }
      this.#repairCandidate.assertResult(stepResult);
    }
    if (stepResult.type !== STEP_RESULT_TYPE.ERROR) this.#input.repairSelection?.assertResult(stepResult);
    const settlement = settleDraftStepResult(this.#input.stepId, stepResult);
    const draftCompletionApplication = settlement.connector === DraftCompletionConnector
      && this.#input.draftCompletionFacts !== null
      ? createDraftCompletionSettlementApplication(this.#input.draftCompletionFacts)
      : null;
    let awaitQuestion = null;
    if (this.#input.stepId === "draft-refine" && settlement instanceof DraftAwaitUserDecision) {
      const facts = this.inspectDraftTransition().facts;
      if (facts.nextQuestion !== null) {
        awaitQuestion = new DraftAwaitQuestionIdentity({
          questionId: facts.nextQuestion.id, questionRevision: facts.nextQuestion.revision,
          sourceDigest: facts.sourceDigest, sourceByteLength: facts.sourceByteLength,
        });
      }
    }
    let committed;
    try {
      committed = await this.#writer.settle({ stepResult, settlement,
        draftCompletionApplication, awaitQuestion, repairCandidate: this.#repairCandidate });
    } catch (error) {
      if (error instanceof WorkerArtifactHandoffError && error.isAdmissionRejection) throw error;
      rethrowStepSettlementFailure(error);
    }
    if (this.#input.prepared) {
      this.#workerOutcome = committed;
      if (committed.error !== null) throw committed.error;
      if (committed.receipt === null || committed.receipt === undefined) {
        throw new StepPersistenceFailure(new Error("Draft worker did not return its durable settlement receipt"));
      }
    }
    if (settlement instanceof DraftExecutionSettlement) this.#executionSelection = settlement;
    return committed.receipt;
  }

  get workerOutcome() { return this.#workerOutcome; }
  get executionSelection() { return this.#executionSelection; }
}
