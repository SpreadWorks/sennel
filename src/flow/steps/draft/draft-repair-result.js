import {
  DraftQuestionsRepairChangedResult, DraftQuestionsRepairUnchangedResult,
  DraftCoverageRepairChangedResult, DraftCoverageRepairUnchangedResult,
  DraftGateRepairAppliedResult, DraftGateRepairCarryForwardResult,
  DraftGateRepairWorkerRequiredResult, StepErrorResult,
} from "../../engine/step-result.js";
import { PlanGateRepairOutcomeDraft } from "../../lib/gate-observation-convergence.js";
import { PlanGateRepairRecord } from "../../lib/plan-gate-repair.js";

export class DraftRepairResultFacts {
  constructor({ stepId, draftChanged }) {
    if (!["draft-questions-repair", "draft-coverage-repair"].includes(stepId)
      || typeof draftChanged !== "boolean") {
      throw new TypeError("Draft Repair facts require a Repair Step and changed decision");
    }
    this.stepId = stepId;
    this.draftChanged = draftChanged;
    Object.freeze(this);
  }
}

/** Pure mapping from typed Repair facts to this Step's terminal Result. */
export function draftQuestionsRepairResult(facts) {
  if (facts instanceof Error) return new StepErrorResult("draft-questions-repair", facts);
  if (!(facts instanceof DraftRepairResultFacts) || facts.stepId !== "draft-questions-repair") {
    throw new TypeError("draft questions Repair Result requires its typed worker facts");
  }
  return facts.draftChanged
    ? new DraftQuestionsRepairChangedResult()
    : new DraftQuestionsRepairUnchangedResult();
}


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
