import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { TemporaryNetworkFailure } from "../../../src/lib/agent-failure.js";
import { candidateBundleParameters } from "../../../src/flow/lib/requirement-test-store.js";
import {
  TEST_REVIEW_REPAIR_BATCH_LIMITS, canonicalTestReviewRepairForTarget,
  canonicalTestReviewRepairProgress, testReviewRepairProgressReceiptForSelectedContract,
} from "../../../src/flow/lib/test-review-repair.js";
import { rejectFirstRequirementReviewBatches } from "../../support/requirement-test-phase-scenario.js";
import { workerArtifactStableStringify } from "../../../src/flow/lib/worker-artifact-input-format.js";
import {
  enterRequirementTestLeaf, assertSavedRequirementTestResult, LifecycleSaveFault, ArtifactPublicationRace,
  readActiveRequirementTestSource, assertSnapshotAfterMetricFlush,
} from "../../support/requirement-test-save-boundary.js";

const PUBLICATION_RACES = Object.freeze([
  ["approval", "spec.record"],
  ["test-generate", "test.requirement.plan"], ["test-generate", "spec.record"],
  ...["test-review", "test-repair", "test-gate"].flatMap((leaf) => [
    [leaf, "test.requirement.plan"], [leaf, "spec.record"],
  ]),
]);


async function existingRepairProgress(scenario) {
  scenario.reload();
  const state = scenario.manager.loadReadOnly(scenario.specId);
  const repair = canonicalTestReviewRepairForTarget({ flowManager: scenario.manager, state, targetStepId: "test-repair" });
  assert.ok(repair, "normal rejected Review must produce its canonical repair evidence");
  const published = scenario.artifact("test.requirement.repair.progress", { requirementId: "R1" });
  assert.ok(published, "normal first batch must publish durable progress, never a prebuilt artifact");
  const progress = canonicalTestReviewRepairProgress({ flowManager: scenario.manager, state, repair, consumerNodeId: "test-repair" });
  assert.equal(progress.complete, false);
  return { state: scenario.manager.canonicalState(scenario.specId), repair, progress,
    document: JSON.parse(published.bytes.toString("utf8")) };
}

function workerRequestDigest(request) {
  return createHash("sha256").update(workerArtifactStableStringify(request), "utf8").digest("hex");
}

describe("RequirementTest producer publication admission and intermediate checkpoint contracts", { concurrency: false }, () => {
  for (const [leaf, logicalKey] of PUBLICATION_RACES) {
    it(`STALE ${leaf} refuses captured ${logicalKey} after same-byte replacement Activity`, async (t) => {
      const race = new ArtifactPublicationRace(leaf, logicalKey);
      const worker = ["test-generate", "test-repair"].includes(leaf);
      const scenario = await enterRequirementTestLeaf(t, leaf, worker ? {
        afterSeal(request, current) { if (request.stepId === leaf) race.publish(current); },
      } : {});
      let control;
      if (!worker) {
        const method = leaf === "approval" ? "approveSpecContinuation" : "completeRequirementTestLifecycle";
        // Dispatcher hook contexts rebind FlowManager through forRoot(), so
        // inject the publication race at the shared method boundary.
        const target = Object.getPrototypeOf(scenario.manager);
        const original = target[method];
        control = t.mock.method(target, method, function (...args) {
          if (scenario.current() === leaf) race.publish(scenario);
          return original.apply(this, args);
        });
      }
      try {
        if (leaf === "approval") {
          await assert.rejects(() => scenario.approve(), /stale|changed|conflict|publication|baseline/i,
            "captured approval source must be revalidated by its real Store admission");
        } else {
          const result = await scenario.dispatch();
          assert.ok(result.errors?.length > 0, "a stale producer cannot report a saved candidate/Review/Gate");
          assert.match(JSON.stringify(result.errors), /stale|changed|conflict|publication|baseline/i,
            "refusal must identify the captured publication boundary, not an unrelated bootstrap error");
        }
      } finally { control?.mock.restore(); }
      assert.equal(race.hit, true, "the normal producer must reach the intended publication race");
      scenario.reload();
      const snapshot = scenario.snapshot();
      if (worker) assertSnapshotAfterMetricFlush(snapshot, race.snapshot, leaf);
      else assert.deepEqual(snapshot, race.snapshot,
        "refused stale admission cannot add Result/receipt/Activity, change budgets, or activate another leaf");
      assert.equal(scenario.current(), leaf);
      assert.equal(readActiveRequirementTestSource(scenario, "r1.test.js"), null);
    });
  }

  for (const leaf of ["test-review", "test-repair", "test-gate"]) {
    it(`STALE ${leaf} retains its immutable candidate when same-byte new publication is requested`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, leaf);
      const candidate = scenario.candidate("R1");
      const parameters = candidateBundleParameters(candidate.descriptor.relativePath);
      assert.ok(parameters, "actual candidate catalog path must resolve through its shared parameter reader");
      const original = scenario.artifact("test.requirement.candidate.bundle", parameters);
      assert.ok(original);
      const before = scenario.snapshot();
      // Candidate ownership allows only generate/repair; requesting publication
      // through that original producer tests immutability, never an illegal Gate updater.
      assert.throws(() => scenario.manager.publishArtifacts({ specId: scenario.specId, nodeId: "test-generate",
        artifactWrites: [{ logicalKey: "test.requirement.candidate.bundle", parameters,
          mediaType: "application/json", bytes: original.bytes }],
      }), /immutable|conflict|publication|changed|same/i,
      "another producer Activity cannot replace the immutable candidate, even with identical bytes");
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), before);
      assert.deepEqual(scenario.artifact("test.requirement.candidate.bundle", parameters), original);
      assert.equal(scenario.current(), leaf);
      assert.equal(readActiveRequirementTestSource(scenario, "r1.test.js"), null);
    });
  }

  for (const phase of ["before-commit", "after-commit"]) {
    it(`CHECKPOINT nonfinal generation ${phase} retains one live Attempt and the exact R frontier`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, "test-generate", { requirements: ["R1", "R2"].map((id) => ({
        id, desc: `Executable behavior ${id}.`, task_ids: ["T1"], preimplementation_test_expectation: "fail",
      })) });
      const attempt = scenario.manager.canonicalState(scenario.specId).attempt;
      const fault = new LifecycleSaveFault(t, scenario, "test-generate", phase);
      try {
        const result = await scenario.dispatch();
        assert.equal(fault.hit, true, "real R1 candidate producer must reach its nonfinal save boundary");
        assert.ok(result.errors?.length > 0);
      } finally { fault.restore(); }
      scenario.reload();
      assertSnapshotAfterMetricFlush(scenario.snapshot(), phase === "before-commit" ? fault.before : fault.committed, "test-generate");
      assert.equal(scenario.current(), "test-generate");
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.id, attempt.id);
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.sequence, attempt.sequence);
      const plan = scenario.plan();
      assert.equal(plan.workItem("R2").status, phase === "before-commit" ? "pending" : "in_progress");
      assert.equal(plan.workItem("R2").bundleRevision, null);
      assert.equal(readActiveRequirementTestSource(scenario, "r1.test.js"), null);
      if (phase === "after-commit") {
        assert.equal(plan.workItem("R1").status, "candidate_saved");
        assert.equal(scenario.candidate("R1").candidate.bundle.lineage.sourceAttempt.id, attempt.id);
        const saved = assertSavedRequirementTestResult(scenario, "test-generate");
        assert.equal(saved.attemptId, attempt.id);
        const producedR1 = scenario.requests.filter((request) => request.stepId === "test-generate"
          && request.requirementTestBinding.requirementId === "R1").length;
        await scenario.dispatch();
        scenario.reload();
        assert.equal(scenario.requests.filter((request) => request.stepId === "test-generate"
          && request.requirementTestBinding.requirementId === "R1").length, producedR1,
        "recovery uses the R1 receipt and must continue with R2, never regenerate committed R1");
      } else assert.equal(plan.workItem("R1").bundleRevision, null);
    });

    it(`CHECKPOINT nonfinal repair batch ${phase} retains staged progress without publishing a candidate revision`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, "test-repair", { reviewResponse: rejectFirstRequirementReviewBatches() });
      const attempt = scenario.manager.canonicalState(scenario.specId).attempt;
      const beforeCandidate = scenario.candidate("R1").candidate.toJSON();
      const beforeBudget = scenario.plan().activeWorkItem().budget.toJSON();
      const fault = new LifecycleSaveFault(t, scenario, "test-repair", phase,
        { method: "completeRequirementTestLifecycle", artifactKey: "test.requirement.repair.progress" });
      try {
        const result = await scenario.dispatch();
        assert.equal(fault.hit, true, "real bounded repair producer must reach intermediate progress publication");
        assert.ok(result.errors?.length > 0);
      } finally { fault.restore(); }
      scenario.reload();
      assertSnapshotAfterMetricFlush(scenario.snapshot(), phase === "before-commit" ? fault.before : fault.committed, "test-repair");
      assert.equal(scenario.current(), "test-repair");
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt.id, attempt.id);
      assert.deepEqual(scenario.candidate("R1").candidate.toJSON(), beforeCandidate);
      assert.deepEqual(scenario.plan().activeWorkItem().budget.toJSON(), beforeBudget);
      assert.equal(readActiveRequirementTestSource(scenario, "r1.test.js"), null);
      if (phase === "after-commit") {
        const { progress } = await existingRepairProgress(scenario);
        assert.ok(progress.entries.some((entry) => entry.status === "done"));
        assert.ok(progress.entries.some((entry) => entry.status === "pending"));
        assert.equal(progress.coordinatorAttempt.id, attempt.id);
        assertSavedRequirementTestResult(scenario, "test-repair");
      }
    });
  }

  it("REPLAY same-size subsequent batch cannot reuse the first real checkpoint's finding/receipt identity", async (t) => {
    const scenario = await enterRequirementTestLeaf(t, "test-repair", {
      reviewResponse: rejectFirstRequirementReviewBatches(TEST_REVIEW_REPAIR_BATCH_LIMITS.findingCount * 2 + 1),
    });
    await scenario.dispatch();
    const prior = await existingRepairProgress(scenario);
    const firstRequest = scenario.requests.findLast((request) => request.stepId === "test-repair");
    const firstRequestDigest = workerRequestDigest(firstRequest);
    const done = prior.progress.entries.find((entry) => entry.status === "done");
    assert.ok(done);
    assert.equal(testReviewRepairProgressReceiptForSelectedContract({ state: prior.state,
      progressDocument: prior.document, selectedContract: firstRequest.testReviewRepair,
      requestDigest: firstRequestDigest }), done.handoff.handoffDigest,
    "the exact saved batch must remain a lawful replay before testing another batch");
    const fault = new LifecycleSaveFault(t, scenario, "test-repair", "before-commit",
      { method: "completeRequirementTestLifecycle", artifactKey: "test.requirement.repair.progress" });
    try {
      await scenario.dispatch();
      assert.equal(fault.hit, true);
    } finally { fault.restore(); }
    const secondRequest = scenario.requests.findLast((request) => request.stepId === "test-repair");
    const secondRequestDigest = workerRequestDigest(secondRequest);
    assert.notEqual(secondRequestDigest, firstRequestDigest);
    assert.equal(secondRequest.testReviewRepair.batch.findingIds.length, firstRequest.testReviewRepair.batch.findingIds.length);
    assert.notDeepEqual(secondRequest.testReviewRepair.batch.findingIds, firstRequest.testReviewRepair.batch.findingIds);
    assert.notEqual(secondRequest.testReviewRepair.batch.batchId, firstRequest.testReviewRepair.batch.batchId);
    assert.equal(testReviewRepairProgressReceiptForSelectedContract({ state: prior.state,
      progressDocument: prior.document, selectedContract: secondRequest.testReviewRepair,
      requestDigest: secondRequestDigest }), null,
    "a same-count batch with other finding identities cannot consume the previous batch's real receipt");
  });

  it("REPLAY public tooling retry cannot authorize saved repair progress from an older coordinator Attempt", async (t) => {
    const scenario = await enterRequirementTestLeaf(t, "test-repair", { reviewResponse: rejectFirstRequirementReviewBatches() });
    await scenario.dispatch();
    const prior = await existingRepairProgress(scenario);
    const request = scenario.requests.findLast((entry) => entry.stepId === "test-repair");
    const originalAttempt = scenario.manager.canonicalState(scenario.specId).attempt;
    const beforeBudget = scenario.plan().activeWorkItem().budget.toJSON();
    scenario.options.beforeSeal = (workerRequest) => {
      if (workerRequest.stepId === "test-repair") throw new TemporaryNetworkFailure({ message: "temporary DNS failure at external provider" });
    };
    // Only the normal dispatcher consumes the real external tooling failure and
    // Definition retry. No retry grant, StepAttempt or coordinator is constructed here.
    for (let action = 0; action < 3; action += 1) {
      await scenario.dispatch();
      scenario.reload();
      if (scenario.manager.canonicalState(scenario.specId).attempt.id !== originalAttempt.id) break;
    }
    const state = scenario.manager.loadReadOnly(scenario.specId);
    const current = scenario.manager.canonicalState(scenario.specId).attempt;
    assert.notEqual(current.id, originalAttempt.id, "public tooling retry must really create its new Attempt");
    assert.ok(current.sequence > originalAttempt.sequence);
    assert.ok(scenario.plan().activeWorkItem().budget.tooling > beforeBudget.tooling);
    assert.equal(scenario.plan().activeWorkItem().budget.manualSemantic, beforeBudget.manualSemantic);
    assert.equal(scenario.plan().activeWorkItem().budget.autoSemantic, beforeBudget.autoSemantic);
    const beforeRefusal = scenario.snapshot();
    assert.throws(() => testReviewRepairProgressReceiptForSelectedContract({ state,
      progressDocument: prior.document, selectedContract: request.testReviewRepair,
      requestDigest: workerRequestDigest(request) }), /lineage|Attempt|coordinator|stale/i);
    assert.throws(() => canonicalTestReviewRepairProgress({ flowManager: scenario.manager, state,
      repair: prior.repair, consumerNodeId: "test-repair" }), /lineage|Attempt|coordinator|stale/i);
    assert.deepEqual(scenario.snapshot(), beforeRefusal, "old-coordinator refusal cannot reset progress or budgets");
  });
});
