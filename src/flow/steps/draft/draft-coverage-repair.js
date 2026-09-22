import { Step } from "../../engine/step.js";
import { DraftService } from "../../services/draft-service.js";
import {
  DraftCoverageRepairChangedResult,
  DraftCoverageRepairUnchangedResult,
  StepErrorResult,
} from "../../engine/step-result.js";
import { DraftRepairResultFacts } from "../../lib/worker-artifact-handoff.js";
import { isStepPersistenceFailure } from "../../lib/definition-lifecycle-failure.js";

/** Pure mapping from typed Repair facts to this Step's terminal Result. */
export function draftCoverageRepairResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("draft-coverage-repair", facts);
  if (!(facts instanceof DraftRepairResultFacts) || facts.stepId !== "draft-coverage-repair") {
    throw new TypeError("draft coverage Repair Result requires its typed worker facts");
  }
  return facts.draftChanged
    ? new DraftCoverageRepairChangedResult()
    : new DraftCoverageRepairUnchangedResult();
}

/**
 * Apply coverage-triage decisions to the Draft and record the repair.
 * The existing worker handoff applies the selected coverage repair.
 */
export class DraftCoverageRepairStep extends Step {
  static dependencies = [DraftService];

  #draftService;

  constructor(draftService) {
    super();
    if (!(draftService instanceof DraftService)) throw new TypeError("DraftService is required");
    this.#draftService = draftService;
  }

  async _execute() {
    let result;
    try {
      result = draftCoverageRepairResult(this.#draftService.inspectWorkerFacts().repairResult);
    } catch (error) {
      if (isStepPersistenceFailure(error)) throw error;
      result = draftCoverageRepairResult(error);
    }
    await result.persist(this.#draftService);
    return result;
  }
}
