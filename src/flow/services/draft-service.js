import {
  DraftRefineAwaitBinding,
  DraftStepBinding,
} from "../engine/connectors/draft/draft-step-binding.js";
import { STEP_RESULT_TYPE, StepResult } from "../engine/step-result.js";
import { DraftAwaitUserDecision, settleDraftStepResult } from "../definition.js";
import { DraftStepPersistenceFailure, isDraftStepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";

/** Access the sealed worker request for one Connector-bound Draft Step. */
export class DraftService {
  #workerOutcome = null;

  constructor({ flowManager, binding, workerFacts = null, workerExecutor = null, workerErrorCommitter = null }) {
    if (!(binding instanceof DraftStepBinding)) {
      throw new TypeError("DraftService requires a typed Draft step binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("DraftService binding belongs to a different FlowManager");
    }
    if (typeof flowManager.findDraftAwaitSettlementReceipt !== "function") {
      throw new TypeError("DraftService requires the canonical Await receipt reader");
    }
    this.binding = binding;
    if (workerExecutor !== null && typeof workerExecutor !== "function") {
      throw new TypeError("DraftService worker executor must be a function");
    }
    if (workerErrorCommitter !== null && typeof workerErrorCommitter !== "function") {
      throw new TypeError("DraftService worker error committer must be a function");
    }
    if (workerFacts !== null && (typeof workerFacts !== "object" || Array.isArray(workerFacts))) {
      throw new TypeError("DraftService worker facts must be an object");
    }
    if (workerFacts !== null && workerExecutor === null) {
      throw new TypeError("DraftService worker facts require a worker executor");
    }
    this.workerExecutor = workerExecutor;
    this.workerErrorCommitter = workerErrorCommitter;
    this.workerFacts = workerFacts;
  }

  /** Confirm that this bound refine Step is waiting for its stored question. */
  awaitingUserInput() {
    if (!(this.binding instanceof DraftRefineAwaitBinding)) return false;
    this.binding.assertCurrent();
    return true;
  }

  inspectWorkerFacts() {
    if (this.workerFacts === null) throw new Error("Draft worker has no prepared facts");
    this.binding.assertCurrent();
    return this.workerFacts;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("DraftService requires its bound Step's concrete Result");
    }
    let settlement = settleDraftStepResult(this.binding.stepId, stepResult);
    if (settlement.application !== null && settlement.application !== undefined) {
      settlement = settlement.materializeDraftCompletion(this.workerFacts?.draftCompletionFacts ?? null);
    }
    if (stepResult.type === STEP_RESULT_TYPE.ERROR) {
      return this.#commitWorkerError(stepResult, settlement);
    }
    if (this.workerExecutor === null) {
      try {
        if (settlement instanceof DraftAwaitUserDecision) {
          const replay = this.binding.flowManager.findDraftAwaitSettlementReceipt({
            binding: this.binding,
            stepResult,
            settlement,
          });
          if (replay !== null) return replay;
        }
        const committed = await this.binding.flowManager.settleDraftStepResult({
          binding: this.binding,
          stepResult,
          settlement,
        });
        return committed.receipt;
      } catch (error) {
        if (isDraftStepPersistenceFailure(error)) throw error;
        throw new DraftStepPersistenceFailure(error);
      }
    }
    let outcome;
    try {
      outcome = await this.workerExecutor(stepResult, settlement, this.binding);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      throw new DraftStepPersistenceFailure(error);
    }
    this.#workerOutcome = outcome;
    if (outcome.error !== null) throw outcome.error;
    if (outcome.receipt === null || outcome.receipt === undefined) {
      throw new DraftStepPersistenceFailure(new Error("Draft worker did not return its durable settlement receipt"));
    }
    return outcome.receipt;
  }

  async #commitWorkerError(stepResult, settlement) {
    if (this.workerErrorCommitter === null) throw stepResult.error;
    let outcome;
    try {
      outcome = await this.workerErrorCommitter(stepResult, settlement, this.binding);
    } catch (error) {
      if (isDraftStepPersistenceFailure(error)) throw error;
      throw new DraftStepPersistenceFailure(error);
    }
    this.#workerOutcome = outcome;
    if (outcome.error !== null) throw outcome.error;
    if (outcome.receipt === null || outcome.receipt === undefined) {
      throw new DraftStepPersistenceFailure(new Error("Draft worker did not return its durable settlement receipt"));
    }
    return outcome.receipt;
  }

  get workerOutcome() {
    return this.#workerOutcome;
  }
}
