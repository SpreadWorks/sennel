import { SpecGateProspectiveFacts } from "../lib/spec-gate-prospective-facts.js";

/** Accepted prospective Spec Gate facts for one bound Attempt. */
export class SpecGateInput {
  constructor(facts) {
    if (!(facts instanceof SpecGateProspectiveFacts)) {
      throw new TypeError("Spec Gate input requires typed prospective facts");
    }
    this.facts = facts;
    this.stepId = "spec-gate";
    Object.freeze(this);
  }
}
