import { DraftStepBinding, DraftWorkerExecutionStepBinding } from "../engine/connectors/draft/draft-step-binding.js";
import { STEP_RESULT_TYPE, StepResult } from "../engine/step-result.js";
import { DraftAwaitQuestionIdentity, DraftAwaitUserDecision, DraftCompletionConnector, DraftExecutionSettlement, DraftWorkerExecutionBinding, DraftStepExecutionLifecycle, settleDraftStepResult } from "../definition.js";
import { StepPersistenceFailure, recoverStepSettlementReceipt, rethrowStepSettlementFailure } from "../lib/definition-lifecycle-failure.js";
import { DraftTransitionFacts, readDraftTransitionFacts } from "../lib/draft-transition-facts.js";
import { canonicalPlanGateRepairForTarget, PlanGateRepairRecord } from "../lib/plan-gate-repair.js";
import {
  createDraftCompletionSettlementApplication,
} from "../lib/draft-completion-connector.js";
import { isConditionalDraftWorkerStep } from "../lib/draft-conditional-worker.js";
import { DraftRepairOperationsError } from "../lib/draft-repair-operations.js";
import { WorkerArtifactHandoffError } from "../lib/worker-artifact-handoff.js";

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
  #repairCandidate = null;
  #executionSelection = null;

  static async prepare({ ctx, request, Connector, handoffCoordinator, preparation }) {
    const binding = isConditionalDraftWorkerStep(request.stepId)
      ? new DraftWorkerExecutionStepBinding({ flowManager: ctx.flowManager, specId: request.specId, stepId: request.stepId })
      : await new Connector(request).connect();
    return new DraftService({ flowManager: ctx.flowManager, binding, ctx, request, preparation, handoffCoordinator });
  }

  constructor({
    flowManager,
    binding,
    ctx = null,
    request = null,
    preparation = null,
    handoffCoordinator = null,
    executionBinding = null,
  }) {
    if (!(binding instanceof DraftStepBinding)) {
      throw new TypeError("DraftService requires a typed Draft step binding");
    }
    if (binding.flowManager !== flowManager) {
      throw new Error("DraftService binding belongs to a different FlowManager");
    }
    if (typeof flowManager.settleDraftStepResult !== "function"
      || typeof flowManager.findStepSettlementReceipt !== "function"
      || typeof flowManager.findDraftAwaitSettlementReceipt !== "function") {
      throw new TypeError("DraftService requires canonical Result settlement and receipt readers");
    }
    this.binding = binding;
    const workerFacts = preparation?.facts ?? null;
    if (executionBinding !== null && !(executionBinding instanceof DraftWorkerExecutionBinding)) {
      throw new TypeError("DraftService requires a typed worker execution binding");
    }
    if (workerFacts !== null && (typeof workerFacts !== "object" || Array.isArray(workerFacts))) {
      throw new TypeError("DraftService worker facts must be an object");
    }
    if (workerFacts !== null && binding.stepId === "draft-refine"
      && (!(workerFacts.draftTransitionFacts instanceof DraftTransitionFacts)
        || typeof workerFacts.autoApprove !== "boolean")) {
      throw new TypeError("DraftService refine worker facts must carry typed Draft transition facts");
    }
    if (preparation !== null && (preparation.request !== request || ctx?.flowManager !== flowManager
      || typeof handoffCoordinator?.commitDraftWorker !== "function")) {
      throw new TypeError("DraftService requires its prepared worker handoff");
    }
    if (executionBinding !== null && preparation !== null) {
      throw new TypeError("DraftService execution checkpoint cannot carry post-worker state");
    }
    this.ctx = ctx;
    this.request = request;
    this.preparation = preparation;
    this.handoffCoordinator = handoffCoordinator;
    this.workerFacts = workerFacts;
    this.executionBinding = executionBinding;
  }

  /** Whether this bound Step must be admitted before its worker request is materialized. */
  requiresWorkerExecution() {
    this.binding.assertCurrent();
    return this.executionBinding !== null;
  }

  /** Read the immutable facts sealed for this worker handoff. */
  inspectWorkerFacts() {
    if (this.workerFacts === null) throw new Error("Draft worker has no prepared facts");
    this.binding.assertCurrent();
    return this.workerFacts;
  }

  adoptRepairCandidate(candidate) {
    this.binding.assertCurrent();
    this.preparation = this.preparation.adoptRepairCandidate(candidate);
    this.#repairCandidate = candidate;
  }

  /** A rejected external operation batch is a handoff rejection, not a semantic Step failure. */
  rejectInvalidRepair(error) {
    if (!(error instanceof DraftRepairOperationsError)) return;
    throw new WorkerArtifactHandoffError("invalid", error.code,
      `worker artifact payload failed ${this.binding.stepId} validation: ${error.message}`, {
        cause: error, retryable: false,
        data: { stepId: this.binding.stepId, draftRepairAudit: error.audit },
      });
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
    if (stepResult.type !== STEP_RESULT_TYPE.ERROR && this.workerFacts?.repairInput != null) {
      if (this.#repairCandidate === null) throw new TypeError("Draft repair publication requires the Step-adopted candidate");
      this.#repairCandidate.assertResult(stepResult);
    }
    if (stepResult.type !== STEP_RESULT_TYPE.ERROR) this.workerFacts?.repairSelection?.assertResult(stepResult);
    const settlement = settleDraftStepResult(this.binding.stepId, stepResult);
    const draftCompletionApplication = settlement.connector === DraftCompletionConnector
      ? createDraftCompletionSettlementApplication(this.preparation?.publications?.draftCoverageRepairFacts
        ?? this.workerFacts?.draftCompletionFacts ?? null)
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
    if (this.executionBinding !== null && settlement instanceof DraftExecutionSettlement) {
      const input = {
        binding: this.binding, stepResult, settlement, executionBinding: this.executionBinding,
        executionLifecycle: DraftStepExecutionLifecycle.checkpoint(this.executionBinding),
      };
      let receipt;
      try {
        receipt = this.binding.flowManager.checkpointDraftStepExecution(input).receipt;
      } catch (error) {
        receipt = recoverStepSettlementReceipt(this.binding.flowManager, input, error);
      }
      this.#executionSelection = settlement;
      return receipt;
    }
    if (this.preparation === null) {
      const input = {
        binding: this.binding, stepResult, settlement, draftCompletionApplication, awaitQuestion,
      };
      try {
        if (settlement instanceof DraftAwaitUserDecision) {
          const replay = this.binding.flowManager.findDraftAwaitSettlementReceipt(input);
          if (replay !== null) return replay;
        }
        return (await this.binding.flowManager.settleDraftStepResult(input)).receipt;
      } catch (error) {
        return recoverStepSettlementReceipt(this.binding.flowManager, input, error);
      }
    }
    return this.#persistPreparedWorker(stepResult, settlement, draftCompletionApplication);
  }

  async #commitWorkerError(stepResult, settlement) {
    if (this.preparation === null) {
      const input = {
        binding: this.binding,
        stepResult,
        settlement,
      };
      try {
        const committed = await this.binding.flowManager.settleDraftStepResult(input);
        return committed.receipt;
      } catch (error) {
        return recoverStepSettlementReceipt(this.binding.flowManager, input, error);
      }
    }
    return this.#persistPreparedWorker(stepResult, settlement);
  }

  #persistPreparedWorker(stepResult, settlement, draftCompletionApplication = null) {
    let outcome;
    try {
      outcome = this.#commitPreparedWorker(stepResult, settlement, draftCompletionApplication);
    } catch (error) {
      if (error instanceof WorkerArtifactHandoffError && error.isAdmissionRejection) throw error;
      rethrowStepSettlementFailure(error);
    }
    this.#workerOutcome = outcome;
    if (outcome.error !== null) throw outcome.error;
    if (outcome.receipt === null || outcome.receipt === undefined) {
      throw new StepPersistenceFailure(new Error("Draft worker did not return its durable settlement receipt"));
    }
    return outcome.receipt;
  }

  #commitPreparedWorker(stepResult, settlement, draftCompletionApplication = null) {
    const input = {
      ctx: this.ctx, request: this.request, preparation: this.preparation,
      binding: this.binding, stepResult, settlement, draftCompletionApplication,
    };
    const failed = stepResult.type === STEP_RESULT_TYPE.ERROR;
    if (failed && isConditionalDraftWorkerStep(this.binding.stepId)) {
      const execution = this.binding.flowManager.draftStepExecutionState({ binding: this.binding });
      if (execution.lifecycle?.phase === "publication") {
        return { error: null, ...this.handoffCoordinator.completePublishedDraftWorker(input) };
      }
    }
    return { error: null, ...(failed
      ? this.handoffCoordinator.commitDraftWorkerError(input)
      : this.handoffCoordinator.commitDraftWorker(input)) };
  }

  get workerOutcome() {
    return this.#workerOutcome;
  }

  get executionSelection() { return this.#executionSelection; }
}
