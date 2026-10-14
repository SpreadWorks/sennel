import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { QueryDraftReviewScenario } from "../../support/infrastructure/query-draft-review-scenario.js";
import { receiptBinding, changedResult, replaceStoredResult } from "../../support/infrastructure/query-captured-step-result.js";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactSpecReviewActivityEvidenceDocument } from "../../../src/lib/flow-artifact-contract.js";
import { FlowArtifactCatalog, FlowArtifactDescriptor } from "../../../src/lib/flow-version.js";
import { ActivityReviewPublication } from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalSpecReview } from "../../../src/flow/lib/spec-review-artifacts.js";
import { DraftStepSettlementReceipt, DraftStepExecutionLifecycle, settleSpecStepResult } from "../../../src/flow/definition.js";
import { SpecReviewPassedResult, SpecReviewAdvisoryResult } from "../../../src/flow/engine/step-result.js";
import { QueryDetailIndex } from "../../../src/flow/query-details.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("captured Spec Review archives bind the selected Flow and refuse unsupported, missing or ambiguous retained meaning", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "824-query-spec-history-binding");
  await scenario.draft();
  await scenario.review("draft-questions");
  await scenario.refine();
  await scenario.review("draft-coverage");
  await scenario.gate();
  await scenario.spec();
  const finding = { kind: "blocking", findingId: "F-context", title: "Record the context", target: "goal",
    body: "The goal needs its recorded context.", issue: "The context is absent.",
    requiredChange: "Record the selected context.", whyBlocking: "The selected result needs that context." };
  await scenario.specReview([finding]);
  const before = scenario.protectedState();
  const current = scenario.manager.readCurrentSpecReview({ specId: scenario.specId, consumerNodeId: "spec-triage" });
  assert.ok(current);
  const read = await scenario.captureQuery({ resource: "activities", condition: { specId: scenario.specId },
    page: { limit: 100, after: null } });
  const captured = read.version;
  assert.equal(captured.projectionError, null, JSON.stringify(captured.projectionError));
  assert.equal(captured.response.pageInfo.returnedItems, before.ledger.length);
  assert.equal(captured.response.completeness.details, "complete");
  const publication = captured.activities.find((activity) => activity.reviewPublication?.stage === "spec-review");
  const terminal = captured.activities.find((activity) => activity.nodeId === "spec-review"
    && activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal");
  assert.ok(publication);
  assert.ok(terminal);
  const originalDescriptor = captured.catalog.artifacts.find((descriptor) => descriptor.logicalKey === "activity.evidence"
    && descriptor.activityId === publication.id);
  assert.ok(originalDescriptor);
  const document = FLOW_ARTIFACT_CONTRACTS.require("activity.evidence").contentContract
    .parse(captured.artifactBytes.get(originalDescriptor.relativePath));
  assert.ok(document instanceof FlowArtifactSpecReviewActivityEvidenceDocument);
  const mutable = captured.catalog.artifacts.find((descriptor) => descriptor.relativePath === document.source.path);
  assert.equal(mutable.activityId, publication.id);
  assert.deepEqual(current.descriptor.toJSON(), mutable.toJSON());
  mutable.verifyBytes(current.bytes);
  assert.deepEqual(scenario.protectedState(), before);

  const claimDescriptor = captured.catalog.artifacts.find((descriptor) => descriptor.logicalKey === "execution.contract"
    && captured.activities.some((activity) => activity.id === descriptor.activityId
      && activity.nodeId === "draft-gate" && activity.transition.operation === "publish_artifacts"));
  assert.ok(claimDescriptor, "the production Draft Gate retained its provider execution claim");
  const claim = captured.activities.find((activity) => activity.id === claimDescriptor.activityId);
  const claimDocument = JSON.parse(captured.artifactBytes.get(claimDescriptor.relativePath));
  const claimItem = captured.response.items.find((item) => item.activity.id === claim.id);
  assert.ok(claimItem);
  for (const group of ["evaluations", "findings", "repairs"]) {
    assert.deepEqual(claimItem.detailCoverage[group], { availability: "not-applicable", reason: "NOT_APPLICABLE", count: 0 });
    assert.deepEqual(claimItem.detailRefs[group], []);
  }

  for (const [name, mutate] of [
    ["a self-consistent foreign Flow contract", (value) => { value.contract.runId = "foreign-run"; }],
    ["a contract bound to another producer Attempt", (value) => { value.contract.attemptId = "foreign-attempt"; }],
    ["an unsupported contract observation", (value) => { value.findings = []; }],
  ]) await t.test(`${name} cannot classify a Gate publication as execution-only`, () => {
    const value = structuredClone(claimDocument);
    mutate(value);
    const contract = FlowExecutionContract.fromJSON(value.contract);
    value.id = contract.id;
    const bytes = Buffer.from(JSON.stringify(value));
    const target = FLOW_ARTIFACT_CONTRACTS.resolve("execution.contract", contract.parameters);
    const descriptor = new FlowArtifactDescriptor({
      ...target.publication({ mediaType: "application/json", updater: claim.nodeId, activityId: claim.id }),
      hash: hash(bytes), size: bytes.length,
    });
    const artifactBytes = new Map(captured.artifactBytes);
    artifactBytes.delete(claimDescriptor.relativePath);
    artifactBytes.set(descriptor.relativePath, bytes);
    const index = new QueryDetailIndex({ state: captured.state, activities: captured.activities,
      catalog: new FlowArtifactCatalog({ artifacts: captured.catalog.artifacts.map((entry) =>
        entry.relativePath === claimDescriptor.relativePath ? descriptor : entry) }),
      artifactBytes, snapshotId: captured.response.snapshot.id });
    assert.throws(() => index.forActivity(claim), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  });

  await t.test("a claim cannot borrow another generation's internally consistent contract", () => {
    const next = FlowExecutionContract.fromJSON({ ...claimDocument.contract, generation: claimDocument.contract.generation + 1 });
    const bytes = Buffer.from(JSON.stringify({ id: next.id, contract: next.toJSON() }));
    const other = { ...claim.toJSON(), id: `${claim.id}-other-generation`, confirmationOrder: captured.state.confirmationOrder + 1 };
    const target = FLOW_ARTIFACT_CONTRACTS.resolve("execution.contract", next.parameters);
    const otherDescriptor = new FlowArtifactDescriptor({
      ...target.publication({ mediaType: "application/json", updater: other.nodeId, activityId: other.id }),
      hash: hash(bytes), size: bytes.length,
    });
    const artifactBytes = new Map(captured.artifactBytes);
    artifactBytes.set(claimDescriptor.relativePath, bytes);
    artifactBytes.set(otherDescriptor.relativePath, bytes);
    const artifacts = captured.catalog.artifacts.map((entry) => entry.relativePath === claimDescriptor.relativePath
      ? new FlowArtifactDescriptor({ ...entry.toJSON(), hash: hash(bytes), size: bytes.length }) : entry);
    const index = new QueryDetailIndex({ state: captured.state, activities: [...captured.activities, other],
      catalog: new FlowArtifactCatalog({ artifacts: [...artifacts, otherDescriptor] }),
      artifactBytes, snapshotId: captured.response.snapshot.id });
    assert.throws(() => index.forActivity(claim), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  });

  await t.test("a semantic reference cannot hide behind a valid execution contract", () => {
    const changed = claim.toJSON();
    changed.references.findings = [{ id: finding.findingId, label: null }];
    const index = new QueryDetailIndex({ state: captured.state,
      activities: captured.activities.map((activity) => activity.id === claim.id ? changed : activity),
      catalog: captured.catalog, artifactBytes: captured.artifactBytes, snapshotId: captured.response.snapshot.id });
    assert.throws(() => index.forActivity(changed), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  });

  const indexFor = ({ values = [document.toJSON()], activity = publication, mutableOwner = null } = {}) => {
    const artifacts = captured.catalog.artifacts.filter((descriptor) => descriptor.relativePath !== originalDescriptor.relativePath)
      .map((descriptor) => mutableOwner !== null && descriptor.relativePath === mutable.relativePath
        ? new FlowArtifactDescriptor({ ...descriptor.toJSON(), activityId: mutableOwner }) : descriptor);
    const artifactBytes = new Map(captured.artifactBytes);
    artifactBytes.delete(originalDescriptor.relativePath);
    // Normal projection needs only the archive. Boundary fixtures that test
    // its mutable alternative admit those exact production bytes explicitly.
    artifactBytes.set(mutable.relativePath, current.bytes);
    for (const value of values) {
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      const address = FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId: activity.nodeId, digest: hash(bytes) });
      const descriptor = new FlowArtifactDescriptor({ ...address.publication({ mediaType: "application/json",
        updater: activity.nodeId, activityId: activity.id }), hash: hash(bytes), size: bytes.length });
      artifacts.push(descriptor);
      artifactBytes.set(descriptor.relativePath, bytes);
    }
    return new QueryDetailIndex({ state: captured.state,
      activities: captured.activities.map((entry) => entry.id === publication.id ? activity : entry),
      catalog: new FlowArtifactCatalog({ artifacts }), artifactBytes, snapshotId: captured.response.snapshot.id });
  };
  assert.equal(indexFor().forActivity(publication).detailCoverage.findings.count, 1);

  for (const replacement of [new SpecReviewPassedResult(), new SpecReviewAdvisoryResult()]) {
    await t.test(`an internally valid ${replacement.kind} terminal cannot reinterpret its retained blocking Review`, () => {
      const changed = changedResult(terminal, captured.state, (result) =>
        replaceStoredResult(result, terminal, captured.state, replacement, settleSpecStepResult));
      assert.deepEqual(changed.result.draftSettlementReceipt.binding, terminal.result.draftSettlementReceipt.binding);
      const originalLifecycle = DraftStepExecutionLifecycle.fromJSON(terminal.result.draftSettlementReceipt.executionLifecycle.toJSON());
      const changedLifecycle = DraftStepExecutionLifecycle.fromJSON(changed.result.draftSettlementReceipt.executionLifecycle.toJSON());
      assert.equal(changedLifecycle.equals(originalLifecycle), true);
      DraftStepSettlementReceipt.assertStored(changed.result.draftSettlementReceipt, {
        binding: receiptBinding(terminal, captured.state), result: changed.result.stepResult,
        settlement: settleSpecStepResult(changed.nodeId, changed.result.stepResult) });
      const index = new QueryDetailIndex({ state: captured.state,
        activities: captured.activities.map((activity) => activity.id === terminal.id ? changed : activity),
        catalog: captured.catalog, artifactBytes: captured.artifactBytes, snapshotId: captured.response.snapshot.id });
      assert.throws(() => index.forActivity(changed), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
      assert.deepEqual(scenario.protectedState(), before);
    });
  }

  await t.test("a self-consistent foreign Spec archive cannot certify the selected Flow", () => {
    const foreignReview = new CanonicalSpecReview({ ...document.review.toJSON(), identity: {
      ...document.review.identity.toJSON(), specId: "825-different-spec-history" } });
    const foreignFact = new ActivityReviewPublication({ ...publication.reviewPublication.toJSON(),
      identity: foreignReview.identity.toJSON(), reviewDigest: foreignReview.digest });
    const foreignActivity = publication.withReviewPublication(foreignFact);
    const foreignDocument = new FlowArtifactSpecReviewActivityEvidenceDocument({ ...document.toJSON(),
      source: { ...document.source, hash: foreignReview.digest }, review: foreignReview.toJSON() });
    assert.equal(foreignDocument.assertActivity(foreignActivity), foreignDocument,
      "the document, fact, owner and body are internally self-consistent");
    DraftStepSettlementReceipt.assertStored(foreignActivity.result.draftSettlementReceipt, {
      binding: { runId: captured.state.runId, specId: captured.state.specId, stepId: foreignActivity.nodeId,
        attempt: { id: foreignActivity.attemptId, sequence: foreignActivity.sequence } }, result: foreignActivity.result.stepResult });
    const index = indexFor({ values: [foreignDocument.toJSON()], activity: foreignActivity });
    assert.throws(() => index.forActivity(foreignActivity), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  });

  for (const [name, mutate] of [
    ["unknown archive meaning", (value) => { value.futureMeaning = true; }],
    ["unknown Review meaning", (value) => { value.review.futureMeaning = true; }],
    ["missing Review body field", (value) => { delete value.review.findings; }],
    ["different retained generation", (value) => { value.review.generation += 1; }],
    ["different owner", (value) => { value.owner.nodeId = "spec-triage"; }],
  ]) await t.test(`${name} cannot fall back to the available mutable body`, () => {
    const value = document.toJSON();
    mutate(value);
    assert.throws(() => indexFor({ values: [value] }).forActivity(publication),
      { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
  });

  await t.test("a core note permits mutable fallback only while the exact publication body is retained", () => {
    const { review, ...note } = document.toJSON();
    const valid = indexFor({ values: [note] });
    const details = valid.forActivity(publication);
    const findingId = details.detailRefs.findings[0];
    assert.equal(valid.entities.findings.get(findingId).source.relativePath, mutable.relativePath);
    assert.equal(valid.entities.findings.get(findingId).finding.body, finding.body);
    const lost = indexFor({ values: [note], mutableOwner: terminal.id });
    assert.throws(() => lost.forActivity(publication),
      { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" });
  });

  await t.test("two internally valid archives for the publication refuse ambiguous retained meaning", () => {
    const second = { ...document.toJSON(), note: "A second retained Review observation." };
    new FlowArtifactSpecReviewActivityEvidenceDocument(second).assertActivity(publication);
    assert.throws(() => indexFor({ values: [document.toJSON(), second] }).forActivity(publication),
      { code: "DETAIL_UNAVAILABLE", reason: "AMBIGUOUS_REFERENCE" });
  });
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), before);
});
