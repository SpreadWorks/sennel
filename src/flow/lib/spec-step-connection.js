import {
  CanonicalFlowArtifactBaseline,
  CanonicalWorkerSpecPublication,
} from "./current-flow-state.js";
import { SpecWorkerStepBinding } from "../engine/connectors/spec/spec-step-binding.js";
import { PlanGateRepairOutcomeDraft } from "./gate-observation-convergence.js";

/** Validated, side-effect-free output facts produced by the Spec worker. */
export class SpecWorkerCompletionFacts {
  constructor({ publication, baseline, planGateRepairOutcome = null } = {}) {
    if (!(publication instanceof CanonicalWorkerSpecPublication)) {
      throw new TypeError("Spec worker facts require a typed Spec publication");
    }
    if (!(baseline instanceof CanonicalFlowArtifactBaseline)
      || baseline.artifact.logicalKey !== "spec.record") {
      throw new TypeError("Spec worker facts require the canonical Spec baseline");
    }
    if (planGateRepairOutcome !== null
      && !(planGateRepairOutcome instanceof PlanGateRepairOutcomeDraft)) {
      throw new TypeError("Spec worker facts require a typed plan Gate repair outcome");
    }
    this.publication = publication;
    this.baseline = baseline;
    this.planGateRepairOutcome = planGateRepairOutcome;
    Object.freeze(this);
  }
}

/** Exact publication and successor connection selected after Definition settles the Result. */
export class SpecReviewSettlementApplication {
  constructor({ binding, facts } = {}) {
    if (!(binding instanceof SpecWorkerStepBinding)
      || !(facts instanceof SpecWorkerCompletionFacts)) {
      throw new TypeError("Spec review connection requires its binding and completion facts");
    }
    binding.assertCurrent();
    this.runId = binding.runId;
    this.specId = binding.specId;
    this.sourceStepId = binding.stepId;
    this.sourceAttempt = binding.attempt;
    this.targetStepId = "spec-review";
    this.publication = facts.publication;
    this.baseline = facts.baseline;
    Object.freeze(this);
  }
}
