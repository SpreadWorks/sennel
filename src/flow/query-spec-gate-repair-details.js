import { isDeepStrictEqual } from "node:util";
import { FLOW_ARTIFACT_CONTRACTS } from "../lib/flow-artifact-contract.js";
import { FlowArtifactDescriptor } from "../lib/flow-version.js";
import { FlowActivity } from "./lib/current-flow-state.js";
import { DraftStepSettlementReceipt, DraftStepExecutionLifecycle, DraftWorkerExecutionBinding } from "./definition.js";
import { SpecGateRepairReviewRequiredResult, SpecGateRepairReadyForGateResult } from "./engine/step-result.js";
import { StoredSpecGateRepairOperationAudit } from "./lib/spec-repair-operations.js";
import { FlowFindingSourceIdentity, CanonicalSourceFinding, canonicalSourceFindings } from "./lib/flow-finding-source.js";
import { GateEvidenceIdentity, SpecGateRepairObservationResult, specGateRepairObservationResult } from "./lib/gate-observation-convergence.js";
import { GateAttemptIdentity } from "./lib/gate-transition.js";
import { PlanGateRepairRecord } from "./lib/plan-gate-repair.js";
import { SpecRevisionIdentity } from "./lib/spec-revision-identity.js";
import { SpecReviewFinding, SpecReviewFindingCollection } from "./lib/spec-review-artifacts.js";
import { SpecGateRepairReviewFinding, SpecGateRepairReviewFacts } from "./lib/spec-gate-repair-review.js";

const OPERATION_FIELDS = ["version", "phase", "baseRevision", "acceptedGroups", "discardedGroups", "operationDigest", "resultRevision"];
const AUDIT_FIELDS = [...OPERATION_FIELDS, "sourceReviewIdentity", "sourceEvidenceIdentity", "sourceFindingIdentities",
  "observationIdentities", "repairId", "repairRecordFingerprint", "targetAttempt", "observationResults", "reviewFacts"];

function exact(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) throw new TypeError(`${label} has an invalid stored schema`);
}
function same(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new TypeError(`${label} differs from its saved producer binding`);
}
function identities(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${label} must retain complete finding identities`);
  const result = values.map((value) => {
    exact(value, ["sourceArtifact", "sourceStep", "sourceFindingId", "fingerprint"], label);
    const identity = new FlowFindingSourceIdentity(value);
    same(identity.toJSON(), value, label);
    if (identity.sourceStep !== "spec-gate" || identity.sourceArtifact !== FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate").relativePath) {
      throw new TypeError(`${label} does not belong to the original Spec Gate source`);
    }
    return identity;
  });
  if (new Set(result.map((identity) => identity.toString())).size !== result.length) throw new TypeError(`${label} has duplicate identities`);
  return Object.freeze(result);
}
function optionalDigest(value, label) {
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw new TypeError(`${label} must be a saved digest or null`);
  return value;
}

/** Stored Review preservation facts; no Spec application or route selection. */
export class QuerySpecGateRepairReviewFacts {
  constructor(value, operationAudit) {
    exact(value, ["version", "baseRevision", "resultRevision", "sourceReviewIdentity", "sourceReviewDigest",
      "sourceReviewArtifact", "sourceSpecDigest", "resultSpecDigest", "findings", "reviewInputPreserved",
      "unresolvedBlocking", "requiresReview", "reason"], "stored Gate repair Review facts");
    if (value.version !== 1 || !Array.isArray(value.findings)
      || ["reviewInputPreserved", "unresolvedBlocking", "requiresReview"].some((field) => typeof value[field] !== "boolean")
      || !["unresolved-blocking-review", "review-evidence-unavailable", "review-input-preservation-unproven", "exact-reviewed-input-preserved"].includes(value.reason)) {
      throw new TypeError("Stored Gate repair Review facts have invalid recorded values");
    }
    same(value.baseRevision, operationAudit.baseRevision, "Gate repair Review base revision");
    same(value.resultRevision, operationAudit.resultRevision, "Gate repair Review result revision");
    this.sourceReviewIdentity = value.sourceReviewIdentity === null ? null : new SpecRevisionIdentity(value.sourceReviewIdentity);
    if (this.sourceReviewIdentity !== null) same(this.sourceReviewIdentity.toJSON(), value.sourceReviewIdentity, "Gate repair source Review identity");
    this.sourceReviewDigest = optionalDigest(value.sourceReviewDigest, "source Review digest");
    this.sourceSpecDigest = optionalDigest(value.sourceSpecDigest, "source Spec semantic digest");
    this.resultSpecDigest = optionalDigest(value.resultSpecDigest, "result Spec semantic digest");
    if (this.resultSpecDigest === null) throw new TypeError("Gate repair Review facts require their result semantic digest");
    this.sourceReviewArtifact = value.sourceReviewArtifact;
    if (this.sourceReviewIdentity === null
      ? this.sourceReviewDigest !== null || this.sourceReviewArtifact !== null || this.sourceSpecDigest !== null || value.findings.length !== 0
      : this.sourceReviewDigest === null || typeof this.sourceReviewArtifact !== "string") {
      throw new TypeError("Gate repair Review source facts are incomplete");
    }
    if (this.sourceReviewIdentity !== null && this.sourceReviewArtifact !== FLOW_ARTIFACT_CONTRACTS.resolve("spec.review", {
      revision: this.sourceReviewIdentity.revision.toString() }).relativePath) throw new TypeError("Gate repair Review facts have a different revision path");
    const acceptedGroups = operationAudit.acceptedGroups.map((group) => group.toJSON());
    new SpecReviewFindingCollection(value.findings.map((entry) => entry.finding));
    this.findings = Object.freeze(value.findings.map((entry) => {
      exact(entry, ["identity", "finding", "relatedChanges", "unresolvedBlocking"], "stored Gate repair Review finding");
      exact(entry.identity, ["sourceArtifact", "sourceStep", "sourceFindingId", "fingerprint"], "stored Review finding identity");
      const identity = new FlowFindingSourceIdentity(entry.identity);
      if (identity.sourceStep !== "spec-review" || identity.sourceArtifact !== this.sourceReviewArtifact) throw new TypeError("Gate repair Review finding has a different source");
      const finding = new SpecReviewFinding(entry.finding);
      const [canonical] = canonicalSourceFindings({ artifact: { findings: [finding.toJSON()] }, sourceStep: "spec-review",
        sourceArtifact: this.sourceReviewArtifact });
      if (!canonical.identity.equals(identity)) throw new TypeError("Gate repair Review finding body differs from its complete source identity");
      const observed = new SpecGateRepairReviewFinding({ source: new CanonicalSourceFinding({ identity, finding: finding.toJSON() }), acceptedGroups });
      same(observed.toJSON(), entry, "Gate repair Review finding relation");
      return observed;
    }));
    this.reviewInputPreserved = value.reviewInputPreserved;
    this.unresolvedBlocking = value.unresolvedBlocking;
    this.requiresReview = value.requiresReview;
    this.reason = value.reason;
    if (this.unresolvedBlocking !== this.findings.some((finding) => finding.unresolvedBlocking)
      || this.requiresReview !== (!this.reviewInputPreserved || this.unresolvedBlocking)
      || this.reviewInputPreserved && (this.sourceSpecDigest === null || this.sourceSpecDigest !== this.resultSpecDigest)) {
      throw new TypeError("Gate repair Review preservation flags contradict their saved facts");
    }
    same(this.reason, SpecGateRepairReviewFacts.reasonFor({ unresolvedBlocking: this.unresolvedBlocking,
      sourceReviewAvailable: this.sourceReviewIdentity !== null, reviewInputPreserved: this.reviewInputPreserved }), "Gate repair Review explanation");
    Object.freeze(this);
  }
}

/** An actual adopted edit; the operation remains its existing nominal grammar. */
export class QuerySpecGateRepairOperation {
  constructor(group, operation, operationIndex, position) {
    this.jsonPointer = `/acceptedGroups/${position}/operations/${operationIndex}`;
    this.identities = group.identities;
    this.operation = operation;
    this.target = operation.target;
    this.operationKind = operation.kind;
    this.reason = operation.reason;
    this.status = "applied";
    Object.freeze(this);
  }
}

/** A discarded group retained diagnostics, without its rejected worker values. */
export class QuerySpecGateRepairDiscardedGroup {
  constructor(group, position) {
    this.referenceId = group.groupDigest;
    this.jsonPointer = `/discardedGroups/${position}`;
    this.reason = group.reason;
    this.status = "discarded";
    // These are absent in the producer audit, rather than inferred from the
    // complete source finding list or the current Spec's target inventory.
    this.target = null;
    this.operationKind = null;
    this.identities = Object.freeze([]);
    Object.freeze(this);
  }
}

/** Exact terminal audit and its recorded edit/rejection observations. */
export class QuerySpecGateRepairObservation {
  constructor({ audit, state, activity, descriptor, repairRecord, baseSpecDescriptor }) {
    exact(audit, AUDIT_FIELDS, "stored Spec Gate repair audit");
    if (!(activity instanceof FlowActivity) || !(descriptor instanceof FlowArtifactDescriptor)
      || !(baseSpecDescriptor instanceof FlowArtifactDescriptor)
      || !(repairRecord instanceof PlanGateRepairRecord)) throw new TypeError("Gate repair query requires captured typed metadata and its plan record");
    const result = activity.result?.stepResult;
    if (!(result instanceof SpecGateRepairReviewRequiredResult || result instanceof SpecGateRepairReadyForGateResult)
      || activity.nodeId !== "spec-gate-repair" || activity.transition.operation !== "confirm_attempt") {
      throw new TypeError("Only a completed Spec Gate repair owns an applied audit");
    }
    const receipt = DraftStepSettlementReceipt.assertStored(activity.result.draftSettlementReceipt, {
      binding: { runId: state.runId, specId: state.specId, stepId: activity.nodeId,
        attempt: { id: activity.attemptId, sequence: activity.sequence } }, result });
    const lifecycle = DraftStepExecutionLifecycle.fromJSON(receipt.executionLifecycle?.toJSON?.() ?? receipt.executionLifecycle);
    if (lifecycle.phase !== "terminal" || !(lifecycle.binding instanceof DraftWorkerExecutionBinding)
      || receipt.settlementKind !== "target-connection") throw new TypeError("Gate repair audit requires its terminal worker lifecycle");
    const expectedPath = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.audit", { attemptId: activity.attemptId }).relativePath;
    if (descriptor.logicalKey !== "spec.gate.repair.audit" || descriptor.relativePath !== expectedPath
      || descriptor.slot.publicationStep !== activity.nodeId || descriptor.activityId !== activity.id) throw new TypeError("Gate repair audit has a different catalog owner or path");
    this.operationAudit = new StoredSpecGateRepairOperationAudit(Object.fromEntries(OPERATION_FIELDS.map((field) => [field, audit[field]])));
    if (this.operationAudit.acceptedGroups.length === 0) throw new TypeError("Gate repair audit has no adopted edit");
    // The worker input revision identifies its complete execution input.
    // baseRevision independently identifies the original Spec's raw bytes.
    // Capture supplies this immutable descriptor from the selected Version.
    if (baseSpecDescriptor.logicalKey !== "spec.snapshot"
      || baseSpecDescriptor.cardinality.toString() !== "collection"
      || !FLOW_ARTIFACT_CONTRACTS.require("spec.snapshot").matchesCanonicalPath(baseSpecDescriptor.relativePath)
      || baseSpecDescriptor.hash !== this.operationAudit.baseRevision.slice("sha256:".length)) {
      throw new TypeError("Gate repair audit does not match its captured base Spec snapshot");
    }
    this.baseSpecDescriptor = baseSpecDescriptor;
    this.targetAttempt = new GateAttemptIdentity(audit.targetAttempt);
    same(this.targetAttempt.toJSON(), audit.targetAttempt, "Gate repair target Attempt");
    if (!this.targetAttempt.matches(new GateAttemptIdentity({ id: activity.attemptId, sequence: activity.sequence }))) throw new TypeError("Gate repair audit has a different target Attempt");
    this.sourceEvidence = GateEvidenceIdentity.fromJSON(audit.sourceEvidenceIdentity);
    repairRecord.assertFlow(state);
    if (repairRecord.phase !== "spec" || repairRecord.targetStepId !== activity.nodeId
      || repairRecord.idempotencyKey !== audit.repairId || repairRecord.fingerprint !== audit.repairRecordFingerprint
      || !repairRecord.evidenceIdentity.matches(this.sourceEvidence)) throw new TypeError("Gate repair audit has a different source plan or evidence");
    this.sourceFindingIdentities = identities(audit.sourceFindingIdentities, "Gate repair source findings");
    this.observationIdentities = identities(audit.observationIdentities, "Gate repair observation identities");
    const sourceKeys = new Set(this.sourceFindingIdentities.map((identity) => identity.toString()));
    if (this.observationIdentities.some((identity) => !sourceKeys.has(identity.toString()))
      || this.operationAudit.acceptedGroups.some((group) => group.identities.some((identity) => !sourceKeys.has(identity.toString())))) throw new TypeError("Gate repair group or observation has an unrelated source finding");
    if (!Array.isArray(audit.observationResults) || audit.observationResults.length !== repairRecord.observationRequests.length
      || this.observationIdentities.length !== repairRecord.observations.length) throw new TypeError("Gate repair audit does not retain each requested observation");
    const reported = new Set();
    const acceptedGroups = this.operationAudit.acceptedGroups.map((group) => group.toJSON());
    for (const value of audit.observationResults) {
      exact(value, ["fingerprint", "strategy", "summary", "priorRepairInsufficiency", "groupIndices"], "stored Gate repair observation result");
      const observation = new SpecGateRepairObservationResult(value);
      same(observation.toJSON(), value, "Gate repair observation result");
      const fingerprint = observation.fingerprint.toString();
      const request = repairRecord.observationRequests.find((candidate) => candidate.fingerprint.toString() === fingerprint);
      const index = repairRecord.observationFingerprints.indexOf(fingerprint);
      if (!request || index < 0 || reported.has(fingerprint)) throw new TypeError("Gate repair audit has a missing or repeated observation request");
      reported.add(fingerprint);
      same(specGateRepairObservationResult({ request, identity: this.observationIdentities[index].toJSON(), acceptedGroups }), value,
        "Gate repair saved operation strategy");
    }
    this.reviewFacts = new QuerySpecGateRepairReviewFacts(audit.reviewFacts, this.operationAudit);
    same(this.reviewFacts.sourceReviewIdentity?.toJSON() ?? null, audit.sourceReviewIdentity, "Gate repair source Review identity");
    if (this.reviewFacts.sourceReviewIdentity !== null && this.reviewFacts.sourceReviewIdentity.specId !== state.specId
      || this.reviewFacts.requiresReview !== (result instanceof SpecGateRepairReviewRequiredResult)) throw new TypeError("Gate repair Review facts disagree with the saved completion Result");
    this.acceptedOperations = Object.freeze(this.operationAudit.acceptedGroups.flatMap((group, position) =>
      group.operations.map((operation, index) => new QuerySpecGateRepairOperation(group, operation, index, position))));
    this.discardedGroups = Object.freeze(this.operationAudit.discardedGroups.map((group, index) => new QuerySpecGateRepairDiscardedGroup(group, index)));
    this.entries = Object.freeze([...this.acceptedOperations, ...this.discardedGroups]);
    Object.freeze(this);
  }
}
