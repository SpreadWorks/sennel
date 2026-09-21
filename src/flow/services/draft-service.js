import { DraftStepBinding } from "../engine/connectors/draft/draft-step-binding.js";
import { STEP_RESULT_TYPE, StepResult } from "../engine/step-result.js";
import { DraftAwaitQuestionIdentity, DraftAwaitUserDecision, DraftCompletionConnector, DraftExecutionSettlement, settleDraftStepResult } from "../definition.js";
import { DraftStepPersistenceFailure, isDraftStepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { DraftTransitionFacts, readDraftTransitionFacts } from "../lib/draft-transition-facts.js";
import { canonicalPlanGateRepairForTarget, PlanGateRepairRecord } from "../lib/plan-gate-repair.js";
import {
  createDraftCompletionSettlementApplication,
} from "../lib/draft-completion-connector.js";

const COMPLETED_WORKER_STEP_IDS = Object.freeze([
  "draft",
  "draft-questions-triage",
  "draft-coverage-triage",
]);

/** Typed evidence that one worker-only Draft Step has a validated output ready to settle. */
export class DraftWorkerCompletionFacts {
  constructor(stepId) {
    if (!COMPLETED_WORKER_STEP_IDS.includes(stepId)) {
      throw new TypeError("Draft worker completion facts require a completed worker Step");
    }
    this.stepId = stepId;
    Object.freeze(this);
  }
}

/** Access the sealed worker request for one Connector-bound Draft Step. */
export class DraftService {
  #workerOutcome = null;
  #draftTransition = null;

  constructor({
    flowManager,
    binding,
    workerFacts = null,
    workerExecutor = null,
    workerErrorCommitter = null,
    executionCheckpointer = null,
  }) {
    if (!(binding instanceof DraftStepBinding)) {
      throw new TypeError("DraftService requires a typed Draft step binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("DraftService binding belongs to a different FlowManager");
    }
    if (typeof flowManager.settleDraftStepResult !== "function"
      || typeof flowManager.findDraftStepSettlementReceipt !== "function"
      || typeof flowManager.findDraftAwaitSettlementReceipt !== "function") {
      throw new TypeError("DraftService requires canonical Result settlement and receipt readers");
    }
    this.binding = binding;
    if (workerExecutor !== null && typeof workerExecutor !== "function") {
      throw new TypeError("DraftService worker executor must be a function");
    }
    if (workerErrorCommitter !== null && typeof workerErrorCommitter !== "function") {
      throw new TypeError("DraftService worker error committer must be a function");
    }
    if (executionCheckpointer !== null && typeof executionCheckpointer !== "function") {
      throw new TypeError("DraftService execution checkpointer must be a function");
    }
    if (workerFacts !== null && (typeof workerFacts !== "object" || Array.isArray(workerFacts))) {
      throw new TypeError("DraftService worker facts must be an object");
    }
    if (workerFacts !== null && binding.stepId === "draft-refine"
      && (!(workerFacts.draftTransitionFacts instanceof DraftTransitionFacts)
        || typeof workerFacts.autoApprove !== "boolean")) {
      throw new TypeError("DraftService refine worker facts must carry typed Draft transition facts");
    }
    if (workerFacts !== null && workerExecutor === null) {
      throw new TypeError("DraftService worker facts require a worker executor");
    }
    if (executionCheckpointer !== null && (workerFacts !== null || workerExecutor !== null || workerErrorCommitter !== null)) {
      throw new TypeError("DraftService execution checkpoint cannot carry post-worker state");
    }
    this.workerExecutor = workerExecutor;
    this.workerErrorCommitter = workerErrorCommitter;
    this.workerFacts = workerFacts;
    this.executionCheckpointer = executionCheckpointer;
  }

  /** Whether this bound Step must be admitted before its worker request is materialized. */
  requiresWorkerExecution() {
    this.binding.assertCurrent();
    return this.executionCheckpointer !== null;
  }

  /** Read the immutable facts sealed for this worker handoff. */
  inspectWorkerFacts() {
    if (this.workerFacts === null) throw new Error("Draft worker has no prepared facts");
    this.binding.assertCurrent();
    return this.workerFacts;
  }

  /** Read the typed completion fact created only after worker payload validation. */
  inspectWorkerCompletion() {
    const facts = this.inspectWorkerFacts();
    if (!COMPLETED_WORKER_STEP_IDS.includes(this.binding.stepId)
      || facts.stepId !== this.binding.stepId) {
      throw new Error("Draft worker completion does not match the bound Step");
    }
    return new DraftWorkerCompletionFacts(this.binding.stepId);
  }

  /** Read the canonical repair binding selected for the active pre-worker Step. */
  inspectPlanGateRepair() {
    const state = this.binding.assertCurrent();
    if (this.binding.stepId !== "draft-gate-repair") {
      throw new Error("Plan Gate repair facts belong only to draft-gate-repair");
    }
    const repair = canonicalPlanGateRepairForTarget({
      flowManager: this.binding.flowManager,
      state,
      targetStepId: this.binding.stepId,
    });
    if (!(repair instanceof PlanGateRepairRecord)) {
      throw new Error("draft-gate-repair has no canonical repair binding");
    }
    return repair;
  }

  inspectDraftTransition() {
    const state = this.binding.assertCurrent();
    if (this.#draftTransition !== null) return this.#draftTransition;
    const facts = this.workerFacts?.draftTransitionFacts
      ?? readDraftTransitionFacts({
        flowManager: this.binding.flowManager,
        flowState: this.binding.flowManager.loadReadOnly(this.binding.specId),
      });
    if (!(facts instanceof DraftTransitionFacts)) {
      throw new Error("Draft refine has no canonical transition facts");
    }
    this.#draftTransition = Object.freeze({
      facts,
      autoApprove: this.workerFacts?.autoApprove ?? state.policy.autoApprove,
    });
    return this.#draftTransition;
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("DraftService requires its bound Step's concrete Result");
    }
    const settlement = settleDraftStepResult(this.binding.stepId, stepResult);
    const draftCompletionApplication = settlement.connector === DraftCompletionConnector
      ? createDraftCompletionSettlementApplication(this.workerFacts?.draftCompletionFacts ?? null)
      : null;
    if (stepResult.type === STEP_RESULT_TYPE.ERROR) {
      return this.#commitWorkerError(stepResult, settlement);
    }
    let awaitQuestion = null;
    if (this.binding.stepId === "draft-refine" && settlement instanceof DraftAwaitUserDecision) {
      const transition = this.#draftTransition ?? this.inspectDraftTransition();
      if (transition.facts.nextQuestion !== null) {
        awaitQuestion = new DraftAwaitQuestionIdentity({
          questionId: transition.facts.nextQuestion.id,
          questionRevision: transition.facts.nextQuestion.revision,
          sourceDigest: transition.facts.sourceDigest,
          sourceByteLength: transition.facts.sourceByteLength,
        });
      }
    }
    if (this.executionCheckpointer !== null && settlement instanceof DraftExecutionSettlement) {
      try {
        const committed = await this.executionCheckpointer(stepResult, settlement, this.binding);
        return committed.receipt;
      } catch (error) {
        if (isDraftStepPersistenceFailure(error)) throw error;
        throw new DraftStepPersistenceFailure(error);
      }
    }
    if (this.workerExecutor === null) {
      try {
        if (settlement instanceof DraftAwaitUserDecision) {
          const replay = this.binding.flowManager.findDraftAwaitSettlementReceipt({
            binding: this.binding,
            stepResult,
            settlement,
            awaitQuestion,
          });
          if (replay !== null) return replay;
        }
        const committed = await this.binding.flowManager.settleDraftStepResult({
          binding: this.binding,
          stepResult,
          settlement,
          draftCompletionApplication,
          awaitQuestion,
        });
        return committed.receipt;
      } catch (error) {
        if (isDraftStepPersistenceFailure(error)) throw error;
        throw new DraftStepPersistenceFailure(error);
      }
    }
    let outcome;
    try {
      outcome = await this.workerExecutor(
        stepResult, settlement, this.binding, awaitQuestion, draftCompletionApplication,
      );
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
    if (this.workerErrorCommitter === null) {
      const input = {
        binding: this.binding,
        stepResult,
        settlement,
      };
      try {
        const committed = await this.binding.flowManager.settleDraftStepResult(input);
        return committed.receipt;
      } catch (error) {
        const replay = this.binding.flowManager.findDraftStepSettlementReceipt(input);
        if (replay !== null) return replay;
        if (isDraftStepPersistenceFailure(error)) throw error;
        throw new DraftStepPersistenceFailure(error);
      }
    }
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
