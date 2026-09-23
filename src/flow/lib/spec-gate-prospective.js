import { createHash } from "node:crypto";
import { SpecGateIssuePublication } from "./gate-issue-publication.js";
import { CurrentAttemptIdentity, CurrentFlowStateConflictError } from "./current-flow-state.js";
import {
  attachedCanonicalCommandResultArtifact,
  attachedCanonicalCommandResultPublications,
} from "./canonical-command-result.js";

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

/** Optimistic proof of the canonical inputs used to select one Gate Result. */
export class SpecGatePublicationVersion {
  constructor({ binding, view } = {}) {
    if (binding?.stepId !== "spec-gate"
      || !/^[a-f0-9]{64}$/.test(view?.revision ?? "")
      || !/^[a-f0-9]{64}$/.test(view?.catalog?.hash ?? "")) {
      throw new TypeError("Spec Gate publication version requires its canonical view");
    }
    this.runId = binding.runId;
    this.specId = binding.specId;
    this.stepId = binding.stepId;
    this.attempt = CurrentAttemptIdentity.from(binding.attempt);
    this.revision = view.revision;
    this.catalogFingerprint = view.catalog.hash;
    this.assert(view);
    Object.freeze(this);
  }

  matches(binding) {
    return binding?.runId === this.runId && binding?.specId === this.specId
      && binding?.stepId === this.stepId && binding?.attempt?.id === this.attempt.id
      && binding?.attempt?.sequence === this.attempt.sequence;
  }

  assert(view) {
    if (view.revision !== this.revision || view.catalog.hash !== this.catalogFingerprint
      || view.state.runId !== this.runId || view.state.specId !== this.specId
      || !this.attempt.matches(view.state)) {
      throw new CurrentFlowStateConflictError("Spec Gate canonical inputs changed before settlement");
    }
  }

  toJSON() {
    return {
      runId: this.runId, specId: this.specId, stepId: this.stepId,
      attempt: this.attempt.toJSON(), revision: this.revision,
      catalogFingerprint: this.catalogFingerprint,
    };
  }
}

/** Sealed evidence and lock-scoped admission; never re-evaluates Gate semantics. */
export class SpecGatePublicationIntent {
  constructor({ facts, issue = null, version, binding, commandResult } = {}) {
    if (!(facts instanceof SpecGateProspectiveFacts)
      || !(version instanceof SpecGatePublicationVersion) || !version.matches(binding)
      || (facts.result === "fail") !== (issue instanceof SpecGateIssuePublication)
      || (issue !== null && !issue.matches(binding))) {
      throw new TypeError("Spec Gate publication requires matching facts and issue evidence");
    }
    const artifact = attachedCanonicalCommandResultArtifact(commandResult);
    if (artifact?.logicalKey !== "spec.gate"
      || createHash("sha256").update(JSON.stringify(artifact.payload)).digest("hex") !== facts.resultFingerprint) {
      throw new CurrentFlowStateConflictError("Spec Gate publication differs from its accepted facts");
    }
    this.facts = facts;
    this.issue = issue;
    this.version = version;
    this.publicationDigest = this.#publicationDigest(commandResult);
    Object.freeze(this);
  }

  #publicationDigest(commandResult) {
    return createHash("sha256").update(JSON.stringify({
      result: attachedCanonicalCommandResultArtifact(commandResult)?.toJSON() ?? null,
      publications: attachedCanonicalCommandResultPublications(commandResult).map((entry) => entry.toJSON()),
      issue: this.issue?.toJSON() ?? null,
    })).digest("hex");
  }

  assertPublication({ binding, commandResult }) {
    if (!this.version.matches(binding) || this.#publicationDigest(commandResult) !== this.publicationDigest) {
      throw new CurrentFlowStateConflictError("Spec Gate publication changed after Result selection");
    }
  }

  assert(view) { this.version.assert(view); }

  toJSON() {
    return {
      facts: { ...this.facts }, issue: this.issue?.toJSON() ?? null,
      version: this.version.toJSON(), publicationDigest: this.publicationDigest,
    };
  }
}
