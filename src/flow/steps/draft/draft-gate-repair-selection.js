import { isDeepStrictEqual } from "node:util";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";
import { StepResult, DraftGateRepairAppliedResult, DraftGateRepairCarryForwardResult, stepResultDigest } from "../../engine/step-result.js";
import { GateObservationRepair, PlanGateRepairOutcomeDraft } from "../../lib/gate-observation-convergence.js";

/** The Gate Repair Step's terminal choice retained through publication recovery. */
export class DraftGateRepairSelection {
  constructor({ result, outcome }) {
    const disposition = result instanceof DraftGateRepairAppliedResult ? "applied"
      : result instanceof DraftGateRepairCarryForwardResult ? "rejected-no-progress" : null;
    if (!(outcome instanceof PlanGateRepairOutcomeDraft) || disposition === null
      || outcome.disposition !== disposition) {
      throw new TypeError("Draft Gate repair selection requires its exact Result and outcome");
    }
    outcome.seal("draft-gate-repair-selection-validation");
    this.result = result;
    this.resultDigest = stepResultDigest(result);
    this.outcome = outcome;
    Object.freeze(this);
  }

  assertResult(result) {
    if (stepResultDigest(result) !== this.resultDigest) {
      throw new CurrentFlowStateConflictError("Draft Gate repair Result differs from its published selection");
    }
  }

  assertBinding(binding, lifecycle) {
    if (binding.stepId !== "draft-gate-repair" || lifecycle?.phase !== "publication"
      || this.outcome.repair.targetAttempt.id !== binding.attemptId
      || this.outcome.repair.targetAttempt.sequence !== binding.attemptSequence
      || this.outcome.repair.handoffRevision !== lifecycle.binding.inputRevision) {
      throw new TypeError("Draft Gate repair selection differs from its publication binding");
    }
  }

  assertPublication({ draftDigest, auditReport = null }) {
    if (draftDigest !== this.outcome.report.outputEvidenceDigest) {
      throw new CurrentFlowStateConflictError("Draft Gate repair selection differs from its published Draft");
    }
    if (this.outcome.disposition === "applied"
      && (auditReport === null || !isDeepStrictEqual(auditReport, this.outcome.report.toJSON()))) {
      throw new CurrentFlowStateConflictError("Draft Gate repair selection differs from its published audit");
    }
  }

  toJSON() {
    return { result: this.result.toJSON(), outcome: {
      repair: this.outcome.repair.toJSON(), disposition: this.outcome.disposition,
      report: this.outcome.report.toJSON(),
    } };
  }

  static fromJSON(value) {
    if (Object.keys(value).sort().join() !== "outcome,result"
      || Object.keys(value.outcome).sort().join() !== "disposition,repair,report") {
      throw new TypeError("Draft Gate repair selection has invalid fields");
    }
    return new DraftGateRepairSelection({
      result: StepResult.fromStored("draft-gate-repair", value.result),
      outcome: new PlanGateRepairOutcomeDraft({ ...value.outcome, repair: GateObservationRepair.fromJSON(value.outcome.repair) }),
    });
  }
}
