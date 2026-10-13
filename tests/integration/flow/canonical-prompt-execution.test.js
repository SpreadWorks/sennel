import assert from "node:assert/strict";
import fs from "node:fs";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowAtStepFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { DraftRefineWorkerRequiredResult, StepErrorResult } from "../../../src/flow/engine/step-result.js";
import { settleDraftStepResult, DraftWorkerExecutionClaim } from "../../../src/flow/definition.js";
import { FlowExecutionContract, FlowExecutionContractRefusal, FlowExecutionInputBaseline } from "../../../src/flow/lib/flow-execution-contract.js";
import { CanonicalPromptExecutionJournalWriter } from "../../../src/flow/lib/canonical-prompt-execution-writer.js";
import { PromptExecutionJournal, PromptExecutionScope } from "../../../src/lib/prompt-execution-journal.js";
import { PromptRequestEnvelope, PromptInputBuilder, PromptRequestLimit, RangedTextPromptElement,
  PromptBatchPlan, PromptBatchExecutor, PromptExecutionLimit, PromptExecutionBudget } from "../../../src/lib/prompt-batching.js";

class Envelope extends PromptRequestEnvelope {
  constructor() { super({ revision: "test" }); }
  build(elements) { return { userPrompt: elements.map((entry) => entry.toPromptText()).join(""), systemPrompt: null, jsonSchema: null, fmtFallback: null }; }
}
function fixture(t, { captureInput = false } = {}) {
  const root = createTmpDir("canonical-prompt-execution-");
  t.after(() => removeTmpDir(root));
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const specId = "001-contract";
  new FlowAtStepFixture({ flowManager: manager, specId, runId: "run-contract", request: "Durable execution", targetStep: "draft-refine" }).create();
  const state = manager.canonicalState(specId);
  const binding = { runId: state.runId, specId, stepId: "draft-refine", attempt: state.attempt };
  const required = new DraftRefineWorkerRequiredResult();
  const settlement = settleDraftStepResult(required.stepId, required);
  const executionBinding = manager.draftStepExecutionState({ binding }).workerBinding({ inputDigest: "a".repeat(64), inputRevision: "b".repeat(64) });
  manager.checkpointDraftStepExecution({ binding, stepResult: required, settlement, executionBinding });
  let inputBaselines = [], draftInput = null;
  if (captureInput) {
    manager.publishArtifacts({ specId, nodeId: "draft-refine", artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(canonicalDraftDocument())) }] });
    draftInput = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" });
    inputBaselines = [new FlowExecutionInputBaseline({ descriptor: draftInput.descriptor })];
  }
  const limit = new PromptExecutionLimit({ maxProviderCallCount: 2 });
  const executionContract = FlowExecutionContract.fromBinding({ binding, generation: executionBinding.executionGeneration,
    inputRevision: executionBinding.inputRevision, promptDigest: "c".repeat(64), schemaDigest: "d".repeat(64), executionLimit: { ...limit }, inputBaselines });
  const claim = new DraftWorkerExecutionClaim({ dispatchInvocationId: "dispatch-1", generatedAt: "2026-09-20T01:02:03.000Z", actionDigest: "e".repeat(64), requestDigest: "f".repeat(64) });
  manager.claimDraftStepExecution({ binding, stepResult: required, settlement, executionBinding, executionClaim: claim, executionContract });
  const envelope = new Envelope(), requestLimit = new PromptRequestLimit({ maxCharacters: 40 });
  const builder = new PromptInputBuilder({ envelope, limit: requestLimit });
  builder.add(new RangedTextPromptElement({ id: "one", sourceRevision: "revision", sequence: 0, text: "payload" }));
  const plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit: requestLimit });
  const scope = new PromptExecutionScope({ stage: "map" });
  const journal = (flowManager = manager, snapshot = null) => new PromptExecutionJournal({ scope, snapshot,
    writer: new CanonicalPromptExecutionJournalWriter({ flowManager, executionContract, scope, snapshot }) });
  return { root, manager, binding, executionContract, limit, plan, scope, journal, draftInput };
}
async function execute(value, journal, callAgent) {
  const episode = value.manager.readPromptExecutionEpisode({ executionContract: value.executionContract });
  const executionBudget = PromptExecutionBudget.fromSnapshot(value.limit, episode.budget);
  return new PromptBatchExecutor({ executionLimit: value.limit, executionBudget }).executeCompletions({ plan: value.plan, executionJournal: journal,
    responseContract: { parse: (raw) => raw, itemCount: () => 1 }, callAgent });
}
async function response(_request, _batch, _retry, _context, admission) {
  admission.claim(); await admission.beforeProviderAttempt({ attempt: 1, maxAttempts: 1, providerKey: "fake", profileKey: "test" }); return "answer";
}

test("canonical contract and ordered provider checkpoints reload without duplicate calls or budget resets", async (t) => {
  const value = fixture(t);
  await execute(value, value.journal(), response);
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  assert.equal(restarted.readExecutionContract({ executionContract: value.executionContract }).id, value.executionContract.id);
  const episode = restarted.readPromptExecutionEpisode({ executionContract: value.executionContract });
  assert.equal(episode.scopes.length, 1); assert.equal(episode.budget.providerCallCount, 1);
  assert.equal(episode.scopes[0].batches[0].completion.response, "answer");
  const before = restarted.activityLedger(value.executionContract.specId).length;
  await execute(value, value.journal(restarted, episode.scopes[0]), () => assert.fail("completed batch invoked provider"));
  assert.equal(restarted.activityLedger(value.executionContract.specId).length, before);
  const changed = new FlowExecutionContract({ ...value.executionContract.toJSON(), inputRevision: "different" });
  assert.throws(() => restarted.readExecutionContract({ executionContract: changed }), FlowExecutionContractRefusal);
  assert.equal(restarted.activityLedger(value.executionContract.specId).length, before);
});

test("uncertain durable claim refuses automatic retry and preserves consumed budget", async (t) => {
  const value = fixture(t);
  await assert.rejects(execute(value, value.journal(), async (...args) => { await response(...args); throw new Error("lost response"); }));
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const snapshot = restarted.readPromptExecutionProgress({ executionContract: value.executionContract, scope: value.scope });
  assert.equal(snapshot.budget.providerCallCount, 1); assert.ok(snapshot.batches[0].claim);
  const before = restarted.activityLedger(value.executionContract.specId).length;
  await assert.rejects(execute(value, value.journal(restarted, snapshot), () => assert.fail("uncertain call retried")), { code: "PROMPT_EXECUTION_UNCERTAIN" });
  assert.equal(restarted.activityLedger(value.executionContract.specId).length, before);
});

test("exact Store event readback recovers lost acknowledgement and competing writer is refused before provider", async (t) => {
  const value = fixture(t);
  const prototype = Object.getPrototypeOf(value.manager._store);
  const original = prototype.publishArtifacts;
  const mocked = t.mock.method(prototype, "publishArtifacts", function (input) { original.call(this, input); throw new Error("ACK lost"); });
  await execute(value, value.journal(), response);
  mocked.mock.restore();
  let calls = 0;
  await assert.rejects(execute(value, value.journal(), async (...args) => { calls++; return response(...args); }), FlowExecutionContractRefusal);
  assert.equal(calls, 0);
  const episode = value.manager.readPromptExecutionEpisode({ executionContract: value.executionContract });
  assert.equal(episode.budget.providerCallCount, 1);
});

test("response persisted before failed validation is reparsed after reload without another provider claim", async (t) => {
  const value = fixture(t);
  const prototype = Object.getPrototypeOf(value.manager._store);
  const original = prototype.savePromptExecutionProgress;
  const mocked = t.mock.method(prototype, "savePromptExecutionProgress", function (input) {
    if (input.record.event === "validated") throw new Error("validation persistence unavailable");
    return original.call(this, input);
  });
  await assert.rejects(execute(value, value.journal(), response), /validation persistence unavailable/);
  mocked.mock.restore();
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const snapshot = restarted.readPromptExecutionProgress({ executionContract: value.executionContract, scope: value.scope });
  assert.equal(snapshot.batches[0].claim, null);
  assert.equal(snapshot.batches[0].completion, null);
  assert.equal(snapshot.batches[0].responses[0].raw, "answer");
  await execute(value, value.journal(restarted, snapshot), () => assert.fail("saved response called provider"));
  const episode = restarted.readPromptExecutionEpisode({ executionContract: value.executionContract });
  assert.equal(episode.budget.providerCallCount, 1);
  assert.equal(episode.scopes[0].batches[0].completion.response, "answer");
});

test("cache responses save origin and validated accounting without physical provider claims", async (t) => {
  const value = fixture(t);
  await execute(value, value.journal(), async (_request, _batch, _retry, _context, admission) => {
    admission.claim(); admission.recordCacheHit({ providerKey: "fake", profileKey: "test" }); return "cached";
  });
  const episode = value.manager.readPromptExecutionEpisode({ executionContract: value.executionContract });
  assert.equal(episode.budget.providerCallCount, 0);
  assert.equal(episode.scopes[0].batches[0].responses[0].origin, "cache");
  assert.equal(episode.scopes[0].batches[0].transportOrdinal, 0);
  assert.deepEqual(episode.scopes[0].batches[0].completion.executionAccounting, { responseCallCount: 1, providerAttemptCount: 0 });
});

test("two-batch provider cap survives interrupted next claim and only the uncompleted batch resumes", async (t) => {
  const value = fixture(t);
  const envelope = new Envelope(), limit = new PromptRequestLimit({ maxCharacters: 40 });
  const builder = new PromptInputBuilder({ envelope, limit });
  for (const [sequence, id] of ["first", "second"].entries()) builder.add(new RangedTextPromptElement({ id, sourceRevision: "revision", sequence, text: id.repeat(5) }));
  value.plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
  assert.equal(value.plan.batches.length, 2);
  const prototype = Object.getPrototypeOf(value.manager._store), original = prototype.savePromptExecutionProgress;
  const mocked = t.mock.method(prototype, "savePromptExecutionProgress", function (input) {
    if (input.record.event === "claimed" && input.record.snapshot.budget.providerCallCount === 2) throw new Error("second claim unavailable");
    return original.call(this, input);
  });
  let calls = 0;
  const provider = async (...args) => { const result = await response(...args); calls++; return result; };
  await assert.rejects(execute(value, value.journal(), provider), /second claim unavailable/);
  mocked.mock.restore();
  assert.equal(calls, 1);
  const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
  const snapshot = restarted.readPromptExecutionProgress({ executionContract: value.executionContract, scope: value.scope });
  assert.equal(snapshot.budget.providerCallCount, 1);
  assert.equal(snapshot.batches[0].completion.response, "answer"); assert.equal(snapshot.batches[1].completion, null);
  await execute(value, value.journal(restarted, snapshot), provider);
  assert.equal(calls, 2);
  const episode = restarted.readPromptExecutionEpisode({ executionContract: value.executionContract });
  assert.equal(episode.budget.providerCallCount, 2);
  assert.equal(episode.scopes[0].batches.filter((entry) => entry.completion !== null).length, 2);
});


test("same-byte input republication changes producer identity and rejects progress without consuming budget", async (t) => {
  const value = fixture(t, { captureInput: true });
  const required = new DraftRefineWorkerRequiredResult();
  value.manager.settleDraftStepResult({ binding: value.binding, stepResult: required,
    settlement: settleDraftStepResult("draft-refine", required), executionContract: value.executionContract,
    lifecycleResult: { outcome: "incomplete", summary: "saved execution response", confirmedAt: "2026-09-20T01:03:00.000Z", artifactRefs: [] } });
  const read = value.manager.readStoredExecutionContract({ binding: value.binding, generation: value.executionContract.generation });
  assert.equal(read.inputBaselines.length, 1);
  value.manager.publishArtifacts({ specId: value.executionContract.specId, nodeId: "draft-refine",
    artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: value.draftInput.bytes }] });
  const before = value.manager.canonicalState(value.executionContract.specId).toJSON();
  const activities = value.manager.activityLedger(value.executionContract.specId).length;
  const changed = value.manager.readArtifact({ specId: value.executionContract.specId, logicalKey: "draft", consumerNodeId: "draft-questions-review" });
  assert.equal(changed.descriptor.hash, value.draftInput.descriptor.hash);
  assert.notEqual(changed.descriptor.activityId, value.draftInput.descriptor.activityId);
  await assert.rejects(execute(value, value.journal(), () => assert.fail("changed input started provider")), { code: "FLOW_EXECUTION_INPUT_BASELINE_CHANGED" });
  assert.deepEqual(value.manager.canonicalState(value.executionContract.specId).toJSON(), before);
  assert.equal(value.manager.activityLedger(value.executionContract.specId).length, activities);
  const result = new StepErrorResult("draft-refine", new Error("invalid response"));
  assert.throws(() => value.manager.settleDraftStepResult({ binding: value.binding, stepResult: result,
    settlement: settleDraftStepResult("draft-refine", result), executionContract: value.executionContract }),
  { code: "FLOW_EXECUTION_INPUT_BASELINE_CHANGED" });
  assert.deepEqual(value.manager.canonicalState(value.executionContract.specId).toJSON(), before);
  assert.equal(value.manager.activityLedger(value.executionContract.specId).length, activities);
});


test("supported final receipt replays before checking an old input producer baseline", async (t) => {
  const value = fixture(t, { captureInput: true });
  const required = new DraftRefineWorkerRequiredResult();
  value.manager.settleDraftStepResult({ binding: value.binding, stepResult: required,
    settlement: settleDraftStepResult("draft-refine", required), executionContract: value.executionContract,
    lifecycleResult: { outcome: "incomplete", summary: "saved execution response", confirmedAt: "2026-09-20T01:03:00.000Z", artifactRefs: [] } });
  const result = new StepErrorResult("draft-refine", new Error("terminal invalid response"));
  const input = { binding: value.binding, stepResult: result, settlement: settleDraftStepResult("draft-refine", result),
    executionContract: value.executionContract };
  const completed = value.manager.commitDraftStepResult(input);
  value.manager.publishArtifacts({ specId: value.executionContract.specId, nodeId: "draft-refine",
    artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: value.draftInput.bytes }] });
  const before = value.manager.activityLedger(value.executionContract.specId).length;
  const replay = value.manager.commitDraftStepResult(input);
  assert.equal(replay.receipt.id, completed.receipt.id);
  assert.equal(value.manager.activityLedger(value.executionContract.specId).length, before);
});


for (const missing of ["prompt.execution.budget", "prompt.execution.progress"]) {
  test(`missing ${missing} after provider completion refuses re-entry instead of restoring zero counters`, async (t) => {
    const value = fixture(t);
    assert.equal(value.manager.readPromptExecutionEpisode({ executionContract: value.executionContract }).budget.providerCallCount, 0);
    await execute(value, value.journal(), response);
    const catalog = value.manager.artifactCatalog(value.executionContract.specId);
    const omitted = new FlowArtifactCatalog({ artifacts: catalog.artifacts.filter((entry) => entry.logicalKey !== missing) });
    // Malformed catalog input is intentional here: ordinary producers cannot
    // remove execution authority through their publication API.
    const location = value.manager.specLocation(value.executionContract.specId);
    for (const descriptor of catalog.artifacts.filter((entry) => entry.logicalKey === missing)) fs.unlinkSync(location.resolve(descriptor.relativePath));
    fs.writeFileSync(location.catalogFile, JSON.stringify(omitted.toJSON()));
    const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false });
    const before = restarted.canonicalState(value.executionContract.specId).toJSON();
    const activities = restarted.activityLedger(value.executionContract.specId).length;
    assert.throws(() => restarted.readPromptExecutionEpisode({ executionContract: value.executionContract }), FlowExecutionContractRefusal);
    await assert.rejects(execute({ ...value, manager: restarted }, value.journal(restarted), () => assert.fail("missing authority called provider")), FlowExecutionContractRefusal);
    assert.deepEqual(restarted.canonicalState(value.executionContract.specId).toJSON(), before);
    assert.equal(restarted.activityLedger(value.executionContract.specId).length, activities);
  });
}
