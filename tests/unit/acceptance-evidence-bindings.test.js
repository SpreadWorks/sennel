import assert from "node:assert/strict";
import { test } from "node:test";
import { bindAcceptanceResponse } from "../../src/flow/lib/run-acceptance-review.js";
import { AcceptanceEvidenceBindings } from "../../src/flow/lib/acceptance-review-artifacts.js";

test("Acceptance binds deferred findings to canonical source, diff, repair and requirement test references", () => {
  const finding = { findingId: "DF-1", sourceArtifact: "impl.review", sourceFindingId: "review-1" };
  const context = {
    requirementIds: ["R-1", "R-2"], deferredFindings: [finding],
    evidence: { diff: "diff --git a/src/value.js b/src/value.js\n", repairEvidence: { ref: "impl-repair.json" } },
  };
  const bound = bindAcceptanceResponse(context, {
    requirementJudgments: context.requirementIds.map((requirementId) => ({ requirementId, status: "met" })),
    deferredFindingDispositions: [{ findingId: finding.findingId, finalDisposition: "fixed", evidenceRefs: [
      "impl.review#review-1", "diff:src/value.js", "impl-repair.json",
      "test-execute-result.json#R-1", "test-execute-result.json#R-2", "test-result-review.json",
      "diff:foreign.js", "test-execute-result.json#foreign", "foreign-repair.json",
    ] }],
  });
  assert.deepEqual(bound.deferredFindingDispositions[0], {
    findingId: "DF-1", finalDisposition: "fixed", evidenceRefs: [
      "impl.review#review-1", "diff:src/value.js", "impl-repair.json",
      "test-execute-result.json#R-1", "test-execute-result.json#R-2", "test-result-review.json",
    ],
  });
  assert.deepEqual(bound.requirementJudgments.map((judgment) => judgment.testRefs), [
    ["test-execute-result.json#R-1", "test-result-review.json"],
    ["test-execute-result.json#R-2", "test-result-review.json"],
  ]);
  const bindings = new AcceptanceEvidenceBindings(context);
  assert.equal(bindings.validateDeferredDisposition(bound.deferredFindingDispositions[0], finding).finalDisposition, "fixed");
  assert.throws(() => bindings.validateDeferredDisposition({ ...bound.deferredFindingDispositions[0],
    evidenceRefs: ["diff:src/value.js"] }, finding), /evidenceRefs must cite impl.review#review-1/);
});
