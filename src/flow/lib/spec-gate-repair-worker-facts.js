import { CanonicalWorkerSpecPublication } from "./current-flow-state.js";
import { SpecGateRepairInput } from "./spec-gate-repair-input.js";
import {
  SpecGateRepairReviewRequiredResult, SpecGateRepairReadyForGateResult,
} from "../engine/step-result.js";

/** Published worker evidence and the remaining canonical work at this Attempt. */
export class SpecGateRepairContinuationFacts {
  constructor({ input, ledger, locationPlan, proposal }) {
    if (!(input instanceof SpecGateRepairInput) || !Array.isArray(ledger?.entries)) {
      throw new TypeError("Gate repair continuation requires canonical progress facts");
    }
    this.input = input;
    this.unresolvedLocationCount = input.context.unresolvedFindings().length;
    this.locationBatchCount = locationPlan?.batches.length ?? 0;
    this.completedLocationBatchCount = ledger.forMode("locate").length;
    this.unitCount = this.unresolvedLocationCount === 0 ? input.context.units().length : 0;
    this.completedUnitCount = this.unresolvedLocationCount === 0
      ? ledger.completedUnitIds(input.context).length : 0;
    this.decisionRequired = proposal?.stage === "spec-gate-repair-user-input";
    this.additionalContextRequested = proposal?.stage === "spec-gate-repair-context-request";
    Object.freeze(this);
  }
}

export class SpecGateRepairWorkerFacts {
  constructor({ input, proposal }) {
    if (!(input instanceof SpecGateRepairInput)
      || !["spec-gate-repair", "spec-gate-repair-locate", "spec-gate-repair-evidence",
        "spec-gate-repair-context-request", "spec-gate-repair-user-input"].includes(proposal?.stage)) {
      throw new TypeError("Spec Gate repair worker facts require canonical input and proposal");
    }
    this.input = input;
    this.proposal = Object.freeze(structuredClone(proposal));
    Object.freeze(this);
  }
}

/** The accepted groups, Result and version-linked audit are one Step decision. */
export class SpecGateRepairSelection {
  constructor({ result, publication, audit, facts }) {
    if (!(facts instanceof SpecGateRepairWorkerFacts)
      || !(result instanceof SpecGateRepairReviewRequiredResult
        || result instanceof SpecGateRepairReadyForGateResult)
      || !(publication instanceof CanonicalWorkerSpecPublication)
      || audit?.phase !== "spec-gate-repair") {
      throw new TypeError("Spec Gate repair selection requires a typed Result and publication");
    }
    this.result = result;
    this.publication = publication;
    this.audit = Object.freeze(structuredClone(audit));
    this.facts = facts;
    Object.freeze(this);
  }
  assertResult(result) {
    if (result !== this.result) throw new TypeError("Spec Gate repair Result changed after selection");
  }
}
