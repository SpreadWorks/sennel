import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";
import { FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { DraftRefineWorkerRequiredResult } from "../../../src/flow/engine/step-result.js";
import { settleDraftStepResult, DraftWorkerExecutionClaim } from "../../../src/flow/definition.js";
import { FlowExecutionContract } from "../../../src/flow/lib/flow-execution-contract.js";
import { CanonicalPromptExecutionJournalWriter } from "../../../src/flow/lib/canonical-prompt-execution-writer.js";
import { PromptExecutionJournal, PromptExecutionJournalRecord, PromptExecutionScope, PromptProcessStopObservation } from "../../../src/lib/prompt-execution-journal.js";
import { PromptRequestEnvelope, PromptInputBuilder, PromptRequestLimit, RangedTextPromptElement,
  PromptBatchPlan, PromptBatchExecutor, PromptExecutionLimit, PromptExecutionBudget } from "../../../src/lib/prompt-batching.js";
import { ProcessExecutionRuntime, ProcessExecutionBinding, ProcessExecutionControlFailure, captureProcessExecutionCheckoutIdentity } from "../../../src/lib/process-execution-runtime.js";
import { AgentProviderAttemptContext } from "../../../src/lib/agent-provider-attempt.js";
import { AgentProviderCompletionEvidence, UnclassifiedProviderExitFailure } from "../../../src/lib/agent-failure.js";
import { executeManagedProcess } from "../../../src/lib/managed-process.js";

class Envelope extends PromptRequestEnvelope {
  constructor() { super({ revision: "stop-receipt" }); }
  build(elements) { return { userPrompt: elements.map((entry) => entry.toPromptText()).join(""), systemPrompt: null, jsonSchema: null, fmtFallback: null }; }
}
function fixture(t) {
  const root = createTmpDir("prompt-stop-", { parent: path.resolve(".tmp/c2f6/prompt-receipt-fixtures") });
  const owned = { runtime: null };
  t.after(async () => { try { await owned.runtime?.close(); } finally { removeTmpDir(root); } });
  initGitRepo(root);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const specId = "001-stop-contract";
  new FlowAtStepFixture({ flowManager: manager, specId, runId: "stop-run", request: "Managed Prompt receipt", targetStep: "draft-refine" }).create();
  const state = manager.canonicalState(specId);
  const binding = { runId: state.runId, specId, stepId: "draft-refine", attempt: state.attempt };
  const required = new DraftRefineWorkerRequiredResult(), settlement = settleDraftStepResult(required.stepId, required);
  const executionBinding = manager.draftStepExecutionState({ binding }).workerBinding({ inputDigest: "a".repeat(64), inputRevision: "b".repeat(64) });
  manager.checkpointDraftStepExecution({ binding, stepResult: required, settlement, executionBinding });
  const limit = new PromptExecutionLimit({ maxProviderCallCount: 2 });
  const contract = FlowExecutionContract.fromBinding({ binding, generation: executionBinding.executionGeneration,
    inputRevision: executionBinding.inputRevision, promptDigest: "c".repeat(64), schemaDigest: "d".repeat(64), executionLimit: { ...limit } });
  const claim = new DraftWorkerExecutionClaim({ dispatchInvocationId: "prompt-stop-dispatch", generatedAt: "2026-10-13T01:02:03.000Z", actionDigest: "e".repeat(64), requestDigest: "f".repeat(64) });
  manager.claimDraftStepExecution({ binding, stepResult: required, settlement, executionBinding, executionClaim: claim, executionContract: contract });
  const envelope = new Envelope(), requestLimit = new PromptRequestLimit({ maxCharacters: 40 });
  const builder = new PromptInputBuilder({ envelope, limit: requestLimit });
  builder.add(new RangedTextPromptElement({ id: "input", sourceRevision: "revision", sequence: 0, text: "payload" }));
  const plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit: requestLimit });
  const scope = new PromptExecutionScope({ stage: "map" });
  const writer = (flowManager = manager, snapshot = null) => new CanonicalPromptExecutionJournalWriter({ flowManager, executionContract: contract, scope, snapshot, checkoutIdentity: captureProcessExecutionCheckoutIdentity({ mainRoot: root }) });
  const journal = (flowManager = manager, snapshot = null) => new PromptExecutionJournal({ scope, snapshot, writer: writer(flowManager, snapshot) });
  const reload = () => new FlowManager({ root, mainRoot: root, inWorktree: false });
  return { root, manager, specId, contract, limit, plan, scope, writer, journal, reload, owned };
}
async function execute(value, journal, provider) {
  const episode = value.manager.readPromptExecutionEpisode({ executionContract: value.contract });
  return new PromptBatchExecutor({ executionBudget: PromptExecutionBudget.fromSnapshot(value.limit, episode.budget) })
    .executeCompletions({ plan: value.plan, executionJournal: journal, responseContract: { parse: (raw) => raw, itemCount: () => 1 }, callAgent: provider });
}
async function runtimeFor(t, value) {
  const runtime = await ProcessExecutionRuntime.acquire({ mainRoot: value.root, runId: value.contract.runId, specId: value.specId });
  value.owned.runtime = runtime;
  return runtime;
}
function provider({ bindingChange = null, physicalMismatch = false, fail = false, afterStop = null } = {}) {
  return async (_request, _batch, _retry, _protocolContext, admission) => {
    admission.claim();
    const context = new AgentProviderAttemptContext({ attemptId: crypto.randomUUID(), logicalInvocationId: admission.invocation.logicalInvocationId,
      commandId: "prompt.stop.test", provider: "node", profileKey: "local", attemptIndex: 0, maxAttempts: 1, inputCharacters: 7, invocation: admission.invocation });
    await admission.beforeProviderAttempt(context);
    const identity = admission.processExecutionIdentity.toJSON();
    if (physicalMismatch) identity.providerAttemptId = crypto.randomUUID();
    const binding = bindingChange === null ? admission.processExecutionBinding : new ProcessExecutionBinding({ ...admission.processExecutionBinding.toJSON(), ...bindingChange });
    const result = await executeManagedProcess(process.execPath, ["-e", fail ? "process.exitCode = 1; process.stderr.write('failed')" : "process.stdout.write('answer')"], {
      timeoutMs: 10000, graceMs: 100, maxBuffer: 1024, kind: "provider", commandId: context.commandId,
      providerAttemptId: context.attemptId, logicalInvocationId: context.logicalInvocationId,
      providerAttemptContext: context.toJSON(), promptProcessIdentity: identity,
      processExecutionBinding: binding,
      onProcessExecutionStop: (receipt) => admission.observeProcessStop(receipt, context),
    });
    if (afterStop) await afterStop(admission);
    if (fail) {
      const failure = new UnclassifiedProviderExitFailure({ attemptCount: 1, maxAttempts: 1,
        providerCompletionEvidence: new AgentProviderCompletionEvidence({ provider: "node", profile: "local", exitCode: result.code,
          stdout: result.stdout, stderr: result.stderr, attemptCount: 1, maxAttempts: 1, processTreeQuiescence: "confirmed" }) });
      await admission.afterProviderFailure(failure, { attempt: 1, maxAttempts: 1 });
      throw failure;
    }
    return result.stdout;
  };
}

test("canonical managed Prompt stop is saved before response, retains budget, and reloads through Store CAS", async (t) => {
  const value = fixture(t), runtime = await runtimeFor(t, value);
  let staleWriter = null, stoppedSnapshot = null;
  await runtime.enter(() => execute(value, value.journal(), provider({ afterStop() {
    stoppedSnapshot = value.manager.readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope });
    const batch = stoppedSnapshot.batches[0];
    assert.equal(batch.claim.transportOrdinal, 1);
    assert.equal(stoppedSnapshot.budget.providerCallCount, 1);
    assert.equal(stoppedSnapshot.budget.aggregateCharacters, 0);
    assert.equal(batch.processStops.length, 1);
    const observation = PromptProcessStopObservation.fromJSON(batch.processStops[0]);
    observation.identity.assertClaim(batch.claim);
    staleWriter = value.writer(value.manager, stoppedSnapshot);
  } })));
  const restarted = value.reload();
  const saved = restarted.readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope });
  assert.equal(saved.batches[0].claim, null);
  assert.equal(saved.batches[0].completion.response, "answer");
  assert.deepEqual(saved.batches[0].processStops, stoppedSnapshot.batches[0].processStops);
  const foreignCheckout = path.join(value.root, "other-checkout");
  fs.mkdirSync(foreignCheckout);
  const foreignIdentity = captureProcessExecutionCheckoutIdentity({ mainRoot: value.root, executionRoot: foreignCheckout });
  assert.throws(() => restarted.readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope, checkoutIdentity: foreignIdentity }), { code: "PROCESS_EXECUTION_STOP_CHECKOUT_MISMATCH" });
  const before = restarted.activityLedger(value.specId).length;
  await assert.rejects(staleWriter.save(new PromptExecutionJournalRecord({ event: "process-stopped", snapshot: stoppedSnapshot })), { code: "FLOW_EXECUTION_CONTRACT_MISMATCH" });
  assert.equal(restarted.activityLedger(value.specId).length, before);
});

test("confirmed stop alone leaves the Prompt claim uncertain and cannot cause replay or retry", async (t) => {
  const value = fixture(t), runtime = await runtimeFor(t, value);
  await assert.rejects(runtime.enter(() => execute(value, value.journal(), provider({ afterStop() { throw new Error("lost-response-after-stop"); } }))));
  const restarted = value.reload();
  const saved = restarted.readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope });
  assert.equal(saved.batches[0].claim.transportOrdinal, 1);
  assert.equal(saved.batches[0].processStops.length, 1);
  const before = restarted.activityLedger(value.specId).length;
  await assert.rejects(execute(value, value.journal(restarted, saved), () => assert.fail("unsettled claim retried")), { code: "PROMPT_EXECUTION_UNCERTAIN" });
  assert.equal(restarted.activityLedger(value.specId).length, before);
});

test("ordinary transport failure retains the saved physical stop observation without another claim", async (t) => {
  const value = fixture(t), runtime = await runtimeFor(t, value);
  await assert.rejects(runtime.enter(() => execute(value, value.journal(), provider({ fail: true }))));
  const saved = value.reload().readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope });
  assert.equal(saved.batches[0].claim, null);
  assert.equal(saved.batches[0].transportFailures.length, 1);
  assert.equal(saved.batches[0].processStops.length, 1);
  assert.equal(saved.budget.providerCallCount, 1);
});

test("wrong physical, contract, and old Attempt receipts fail before canonical stop or response publication", async (t) => {
  for (const [name, input] of [["physical", { physicalMismatch: true }], ["contract", { bindingChange: { executionContractId: "wrong-contract" } }], ["old-attempt", { bindingChange: { attemptId: "old-attempt" } }]]) {
    await t.test(name, async (t) => {
      const value = fixture(t), runtime = await runtimeFor(t, value);
      await assert.rejects(runtime.enter(() => execute(value, value.journal(), provider(input))), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED");
      const saved = value.reload().readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope });
      assert.equal(saved.batches[0].claim.transportOrdinal, 1);
      assert.equal(saved.batches[0].processStops, undefined);
      assert.equal(saved.batches[0].responses.length, 0);
      assert.equal(saved.budget.providerCallCount, 1);
    });
  }
});

test("stop observation Store save failure preserves the claim and physical receipt without semantic settlement", async (t) => {
  const value = fixture(t), runtime = await runtimeFor(t, value);
  const prototype = Object.getPrototypeOf(value.manager._store), original = prototype.savePromptExecutionProgress;
  const mock = t.mock.method(prototype, "savePromptExecutionProgress", function(input) {
    if (input.record.event === "process-stopped") throw new Error("stop-observation-store-unavailable");
    return original.call(this, input);
  });
  await assert.rejects(runtime.enter(() => execute(value, value.journal(), provider())), (error) => error instanceof ProcessExecutionControlFailure && error.code === "PROCESS_EXECUTION_RECEIPT_DELIVERY_FAILED");
  mock.mock.restore();
  const saved = value.reload().readPromptExecutionProgress({ executionContract: value.contract, scope: value.scope });
  assert.equal(saved.batches[0].claim.transportOrdinal, 1);
  assert.equal(saved.batches[0].processStops, undefined);
  assert.equal(saved.batches[0].responses.length, 0);
  assert.equal(runtime.inspect().executions[0].calls[0].receipt.stopEvidence.status, "confirmed");
  await assert.rejects(execute(value, value.journal(value.reload(), saved), () => assert.fail("save failure started another provider")), { code: "PROMPT_EXECUTION_UNCERTAIN" });
});
