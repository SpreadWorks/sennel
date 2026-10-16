import assert from "node:assert/strict";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord } from "../../../src/lib/flow-artifact-contract.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import { settleDraftStepResult } from "../../../src/flow/definition.js";
import { DraftQuestionsRepairUnchangedResult } from "../../../src/flow/engine/step-result.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { AwaitingUserAnswer } from "../../../src/flow/lib/draft-question-ledger.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalFlowRuntime } from "../../../src/flow/lib/canonical-flow-runtime.js";
import { attachedCanonicalCommandResultArtifact, attachedCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { commandResultPayload } from "../../../src/flow/lib/canonical-step-settlement-publication.js";
import { TaskGateClassificationRecoveryIdentity } from "../../../src/flow/lib/task-gate-classification-recovery.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { createExecutionQueryScenario } from "../../support/infrastructure/execution-query-scenario.js";
import { CanonicalFlowFixture, FlowAtStepFixture, TaskLifecycleFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { prepareDraftService } from "../../support/infrastructure/draft-service.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function scenarioRoot(t) {
  const root = createTmpDir("query-attempt-lifecycle-");
  t.after(() => removeTmpDir(root));
  return root;
}

function reload(root) { return new FlowManager({ root, mainRoot: root, inWorktree: false }); }

async function readAttempts(root, specId) {
  const request = new QueryRequest({ resource: "executions", condition: { specId }, page: { limit: 100, after: null } });
  const captured = await new CanonicalFlowVersionReader({ repositoryRoot: root }).read(request.specId, request.flowVersion, request);
  if (captured.version.projectionError) throw captured.version.projectionError;
  const response = captured.version.response;
  assert.equal(response.pageInfo.hasNext, false, "the fixture's complete execution history fits in one page");
  return new Map(response.items.filter((item) => item.kind === "step-attempt").map((item) => [item.attemptId, item]));
}

function assertConfirmation(item, activity) {
  assert.equal(item.resultConfirmedAt, activity.result.confirmedAt);
  assert.deepEqual(item.resultRef, { kind: "activity", id: activity.id });
}

test("a claimed intermediate Result stays confirmed while the Attempt remains unfinished across park and reload", async (t) => {
  const scenario = await createExecutionQueryScenario(t);
  await scenario.shutdown();
  const manager = scenario.reload();
  const attempt = manager.canonicalState(scenario.specId).attempt;
  const confirmed = manager.activityLedger(scenario.specId).filter((entry) => entry.attemptId === attempt.id && entry.result !== null).at(-1);
  assert.equal(confirmed.result.draftSettlementReceipt.executionLifecycle.phase, "claimed");
  assert.equal(confirmed.result.stepResult.kind, "draft-refine-worker-required");
  for (const [index, lifecycle] of ["active", "parked", "active"].entries()) {
    const state = scenario.reload().canonicalState(scenario.specId);
    assert.equal(state.lifecycle.state, lifecycle);
    assert.equal(state.attempt.id, attempt.id);
    const item = (await readAttempts(scenario.root, scenario.specId)).get(attempt.id);
    assert.equal(item.startedAt, attempt.startedAt);
    assert.equal(item.timing.startedAt, attempt.startedAt);
    assertConfirmation(item, confirmed);
    assert.equal(item.timing.finishedAt, null);
    assert.equal(item.timing.durationMs, null);
    if (index === 0) manager.parkFlow(scenario.specId);
    if (index === 1) manager.resumeFlow(scenario.specId);
  }
});

test("a durable Await Result keeps its confirmation and does not finish its retained Attempt", async (t) => {
  const root = scenarioRoot(t);
  const specId = "001-attempt-await";
  const manager = reload(root);
  const flow = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-attempt-await" }).create().activate("draft");
  const draft = canonicalDraftDocument({ questions: [new AwaitingUserAnswer({
    id: "q1", question: "Which behavior should be visible?", revision: 0,
    category: "user-visible-behavior", provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
  }).toJSON()] });
  manager.publishArtifacts({ specId, nodeId: "draft", artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(draft)}\n`),
  }] });
  flow.settle("draft").activate("draft-refine");
  const attempt = manager.canonicalState(specId).attempt;
  const binding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-refine" });
  await new DraftRefineStep(await prepareDraftService({ flowManager: manager, binding })).execute();
  const restored = reload(root);
  const confirmed = restored.activityLedger(specId).filter((entry) => entry.attemptId === attempt.id && entry.result !== null).at(-1);
  assert.equal(confirmed.result.draftSettlementReceipt.settlementKind, "await");
  assert.equal(restored.canonicalState(specId).attempt.id, attempt.id);
  const item = (await readAttempts(root, specId)).get(attempt.id);
  assertConfirmation(item, confirmed);
  assert.equal(item.timing.finishedAt, null);
});

test("a terminal connection finishes its exact Attempt and reopening the node starts a separate unfinished Attempt", async (t) => {
  const root = scenarioRoot(t);
  const specId = "001-attempt-completion";
  const manager = reload(root);
  new FlowAtStepFixture({ flowManager: manager, specId, runId: "run-attempt-completion", targetStep: "draft-questions-repair" }).create();
  const before = manager.canonicalState(specId);
  const result = new DraftQuestionsRepairUnchangedResult();
  manager.settleDraftStepResult({
    binding: { runId: before.runId, specId, stepId: result.stepId, attempt: before.attempt },
    stepResult: result, settlement: settleDraftStepResult(result.stepId, result),
  });
  const confirmed = manager.activityLedger(specId).filter((entry) => entry.attemptId === before.attempt.id && entry.result !== null).at(-1);
  assert.equal(confirmed.result.draftSettlementReceipt.settlementKind, "target-connection");
  let item = (await readAttempts(root, specId)).get(before.attempt.id);
  assertConfirmation(item, confirmed);
  assert.equal(item.timing.finishedAt, confirmed.result.confirmedAt);
  manager.rewindTo("draft-questions-repair", { specId });
  const reopened = reload(root).canonicalState(specId).attempt;
  assert.notEqual(reopened.id, before.attempt.id);
  assert.equal(reopened.nodeId, before.attempt.nodeId);
  const attempts = await readAttempts(root, specId);
  item = attempts.get(before.attempt.id);
  assertConfirmation(item, confirmed);
  assert.equal(item.timing.finishedAt, confirmed.result.confirmedAt);
  assert.equal(attempts.get(reopened.id).timing.finishedAt, null);
  assert.equal(attempts.get(reopened.id).resultConfirmedAt, null);
});

test("a safe failed Attempt keeps its saved finish through refusal and a new retry after reload", async (t) => {
  const root = scenarioRoot(t);
  const specId = "001-attempt-retry";
  const manager = reload(root);
  new FlowAtStepFixture({ flowManager: manager, specId, runId: "run-attempt-retry", targetStep: "spec-review" }).create();
  const attempt = manager.canonicalState(specId).attempt;
  manager.failCurrentAttempt({ specId, failure: {
    category: "provider", code: "REVIEW_PROVIDER_UNAVAILABLE", message: "Provider is temporarily unavailable.", retryable: true, retryKind: "tooling",
  } });
  const failed = manager.activityLedger(specId).filter((entry) => entry.attemptId === attempt.id && entry.result !== null).at(-1);
  let item = (await readAttempts(root, specId)).get(attempt.id);
  assertConfirmation(item, failed);
  assert.equal(item.timing.finishedAt, failed.result.confirmedAt);
  const restored = reload(root);
  restored.retryCurrentAttempt({ specId });
  const retried = reload(root).canonicalState(specId);
  assert.notEqual(retried.attempt.id, attempt.id);
  assert.equal(retried.attempt.sequence, attempt.sequence + 1);
  const beforeRefusal = retried.toJSON();
  assert.throws(() => restored.retryCurrentAttempt({ specId }), /failed active Attempt/);
  assert.deepEqual(reload(root).canonicalState(specId).toJSON(), beforeRefusal);
  const attempts = await readAttempts(root, specId);
  item = attempts.get(attempt.id);
  assertConfirmation(item, failed);
  assert.equal(item.timing.finishedAt, failed.result.confirmedAt);
  assert.equal(attempts.get(retried.attempt.id).timing.finishedAt, null);
  assert.equal(attempts.get(retried.attempt.id).resultConfirmedAt, null);
});

test("canonical recovery of a historical same-identity Attempt clears its finish while retaining the failure Result", async (t) => {
  const root = scenarioRoot(t);
  const specId = "001-attempt-same-identity-recovery";
  const manager = reload(root);
  new TaskLifecycleFixture({ flowManager: manager, specId, runId: "run-attempt-same-identity-recovery",
    taskDocuments: [{ id: "T-1", title: "Task", goal: "Resume the saved Task Gate.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
    taskId: "T-1", targetStep: "task-gate",
  }).create();
  const attempt = manager.canonicalState(specId).attempt;
  const sourceFingerprint = captureCurrentTaskSource({ root, flowManager: manager, state: manager.loadReadOnly(specId), taskId: "T-1" }).fingerprint;
  const result = new CanonicalGatePromotion({ state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1" })
    .promote({ result: "fail", artifacts: { failureKind: "ai_semantic_fail", failureCode: "TASK_GATE_REJECTED", sourceFingerprint,
      nextAction: { diagnosis: { observations: [] } } } });
  // Current implementation Steps publish atomically with their Result. Rebuild
  // the supported retained pre-terminal publication through the canonical
  // runtime writer and shared history formatter, as historical recovery input.
  const artifact = attachedCanonicalCommandResultArtifact(result);
  const history = new FlowArtifactAttemptHistory().append(new FlowArtifactAttemptRecord({
    attempt: attempt.sequence, payload: commandResultPayload(result, attempt.nodeId, artifact.logicalKey),
  }));
  new CanonicalFlowRuntime({ repositoryRoot: root, definition: manager.canonicalState(specId).definition }).publishArtifacts({
    specId, activityId: "historical-task-gate-publication", nodeId: attempt.nodeId, expectedAttempt: attempt,
    artifactWrites: [{ logicalKey: artifact.logicalKey, parameters: { taskId: "T-1" }, mediaType: "application/json", bytes: history.toBytes() },
      ...attachedCanonicalCommandResultPublications(result).map((publication) => ({
        logicalKey: publication.logicalKey, parameters: publication.parameters, mediaType: publication.mediaType,
        bytes: Buffer.from(`${JSON.stringify(publication.payload)}\n`),
      }))],
  });
  manager.failCurrentAttempt({ specId, failure: {
    category: "tooling", code: "POST_HOOK_FAILED", message: "Settlement stopped after publication.", retryable: false, retryKind: null,
  } });
  const failed = manager.activityLedger(specId).filter((entry) => entry.attemptId === attempt.id && entry.result !== null).at(-1);
  assert.equal((await readAttempts(root, specId)).get(attempt.id).timing.finishedAt, failed.result.confirmedAt);
  const restored = reload(root).canonicalState(specId);
  const recovery = new TaskGateClassificationRecoveryIdentity({ publicationActivityId: "historical-task-gate-publication",
    failedActivityId: failed.id, attempt: restored.attempt });
  // Exercise the retained recovery reducer's exact historical guards. Current
  // Step admission additionally requires today's Review/budget publications.
  new CanonicalFlowRuntime({ repositoryRoot: root, definition: restored.definition }).recoverTaskGateClassification({
    specId, activityId: recovery.activityId, attempt: restored.attempt.replaceFacts({ failure: null }),
  });
  const recovered = reload(root).canonicalState(specId);
  assert.equal(recovered.attempt.id, attempt.id);
  assert.equal(recovered.attempt.sequence, attempt.sequence);
  assert.equal(recovered.attempt.failure, null);
  const item = (await readAttempts(root, specId)).get(attempt.id);
  assertConfirmation(item, failed);
  assert.equal(item.timing.startedAt, attempt.startedAt);
  assert.equal(item.timing.finishedAt, null);
});
