import { ArtifactWorkerExecutionFrontier } from "./artifact-worker-execution-frontier.js";

/** Fresh observations shared by next-action, resume and provider admission. */
export class ArtifactWorkerExecutionContinuationFacts {
  constructor({ frontier, response = "absent", publication = "unpublished", physical = "unknown",
    newlyClaimed = false, retryAuthorized = false, recoveryBudgetAvailable = false, responseDigest = null,
    refusal = null, ownerGeneration = null, unusedAuthorizationAvailable = false }) {
    if (!(frontier instanceof ArtifactWorkerExecutionFrontier)
      || !["absent", "unsealed", "sealed", "invalid"].includes(response)
      || !["unpublished", "pending", "accepted", "unknown"].includes(publication)
      || !["unstarted", "stopped", "running", "unknown"].includes(physical)
      || typeof newlyClaimed !== "boolean" || typeof retryAuthorized !== "boolean"
      || typeof recoveryBudgetAvailable !== "boolean"
      || typeof unusedAuthorizationAvailable !== "boolean"
      || ownerGeneration !== null && (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0)
      || responseDigest !== null && !/^[a-f0-9]{64}$/.test(responseDigest)
      || refusal !== null && !(refusal instanceof Error)
      || response === "invalid" && refusal === null) {
      throw new TypeError("Artifact execution continuation requires authenticated observations");
    }
    Object.assign(this, { frontier, response, publication, physical, newlyClaimed, retryAuthorized,
      recoveryBudgetAvailable, responseDigest, refusal, ownerGeneration, unusedAuthorizationAvailable });
    Object.freeze(this);
  }
}

class ArtifactWorkerExecutionContinuation {
  constructor(facts) {
    this.executionContract = facts.frontier.executionContract;
    this.contractId = this.executionContract?.id ?? null;
    this.recovery = facts.frontier.recovery;
    this.recoveryId = this.recovery?.id ?? null;
    this.reservationContinuation = facts.frontier.reservationContinuation;
    this.responseDigest = facts.responseDigest;
    this.ownerGeneration = facts.ownerGeneration;
    this.retryable = false;
  }
}

export class ArtifactWorkerNewExecution extends ArtifactWorkerExecutionContinuation {
  constructor(facts) { super(facts); Object.freeze(this); }
  get requiresWorker() { return true; }
  get usesSavedResponse() { return false; }
}

export class ArtifactWorkerSealedReplay extends ArtifactWorkerExecutionContinuation {
  constructor(facts) { super(facts); if (new.target === ArtifactWorkerSealedReplay) Object.freeze(this); }
  get requiresWorker() { return false; }
  get usesSavedResponse() { return true; }
}

export class ArtifactWorkerPublicationReplay extends ArtifactWorkerSealedReplay {
  constructor(facts) { super(facts); Object.freeze(this); }
}

export class ArtifactWorkerRecoveryRequired extends ArtifactWorkerExecutionContinuation {
  constructor(facts) { super(facts); Object.freeze(this); }
  get requiresWorker() { return false; }
  get usesSavedResponse() { return false; }
}

export class ArtifactWorkerRecoveryAuthorized extends ArtifactWorkerExecutionContinuation {
  constructor(facts) { super(facts); Object.freeze(this); }
  get requiresWorker() { return true; }
  get usesSavedResponse() { return false; }
}

export class ArtifactWorkerExecutionStop extends ArtifactWorkerExecutionContinuation {
  constructor(facts, { code, reason, missingConditions = [] }) {
    super(facts);
    this.code = facts.refusal?.code ?? code;
    this.reason = facts.refusal?.message ?? reason;
    this.cause = facts.refusal;
    this.missingConditions = Object.freeze([...missingConditions]);
    this.resolutionOperation = null;
    this.resolutionImplemented = false;
    Object.freeze(this);
  }
  get requiresWorker() { return false; }
  get usesSavedResponse() { return false; }
}

/** Definition policy: a retained claim is evidence, never another spawn permit. */
export function resolveArtifactWorkerExecutionContinuation(facts) {
  if (!(facts instanceof ArtifactWorkerExecutionContinuationFacts)) {
    throw new TypeError("Artifact worker continuation requires typed observations");
  }
  if (facts.refusal !== null || facts.response === "invalid") return new ArtifactWorkerExecutionStop(facts, {
    code: "FLOW_ARTIFACT_EXECUTION_INVALID", reason: "Saved artifact execution evidence is invalid.",
    missingConditions: ["authenticated-execution-evidence"],
  });
  if (facts.publication === "unknown") return new ArtifactWorkerExecutionStop(facts, {
    code: "FLOW_ARTIFACT_EXECUTION_PUBLICATION_UNKNOWN", reason: "Artifact execution publication state is unknown.",
    missingConditions: ["known-publication-state"],
  });
  if (facts.ownerGeneration !== null && facts.frontier.executionContract !== null
    && facts.ownerGeneration > facts.frontier.executionContract.generation) {
    return new ArtifactWorkerNewExecution(facts);
  }
  if (["pending", "accepted"].includes(facts.publication)) return new ArtifactWorkerPublicationReplay(facts);
  if (facts.response === "sealed") return new ArtifactWorkerSealedReplay(facts);
  const { frontier } = facts;
  if (frontier.executionContract === null) return new ArtifactWorkerNewExecution(facts);
  if (facts.retryAuthorized && facts.response === "unsealed" && ["stopped", "unstarted"].includes(facts.physical)) {
    return new ArtifactWorkerNewExecution(facts);
  }
  if (frontier.recovery === null && facts.physical === "unstarted"
    && (frontier.reservationContinuation?.pending === true || facts.unusedAuthorizationAvailable)) {
    return new ArtifactWorkerRecoveryAuthorized(facts);
  }
  if (frontier.recovery === null && frontier.status === "reserved" && facts.physical === "unstarted") {
    return new ArtifactWorkerRecoveryRequired(facts);
  }
  if (frontier.recovery?.targetContractId === frontier.executionContract.id) {
    if (frontier.status === "reserved" && facts.physical === "unstarted"
      && frontier.reservationContinuation === null) return new ArtifactWorkerRecoveryRequired(facts);
    if (frontier.status === "unconsumed" && facts.physical !== "running"
      || frontier.status === "reserved" && facts.physical === "unstarted" && frontier.reservationContinuation?.pending === true) {
      return new ArtifactWorkerRecoveryAuthorized(facts);
    }
    return new ArtifactWorkerExecutionStop(facts, {
      code: "FLOW_ARTIFACT_EXECUTION_RECOVERY_EXHAUSTED",
      reason: "The authorized replacement execution has already reserved or consumed its provider call.",
      missingConditions: ["unused-recovery-authorization"],
    });
  }
  if (facts.newlyClaimed && facts.response === "unsealed") {
    return new ArtifactWorkerNewExecution(facts);
  }
  if (!["stopped", "unstarted"].includes(facts.physical)) return new ArtifactWorkerExecutionStop(facts, {
    code: "FLOW_ARTIFACT_EXECUTION_STOP_UNCONFIRMED",
    reason: facts.physical === "running" ? "The previous artifact worker is still running."
      : "The previous artifact worker has no authenticated stop or non-execution proof.",
    missingConditions: ["confirmed-stop-or-non-execution"],
  });
  if (frontier.recovery !== null || !facts.recoveryBudgetAvailable) return new ArtifactWorkerExecutionStop(facts, {
    code: "FLOW_ARTIFACT_EXECUTION_RECOVERY_EXHAUSTED", reason: "The artifact execution has no remaining recovery authorization or provider budget.",
    missingConditions: ["unused-recovery-authorization", "remaining-provider-budget"],
  });
  return new ArtifactWorkerRecoveryRequired(facts);
}
