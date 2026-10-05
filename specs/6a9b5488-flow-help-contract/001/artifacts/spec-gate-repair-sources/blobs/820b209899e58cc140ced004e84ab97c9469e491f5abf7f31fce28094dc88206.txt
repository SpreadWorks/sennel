/** Durable observations only; worker execution policy is owned by Definition. */
export class SpecGateRepairExecutionFacts {
  constructor({ phase, publicationCompletion = null, response = "absent", formatAvailable = true }) {
    if (![null, "checkpoint", "claimed", "publication", "terminal"].includes(phase)
      || !["absent", "unsealed", "sealed", "present"].includes(response)
      || typeof formatAvailable !== "boolean" || formatAvailable && response === "present") {
      throw new TypeError("Spec Gate repair execution facts are invalid");
    }
    this.phase = phase;
    this.publicationCompletion = publicationCompletion;
    this.response = response;
    this.formatAvailable = formatAvailable;
    Object.freeze(this);
  }
}

export class SpecGateRepairNewWorker {}
export class SpecGateRepairExecutionFormatUnavailable {
  constructor() {
    this.code = "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE";
    this.reason = "Saved unfinished Gate repair has no current immutable input descriptor";
    Object.freeze(this);
  }
}
export class SpecGateRepairCheckpointResume {}
export class SpecGateRepairSealedReplay {}
export class SpecGateRepairPublicationReplay {}
export class SpecGateRepairExecutionStop {
  constructor({ phase = "claimed" } = {}) {
    this.code = "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE";
    this.reason = phase === "checkpoint"
      ? "Spec Gate repair checkpoint has no exact unsealed worker request"
      : "claimed Spec Gate repair has no exact sealed worker response";
    Object.freeze(this);
  }
}

export function resolveSpecGateRepairExecution(facts) {
  if (!(facts instanceof SpecGateRepairExecutionFacts)) {
    throw new TypeError("Spec Gate repair execution requires canonical facts");
  }
  if (!facts.formatAvailable) {
    return facts.phase === "claimed" && facts.response === "absent"
      ? new SpecGateRepairExecutionStop() : new SpecGateRepairExecutionFormatUnavailable();
  }
  if (facts.phase === "publication" && facts.publicationCompletion === null) {
    return new SpecGateRepairPublicationReplay();
  }
  if (facts.phase === "checkpoint") {
    return facts.response === "unsealed"
      ? new SpecGateRepairCheckpointResume() : new SpecGateRepairExecutionStop({ phase: "checkpoint" });
  }
  if (facts.phase === "claimed") {
    return facts.response === "sealed"
      ? new SpecGateRepairSealedReplay() : new SpecGateRepairExecutionStop();
  }
  return new SpecGateRepairNewWorker();
}
