import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { validateSchema } from "../../../src/lib/schema-validate.js";
import crypto from "node:crypto";
import { CanonicalFlowFixture, makeFlowManager, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { QueryDetailIndex, QueryDetailArtifactRequired } from "../../../src/flow/query-details.js";
import { FlowActivity, ActivityTransition, NodeResult } from "../../../src/flow/lib/current-flow-state.js";
import { FlowArtifactCatalog, FlowArtifactDescriptor } from "../../../src/lib/flow-version.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { attachCanonicalCommandResultArtifact, attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { DraftReviewArtifactDocument } from "../../../src/flow/lib/draft-review-artifacts.js";
import { SpecRepairTarget, SpecRepairFieldReplace, SpecRepairArrayReplace } from "../../../src/flow/lib/spec-repair-operations.js";
import { reasonsFromEvaluations } from "../../../src/flow/lib/run-gate.js";
import { NextAction, Diagnosis } from "../../../src/flow/lib/observation.js";
import { DraftArtifactRevision } from "../../../src/flow/lib/draft-artifact-promotion.js";
import { canonicalSourceFindingObservations, findSourceFinding } from "../../../src/flow/lib/flow-finding-source.js";
import { canonicalGateRevision } from "../../../src/flow/lib/canonical-gate-artifacts.js";

const RESPONSE_SCHEMA = JSON.parse(fs.readFileSync(new URL("../../../docs/design/flow-query-revision-2/response.schema.json", import.meta.url)));
const ENTITY_SCHEMA = RESPONSE_SCHEMA.oneOf.find((variant) => variant.properties.resource?.enum[0] === "activities" && variant.properties.ok.enum[0]).properties.entities;
const NOW = "2026-01-01T00:00:00.000Z";
const IDENTITY = { specId: "query-details", revision: 1, digest: "a".repeat(64), byteLength: 32 };
function activity(id, nodeId, { sequence = 1, references = {}, publication = null, operation = "confirm_attempt", nonblocking = null } = {}) {
  return new FlowActivity({ id, nodeId, nodeKey: nodeId, attemptId: `attempt-${id}`, sequence, confirmationOrder: sequence,
    type: operation === "continue_nonblocking" ? "nonblocking_recorded" : "result_confirmed",
    transition: new ActivityTransition({ operation, nodeId, task: null, attempt: null, status: operation === "confirm_attempt" ? "done" : null, policy: null, outbox: null, approval: null, nonblocking }),
    result: new NodeResult({ outcome: "passed", summary: "Recorded producer result", confirmedAt: NOW, artifactRefs: [] }),
    timing: { startedAt: NOW, finishedAt: NOW, durationMs: 0 }, failure: null, provider: null, model: null, effort: null, usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [], ...references }, metric: null, note: null, reviewPublication: publication });
}
function publication(review, stage = "spec-review") {
  return { generation: review.generation, identity: review.identity.toJSON(), reviewDigest: review.digest,
    relation: "revision-scoped-canonical-review", stage, outcome: review.audit.at(-1).outcome };
}
function reviewWith(findings, { previous = null, id = "review-1", stage = "spec-review", acceptedOperations = [], discardedOperations = [] } = {}) {
  const review = previous ?? new CanonicalSpecReview({ version: 2, identity: IDENTITY, generation: 0, findings: [], audit: [] });
  return mergeSpecReviewDelta({ review, activityId: id, acceptedOperations, discardedOperations,
    delta: new SpecReviewDelta({ version: 2, stage, identity: IDENTITY, baseReviewDigest: review.digest, findings, operations: [] }) });
}
function finding(id, improvement = false) {
  return improvement ? { kind: "improvement", findingId: id, title: id, target: "R-1", body: "Advisory body", improvement: "Improve clarity", whyNonBlocking: "Behavior is already specified" }
    : { kind: "blocking", findingId: id, title: id, target: "R-1", body: "Original body", issue: "Missing behavior", requiredChange: "Specify behavior", whyBlocking: "Behavior undefined" };
}
class CapturedFixture {
  constructor(activities) { this.activities = activities; this.descriptors = []; this.bytes = new Map(); }
  add(logicalKey, value, owner, parameters = {}) {
    const resolved = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const descriptor = new FlowArtifactDescriptor({ ...resolved.publication({ mediaType: logicalKey === "flow.activities" ? "application/x-ndjson" : "application/json", updater: owner?.nodeId ?? "system", activityId: owner?.id ?? null }),
      hash: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    this.descriptors.push(descriptor); this.bytes.set(descriptor.relativePath, bytes); return descriptor;
  }
  index(state = {}) { return new QueryDetailIndex({ state: { specId: IDENTITY.specId, flowVersionId: "version-details", ...state }, activities: this.activities,
    catalog: new FlowArtifactCatalog({ artifacts: this.descriptors }), artifactBytes: this.bytes, snapshotId: `sha256:${"b".repeat(64)}` }); }
}
function draftDocument({ blocking = [], advisory = [], repairs = [] } = {}) {
  return new DraftReviewArtifactDocument({ phase: "draft-questions", sourceDraft: "draft.json", generatedAt: NOW,
    sourceDraftRevision: new DraftArtifactRevision({ version: 1, runId: "run-details", specId: IDENTITY.specId,
      sourceStepId: "draft", digest: "d".repeat(64), byteLength: 100, finalizedAt: NOW }),
    blockingFindings: blocking, advisoryFindings: advisory, repairTargets: repairs }).toJSON();
}
function history(logicalKey, documents) { return { attempts: documents.map((payload, i) => ({ attempt: i + 1, artifact: { logicalKey, payload } })) }; }

test("Spec Review exposes both kinds, exact identities and original long body without raw audit", () => {
  const blocking = { ...finding("F-1"), body: "x".repeat(70000) };
  const review = reviewWith([blocking, finding("F-2", true)]);
  const owner = activity("review-1", "spec-review", { publication: publication(review), references: { findings: [{ id: "F-1", label: null }] } });
  const fixture = new CapturedFixture([owner]);
  const descriptor = fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  const index = fixture.index();
  const details = index.forActivity(owner);
  const entities = index.closureFor(details);
  assert.deepEqual(validateSchema(entities, ENTITY_SCHEMA), []);
  assert.equal(entities.findings.length, 2);
  assert.equal(entities.findings[0].description, blocking.body);
  assert.equal(entities.findings[1].specific.kind, "improvement");
  assert.equal(entities.findings[0].identity.sourceArtifact, descriptor.relativePath);
  assert.equal(entities.findings[0].currentState, null);
  assert.deepEqual(details.toJSON().referenceBindings.findings[0].detailIds, [entities.findings[0].id]);
  assert.equal(JSON.stringify(entities).includes("operationDigest"), false);
});

test("overwritten Spec Review generation fails rather than borrowing the current body", () => {
  const first = reviewWith([finding("F-1")]);
  const latest = reviewWith([{ ...finding("F-1"), body: "Changed body" }], { previous: first, id: "review-2" });
  const old = activity("review-1", "spec-review", { publication: publication(first) });
  const owner = activity("review-2", "spec-review", { sequence: 2, publication: publication(latest) });
  const fixture = new CapturedFixture([old, owner]);
  fixture.add("spec.review", Buffer.from(`${JSON.stringify(latest.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  assert.throws(() => fixture.index().forActivity(old), { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" });
});

test("Draft immutable Attempt histories expose every facet and closure outside the selected Activity", () => {
  const document = draftDocument({ blocking: [{ title: "B", target: "R-1", rationale: "missing", evidence: "source" }],
    advisory: [{ title: "A", target: "R-2", rationale: "clearer", evidence: "source" }],
    repairs: [{ title: "P", target: "R-3", rationale: "repair", evidence: "source" }] });
  const review = activity("draft-review-1", "draft-questions-review");
  const later = activity("draft-review-2", "draft-questions-review", { sequence: 2 });
  const fixture = new CapturedFixture([review, later]);
  const descriptor = fixture.add("draft.questions.review", history("draft.questions.review", [document, draftDocument()]), later);
  const index = fixture.index();
  const first = index.forActivity(review);
  const entities = index.closureFor(first);
  assert.equal(entities.evaluations.length, 1);
  assert.equal(entities.findings.length, 3);
  assert.deepEqual(entities.findings.map((entry) => entry.specific.classification), ["blocking", "advisory", "repair_target"]);
  assert.equal(entities.evaluations[0].result.nativeCode, "REJECTED");
  assert.equal(entities.findings[0].source.jsonPointer, "/attempts/0/artifact/payload/blockingFindings/0");
  assert.deepEqual(index.closureFor(index.forActivity(review)), entities);
  assert.equal(index.closureFor(index.forActivity(later)).findings.length, 0);
  for (const observed of canonicalSourceFindingObservations({ artifact: document, sourceStep: review.nodeKey, sourceArtifact: descriptor.relativePath })) {
    assert.deepEqual(findSourceFinding(document, observed.identity), observed.finding);
  }
});

test("unknown producer semantics and stored Draft truncation refuse a complete response", () => {
  for (const mutate of [(doc) => { doc.futureMeaning = "unknown"; }, (doc) => { doc.blockingFindings[0].rationale = "cut [truncated]"; }]) {
    const document = draftDocument({ blocking: [{ title: "B", target: "R", rationale: "reason", evidence: "evidence" }] });
    mutate(document);
    const owner = activity("draft-review-1", "draft-questions-review");
    const fixture = new CapturedFixture([owner]);
    fixture.add("draft.questions.review", history("draft.questions.review", [document]), owner);
    assert.throws(() => fixture.index().forActivity(owner), { code: "DETAIL_UNAVAILABLE" });
  }
  const owner = activity("future-1", "future-review");
  assert.throws(() => new CapturedFixture([owner]).index().forActivity(owner), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
});

test("missing old reference is an error and never replaced by an empty available binding", () => {
  const owner = activity("draft-review-1", "draft-questions-review", { references: { findings: [{ id: "lost", label: null }] } });
  const fixture = new CapturedFixture([owner]);
  fixture.add("draft.questions.review", history("draft.questions.review", [draftDocument()]), owner);
  assert.throws(() => fixture.index().forActivity(owner), { code: "DETAIL_UNAVAILABLE", reason: "REFERENCE_NOT_RESOLVED", referenceId: "lost" });
});

test("Gate projection retains recorded evaluation outcomes without deriving a new verdict", () => {
  const owner = activity("gate-1", "spec-gate");
  const fixture = new CapturedFixture([owner]);
  fixture.add("spec.gate", history("spec.gate", [{ result: "pass", changed: [], artifacts: { phase: "spec", evaluations: [{ guardrail_id: "G-1", result: "skip", reason: "Not required" }] } }]), owner);
  const index = fixture.index();
  const entities = index.closureFor(index.forActivity(owner));
  assert.deepEqual(entities.evaluations[0].result, { outcome: "passed", nativeCode: "pass" });
  assert.deepEqual(entities.evaluations[0].criteria[0], { id: "G-1", title: null, category: null, authority: null, expected: null, observed: null, evidence: "Not required", result: "skipped" });
});

test("Gate history retains producer categories, reason rows, scope and prescription independently", () => {
  const owner = activity("gate-detail-1", "spec-gate");
  const evaluations = [{ guardrail_id: "G-1", category: "quality", result: "pass", reason: "Recorded evidence" }];
  const reasons = reasonsFromEvaluations(evaluations);
  const nextAction = new NextAction({ diagnosis: new Diagnosis({ summary: "Recorded diagnosis", observations: [] }), prescription: "Keep the recorded decision" }).toJSON();
  const payload = { result: "pass", changed: [], reason: "Independent result reason", artifacts: {
    target: "spec/spec.json", level: "semantic", phase: "spec", evaluations, reasons, issues: [],
    failureKind: null, failureCode: null, nextAction,
  } };
  const fixture = new CapturedFixture([owner]);
  const descriptor = fixture.add("spec.gate", history("spec.gate", [payload]), owner);
  const stored = JSON.parse(fixture.bytes.get(descriptor.relativePath)).attempts[0].artifact.payload;
  const index = fixture.index();
  const closure = index.closureFor(index.forActivity(owner));
  assert.deepEqual(validateSchema(closure, ENTITY_SCHEMA), []);
  const evaluation = closure.evaluations[0];
  assert.equal(evaluation.criteria[0].category, stored.artifacts.evaluations[0].category);
  assert.equal(evaluation.criteria[0].title, stored.artifacts.evaluations[0].title ?? null);
  assert.equal(evaluation.explanation, stored.reason);
  assert.deepEqual(evaluation.specific, { schemaId: "gate-evaluation@1", target: stored.artifacts.target,
    level: stored.artifacts.level, phase: stored.artifacts.phase, failureKind: null, failureCode: null,
    taskId: stored.artifacts.taskId ?? null, sourceFingerprint: stored.artifacts.sourceFingerprint ?? null,
    failureCategory: stored.artifacts.gateTransitionFailureCategory ?? null,
    evaluationScope: stored.artifacts.evaluationScope ?? null, warnings: stored.artifacts.warnings ?? null,
    reasons: [{ verdict: reasons[0].verdict, detail: reasons[0].detail, guardrailId: "G-1", category: "quality", where: null }],
    issues: [], prescription: nextAction.prescription, diagnosisSummary: nextAction.diagnosis.summary });
  assert.equal(evaluation.source.jsonPointer, "/attempts/0/artifact/payload");
});

test("Gate unknown structured reasons and finding observations cannot disappear into an empty projection", () => {
  for (const extra of [{ reasons: [{ verdict: "FAIL", detail: "Recorded", futureMeaning: "preserve" }] }, { issues: [{ raw: "unknown issue type" }] }]) {
    const owner = activity("gate-unsupported", "spec-gate");
    const fixture = new CapturedFixture([owner]);
    fixture.add("spec.gate", history("spec.gate", [{ result: "fail", changed: [], artifacts: { evaluations: [], ...extra } }]), owner);
    assert.throws(() => fixture.index().forActivity(owner), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  }
});

test("Gate known fields require their exact saved Attempt and refuse unknown native semantics", () => {
  const owner = activity("gate-binding", "spec-gate");
  const state = { runId: "run-details", specId: IDENTITY.specId,
    attempt: { id: owner.attemptId, sequence: owner.sequence, nodeId: owner.nodeId } };
  const baseline = { result: "pass", artifacts: { phase: "spec", evaluations: [],
    gateTransitionAttemptId: owner.attemptId, gateTransitionAttemptSequence: owner.sequence,
    gateTransitionLineage: canonicalGateRevision(state, owner.nodeId) } };
  for (const { mutate, reason } of [
    { mutate: (payload) => { payload.gateTransitionAttemptId = "different-attempt"; }, reason: "SOURCE_GENERATION_NOT_RETAINED" },
    { mutate: (payload) => { payload.gateTransitionAttemptSequence += 1; }, reason: "SOURCE_GENERATION_NOT_RETAINED" },
    { mutate: (payload) => { payload.gateTransitionLineage = "0".repeat(64); }, reason: "SOURCE_GENERATION_NOT_RETAINED" },
    { mutate: (payload) => { payload.taskId = "different-task"; }, reason: "SOURCE_GENERATION_NOT_RETAINED" },
    { mutate: (payload) => { payload.futureMeaning = "unknown"; }, reason: "PRODUCER_NOT_SUPPORTED" },
    { mutate: (payload) => { payload.evaluationScope = { phase: "spec", taskId: null, sourceFingerprint: null,
      contentFingerprint: "a".repeat(64), futureMeaning: "unknown" }; }, reason: "PRODUCER_NOT_SUPPORTED" },
    { mutate: (payload) => { payload.evaluations = [{ guardrail_id: "G-1", result: "pass", reason: "Recorded", authority: "agent" }]; }, reason: "PRODUCER_NOT_SUPPORTED" },
    { mutate: (payload) => { payload.gateTransitionFailureCategory = { category: "semantic", code: "GATE_REJECTED" }; }, reason: "PRODUCER_NOT_SUPPORTED" },
  ]) {
    const value = structuredClone(baseline);
    mutate(value.artifacts);
    const fixture = new CapturedFixture([owner]);
    fixture.add("spec.gate", history("spec.gate", [value]), owner);
    assert.throws(() => fixture.index({ runId: state.runId }).forActivity(owner), { code: "DETAIL_UNAVAILABLE", reason });
  }
});

test("an Activity reference includes the producer's full transitive closure without adding Activity items", () => {
  const owner = activity("draft-review-1", "draft-questions-review");
  const fixture = new CapturedFixture([owner]);
  const descriptor = fixture.add("draft.questions.review", history("draft.questions.review", [draftDocument({ advisory: [{ title: "A", target: "R", rationale: "clarify", evidence: "source" }] })]), owner);
  const consumer = activity("consumer-2", "approval", { sequence: 2, references: { evaluations: [{ id: descriptor.relativePath, label: "path" }] } });
  fixture.activities.push(consumer);
  const index = fixture.index();
  const detail = index.forActivity(consumer);
  const closure = index.closureFor(detail);
  assert.equal(detail.detailRefs.evaluations.length, 1);
  assert.equal(detail.detailRefs.findings.length, 0);
  assert.equal(closure.evaluations.length, 1);
  assert.equal(closure.findings.length, 1);
  assert.deepEqual(closure.findings[0].evaluationIds, [closure.evaluations[0].id]);
  assert.deepEqual(closure.evaluations[0].findingIds, [closure.findings[0].id]);
  assert.deepEqual(closure.findings[0].activityIds, [owner.id]);
});

test("Spec repair audit reports applied operations without exposing old/new or upgrading to verified", () => {
  const first = reviewWith([finding("F-1")]);
  const operation = new SpecRepairFieldReplace({ kind: "replace-field", target: { entity: "spec", field: "goal" }, findingIds: ["F-1"], expectedDigest: "a".repeat(64), replacement: "sensitive-replacement", reason: "Required by F-1" }, 0).toJSON();
  const repaired = reviewWith([], { previous: first, id: "repair-1", stage: "spec-repair", acceptedOperations: [operation] });
  const owner = activity("repair-1", "spec-repair", { publication: publication(repaired, "spec-repair") });
  const fixture = new CapturedFixture([owner]);
  fixture.add("spec.review", Buffer.from(`${JSON.stringify(repaired.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  const index = fixture.index();
  const closure = index.closureFor(index.forActivity(owner));
  assert.deepEqual(validateSchema(closure, ENTITY_SCHEMA), []);
  assert.equal(closure.repairs.length, 1);
  assert.equal(closure.repairs[0].status.value, "applied");
  assert.equal(closure.repairs[0].items[0].status.value, "applied");
  assert.equal(closure.repairs[0].currentState, null);
  assert.deepEqual(closure.repairs[0].findingIds, [closure.findings[0].id]);
  assert.equal(closure.findings[0].identity.sourceStep, "spec-review");
  assert.equal(JSON.stringify(closure).includes("sensitive-"), false);
});

test("Spec repair no-op audit has an available skipped status with its native outcome", () => {
  const review = reviewWith([], { stage: "spec-repair", id: "repair-no-op" });
  assert.equal(review.audit.at(-1).outcome, "no-op");
  const owner = activity("repair-no-op", "spec-repair", { publication: publication(review, "spec-repair") });
  const fixture = new CapturedFixture([owner]);
  const descriptor = fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  const rawAudit = JSON.parse(fixture.bytes.get(descriptor.relativePath)).audit.at(-1);
  const index = fixture.index();
  const closure = index.closureFor(index.forActivity(owner));
  assert.deepEqual(validateSchema(closure, ENTITY_SCHEMA), []);
  assert.deepEqual(closure.repairs[0].status, { value: "skipped", availability: "available", reason: null, nativeValue: rawAudit.outcome });
  assert.deepEqual(closure.repairs[0].items, []);
});

test("Spec Repair refuses a conflicting supplemental audit Activity binding", () => {
  const review = reviewWith([], { stage: "spec-repair", id: "different-repair" });
  const owner = activity("repair-binding", "spec-repair", { publication: publication(review, "spec-repair") });
  const fixture = new CapturedFixture([owner]);
  fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  assert.throws(() => fixture.index().forActivity(owner), { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" });
});

test("Spec Repair no-op with rejected proposals publishes discarded aggregate and item statuses", () => {
  const proposal = { findingIds: ["F-1"], kind: "replace-field", target: { entity: "spec", field: "goal" },
    operationDigest: "a".repeat(64), reason: "unauthorized operation", attempt: 1 };
  const review = reviewWith([], { previous: reviewWith([finding("F-1")]), stage: "spec-repair", id: "repair-discarded", discardedOperations: [proposal] });
  assert.equal(review.audit.at(-1).outcome, "no-op");
  const owner = activity("repair-discarded", "spec-repair", { publication: publication(review, "spec-repair"),
    references: { repairs: [{ id: proposal.operationDigest, label: null }] } });
  const fixture = new CapturedFixture([owner]);
  fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  const index = fixture.index();
  const closure = index.closureFor(index.forActivity(owner));
  const repair = closure.repairs[0];
  assert.deepEqual(repair.status, { value: "discarded", availability: "available", reason: null, nativeValue: "no-op" });
  assert.equal(repair.items[0].status.value, "discarded");
  assert.equal(repair.items[0].discardedReason, proposal.reason);
  assert.equal(repair.items[0].adoptedReason, null);
  assert.equal(Object.hasOwn(repair.items[0], "attempt"), false);
  assert.deepEqual(index.forActivity(owner).toJSON().referenceBindings.repairs[0].detailIds, [repair.id]);
  assert.notEqual(repair.items[0].id, proposal.operationDigest);
});

test("Spec Repair refuses invalid stored worker attempt provenance", () => {
  for (const attempt of [0, "1"]) {
    const review = reviewWith([], { previous: reviewWith([finding("F-1")]), stage: "spec-repair", id: "repair-invalid-attempt",
      discardedOperations: [{ findingIds: ["F-1"], kind: "replace-field", target: { entity: "spec", field: "goal" },
        operationDigest: "a".repeat(64), reason: "unauthorized operation", attempt }] });
    const owner = activity("repair-invalid-attempt", "spec-repair", { publication: publication(review, "spec-repair") });
    const fixture = new CapturedFixture([owner]);
    fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
    assert.throws(() => fixture.index().forActivity(owner), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  }
});

test("Spec repair array targets retain collection and explicit or digest-bound position", () => {
  for (const position of [undefined, 2]) {
    const target = { collection: "scope.in", ...(position === undefined ? {} : { position }) };
    const operation = new SpecRepairArrayReplace({ kind: "replace-array-element", target, findingIds: ["F-1"],
      expectedDigest: "a".repeat(64), replacement: "private-replacement", reason: "Apply recorded permission" }, 0).toJSON();
    const review = reviewWith([], { previous: reviewWith([finding("F-1")]), id: "repair-array", stage: "spec-repair", acceptedOperations: [operation] });
    const owner = activity("repair-array", "spec-repair", { publication: publication(review, "spec-repair") });
    const fixture = new CapturedFixture([owner]);
    const descriptor = fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
    const stored = JSON.parse(fixture.bytes.get(descriptor.relativePath)).audit.at(-1).acceptedOperations[0].target;
    const index = fixture.index();
    const closure = index.closureFor(index.forActivity(owner));
    assert.deepEqual(validateSchema(closure, ENTITY_SCHEMA), []);
    assert.equal(closure.repairs[0].items[0].target.collection, stored.collection);
    assert.equal(closure.repairs[0].items[0].target.position, stored.position ?? null);
    assert.equal(closure.repairs[0].items[0].target.id, SpecRepairTarget.fromJSON(stored, "saved target").conflictKey(operation.expectedDigest));
    assert.equal(JSON.stringify(closure).includes("private-replacement"), false);
  }
});

test("digest-bound array repair targets retain distinct canonical locator IDs", () => {
  const operations = ["a", "b"].map((digit, index) => new SpecRepairArrayReplace({ kind: "replace-array-element",
    target: { collection: "scope.in" }, findingIds: ["F-1"], expectedDigest: digit.repeat(64), replacement: `replacement-${index}`,
    reason: "Apply a digest-bound element correction" }, index).toJSON());
  const review = reviewWith([], { previous: reviewWith([finding("F-1")]), id: "repair-locators", stage: "spec-repair", acceptedOperations: operations });
  const owner = activity("repair-locators", "spec-repair", { publication: publication(review, "spec-repair") });
  const fixture = new CapturedFixture([owner]);
  const descriptor = fixture.add("spec.review", Buffer.from(`${JSON.stringify(review.toJSON(), null, 2)}\n`), owner, { revision: "001" });
  const saved = JSON.parse(fixture.bytes.get(descriptor.relativePath)).audit.at(-1).acceptedOperations;
  const index = fixture.index();
  const closure = index.closureFor(index.forActivity(owner));
  assert.deepEqual(validateSchema(closure, ENTITY_SCHEMA), []);
  const targets = closure.repairs[0].items.map((item) => item.target);
  assert.notEqual(targets[0].id, targets[1].id);
  for (const [i, target] of targets.entries()) {
    assert.equal(target.collection, "scope.in");
    assert.equal(target.position, null);
    assert.equal(target.id, SpecRepairTarget.fromJSON(saved[i].target, "saved target").conflictKey(saved[i].expectedDigest));
  }
});

test("continue_nonblocking maps saved skipped node references to ledger-backed lifecycle detail", () => {
  const owner = activity("skip-1", "impl-review", { operation: "continue_nonblocking", references: { repairs: [{ id: "impl-repair", label: null }] },
    nonblocking: { kind: "decision", sourceStep: "impl-review", sourceAttempt: 1, evidenceRef: "impl-review.json",
      evidenceDigest: "a".repeat(64), definitionDigest: "b".repeat(64), resultKind: "quality", action: "continue",
      rationale: "Accepted remaining work", remainingRisk: "Finding remains open" } });
  const fixture = new CapturedFixture([owner]);
  fixture.add("flow.activities", Buffer.from(`${JSON.stringify(owner.toJSON())}\n`), null);
  const index = fixture.index();
  const details = index.forActivity(owner);
  const entities = index.closureFor(details);
  assert.deepEqual(validateSchema(entities, ENTITY_SCHEMA), []);
  assert.equal(entities.repairs[0].kind, "lifecycle-skip");
  assert.equal(entities.repairs[0].status.value, "skipped");
  assert.equal(entities.repairs[0].source.format, "jsonl");
  assert.equal(entities.repairs[0].source.jsonPointer, null);
  assert.equal(entities.repairs[0].specific.rationale, "Accepted remaining work");
  assert.equal(entities.repairs[0].specific.remainingRisk, "Finding remains open");
  assert.deepEqual(details.toJSON().referenceBindings.repairs[0].detailIds, [entities.repairs[0].id]);
});

test("uncaptured detail input requests typed hydration and succeeds after the captured bytes are supplied", () => {
  const owner = activity("draft-review-1", "draft-questions-review");
  const fixture = new CapturedFixture([owner]);
  const descriptor = fixture.add("draft.questions.review", history("draft.questions.review", [draftDocument()]), owner);
  const bytes = fixture.bytes.get(descriptor.relativePath);
  fixture.bytes.delete(descriptor.relativePath);
  assert.throws(() => fixture.index().forActivity(owner), (error) => {
    assert.ok(error instanceof QueryDetailArtifactRequired);
    assert.equal(error.descriptor, descriptor);
    return true;
  });
  fixture.bytes.set(descriptor.relativePath, bytes);
  const index = fixture.index();
  const entities = index.closureFor(index.forActivity(owner));
  assert.equal(entities.evaluations.length, 1);
  assert.deepEqual(entities.evaluations[0].result, { outcome: "passed", nativeCode: "PASS" });
});

test("qualified node keys preserve canonical producer identity and retained historical Attempt resolution", () => {
  const first = new FlowActivity({ ...activity("draft-review-1", "draft-questions-review").toJSON(), nodeKey: "plan.draft-questions-review" });
  const second = new FlowActivity({ ...activity("draft-review-2", "draft-questions-review", { sequence: 2 }).toJSON(), nodeKey: "plan.draft-questions-review" });
  const fixture = new CapturedFixture([first, second]);
  fixture.add("draft.questions.review", history("draft.questions.review", [draftDocument({ blocking: [{ title: "Missing", target: "R", rationale: "Reason", evidence: "Source" }] }), draftDocument()]), second);
  const index = fixture.index();
  const entities = index.closureFor(index.forActivity(first));
  assert.equal(entities.evaluations.length, 1);
  assert.equal(entities.findings[0].identity.sourceStep, "draft-questions-review");
  assert.equal(entities.findings[0].source.producerActivityId, first.id);
  assert.equal(entities.findings[0].source.jsonPointer, "/attempts/0/artifact/payload/blockingFindings/0");
  const approval = new FlowActivity({ ...activity("approval-1", "approval").toJSON(), nodeKey: "plan.approval" });
  const details = new CapturedFixture([approval]).index().forActivity(approval).toJSON();
  assert.deepEqual(details.detailCoverage.evaluations, { availability: "not-applicable", reason: "NOT_APPLICABLE", count: 0 });
});

test("real Spec Review confirmation resolves its own canonical publication without inventing an evaluation", (t) => {
  const root = createTmpDir();
  t.after(() => removeTmpDir(root));
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId: "query-detail-publication" }).create().activate("spec-review");
  const input = manager.readCurrentSpecReviewInput({ specId: flow.specId, consumerNodeId: "spec-review" });
  const delta = new SpecReviewDelta({ version: 2, stage: "spec-review", identity: input.review.identity.toJSON(),
    baseReviewDigest: input.review.digest, findings: [finding("F-retained")], operations: [] });
  const review = mergeSpecReviewDelta({ review: input.review, delta });
  const commandResult = { result: "Recorded review" };
  attachCanonicalCommandResultArtifact(commandResult, { logicalKey: "spec.review", payload: delta.toJSON() });
  attachCanonicalCommandResultPublications(commandResult, [{ logicalKey: "spec.review",
    parameters: { revision: String(input.revision).padStart(3, "0") }, mediaType: "application/json", payload: review.toJSON() }]);
  manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "done" }, { specId: flow.specId, canonicalCommandResult: commandResult });
  const activities = manager.activityLedger(flow.specId);
  const publication = activities.find((entry) => entry.reviewPublication?.stage === "spec-review");
  const confirmation = activities.findLast((entry) => entry.nodeId === "spec-review" && entry.transition.operation === "confirm_attempt");
  assert.ok(publication);
  assert.ok(confirmation);
  assert.equal(publication.id, confirmation.id);
  assert.equal(Object.hasOwn(confirmation.result, "stepResult"), false);
  assert.equal(confirmation.attemptId, publication.attemptId);
  assert.equal(confirmation.confirmationOrder, publication.confirmationOrder);
  const catalog = manager.artifactCatalog(flow.specId);
  const location = manager.specLocation(flow.specId);
  const artifactBytes = new Map(catalog.artifacts.map((descriptor) => [descriptor.relativePath, fs.readFileSync(location.resolve(descriptor.relativePath))]));
  const index = new QueryDetailIndex({ state: manager.canonicalState(flow.specId), activities, catalog, artifactBytes,
    snapshotId: `sha256:${"c".repeat(64)}` });
  const details = index.forActivity(confirmation);
  const entities = index.closureFor(details);
  assert.equal(entities.findings.length, 1);
  assert.equal(entities.findings[0].title, "F-retained");
  assert.equal(entities.findings[0].source.producerActivityId, publication.id);
  assert.equal(details.detailCoverage.evaluations.availability, "not-recorded");
  assert.equal(details.detailCoverage.findings.availability, "available");
  assert.equal(entities.evaluations.length, 0);
});

test("canonical preparation confirmation is non-detail even with its qualified definition key", (t) => {
  const root = createTmpDir();
  t.after(() => removeTmpDir(root));
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId: "query-detail-preparation" }).create().activate("draft");
  const activities = manager.activityLedger(flow.specId);
  const preparation = activities.find((entry) => entry.nodeId === "prepare-spec" && entry.transition.operation === "confirm_attempt");
  assert.ok(preparation);
  assert.equal(preparation.nodeKey, "plan.prepare-spec");
  const index = new QueryDetailIndex({ state: manager.canonicalState(flow.specId), activities,
    catalog: manager.artifactCatalog(flow.specId), artifactBytes: new Map(), snapshotId: `sha256:${"d".repeat(64)}` });
  const details = index.forActivity(preparation).toJSON();
  for (const group of ["evaluations", "findings", "repairs"]) {
    assert.deepEqual(details.detailCoverage[group], { availability: "not-applicable", reason: "NOT_APPLICABLE", count: 0 });
  }
});

test("non-detail producer inventory uses current contract IDs and refuses unknown or semantic producers", () => {
  for (const nodeId of ["branch", "prepare-spec", "draft", "draft-refine", "spec", "approval", "report",
    "finalize-commit", "finalize-merge", "finalize-sync", "finalize-cleanup"]) {
    const owner = activity(`inventory-${nodeId}`, nodeId);
    const details = new CapturedFixture([owner]).index().forActivity(owner).toJSON();
    for (const group of ["evaluations", "findings", "repairs"]) assert.equal(details.detailCoverage[group].availability, "not-applicable", nodeId);
  }
  // Test generation has structural findings; execution has TestChain evidence;
  // source implementation can carry quality issues and task Gate repair reports.
  for (const nodeId of ["test-generate", "test-execute", "implement", "task-impl", "unknown-step", "plan.prepare-spec", "commit", "test-create"]) {
    const owner = activity(`inventory-${nodeId}`, nodeId);
    assert.throws(() => new CapturedFixture([owner]).index().forActivity(owner),
      (error) => error.code === "DETAIL_UNAVAILABLE" && error.reason === "PRODUCER_NOT_SUPPORTED", nodeId);
  }
});

test("terminal Task source no-change uses saved empty quality evidence and its accepted settlement", (t) => {
  const root = createTmpDir();
  t.after(() => removeTmpDir(root));
  setupFlowConfig(root, "en");
  const manager = makeFlowManager(root);
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId: "query-detail-source", specRecord: {
    goal: "Read recorded source completion", requirements: [{ id: "R-1", desc: "Exercise saved source facts", task_ids: ["T-1"] }],
  } }).create().addTask({ id: "T-1", title: "Recorded implementation", goal: "Exercise source completion", parent: null,
    origin: "plan", added_round: 0, status: "pending" });
  flow.settleBefore("T-1-impl").activateTask("T-1", { settlePredecessors: false }).settle("T-1-impl");
  const activities = manager.activityLedger(flow.specId);
  const owner = activities.findLast((entry) => entry.nodeId === "T-1-impl" && entry.type === "result_confirmed");
  assert.equal(owner.result.stepResult.kind, "task-impl-no-change");
  assert.equal(owner.result.stepResult.evidence.qualityIssueCount, 0);
  assert.equal(owner.result.stepResult.evidence.mutationCount, 0);
  const catalog = manager.artifactCatalog(flow.specId);
  const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === "source.handoff.settlement" && entry.activityId === owner.id);
  assert.ok(descriptor);
  assert.equal(catalog.artifacts.some((entry) => entry.logicalKey === "plan.gate.repair.outcome" && entry.activityId === owner.id), false);
  const bytes = fs.readFileSync(manager.specLocation(flow.specId).resolve(descriptor.relativePath));
  const artifactBytes = new Map([[descriptor.relativePath, bytes]]);
  const args = { state: manager.canonicalState(flow.specId), activities, catalog, artifactBytes, snapshotId: `sha256:${"e".repeat(64)}` };
  const index = new QueryDetailIndex(args);
  const details = index.forActivity(owner).toJSON();
  assert.deepEqual(details.detailCoverage.findings, { availability: "available", reason: null, count: 0 });
  assert.equal(details.detailCoverage.evaluations.availability, "not-applicable");
  assert.equal(details.detailCoverage.repairs.availability, "not-applicable");
  assert.deepEqual(index.closureFor(index.forActivity(owner)), { evaluations: [], findings: [], repairs: [] });
  assert.throws(() => new QueryDetailIndex({ ...args, artifactBytes: new Map() }).forActivity(owner), QueryDetailArtifactRequired);
  const missingCatalog = new FlowArtifactCatalog({ artifacts: catalog.artifacts.filter((entry) => entry !== descriptor) });
  assert.throws(() => new QueryDetailIndex({ ...args, catalog: missingCatalog }).forActivity(owner),
    { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" });
});
