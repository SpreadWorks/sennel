import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { specRepairTargetEntries } from "../../../src/flow/lib/spec-repair-operations.js";
import { FlowQueryConsumer } from "../../support/builders/flow-query-consumer.js";
import { QueryDraftReviewScenario, queryActivityDetails, queryHistoricalEntitySemantics } from "../../support/infrastructure/query-draft-review-scenario.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

const GROUPS = ["evaluations", "findings", "repairs"];
const GUARDRAIL = "QUERY-SAVED-HISTORY";
const PRIVATE_CONTEXT = "Unrelated source context must remain private to the Spec worker.";
const REVIEW_FINDING = { kind: "blocking", findingId: "F-retained-history", title: "Clarify the repair boundary", target: "background",
  body: "The background does not state the permitted repair boundary.", issue: "The repair boundary is missing.",
  requiredChange: "State the bounded repair responsibility.", whyBlocking: "The selected work needs an explicit boundary." };
const BACKGROUND = "The validated repair updates only the field permitted by the saved Review.";
const ORIGINAL_REQUIREMENT = "検証済み成果物を公開する。";
const REQUIREMENT_PREFIX = "要件: ";
const REQUIREMENT_SUFFIX = " 各チェックの記録を保存する。";
const REQUIREMENT = `${REQUIREMENT_PREFIX}${ORIGINAL_REQUIREMENT}${REQUIREMENT_SUFFIX}`;
const GATE_FINDING = "Requirement R1 omits the recorded history of its checks.";

function latest(scenario, predicate, label) {
  const activity = scenario.manager.activityLedger(scenario.specId).findLast(predicate);
  assert.ok(activity, label);
  return activity;
}

function reviewPublication(scenario) {
  return latest(scenario, (activity) => activity.reviewPublication?.stage === "spec-review", "the saved Review publication exists");
}

function terminal(scenario, kind) {
  return latest(scenario, (activity) => activity.result?.stepResult?.kind === kind, `${kind} was actually saved`);
}

function readSpec(scenario, consumerNodeId) {
  return JSON.parse(scenario.manager.readArtifact({ specId: scenario.specId, logicalKey: "spec.record", consumerNodeId }).bytes);
}

function errorDiagnostic(error) {
  return error === null ? null : { name: error.name, code: error.code ?? null, path: error.jsonPath ?? null,
    reason: error.reason ?? null, referenceId: error.referenceId ?? null, message: error.message,
    cause: error.cause ? errorDiagnostic(error.cause) : null };
}

/** Each checkpoint is a fresh read of the production Store, including errors. */
class HistoryCheckpoint {
  constructor({ label, metadata, response, ledger, metadataError = null, activitiesError = null }) {
    this.label = label;
    this.metadata = metadata;
    this.response = response;
    this.ledger = ledger;
    this.metadataError = metadataError;
    this.activitiesError = activitiesError;
  }

  static async capture(scenario, label) {
    scenario.reload();
    const before = scenario.protectedState();
    const metadata = await scenario.captureQuery({ resource: "metadata", condition: { specId: scenario.specId } }, { fixedSource: true });
    const activities = await scenario.captureQuery({ resource: "activities", condition: { specId: scenario.specId },
      page: { limit: 100, after: null } }, { fixedSource: true });
    const consumer = new FlowQueryConsumer();
    const checkpoint = new HistoryCheckpoint({ label,
      metadata: metadata.version.projectionError === null ? consumer.consume(metadata.version.response) : null,
      response: activities.version.projectionError === null ? consumer.consume(activities.version.response) : null,
      metadataError: metadata.version.projectionError, activitiesError: activities.version.projectionError,
      ledger: before.ledger });
    assert.deepEqual(scenario.protectedState(), before, `${label}: query preserves canonical state`);
    return checkpoint;
  }

  assertComplete() {
    assert.equal(this.metadataError, null, `${this.label}: metadata projection succeeds`);
    assert.equal(this.activitiesError, null, `${this.label}: history projection succeeds`);
    assert.equal(this.metadata.error, null, `${this.label}: metadata succeeds`);
    assert.equal(this.response.error, null, `${this.label}: history succeeds`);
    assert.equal(this.response.snapshot.id, this.metadata.snapshot.id);
    assert.equal(this.response.pageInfo.hasNext, false);
    assert.equal(this.response.pageInfo.returnedItems, this.ledger.length);
    assert.equal(this.response.pageInfo.totalItems, this.ledger.length);
    assert.deepEqual(this.response.items.map((item) => item.activity.id), this.ledger.map((activity) => activity.id));
    assert.equal(new Set(this.response.items.map((item) => item.activity.id)).size, this.ledger.length);
    assert.equal(this.response.completeness.details, "complete");
    assert.equal(this.response.completeness.sourceHistory, "complete");
    for (const item of this.response.items) for (const group of GROUPS) {
      assert.equal(item.detailCoverage[group].count, item.detailRefs[group].length);
      for (const id of item.detailRefs[group]) assert.ok(this.response.entities[group].some((entity) => entity.id === id));
    }
    for (const group of GROUPS) for (const entity of this.response.entities[group]) {
      for (const source of [entity.source, ...entity.supportingSources]) {
        const artifact = this.metadata.item.artifacts.find((entry) => entry.artifactId === source.artifactId);
        assert.ok(artifact, `${this.label}: detail source is in the captured metadata`);
        assert.equal(source.artifactKey, artifact.artifactKey);
        assert.equal(source.hash, artifact.hash);
      }
    }
  }

  assertRetains(earlier) {
    for (const item of earlier.response.items) {
      if (!["spec-review", "spec-triage", "spec-repair", "spec-gate", "spec-gate-repair"].includes(item.node.id)) continue;
      const previous = queryActivityDetails(earlier.response, item.activity.id);
      const current = queryActivityDetails(this.response, item.activity.id);
      assert.deepEqual(current.item.detailRefs, previous.item.detailRefs, `${this.label}: ${item.activity.id} retains its observation IDs`);
      assert.deepEqual(current.item.detailCoverage, previous.item.detailCoverage);
      for (const group of GROUPS) assert.deepEqual(current.entities[group].map(queryHistoricalEntitySemantics),
        previous.entities[group].map(queryHistoricalEntitySemantics), `${this.label}: ${item.activity.id} retains its original verdict, findings and audit`);
    }
  }
}

function gateProvider(scenario) {
  return (_prompt, options) => {
    const spec = readSpec(scenario, "spec-gate");
    const fail = spec.requirements.find((entry) => entry.id === "R1").desc !== REQUIREMENT;
    const shape = options.jsonSchema.properties.observations.items.properties;
    const evidenceIds = shape.requirementId?.enum ?? [];
    const sourceRefs = shape.sourceRef?.enum ?? [];
    if (evidenceIds.length > 0) return JSON.stringify({ observations: evidenceIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({
      requirementId, sourceRef, support: [], contradictions: fail && requirementId === GUARDRAIL ? [GATE_FINDING] : [], unresolved: [],
    }))) });
    const target = { entity: "requirement", id: "R1", field: "desc" };
    return JSON.stringify({ observations: fail && shape.requirementRef.enum.includes(GUARDRAIL) ? [{
      failureMode: "guardrail-violation", requirementRef: GUARDRAIL,
      where: { file: "spec.json", locator: "requirements.R1.desc" }, observed: GATE_FINDING,
      targets: [target], allowedTargets: [{ target, operationKinds: ["edit-text-field"] }],
    }] : [], ...(options.jsonSchema.required?.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
  };
}

test("production Review and Gate findings, repairs and rechecks remain readable at their original Activities after later publications", async (t) => {
  const scenario = new QueryDraftReviewScenario(t, "818-query-activity-history");
  const checkpoints = [];
  await scenario.draft();
  await scenario.review("draft-questions");
  await scenario.refine();
  await scenario.review("draft-coverage");
  await scenario.gate();
  const document = validWorkerHandoffTaskSpec();
  document.requirements[0].desc = ORIGINAL_REQUIREMENT;
  document.constraints.push(PRIVATE_CONTEXT);
  document.tasks[0].test_strategy = "Verify the recorded behavioral result and retained history.";
  await scenario.spec(document);
  await scenario.specReview([REVIEW_FINDING]);
  const firstPublication = reviewPublication(scenario);
  const firstTerminal = terminal(scenario, "spec-review-rejected");
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "first rejected Review"));

  const target = { entity: "spec", field: "background" };
  assert.equal((await scenario.specWorker("spec-triage", { findings: [{ findingId: REVIEW_FINDING.findingId,
    disposition: "apply", evidence: "The saved background owns the repair boundary.", allowedTargets: [{ target, operationKinds: ["replace-field"] }] }] })).kind,
  "spec-triage-completed");
  const triage = terminal(scenario, "spec-triage-completed");
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "saved Triage permission"));
  const beforeRepair = readSpec(scenario, "spec-repair");
  const targets = specRepairTargetEntries(beforeRepair);
  const background = targets.find((entry) => entry.target.toJSON().entity === "spec" && entry.target.toJSON().field === "background");
  const goal = targets.find((entry) => entry.target.toJSON().entity === "spec" && entry.target.toJSON().field === "goal");
  const acceptedReason = "Apply the Review permission to the background boundary.";
  assert.equal((await scenario.specWorker("spec-repair", { operations: [
    { findingIds: [REVIEW_FINDING.findingId], kind: "replace-field", target, expectedDigest: background.digest,
      replacement: BACKGROUND, reason: acceptedReason },
    { findingIds: [REVIEW_FINDING.findingId], kind: "replace-field", target: { entity: "spec", field: "goal" }, expectedDigest: goal.digest,
      replacement: "An unauthorized goal replacement must not be published.", reason: "This proposal lacks a saved permission." },
  ] })).kind, "spec-repair-changed");
  const ordinaryRepair = terminal(scenario, "spec-repair-changed");
  assert.equal(readSpec(scenario, "spec-gate").background, BACKGROUND);
  assert.equal(readSpec(scenario, "spec-gate").goal, beforeRepair.goal);
  assert.equal(scenario.manager.canonicalState(scenario.specId).nextAction().nodeId, "spec-gate");
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "accepted and discarded ordinary Repair"));

  fs.writeFileSync(path.join(scenario.root, ".sennel", "guardrail.json"), workerArtifactJson({ guardrails: [{
    id: GUARDRAIL, title: "Recorded checks", body: "The requirement states the retained history of its checks.",
    meta: { phase: ["spec"], category: "requirements" },
  }] }));
  const respond = gateProvider(scenario);
  await scenario.specGate({ respond, expectedResult: "fail" });
  const failedGate = terminal(scenario, "spec-gate-repair-required");
  assert.equal(scenario.manager.canonicalState(scenario.specId).current.at(-1), "spec-gate-repair");
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "failed Gate with a bounded finding"));
  const originalRequirement = readSpec(scenario, "spec-gate-repair").requirements.find((entry) => entry.id === "R1").desc;
  assert.equal(originalRequirement, ORIGINAL_REQUIREMENT);
  const endByte = Buffer.byteLength(originalRequirement, "utf8");
  assert.notEqual(endByte, originalRequirement.length, "the worker's UTF-8 byte offset differs from its character offset");
  const expectedEdits = [
    { startByte: 0, endByte: 0, replacement: REQUIREMENT_PREFIX },
    { startByte: endByte, endByte, replacement: REQUIREMENT_SUFFIX },
  ];
  const gateRepair = await scenario.specGateRepair(REQUIREMENT, { edits: expectedEdits });
  assert.equal(gateRepair.result.kind, "spec-gate-repair-review-required");
  const gateRepairActivity = terminal(scenario, "spec-gate-repair-review-required");
  assert.equal(readSpec(scenario, "spec-review").requirements.find((entry) => entry.id === "R1").desc, REQUIREMENT);
  assert.equal(readSpec(scenario, "spec-review").background, BACKGROUND);
  assert.equal(scenario.manager.canonicalState(scenario.specId).nextAction().nodeId, "spec-review");
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "bounded Gate Repair requires a new Review"));

  scenario.manager.beginNextAction(scenario.specId);
  await scenario.specReview([]);
  const secondPublication = reviewPublication(scenario);
  const secondTerminal = terminal(scenario, "spec-review-passed");
  assert.notEqual(secondPublication.attemptId, firstPublication.attemptId);
  assert.notEqual(secondPublication.reviewPublication.identity.digest, firstPublication.reviewPublication.identity.digest);
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "passed Review of the changed revision"));
  assert.equal((await scenario.specWorker("spec-triage")).kind, "spec-triage-completed");
  assert.equal((await scenario.specWorker("spec-repair")).kind, "spec-repair-unchanged");
  const noOpRepair = terminal(scenario, "spec-repair-unchanged");
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "no-op Repair of the passed Review"));
  await scenario.specGate({ respond, expectedResult: "pass" });
  const passedGate = terminal(scenario, "spec-gate-passed");
  assert.notEqual(passedGate.attemptId, failedGate.attemptId);
  checkpoints.push(await HistoryCheckpoint.capture(scenario, "passed Gate after repair and Review"));

  // Producer/route assertions above run even while the historical query is
  // not implemented. Every refusal is retained and fails this success contract.
  const errors = checkpoints.filter((checkpoint) => checkpoint.metadataError !== null || checkpoint.activitiesError !== null)
    .map((checkpoint) => ({ checkpoint: checkpoint.label,
      metadata: errorDiagnostic(checkpoint.metadataError), activities: errorDiagnostic(checkpoint.activitiesError) }));
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
  for (let index = 0; index < checkpoints.length; index += 1) {
    checkpoints[index].assertComplete();
    for (const previous of checkpoints.slice(0, index)) checkpoints[index].assertRetains(previous);
  }
  const initial = checkpoints[0].response;
  const published = queryActivityDetails(initial, firstPublication.id);
  const completed = queryActivityDetails(initial, firstTerminal.id);
  assert.equal(published.entities.evaluations.length, 0);
  assert.equal(completed.entities.evaluations[0].result.nativeCode, "spec-review-rejected");
  assert.deepEqual(completed.entities.findings, published.entities.findings);
  assert.equal(published.entities.findings[0].description, REVIEW_FINDING.body);
  const canonicalPath = FLOW_ARTIFACT_CONTRACTS.resolve("spec.review", {
    revision: String(firstPublication.reviewPublication.identity.revision).padStart(3, "0"),
  }).relativePath;
  assert.equal(published.entities.findings[0].identity.sourceArtifact, canonicalPath);
  assert.match(published.entities.findings[0].source.relativePath, /\/activity-evidence\/[a-f0-9]{64}\.json$/);
  assert.equal(published.entities.findings[0].source.jsonPointer, "/review/findings/0");
  const permission = queryActivityDetails(checkpoints[1].response, triage.id).entities.findings[0].specific.triage;
  assert.equal(permission.disposition, "apply");
  assert.deepEqual(permission.allowedTargets, [{ target, operationKinds: ["replace-field"] }]);
  const repaired = queryActivityDetails(checkpoints[2].response, ordinaryRepair.id).entities.repairs[0];
  assert.equal(repaired.status.value, "applied");
  assert.deepEqual(repaired.items.map((item) => item.status.value), ["applied", "discarded"]);
  assert.equal(repaired.items[0].adoptedReason, acceptedReason);
  assert.equal(repaired.items[1].discardedReason, "unauthorized operation");
  assert.equal(repaired.items[0].target.field, "background");
  assert.equal(repaired.items[0].operationKind, "replace-field");
  const expectedReplacement = { replacement: BACKGROUND, edits: null };
  assert.deepEqual(repaired.items[0].change, expectedReplacement);
  assert.equal(repaired.items[1].change, null, "a discarded proposal is not a performed change");
  assert.equal(repaired.items[0].findingIds.length, 1);
  assert.ok(checkpoints[2].response.entities.findings.some((finding) => finding.id === repaired.items[0].findingIds[0]
    && finding.source.producerActivityId === triage.id), "ordinary Repair uses the exact Triage input observation");
  const failed = queryActivityDetails(checkpoints[3].response, failedGate.id);
  assert.equal(failed.entities.evaluations[0].result.nativeCode, "fail");
  assert.equal(failed.entities.findings[0].description, GATE_FINDING);
  const bounded = queryActivityDetails(checkpoints[4].response, gateRepairActivity.id).entities.repairs[0];
  assert.equal(bounded.status.value, "applied");
  assert.equal(bounded.items[0].target.field, "desc");
  assert.equal(bounded.items[0].operationKind, "edit-text-field");
  const expectedTextChange = { replacement: null, edits: expectedEdits };
  assert.deepEqual(bounded.items[0].change, expectedTextChange);
  assert.ok(bounded.findingIds.some((id) => checkpoints[4].response.entities.findings.some((finding) => finding.id === id
    && finding.description === GATE_FINDING && finding.source.producerActivityId === failedGate.id)),
  "Gate Repair resolves its original finding in the response closure");
  const rechecked = queryActivityDetails(checkpoints[5].response, secondTerminal.id);
  assert.equal(rechecked.entities.evaluations[0].result.nativeCode, "spec-review-passed");
  assert.deepEqual(rechecked.entities.findings, []);
  const noOp = queryActivityDetails(checkpoints[6].response, noOpRepair.id).entities.repairs[0];
  assert.equal(noOp.status.value, "skipped");
  assert.deepEqual(noOp.items, []);
  const final = checkpoints.at(-1).response;
  assert.equal(queryActivityDetails(final, passedGate.id).entities.evaluations[0].result.nativeCode, "pass");
  assert.deepEqual(queryActivityDetails(final, passedGate.id).entities.findings, []);
  for (const checkpoint of checkpoints.slice(5)) {
    const retainedReplacement = queryActivityDetails(checkpoint.response, ordinaryRepair.id).entities.repairs[0];
    const retainedTextChange = queryActivityDetails(checkpoint.response, gateRepairActivity.id).entities.repairs[0];
    assert.deepEqual(retainedReplacement.items[0].change, expectedReplacement, `${checkpoint.label}: retain the actual replacement`);
    assert.equal(retainedReplacement.items[1].change, null);
    assert.deepEqual(retainedTextChange.items[0].change, expectedTextChange, `${checkpoint.label}: retain both original byte edits`);
  }
  assert.equal(JSON.stringify(final.entities).includes(PRIVATE_CONTEXT), false);
  const beforeCLI = scenario.protectedState();
  const metadataResult = scenario.cli({ resource: "metadata", condition: { specId: scenario.specId } });
  assert.equal(metadataResult.status, 0, metadataResult.stdout || metadataResult.stderr);
  const consumer = new FlowQueryConsumer();
  const metadata = consumer.consumeSerialized(metadataResult.stdout);
  const result = scenario.cli({ resource: "activities", condition: { specId: scenario.specId }, page: { limit: 100, after: null } });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const actual = consumer.consumeSerialized(result.stdout);
  assert.equal(actual.snapshot.id, metadata.snapshot.id);
  assert.equal(actual.pageInfo.hasNext, false);
  assert.equal(actual.pageInfo.totalItems, beforeCLI.ledger.length);
  assert.equal(actual.pageInfo.returnedItems, beforeCLI.ledger.length);
  assert.deepEqual(actual.entities, final.entities);
  assert.deepEqual(queryActivityDetails(actual, ordinaryRepair.id).entities.repairs[0].items[0].change, expectedReplacement);
  assert.equal(queryActivityDetails(actual, ordinaryRepair.id).entities.repairs[0].items[1].change, null);
  assert.deepEqual(queryActivityDetails(actual, gateRepairActivity.id).entities.repairs[0].items[0].change, expectedTextChange);
  assert.equal(actual.completeness.details, "complete");
  scenario.reload();
  assert.deepEqual(scenario.protectedState(), beforeCLI);
});
