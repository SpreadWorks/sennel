import assert from "node:assert/strict";
import { test } from "node:test";

import { DraftQuestionLedger } from "../../src/flow/lib/draft-question-ledger.js";
import { DraftTransitionFacts } from "../../src/flow/lib/draft-transition-facts.js";
import { DraftTransitionFactsError, readDraftTransitionFacts } from "../../src/flow/lib/draft-transition-facts-reader.js";

const digest = "a".repeat(64);
const document = {
  devType: "feature",
  goal: "Select a Draft transition.",
  analysis: {
    problem: "A question may need an answer.",
    proposedApproach: "Read the canonical ledger.",
    validation: "Select the next action.",
  },
  decisionMap: {
    knownFacts: [], decisionPoints: [], resolvedByProjectRules: [],
    requiresUserJudgment: [], deferredToSpec: [],
  },
  questionLedger: new DraftQuestionLedger({
    revision: 0, publication: "fixture", evidenceDigest: digest, questions: [],
  }).toJSON(),
};

function readerInput(source, status = "pending") {
  return {
    flowManager: {
      readArtifact(input) {
        assert.deepEqual(input, {
          specId: "reader-spec", logicalKey: "draft", consumerNodeId: "draft-refine", optional: true,
        });
        return source;
      },
    },
    flowState: { specId: "reader-spec", steps: [{ id: "draft-refine", status }] },
  };
}

test("Draft transition reader returns null when canonical Draft is absent", () => {
  assert.equal(readDraftTransitionFacts(readerInput(null)), null);
});

test("Draft transition reader preserves canonical source identity and worker status", () => {
  const bytes = Buffer.from(JSON.stringify(document));
  const source = { bytes, descriptor: { hash: digest, size: bytes.length } };
  for (const status of ["pending", "invalidated", "in_progress"]) {
    const facts = readDraftTransitionFacts(readerInput(source, status));
    assert.ok(facts instanceof DraftTransitionFacts);
    assert.equal(facts.workerStatus, status);
    assert.equal(facts.sourceDigest, digest);
    assert.equal(facts.sourceByteLength, bytes.length);
    assert.equal(facts.nextQuestion, null);
    assert.equal(facts.candidateQuestion, null);
  }
});

test("Draft transition reader rejects a lifecycle state that cannot select a transition", () => {
  const bytes = Buffer.from(JSON.stringify(document));
  assert.throws(
    () => readDraftTransitionFacts(readerInput({ bytes, descriptor: { hash: digest, size: bytes.length } }, "done")),
    (error) => error instanceof DraftTransitionFactsError && error.code === "DRAFT_TRANSITION_STATE_INVALID",
  );
});

test("Draft transition reader classifies malformed canonical Draft bytes", () => {
  const bytes = Buffer.from("{invalid json");
  assert.throws(
    () => readDraftTransitionFacts(readerInput({ bytes, descriptor: { hash: digest, size: bytes.length } })),
    (error) => error instanceof DraftTransitionFactsError && error.code === "DRAFT_SCHEMA_INVALID",
  );
});
