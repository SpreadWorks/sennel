import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import {
  DraftGateRepairAppliedResult,
  DraftGateRepairCarryForwardResult,
  DraftGateRepairWorkerRequiredResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { PlanGateRepairOutcomeDraft } from "../../lib/gate-observation-convergence.js";
import { PlanGateRepairRecord } from "../../lib/plan-gate-repair.js";

/** Pure mapping from a canonical repair binding or sealed outcome to this Step's Result. */
export function draftGateRepairResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("draft-gate-repair", facts);
  if (facts instanceof PlanGateRepairRecord) {
    if (facts.phase !== "draft" || facts.targetStepId !== "draft-gate-repair") {
      throw new TypeError("draft Gate Repair binding does not target its Step");
    }
    return new DraftGateRepairWorkerRequiredResult();
  }
  if (!(facts instanceof PlanGateRepairOutcomeDraft)) {
    throw new TypeError("draft Gate Repair Result requires typed repair facts");
  }
  if (facts.repair.sourceEvidence.resultLogicalKey !== "draft.gate") {
    throw new TypeError("draft Gate Repair outcome does not belong to the Draft Gate");
  }
  return facts.disposition === "applied"
    ? new DraftGateRepairAppliedResult()
    : new DraftGateRepairCarryForwardResult();
}

/**
 * Apply the selected Gate repair request to the bound Draft.
 * The bound handoff carries the selected Gate repair plan.
 */
export class DraftGateRepairStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    const requiresWorker = this.#draftService.requiresWorkerExecution();
    const facts = requiresWorker
      ? this.#draftService.inspectPlanGateRepair()
      : this.#draftService.inspectWorkerFacts().planGateRepairOutcome;
    let result;
    try {
      result = draftGateRepairResult(facts);
    } catch (error) {
      result = draftGateRepairResult(error);
    }
    await result.persist(this.#draftService);
    return result;
  }
}
