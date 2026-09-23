import {
  SpecCreatedResult,
  SpecPlanGateRepairAppliedResult,
  SpecPlanGateRepairNoProgressResult,
  StepResult,
} from "../engine/step-result.js";
import { SpecWorkerStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { settleSpecStepResult, StepErrorDecision, StepRoute } from "../definition.js";
import { StepPersistenceFailure } from "../lib/definition-lifecycle-failure.js";
import { CurrentFlowStateConflictError } from "../lib/current-flow-state.js";
import {
  SpecReviewSettlementApplication,
  SpecWorkerCompletionFacts,
} from "../lib/spec-step-connection.js";

/** Owns Spec candidate access, adoption, and canonical persistence. */
export class SpecService {
  #outcome = null;
  #adoption = null;
  #application = null;
  #publication = null;

  static async prepare({ ctx, request, Connector, handoffCoordinator } = {}) {
    const preparation = handoffCoordinator.prepareSpecWorker({ ctx, request });
    if (preparation.completed) return preparation;
    const binding = await new Connector(request).connect();
    return new SpecService({ ctx, request, binding, preparation, handoffCoordinator });
  }

  constructor({ ctx, request, binding, preparation, handoffCoordinator } = {}) {
    if (!(binding instanceof SpecWorkerStepBinding)
      || binding.flowManager !== ctx?.flowManager
      || !(preparation?.facts instanceof SpecWorkerCompletionFacts)
      || preparation.request !== request
      || typeof handoffCoordinator?.completeSpecWorkerHandoff !== "function") {
      throw new TypeError("SpecService requires its bound prepared handoff");
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

  adoptWorkerCandidate(facts, result) {
    if (!(facts instanceof SpecWorkerCompletionFacts)
      || facts !== this.preparation.facts
      || (facts.planGateRepairOutcome === null
        ? !(result instanceof SpecCreatedResult)
        : facts.planGateRepairOutcome.disposition === "applied"
          ? !(result instanceof SpecPlanGateRepairAppliedResult)
          : !(result instanceof SpecPlanGateRepairNoProgressResult))) {
      throw new TypeError("SpecService requires the selected prepared Spec candidate and Result");
    }
    this.binding.assertCurrent();
    this.#adoption = { facts, result };
  }

  async persistStepResult(stepResult) {
    if (!(stepResult instanceof StepResult) || stepResult.stepId !== this.binding.stepId) {
      throw new TypeError("SpecService requires its bound Step's concrete Result");
    }
    const settlement = settleSpecStepResult(this.binding.stepId, stepResult);
    const errorSettlement = settlement instanceof StepErrorDecision;
    const planGateRepairOutcome = this.preparation.facts.planGateRepairOutcome;
    if (planGateRepairOutcome !== null && this.#adoption?.result !== stepResult) {
      throw new TypeError("Spec plan Gate repair requires the Step-adopted Result");
    }
    if (!errorSettlement && (!(settlement instanceof StepRoute) || this.#adoption?.result !== stepResult)) {
      throw new TypeError("Spec publication requires the Step-adopted candidate and Result");
    }
    const application = errorSettlement ? null : (this.#application ?? await new settlement.connector({
      binding: this.binding, facts: this.#adoption.facts,
    }).connect());
    if (!errorSettlement && !(application instanceof SpecReviewSettlementApplication)) {
      throw new TypeError("Spec route connector did not return its typed application");
    }
    this.#application = application;
    this.#publication ??= this.preparation.settlementPublication(this.handoffCoordinator.now);
    const input = {
      binding: this.binding,
      stepResult,
      settlement,
      application,
      planGateRepairOutcome,
      ...this.#publication,
      lifecycleResult: errorSettlement ? null : this.#publication.lifecycleResult,
    };
    const replayed = this.#outcome !== null;
    let committed;
    try {
      if (!replayed) {
        this.handoffCoordinator.faultInjector({
          phase: "before-worker-handoff-publication", stepId: this.binding.stepId,
        });
      }
      committed = this.ctx.flowManager.settleSpecStepResult(input);
    } catch (cause) {
      if (cause instanceof CurrentFlowStateConflictError) throw cause;
      const receipt = this.ctx.flowManager.findStepSettlementReceipt({
        ...input,
        specRecord: application?.publication,
      });
      if (receipt === null) throw new StepPersistenceFailure(cause);
      committed = { receipt };
    }
    this.#outcome = this.handoffCoordinator.completeSpecWorkerHandoff({
      request: this.request,
      preparation: this.preparation,
      stepResult,
      receipt: committed.receipt,
      replayed,
    });
    if (this.#outcome?.receipt === null || this.#outcome?.receipt === undefined) {
      throw new StepPersistenceFailure(new Error("Spec worker did not return its durable settlement receipt"));
    }
    return this.#outcome.receipt;
  }

  get workerOutcome() { return this.#outcome; }
}
