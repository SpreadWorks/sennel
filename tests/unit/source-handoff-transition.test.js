import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceHandoffFailureFacts } from "../../src/flow/lib/source-handoff-failure.js";
import {
  resolveSourceHandoffTransitionPlan,
  resolveSourceQualityIssueRecoveryPlan,
  SourceHandoffTransitionPlan,
} from "../../src/flow/definition.js";
import { workerArtifactHandoffPolicy } from "../../src/flow/lib/worker-artifact-handoff.js";

// Outcome -> necessary evidence: rollback needs both exclusive mutation
// authority and observed process termination; unsafe recovery never permits
// source writes; preserving policies retain their existing failure behavior.
for (const [kind, ownershipProven, workerStopped, disposition] of [
  ["rejected", true, true, "rollback"],
  ["rejected", false, true, "block"],
  ["rejected", true, false, "block"],
  ["recovery-untrusted", true, true, "block"],
  ["rollback-required", true, true, "block"],
  ["start-uncertain", true, true, "block"],
  ["settlement-pending", true, true, "block"],
  ["temporary-unavailable", true, true, "wait"],
  ["authority-violation", true, true, "quarantine"],
]) {
  test(`source failure ${kind} ownership=${ownershipProven} stopped=${workerStopped} selects ${disposition}`, () => {
    const facts = new SourceHandoffFailureFacts({
      kind, code: "FLOW_SOURCE_HANDOFF_TEST", message: "Observed failure",
      ownershipProven, workerStopped,
    });
    const plan = resolveSourceHandoffTransitionPlan({ facts, policy: workerArtifactHandoffPolicy("implement") });
    assert.ok(plan instanceof SourceHandoffTransitionPlan);
    assert.equal(plan.disposition, disposition);
    assert.equal(plan.facts, facts);
    assert.deepEqual(plan.toJSON().facts, facts.toJSON());
    if (disposition === "quarantine") {
      assert.equal(plan.failure.category, "source-integrity");
      assert.equal(plan.failure.retryable, false);
      assert.equal(plan.failure.retryKind, null);
    } else assert.equal(plan.failure, null);
  });
}

test("preserving source policies retain rejected edits without overriding unsafe recovery", () => {
  for (const stepId of ["task-triage", "task-repair"]) {
    for (const [kind, expected] of [["rejected", "preserve"], ["start-uncertain", "block"], ["recovery-untrusted", "block"]]) {
      const facts = new SourceHandoffFailureFacts({ kind, code: "FAILURE", message: "Observed failure", workerStopped: true });
      assert.equal(resolveSourceHandoffTransitionPlan({ facts, policy: workerArtifactHandoffPolicy(stepId) }).disposition, expected);
    }
  }
});

test("unknown or corrupt lock owners are not classified as temporary contention", () => {
  for (const code of ["FLOW_HANDOFF_AUTHORITY_LOCK_UNKNOWN", "FLOW_HANDOFF_AUTHORITY_LOCK_CORRUPT"]) {
    const facts = SourceHandoffFailureFacts.fromError(Object.assign(new Error("Invalid lock owner"), { code }));
    assert.equal(resolveSourceHandoffTransitionPlan({ facts, policy: workerArtifactHandoffPolicy("implement") }).disposition, "block");
  }
});

test("rollback plan cannot be constructed without both authority and termination facts", () => {
  const facts = new SourceHandoffFailureFacts({ kind: "rejected", code: "FAILURE", message: "Observed failure" });
  assert.throws(() => new SourceHandoffTransitionPlan({ facts, disposition: "rollback" }), /proven ownership/);
  assert.throws(() => new SourceHandoffFailureFacts({ kind: "unknown", code: "FAILURE", message: "Observed failure" }), /failure kind/);
});

test("fresh transport retry requires a rollback settlement and cannot retry an uncertain worker", () => {
  for (const [kind, workerStopped, expected] of [["rejected", true, true], ["rejected", false, false], ["start-uncertain", true, false]]) {
    const facts = new SourceHandoffFailureFacts({
      kind, code: "FAILURE", message: "Provider did not return a response",
      ownershipProven: true, workerStopped, retryable: true,
    });
    const plan = resolveSourceHandoffTransitionPlan({ facts, policy: workerArtifactHandoffPolicy("implement") });
    assert.equal(plan.retryAfterSettlement, expected);
  }
});

test("static source quality routes retain their Definition checkpoints", () => {
  assert.equal(resolveSourceQualityIssueRecoveryPlan({ sourceStep: "implement" }).recoveryStep, "impl-review");
  assert.equal(resolveSourceQualityIssueRecoveryPlan({ sourceStep: "impl-repair" }).recoveryStep, "impl-gate");
  assert.equal(resolveSourceQualityIssueRecoveryPlan({ sourceStep: "task-impl", taskId: "T-1" }).recoveryStep, "T-1-review");
  assert.equal(resolveSourceQualityIssueRecoveryPlan({ sourceStep: "impl-triage" }), null);
  assert.equal(resolveSourceQualityIssueRecoveryPlan({ sourceStep: "task-triage" }), null);
});
