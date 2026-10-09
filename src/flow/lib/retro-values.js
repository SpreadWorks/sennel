import { AcceptedNonblockingDecision } from "./accepted-nonblocking-decision.js";
import { NonGateTargetBinding, NonGateCatalogPublication } from "./non-gate-transition.js";
import { RetroStaleEvidenceRecoveryFacts } from "./retro-stale-evidence-values.js";
import { requireDigest } from "./flow-value-assertions.js";

/** Requirement aggregation preserves the original test producer's outcomes. */
export class RetroAggregate {
  constructor(requirements, summary) {
    const byId = new Map(summary.map((entry) => [entry.id, entry]));
    const testable = requirements.filter((entry) => entry.testable !== false);
    this.requirements = Object.freeze(testable.map((requirement) => {
      const entry = byId.get(requirement.id);
      const value = entry === undefined
        ? { desc: requirement.desc, status: "not_done", note: "missing from test-execute-result.json summary[]" }
        : entry.result === "pass"
          ? { desc: requirement.desc, status: "done", note: entry.evidence?.test_name || "" }
          : entry.result === "not_applicable"
            ? { desc: requirement.desc, status: "not_applicable", note: entry.reason || "no_tests_declared" }
            : entry.result === "deferred"
              ? { desc: requirement.desc, status: "deferred", note: `Requirement test work deferred by ${entry.deferred_receipt.sourceArtifact}` }
              : { desc: requirement.desc, status: "not_done", note: entry.error || entry.evidence?.test_name || "" };
      return Object.freeze(value);
    }));
    const total = this.requirements.length;
    const done = this.requirements.filter((entry) => entry.status === "done").length;
    const notApplicable = this.requirements.filter((entry) => entry.status === "not_applicable").length;
    const deferred = this.requirements.filter((entry) => entry.status === "deferred").length;
    const notTestable = requirements.length - total;
    this.summary = Object.freeze({ total, done, partial: 0, not_done: total - done - notApplicable - deferred,
      not_applicable_count: notApplicable, deferred_count: deferred, na_count: notTestable,
      not_testable_count: notTestable, rate: total === 0 ? 0 : Math.round(done / total * 100) / 100,
      notes: "aggregated from test-execute-result.json" });
    Object.freeze(this);
  }
  toJSON() { return { requirements: [...this.requirements], unplanned: [], summary: { ...this.summary } }; }
}

/** Adopted aggregate or stale observation, bound to its actual source Attempt. */
export class RetroResultEvidence {
  constructor({ identity, publication = null, fingerprint, notDone = 0, staleFacts = null, nonblocking = false, acceptedDecision = null }) {
    if (!(identity instanceof NonGateTargetBinding) || identity.stepId !== "retro"
      || publication !== null && (!(publication instanceof NonGateCatalogPublication)
        || publication.runId !== identity.runId || publication.specId !== identity.specId
        || publication.stepId !== identity.stepId || !publication.attempt.matches(identity.attempt))
      || !Number.isSafeInteger(notDone) || notDone < 0 || typeof nonblocking !== "boolean") {
      throw new TypeError("Retro requires its exact identity and aggregate observation");
    }
    if (staleFacts !== null && (!(staleFacts instanceof RetroStaleEvidenceRecoveryFacts)
      || staleFacts.runId !== identity.runId || staleFacts.specId !== identity.specId
      || staleFacts.attemptId !== identity.attempt.id || staleFacts.sequence !== identity.attempt.sequence
      || publication !== null)) throw new TypeError("Retro stale evidence belongs to another Attempt");
    this.identity = identity;
    this.publication = publication;
    this.fingerprint = requireDigest(fingerprint, "Retro source fingerprint");
    this.notDone = notDone;
    this.staleFacts = staleFacts;
    this.nonblocking = nonblocking;
    if (acceptedDecision !== null && (!(acceptedDecision instanceof AcceptedNonblockingDecision)
      || notDone === 0 || staleFacts !== null)) {
      throw new TypeError("Retro acceptance requires its original incomplete advisory evidence");
    }
    this.acceptedDecision = acceptedDecision;
    acceptedDecision?.assertEvidence(this);
    Object.freeze(this);
  }
  get stepId() { return "retro"; }
  get resultKind() { return this.staleFacts !== null ? "retro-evidence-refresh"
    : this.notDone > 0 ? "retro-incomplete" : "retro-aggregated"; }
  assertResultKind(kind) { if (kind !== this.resultKind) throw new TypeError("Retro Result contradicts its acquired observation"); }
  withAcceptedDecision(acceptedDecision) {
    return new RetroResultEvidence({ ...this, acceptedDecision });
  }
  toJSON() { return { identity: this.identity.toJSON(), publication: this.publication?.toJSON() ?? null,
    fingerprint: this.fingerprint, notDone: this.notDone, staleFacts: this.staleFacts?.toJSON() ?? null,
    nonblocking: this.nonblocking,
    ...(this.acceptedDecision === null ? {} : { acceptedDecision: this.acceptedDecision.toJSON() }) }; }
  static fromJSON(value) { return new this({ ...value,
    acceptedDecision: value.acceptedDecision == null ? null : AcceptedNonblockingDecision.fromJSON(value.acceptedDecision), identity: new NonGateTargetBinding(value.identity),
    publication: value.publication === null ? null : new NonGateCatalogPublication(value.publication),
    staleFacts: value.staleFacts === null ? null : RetroStaleEvidenceRecoveryFacts.fromJSON(value.staleFacts) }); }
}
