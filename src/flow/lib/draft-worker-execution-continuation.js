/** Read-only observations of a conditional Draft execution. */
export class DraftWorkerExecutionContinuationFacts {
  constructor({ phase = null, response = "absent", newlyClaimed = false, retryAuthorized = false,
    receiptId = null, responseDigest = null, refusal = null } = {}) {
    if (![null, "checkpoint", "claimed", "publication", "terminal"].includes(phase)
      || !["absent", "unsealed", "sealed", "invalid"].includes(response)
      || typeof newlyClaimed !== "boolean"
      || typeof retryAuthorized !== "boolean"
      || newlyClaimed && phase !== "claimed"
      || retryAuthorized && phase !== "claimed"
      || receiptId !== null && !/^[a-f0-9]{64}$/.test(receiptId)
      || responseDigest !== null && !/^[a-f0-9]{64}$/.test(responseDigest)
      || refusal !== null && !(refusal instanceof Error)
      || response !== "absent" && !["claimed", "publication"].includes(phase)
      || (response === "invalid") !== (refusal instanceof Error)) {
      throw new TypeError("Draft execution continuation requires valid observed lifecycle and response facts");
    }
    this.phase = phase;
    this.response = response;
    this.newlyClaimed = newlyClaimed;
    this.retryAuthorized = retryAuthorized;
    this.receiptId = receiptId;
    this.responseDigest = responseDigest;
    this.refusal = refusal;
    Object.freeze(this);
  }
}

export class DraftWorkerNewExecution {
  constructor(facts) {
    this.receiptId = facts.receiptId;
    this.responseDigest = facts.responseDigest;
    Object.freeze(this);
  }
  get requiresWorker() { return true; }
  get usesSavedResponse() { return false; }
}

export class DraftWorkerSealedReplay {
  constructor(facts) {
    this.receiptId = facts.receiptId;
    this.responseDigest = facts.responseDigest;
    Object.freeze(this);
  }
  get requiresWorker() { return false; }
  get usesSavedResponse() { return true; }
}

export class DraftWorkerPublicationReplay {
  constructor(facts) {
    this.receiptId = facts.receiptId;
    this.responseDigest = facts.responseDigest;
    Object.freeze(this);
  }
  get requiresWorker() { return false; }
  get usesSavedResponse() { return true; }
}

export class DraftWorkerExecutionStop {
  constructor(facts) {
    this.receiptId = facts.receiptId;
    this.responseDigest = facts.responseDigest;
    this.code = facts.refusal?.code ?? "FLOW_EXECUTION_CONTRACT_MISMATCH";
    this.reason = facts.refusal?.message ?? (facts.phase === "terminal"
      ? "Draft worker execution already has its terminal receipt"
      : "Worker claim has no exact sealed response for recovery");
    this.cause = facts.refusal;
    Object.freeze(this);
  }

  get requiresWorker() { return false; }
  get usesSavedResponse() { return false; }
}

/** Definition policy; reacquiring an existing claim never authorizes another call. */
export function resolveDraftWorkerExecutionContinuation(facts) {
  if (!(facts instanceof DraftWorkerExecutionContinuationFacts)) {
    throw new TypeError("Draft worker continuation requires typed observations");
  }
  if (facts.response === "invalid" || facts.phase === "terminal") {
    return new DraftWorkerExecutionStop(facts);
  }
  if (facts.phase === "publication") {
    return facts.response === "sealed"
      ? new DraftWorkerPublicationReplay(facts) : new DraftWorkerExecutionStop(facts);
  }
  if (facts.phase === "claimed") {
    if (facts.response === "sealed") return new DraftWorkerSealedReplay(facts);
    return (facts.newlyClaimed || facts.retryAuthorized) && facts.response === "unsealed"
      ? new DraftWorkerNewExecution(facts) : new DraftWorkerExecutionStop(facts);
  }
  return new DraftWorkerNewExecution(facts);
}
