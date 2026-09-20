import assert from "node:assert/strict";
import test from "node:test";

import { DraftReviewArtifactDocument } from "../../src/flow/lib/draft-review-artifacts.js";
import { DraftRepairResultFacts } from "../../src/flow/lib/worker-artifact-handoff.js";
import { draftQuestionsReviewResult } from "../../src/flow/steps/draft/draft-questions-review.js";
import { draftCoverageReviewResult } from "../../src/flow/steps/draft/draft-coverage-review.js";
import { draftQuestionsRepairResult } from "../../src/flow/steps/draft/draft-questions-repair.js";
import { draftCoverageRepairResult } from "../../src/flow/steps/draft/draft-coverage-repair.js";
import {
  DraftCoverageRepairChangedResult,
  DraftCoverageRepairUnchangedResult,
  DraftCoverageReviewFindingsResult,
  DraftCoverageReviewPassedResult,
  DraftQuestionsRepairChangedResult,
  DraftQuestionsRepairUnchangedResult,
  DraftQuestionsReviewFindingsResult,
  DraftQuestionsReviewPassedResult,
  DraftStepErrorResult,
} from "../../src/flow/engine/step-result.js";

function reviewFacts(phase, findings = false) {
  return new DraftReviewArtifactDocument({
    phase,
    sourceDraft: "draft.json",
    sourceDraftRevision: {
      version: 1,
      runId: "run-result-factory",
      specId: "001-result-factory",
      sourceStepId: "draft",
      digest: "a".repeat(64),
      byteLength: 100,
      finalizedAt: "2026-09-20T00:00:00.000Z",
    },
    generatedAt: "2026-09-20T00:01:00.000Z",
    ...(findings ? {
      blockingFindings: [{
        title: "Missing decision",
        target: "decisionMap",
        rationale: "The decision is required.",
        evidence: "No decision was recorded.",
      }],
    } : {}),
  });
}

test("Draft Review Result factories map typed PASS, findings, and Error facts without I/O", () => {
  const cases = [
    [draftQuestionsReviewResult, "draft-questions", DraftQuestionsReviewPassedResult, DraftQuestionsReviewFindingsResult],
    [draftCoverageReviewResult, "draft-coverage", DraftCoverageReviewPassedResult, DraftCoverageReviewFindingsResult],
  ];
  for (const [factory, phase, PassedResult, FindingsResult] of cases) {
    assert.equal(factory(reviewFacts(phase)) instanceof PassedResult, true);
    assert.equal(factory(reviewFacts(phase, true)) instanceof FindingsResult, true);
    const error = new Error(`${phase} facts unavailable`);
    const failed = factory(error);
    assert.equal(failed instanceof DraftStepErrorResult, true);
    assert.equal(failed.error.message, error.message);
  }
});

test("Draft Repair Result factories map typed changed, unchanged, and Error facts without I/O", () => {
  const cases = [
    [draftQuestionsRepairResult, "draft-questions-repair", DraftQuestionsRepairChangedResult, DraftQuestionsRepairUnchangedResult],
    [draftCoverageRepairResult, "draft-coverage-repair", DraftCoverageRepairChangedResult, DraftCoverageRepairUnchangedResult],
  ];
  for (const [factory, stepId, ChangedResult, UnchangedResult] of cases) {
    assert.equal(factory(new DraftRepairResultFacts({ stepId, draftChanged: true })) instanceof ChangedResult, true);
    assert.equal(factory(new DraftRepairResultFacts({ stepId, draftChanged: false })) instanceof UnchangedResult, true);
    const error = new Error(`${stepId} facts unavailable`);
    const failed = factory(error);
    assert.equal(failed instanceof DraftStepErrorResult, true);
    assert.equal(failed.error.message, error.message);
  }
});

test("Draft Result factories reject facts typed for a different Step", () => {
  assert.throws(
    () => draftQuestionsRepairResult(new DraftRepairResultFacts({
      stepId: "draft-coverage-repair", draftChanged: true,
    })),
    /requires its typed worker facts/,
  );
  assert.throws(
    () => draftQuestionsReviewResult(reviewFacts("draft-coverage")),
    /requires typed Review facts/,
  );
  assert.throws(() => draftCoverageReviewResult({ verdict: "PASS" }), /typed Review facts/);
});
