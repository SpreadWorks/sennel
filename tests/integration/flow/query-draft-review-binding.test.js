import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryDraftReviewScenario } from "../../support/infrastructure/query-draft-review-scenario.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import { QueryDetailIndex } from "../../../src/flow/query-details.js";
import { FlowActivity } from "../../../src/flow/lib/current-flow-state.js";
import { DraftQuestionsReviewFindingsResult, DraftCoverageReviewPassedResult } from "../../../src/flow/engine/step-result.js";
import { changedResult, replaceStoredResult } from "../../support/infrastructure/query-captured-step-result.js";

test("captured normal Draft terminal refuses a contradictory Result, complete execution binding differences, and missing or ambiguous publication", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "818-query-draft-binding");
  await scenario.draft();
  await scenario.review("draft-questions");
  const protectedState = scenario.protectedState();
  const request = new QueryRequest({ resource: "activities", condition: { specId: scenario.specId },
    page: { limit: 100, after: null } });
  const read = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(scenario.specId, 1, request);
  const captured = read.version;
  assert.equal(captured.projectionError, null, JSON.stringify(captured.projectionError));
  assert.equal(captured.response.pageInfo.returnedItems, protectedState.ledger.length);
  assert.equal(captured.response.completeness.details, "complete");
  assert.equal(captured.response.completeness.sourceHistory, "complete");
  const publication = captured.activities.find((activity) => activity.nodeId === "draft-questions-review"
    && activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication");
  const terminal = captured.activities.find((activity) => activity.nodeId === "draft-questions-review"
    && activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal");
  assert.ok(publication instanceof FlowActivity);
  assert.ok(terminal instanceof FlowActivity);
  const makeIndex = (activities) => new QueryDetailIndex({ state: captured.state, activities,
    catalog: captured.catalog, artifactBytes: captured.artifactBytes, snapshotId: captured.response.snapshot.id });
  const normal = makeIndex(captured.activities);
  const normalPublication = normal.forActivity(publication).toJSON();
  assert.deepEqual(normal.forActivity(terminal).toJSON(), normalPublication);
  assert.deepEqual(normalPublication.detailCoverage.evaluations, { availability: "available", reason: null, count: 1 });

  const receiptChanges = [
    ["runId", (result) => { result.draftSettlementReceipt.binding.runId = "run-different"; }],
    ["specId", (result) => { result.draftSettlementReceipt.binding.specId = "819-query-other-spec"; }],
    ["stepId", (result) => { replaceStoredResult(result, terminal, captured.state, new DraftCoverageReviewPassedResult()); }],
    ["attemptId", (result) => { result.draftSettlementReceipt.binding.attemptId = "attempt-different"; }],
    ["attemptSequence", (result) => { result.draftSettlementReceipt.binding.attemptSequence += 1; }],
  ];
  for (const [name, mutate] of receiptChanges) {
    await t.test(`self-consistent receipt with different ${name} refuses the external Activity and state binding`, () => {
      // These malformed capture inputs retain internal identity and Result
      // agreement. Their external binding is the query's validation boundary.
      const changed = changedResult(terminal, captured.state, mutate, null);
      assert.notEqual(changed.result.draftSettlementReceipt.binding[name], terminal.result.draftSettlementReceipt.binding[name]);
      const index = makeIndex(captured.activities.map((activity) => activity.id === terminal.id ? changed : activity));
      assert.throws(() => index.forActivity(changed), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
      assert.deepEqual(scenario.protectedState(), protectedState);
    });
  }

  const changes = [
    ["manifestDigest", (result) => { result.draftSettlementReceipt.executionLifecycle.binding.manifestDigest = "c".repeat(64); }],
    ["inputDigest", (result) => { result.draftSettlementReceipt.executionLifecycle.binding.inputDigest = "c".repeat(64); }],
    ["target treeSha", (result) => { result.draftSettlementReceipt.executionLifecycle.binding.target.treeSha = "c".repeat(40); }],
    ["targetStateDigest", (result) => { result.draftSettlementReceipt.executionLifecycle.binding.target.targetStateDigest = "c".repeat(64); }],
    ["executionGeneration", (result) => { result.draftSettlementReceipt.executionLifecycle.binding.executionGeneration += 1; }],
    ["claim", (result) => { result.draftSettlementReceipt.executionLifecycle.claim.request = { skipConfirm: true }; }],
  ];
  for (const [name, mutate] of changes) {
    await t.test(`self-consistent terminal receipt with different ${name} refuses an unrelated publication`, () => {
      const changed = changedResult(terminal, captured.state, mutate);
      const index = makeIndex(captured.activities.map((activity) => activity.id === terminal.id ? changed : activity));
      assert.throws(() => index.forActivity(changed), { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" });
      assert.deepEqual(scenario.protectedState(), protectedState);
    });
  }
  await t.test("a self-consistent findings terminal Result cannot reinterpret the saved PASS publication", () => {
    const changed = changedResult(terminal, captured.state, (result) => {
      replaceStoredResult(result, terminal, captured.state, new DraftQuestionsReviewFindingsResult());
    });
    const index = makeIndex(captured.activities.map((activity) => activity.id === terminal.id ? changed : activity));
    assert.throws(() => index.forActivity(changed), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
    assert.deepEqual(scenario.protectedState(), protectedState);
  });
  await t.test("terminal refuses a missing retained execution publication", () => {
    const index = makeIndex(captured.activities.filter((activity) => activity.id !== publication.id));
    assert.throws(() => index.forActivity(terminal), { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" });
    assert.deepEqual(scenario.protectedState(), protectedState);
  });
  await t.test("terminal refuses two publication candidates for one exact execution binding", () => {
    const duplicate = new FlowActivity({ ...publication.toJSON(), id: `${publication.id}-duplicate` });
    const index = makeIndex([...captured.activities, duplicate]);
    assert.throws(() => index.forActivity(terminal), { code: "DETAIL_UNAVAILABLE", reason: "AMBIGUOUS_REFERENCE" });
    assert.deepEqual(scenario.protectedState(), protectedState);
  });
  await t.test("a Review checkpoint with a saved semantic reference refuses retroactive detail ownership", () => {
    const checkpoint = captured.activities.find((activity) => activity.nodeId === terminal.nodeId
      && activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "checkpoint");
    assert.ok(checkpoint instanceof FlowActivity);
    const serialized = checkpoint.toJSON();
    serialized.references.evaluations = [{ id: publication.id, label: null }];
    const changed = new FlowActivity(serialized);
    const index = makeIndex(captured.activities.map((activity) => activity.id === checkpoint.id ? changed : activity));
    assert.throws(() => index.forActivity(changed), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" });
    assert.deepEqual(scenario.protectedState(), protectedState);
  });
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), protectedState);
});
