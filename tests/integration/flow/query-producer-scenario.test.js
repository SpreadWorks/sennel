import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowVersionReader, Cursor, QueryRequest } from "../../../src/flow/query.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { SpecGateIssuePublication } from "../../../src/flow/lib/gate-issue-publication.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { specRepairTargetEntries } from "../../../src/flow/lib/spec-repair-operations.js";
import { validWorkerHandoffSpec, validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { fixtureRepository, installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { CanonicalFlowFixture, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { SpecStepPreparationFixture } from "../../support/infrastructure/spec-step-preparation.js";
import { FlowQueryConsumer } from "../../support/builders/flow-query-consumer.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function managerAt(root, specId) {
  return new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
}

async function consumeFrom(root, specId, firstActivity, { details = "complete", limit = 100, hasNext = false } = {}) {
  const reader = new CanonicalFlowVersionReader({ repositoryRoot: root });
  const metadataRequest = new QueryRequest({ resource: "metadata", condition: { specId } });
  const metadata = await reader.read(specId, 1, metadataRequest);
  assert.equal(metadata.version.projectionError, null);
  const consumer = new FlowQueryConsumer();
  const consumedMetadata = consumer.consumeSerialized(JSON.stringify(metadata.version.response));
  const input = { resource: "activities", condition: { specId }, page: { limit, after: null } };
  if (firstActivity.confirmationOrder > 1) input.page.after = new Cursor({
    request: new QueryRequest(input), order: firstActivity.confirmationOrder - 1,
    snapshotId: consumedMetadata.snapshot.id,
  }).encode();
  const captured = await reader.read(specId, 1, new QueryRequest(input));
  assert.equal(captured.version.projectionError, null);
  const response = captured.version.response;
  const consumed = consumer.consumeSerialized(JSON.stringify(response));
  assert.equal(consumed.snapshot.id, consumedMetadata.snapshot.id);
  assert.equal(consumed.completeness.details, details);
  assert.equal(consumed.completeness.enumeration, "complete");
  assert.equal(consumed.completeness.sourceHistory, "complete");
  assert.equal(consumed.pageInfo.hasNext, hasNext);
  assert.equal(consumed.pageInfo.returnedItems, consumed.items.length);
  return { consumed, metadata: consumedMetadata };
}

function detailFor(consumed, activityId, group) {
  const item = consumed.items.find((entry) => entry.activity.id === activityId);
  assert.ok(item, `saved Activity ${activityId} must be returned`);
  assert.equal(item.detailCoverage[group].availability, "available");
  assert.equal(item.detailCoverage[group].count, item.detailRefs[group].length);
  return item.detailRefs[group].map((id) => {
    const entity = consumed.entities[group].find((entry) => entry.id === id);
    assert.ok(entity, `detail ${id} must be in the response closure`);
    return entity;
  });
}

async function publishReview(ctx, findings) {
  const command = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
      const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
      const delta = new SpecReviewDelta({ version: 2, stage: "spec-review", identity: review.identity.toJSON(),
        baseReviewDigest: review.digest, findings, operations: [] });
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"), `${JSON.stringify(delta.toJSON())}\n`);
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
  const result = await command.execute({ ...ctx, phase: "spec", flowState: ctx.flowManager.loadReadOnly(ctx.specId), config: {} });
  assert.notEqual(result.ok, false, JSON.stringify(result));
  await FLOW_COMMANDS.run.review.post(ctx, result);
  return result;
}

async function executeReviewWorker(ctx, stepId, { findings = [], operations = [] } = {}) {
  const coordinator = new WorkerArtifactHandoffCoordinator({ now: () => new Date("2026-08-04T00:00:00.000Z") });
  const request = coordinator.createRequest({ ctx, state: ctx.flowManager.loadReadOnly(ctx.specId),
    invocation: { id: `dispatch-${stepId}`, target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: stepId } } } });
  const review = new CanonicalSpecReview(request.inputs.find((entry) => entry.name === "review.json").document);
  fs.writeFileSync(request.payloadPath("review.delta.json"), workerArtifactJson({ version: 2, stage: stepId,
    identity: review.identity.toJSON(), baseReviewDigest: review.digest, findings, operations }));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z") });
  const prepared = await specStepRegistration(stepId).create({ ctx, request, Connector: SpecEntryConnector,
    handoffCoordinator: coordinator });
  return prepared.step.execute();
}

test("production Spec Review terminal verdict survives reload with its retained publication and finding closure", async (t) => {
  const root = createTmpDir("query-review-producer-");
  t.after(() => removeTmpDir(root));
  setupFlowConfig(root, "en");
  const specId = "801-query-review-producer";
  let manager = managerAt(root, specId);
  let flow = new CanonicalFlowFixture({ flowManager: manager, specId }).create().registerActive().activate("spec-review");
  const finding = { kind: "blocking", findingId: "F-retained-verdict", title: "Retained verdict", target: "goal",
    body: "The stored blocking review body.", issue: "Behavior is missing", requiredChange: "Specify the behavior", whyBlocking: "The required behavior is undefined" };
  const commandResult = await publishReview({ root, executionRoot: root, mainRoot: root, specId, flowManager: manager }, [finding]);
  assert.equal(commandResult.artifacts.verdict, "REJECTED");
  manager = null;
  flow = null;
  const reloaded = managerAt(root, specId);
  const ledger = reloaded.activityLedger(specId);
  const publication = ledger.find((entry) => entry.reviewPublication?.stage === "spec-review");
  const terminal = ledger.findLast((entry) => entry.result?.stepResult?.kind === "spec-review-rejected");
  assert.ok(publication);
  assert.ok(terminal);
  assert.equal(publication.result.stepResult.kind, "spec-review-execution-required");
  assert.notEqual(publication.id, terminal.id);
  assert.equal(terminal.attemptId, publication.attemptId);
  assert.equal(terminal.sequence, publication.sequence);
  const { consumed } = await consumeFrom(root, specId, terminal);
  const [evaluation] = detailFor(consumed, terminal.id, "evaluations");
  const [observed] = detailFor(consumed, terminal.id, "findings");
  assert.deepEqual(evaluation.result, { outcome: "failed", nativeCode: terminal.result.stepResult.kind });
  assert.equal(evaluation.source.producerActivityId, terminal.id);
  assert.equal(evaluation.source.format, "jsonl");
  assert.equal(evaluation.supportingSources[0].producerActivityId, publication.id);
  assert.deepEqual(evaluation.findingIds, [observed.id]);
  assert.equal(observed.source.producerActivityId, publication.id);
  assert.equal(observed.description, finding.body);
  assert.equal(observed.identity.sourceFindingId, finding.findingId);
  assert.equal(consumed.items.some((entry) => entry.activity.id === publication.id), false);
  const earlierPage = (await consumeFrom(root, specId, publication)).consumed;
  const publicationItem = earlierPage.items.find((entry) => entry.activity.id === publication.id);
  assert.equal(publicationItem.detailCoverage.evaluations.availability, "not-applicable");
  assert.deepEqual(publicationItem.detailRefs.evaluations, []);
  assert.deepEqual(publicationItem.detailRefs.findings, [observed.id]);
  assert.deepEqual(earlierPage.entities.findings.find((entry) => entry.id === observed.id), observed);
  const executionStages = ledger.filter((entry) => entry.nodeId === "spec-review"
    && entry.result?.stepResult?.kind === "spec-review-execution-required");
  assert.deepEqual(executionStages.map((entry) => entry.result.draftSettlementReceipt.executionLifecycle.phase),
    ["checkpoint", "claimed", "publication"]);
  for (const entry of executionStages) {
    assert.equal(entry.attemptId, terminal.attemptId);
    assert.equal(entry.sequence, terminal.sequence);
    assert.equal(entry.result.draftSettlementReceipt.binding.attemptId, terminal.attemptId);
    assert.equal(entry.result.draftSettlementReceipt.binding.attemptSequence, terminal.sequence);
  }
  const firstReviewActivity = ledger.find((entry) => entry.nodeId === "spec-review");
  const timeline = (await consumeFrom(root, specId, firstReviewActivity)).consumed;
  assert.deepEqual(timeline.entities.findings.find((entry) => entry.id === observed.id), observed);
  for (const entry of executionStages.slice(0, 2)) {
    const item = timeline.items.find((candidate) => candidate.activity.id === entry.id);
    assert.ok(item);
    for (const group of ["evaluations", "findings", "repairs"]) {
      assert.deepEqual(item.detailRefs[group], []);
      assert.deepEqual(item.detailCoverage[group], { availability: "not-applicable", reason: "NOT_APPLICABLE", count: 0 });
    }
  }
  assert.deepEqual(detailFor(timeline, terminal.id, "evaluations"), [evaluation]);
});

for (const stepId of ["spec-repair", "spec-gate"]) {
  test(`production ${stepId} publication survives reload and the semantic query consumer`, async (t) => {
    const root = createTmpDir(`query-${stepId}-producer-`);
    t.after(() => removeTmpDir(root));
    let fixture = new SpecStepPreparationFixture(root);
    t.after(() => fixture?.dispose());
    let preparation = await fixture.createInput(stepId);
    let manager = preparation.input.flowManager ?? preparation.input.ctx.flowManager;
    const specId = manager.canonicalState().specId;
    const repository = preparation.input.ctx?.root ?? path.join(root, stepId);
    let prepared = await specStepRegistration(stepId).create(preparation.input);
    const result = await prepared.step.execute();
    assert.equal(result.kind, stepId === "spec-repair" ? "spec-repair-unchanged" : "spec-gate-passed");
    prepared = null;
    preparation = null;
    fixture.dispose();
    fixture = null;
    manager = null;
    const reloaded = managerAt(repository, specId);
    const owner = reloaded.activityLedger(specId).findLast((entry) => entry.result?.stepResult?.kind === result.kind);
    assert.ok(owner);
    const { consumed, metadata } = await consumeFrom(repository, specId, owner);
    if (stepId === "spec-repair") {
      const review = reloaded.readCurrentSpecReview({ specId, consumerNodeId: "spec-gate" }).review;
      const audit = review.audit.at(-1);
      assert.equal(Object.hasOwn(audit, "activityId"), false);
      assert.equal(audit.outcome, "no-op");
      const [repair] = detailFor(consumed, owner.id, "repairs");
      assert.deepEqual(repair.status, { value: "skipped", availability: "available", reason: null, nativeValue: audit.outcome });
      assert.deepEqual(repair.items, []);
      assert.equal(repair.source.producerActivityId, owner.id);
      assert.equal(metadata.item.artifacts.find((entry) => entry.relativePath === repair.source.relativePath).producerActivityId, owner.id);
    } else {
      const artifact = reloaded.readArtifact({ specId, logicalKey: "spec.gate", consumerNodeId: "approval" });
      const stored = JSON.parse(artifact.bytes).attempts[0].artifact.payload;
      assert.equal(stored.artifacts.gateTransitionAttemptId, owner.attemptId);
      assert.equal(stored.artifacts.gateTransitionAttemptSequence, owner.sequence);
      assert.match(stored.artifacts.gateTransitionLineage, /^[a-f0-9]{64}$/);
      const [evaluation] = detailFor(consumed, owner.id, "evaluations");
      assert.deepEqual(evaluation.result, { outcome: "passed", nativeCode: stored.result });
      assert.equal(evaluation.specific.phase, stored.artifacts.phase);
      assert.equal(evaluation.specific.taskId, stored.artifacts.taskId ?? null);
      assert.equal(evaluation.specific.sourceFingerprint, stored.artifacts.sourceFingerprint ?? null);
      assert.equal(evaluation.specific.failureCategory, stored.artifacts.gateTransitionFailureCategory ?? null);
      assert.equal(evaluation.specific.evaluationScope, stored.artifacts.evaluationScope ?? null);
      assert.equal(evaluation.specific.warnings, stored.artifacts.warnings ?? null);
      assert.deepEqual(evaluation.criteria, []);
      assert.equal(evaluation.source.producerActivityId, owner.id);
      assert.equal(evaluation.source.jsonPointer, "/attempts/0/artifact/payload");
    }
  });
}

test("production Spec Repair preserves accepted and discarded operation meaning across reload", async (t) => {
  const root = createTmpDir("query-repair-operations-producer-");
  t.after(() => removeTmpDir(root));
  setupFlowConfig(root, "en");
  const specId = "802-query-repair-operations";
  let manager = managerAt(root, specId);
  let flow = new CanonicalFlowFixture({ flowManager: manager, specId, specRecord: validWorkerHandoffSpec() })
    .create().addTasks(validWorkerHandoffTaskSpec().tasks.map((entry) => ({ ...entry,
      test_strategy: "Check the bounded canonical publication." }))).registerActive().activate("spec-review");
  let ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager: manager };
  const findingId = "F-bounded-repair";
  await publishReview(ctx, [{ kind: "blocking", findingId, title: "Repair background", target: "background",
    body: "The saved background needs clarification.", issue: "The rationale is missing", requiredChange: "Clarify the background", whyBlocking: "The scope needs a rationale" }]);
  const target = { entity: "spec", field: "background" };
  flow.activate("spec-triage", { settlePredecessors: false });
  assert.equal((await executeReviewWorker(ctx, "spec-triage", { findings: [{ findingId, disposition: "apply",
    evidence: "The background owns the rationale.", allowedTargets: [{ target, operationKinds: ["replace-field"] }] }] })).kind,
  "spec-triage-completed");
  const storedSpec = JSON.parse(manager.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-repair" }).bytes);
  const targets = specRepairTargetEntries(storedSpec);
  const operations = [
    { findingIds: [findingId], kind: "replace-field", target, expectedDigest: targets.find((entry) => entry.target.toJSON().field === "background").digest,
      replacement: "The corrected background explains the bounded scope.", reason: "The saved permission allows this correction." },
    { findingIds: [findingId], kind: "replace-field", target: { entity: "spec", field: "goal" },
      expectedDigest: targets.find((entry) => entry.target.toJSON().field === "goal").digest, replacement: "Private unauthorized goal replacement",
      reason: "This proposal lacks a saved permission." },
  ];
  operations.push(structuredClone(operations[1]));
  flow.activate("spec-repair", { settlePredecessors: false });
  const repairResult = await executeReviewWorker(ctx, "spec-repair", { operations });
  assert.equal(repairResult.kind, "spec-repair-changed", JSON.stringify(manager.readCurrentSpecReview({ specId, consumerNodeId: "spec-gate" }).review.audit.at(-1)));
  manager = null;
  flow = null;
  ctx = null;
  const reloaded = managerAt(root, specId);
  const owner = reloaded.activityLedger(specId).findLast((entry) => entry.result?.stepResult?.kind === "spec-repair-changed");
  const review = reloaded.readCurrentSpecReview({ specId, consumerNodeId: "spec-gate" }).review;
  const audit = review.audit.at(-1);
  assert.equal(Object.hasOwn(audit, "activityId"), false);
  assert.equal(audit.acceptedOperations.length, 1);
  assert.equal(audit.discardedOperations.length, 2);
  assert.equal(audit.discardedOperations[0].reason, "unauthorized operation");
  const repairedSpec = JSON.parse(reloaded.readArtifact({ specId, logicalKey: "spec.record", consumerNodeId: "spec-gate" }).bytes);
  assert.equal(repairedSpec.background, operations[0].replacement);
  assert.equal(repairedSpec.goal, storedSpec.goal);
  const { consumed } = await consumeFrom(root, specId, owner);
  const [repair] = detailFor(consumed, owner.id, "repairs");
  assert.equal(repair.status.value, "applied");
  assert.deepEqual(repair.items.map((item) => item.status.value), ["applied", "discarded", "discarded"]);
  assert.equal(new Set(repair.items.map((item) => item.id)).size, repair.items.length);
  assert.equal(repair.items[0].target.field, target.field);
  assert.equal(repair.items[0].adoptedReason, operations[0].reason);
  assert.equal(repair.items[1].discardedReason, audit.discardedOperations[0].reason);
  assert.equal(repair.items[2].discardedReason, audit.discardedOperations[1].reason);
  assert.deepEqual(repair.items[1].status, repair.items[2].status);
  assert.deepEqual(repair.items[1].target, repair.items[2].target);
  assert.equal(repair.source.producerActivityId, owner.id);
  assert.equal(repair.findingIds.length, 1);
  assert.ok(consumed.entities.findings.some((entry) => entry.id === repair.findingIds[0]
    && entry.identity.sourceFindingId === findingId));
  assert.equal(JSON.stringify(consumed.entities).includes(operations[1].replacement), false);
  const reread = await consumeFrom(root, specId, owner);
  assert.deepEqual(detailFor(reread.consumed, owner.id, "repairs"), [repair]);
});

test("RunGateCommand persists mechanical coverage authority and evaluation scope for the query consumer", async (t) => {
  const root = fixtureRepository("query-gate-command-producer-");
  t.after(() => removeTmpDir(root));
  setupFlowConfig(root, "en");
  fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({ guardrails: [{
    id: "spec-test-coverage", title: "Spec Test Coverage", body: "Tests cover testable requirements.",
    meta: { phase: ["spec"], category: "testing" },
  }] }));
  const specId = "803-query-gate-command";
  let manager = managerAt(root, specId);
  let flow = new CanonicalFlowFixture({ flowManager: manager, specId, specRecord: validWorkerHandoffSpec() })
    .create().addTasks(validWorkerHandoffTaskSpec().tasks.map((entry) => ({ ...entry,
      test_strategy: "Check the canonical Gate result." }))).registerActive().activate("spec-gate");
  let ctx = { root, mainRoot: root, executionRoot: root, specId, phase: "spec", config: {},
    flowManager: manager, flowState: manager.loadReadOnly(specId) };
  const semanticGuardrailIds = [];
  const provider = installGateProviderFake((_prompt, options) => {
    if (!(options.jsonSchema?.required ?? []).includes("evaluations")) return JSON.stringify({ observations: [],
      ...((options.jsonSchema?.required ?? []).includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}) });
    const ids = options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum;
    semanticGuardrailIds.push(...ids);
    return JSON.stringify({ evaluations: ids.map((guardrail_id) => ({ guardrail_id, result: "pass", reason: "The recorded requirement is explicit." })) });
  });
  t.after(() => provider.mock.restore());
  const result = await new RunGateCommand().execute(ctx);
  assert.equal(result.result, "pass", JSON.stringify(result));
  assert.equal(semanticGuardrailIds.includes("spec-test-coverage"), false);
  await FLOW_COMMANDS.run.gate.post(ctx, result);
  manager = null;
  flow = null;
  ctx = null;
  const reloaded = managerAt(root, specId);
  const artifact = reloaded.readArtifact({ specId, logicalKey: "spec.gate", consumerNodeId: "approval" });
  const stored = JSON.parse(artifact.bytes).attempts[0].artifact.payload;
  const owner = reloaded.activityLedger(specId).find((entry) => entry.id === artifact.descriptor.activityId);
  assert.equal(owner.result.stepResult.kind, "spec-gate-passed");
  const mechanical = stored.artifacts.evaluations.find((entry) => entry.guardrail_id === "spec-test-coverage");
  assert.ok(mechanical);
  assert.equal(mechanical.authority, "mechanical");
  assert.equal(stored.artifacts.evaluationScope.phase, "spec");
  const { consumed } = await consumeFrom(root, specId, owner);
  const [evaluation] = detailFor(consumed, owner.id, "evaluations");
  assert.deepEqual(evaluation.specific.evaluationScope, stored.artifacts.evaluationScope);
  assert.equal(evaluation.specific.warnings, stored.artifacts.warnings ?? null);
  const criterion = evaluation.criteria.find((entry) => entry.id === mechanical.guardrail_id);
  assert.equal(criterion.authority, mechanical.authority);
  assert.equal(criterion.evidence, mechanical.reason);
  assert.equal(JSON.stringify(consumed.entities).includes("responseProtocolEvidence"), false);
});

test("production Spec Gate failed history stays bound to its saved Attempt after semantic retry", async (t) => {
  const root = createTmpDir("query-gate-history-producer-");
  t.after(() => removeTmpDir(root));
  let fixture = new SpecStepPreparationFixture(root);
  t.after(() => fixture?.dispose());
  let input = (await fixture.createInput("spec-gate")).input;
  let manager = input.flowManager;
  const repository = path.join(root, "spec-gate");
  const specId = manager.canonicalState().specId;
  const commandResult = new CanonicalGatePromotion({ state: manager.canonicalState(specId), phase: "spec", nodeId: "spec-gate" })
    .promote({ result: "fail", artifacts: { evaluations: [], failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED" } });
  let prepared = await specStepRegistration("spec-gate").create({ ...input, commandResult,
    issuePublication: new SpecGateIssuePublication({ binding: input.binding, entry: {
      step: "spec-gate", phase: "spec", observations: [], reason: "Recorded semantic Gate failure.",
      trigger: "gate post hook (auto)", timestamp: input.binding.assertCurrent().attempt.startedAt,
    } }) });
  assert.equal((await prepared.step.execute()).kind, "spec-gate-retry-required");
  const retry = manager.canonicalState(specId).attempt;
  const passedResult = new CanonicalGatePromotion({ state: manager.canonicalState(specId), phase: "spec", nodeId: "spec-gate" })
    .promote({ result: "pass", artifacts: { evaluations: [] } });
  let latest = await specStepRegistration("spec-gate").create({ flowManager: manager,
    binding: new SpecGateEvaluationBinding({ flowManager: manager, specId }), commandResult: passedResult });
  assert.equal((await latest.step.execute()).kind, "spec-gate-passed");
  latest = null;
  prepared = null;
  input = null;
  manager = null;
  fixture.dispose();
  fixture = null;
  const reloaded = managerAt(repository, specId);
  const failed = reloaded.activityLedger(specId).findLast((entry) => entry.result?.stepResult?.kind === "spec-gate-retry-required");
  const passed = reloaded.activityLedger(specId).findLast((entry) => entry.result?.stepResult?.kind === "spec-gate-passed");
  assert.equal(passed.sequence, failed.sequence + 1);
  assert.equal(passed.attemptId, retry.id);
  assert.notEqual(passed.attemptId, failed.attemptId);
  const saved = reloaded.readArtifact({ specId, logicalKey: "spec.gate", consumerNodeId: "approval" });
  assert.equal(saved.descriptor.activityId, passed.id);
  assert.deepEqual(JSON.parse(saved.bytes).attempts.map((entry) => entry.artifact.payload.result), ["fail", "pass"]);
  const { consumed } = await consumeFrom(repository, specId, failed);
  const [evaluation] = detailFor(consumed, failed.id, "evaluations");
  assert.deepEqual(evaluation.result, { outcome: "failed", nativeCode: "fail" });
  assert.deepEqual(evaluation.specific.failureCategory, commandResult.artifacts.gateTransitionFailureCategory);
  assert.equal(evaluation.specific.failureKind, commandResult.artifacts.failureKind);
  assert.equal(evaluation.specific.failureCode, commandResult.artifacts.failureCode);
  assert.equal(evaluation.source.attemptId, failed.attemptId);
  assert.equal(evaluation.source.observationId, `attempt:${failed.attemptId}`);
  const [latestEvaluation] = detailFor(consumed, passed.id, "evaluations");
  assert.deepEqual(latestEvaluation.result, { outcome: "passed", nativeCode: "pass" });
  assert.notEqual(evaluation.id, latestEvaluation.id);
  assert.equal(latestEvaluation.source.jsonPointer, "/attempts/1/artifact/payload");
});

test("two production Task Gate publications at sequence one resolve their own catalog scope after reload", async (t) => {
  const root = fixtureRepository("query-task-gate-producers-");
  t.after(() => removeTmpDir(root));
  setupFlowConfig(root, "en");
  const specId = "804-query-task-gates";
  let manager = managerAt(root, specId);
  const tasks = ["T1", "T2"].map((id) => ({ id, title: `Gate ${id}`, goal: `Save ${id} Gate evidence`,
    parent: null, origin: "plan", added_round: 0, status: "pending" }));
  let flow = new CanonicalFlowFixture({ flowManager: manager, specId, specRecord: {
    goal: "Preserve Task scope", requirements: [{ id: "R1", desc: "Each Task owns its Gate", task_ids: tasks.map((entry) => entry.id) }],
  } }).create().addTasks(tasks);
  const sourceMutations = new Map(tasks.map((task) => [`${task.id}-impl`, () => {
    fs.appendFileSync(path.join(root, "README.md"), `Implemented ${task.id} behavior.\n`);
  }]));
  for (const task of tasks) {
    await flow.activateWithProducers(`${task.id}-gate`, { sourceMutations });
    flow.settle(`${task.id}-gate`);
  }
  manager = null;
  flow = null;
  const reloaded = managerAt(root, specId);
  const ledger = reloaded.activityLedger(specId);
  const catalog = reloaded.artifactCatalog(specId);
  for (const task of tasks) {
    const relativePath = FLOW_ARTIFACT_CONTRACTS.resolve("task.gate", { taskId: task.id }).relativePath;
    const descriptor = catalog.artifacts.find((entry) => entry.relativePath === relativePath);
    assert.ok(descriptor);
    const artifact = { descriptor, bytes: fs.readFileSync(reloaded.specLocation(specId).resolve(relativePath)) };
    const stored = JSON.parse(artifact.bytes).attempts[0].artifact.payload;
    const owner = ledger.find((entry) => entry.id === artifact.descriptor.activityId);
    assert.equal(owner.sequence, 1);
    assert.equal(owner.nodeId, `${task.id}-gate`);
    const { consumed } = await consumeFrom(root, specId, owner, { limit: 1,
      hasNext: ledger.some((entry) => entry.confirmationOrder > owner.confirmationOrder) });
    const [evaluation] = detailFor(consumed, owner.id, "evaluations");
    assert.equal(consumed.entities.evaluations.length, 1);
    assert.equal(evaluation.source.relativePath, artifact.descriptor.relativePath);
    assert.equal(evaluation.source.producerActivityId, owner.id);
    assert.equal(evaluation.specific.taskId, task.id);
    assert.equal(evaluation.specific.phase, stored.artifacts.phase);
    assert.equal(evaluation.specific.sourceFingerprint, stored.artifacts.sourceFingerprint);
    assert.deepEqual(evaluation.result, { outcome: "passed", nativeCode: "pass" });
  }
});
