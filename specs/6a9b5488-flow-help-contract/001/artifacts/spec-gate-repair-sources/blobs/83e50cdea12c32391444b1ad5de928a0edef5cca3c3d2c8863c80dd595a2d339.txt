import { opensReviewFindingCycle } from "./finding-disposition-policy.js";

/** User-facing assurance derived from committed continuation decisions. */
class AdvisoryContinuationSummary {
  constructor({ stepId, evidenceRef, rationale, remainingRisk }) {
    this.stepId = stepId;
    this.evidenceRef = evidenceRef;
    this.rationale = rationale;
    this.remainingRisk = remainingRisk;
    Object.freeze(this);
  }

  static fromActivity(activity, currentReviewCycle) {
    const record = activity.transition.nonblocking;
    if (record?.kind === "decision" && record.action === "continue") {
      return new AdvisoryContinuationSummary({
        stepId: record.sourceStep, evidenceRef: record.evidenceRef,
        rationale: record.rationale, remainingRisk: record.remainingRisk,
      });
    }
    if (!currentReviewCycle) return null;
    const plan = activity.transition.taskReviewStagePlan;
    const selection = plan?.facts.noChangeContinuation;
    if (selection?.decision !== "continue") return null;
    return new AdvisoryContinuationSummary({
      stepId: `${plan.facts.binding.taskId}-${plan.facts.binding.stage}`,
      evidenceRef: selection.acceptanceHandoffId,
      rationale: selection.reason,
      remainingRisk: "Task Gate was skipped for an unchanged source; Acceptance must assess the bound Review and continuation evidence.",
    });
  }

  toJSON() {
    return { stepId: this.stepId, evidenceRef: this.evidenceRef, rationale: this.rationale, remainingRisk: this.remainingRisk };
  }
}

export function projectAdvisorySummary(activities) {
  const cycleStart = activities.findLastIndex(opensReviewFindingCycle);
  return activities.map((activity, index) => AdvisoryContinuationSummary.fromActivity(activity, index > cycleStart))
    .filter((entry) => entry !== null).map((entry) => Object.freeze(entry.toJSON()));
}
