import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import { DraftRepairCandidate } from "./draft-repair-candidate.js";
import { draftGateRepairResult } from "./draft-repair-result.js";

/**
 * Apply the selected Gate repair request to the bound Draft.
 * The bound handoff carries the selected Gate repair plan.
 */
export class DraftGateRepairStep extends Step {
  static dependencies = [DraftService];

  #draftService;
  #selectedResult = null;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  prepareResult() {
    if (this.#selectedResult !== null) return this.#selectedResult;
    const requiresWorker = this.#draftService.requiresWorkerExecution();
    const recovered = requiresWorker ? null : this.#draftService.inspectWorkerFacts().repairSelection;
    if (recovered != null) {
      this.#selectedResult = recovered.result;
      return this.#selectedResult;
    }
    const facts = requiresWorker
      ? this.#draftService.inspectPlanGateRepair()
      : this.#draftService.inspectWorkerFacts().repairInput;
    let result;
    let candidate;
    try {
      candidate = requiresWorker ? null : new DraftRepairCandidate(facts);
      result = requiresWorker ? draftGateRepairResult(facts) : candidate.result;
    } catch (error) {
      this.#draftService.rejectInvalidRepair(error);
      result = draftGateRepairResult(error);
    }
    if (candidate != null) this.#draftService.adoptRepairCandidate(candidate);
    this.#selectedResult = result;
    return result;
  }

  async _execute() {
    const result = this.prepareResult();
    await result.persist(this.#draftService);
    return result;
  }
}
