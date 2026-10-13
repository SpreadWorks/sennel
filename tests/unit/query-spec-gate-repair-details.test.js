import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";
import { FlowArtifactDescriptor } from "../../src/lib/flow-version.js";
import { FlowActivity, ActivityTransition, NodeResult } from "../../src/flow/lib/current-flow-state.js";
import { PlanGateRepairRecord, PlanGateRepairObservation } from "../../src/flow/lib/plan-gate-repair.js";
import { GateEvidenceIdentity, specGateRepairObservationResult } from "../../src/flow/lib/gate-observation-convergence.js";
import { canonicalSourceFindings } from "../../src/flow/lib/flow-finding-source.js";
import { Observation } from "../../src/flow/lib/observation.js";
import { SpecGateRepairOperationGroup, SpecGateRepairOperationRejection, StoredSpecGateRepairOperationAudit,
  StoredSpecGateRepairAcceptedGroup, SpecRepairTarget } from "../../src/flow/lib/spec-repair-operations.js";
import { SpecGateRepairReviewFacts } from "../../src/flow/lib/spec-gate-repair-review.js";
import { SpecGateRepairReviewRequiredResult } from "../../src/flow/engine/step-result.js";
import { DraftWorkerExecutionBinding, DraftWorkerExecutionClaim, DraftStepExecutionLifecycle,
  DraftStepSettlementPublication, DraftStepSettlementReceipt, settleSpecStepResult } from "../../src/flow/definition.js";
import { QuerySpecGateRepairObservation } from "../../src/flow/query-spec-gate-repair-details.js";

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = "2026-10-13T02:00:00.000Z";
const state = { runId: "run-query-gate-repair", specId: "821-query-gate-repair", issue: null };
const baseRevision = `sha256:${"a".repeat(64)}`;

function fixture() {
  const observation = new Observation({ kind: "violation", failureMode: "guardrail-violation", requirementRef: "G-1",
    where: { file: "spec.json", locator: "goal" }, observed: "The goal lacks the required result.", severity: "blocking", refs: ["G-1"],
    specRevision: baseRevision, targets: [{ entity: "spec", field: "goal" }],
    allowedTargets: [{ target: { entity: "spec", field: "goal" }, operationKinds: ["replace-field"] }] }).toJSON();
  const [source] = canonicalSourceFindings({ artifact: { observations: [observation] }, sourceStep: "spec-gate",
    sourceArtifact: FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate").relativePath });
  const identity = source.identity.toJSON();
  const canonical = new PlanGateRepairObservation({ ...observation, phase: "spec", scope: "flow", taskId: null });
  const sourceAttempt = { id: "attempt-source-gate", sequence: 1 };
  const evidence = new GateEvidenceIdentity({ sourceAttempt, resultLogicalKey: "spec.gate", publicationActivityId: "activity-source-gate",
    catalogFingerprint: "b".repeat(64), transitionLineage: { sourceAttempt, canonicalAttempt: sourceAttempt,
      sourceFingerprint: "b".repeat(64), canonicalFingerprint: "b".repeat(64),
      sourceRevisionFingerprint: "c".repeat(64), canonicalRevisionFingerprint: "c".repeat(64) } });
  const repairRecord = new PlanGateRepairRecord({ version: 2, ...state, phase: "spec", evidenceIdentity: evidence,
    connector: { phase: "spec", sourceGateStepId: "spec-gate", sourceAttempt,
      resultLogicalKey: "spec.gate", resultArtifactId: "steps/spec-gate/result.json", catalogFingerprint: "b".repeat(64),
      targetStepId: "spec-gate-repair", resetStepIds: ["spec-gate-repair", "spec-gate"], taskLifecycle: null },
    sourceIssueLogId: "gate-source-issue", sourceEntryDigest: "d".repeat(64), observations: [observation],
    observationFingerprints: [canonical.fingerprint.toString()], observationRequests: [{ fingerprint: canonical.fingerprint.toString(), recurrenceCount: 0, priorStrategy: null }],
    requestedAt: now });
  const group = new SpecGateRepairOperationGroup({ findingIdentities: [identity], operations: [{ kind: "replace-field",
    target: { entity: "spec", field: "goal" }, expectedDigest: "e".repeat(64), replacement: "The corrected goal gives the exact result.",
    reason: "State the required result explicitly." }] }, 0);
  const accepted = [{ index: 0, findingIdentities: group.identities.map((value) => value.toJSON()),
    operations: group.operations.map((operation) => { const { findingIds, ...value } = operation.toJSON(); return value; }) }];
  const rejected = [new SpecGateRepairOperationRejection({ index: 1, groupDigest: "f".repeat(64), reason: "unauthorized operation" })];
  const resultSpec = { goal: "The corrected goal gives the exact result.", background: "The saved context." };
  const resultRevision = { digest: hash(resultSpec), byteLength: Buffer.byteLength(JSON.stringify(resultSpec)) };
  const operationAudit = { version: 1, phase: "spec-gate-repair", baseRevision, acceptedGroups: accepted,
    discardedGroups: rejected.map((group) => group.toJSON()), operationDigest: hash({ accepted, rejected }), resultRevision };
  const targetAttempt = { id: "attempt-spec-gate-repair", sequence: 2 };
  const reviewFacts = new SpecGateRepairReviewFacts({ sourceReview: null, baseRevision, resultSpec, resultRevision, acceptedGroups: accepted });
  const audit = { ...operationAudit, sourceReviewIdentity: null, sourceEvidenceIdentity: evidence.toJSON(),
    sourceFindingIdentities: [identity], observationIdentities: [identity], repairId: repairRecord.idempotencyKey,
    repairRecordFingerprint: repairRecord.fingerprint, targetAttempt,
    observationResults: [specGateRepairObservationResult({ request: repairRecord.observationRequests[0], identity, acceptedGroups: accepted })],
    reviewFacts: reviewFacts.toJSON() };
  const result = new SpecGateRepairReviewRequiredResult();
  const lifecycle = DraftStepExecutionLifecycle.checkpoint(new DraftWorkerExecutionBinding({ executionGeneration: 0,
    inputDigest: "b".repeat(64), inputRevision: "9".repeat(64) })).claimed(new DraftWorkerExecutionClaim({ dispatchInvocationId: "worker-invocation",
    generatedAt: now, actionDigest: "c".repeat(64), requestDigest: "d".repeat(64) })).terminal();
  const receipt = new DraftStepSettlementReceipt({ binding: { ...state, stepId: "spec-gate-repair", attempt: targetAttempt }, result,
    settlement: settleSpecStepResult("spec-gate-repair", result), publication: new DraftStepSettlementPublication({ saved: "audit" }), executionLifecycle: lifecycle });
  const activity = new FlowActivity({ id: "activity-spec-gate-repair", nodeId: "spec-gate-repair", nodeKey: "spec-gate-repair",
    attemptId: targetAttempt.id, sequence: targetAttempt.sequence, confirmationOrder: 4, type: "result_confirmed",
    transition: new ActivityTransition({ operation: "confirm_attempt", nodeId: "spec-gate-repair", task: null, attempt: null,
      status: "done", policy: null, outbox: null, approval: null, nonblocking: null }),
    result: new NodeResult({ outcome: "passed", summary: "The saved Gate repair completed.", confirmedAt: now,
      artifactRefs: [], stepResult: result, draftSettlementReceipt: receipt.toJSON() }),
    timing: null, failure: null, provider: null, model: null, effort: null, usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] }, metric: null, note: null, reviewPublication: null });
  const bytes = Buffer.from(JSON.stringify(audit));
  const resolved = FLOW_ARTIFACT_CONTRACTS.resolve("spec.gate.repair.audit", { attemptId: targetAttempt.id });
  const descriptor = new FlowArtifactDescriptor({ ...resolved.publication({ mediaType: "application/json", updater: activity.nodeId, activityId: activity.id }),
    hash: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  const snapshot = FLOW_ARTIFACT_CONTRACTS.resolve("spec.snapshot", { revision: "001" });
  const baseSpecDescriptor = new FlowArtifactDescriptor({ ...snapshot.publication({ mediaType: "application/json",
    updater: "spec", activityId: "activity-original-spec" }), hash: baseRevision.slice(7), size: 100 });
  return { audit: structuredClone(audit), operationAudit, activity, descriptor, repairRecord, state, baseSpecDescriptor };
}

test("stored Gate operation audit preserves typed adopted operations, rejected diagnostics and the writer digest", () => {
  const { operationAudit } = fixture();
  const stored = new StoredSpecGateRepairOperationAudit(operationAudit);
  assert.ok(stored.acceptedGroups[0] instanceof StoredSpecGateRepairAcceptedGroup);
  assert.ok(stored.acceptedGroups[0].operations[0].target instanceof SpecRepairTarget);
  assert.ok(stored.discardedGroups[0] instanceof SpecGateRepairOperationRejection);
  assert.deepEqual(stored.toJSON(), operationAudit);
  const changed = structuredClone(operationAudit);
  changed.acceptedGroups[0].operations[0].reason = "Different retained reason.";
  assert.throws(() => new StoredSpecGateRepairOperationAudit(changed), /operation digest/);
});

test("completed Gate repair projects exact source identities and typed edits without inventing rejected targets", () => {
  const input = fixture();
  const before = structuredClone(input.audit);
  const observation = new QuerySpecGateRepairObservation(input);
  assert.notEqual(input.activity.result.draftSettlementReceipt.executionLifecycle.binding.inputRevision,
    input.baseSpecDescriptor.hash, "semantic execution revision and raw Spec hash belong to different contracts");
  assert.equal(observation.baseSpecDescriptor, input.baseSpecDescriptor);
  assert.equal(observation.entries.length, 2);
  const [adopted, discarded] = observation.entries;
  assert.equal(adopted.status, "applied");
  assert.equal(adopted.operationKind, "replace-field");
  assert.ok(adopted.target instanceof SpecRepairTarget);
  assert.equal(adopted.reason, input.audit.acceptedGroups[0].operations[0].reason);
  assert.equal(adopted.jsonPointer, "/acceptedGroups/0/operations/0");
  assert.deepEqual(adopted.identities.map((identity) => identity.toJSON()), input.audit.sourceFindingIdentities);
  assert.equal(discarded.status, "discarded");
  assert.equal(discarded.target, null);
  assert.equal(discarded.operationKind, null);
  assert.deepEqual(discarded.identities, []);
  assert.equal(discarded.reason, "unauthorized operation");
  assert.equal(observation.sourceEvidence.publicationActivityId, "activity-source-gate");
  assert.deepEqual(input.audit, before);
});

test("stored terminal audit refuses unknown meaning, stale plan or Attempt, altered groups and inconsistent Review facts", () => {
  for (const mutate of [
    (input) => { input.audit.unknownMeaning = true; },
    (input) => { input.audit.acceptedGroups[0].operations[0].unexpectedAuthority = true; },
    (input) => { input.audit.discardedGroups[0].target = { entity: "spec", field: "goal" }; },
    (input) => { input.audit.repairRecordFingerprint = "c".repeat(64); },
    (input) => { input.audit.targetAttempt.sequence += 1; },
    (input) => { input.audit.baseRevision = `sha256:${"b".repeat(64)}`; },
    (input) => { input.audit.observationResults[0].summary = "A fabricated completion."; },
    (input) => { input.audit.reviewFacts.requiresReview = false; },
    (input) => { input.audit.reviewFacts.extraMeaning = true; },
    (input) => { input.audit.reviewFacts.reason = "exact-reviewed-input-preserved"; },
    (input) => { input.audit.sourceFindingIdentities[0].sourceArtifact = "steps/other-gate/result.json"; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => new QuerySpecGateRepairObservation(input));
  }
});

test("stored terminal audit requires the catalog owner and selected Flow identity", () => {
  const input = fixture();
  const differentOwner = new FlowArtifactDescriptor({ ...input.descriptor.toJSON(), activityId: "different-audit-owner" });
  assert.throws(() => new QuerySpecGateRepairObservation({ ...input, descriptor: differentOwner }), /catalog owner or path/);
  assert.throws(() => new QuerySpecGateRepairObservation({ ...input, state: { ...state, runId: "different-run" } }), /binding/);
  assert.throws(() => new QuerySpecGateRepairObservation({ ...input, state: { ...state, specId: "822-different-spec" } }), /binding/);
});

test("saved repair base revision refuses a different or missing immutable Spec snapshot", () => {
  const input = fixture();
  const wrongSnapshot = new FlowArtifactDescriptor({ ...input.baseSpecDescriptor.toJSON(), hash: "8".repeat(64) });
  assert.throws(() => new QuerySpecGateRepairObservation({ ...input, baseSpecDescriptor: wrongSnapshot }), /base Spec snapshot/);
  assert.throws(() => new QuerySpecGateRepairObservation({ ...input, baseSpecDescriptor: input.descriptor }), /base Spec snapshot/);
  assert.throws(() => new QuerySpecGateRepairObservation({ ...input, baseSpecDescriptor: null }), /captured typed metadata/);
});
