import assert from "node:assert/strict";
import test from "node:test";

import { settleSpecStepResult } from "../../src/flow/definition.js";
import { StepResult } from "../../src/flow/engine/step-result.js";
import { SpecGateProspectiveFacts } from "../../src/flow/lib/spec-gate-prospective.js";
import { specGateResult } from "../../src/flow/steps/spec/spec-gate.js";

const resultFingerprint = "a".repeat(64);

function resultFor(phase, overrides = {}) {
  return specGateResult(new SpecGateProspectiveFacts({
    phase, result: "fail", failureCategory: "semantic", resultFingerprint, ...overrides,
  }));
}

test("Spec Gate chooses phase-specific Result and Settlement for each semantic outcome", () => {
  const cases = [
    ["spec", { result: "pass", failureCategory: null }, "spec-gate-passed", "target-connection", "approval"],
    ["task-spec", { result: "pass", failureCategory: null }, "task-spec-gate-passed", "target-connection", "approval"],
    ["spec", { repairAvailable: true }, "spec-gate-repair-required", "target-connection", "spec"],
    ["task-spec", { repairAvailable: true }, "task-spec-gate-repair-required", "execution", null],
    ["spec", {}, "spec-gate-retry-required", "execution", null],
    ["task-spec", { retryExhausted: true }, "task-spec-gate-deferred", "target-connection", "approval"],
    ["spec", { nonblockingEnabled: true, acceptanceBacked: true }, "spec-gate-awaiting-decision", "await", null],
    ["task-spec", { result: "recovered", failureCategory: null }, "task-spec-gate-recovered", "execution", null],
    ["task-spec", { failureCategory: "local" }, "task-spec-gate-blocked", "failure", null],
  ];
  for (const [phase, options, kind, settlementKind, target] of cases) {
    const result = resultFor(phase, options);
    const restored = StepResult.fromStored("spec-gate", result.toJSON());
    for (const candidate of [result, restored]) {
      assert.equal(candidate.kind, kind);
      const settlement = settleSpecStepResult("spec-gate", candidate);
      assert.equal(settlement.kind, settlementKind);
      assert.equal(settlement.targetStepId ?? null, target);
    }
  }
});

test("same-evidence Spec Gate facts select a blocking Failure settlement", () => {
  const selected = resultFor("spec", { sameEvidence: true });
  assert.equal(selected.kind, "spec-gate-blocked");
  assert.equal(selected.error.data.reason, "same-evidence");
  const restored = StepResult.fromStored("spec-gate", selected.toJSON());
  assert.equal(restored.kind, "spec-gate-blocked");
  assert.equal(settleSpecStepResult("spec-gate", restored).kind, "failure");
});

test("Spec cycle cap blocks only spec after PASS has been considered", () => {
  assert.equal(resultFor("spec", { cycle: 4 }).kind, "spec-gate-blocked");
  assert.equal(resultFor("task-spec", { cycle: 4 }).kind, "task-spec-gate-retry-required");
  assert.equal(resultFor("spec", { result: "pass", failureCategory: null, cycle: 4 }).kind, "spec-gate-passed");
  assert.equal(resultFor("spec", {
    result: "pass", failureCategory: null, integrityFailure: "invalid_lineage",
  }).kind, "spec-gate-blocked");
});
