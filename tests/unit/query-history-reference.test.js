import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord, FLOW_ARTIFACT_CONTRACTS } from "../../src/lib/flow-artifact-contract.js";
import { FlowArtifactCatalog, FlowArtifactDescriptor } from "../../src/lib/flow-version.js";
import { FlowActivity, ActivityTransition, NodeResult, ArtifactReference } from "../../src/flow/lib/current-flow-state.js";
import { ReferenceResolver } from "../../src/flow/query-values.js";
import { NonGateTargetBinding, NonGateCatalogPublication } from "../../src/flow/lib/non-gate-transition.js";
import { AcceptanceReviewResultEvidence } from "../../src/flow/steps/acceptance/acceptance-review-values.js";
import { AcceptanceReviewRepairRequiredResult } from "../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceipt, DraftStepSettlementPublication, settleAcceptanceStepResult } from "../../src/flow/definition.js";

const NOW = "2026-01-01T00:00:00.000Z";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function record(attempt, { nodeId = "acceptance-review", round = attempt } = {}) {
  return new FlowArtifactAttemptRecord({ attempt, payload: {
    nodeId, outcome: "completed", result: { verdict: "repair_required" },
    artifact: { logicalKey: "acceptance.review", payload: { verdict: "repair_required", round } },
  } });
}
function descriptor(history) {
  const bytes = history.toBytes();
  return new FlowArtifactDescriptor({
    ...FLOW_ARTIFACT_CONTRACTS.resolve("acceptance.review").publication({
      mediaType: "application/json", updater: "acceptance-review", activityId: "publication-2",
    }), hash: hash(bytes), size: bytes.length,
  });
}
function activity(sequence, reference, { nodeId = "acceptance-review", stepResult = null, receipt = null } = {}) {
  return new FlowActivity({ id: `publication-${sequence}`, nodeId, nodeKey: nodeId,
    attemptId: `attempt-${sequence}`, sequence, confirmationOrder: sequence, type: "result_confirmed",
    transition: new ActivityTransition({ operation: "confirm_attempt", nodeId, task: null, attempt: null,
      status: "done", policy: null, outbox: null, approval: null, nonblocking: null }),
    result: new NodeResult({ outcome: "passed", summary: "Published exact review history", confirmedAt: NOW,
      artifactRefs: [reference], ...(stepResult === null ? {} : { stepResult, draftSettlementReceipt: receipt }) }),
    timing: { startedAt: NOW, finishedAt: NOW, durationMs: 0 },
    failure: null, provider: null, model: null, effort: null, usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null, note: null, reviewPublication: null });
}

function acceptanceActivity(reference, current, publicationFields = {}) {
  const binding = { runId: "run-history-query", specId: "history-query", stepId: "acceptance-review",
    attempt: { id: "attempt-1", sequence: 1 } };
  const publication = new NonGateCatalogPublication({ ...binding, attemptId: binding.attempt.id, sequence: 1,
    producerActivityId: "publication-1", artifactId: current.relativePath, fingerprint: reference.id, ...publicationFields });
  const evidence = new AcceptanceReviewResultEvidence({ identity: new NonGateTargetBinding(binding), publication,
    fingerprint: "a".repeat(64), requirementIds: ["R1"], reviewDigest: publication.fingerprint, reviewAttempt: 1,
    verdict: "repair_required", findingIds: ["requirement:R1"], decisionAttemptSequence: 0, decisionStatus: "pending" });
  const stepResult = new AcceptanceReviewRepairRequiredResult({ evidence });
  const receipt = new DraftStepSettlementReceipt({ binding, result: stepResult,
    settlement: settleAcceptanceStepResult("acceptance-review", stepResult),
    publication: new DraftStepSettlementPublication({ publication: publication.toJSON() }) });
  return activity(1, reference, { stepResult, receipt: receipt.toJSON() });
}
function fixture({ first = record(1), second = record(2), capturedBytes = null } = {}) {
  const original = new FlowArtifactAttemptHistory([first]);
  const history = original.append(second);
  const current = descriptor(history);
  const oldReference = new ArtifactReference({ kind: "acceptance-review", id: hash(original.toBytes()) });
  const currentReference = new ArtifactReference({ kind: "acceptance-review", id: current.hash });
  const bytes = new Map([[current.relativePath, capturedBytes ?? history.toBytes()]]);
  return { original, history, current, oldReference, currentReference, bytes,
    resolver: new ReferenceResolver(new FlowArtifactCatalog({ artifacts: [current] }), {
      readArtifact: (entry) => bytes.get(entry.relativePath),
    }) };
}

test("exact history prefix serialization retains original publication bytes without changing the current history", () => {
  const first = new FlowArtifactAttemptHistory([record(2)]);
  const later = first.append(record(5));
  const before = later.toBytes();
  assert.deepEqual(later.prefixThrough(2).toBytes(), first.toBytes());
  assert.deepEqual(later.toBytes(), before);
  assert.deepEqual(later.prefixThrough(5).toBytes(), before);
  assert.throws(() => later.prefixThrough(3));
  assert.deepEqual(later.attempts.map((entry) => entry.attempt.value), [2, 5]);
});

test("an old Result hash resolves to its authenticated retained publication after a later successful Attempt", () => {
  const { resolver, oldReference, currentReference, current } = fixture();
  const first = activity(1, oldReference);
  const second = activity(2, currentReference);
  resolver.validateCanonicalActivityResults([first, second]);
  assert.equal(resolver.resolveResultReference(oldReference, "Historical Result", { activity: first }), current);
  assert.equal(resolver.resolveResultReference(oldReference, "Admitted historical Result"), current);
  assert.equal(resolver.resolveResultReference(currentReference, "Current Result"), current);
  assert.deepEqual(resolver.activityRelations([first, second]).activityIdsFor(current), [first.id, second.id]);
});

test("admitting one historical Result does not authorize the same hash for a different owning Activity", () => {
  const { resolver, oldReference, current } = fixture();
  resolver.validateCanonicalActivityResults([activity(1, oldReference)]);
  assert.throws(() => resolver.validateCanonicalActivityResults([activity(2, oldReference)]), {
    code: "CANONICAL_RECORD_INCONSISTENT",
  });
  assert.equal(resolver.resolveResultReference(oldReference, "Previously admitted history"), current);
});

test("historical Result proof uses the actual persisted typed Acceptance publication identity", async (t) => {
  const valid = fixture();
  const owner = acceptanceActivity(valid.oldReference, valid.current);
  valid.resolver.validateCanonicalActivityResults([owner]);
  assert.equal(valid.resolver.resolveResultReference(valid.oldReference, "Published history", { activity: owner }), valid.current);
  for (const [name, publicationFields] of [
    ["different published path", { artifactId: "steps/foreign-review/result.json" }],
    ["different publication hash", { fingerprint: "f".repeat(64) }],
    ["different original producer", { producerActivityId: "publication-foreign" }],
  ]) await t.test(name, () => {
    const value = fixture();
    const mismatched = acceptanceActivity(value.oldReference, value.current, publicationFields);
    assert.throws(() => value.resolver.validateCanonicalActivityResults([mismatched]), { code: "CANONICAL_RECORD_INCONSISTENT" });
  });
});

test("historical Result proof refuses missing, foreign or mismatched exact publication authority", async (t) => {
  const cases = [
    ["missing exact ordinal", () => {
      const value = fixture({ first: record(2), second: record(3) });
      return { ...value, owner: activity(1, value.oldReference) };
    }],
    ["different Activity Attempt sequence", () => {
      const value = fixture();
      return { ...value, owner: activity(2, value.oldReference) };
    }],
    ["different saved producer node", () => {
      const value = fixture({ first: record(1, { nodeId: "impl-review" }) });
      return { ...value, owner: activity(1, value.oldReference) };
    }],
    ["different Activity node", () => {
      const value = fixture();
      return { ...value, owner: activity(1, value.oldReference, { nodeId: "impl-review" }) };
    }],
    ["foreign prefix hash", () => {
      const value = fixture();
      const foreign = new FlowArtifactAttemptHistory([record(1, { round: 99 })]);
      return { ...value, owner: activity(1, new ArtifactReference({ kind: "acceptance-review", id: hash(foreign.toBytes()) })) };
    }],
    ["missing captured history", () => {
      const value = fixture();
      value.bytes.clear();
      return { ...value, owner: activity(1, value.oldReference) };
    }],
    ["captured bytes differ from descriptor", () => {
      const value = fixture();
      value.bytes.set(value.current.relativePath,
        new FlowArtifactAttemptHistory([record(1), record(2, { round: 99 })]).toBytes());
      return { ...value, owner: activity(1, value.oldReference) };
    }],
  ];
  for (const [name, build] of cases) await t.test(name, () => {
    const { resolver, owner } = build();
    assert.throws(() => resolver.validateCanonicalActivityResults([owner]), { code: "CANONICAL_RECORD_INCONSISTENT" });
  });
});
