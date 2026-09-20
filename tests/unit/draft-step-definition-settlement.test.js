import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  DraftAwaitUserDecision,
  DraftBranchRoute,
  DraftExecutionSettlement,
  DraftCompletionSettlementApplication,
  DraftLoopRoute,
  DraftNextRoute,
  DraftStepErrorDecision,
  settleDraftStepResult,
} from "../../src/flow/definition.js";
import * as results from "../../src/flow/engine/step-result.js";
import { DraftCompletionFacts } from "../../src/flow/lib/draft-completion-connector.js";

function completionFacts(sourceStepId) {
  const draft = {
    devType: "feature",
    goal: "Select one concrete completion settlement.",
    analysis: {
      problem: "The completion route must own its connector.",
      proposedApproach: "Bind typed facts during Definition selection.",
      validation: "Inspect the selected application.",
    },
    decisionMap: {
      knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [],
    },
    questionLedger: {
      revision: 0, publication: "unit-test", evidenceDigest: "a".repeat(64), questions: [],
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  return new DraftCompletionFacts({
    source: "coverage-pass",
    sourceStepId,
    targetStepId: "draft-gate",
    draft,
    draftDigest: digest,
    draftByteLength: bytes.length,
    reviewDraftDigest: digest,
    reviewArtifactDigest: "b".repeat(64),
    questionsReviewArtifactDigest: "c".repeat(64),
    reviewVerdict: "PASS",
  });
}

test("Definition maps every target-connection Result through its selected Connector", () => {
  const cases = [
    ["DraftCreatedResult", DraftNextRoute, "draft-questions-review", "DraftReviewConnector"],
    ["DraftQuestionsReviewPassedResult", DraftNextRoute, "draft-refine", "DraftRefineConnector"],
    ["DraftQuestionsReviewFindingsResult", DraftBranchRoute, "draft-questions-triage", "DraftTriageConnector"],
    ["DraftQuestionsTriageCompletedResult", DraftNextRoute, "draft-questions-repair", "DraftRepairConnector"],
    ["DraftQuestionsRepairChangedResult", DraftLoopRoute, "draft-questions-review", "DraftReviewConnector"],
    ["DraftQuestionsRepairUnchangedResult", DraftNextRoute, "draft-refine", "DraftRefineConnector"],
    ["DraftRefineCompletedResult", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["DraftCoverageReviewPassedResult", DraftNextRoute, "draft-gate", "DraftCompletionConnector"],
    ["DraftCoverageReviewFindingsResult", DraftBranchRoute, "draft-coverage-triage", "DraftTriageConnector"],
    ["DraftCoverageTriageCompletedResult", DraftNextRoute, "draft-coverage-repair", "DraftRepairConnector"],
    ["DraftCoverageRepairChangedResult", DraftLoopRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["DraftCoverageRepairUnchangedResult", DraftNextRoute, "draft-gate", "DraftCompletionConnector"],
    ["DraftGateRepairRequiredResult", DraftLoopRoute, "draft-gate-repair", "PlanGateRepairConnector"],
    ["DraftGatePassedResult", DraftNextRoute, "spec", "DraftSpecConnector"],
    ["DraftGateCarryForwardResult", DraftNextRoute, "spec", "DraftSpecConnector"],
    ["DraftGateRepairAppliedResult", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
    ["DraftGateRepairCarryForwardResult", DraftNextRoute, "draft-coverage-review", "DraftReviewConnector"],
  ];
  for (const [name, SettlementClass, targetStepId, connectorName] of cases) {
    const result = new results[name]();
    const draftCompletionFacts = connectorName === "DraftCompletionConnector"
      ? completionFacts(result.stepId)
      : null;
    const selected = settleDraftStepResult(result.stepId, result, { draftCompletionFacts });
    assert.equal(selected instanceof SettlementClass, true, name);
    assert.equal(selected.targetStepId, targetStepId);
    assert.equal(selected.connector.name, connectorName);
    if (draftCompletionFacts !== null) {
      assert.equal(selected.application instanceof DraftCompletionSettlementApplication, true);
      assert.equal(selected.application.facts, draftCompletionFacts);
      assert.equal(selected.application.connector instanceof selected.connector, true);
    }
  }
});

test("Definition rejects a completion Result without typed facts and unrelated facts on another route", () => {
  const completion = new results.DraftCoverageReviewPassedResult();
  assert.throws(
    () => settleDraftStepResult(completion.stepId, completion),
    /requires typed completion facts/,
  );
  const unrelated = new results.DraftCreatedResult();
  assert.throws(
    () => settleDraftStepResult(unrelated.stepId, unrelated, {
      draftCompletionFacts: completionFacts("draft-coverage-review"),
    }),
    /do not belong/,
  );
});

test("Definition selects connector-free Execution, Await, and Failure settlements", () => {
  for (const name of [
    "DraftQuestionsReviewExecutionRequiredResult",
    "DraftRefineWorkerRequiredResult",
    "DraftCoverageReviewExecutionRequiredResult",
    "DraftGateRepairWorkerRequiredResult",
  ]) {
    const result = new results[name]();
    const selected = settleDraftStepResult(result.stepId, result);
    assert.equal(selected instanceof DraftExecutionSettlement, true, name);
    assert.equal(Object.hasOwn(selected, "connector"), false);
  }
  const awaiting = settleDraftStepResult("draft-refine", new results.DraftRefineAwaitingAnswerResult());
  assert.equal(awaiting instanceof DraftAwaitUserDecision, true);
  assert.equal(Object.hasOwn(awaiting, "connector"), false);

  const failed = settleDraftStepResult(
    "draft-gate",
    new results.DraftStepErrorResult("draft-gate", new Error("provider failed")),
  );
  assert.equal(failed instanceof DraftStepErrorDecision, true);
  assert.equal(Object.hasOwn(failed, "connector"), false);
});

test("Definition rejects a Result bound to another Step", () => {
  assert.throws(
    () => settleDraftStepResult("draft", new results.DraftGatePassedResult()),
    TypeError,
  );
  assert.throws(
    () => new DraftExecutionSettlement(new results.DraftCreatedResult()),
    /must be selected by Definition/,
  );
});
