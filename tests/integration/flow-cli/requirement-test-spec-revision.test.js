import assert from "node:assert/strict";
import { test } from "node:test";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { settleRequirementTestStepResult } from "../../../src/flow/definition.js";
import { RequirementTestSettlementReceipt } from "../../../src/flow/lib/requirement-test-settlement-receipt.js";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { RequirementTestArtifactStore } from "../../../src/flow/lib/requirement-test-store.js";

test("authorized Spec correction preserves old immutable candidate and publishes local revision one for the new Spec", async (t) => {
  const flow = AcceptancePhaseScenario.create(t);
  await flow.advanceTo("implement");
  flow.reload();
  const store = () => new RequirementTestArtifactStore({ flowManager: flow.manager, state: flow.state() });
  const originalPlan = store().readPlan("test-gate").artifact.plan;
  const originalBundle = originalPlan.workItem("R1").bundleRevision;
  const original = store().readCandidate({ bundle: originalBundle, consumerNodeId: "test-gate" });
  const originalActivity = flow.manager.activityLedger(flow.specId).find((entry) => entry.id === original.descriptor.activityId);
  assert.ok(originalActivity);
  const retained = JSON.stringify(originalActivity);
  assert.equal(originalBundle.revision, 1);
  flow.options.requirements = [{ id: "R1", desc: "The corrected requirement retains executable independent evidence.",
    task_ids: ["T1"], preimplementation_test_expectation: "fail" }];
  const reopened = await flow.runRegistered("reopen-draft", { category: "spec-correction",
    reason: "Regenerate Requirement evidence after this explicitly authorized Spec correction.",
    expectRunId: flow.state().runId, expectSpec: flow.specId, expectNoIssue: true });
  assert.equal(reopened.mode, "spec-correction", JSON.stringify(reopened));
  await flow.advanceTo("test-review");
  flow.reload();
  const currentPlan = store().readPlan("test-review").artifact.plan;
  const currentBundle = currentPlan.workItem("R1").bundleRevision;
  const current = store().readCandidate({ bundle: currentBundle, consumerNodeId: "test-review" });
  assert.ok(currentPlan.specRevision.revision.value > originalPlan.specRevision.revision.value);
  assert.equal(currentBundle.specRevision.equals(currentPlan.specRevision), true);
  assert.equal(currentBundle.revision, 1, "a new Spec starts its own generation lineage, not an invented repair counter");
  assert.equal(currentBundle.lineage.predecessorRevision, null);
  assert.deepEqual(currentBundle.lineage.sourceFindingFingerprints, []);
  assert.notEqual(current.descriptor.relativePath, original.descriptor.relativePath);
  assert.notEqual(current.descriptor.activityId, original.descriptor.activityId);
  const reread = store().readCandidate({ bundle: originalBundle, consumerNodeId: "test-review" });
  assert.deepEqual(reread.candidate.toJSON(), original.candidate.toJSON());
  assert.deepEqual(reread.descriptor, original.descriptor);
  assert.deepEqual(reread.sources.map((entry) => entry.bytes), original.sources.map((entry) => entry.bytes));
  assert.equal(JSON.stringify(flow.manager.activityLedger(flow.specId).find((entry) => entry.id === originalActivity.id)), retained);
  const produced = flow.requests.filter((request) => request.stepId === "test-generate").at(-1).requirementTestBinding;
  assert.deepEqual(produced.specRevision, currentBundle.specRevision.toJSON());
  assert.equal(produced.bundleRevision, 1);
  await flow.advanceTo("implement");
  flow.reload();
  const consumed = store().readPlan("test-gate").artifact.plan.workItem("R1");
  assert.equal(consumed.status, "promoted");
  assert.equal(consumed.bundleRevision.specRevision.equals(currentPlan.specRevision), true);
  for (const stepId of ["test-review", "test-gate"]) {
    const activity = flow.manager.activityLedger(flow.specId).filter((entry) => entry.nodeId === stepId
      && entry.result?.stepResult?.type === "completed").at(-1);
    assert.ok(activity);
    const result = StepResult.fromStored(stepId, activity.result.stepResult);
    assert.equal(result.binding.specRevision.equals(currentPlan.specRevision), true);
    const receipt = activity.result.draftSettlementReceipt;
    RequirementTestSettlementReceipt.fromJSON(receipt.toJSON?.() ?? receipt, {
      result, settlement: settleRequirementTestStepResult(stepId, result),
      binding: { runId: flow.state().runId, specId: flow.specId, stepId,
        attempt: { id: activity.attemptId, sequence: activity.sequence } },
    });
  }
  assert.deepEqual(store().readCandidate({ bundle: originalBundle, consumerNodeId: "test-gate" }).descriptor,
    original.descriptor, "later consumers retain the prior Spec's immutable publication");
});
