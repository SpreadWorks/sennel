import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DraftAwaitQuestionIdentity,
  DraftStepExecutionIdentity,
  DraftRefineStepState,
  DraftStepExecutionLifecycle,
  DraftStepSettlementPublication,
  DraftStepSettlementReceipt,
  DraftStepSettlementReceiptValue,
  DraftWorkerExecutionBinding,
  settleDraftStepResult,
} from "../../src/flow/definition.js";
import {
  DraftRefineAwaitingAnswerResult,
  DraftRefineCompletedResult,
  DraftRefineWorkerRequiredResult,
} from "../../src/flow/engine/step-result.js";
import {
  DraftQuestionResolutionIdentity,
  DraftQuestionResumeReceipt,
} from "../../src/flow/lib/draft-question-resume-receipt.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function binding(overrides = {}) {
  return {
    runId: "run-1",
    specId: "001-draft-refine-state",
    stepId: "draft-refine",
    attempt: { id: "attempt-1", nodeId: "draft-refine", sequence: 1 },
    ...overrides,
  };
}

function settlementReceipt(result, { awaitQuestion = null, executionLifecycle = null } = {}) {
  return new DraftStepSettlementReceipt({
    binding: binding(),
    result,
    settlement: settleDraftStepResult(result.stepId, result),
    publication: new DraftStepSettlementPublication({ artifact: "draft" }),
    executionLifecycle,
    awaitQuestion,
  });
}

test("DraftRefineStepState projects unselected, execution, Await, and resumed semantics", () => {
  const unselected = new DraftRefineStepState({ binding: binding() });
  assert.equal(unselected.requiresStepSelection, true);
  assert.equal(unselected.executionIdentity(), null);
  assert.equal(unselected.awaitQuestionIdentity(), null);
  assert.equal(unselected.dispositionForQuestion(), null);

  const workerResult = new DraftRefineWorkerRequiredResult();
  const workerReceipt = settlementReceipt(workerResult, {
    executionLifecycle: DraftStepExecutionLifecycle.checkpoint(new DraftWorkerExecutionBinding({
      executionGeneration: 0,
      inputDigest: DIGEST_A,
      inputRevision: DIGEST_B,
    })),
  });
  const executing = new DraftRefineStepState({ binding: binding(), settlement: workerReceipt });
  const executionIdentity = executing.executionIdentity();
  assert.equal(executing.requiresStepSelection, false);
  assert.equal(executionIdentity instanceof DraftStepExecutionIdentity, true);
  assert.equal(executionIdentity.receiptId, workerReceipt.id);
  assert.equal(executionIdentity.stepResult instanceof DraftRefineWorkerRequiredResult, true);
  assert.equal(executionIdentity.settlement.kind, "execution");
  assert.equal(executing.dispositionForQuestion().operation, "execute-worker");

  const awaitQuestion = new DraftAwaitQuestionIdentity({
    questionId: "q1",
    questionRevision: 3,
    sourceDigest: DIGEST_A,
    sourceByteLength: 42,
  });
  const awaitResult = new DraftRefineAwaitingAnswerResult();
  const awaitReceipt = settlementReceipt(awaitResult, { awaitQuestion });
  const awaiting = new DraftRefineStepState({ binding: binding(), settlement: awaitReceipt });
  assert.equal(awaitReceipt instanceof DraftStepSettlementReceiptValue, true);
  assert.deepEqual(awaiting.awaitQuestionIdentity().toJSON(), awaitQuestion.toJSON());
  assert.equal(awaiting.awaitReceiptFor({ questionId: "q1", questionRevision: 3 }), awaitReceipt);
  assert.equal(awaiting.awaitReceiptFor({ questionId: "q1", questionRevision: 4 }), null);
  assert.deepEqual(awaiting.dispositionForQuestion({
    id: "q1",
    revision: 3,
    question: "Which behavior should be public?",
  }).toJSON(), {
    stepId: "draft-refine",
    operation: "await-user-answer",
    questionId: "q1",
    question: "Which behavior should be public?",
    questionRevision: 3,
  });

  const autoReselected = new DraftRefineStepState({
    binding: binding(),
    settlement: awaitReceipt,
    autoApprove: true,
  });
  assert.equal(autoReselected.requiresStepSelection, true);
  assert.equal(autoReselected.awaitQuestionIdentity(), null);
  assert.equal(autoReselected.dispositionForQuestion(), null);

  const resume = new DraftQuestionResumeReceipt({
    binding: awaitReceipt.binding,
    awaitReceiptId: awaitReceipt.id,
    questionId: "q1",
    questionRevision: 3,
    resolution: DraftQuestionResolutionIdentity.answer({
      answer: "Keep the public behavior.",
      why: "It matches the request.",
    }),
    sourceDigest: DIGEST_A,
    sourceByteLength: 42,
    outputDigest: DIGEST_C,
  });
  const resumed = new DraftRefineStepState({
    binding: binding(),
    settlement: awaitReceipt,
    resume,
    resumeAfterSettlement: true,
  });
  assert.equal(resumed.requiresStepSelection, true);
  assert.equal(resumed.resumeReceiptId, resume.id);
  assert.equal(resumed.awaitQuestionIdentity(), null);
  assert.equal(resumed.dispositionForQuestion(), null);
});

test("DraftRefineStepState rejects mismatched binding, Result pairs, and resume ordering", () => {
  const awaitQuestion = new DraftAwaitQuestionIdentity({
    questionId: "q1",
    questionRevision: 3,
    sourceDigest: DIGEST_A,
    sourceByteLength: 42,
  });
  const awaitReceipt = settlementReceipt(new DraftRefineAwaitingAnswerResult(), { awaitQuestion });
  const resume = new DraftQuestionResumeReceipt({
    binding: awaitReceipt.binding,
    awaitReceiptId: awaitReceipt.id,
    questionId: "q1",
    questionRevision: 3,
    resolution: DraftQuestionResolutionIdentity.discard("The decision is outside this scope."),
    sourceDigest: DIGEST_A,
    sourceByteLength: 42,
    outputDigest: DIGEST_B,
  });

  assert.throws(() => new DraftRefineStepState({
    binding: binding({ specId: "002-other" }),
    settlement: awaitReceipt,
  }), /does not match its Attempt binding/);
  assert.throws(() => new DraftRefineStepState({
    binding: binding(),
    settlement: settlementReceipt(new DraftRefineCompletedResult()),
  }), /no resumable persisted Step Result/);
  assert.throws(() => new DraftRefineStepState({
    binding: binding(),
    settlement: awaitReceipt,
    resume,
    resumeAfterSettlement: false,
  }), /resume ordering/);
});

test("DraftRefineStepState equality binds selection to the exact Attempt and latest settlement and answer", () => {
  const unselected = new DraftRefineStepState({ binding: binding() });
  assert.equal(unselected.equals(new DraftRefineStepState({ binding: binding() })), true);
  assert.equal(unselected.equals(null), false);
  assert.equal(unselected.equals({ binding: unselected.binding }), false);
  for (const changed of [
    binding({ runId: "run-2" }),
    binding({ specId: "002-draft-refine-state" }),
    binding({ attempt: { id: "attempt-2", nodeId: "draft-refine", sequence: 1 } }),
    binding({ attempt: { id: "attempt-1", nodeId: "draft-refine", sequence: 2 } }),
  ]) {
    assert.equal(unselected.equals(new DraftRefineStepState({ binding: changed })), false);
  }
  const awaitReceipt = (questionRevision) => settlementReceipt(new DraftRefineAwaitingAnswerResult(), {
    awaitQuestion: new DraftAwaitQuestionIdentity({ questionId: "q1", questionRevision,
      sourceDigest: DIGEST_A, sourceByteLength: 42 }),
  });
  const firstAwait = awaitReceipt(3);
  const nextAwait = awaitReceipt(4);
  const awaiting = new DraftRefineStepState({ binding: binding(), settlement: firstAwait });
  assert.equal(awaiting.equals(new DraftRefineStepState({ binding: binding(), settlement: awaitReceipt(3) })), true);
  assert.equal(awaiting.equals(new DraftRefineStepState({ binding: binding(), settlement: nextAwait })), false);
  const autoSelected = new DraftRefineStepState({ binding: binding(), settlement: firstAwait, autoApprove: true });
  assert.equal(autoSelected.requiresStepSelection, true);
  assert.equal(autoSelected.equals(awaiting), false, "the same Await can require a different semantic selection");
  assert.equal(autoSelected.equals(unselected), false, "matching Step-selection semantics cannot erase the latest receipt");
  const resume = (receipt, answer) => new DraftQuestionResumeReceipt({ binding: receipt.binding,
    awaitReceiptId: receipt.id, questionId: "q1", questionRevision: receipt.awaitQuestion.questionRevision,
    resolution: DraftQuestionResolutionIdentity.answer({ answer, why: "The current user decision." }),
    sourceDigest: DIGEST_A, sourceByteLength: 42, outputDigest: DIGEST_C });
  const resumed = new DraftRefineStepState({ binding: binding(), settlement: firstAwait,
    resume: resume(firstAwait, "Keep the public behavior."), resumeAfterSettlement: true });
  const sameAnswer = new DraftRefineStepState({ binding: binding(), settlement: awaitReceipt(3),
    resume: resume(firstAwait, "Keep the public behavior."), resumeAfterSettlement: true });
  const differentAnswer = new DraftRefineStepState({ binding: binding(), settlement: firstAwait,
    resume: resume(firstAwait, "Change the public behavior."), resumeAfterSettlement: true });
  assert.equal(resumed.equals(sameAnswer), true);
  assert.equal(sameAnswer.equals(resumed), true);
  assert.equal(resumed.equals(autoSelected), false, "the exact answer receipt remains part of Step-selection authority");
  assert.equal(resumed.equals(differentAnswer), false, "the same Attempt and selection cannot reuse a different answer receipt");
  const workerReceipt = (executionGeneration) => settlementReceipt(new DraftRefineWorkerRequiredResult(), {
    executionLifecycle: DraftStepExecutionLifecycle.checkpoint(new DraftWorkerExecutionBinding({
      executionGeneration, inputDigest: DIGEST_A, inputRevision: DIGEST_B })),
  });
  const executing = new DraftRefineStepState({ binding: binding(), settlement: workerReceipt(0) });
  assert.equal(executing.equals(new DraftRefineStepState({ binding: binding(), settlement: workerReceipt(0) })), true);
  assert.equal(executing.equals(new DraftRefineStepState({ binding: binding(), settlement: workerReceipt(1) })), false);
});
