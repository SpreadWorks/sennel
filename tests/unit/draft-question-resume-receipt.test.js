import assert from "node:assert/strict";
import test from "node:test";

import {
  DraftQuestionResolutionIdentity,
  DraftQuestionResumeReceipt,
} from "../../src/flow/lib/draft-question-resume-receipt.js";

function receipt() {
  return new DraftQuestionResumeReceipt({
    binding: {
      runId: "run-draft-resume",
      specId: "001-draft-resume",
      stepId: "draft-refine",
      attemptId: "attempt-draft-refine-1",
      attemptSequence: 1,
    },
    awaitReceiptId: "a".repeat(64),
    questionId: "q1",
    questionRevision: 2,
    resolution: DraftQuestionResolutionIdentity.answer({
      answer: "Keep the selected public behavior.",
      why: "The user selected this behavior.",
      considered: "A private representation was rejected.",
    }),
    sourceDigest: "b".repeat(64),
    sourceByteLength: 512,
    outputDigest: "c".repeat(64),
  });
}

test("Draft question resume receipt round-trips its exact durable schema", () => {
  const original = receipt();
  const restored = DraftQuestionResumeReceipt.fromJSON(original.toJSON());

  assert.deepEqual(restored.toJSON(), original.toJSON());
  assert.equal(restored.resolution instanceof DraftQuestionResolutionIdentity, true);
});

test("Draft question resume receipt rejects unknown durable fields", () => {
  const stored = receipt().toJSON();

  assert.throws(
    () => DraftQuestionResumeReceipt.fromJSON({ ...stored, legacyStatus: "answered" }),
    /stored Draft resume receipt has invalid fields/,
  );
  assert.throws(
    () => DraftQuestionResumeReceipt.fromJSON({
      ...stored,
      binding: { ...stored.binding, generation: 1 },
    }),
    /stored Draft resume binding has invalid fields/,
  );
  assert.throws(
    () => DraftQuestionResumeReceipt.fromJSON({
      ...stored,
      resolution: { ...stored.resolution, note: "ignored" },
    }),
    /stored Draft answer resolution has invalid fields/,
  );
  assert.throws(
    () => DraftQuestionResolutionIdentity.fromJSON({
      kind: "discard",
      reason: "Out of scope.",
      note: "ignored",
    }),
    /stored Draft discard resolution has invalid fields/,
  );
});
