import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftRefineStep } from "../../../src/flow/steps/draft/draft-refine.js";
import { StepErrorResult } from "../../../src/flow/engine/step-result.js";
import { DraftAwaitQuestionIdentity, DraftStepExecutionLifecycle, settleDraftStepResult } from "../../../src/flow/definition.js";
import { DraftStepSettlementReceiptValue } from "../../../src/flow/lib/draft-step-settlement-receipt.js";
import { DraftQuestionResolutionIdentity } from "../../../src/flow/lib/draft-question-resume-receipt.js";
import { DraftLifecycle } from "../../../src/flow/lib/draft-lifecycle.js";
import SetDraftAnswerCommand from "../../../src/flow/lib/set-draft-answer.js";
import { AwaitingUserAnswer, CandidateQuestion } from "../../../src/flow/lib/draft-question-ledger.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { prepareDraftService } from "../../support/infrastructure/draft-service.js";
import { completeDraftWorkerThroughStep, prepareConditionalDraftWorkerThroughStep } from "../../support/infrastructure/draft-worker-step.js";
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

test("Draft Step Error replacement renews Await and refuses the old answer receipt before same-Step completion", async (t) => {
  const root = createTmpDir("draft-await-error-replacement-");
  t.after(() => removeTmpDir(root));
  const specId = "001-await-error-replacement";
  let manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({ flowManager: manager, specId, runId: "run-await-error-replacement",
    request: "Authorize a fresh Await after correcting the saved refine error.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  const draft = canonicalDraftDocument({ questions: [new CandidateQuestion({
    id: "q1", question: "Choose the visible behavior?", revision: 3, category: "user-visible-behavior",
    provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64),
  }).toJSON()] });
  manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft",
    mediaType: "application/json", bytes: Buffer.from(`${JSON.stringify(draft, null, 2)}\n`) }] });
  fixture.activate("draft-refine");
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager: manager };
  const execution = await prepareConditionalDraftWorkerThroughStep({ coordinator, ctx,
    state: manager.loadReadOnly(specId), invocation: { id: "await-error-candidate", target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: "draft-refine" } } } });
  fs.writeFileSync(execution.request.payloadPath("draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
  sealWorkerArtifactHandoff({ requestPath: execution.request.requestPath,
    invocationId: execution.request.dispatchInvocationId });
  const promoted = await completeDraftWorkerThroughStep({ coordinator, ctx, request: execution.request });
  assert.equal(promoted.stepResult.kind, "draft-refine-awaiting-answer");
  const binding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-refine" });
  const service = await prepareDraftService({ flowManager: manager, binding });
  const oldAwait = manager.draftRefineStepState({ binding }).awaitReceiptFor({ questionId: "q1", questionRevision: 4 });
  const source = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" });

  // This is an Error persistence boundary; the Step did not generate this error.
  const error = new StepErrorResult("draft-refine", new Error("The selected question could not be processed."));
  await error.persist(service);
  manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const failed = snapshot(manager, specId);
  const failureReceipt = manager.readCurrentStepSettlement({ specId, stepId: "draft-refine" }).receipt;
  assert.equal(failed.state.attempt.failure.category, "step-result-error");
  assert.equal(manager.canonicalState(specId).nextAction().operation, "blocked");
  manager.recoverDraftExecution({ specId, reason: "The question processing cause was corrected.",
    expectedAttempt: manager.canonicalState(specId).attempt });
  manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const replacement = manager.canonicalState(specId).attempt;
  assert.notEqual(replacement.id, binding.attempt.id);
  assert.equal(replacement.sequence, binding.attempt.sequence + 1);
  assert.deepEqual(replacement.consumption.toJSON(), failed.state.attempt.consumption);
  assert.deepEqual(manager.activityLedger(specId).slice(0, failed.activities.length), failed.activities);
  assert.equal(manager.activityLedger(specId).at(-1).transition.draftStepErrorRecoveryReceipt.failureReceiptId,
    failureReceipt.id);
  assert.deepEqual(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-refine" }), source);
  assert.equal(manager.readCurrentStepSettlement({ specId, stepId: "draft-refine" }), null);

  const resolution = DraftQuestionResolutionIdentity.answer({ answer: "Keep the established behavior.", why: "The user selected it." });
  const answerInput = { root, mainRoot: root, executionRoot: root, specId, flowManager: manager,
    flowState: manager.loadReadOnly(specId), questionId: "q1", questionRevision: 4,
    answer: resolution.answer, why: resolution.why };
  const beforeAwait = snapshot(manager, specId);
  const premature = new SetDraftAnswerCommand().execute(answerInput);
  assert.equal(premature.ok, false);
  assert.equal(premature.errors[0].code, "DRAFT_ANSWER_NOT_SELECTED");
  assert.deepEqual(snapshot(manager, specId), beforeAwait);

  const newBinding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-refine" });
  const newService = await prepareDraftService({ flowManager: manager, binding: newBinding });
  assert.equal((await new DraftRefineStep(newService).execute()).kind, "draft-refine-awaiting-answer");
  manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const currentBinding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-refine" });
  const newAwait = manager.draftRefineStepState({ binding: currentBinding })
    .awaitReceiptFor({ questionId: "q1", questionRevision: 4 });
  assert.notEqual(newAwait.id, oldAwait.id);
  assert.equal(newAwait.binding.attemptId, replacement.id);
  assert.equal(newAwait.binding.attemptSequence, replacement.sequence);
  assert.deepEqual(newAwait.awaitQuestion, oldAwait.awaitQuestion);
  const lifecycle = new DraftLifecycle(JSON.parse(source.bytes));
  const answered = lifecycle.withQuestionLedger(lifecycle.questionLedger.answer("q1", 4, {
    answer: resolution.answer, why: resolution.why, considered: resolution.considered,
  }));
  answered.decisionMap.requiresUserJudgment = answered.decisionMap.requiresUserJudgment.filter((id) => id !== "q1");
  assert.deepEqual(new DraftLifecycle(answered).validateForPublication(), []);
  const beforeOldAnswer = snapshot(manager, specId);
  assert.throws(() => manager.recordDraftQuestionResume({
    binding: currentBinding, awaitReceipt: oldAwait, questionId: "q1", questionRevision: 4,
    resolution, source, outputBytes: Buffer.from(`${JSON.stringify(answered, null, 2)}\n`),
  }), (error) => error instanceof CurrentFlowStateConflictError
    && error.message === "Draft resume receipt does not consume this Attempt's Await settlement");
  assert.deepEqual(snapshot(manager, specId), beforeOldAnswer);

  const accepted = new SetDraftAnswerCommand().execute({ ...answerInput, flowManager: manager,
    flowState: manager.loadReadOnly(specId) });
  assert.equal(accepted.status, "answered");
  assert.equal(accepted.replayed, false);
  manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const completionBinding = new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-refine" });
  const completionService = await prepareDraftService({ flowManager: manager, binding: completionBinding });
  assert.equal((await new DraftRefineStep(completionService).execute()).kind, "draft-refine-completed");
  const final = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  assert.equal(final.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
  const terminal = final.activityLedger(specId).findLast((activity) => activity.result?.stepResult?.kind === "draft-refine-completed");
  assert.equal(terminal.result.draftSettlementReceipt.binding.attemptId, replacement.id);
  assert.equal(terminal.result.draftSettlementReceipt.binding.attemptSequence, replacement.sequence);
  assert.equal(JSON.parse(final.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).bytes)
    .questionLedger.questions[0].answer, resolution.answer);
});
