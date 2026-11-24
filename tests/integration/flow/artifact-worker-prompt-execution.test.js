import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir } from "../../support/builders/tmp-dir.js";
import { removeQuiescentRuntimeFixture } from "../../support/infrastructure/runtime-fixture-cleanup.js";
import { DraftRefineWorkerRequiredResult, DraftRefineCompletedResult } from "../../../src/flow/engine/step-result.js";
import { settleDraftStepResult, DraftWorkerExecutionClaim } from "../../../src/flow/definition.js";
import { FlowExecutionContract, FlowExecutionContractRefusal,
  executionValueDigest as promptExecutionValueDigest } from "../../../src/flow/lib/flow-execution-contract.js";
import { CanonicalPromptExecutionEpisode, LegacyArtifactPromptConsumptionPublication,
  readStoredPromptExecutionEpisodeFromView } from "../../../src/flow/lib/canonical-prompt-execution.js";
import { executeArtifactWorkerPrompt } from "../../../src/flow/lib/artifact-worker-prompt-execution.js";
import { ArtifactWorkerInputContinuation } from "../../../src/flow/lib/artifact-worker-input-continuation.js";
import { FlowProcessExecutionBinding } from "../../../src/flow/lib/flow-process-execution-binding.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import { ProcessExecutionStopReceipt,
  executionValueDigest as processExecutionValueDigest } from "../../../src/lib/process-execution-values.js";
import { PromptExecutionLimit } from "../../../src/lib/prompt-batching.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding } from "../../../src/lib/process-execution-runtime.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";
import { Agent } from "../../../src/lib/agent.js";
import { ProviderRegistry } from "../../../src/lib/provider.js";
import { Logger } from "../../../src/lib/log.js";
import { AgentAuthenticationFailure } from "../../../src/lib/agent-failure.js";
import { WorkerArtifactHandoffError } from "../../../src/flow/lib/worker-artifact-handoff-error.js";
import { FlowProcessEventWriter } from "../../../src/flow/lib/flow-process-event.js";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";

function fixture(t, { maxProviderCallCount = 3 } = {}) {
  const root = createTmpDir("artifact-prompt-episode-");
  t.after(() => removeQuiescentRuntimeFixture({ mainRoot: root }));
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const specId = "001-artifact-budget";
  new FlowAtStepFixture({ flowManager: manager, specId, runId: "artifact-budget-run",
    request: "Preserve the interrupted worker budget", targetStep: "draft-refine" }).create();
  const state = manager.canonicalState(specId);
  const binding = { runId: state.runId, specId, stepId: "draft-refine", attempt: state.attempt };
  const required = new DraftRefineWorkerRequiredResult();
  const settlement = settleDraftStepResult(required.stepId, required);
  const executionBinding = manager.draftStepExecutionState({ binding }).workerBinding({ inputDigest: "a".repeat(64), inputRevision: "b".repeat(64) });
  manager.checkpointDraftStepExecution({ binding, stepResult: required, settlement, executionBinding });
  const contract = FlowExecutionContract.fromBinding({ binding, generation: executionBinding.executionGeneration,
    inputRevision: executionBinding.inputRevision, promptDigest: "c".repeat(64), schemaDigest: "d".repeat(64),
    executionLimit: { ...new PromptExecutionLimit({ maxProviderCallCount }) } });
  manager.claimDraftStepExecution({ binding, stepResult: required, settlement, executionBinding,
    executionClaim: new DraftWorkerExecutionClaim({ dispatchInvocationId: "dispatch-budget", generatedAt: "2026-10-15T00:00:00.000Z",
      actionDigest: "e".repeat(64), requestDigest: "f".repeat(64) }), executionContract: contract });
  const episodeBinding = new ProcessExecutionBinding({ runId: contract.runId, specId: contract.specId, nodeId: contract.nodeId,
    taskId: contract.taskId, attemptId: contract.attemptId, attemptSequence: contract.attemptSequence });
  return { root, manager, contract, episodeBinding };
}
function view(value, read) { return value.manager._store.runtime.readCanonicalTransitionView(value.contract.specId, read); }
function nextContract(contract, changes = {}) { return new FlowExecutionContract({ ...contract.toJSON(), generation: contract.generation + 1, ...changes }); }
async function physicalCall(value, { binding = FlowProcessExecutionBinding.forContract(value.contract), privateInput = null } = {}) {
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, runId: value.contract.runId,
    specId: value.contract.specId, binding });
  try {
    await runtime.enter(() => executeManagedProcess(process.execPath, ["-e", "process.stdout.write('old-worker-response')",
      ...(privateInput === null ? [] : [privateInput.argument])], {
      timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
      ...(privateInput === null ? {} : { env: { ...process.env, SENNEL_TEST_PRIVATE_INPUT: privateInput.environment } }),
    }));
  } finally { await runtime.close(); }
  const archiver = await ProcessExecutionRuntime.acquire({ mainRoot: value.root });
  await archiver.close();
}

test("artifact worker dispatch journals provider consumption and fresh readback reuses the saved response", async (t) => {
  const value = fixture(t);
  let calls = 0;
  const input = { flowManager: value.manager, request: { executionContract: value.contract }, prompt: "worker instructions",
    callOptions: { commandId: "flow.worker", systemPrompt: "parent instructions" }, agent: {
      async call(prompt, options) {
        calls++;
        assert.equal(prompt, "worker instructions");
        assert.equal(options.systemPrompt, "parent instructions");
        options.providerCallAdmission.claim();
        await options.providerCallAdmission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: "fake", profileKey: "test" });
        return "worker result";
      },
    } };
  assert.equal(await executeArtifactWorkerPrompt(input), "worker result");
  assert.equal(calls, 1);
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const saved = restarted.readPromptExecutionEpisode({ executionContract: value.contract });
  assert.equal(saved.budget.providerCallCount, 1);
  assert.equal(saved.scopes[0].scope.stage, "artifact-worker");
  const before = restarted.activityLedger(value.contract.specId).length;
  assert.equal(await executeArtifactWorkerPrompt({ ...input, flowManager: restarted }), "worker result");
  assert.equal(calls, 1);
  assert.equal(restarted.activityLedger(value.contract.specId).length, before);
  await assert.rejects(executeArtifactWorkerPrompt({ ...input, flowManager: restarted, prompt: "changed worker instructions" }),
    { code: "PROMPT_EXECUTION_IDENTITY_MISMATCH" });
  assert.equal(calls, 1);
});

test("artifact worker Prompt preserves typed dispatch failures before provider admission", async (t) => {
  for (const failure of [new AgentAuthenticationFailure({ message: "Credentials are unavailable" }),
    new WorkerArtifactHandoffError("invalid", "FLOW_ARTIFACT_HANDOFF_INVALID", "Producer rejected its payload", { retryable: true })]) {
    const value = fixture(t);
    await assert.rejects(executeArtifactWorkerPrompt({ flowManager: value.manager,
      request: { executionContract: value.contract }, prompt: "worker instructions", callOptions: {},
      agent: { async call() { throw failure; } },
    }), (error) => error === failure);
    const saved = value.manager.readPromptExecutionEpisode({ executionContract: value.contract });
    assert.equal(saved.budget.providerCallCount, 0);
    assert.equal(saved.scopes[0].batches[0].claim, null);
  }
});

test("stored Prompt facts remain readable when normal runtime admission refuses them", async (t) => {
  const value = fixture(t);
  const refusal = t.mock.method(FlowExecutionContract.prototype, "assertCurrent", () => {
    throw new FlowExecutionContractRefusal("old runtime cannot start another worker");
  });
  assert.throws(() => value.manager.readPromptExecutionEpisode({ executionContract: value.contract }), FlowExecutionContractRefusal);
  const saved = view(value, (current) => readStoredPromptExecutionEpisodeFromView(current, value.contract));
  assert.equal(saved.executionContract.id, value.contract.id);
  assert.equal(saved.budget.providerCallCount, 0);
  assert.equal(refusal.mock.callCount(), 1);
});

test("historical Prompt audit preserves the completed producer budget after the next Attempt activates", async (t) => {
  const value = fixture(t);
  await executeArtifactWorkerPrompt({ flowManager: value.manager, request: { executionContract: value.contract },
    prompt: "complete the selected worker", callOptions: {}, agent: { async call(_prompt, { providerCallAdmission }) {
      providerCallAdmission.claim();
      await providerCallAdmission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: "fake", profileKey: "test" });
      return "completed worker result";
    } } });
  const state = value.manager.canonicalState(value.contract.specId);
  const binding = { runId: state.runId, specId: state.specId, stepId: "draft-refine", attempt: state.attempt };
  const required = new DraftRefineWorkerRequiredResult();
  value.manager.settleDraftStepResult({ binding, stepResult: required,
    settlement: settleDraftStepResult("draft-refine", required), executionContract: value.contract,
    lifecycleResult: { outcome: "incomplete", summary: "saved worker response",
      confirmedAt: "2026-10-15T00:01:00.000Z", artifactRefs: [] } });
  const result = new DraftRefineCompletedResult();
  value.manager.commitDraftStepResult({ binding, stepResult: result,
    settlement: settleDraftStepResult("draft-refine", result), executionContract: value.contract });
  value.manager.updateStepStatus({ stepId: "draft-coverage-review", requestedStatus: "in_progress" },
    { specId: value.contract.specId });
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  assert.notEqual(restarted.canonicalState(value.contract.specId).attempt.id, value.contract.attemptId);
  assert.throws(() => restarted.readPromptExecutionEpisode({ executionContract: value.contract }), FlowExecutionContractRefusal);
  assert.throws(() => restarted.readStoredPromptExecutionEpisode({ executionContract: value.contract }), FlowExecutionContractRefusal);
  const before = restarted.activityLedger(value.contract.specId).length;
  const saved = view({ ...value, manager: restarted }, (current) => readStoredPromptExecutionEpisodeFromView(current,
    value.contract, null, { currentAttempt: false }));
  assert.equal(saved.executionContract.id, value.contract.id);
  assert.equal(saved.budget.providerCallCount, 1);
  assert.equal(saved.scopes[0].batches[0].completion.response, "completed worker result");
  assert.equal(restarted.activityLedger(value.contract.specId).length, before);
  assert.throws(() => view({ ...value, manager: restarted }, (current) => readStoredPromptExecutionEpisodeFromView({
    ...current, state: { ...current.state, runId: "another-run" } }, value.contract, null, { currentAttempt: false })), FlowExecutionContractRefusal);
});

test("generation and explicit runtime continuation retain all consumed counters and fixed policy", (t) => {
  const value = fixture(t);
  const episode = new CanonicalPromptExecutionEpisode({ executionContract: value.contract, scopes: [],
    budget: { providerCallCount: 2, synthesisCallCount: 1, aggregateCharacters: 7, aggregateItemCount: 1 } });
  const next = nextContract(value.contract, { runtimeRevision: "new-proven-runtime" });
  const continuation = episode.continuationFor(next);
  assert.equal(continuation.remainingProviderCalls, 1);
  assert.deepEqual(continuation.createExecutionBudget().snapshot(), episode.budget);
  for (const changes of [{ budgetOwner: "different-owner" }, { inputRevision: "changed-input" }, { promptDigest: "changed-prompt" },
    { schemaDigest: "changed-schema" }, { generation: next.generation + 1 },
    { executionLimit: { ...value.contract.executionLimit, maxProviderCallCount: 4 } }]) {
    assert.throws(() => episode.continuationFor(nextContract(value.contract, changes)), FlowExecutionContractRefusal);
  }
  const exhausted = new CanonicalPromptExecutionEpisode({ executionContract: value.contract, scopes: [],
    budget: { ...episode.budget, providerCallCount: 3 } });
  assert.throws(() => exhausted.continuationFor(next), { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
});

test("input provenance rebinding requires its exact saved content continuation while retaining the same budget", (t) => {
  const value = fixture(t);
  const episode = value.manager.readPromptExecutionEpisode({ executionContract: value.contract });
  const target = nextContract(value.contract, { inputRevision: "new-dispatch-provenance", runtimeRevision: "new-runtime" });
  assert.throws(() => episode.continuationFor(target), FlowExecutionContractRefusal);
  const inputContinuation = new ArtifactWorkerInputContinuation({ sourceContract: value.contract,
    targetContract: target, contentDigest: "1".repeat(64) });
  const saved = ArtifactWorkerInputContinuation.fromJSON(inputContinuation.toJSON());
  assert.equal(saved.assertContracts(value.contract, target), saved);
  const continuation = episode.continuationFor(target, { inputContinuation: saved });
  assert.deepEqual(continuation.budget, episode.budget);
  assert.equal(continuation.executionContract.id, target.id);
});

test("input provenance continuation cannot change policy or authorize another target contract", (t) => {
  const value = fixture(t);
  const target = nextContract(value.contract, { inputRevision: "new-dispatch-provenance" });
  const inputContinuation = new ArtifactWorkerInputContinuation({ sourceContract: value.contract,
    targetContract: target, contentDigest: "1".repeat(64) });
  for (const change of [{ schemaDigest: "changed-schema" }, { promptDigest: "changed-prompt" }, { budgetOwner: "changed-owner" },
    { executionLimit: { ...target.executionLimit, maxProviderCallCount: 4 } }]) {
    assert.throws(() => new ArtifactWorkerInputContinuation({ sourceContract: value.contract,
      targetContract: nextContract(value.contract, change), contentDigest: "1".repeat(64) }), FlowExecutionContractRefusal);
  }
  const otherTarget = nextContract(value.contract, { inputRevision: "another-provenance" });
  assert.throws(() => value.manager.readPromptExecutionEpisode({ executionContract: value.contract })
    .continuationFor(otherTarget, { inputContinuation }), FlowExecutionContractRefusal);
});

test("legacy physical worker consumption imports once into the same Prompt episode across archive and reload", async (t) => {
  const value = fixture(t);
  const privateInput = { argument: "private-provider-argument-sentinel", environment: "private-provider-environment-sentinel" };
  await physicalCall(value, { privateInput });
  const privateInventory = JSON.stringify(ProcessExecutionRuntime.inspect({ mainRoot: value.root }));
  for (const secret of Object.values(privateInput)) assert.ok(privateInventory.includes(secret));
  const operationId = crypto.randomUUID();
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
    assert.equal(physicalEvidence.calls.length, 1);
    assert.equal(physicalEvidence.calls[0].startPermitted, true);
    const publication = new LegacyArtifactPromptConsumptionPublication({ contract: value.contract, physicalEvidence, operationId });
    const prepared = view(value, (current) => publication.prepare(current));
    assert.equal(prepared.episode.budget.providerCallCount, 1);
    assert.equal(prepared.episode.continuationFor(nextContract(value.contract)).remainingProviderCalls, 2);
    value.manager.publishArtifacts({ specId: value.contract.specId, nodeId: value.contract.nodeId,
      artifactWrites: prepared.writes, admission: publication });
    const replay = view(value, (current) => publication.prepare(current));
    assert.equal(replay.writes.length, 0);
    assert.equal(replay.episode.budget.providerCallCount, 1);
  });
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const saved = restarted.readPromptExecutionEpisode({ executionContract: value.contract });
  assert.equal(saved.budget.providerCallCount, 1);
  assert.equal(saved.scopes.length, 0);
  const catalog = restarted.artifactCatalog(value.contract.specId);
  assert.equal(catalog.artifacts.filter((entry) => entry.logicalKey === "prompt.execution.event").length, 1);
  assert.equal(catalog.artifacts.filter((entry) => entry.logicalKey === "prompt.execution.budget").length, 1);
  const savedEvent = view({ ...value, manager: restarted }, (current) => current.readCatalogedArtifact(
    current.catalog.artifacts.find((entry) => entry.logicalKey === "prompt.execution.event")).toString("utf8"));
  for (const secret of Object.values(privateInput)) assert.equal(savedEvent.includes(secret), false);
  const proof = JSON.parse(savedEvent).record.calls[0];
  assert.match(proof.invocationDigest, /^[a-f0-9]{64}$/);
  assert.equal(proof.invocation.actualCommand, undefined);
  assert.equal(proof.invocation.launch, undefined);
  assert.equal(proof.receipt.invocationDigest, proof.invocationDigest);
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
    const prepared = view({ ...value, manager: restarted }, (current) => new LegacyArtifactPromptConsumptionPublication({
      contract: value.contract, physicalEvidence, operationId: crypto.randomUUID(),
    }).prepare(current));
    assert.equal(prepared.episode.budget.providerCallCount, 1);
  });
});

test("physical consumption refuses a call without a saved contract in the same episode", async (t) => {
  const value = fixture(t);
  await physicalCall(value, { binding: new ProcessExecutionBinding({ ...FlowProcessExecutionBinding.forContract(value.contract).toJSON(),
    executionContractId: "different-contract" }) });
  const before = value.manager.activityLedger(value.contract.specId).length;
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
    assert.throws(() => view(value, (current) => new LegacyArtifactPromptConsumptionPublication({ contract: value.contract,
      physicalEvidence, operationId: crypto.randomUUID() }).prepare(current)), FlowExecutionContractRefusal);
  });
  assert.equal(value.manager.activityLedger(value.contract.specId).length, before);
});

for (const reserved of [false, true]) {
  test(`physical ${reserved ? "reservation without permit" : "inventory without reservation"} proves zero consumption without assuming receipt absence`, async (t) => {
    const value = fixture(t, { maxProviderCallCount: 1 });
    const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root,
      binding: FlowProcessExecutionBinding.forContract(value.contract) });
    try {
      if (reserved) {
        const call = await runtime.reserveCall({ invocation: { commandId: "before-provider-permit" } });
        await runtime.revokeCall(call);
      }
    } finally { await runtime.close(); }
    let expired;
    await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
      assert.equal(physicalEvidence.calls.length, reserved ? 1 : 0);
      assert.equal(physicalEvidence.nonExecution === null, reserved);
      if (reserved) {
        assert.equal(physicalEvidence.calls[0].startPermitted, false);
        assert.equal(physicalEvidence.calls[0].receipt, null);
        assert.equal(physicalEvidence.calls[0].revocation.scope, "unlaunched-reservation");
      }
      expired = new LegacyArtifactPromptConsumptionPublication({ contract: value.contract, physicalEvidence, operationId: crypto.randomUUID() });
      const prepared = view(value, (current) => expired.prepare(current));
      assert.equal(prepared.episode.budget.providerCallCount, 0);
      assert.equal(prepared.episode.continuationFor(nextContract(value.contract)).remainingProviderCalls, 1);
      value.manager.publishArtifacts({ specId: value.contract.specId, nodeId: value.contract.nodeId,
        artifactWrites: prepared.writes, admission: expired });
    });
    assert.equal(value.manager.readPromptExecutionEpisode({ executionContract: value.contract }).budget.providerCallCount, 0);
    assert.throws(() => view(value, (current) => expired.prepare(current)), { code: "PROCESS_EXECUTION_RECOVERY_AUTHORITY_EXPIRED" });
  });
}

test("managed Agent provider admission and archived physical accounting share one consumed Prompt call", async (t) => {
  const value = fixture(t);
  const secrets = { argument: "agent-private-argument-sentinel", environment: "agent-private-environment-sentinel" };
  const config = { agent: { default: "test/exec", providers: { "test/exec": { command: process.execPath,
    args: ["-e", "process.stdout.write('managed worker result')", secrets.argument, "{{PROMPT}}"] } }, timeout: 30 } };
  const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
    flowManager: value.manager, registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: value.root, enabled: false }) });
  const binding = FlowProcessExecutionBinding.forContract(value.contract, {
    flowVersionId: value.manager.canonicalState(value.contract.specId).flowVersionId });
  const eventWriter = new FlowProcessEventWriter(value.manager);
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root,
    runId: value.contract.runId, specId: value.contract.specId, binding, eventWriter: (event) => eventWriter.write(event) });
  try {
    assert.equal(await runtime.enter(() => executeArtifactWorkerPrompt({ flowManager: value.manager,
      request: { executionContract: value.contract }, prompt: "managed worker instructions", agent,
      callOptions: { commandId: "flow.worker", processExecutionBinding: binding,
        executionEnvironment: { SENNEL_TEST_PRIVATE_INPUT: secrets.environment } } })), "managed worker result");
  } finally { await runtime.close(); }
  const inventory = JSON.stringify(ProcessExecutionRuntime.inspect({ mainRoot: value.root }));
  for (const secret of Object.values(secrets)) assert.ok(inventory.includes(secret));
  const episode = value.manager.readPromptExecutionEpisode({ executionContract: value.contract });
  assert.equal(episode.budget.providerCallCount, 1);
  assert.equal(episode.scopes[0].batches[0].processStops.length, 1);
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
    const publication = new LegacyArtifactPromptConsumptionPublication({ contract: value.contract, physicalEvidence, operationId: crypto.randomUUID() });
    const prepared = view(value, (current) => publication.prepare(current));
    assert.equal(prepared.episode.budget.providerCallCount, 1);
    assert.equal(prepared.document.record.accountedCallIds.length, 1);
    value.manager.publishArtifacts({ specId: value.contract.specId, nodeId: value.contract.nodeId,
      artifactWrites: prepared.writes, admission: publication });
  });
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const saved = restarted.readPromptExecutionEpisode({ executionContract: value.contract });
  assert.equal(saved.budget.providerCallCount, 1);
  assert.equal(saved.scopes[0].batches[0].completion.response, "managed worker result");
  const persisted = view({ ...value, manager: restarted }, (current) => current.catalog.artifacts
    .map((entry) => current.readCatalogedArtifact(entry).toString("utf8")));
  const activities = restarted.activityLedger(value.contract.specId);
  assert.ok(activities.some((activity) => activity.processEvent != null));
  const request = new QueryRequest({ resource: "executions", condition: { specId: value.contract.specId },
    page: { limit: 100, after: null } });
  const query = await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).read(request.specId, request.flowVersion, request);
  if (query.version.projectionError) throw query.version.projectionError;
  assert.ok(query.version.response.items.some((item) => item.kind === "process-call"));
  for (const secret of Object.values(secrets)) {
    for (const document of [...persisted, JSON.stringify(saved.scopes), JSON.stringify(activities), JSON.stringify(query.version.response)]) {
      assert.equal(document.includes(secret), false, "canonical Prompt, Activity and query must not expose private execution input");
    }
  }
});


async function ordinaryEpisodeOperation(value, operation) {
  const ctx = { root: value.root, mainRoot: value.root, executionRoot: value.root,
    flowManager: value.manager, specId: value.contract.specId,
    flowState: value.manager.loadReadOnly(value.contract.specId) };
  return withFlowProcessRuntime(ctx, operation, { commandId: "flow.episode-infrastructure" });
}

test("episode physical accounting retains admitted infrastructure closure without consuming another provider call", async (t) => {
  const value = fixture(t);
  const infrastructure = await ordinaryEpisodeOperation(value, () => executeManagedProcess(process.execPath,
    ["-e", "process.stdout.write('admitted infrastructure')"], { timeoutMs: 10000, graceMs: 100, maxBuffer: 1024 }));
  assert.equal(infrastructure.code, 0);
  const infrastructureReceipt = infrastructure.processExecutionStopReceipt;
  assert.ok(infrastructureReceipt instanceof ProcessExecutionStopReceipt);
  assert.equal(infrastructureReceipt.binding.value.executionContractId, null);
  assert.equal(infrastructureReceipt.binding.value.executionGeneration, null);
  assert.equal(infrastructureReceipt.invocation.kind, "command");
  assert.equal(infrastructureReceipt.stopEvidence.status, "confirmed");
  await physicalCall(value);
  const operationId = crypto.randomUUID();
  let storedDocument;
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
    assert.equal(physicalEvidence.calls.length, 2);
    for (const call of physicalEvidence.calls) {
      assert.equal(call.startPermitted, true);
      assert.equal(call.receipt.callId, call.callId);
      assert.equal(call.receipt.executionId, call.executionId);
      assert.equal(call.receipt.ownerEpoch, call.ownerEpoch);
      assert.equal(call.receipt.stopEvidence.status, "confirmed");
      assert.equal(call.receipt.invocationDigest, call.invocationDigest);
    }
    const infrastructureCall = physicalEvidence.calls.find((call) => call.callId === infrastructureReceipt.callId);
    assert.deepEqual(infrastructureCall.receipt.toJSON(), infrastructureReceipt.toJSON());
    const worker = physicalEvidence.calls.find((call) => call.binding.includes(FlowProcessExecutionBinding.forContract(value.contract)));
    assert.ok(worker);
    const publication = new LegacyArtifactPromptConsumptionPublication({ contract: value.contract, physicalEvidence, operationId });
    const prepared = view(value, (current) => publication.prepare(current));
    assert.equal(prepared.episode.budget.providerCallCount, 1);
    assert.equal(prepared.episode.continuationFor(nextContract(value.contract)).remainingProviderCalls, 2);
    const record = prepared.document.record;
    assert.deepEqual(record.calls, physicalEvidence.calls.map((call) => call.toStored()));
    assert.deepEqual(record.physicalEvidence, physicalEvidence.toJSON());
    const { id, digest, ...summary } = record.physicalEvidence;
    assert.equal(id, digest);
    assert.equal(digest, processExecutionValueDigest(summary));
    assert.deepEqual(record.accountedCallIds, []);
    assert.deepEqual(record.unobservedProviderUsageCallIds, [`${worker.executionId}/${worker.callId}`]);
    assert.equal(prepared.document.digest, promptExecutionValueDigest(record));
    value.manager.publishArtifacts({ specId: value.contract.specId, nodeId: value.contract.nodeId,
      artifactWrites: prepared.writes, admission: publication });
    storedDocument = prepared.document;
  });
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const saved = restarted.readPromptExecutionEpisode({ executionContract: value.contract });
  assert.equal(saved.budget.providerCallCount, 1);
  assert.equal(saved.continuationFor(nextContract(value.contract)).remainingProviderCalls, 2);
  const persisted = view({ ...value, manager: restarted }, (current) => JSON.parse(current.readCatalogedArtifact(
    current.catalog.artifacts.find((entry) => entry.logicalKey === "prompt.execution.event")).toString("utf8")));
  assert.deepEqual(persisted, storedDocument);
  const before = { state: restarted.canonicalState(value.contract.specId).toJSON(),
    activities: restarted.activityLedger(value.contract.specId), catalog: restarted.artifactCatalog(value.contract.specId).toJSON() };
  await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
    const replay = view({ ...value, manager: restarted }, (current) => new LegacyArtifactPromptConsumptionPublication({
      contract: value.contract, physicalEvidence, operationId }).prepare(current));
    assert.deepEqual(replay.document, storedDocument);
    assert.deepEqual(replay.writes, []);
    assert.equal(replay.episode.budget.providerCallCount, 1);
    const fresh = view({ ...value, manager: restarted }, (current) => new LegacyArtifactPromptConsumptionPublication({
      contract: value.contract, physicalEvidence, operationId: crypto.randomUUID() }).prepare(current));
    assert.equal(fresh.episode.budget.providerCallCount, 1);
    const worker = physicalEvidence.calls.find((call) => call.binding.includes(FlowProcessExecutionBinding.forContract(value.contract)));
    assert.deepEqual(fresh.document.record.accountedCallIds, [`${worker.executionId}/${worker.callId}`]);
    assert.deepEqual(fresh.document.record.unobservedProviderUsageCallIds, []);
    assert.deepEqual(fresh.document.record.calls, physicalEvidence.calls.map((call) => call.toStored()));
    assert.deepEqual(fresh.document.record.physicalEvidence, physicalEvidence.toJSON());
    assert.equal(fresh.document.digest, promptExecutionValueDigest(fresh.document.record));
  });
  assert.deepEqual({ state: restarted.canonicalState(value.contract.specId).toJSON(),
    activities: restarted.activityLedger(value.contract.specId), catalog: restarted.artifactCatalog(value.contract.specId).toJSON() }, before);
});

for (const conflictingMetadata of ["provider", "prompt"]) {
  test(`episode physical accounting refuses a null-contract ${conflictingMetadata} call with its real closure intact`, async (t) => {
    const value = fixture(t);
    let completed;
    if (conflictingMetadata === "provider") {
      const config = { agent: { default: "test/exec", providers: { "test/exec": { command: process.execPath,
        args: ["-e", "process.stdout.write('unowned provider result')", "{{PROMPT}}"] } }, timeout: 30 } };
      const agent = new Agent({ config, paths: { root: value.root, agentWorkDir: path.join(value.root, ".tmp") },
        flowManager: value.manager, registry: new ProviderRegistry(config.agent.providers),
        logger: new Logger({ logDir: value.root, enabled: false }) });
      assert.equal(await ordinaryEpisodeOperation(value, () => agent.call("unowned provider instructions",
        { commandId: "flow.unowned-provider", onProcessExecutionStop(receipt) { completed = receipt; } })), "unowned provider result");
    } else {
      const result = await ordinaryEpisodeOperation(value, () => executeManagedProcess(process.execPath,
        ["-e", "process.stdout.write('conflicting Prompt metadata')"], { timeoutMs: 10000, graceMs: 100, maxBuffer: 1024,
          promptProcessIdentity: { providerAttemptId: crypto.randomUUID(), logicalInvocationId: crypto.randomUUID() } }));
      assert.equal(result.code, 0);
      completed = result.processExecutionStopReceipt;
    }
    assert.ok(completed instanceof ProcessExecutionStopReceipt);
    assert.equal(completed.binding.value.executionContractId, null);
    assert.equal(completed.binding.value.executionGeneration, null);
    assert.equal(completed.stopEvidence.status, "confirmed");
    assert.equal(completed.invocation.kind, conflictingMetadata === "provider" ? "provider" : "command");
    const before = { state: value.manager.canonicalState(value.contract.specId).toJSON(),
      activities: value.manager.activityLedger(value.contract.specId), catalog: value.manager.artifactCatalog(value.contract.specId).toJSON(),
      budget: value.manager.readPromptExecutionEpisode({ executionContract: value.contract }).budget };
    await ProcessExecutionRuntime.withRecoveryEvidence({ mainRoot: value.root, binding: value.episodeBinding }, (physicalEvidence) => {
      assert.equal(physicalEvidence.calls.length, 1);
      assert.equal(physicalEvidence.calls[0].startPermitted, true);
      assert.deepEqual(physicalEvidence.calls[0].receipt.toJSON(), completed.toJSON());
      assert.throws(() => view(value, (current) => new LegacyArtifactPromptConsumptionPublication({ contract: value.contract,
        physicalEvidence, operationId: crypto.randomUUID() }).prepare(current)), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
    });
    assert.deepEqual({ state: value.manager.canonicalState(value.contract.specId).toJSON(),
      activities: value.manager.activityLedger(value.contract.specId), catalog: value.manager.artifactCatalog(value.contract.specId).toJSON(),
      budget: value.manager.readPromptExecutionEpisode({ executionContract: value.contract }).budget }, before);
    const inventory = ProcessExecutionRuntime.inspect({ mainRoot: value.root });
    assert.equal(inventory.slot, null);
    const savedCall = inventory.executions.flatMap((execution) => execution.calls).find((call) => call.callId === completed.callId);
    assert.deepEqual(savedCall.receipt, completed.toJSON());
  });
}
