import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowProcessExecutionBinding } from "../../../src/flow/lib/flow-process-execution-binding.js";
import RunRecoverArtifactExecutionCommand from "../../../src/flow/lib/run-recover-artifact-execution.js";
import { ExecuteStepDirective } from "../../../src/flow/lib/next-action-directive.js";
import { FlowDispatchTarget, FlowDispatchSession, FlowDispatchInvocation,
  UnapprovedFlowDispatchAuthorization } from "../../../src/flow/lib/dispatch-invocation.js";
import { dispatchRepositoryFingerprint } from "../../../src/flow/lib/run-dispatch.js";
import { selectWorkerExecutionAdmission } from "../../../src/flow/lib/worker-execution-admission.js";
import { ArtifactWorkerSealedReplay, ArtifactWorkerExecutionStop } from "../../../src/flow/lib/artifact-worker-execution-continuation.js";
import { DraftCreatedResult } from "../../../src/flow/engine/step-result.js";
import { DraftRefineWorkerRequiredResult } from "../../../src/flow/engine/step-result.js";
import { settleDraftStepResult, DraftConditionalWorkerExecutionBinding, DraftWorkerExecutionClaim } from "../../../src/flow/definition.js";
import { DraftWorkerStepBinding, DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { CanonicalFlowFixture, FlowAtStepFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { executeArtifactWorkerPrompt } from "../../../src/flow/lib/artifact-worker-prompt-execution.js";
import { OriginalArtifactWorkerAuthorization } from "../../../src/flow/lib/original-artifact-worker-authorization.js";
import { PromptBatchExecutionIncompleteFailure } from "../../../src/lib/prompt-batching.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { dispatchContainer, dispatchFlowCommand } from "../../support/infrastructure/flow-dispatch-scenario.js";

function fixture(t, { stepId = "draft" } = {}) {
  const root = createTmpDir("artifact-recovery-seal-race-");
  const runtimes = [];
  t.after(async () => {
    try { for (const runtime of runtimes) if (!runtime.closed) await runtime.close(); }
    finally { removeTmpDir(root); }
  });
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "README.md"), "Artifact worker recovery race fixture\n");
  commitAll(root, "Create recovery race fixture");
  const specId = "artifact-recovery-seal-race";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const flowInput = { flowManager: manager, specId, runId: "artifact-recovery-seal-race-run",
    request: "Preserve a worker response arriving during recovery admission.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } };
  if (stepId === "draft") new CanonicalFlowFixture(flowInput).create().registerActive().activate("draft");
  else new FlowAtStepFixture({ ...flowInput, targetStep: stepId }).create();
  const context = (flowManager) => ({ root, mainRoot: root, executionRoot: root, specId,
    flowManager, flowState: flowManager.loadReadOnly(specId), flowCommandBoundary: true });
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const ctx = context(manager);
  const session = new FlowDispatchSession({ id: "artifact-recovery-seal-race-dispatch", target: FlowDispatchTarget.captureContext(ctx) });
  const action = session.captureAction({ step: stepId, directive: new ExecuteStepDirective({ action: "write-draft" }).toJSON() },
    dispatchRepositoryFingerprint(ctx));
  const invocation = new FlowDispatchInvocation({ session, action, authorization: new UnapprovedFlowDispatchAuthorization(action) });
  const request = coordinator.createRequest({ ctx: context(manager), state: manager.loadReadOnly(specId),
    invocation, ...(stepId === "draft" ? {} : { deferPreparation: true, deferConditionalAdmission: true }) });
  if (stepId !== "draft") {
    const binding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId });
    const stepResult = new DraftRefineWorkerRequiredResult();
    const settlement = settleDraftStepResult(stepId, stepResult);
    const executionBinding = new DraftConditionalWorkerExecutionBinding({ executionGeneration: 0,
      inputDigest: request.inputDigest, inputRevision: request.inputRevision, contentDigest: request.checkpointContentDigest() });
    manager.checkpointDraftStepExecution({ binding, stepResult, settlement, executionBinding, executionContract: request.executionContract });
    manager.claimDraftStepExecution({ binding, stepResult, settlement, executionBinding, executionContract: request.executionContract,
      requestSnapshot: request.requestSnapshot(), executionClaim: new DraftWorkerExecutionClaim({
        dispatchInvocationId: request.dispatchInvocationId, generatedAt: request.generatedAt,
        actionDigest: request.actionDigest, requestDigest: request.requestDigest }) });
    coordinator.admitConditionalDraftRequest({ ctx, state: manager.loadReadOnly(specId), request });
    request.prepare();
  }
  const reload = () => new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const binding = { runId: request.runId, specId, stepId: request.stepId, nodeId: request.stepId,
    attempt: manager.canonicalState(specId).attempt };
  return { root, specId, manager, request, coordinator, context, reload, binding, runtimes };
}

test("an original conditional reservation authenticates its saved claim without minting another generation", async (t) => {
  const value = fixture(t, { stepId: "draft-refine" });
  const { request, root } = value;
  const parameters = request.executionContract.parameters;
  const producer = (logicalKey) => value.manager.readArtifact({ specId: value.specId, logicalKey,
    parameters, consumerNodeId: "system" }).descriptor.activityId;
  assert.equal(producer("execution.contract"), producer("execution.request"));
  const processBinding = new ProcessExecutionBinding({ ...FlowProcessExecutionBinding.forContract(request.executionContract).toJSON(),
    dispatchInvocationId: request.dispatchInvocationId, requestDigest: request.requestDigest });
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: request.runId, specId: value.specId, binding: processBinding });
  value.runtimes.push(runtime);
  const interrupted = new Error("Interrupted after the original Prompt reservation");
  try {
    await assert.rejects(runtime.enter(() => executeArtifactWorkerPrompt({ flowManager: value.manager, request,
      prompt: "Preserve the original selected refinement", callOptions: { commandId: "flow.worker", processExecutionBinding: processBinding },
      agent: { async call(_prompt, { providerCallAdmission }) {
        providerCallAdmission.claim();
        await providerCallAdmission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: "test", profileKey: "conditional-original",
          attemptId: "conditional-original-provider", logicalInvocationId: "conditional-original-call" });
        throw interrupted;
      } } })), (error) => error instanceof PromptBatchExecutionIncompleteFailure && error.cause === interrupted);
  } finally { await runtime.close(); }
  const manager = value.reload();
  const before = manager.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget;
  assert.equal(before.providerCallCount, 1);
  const authorization = await value.coordinator.recoverArtifactExecution({ ctx: value.context(manager) });
  assert.ok(authorization instanceof OriginalArtifactWorkerAuthorization);
  const fresh = value.reload();
  const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding });
  assert.equal(frontier.recovery, null);
  assert.equal(frontier.contracts.length, 1);
  assert.equal(frontier.executionContract.id, request.executionContract.id);
  assert.equal(frontier.reservationContinuation.pending, true);
  assert.equal(frontier.reservationContinuation.authorizationId, authorization.id);
  assert.deepEqual(fresh.readStoredPromptExecutionEpisode({ executionContract: request.executionContract }).budget, before);
});

function canonicalSnapshot(value, manager) {
  return { state: manager.canonicalState(value.specId).toJSON(),
    activities: JSON.parse(JSON.stringify(manager.activityLedger(value.specId))),
    catalog: manager.artifactCatalog(value.specId).toJSON(),
    budget: manager.readStoredPromptExecutionEpisode({ executionContract: value.request.executionContract }).budget };
}

function canonicalBytes(location, extraFiles = []) {
  return [location.flowStateFile, location.activitiesFile, location.catalogFile, location.specFile, ...extraFiles]
    .map((file) => fs.readFileSync(file).toString("base64"));
}

async function saveStartedWorkerStop(value) {
  const { request, root } = value;
  const processBinding = new ProcessExecutionBinding({ ...FlowProcessExecutionBinding.forContract(request.executionContract).toJSON(),
    dispatchInvocationId: request.dispatchInvocationId, requestDigest: request.requestDigest });
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: root, executionRoot: root,
    runId: request.runId, specId: value.specId, binding: processBinding });
  value.runtimes.push(runtime);
  try {
    await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('worker stopped before sealing')"], {
      processExecutionBinding: processBinding, kind: "worker", timeoutMs: 60000, maxBuffer: 1024 }));
  } finally { await runtime.close(); }
}

test("a corrupt cataloged execution contract refuses the guarded CLI before provider or canonical changes", async (t) => {
  const value = fixture(t);
  const location = value.manager.specLocation(value.specId);
  const descriptor = value.manager.artifactCatalog(value.specId).artifacts.find((entry) => entry.logicalKey === "execution.contract");
  const contractPath = location.resolve(descriptor.relativePath);
  // A malformed filesystem input is intentional. The global catalog must
  // refuse before there is any authenticated frontier from which to select.
  fs.appendFileSync(contractPath, "corrupt");
  const snapshot = () => canonicalBytes(location, [contractPath, value.request.requestPath]);
  const before = snapshot();
  const fresh = value.reload();
  let workerCalls = 0;
  const execution = await dispatchFlowCommand({
    container: dispatchContainer({ root: value.root, flowManager: fresh,
      agent: { call() { workerCalls++; assert.fail("Catalog corruption cannot authorize a worker"); } } }),
    group: "run", name: "recover-artifact-execution",
    argv: ["--expect-run-id", value.request.runId, "--expect-spec", value.specId, "--expect-no-issue"],
  });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.envelope.ok, false);
  assert.deepEqual(execution.envelope.errors.map((entry) => entry.code), ["FLOW_TARGET_RECOVERY_REQUIRED"]);
  assert.equal(execution.envelope.data.reason, "FLOW_TARGET_STATE_INVALID");
  assert.ok(execution.envelope.errors[0].messages.some((message) => message.includes("selected flow target state is corrupt or unreadable")));
  assert.equal(workerCalls, 0);
  assert.deepEqual(snapshot(), before);
});

test("a missing durable Prompt budget refuses the guarded next action without restoring zero consumption", async (t) => {
  const value = fixture(t);
  await executeArtifactWorkerPrompt({ flowManager: value.manager, request: value.request,
    prompt: "Complete the acquired worker request", callOptions: {}, agent: { async call(_prompt, { providerCallAdmission }) {
      providerCallAdmission.claim();
      await providerCallAdmission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: "fixture", profileKey: "review" });
      return "saved unsealed response";
    } } });
  const catalog = value.manager.artifactCatalog(value.specId);
  const budget = catalog.artifacts.find((entry) => entry.logicalKey === "prompt.execution.budget");
  const location = value.manager.specLocation(value.specId);
  // Match the existing missing-authority fixture: a malformed catalog is
  // intentionally supplied at the storage boundary, never by a normal writer.
  fs.unlinkSync(location.resolve(budget.relativePath));
  fs.writeFileSync(location.catalogFile, JSON.stringify(new FlowArtifactCatalog({
    artifacts: catalog.artifacts.filter((entry) => entry !== budget),
  }).toJSON()));
  const before = canonicalBytes(location, [value.request.requestPath]);
  let workerCalls = 0;
  const execution = await dispatchFlowCommand({
    container: dispatchContainer({ root: value.root, flowManager: value.reload(),
      agent: { call() { workerCalls++; assert.fail("Missing Prompt authority cannot authorize a worker"); } } }),
    group: "get", name: "next-action",
    argv: ["--expect-run-id", value.request.runId, "--expect-spec", value.specId, "--expect-no-issue"],
  });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.envelope.ok, false);
  assert.deepEqual(execution.envelope.errors.map((entry) => entry.code), ["FLOW_EXECUTION_CONTRACT_MISMATCH"]);
  assert.ok(execution.envelope.errors[0].messages.some((message) => message.includes("no durable episode budget")));
  assert.equal(workerCalls, 0);
  assert.deepEqual(canonicalBytes(location, [value.request.requestPath]), before);
});

test("concurrent resumes of the same stopped producer converge on one durable replacement and one budget import", async (t) => {
  const value = fixture(t);
  await saveStartedWorkerStop(value);
  const first = value.reload();
  const second = value.reload();
  const before = canonicalSnapshot(value, first);
  const observations = new Map();
  let saveCalls = 0;
  for (const manager of [first, second]) {
    const read = manager.artifactWorkerExecutionState.bind(manager);
    const observed = [];
    observations.set(manager, observed);
    t.mock.method(manager, "artifactWorkerExecutionState", (input) => {
      const frontier = read(input);
      observed.push(frontier.executionContract.id);
      return frontier;
    });
    const save = manager.saveArtifactWorkerRecovery.bind(manager);
    t.mock.method(manager, "saveArtifactWorkerRecovery", (input) => { saveCalls++; return save(input); });
  }
  const owner = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, executionRoot: value.root,
    runId: value.request.runId, specId: value.specId, binding: FlowProcessExecutionBinding.forEpisode(value.request.executionContract) });
  value.runtimes.push(owner);
  let receipts;
  try {
    receipts = await owner.enter(() => Promise.all([first, second].map((manager) =>
      new WorkerArtifactHandoffCoordinator().recoverArtifactExecution({ ctx: value.context(manager) }))));
  } finally { await owner.close(); }
  assert.deepEqual([...observations.values()].map((entries) => entries[0]),
    [value.request.executionContract.id, value.request.executionContract.id], "both resumes observed the original frontier before exclusion");
  assert.equal(observations.get(second)[1], receipts[0].targetContractId, "the queued resume rereads the first durable replacement under exclusion");
  assert.equal(receipts[0].id, receipts[1].id);
  assert.equal(saveCalls, 1);
  const fresh = value.reload();
  const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding });
  assert.deepEqual(frontier.contracts.map((contract) => contract.generation), [0, 1]);
  assert.equal(frontier.recovery.id, receipts[0].id);
  assert.equal(fresh.artifactWorkerRecoveryReceipts({ specId: value.specId }).length, 1);
  assert.equal(fresh.activityLedger(value.specId).length, before.activities.length + 1);
  const episode = fresh.readStoredPromptExecutionEpisode({ executionContract: frontier.executionContract });
  assert.equal(episode.budget.providerCallCount, before.budget.providerCallCount + 1);
  assert.deepEqual({ ...episode.budget, providerCallCount: before.budget.providerCallCount }, before.budget);
  assert.equal(frontier.executionContract.episodeId, value.request.executionContract.episodeId);
  assert.equal(frontier.executionContract.budgetId, value.request.executionContract.budgetId);
  const after = canonicalSnapshot(value, fresh);
  const replay = await new WorkerArtifactHandoffCoordinator().recoverArtifactExecution({ ctx: value.context(value.reload()) });
  assert.equal(replay.id, receipts[0].id);
  assert.deepEqual(canonicalSnapshot(value, value.reload()), after);
});

for (const corruptAfterSeal of [false, true]) {
  test(`a ${corruptAfterSeal ? "corrupt" : "valid"} response arriving before recovery save preserves the original authorization`, async (t) => {
    const value = fixture(t);
    const { request, root } = value;
    await saveStartedWorkerStop(value);

    const manager = value.reload();
    const before = canonicalSnapshot(value, manager);
    const actualSave = manager.saveArtifactWorkerRecovery.bind(manager);
    const draft = canonicalDraftDocument({ goal: "Retain the response that arrived during recovery", questions: [] });
    let saveCalls = 0;
    t.mock.method(manager, "saveArtifactWorkerRecovery", (input) => {
      saveCalls++;
      fs.writeFileSync(request.payloadPath("draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
      sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
      if (corruptAfterSeal) fs.appendFileSync(request.payloadPath("draft.json"), "corrupt");
      return actualSave(input);
    });
    const envelope = await new RunRecoverArtifactExecutionCommand().execute(value.context(manager));
    assert.equal(saveCalls, 1, `the response arrives after preparation, at the real Store save boundary: ${JSON.stringify(envelope)}`);
    assert.equal(envelope.ok, !corruptAfterSeal, JSON.stringify(envelope));
    if (!corruptAfterSeal) assert.equal(envelope.data.replaySelected, true);
    const fresh = value.reload();
    assert.deepEqual(canonicalSnapshot(value, fresh), before);
    const frontier = fresh.artifactWorkerExecutionState({ binding: value.binding });
    assert.equal(frontier.recovery, null);
    assert.deepEqual(frontier.contracts.map((contract) => contract.id), [request.executionContract.id]);
    const selected = selectWorkerExecutionAdmission({ ctx: value.context(fresh), stepId: request.stepId });
    assert.ok(selected.artifactContinuation instanceof (corruptAfterSeal ? ArtifactWorkerExecutionStop : ArtifactWorkerSealedReplay));
    assert.equal(selected.artifactContinuation.requiresWorker, false);
    assert.ok(ProcessExecutionRuntime.inspect({ mainRoot: root, executionRoot: root }).executions.every((entry) => entry.status === "closed"));
    if (corruptAfterSeal) return;

    const ctx = value.context(fresh);
    const preparation = value.coordinator.prepareDraftWorker({ ctx, request });
    const result = new DraftCreatedResult();
    const completed = value.coordinator.commitDraftWorker({ ctx, request, preparation, stepResult: result,
      settlement: settleDraftStepResult(result.stepId, result), binding: new DraftWorkerStepBinding({ request }) });
    assert.equal(completed.completed, true);
    const published = fresh.readArtifact({ specId: value.specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" });
    assert.deepEqual(JSON.parse(published.bytes.toString("utf8")), draft);
    assert.equal(fresh.canonicalState(value.specId).findNode("draft").status, "done");
  });
}
