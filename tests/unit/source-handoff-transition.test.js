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

test("the Task repair source policy retains rejected edits without overriding unsafe recovery", () => {
  for (const [kind, expected] of [["rejected", "preserve"], ["start-uncertain", "block"], ["recovery-untrusted", "block"]]) {
    const facts = new SourceHandoffFailureFacts({ kind, code: "FAILURE", message: "Observed failure", workerStopped: true });
    assert.equal(resolveSourceHandoffTransitionPlan({ facts, policy: workerArtifactHandoffPolicy("task-repair") }).disposition, expected);
  }
});

test("Definition converges only a stopped owned terminal Task repair response failure", () => {
  const identity = { stepId: "task-repair", toJSON: () => ({ stepId: "task-repair" }) };
  for (const [code, retryable, ownershipProven, workerStopped, expected] of [
    ["FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", false, true, true, "converge-no-change"],
    ["FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", true, true, true, "preserve"],
    ["FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", false, false, true, "preserve"],
    ["FLOW_SOURCE_HANDOFF_RESPONSE_INVALID", false, true, false, "block"],
    ["FLOW_SOURCE_HANDOFF_PARENT_AUTHORITY_VIOLATION", false, true, true, "preserve"],
  ]) {
    const facts = new SourceHandoffFailureFacts({
      kind: "rejected", code, message: "Observed Task repair producer failure",
      identity, retryable, ownershipProven, workerStopped,
    });
    assert.equal(
      resolveSourceHandoffTransitionPlan({ facts, policy: workerArtifactHandoffPolicy("task-repair") }).disposition,
      expected,
      code,
    );
  }
  const exhaustedProvider = new SourceHandoffFailureFacts({
    kind: "rejected", code: "AGENT_TEMPORARY_NETWORK", message: "Provider retry budget exhausted",
    identity, retryable: true, ownershipProven: true, workerStopped: true,
    providerFailed: true, toolingRecoveryAvailable: false,
  });
  assert.equal(resolveSourceHandoffTransitionPlan({
    facts: exhaustedProvider, policy: workerArtifactHandoffPolicy("task-repair"),
  }).disposition, "converge-no-change");
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
