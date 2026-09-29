/** Validated prospective observation for the two phases owned by spec-gate. */
export class SpecGateProspectiveFacts {
  constructor({ phase, result, failureCategory = null, failureCode = null,
    retryExhausted = false, sameEvidence = false, repairAvailable = false,
    cycle = 1, nonblockingEnabled = false, acceptanceBacked = false,
    integrityFailure = null, resultFingerprint, retryUsed = 0, retryMaximum = 1 } = {}) {
    if (!["spec", "task-spec"].includes(phase)
      || !["pass", "fail", "recovered"].includes(result)
      || (result === "fail") !== (["semantic", "local"].includes(failureCategory))
      || (failureCode !== null && typeof failureCode !== "string")
      || !Number.isSafeInteger(cycle) || cycle < 1
      || !Number.isSafeInteger(retryUsed) || retryUsed < 0
      || !Number.isSafeInteger(retryMaximum) || retryMaximum < 1
      || retryUsed > retryMaximum
      || (integrityFailure !== null && typeof integrityFailure !== "string")
      || !/^[a-f0-9]{64}$/.test(resultFingerprint ?? "")
      || [retryExhausted, sameEvidence, repairAvailable, nonblockingEnabled, acceptanceBacked]
        .some((value) => typeof value !== "boolean")) {
      throw new TypeError("Spec Gate prospective facts are invalid");
    }
    this.phase = phase;
    this.result = result;
    this.failureCategory = failureCategory;
    this.failureCode = failureCode;
    this.retryExhausted = retryExhausted;
    this.sameEvidence = sameEvidence;
    this.repairAvailable = repairAvailable;
    this.cycle = cycle;
    this.nonblockingEnabled = nonblockingEnabled;
    this.acceptanceBacked = acceptanceBacked;
    this.integrityFailure = integrityFailure;
    this.resultFingerprint = resultFingerprint;
    this.retryUsed = retryUsed;
    this.retryMaximum = retryMaximum;
    Object.freeze(this);
  }
}
