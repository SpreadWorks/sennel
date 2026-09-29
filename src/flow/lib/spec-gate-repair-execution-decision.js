/** Durable observations only; worker execution policy is owned by Definition. */
export class SpecGateRepairExecutionFacts {
  constructor({ phase, publicationCompletion = null, response = "absent" }) {
    if (![null, "checkpoint", "claimed", "publication", "terminal"].includes(phase)
      || !["absent", "unsealed", "sealed"].includes(response)) {
      throw new TypeError("Spec Gate repair execution facts are invalid");
    }
    this.phase = phase;
    this.publicationCompletion = publicationCompletion;
    this.response = response;
    Object.freeze(this);
  }
}

export class SpecGateRepairNewWorker {}
export class SpecGateRepairSealedReplay {}
export class SpecGateRepairPublicationReplay {}
export class SpecGateRepairExecutionStop {
  constructor() {
    this.code = "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE";
    this.reason = "claimed Spec Gate repair has no exact sealed worker response";
    Object.freeze(this);
  }
}

export function resolveSpecGateRepairExecution(facts) {
  if (!(facts instanceof SpecGateRepairExecutionFacts)) {
    throw new TypeError("Spec Gate repair execution requires canonical facts");
  }
  if (facts.phase === "publication" && facts.publicationCompletion === null) {
    return new SpecGateRepairPublicationReplay();
  }
  if (facts.phase === "claimed") {
    return facts.response === "sealed"
      ? new SpecGateRepairSealedReplay() : new SpecGateRepairExecutionStop();
  }
  return new SpecGateRepairNewWorker();
}
