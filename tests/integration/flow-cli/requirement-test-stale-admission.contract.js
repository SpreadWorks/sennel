import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { TemporaryNetworkFailure } from "../../../src/lib/agent-failure.js";
import { ProcessExecutionControlFailure } from "../../../src/lib/process-execution-runtime.js";
import { candidateBundleParameters } from "../../../src/flow/lib/requirement-test-store.js";
import {
  TEST_REVIEW_REPAIR_BATCH_LIMITS, canonicalTestReviewRepairForTarget,
  canonicalTestReviewRepairProgress, testReviewRepairProgressReceiptForSelectedContract,
} from "../../../src/flow/lib/test-review-repair.js";
import { rejectFirstRequirementReviewBatches } from "../../support/requirement-test-phase-scenario.js";
import { workerArtifactStableStringify } from "../../../src/flow/lib/worker-artifact-input-format.js";
import { FlowExecutionContract, FlowExecutionContractRefusal } from "../../../src/flow/lib/flow-execution-contract.js";
import { RequirementTestRepairProgressIdentity, TestRepairProgressSavedResult } from "../../../src/flow/engine/step-result.js";
import { RequirementTestSettlementReceipt } from "../../../src/flow/lib/requirement-test-settlement-receipt.js";
import {
  assertSavedRequirementTestResult, LifecycleSaveFault, ArtifactPublicationRace,
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

export function registerRequirementTestStaleAdmission(enterRequirementTestLeaf) {
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

  it("GENERATION repair reload advances only the completed batch and retains its budget owner", async (t) => {
    const scenario = await enterRequirementTestLeaf(t, "test-repair", {
      reviewResponse: rejectFirstRequirementReviewBatches(TEST_REVIEW_REPAIR_BATCH_LIMITS.findingCount * 2 + 1),
    });
    await scenario.dispatch();
    scenario.reload();
    const first = scenario.requests.findLast((request) => request.stepId === "test-repair");
    const saved = assertSavedRequirementTestResult(scenario, "test-repair");
    assert.deepEqual(saved.result.draftSettlementReceipt.executionContract, first.executionContract);
    const budget = scenario.plan().activeWorkItem().budget.toJSON();
    await scenario.dispatch();
    scenario.reload();
    const second = scenario.requests.findLast((request) => request.stepId === "test-repair");
    assert.equal(second.executionContract.generation, first.executionContract.generation + 1);
    const firstContract = FlowExecutionContract.fromJSON(first.executionContract);
    const secondContract = FlowExecutionContract.fromJSON(second.executionContract);
    assert.equal(secondContract.episodeId, firstContract.episodeId);
    assert.equal(secondContract.budgetId, firstContract.budgetId);
    assert.deepEqual(second.executionContract.budgetOwner, first.executionContract.budgetOwner);
    assert.notEqual(second.executionContract.promptDigest, first.executionContract.promptDigest);
    assert.notEqual(second.testReviewRepair.batch.batchId, first.testReviewRepair.batch.batchId);
    assert.deepEqual(scenario.plan().activeWorkItem().budget.toJSON(), budget);
    assert.equal(assertSavedRequirementTestResult(scenario, "test-repair").result.draftSettlementReceipt
      .executionContract.generation, second.executionContract.generation);
    assert.equal((await existingRepairProgress(scenario)).progress.complete, false);
  });

  it("GENERATION same-byte repair progress from a different producer cannot authorize another batch", async (t) => {
    const scenario = await enterRequirementTestLeaf(t, "test-repair", {
      reviewResponse: rejectFirstRequirementReviewBatches(),
    });
    await scenario.dispatch();
    scenario.reload();
    const parameters = { requirementId: "R1" };
    const original = scenario.artifact("test.requirement.repair.progress", parameters);
    scenario.manager.publishArtifacts({ specId: scenario.specId, nodeId: "test-repair",
      artifactWrites: [{ logicalKey: "test.requirement.repair.progress", parameters,
        mediaType: "application/json", bytes: original.bytes }],
    });
    const replaced = scenario.artifact("test.requirement.repair.progress", parameters);
    assert.equal(replaced.descriptor.hash, original.descriptor.hash);
    assert.notEqual(replaced.descriptor.activityId, original.descriptor.activityId);
    const before = scenario.snapshot();
    const calls = scenario.requests.length;
    const rejected = await scenario.dispatch();
    assert.equal(rejected.dispatch.boundary, "blocked");
    assert.equal(rejected.dispatch.dispatchCount, 0);
    const refusal = rejected.nextAction.directive;
    assert.equal(refusal.kind, "blocked");
    assert.equal(refusal.code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
    assert.equal(refusal.diagnostic.code, refusal.code);
    assert.deepEqual(refusal.diagnostic.missingConditions, ["authenticated-execution-evidence"]);
    assert.equal(refusal.diagnostic.retryable, false);
    assert.equal(refusal.diagnostic.resolutionImplemented, false);
    scenario.reload();
    assert.deepEqual(scenario.snapshot(), before);
    assert.equal(scenario.requests.length, calls, "unauthenticated progress must refuse before the external worker");
  });

  for (const alteration of ["write", "Result", "request group"]) {
    it(`ATOMIC nonfinal repair refuses a mismatched ${alteration} without a progress receipt`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, "test-repair", {
        reviewResponse: rejectFirstRequirementReviewBatches(TEST_REVIEW_REPAIR_BATCH_LIMITS.findingCount * 2 + 1),
      });
      let previousGroup = null;
      if (alteration === "request group") {
        await scenario.dispatch();
        scenario.reload();
        previousGroup = assertSavedRequirementTestResult(scenario, "test-repair").result.artifactRefs;
      }
      const previousProgress = scenario.artifact("test.requirement.repair.progress", { requirementId: "R1" });
      const target = Object.getPrototypeOf(scenario.manager);
      const original = target.completeRequirementTestLifecycle;
      let before = null;
      let refusal = null;
      const control = t.mock.method(target, "completeRequirementTestLifecycle", function (input) {
        if (input.stepResult?.kind !== "test-repair-progress-saved") return original.call(this, input);
        before = scenario.snapshot();
        const changed = { ...input };
        if (alteration === "write") {
          changed.artifactWrites = input.artifactWrites.map((write) => {
            if (write.logicalKey !== "test.requirement.repair.progress") return write;
            const progress = JSON.parse(write.bytes.toString("utf8"));
            progress.sourceArtifactDigest = "f".repeat(64);
            return { ...write, bytes: Buffer.from(JSON.stringify(progress)) };
          });
        } else if (alteration === "Result") {
          const result = input.stepResult;
          const identity = result.progressIdentity;
          changed.stepResult = new TestRepairProgressSavedResult({ binding: result.binding,
            frontier: result.frontier, retryState: result.retryState,
            progressIdentity: new RequirementTestRepairProgressIdentity({
              sourceArtifactDigest: "f".repeat(64), sourceEvidenceId: identity.sourceEvidenceId,
              sourceCandidate: identity.sourceCandidate, coordinatorAttempt: identity.coordinatorAttempt,
              entries: identity.entries, stagedSources: identity.stagedSources,
            }),
          });
        } else {
          changed.result = { ...input.result, artifactRefs: input.result.artifactRefs.map((reference) =>
            previousGroup.find((prior) => prior.kind === reference.kind) ?? reference) };
          assert.notDeepEqual(changed.result.artifactRefs, input.result.artifactRefs,
            "the second same-sized batch must present the first genuine completed group's refs");
        }
        try { return original.call(this, changed); }
        catch (error) { refusal = error; throw error; }
      });
      try {
        const dispatched = await scenario.dispatch().then((result) => ({ result, error: null }),
          (error) => ({ result: null, error }));
        if (dispatched.error !== null) assert.equal(dispatched.error, refusal,
          "a propagated refusal must be the actual Store conflict captured at this boundary");
        else assert.ok(dispatched.result.errors?.length > 0, "a rejected completion must report an error");
      } finally { control.mock.restore(); }
      assert.ok(before, "the real producer must reach its nonfinal Store transaction");
      assert.ok(refusal, "Store admission must refuse the changed completion before commit");
      assert.match(refusal.message, /progress|identity|receipt|group|handoff|mismatch|differs/i);
      scenario.reload();
      assertSnapshotAfterMetricFlush(scenario.snapshot(), before, "test-repair");
      assert.deepEqual(scenario.artifact("test.requirement.repair.progress", { requirementId: "R1" }), previousProgress);
    });
  }

  it("GENERATION unfinished repair claim cannot authorize another provider call or generation", async (t) => {
    const scenario = await enterRequirementTestLeaf(t, "test-repair", {
      reviewResponse: rejectFirstRequirementReviewBatches(),
    });
    const refusal = new ProcessExecutionControlFailure("receipt-delivery-failed", "external worker stopped before its response was sealed");
    scenario.options.beforeSeal = (request) => { if (request.stepId === "test-repair") throw refusal; };
    await assert.rejects(() => scenario.dispatch(), (error) => error === refusal);
    scenario.reload();
    const before = scenario.snapshot();
    const calls = scenario.requests.filter((request) => request.stepId === "test-repair").length;
    const rejected = await scenario.dispatch();
    assert.equal(rejected.errors[0].code, "FLOW_EXECUTION_CONTRACT_MISMATCH");
    scenario.reload();
    assert.equal(scenario.requests.filter((request) => request.stepId === "test-repair").length, calls);
    assert.deepEqual(scenario.snapshot(), before);
  });

  it("REPLAY exact nonfinal repair Store input returns its saved receipt and changed input conflicts", async (t) => {
    const scenario = await enterRequirementTestLeaf(t, "test-repair", {
      reviewResponse: rejectFirstRequirementReviewBatches(),
    });
    const target = Object.getPrototypeOf(scenario.manager);
    const original = target.completeRequirementTestLifecycle;
    let captured = null;
    let completed = null;
    const control = t.mock.method(target, "completeRequirementTestLifecycle", function (input) {
      const result = original.call(this, input);
      if (input.stepResult?.kind === "test-repair-progress-saved") { captured = input; completed = result; }
      return result;
    });
    try { await scenario.dispatch(); }
    finally { control.mock.restore(); }
    assert.ok(captured, "the real worker and registered Step must commit a nonfinal Result");
    scenario.reload();
    const before = scenario.snapshot();
    const replay = scenario.manager.completeRequirementTestLifecycle(captured);
    assert.equal(replay.receipt.id, completed.receipt.id);
    assert.deepEqual(RequirementTestSettlementReceipt.fromJSON(replay.receipt).toJSON(), completed.receipt.toJSON());
    assert.deepEqual(scenario.snapshot(), before);
    const changed = { ...captured, result: { ...captured.result,
      artifactRefs: captured.result.artifactRefs.map((reference) => reference.kind === "worker-handoff-request"
        ? { ...reference, id: "f".repeat(64) } : reference),
    } };
    assert.throws(() => scenario.manager.completeRequirementTestLifecycle(changed),
      { code: "CURRENT_FLOW_STATE_CONFLICT" });
    scenario.reload();
    assert.deepEqual(scenario.snapshot(), before);
  });

  for (const [boundary, logicalKey] of [["claim", "test.requirement.plan"], ["provider", "test.requirement.repair.progress"]]) {
    it(`BASELINE repair ${boundary} refuses same-byte ${logicalKey} producer replacement before the worker`, async (t) => {
      const scenario = await enterRequirementTestLeaf(t, "test-repair", {
        reviewResponse: rejectFirstRequirementReviewBatches(),
      });
      await scenario.dispatch();
      scenario.reload();
      const publications = ["test.requirement.plan", "test.requirement.repair.progress"].map((key) =>
        scenario.artifact(key, key.endsWith("progress") ? { requirementId: "R1" } : {}));
      const calls = scenario.requests.filter((request) => request.stepId === "test-repair").length;
      let hit = false;
      let changedSnapshot = null;
      let selectedContract = null;
      const replace = (contract) => {
        if (hit) return;
        hit = true;
        selectedContract = contract;
        for (const publication of publications) assert.ok(contract.inputBaselines.some((baseline) =>
          baseline.toJSON().logicalKey === publication.descriptor.logicalKey
          && baseline.toJSON().relativePath === publication.descriptor.relativePath
          && baseline.toJSON().hash === publication.descriptor.hash
          && baseline.toJSON().size === publication.descriptor.size
          && baseline.toJSON().activityId === publication.descriptor.activityId),
        "the real repair contract must carry each exact plan/progress producer baseline");
        const parameters = logicalKey.endsWith("progress") ? { requirementId: "R1" } : {};
        const publication = scenario.artifact(logicalKey, parameters);
        scenario.manager.publishArtifacts({ specId: scenario.specId, nodeId: "test-repair",
          artifactWrites: [{ logicalKey, parameters, mediaType: "application/json", bytes: publication.bytes }],
        });
        const replaced = scenario.artifact(logicalKey, parameters);
        assert.equal(replaced.descriptor.hash, publication.descriptor.hash);
        assert.notEqual(replaced.descriptor.activityId, publication.descriptor.activityId);
        changedSnapshot = scenario.snapshot();
      };
      let control = null;
      if (boundary === "claim") {
        const target = Object.getPrototypeOf(scenario.manager);
        const original = target.claimExecutionContract;
        control = t.mock.method(target, "claimExecutionContract", function (input) {
          if (input.executionContract.stepId === "test-repair") replace(input.executionContract);
          return original.call(this, input);
        });
      } else {
        scenario.agent.projectInvocation = (_prompt, options) => {
          const binding = options.processExecutionBinding.value;
          if (binding.nodeId === "test-repair") {
            const state = scenario.manager.canonicalState(scenario.specId);
            const contract = scenario.manager.readStoredExecutionContract({
              binding: { runId: state.runId, specId: state.specId, stepId: "test-repair", attempt: state.attempt },
              generation: binding.executionGeneration, optional: true,
            });
            if (contract !== null) replace(contract);
          }
          return { assertWithinLimit() {} };
        };
      }
      try {
        if (boundary === "claim") {
          await assert.rejects(() => scenario.dispatch(), { code: "FLOW_EXECUTION_INPUT_BASELINE_CHANGED" });
        } else {
          const rejected = await scenario.dispatch();
          assert.equal(rejected.errors[0].code, "FLOW_EXECUTION_INPUT_BASELINE_CHANGED");
        }
      } finally { control?.mock.restore(); delete scenario.agent.projectInvocation; }
      assert.equal(hit, true, "the real claim/provider admission must reach its producer race");
      assert.equal(selectedContract.generation, 1);
      scenario.reload();
      assert.deepEqual(scenario.snapshot(), changedSnapshot);
      assert.equal(scenario.requests.filter((request) => request.stepId === "test-repair").length, calls);
    });
  }
});

}
