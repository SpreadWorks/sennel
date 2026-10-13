import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { FlowQueryConsumer } from "../../support/builders/flow-query-consumer.js";
import { QueryDraftReviewScenario, queryActivityDetails as detailsAt, queryHistoricalEntitySemantics } from "../../support/infrastructure/query-draft-review-scenario.js";
import RunReopenDraftCommand from "../../../src/flow/lib/run-reopen-draft.js";
import { CanonicalFlowVersionReader, Cursor, QueryRequest } from "../../../src/flow/query.js";
import { QueryDetailIndex } from "../../../src/flow/query-details.js";
import { FlowArtifactCatalog, FlowArtifactDescriptor } from "../../../src/lib/flow-version.js";

const GROUPS = ["evaluations", "findings", "repairs"];
const advisory = { title: "Clarify validation", target: "analysis.validation",
  rationale: "Retain the concrete validation expectation.", evidence: "The Draft validation can be clearer.", classification: "advisory" };

async function all(scenario, extra = {}) {
  return new FlowQueryConsumer().consume(await scenario.query({ resource: "activities",
    condition: { specId: scenario.specId }, page: { limit: 100, after: null }, ...extra }));
}

async function one(scenario, activity) {
  const metadata = await scenario.query({ resource: "metadata", condition: { specId: scenario.specId } });
  const request = { resource: "activities", condition: { specId: scenario.specId }, page: { limit: 1, after: null } };
  request.page.after = new Cursor({ request: new QueryRequest(request), order: activity.confirmationOrder - 1,
    snapshotId: metadata.snapshot.id }).encode();
  return new FlowQueryConsumer().consume(await scenario.query(request));
}

function stageActivity(scenario, stepId, phase) {
  const activity = scenario.manager.activityLedger(scenario.specId).findLast((entry) => entry.nodeId === stepId
    && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === phase);
  assert.ok(activity, `${stepId} persisted ${phase}`);
  return activity;
}

function assertExecutionOnly(item) {
  for (const group of GROUPS) {
    assert.deepEqual(item.detailRefs[group], []);
    assert.deepEqual(item.detailCoverage[group], { availability: "not-applicable", reason: "NOT_APPLICABLE", count: 0 });
  }
}

function assertReviewPair(items, entities, ledger, stepId, verdict, count) {
  const stages = ledger.filter((entry) => entry.nodeId === stepId && entry.result?.draftSettlementReceipt);
  const stage = (phase) => stages.find((entry) => entry.result.draftSettlementReceipt.executionLifecycle?.phase === phase);
  for (const phase of ["checkpoint", "claimed"]) {
    const item = items.find((entry) => entry.activity.id === stage(phase)?.id);
    assert.ok(item, `${stepId} ${phase} is returned`);
    assertExecutionOnly(item);
  }
  const publication = stage("publication");
  const terminal = stage("terminal");
  assert.ok(publication);
  assert.ok(terminal);
  const published = items.find((entry) => entry.activity.id === publication.id);
  const completed = items.find((entry) => entry.activity.id === terminal.id);
  assert.deepEqual(completed.detailRefs, published.detailRefs);
  assert.deepEqual(completed.detailCoverage, published.detailCoverage);
  assert.equal(published.detailCoverage.evaluations.count, 1);
  assert.equal(published.detailCoverage.findings.count, count);
  assert.equal(published.detailCoverage.findings.availability, "available");
  assert.equal(published.detailCoverage.repairs.availability, "not-applicable");
  const evaluation = entities.evaluations.get(published.detailRefs.evaluations[0]);
  const expectedOutcomes = { PASS: "passed", ADVISORY: "advisory", REJECTED: "failed" };
  assert.deepEqual(evaluation.result, { outcome: expectedOutcomes[verdict], nativeCode: verdict });
  assert.equal(evaluation.summary, `${stepId.slice(0, -"-review".length)} saved ${verdict} review.`);
  assert.equal(evaluation.source.producerActivityId, publication.id);
  assert.equal(evaluation.source.jsonPointer, "/attempts/0/artifact/payload");
  for (const id of published.detailRefs.findings) {
    const finding = entities.findings.get(id);
    assert.equal(finding.source.producerActivityId, publication.id);
    assert.deepEqual(Object.keys(finding.identity).sort(), ["fingerprint", "sourceArtifact", "sourceFindingId", "sourceStep"]);
  }
}

test("production Draft questions and coverage history pages from null through the actual CLI without changing saved state", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "811-query-draft-cli");
  await scenario.draft();
  await scenario.review("draft-questions");
  await scenario.refine();
  await scenario.review("draft-coverage", { verdict: "ADVISORY", advisory: [advisory] });
  scenario.reload();
  const before = scenario.protectedState();
  const consumer = new FlowQueryConsumer();
  const metadataResult = scenario.cli({ resource: "metadata", condition: { specId: scenario.specId } });
  assert.equal(metadataResult.status, 0, metadataResult.stderr || metadataResult.stdout);
  const metadata = consumer.consumeSerialized(metadataResult.stdout);
  const request = { resource: "activities", condition: { specId: scenario.specId }, page: { limit: 1, after: null } };
  const items = [];
  const entities = Object.fromEntries(GROUPS.map((group) => [group, new Map()]));
  let totalItems;
  do {
    const result = scenario.cli(request);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const page = consumer.consumeSerialized(result.stdout);
    assert.equal(page.error, null);
    assert.equal(page.snapshot.id, metadata.snapshot.id);
    const applicable = page.items.some((item) => GROUPS.some((group) => item.detailCoverage[group].availability === "available"));
    assert.equal(page.completeness.details, applicable ? "complete" : "not-applicable");
    assert.equal(page.completeness.sourceHistory, "complete");
    assert.equal(page.completeness.enumeration, "complete");
    assert.equal(page.pageInfo.returnedItems, page.items.length);
    totalItems ??= page.pageInfo.totalItems;
    assert.equal(page.pageInfo.totalItems, totalItems);
    items.push(...page.items);
    for (const group of GROUPS) for (const entity of page.entities[group]) {
      if (entities[group].has(entity.id)) assert.deepEqual(entity, entities[group].get(entity.id));
      else entities[group].set(entity.id, entity);
    }
    for (const item of page.items) for (const group of GROUPS) {
      assert.equal(item.detailCoverage[group].count, item.detailRefs[group].length);
      for (const id of item.detailRefs[group]) assert.ok(page.entities[group].some((entity) => entity.id === id));
      const legacyField = group === "evaluations" ? "evaluationIds" : group === "findings" ? "findingIds" : "repairIds";
      assert.deepEqual(item.referenceBindings[group].map((binding) => binding.reference.id).sort(), [...item[legacyField]].sort());
      for (const binding of item.referenceBindings[group]) for (const id of binding.detailIds) {
        assert.ok(page.entities[group].some((entity) => entity.id === id));
      }
    }
    for (const group of GROUPS) for (const entity of page.entities[group]) for (const source of [entity.source, ...entity.supportingSources]) {
      const artifact = metadata.item.artifacts.find((entry) => entry.artifactId === source.artifactId);
      assert.ok(artifact, "detail source belongs to the same-snapshot metadata catalog");
      assert.equal(source.artifactKey, artifact.artifactKey);
      assert.equal(source.hash, artifact.hash);
      assert.equal(source.relativePath, artifact.relativePath);
    }
    if (!page.pageInfo.hasNext) break;
    assert.ok(page.pageInfo.endCursor);
    request.page.after = page.pageInfo.endCursor;
    assert.ok(items.length <= before.ledger.length, "paging makes progress without repetition");
  } while (true);
  assert.equal(items.length, totalItems);
  assert.equal(items.length, before.ledger.length);
  assert.equal(new Set(items.map((item) => item.activity.id)).size, items.length);
  assertReviewPair(items, entities, before.ledger, "draft-questions-review", "PASS", 0);
  assertReviewPair(items, entities, before.ledger, "draft-coverage-review", "ADVISORY", 1);
  assert.equal(entities.findings.values().next().value.description, advisory.rationale);
  const publicJSON = JSON.stringify({ items, entities: Object.fromEntries(GROUPS.map((group) => [group, [...entities[group].values()]])) });
  for (const internal of ["workerOutput", "canonicalEvidence", "canonicalTarget", "targetStateDigest", "treeSha", "manifestDigest", "publicationDigest"]) {
    assert.equal(publicJSON.includes(`"${internal}"`), false, `${internal} remains internal`);
  }
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), before);
});

for (const phase of ["draft-questions", "draft-coverage"]) {
  test(`production ${phase} checkpoint and claim have no evaluation before publication; publication survives interruption and terminal shares its entities`, async (t) => {
    const scenario = new QueryDraftReviewScenario(t, `812-query-${phase}`);
    await scenario.draft();
    if (phase === "draft-coverage") {
      await scenario.review("draft-questions");
      await scenario.refine();
    }
    const stepId = `${phase}-review`;
    await scenario.checkpoint(phase);
    const checkpoint = stageActivity(scenario, stepId, "checkpoint");
    const checkpointState = scenario.protectedState();
    assertExecutionOnly(detailsAt(await all(scenario), checkpoint.id).item);
    assert.equal(scenario.manager.artifactCatalog(scenario.specId).toJSON().artifacts
      .some((entry) => entry.logicalKey === `draft.${phase.split("-")[1]}.review`), false);
    assert.deepEqual(scenario.protectedState(), checkpointState);
    let claimed;
    await scenario.review(phase, { terminal: false, beforeOutput: async () => {
      scenario.reload();
      claimed = stageActivity(scenario, stepId, "claimed");
      const before = scenario.protectedState();
      const unPublished = await all(scenario);
      assertExecutionOnly(detailsAt(unPublished, checkpoint.id).item);
      assertExecutionOnly(detailsAt(unPublished, claimed.id).item);
      assert.deepEqual(scenario.protectedState(), before);
    } });
    const publication = stageActivity(scenario, stepId, "publication");
    assert.equal(scenario.manager.activityLedger(scenario.specId).some((entry) => entry.nodeId === stepId
      && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "terminal"), false);
    const publishedState = scenario.protectedState();
    const interrupted = await all(scenario);
    const published = detailsAt(interrupted, publication.id);
    assert.equal(published.item.detailCoverage.evaluations.count, 1);
    assert.equal(published.entities.evaluations[0].result.nativeCode, "PASS");
    assert.deepEqual(published.item.detailCoverage.findings, { availability: "available", reason: null, count: 0 });
    assertExecutionOnly(detailsAt(interrupted, checkpoint.id).item);
    assertExecutionOnly(detailsAt(interrupted, claimed.id).item);
    assert.deepEqual(scenario.protectedState(), publishedState);
    // Reloaded execute reconstructs the publication; no previous command
    // result or transient work unit is passed into terminal recovery.
    await scenario.resumeReview(phase);
    const terminal = stageActivity(scenario, stepId, "terminal");
    const complete = await all(scenario);
    assert.deepEqual(detailsAt(complete, publication.id), published);
    assert.deepEqual(detailsAt(complete, terminal.id).item.detailRefs, published.item.detailRefs);
    assert.deepEqual(detailsAt(complete, terminal.id).entities, published.entities);
    const filtered = await one(scenario, terminal);
    assert.equal(filtered.items.some((item) => item.activity.id === publication.id), false);
    assert.deepEqual(detailsAt(filtered, terminal.id).entities, published.entities);
    assert.equal(filtered.snapshot.id, complete.snapshot.id);
    // These real execution Activities do not record timing. Date filtering
    // must not invent it from the separate NodeResult.confirmedAt field.
    assert.equal(terminal.timing, null);
    assert.equal(publication.timing, null);
    const dated = await all(scenario, { recordedAt: { gte: terminal.result.confirmedAt } });
    assert.equal(dated.items.some((item) => item.activity.id === terminal.id || item.activity.id === publication.id), false);
  });
}

test("production rejected Draft Review publishes blocking, advisory and repair targets as findings with no applied Repair", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "814-query-draft-rejected");
  await scenario.draft();
  const blocking = { title: "Specify missing behavior", target: "analysis.validation", rationale: "A required check is missing.", evidence: "The Draft omitted the expected exit status.", classification: "blocking" };
  const repair = { title: "Repair validation detail", target: "analysis.validation", rationale: "Record the omitted expected result.", evidence: "The validation requirement names the result.", classification: "repair_target" };
  await scenario.review("draft-questions", { verdict: "REJECTED", blocking: [blocking], advisory: [advisory], repairs: [repair] });
  const publication = stageActivity(scenario, "draft-questions-review", "publication");
  const terminal = stageActivity(scenario, "draft-questions-review", "terminal");
  const response = await all(scenario);
  const saved = detailsAt(response, publication.id);
  assert.deepEqual(saved.entities.evaluations[0].result, { outcome: "failed", nativeCode: "REJECTED" });
  assert.deepEqual(saved.entities.findings.map((entry) => entry.specific.classification), ["blocking", "advisory", "repair_target"]);
  assert.deepEqual(saved.entities.findings.map((entry) => entry.description), [blocking.rationale, advisory.rationale, repair.rationale]);
  assert.deepEqual(saved.entities.findings.map((entry) => entry.source.jsonPointer), [
    "/attempts/0/artifact/payload/blockingFindings/0", "/attempts/0/artifact/payload/advisoryFindings/0", "/attempts/0/artifact/payload/repairTargets/0",
  ]);
  assert.deepEqual(saved.entities.repairs, []);
  assert.deepEqual(detailsAt(response, terminal.id).entities, saved.entities);
  assert.equal(scenario.manager.canonicalState(scenario.specId).nextAction().nodeId, "draft-questions-triage");
});

test("production Draft reopen retains exact previous Review Attempt bodies even when the descriptor belongs to a later publication", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "815-query-draft-history");
  await scenario.draft();
  await scenario.review("draft-questions", { verdict: "ADVISORY", advisory: [advisory] });
  const oldPublication = stageActivity(scenario, "draft-questions-review", "publication");
  const oldTerminal = stageActivity(scenario, "draft-questions-review", "terminal");
  scenario.manager.beginNextAction(scenario.specId);
  const reopen = await new RunReopenDraftCommand().execute({ ...scenario.ctx,
    flowState: scenario.manager.loadReadOnly(scenario.specId), reason: "Revisit the Draft with a second retained Review Attempt." });
  assert.equal(reopen.ok, true, JSON.stringify(reopen));
  scenario.reload();
  await scenario.draft();
  await scenario.review("draft-questions");
  const latest = stageActivity(scenario, "draft-questions-review", "publication");
  const latestTerminal = stageActivity(scenario, "draft-questions-review", "terminal");
  assert.notEqual(latest.attemptId, oldPublication.attemptId);
  assert.equal(latest.sequence, oldPublication.sequence + 1);
  const artifact = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "draft.questions.review", consumerNodeId: "system" });
  assert.equal(artifact.descriptor.activityId, latest.id);
  const history = JSON.parse(artifact.bytes);
  assert.deepEqual(history.attempts.map((entry) => entry.attempt), [oldPublication.sequence, latest.sequence]);
  const before = scenario.protectedState();
  const metadata = new FlowQueryConsumer().consume(await scenario.query({ resource: "metadata", condition: { specId: scenario.specId } }));
  const response = await all(scenario);
  assert.equal(response.snapshot.id, metadata.snapshot.id);
  assert.equal(response.pageInfo.hasNext, false);
  assert.equal(response.pageInfo.totalItems, before.ledger.length);
  assert.equal(response.pageInfo.returnedItems, before.ledger.length);
  assert.deepEqual(response.items.map((item) => item.activity.id), before.ledger.map((activity) => activity.id));
  assert.equal(new Set(response.items.map((item) => item.activity.id)).size, before.ledger.length);
  assert.equal(response.completeness.details, "complete");
  assert.equal(response.completeness.sourceHistory, "complete");
  const earlier = detailsAt(response, oldPublication.id);
  assert.equal(earlier.entities.evaluations[0].result.nativeCode, "ADVISORY");
  assert.equal(earlier.entities.evaluations[0].source.producerActivityId, oldPublication.id);
  assert.equal(earlier.entities.evaluations[0].source.attemptId, oldPublication.attemptId);
  assert.equal(earlier.entities.evaluations[0].source.jsonPointer, "/attempts/0/artifact/payload");
  assert.equal(earlier.entities.findings[0].description, advisory.rationale);
  assert.deepEqual(detailsAt(response, oldTerminal.id).entities, earlier.entities);
  assert.deepEqual(detailsAt(response, oldTerminal.id).item.detailRefs, earlier.item.detailRefs);
  const current = detailsAt(response, latest.id);
  assert.equal(current.entities.evaluations[0].result.nativeCode, "PASS");
  assert.equal(current.entities.evaluations[0].source.producerActivityId, latest.id);
  assert.equal(current.entities.evaluations[0].source.attemptId, latest.attemptId);
  assert.equal(current.entities.evaluations[0].source.jsonPointer, "/attempts/1/artifact/payload");
  assert.deepEqual(current.entities.findings, []);
  assert.notEqual(current.entities.evaluations[0].id, earlier.entities.evaluations[0].id);
  assert.deepEqual(detailsAt(response, latestTerminal.id).entities, current.entities);
  assert.deepEqual(detailsAt(response, latestTerminal.id).item.detailRefs, current.item.detailRefs);
  for (const [terminal, expected] of [[oldTerminal, earlier], [latestTerminal, current]]) {
    const selected = await one(scenario, terminal);
    assert.equal(selected.snapshot.id, metadata.snapshot.id);
    assert.deepEqual(detailsAt(selected, terminal.id).entities, expected.entities);
  }
  const repeated = await all(scenario);
  assert.equal(repeated.snapshot.id, metadata.snapshot.id);
  assert.deepEqual(repeated.items, response.items);
  assert.deepEqual(repeated.entities, response.entities);
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), before);
});

test("captured production Draft Review refuses unsupported or inconsistent payloads and altered publication content", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "816-query-draft-refusal");
  await scenario.draft();
  await scenario.review("draft-questions", { verdict: "ADVISORY", advisory: [advisory] });
  const publication = stageActivity(scenario, "draft-questions-review", "publication");
  const before = scenario.protectedState();
  const read = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(scenario.specId, 1,
    new QueryRequest({ resource: "activities", condition: { specId: scenario.specId }, page: { limit: 100, after: null } }));
  assert.equal(read.version.projectionError, null);
  const captured = read.version;
  const descriptor = captured.catalog.artifacts.find((entry) => entry.logicalKey === "draft.questions.review");
  assert.ok(descriptor);
  const original = captured.artifactBytes.get(descriptor.relativePath);
  assert.ok(original, "query hydration retained the same-snapshot production history bytes");
  const activity = captured.activities.find((entry) => entry.id === publication.id);
  const makeIndex = (mutate) => {
    const history = JSON.parse(original);
    mutate(history.attempts[0]);
    const bytes = Buffer.from(JSON.stringify(history));
    const artifactBytes = new Map(captured.artifactBytes);
    artifactBytes.set(descriptor.relativePath, bytes);
    const replacement = new FlowArtifactDescriptor({ ...descriptor.toJSON(),
      hash: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    const catalog = new FlowArtifactCatalog({ artifacts: captured.catalog.artifacts.map((entry) =>
      entry.relativePath === descriptor.relativePath ? replacement : entry) });
    return new QueryDetailIndex({ state: captured.state, activities: captured.activities,
      catalog, artifactBytes, snapshotId: read.version.response.snapshot.id });
  };
  // Every case starts from captured, valid producer output. Updating the
  // capture's descriptor hash isolates semantic and receipt binding checks
  // from the separately tested file-corruption boundary.
  for (const [name, mutate] of [
    ["unknown payload meaning", (record) => { record.artifact.payload.futureMeaning = "unknown"; }],
    ["missing internal evidence", (record) => { delete record.artifact.payload.canonicalEvidence; }],
    ["missing internal output receipt", (record) => { delete record.artifact.payload.workerOutput; }],
    ["missing internal target", (record) => { delete record.artifact.payload.canonicalTarget; }],
    ["invalid output digest", (record) => { record.artifact.payload.workerOutput.digest = "invalid"; }],
    ["invalid output media type", (record) => { record.artifact.payload.workerOutput.mediaType = "text/plain"; }],
    ["different target", (record) => { record.artifact.payload.canonicalTarget.treeSha = "c".repeat(40); }],
    ["evidence/body contradiction", (record) => { record.artifact.payload.advisoryFindings[0].rationale = "Different saved meaning."; }],
    ["different command result", (record) => { record.result.artifacts.issueCount += 1; }],
    ["different record outcome", (record) => { record.outcome = "rejected"; }],
  ]) {
    assert.throws(() => makeIndex(mutate).forActivity(activity), { code: "DETAIL_UNAVAILABLE", reason: "PRODUCER_NOT_SUPPORTED" }, name);
  }
  assert.throws(() => makeIndex((record) => { record.nodeId = "draft-coverage-review"; }).forActivity(activity),
    { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" }, "changed owner cannot identify the retained generation");
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), before);
});

test("production Draft Gate and Spec Review retain their history through Triage and Repair and refuse a capture missing the old Review evidence", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "817-query-draft-spec-prefix");
  await scenario.draft();
  await scenario.review("draft-questions");
  await scenario.refine();
  await scenario.review("draft-coverage");
  await scenario.gate();
  await scenario.spec();
  const finding = { kind: "blocking", findingId: "F-spec-prefix", title: "Clarify goal", target: "goal",
    body: "The saved goal needs clarification.", issue: "The goal lacks an exact result.",
    requiredChange: "Describe the exact result.", whyBlocking: "The acceptance needs a measurable result." };
  await scenario.specReview([finding]);
  const before = scenario.protectedState();
  const metadataResult = scenario.cli({ resource: "metadata", condition: { specId: scenario.specId } });
  assert.equal(metadataResult.status, 0, metadataResult.stdout || metadataResult.stderr);
  const consumer = new FlowQueryConsumer();
  const metadata = consumer.consumeSerialized(metadataResult.stdout);
  const request = { resource: "activities", condition: { specId: scenario.specId }, page: { limit: 100, after: null } };
  const result = scenario.cli(request);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const response = consumer.consumeSerialized(result.stdout);
  assert.equal(response.snapshot.id, metadata.snapshot.id);
  assert.equal(response.pageInfo.hasNext, false);
  assert.equal(response.pageInfo.returnedItems, before.ledger.length);
  assert.equal(response.pageInfo.totalItems, before.ledger.length);
  assert.equal(response.completeness.details, "complete");
  assert.equal(response.completeness.sourceHistory, "complete");
  const publication = before.ledger.findLast((entry) => entry.reviewPublication?.stage === "spec-review");
  const terminal = before.ledger.findLast((entry) => entry.result?.stepResult?.kind === "spec-review-rejected");
  const published = detailsAt(response, publication.id);
  assertExecutionOnly(detailsAt(response, before.ledger.find((entry) => entry.nodeId === "spec-review"
    && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "checkpoint").id).item);
  assert.deepEqual(published.item.detailCoverage.evaluations, { availability: "not-applicable", reason: "NOT_APPLICABLE", count: 0 });
  assert.equal(published.entities.findings[0].description, finding.body);
  const completed = detailsAt(response, terminal.id);
  assert.deepEqual(completed.entities.findings, published.entities.findings);
  assert.equal(completed.entities.evaluations[0].result.nativeCode, "spec-review-rejected");
  assert.ok(response.entities.evaluations.some((entry) => entry.source.producerActivityId === before.ledger
    .findLast((activity) => activity.result?.stepResult?.kind === "draft-gate-passed").id));
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), before);
  assert.equal((await scenario.specWorker("spec-triage", { findings: [{ findingId: finding.findingId,
    disposition: "invalid", evidence: "The persisted goal already provides the required result." }] })).kind,
  "spec-triage-completed");
  assert.equal((await scenario.specWorker("spec-repair")).kind, "spec-repair-unchanged");
  const repairedState = scenario.protectedState();
  const savedResult = scenario.cli(request);
  assert.equal(savedResult.status, 0, savedResult.stdout || savedResult.stderr);
  const saved = consumer.consumeSerialized(savedResult.stdout);
  assert.equal(saved.pageInfo.totalItems, repairedState.ledger.length);
  assert.equal(saved.pageInfo.returnedItems, repairedState.ledger.length);
  assert.equal(saved.pageInfo.hasNext, false);
  assert.deepEqual(detailsAt(saved, publication.id).entities, published.entities);
  for (const group of GROUPS) assert.deepEqual(detailsAt(saved, terminal.id).entities[group].map(queryHistoricalEntitySemantics),
    completed.entities[group].map(queryHistoricalEntitySemantics));
  assert.equal(saved.completeness.details, "complete");
  const repair = repairedState.ledger.findLast((entry) => entry.result?.stepResult?.kind === "spec-repair-unchanged");
  const repairOnly = await one(scenario, repair);
  const retained = detailsAt(repairOnly, repair.id);
  assert.equal(retained.entities.repairs.length, 1);
  assert.equal(retained.entities.repairs[0].status.value, "skipped");
  assert.deepEqual(retained.entities.repairs[0].items, []);
  assert.equal(retained.entities.repairs[0].source.producerActivityId, repair.id);
  const read = await new CanonicalFlowVersionReader({ repositoryRoot: scenario.root }).read(scenario.specId, 1, new QueryRequest(request));
  assert.equal(read.version.projectionError, null);
  const captured = read.version;
  const auxiliary = captured.catalog.artifacts.filter((descriptor) => descriptor.logicalKey === "activity.evidence"
    && descriptor.activityId === publication.id);
  assert.equal(auxiliary.length, 1, "the original Review has its own immutable saved evidence");
  const missingPaths = new Set(auxiliary.map((descriptor) => descriptor.relativePath));
  const artifactBytes = new Map([...captured.artifactBytes].filter(([relativePath]) => !missingPaths.has(relativePath)));
  const catalog = new FlowArtifactCatalog({ artifacts: captured.catalog.artifacts.filter((descriptor) => !missingPaths.has(descriptor.relativePath)) });
  const missingEvidence = new QueryDetailIndex({ state: captured.state, activities: captured.activities,
    catalog, artifactBytes, snapshotId: captured.response.snapshot.id });
  assert.throws(() => missingEvidence.forActivity(captured.activities.find((activity) => activity.id === publication.id)),
    { code: "DETAIL_UNAVAILABLE", reason: "SOURCE_GENERATION_NOT_RETAINED" }, "the overwritten current Review cannot substitute for missing historical evidence");
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), repairedState);
});
