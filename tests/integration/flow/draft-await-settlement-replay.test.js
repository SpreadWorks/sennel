import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { DraftAwaitQuestionIdentity, DraftStepExecutionLifecycle, settleDraftStepResult } from "../../../src/flow/definition.js";
import { DraftStepSettlementReceiptValue } from "../../../src/flow/lib/draft-step-settlement-receipt.js";
import { AwaitingUserAnswer } from "../../../src/flow/lib/draft-question-ledger.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { prepareDraftService } from "../../support/infrastructure/draft-service.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function snapshot(manager, specId) {
  const source = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
  return { state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
    catalog: manager.artifactCatalog(specId).toJSON(), source: source.bytes };
}

function refuses(manager, input) {
  assert.throws(() => manager.commitDraftStepResult(input), (error) => error instanceof StepAdmissionRefusal
    && error.cause instanceof CurrentFlowStateConflictError);
}

test("ordinary Draft Await reuses only the current exact question receipt and never another publication intent", async (t) => {
  const root = createTmpDir("draft-await-exact-replay-");
  t.after(() => removeTmpDir(root));
  const specId = "001-await-exact-replay";
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-await-exact-replay",
    request: "Preserve the exact Await receipt.", execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().activate("draft");
  const draft = canonicalDraftDocument({ questions: [new AwaitingUserAnswer({
    id: "q1", question: "Choose the visible behavior?", revision: 0, category: "user-visible-behavior",
    provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
  }).toJSON()] });
  manager.publishArtifacts({ specId, nodeId: "draft", artifactWrites: [{ logicalKey: "draft",
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(draft, null, 2)}\n`) }] });
  fixture.settle("draft").activate("draft-refine");
  const binding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-refine" });
  const service = await prepareDraftService({ flowManager: manager, binding });
  const result = await new DraftRefineStep(service).execute();
  const facts = service.inspectDraftTransition().facts;
  const awaitQuestion = new DraftAwaitQuestionIdentity({ questionId: facts.nextQuestion.id,
    questionRevision: facts.nextQuestion.revision, sourceDigest: facts.sourceDigest, sourceByteLength: facts.sourceByteLength });
  const input = { binding, stepResult: result, settlement: settleDraftStepResult(result.stepId, result), awaitQuestion };
  const original = manager.readCurrentStepSettlement({ specId, stepId: "draft-refine" }).receipt;
  const before = snapshot(manager, specId);
  const exact = manager.commitDraftStepResult(input).receipt;
  assert.ok(exact instanceof DraftStepSettlementReceiptValue);
  assert.equal(exact.id, original.id);
  assert.equal(exact.publicationDigest, original.publicationDigest);
  assert.deepEqual(exact.toJSON(), original);
  assert.deepEqual(snapshot(manager, specId), before);

  for (const [name, changed] of [
    ["question", { awaitQuestion: new DraftAwaitQuestionIdentity({ ...awaitQuestion.toJSON(), questionId: "q-other" }) }],
    ["source", { awaitQuestion: new DraftAwaitQuestionIdentity({ ...awaitQuestion.toJSON(), sourceDigest: "f".repeat(64) }) }],
    ["Attempt", { binding: { runId: binding.runId, specId, stepId: binding.stepId,
      attempt: { id: `${binding.attempt.id}-other`, nodeId: binding.attempt.nodeId, sequence: binding.attempt.sequence } } }],
  ]) {
    const changedInput = { ...input, ...changed };
    assert.equal(manager.findDraftAwaitSettlementReceipt(changedInput), null, name);
    refuses(manager, changedInput);
    assert.deepEqual(snapshot(manager, specId), before, name);
  }

  const generation = manager.draftStepExecutionState({ binding }).workerBinding({
    inputDigest: facts.sourceDigest, inputRevision: manager.artifactCatalog(specId).hash });
  const lifecycleIntent = DraftStepExecutionLifecycle.checkpoint(generation);
  const latestGenerationInput = { ...input, executionLifecycle: lifecycleIntent };
  assert.throws(() => manager.commitDraftStepResult(latestGenerationInput), /phase|Settlement|settlement/i);
  assert.deepEqual(snapshot(manager, specId), before, "a new generation intent cannot borrow the saved Await");

  const source = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
  for (const publication of [
    { artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: source.bytes }] },
    { artifactRemovals: [{ logicalKey: "tests.source", parameters: { testPath: "fixture.test.js" } }] },
  ]) {
    assert.equal(manager.findStepSettlementReceipt({ ...input, ...publication }), null);
    refuses(manager, { ...input, ...publication });
    assert.deepEqual(snapshot(manager, specId), before, "new artifact intent must not be acknowledged as the old Await");
  }

  manager.publishArtifacts({ specId, nodeId: "draft-refine", artifactWrites: [{ logicalKey: "draft",
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify({ ...draft, goal: "Changed canonical source." }, null, 2)}\n`) }] });
  const changedSource = snapshot(manager, specId);
  assert.notDeepEqual(changedSource.source, before.source);
  assert.equal(manager.findDraftAwaitSettlementReceipt(input), null);
  refuses(manager, input);
  assert.deepEqual(snapshot(manager, specId), changedSource);
});
