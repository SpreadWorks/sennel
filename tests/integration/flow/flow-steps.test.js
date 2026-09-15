/**
 * tests/integration/flow/flow-steps.test.js
 *
 * Tests for FLOW_STEPS ordering and PHASE_MAP after the plan rework.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FLOW_STEPS, PHASE_MAP } from "../../../src/lib/flow-helpers.js";
import { getFlowNode } from "../../../src/flow/definition.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
describe("FLOW_STEPS ordering (plan rework)", () => {
  it("has draft review triage and repair steps before their consumers", () => {
    assertStepsAppearInOrder(
      "draft-questions-review",
      "draft-questions-triage",
      "draft-questions-repair",
      "draft-refine",
      "draft-gate-repair",
    );
    assertStepsAppearInOrder(
      "draft-coverage-review",
      "draft-coverage-triage",
      "draft-coverage-repair",
      "draft-gate",
    );
  });

  it("keeps draft completion as a connector, not an independent Flow step", () => {
    assert.ok(!FLOW_STEPS.includes("draft-completion-connector"));
    assert.equal(getFlowNode("draft-completion-connector"), null);
  });

  it("has the fixed Requirement test lifecycle after approval", () => {
    const expectedPrefix = [
      "branch", "prepare-spec", "draft", "draft-questions-review", "draft-questions-triage", "draft-questions-repair", "draft-refine", "draft-gate-repair",
      "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate",
      "spec", "spec-review", "spec-triage", "spec-repair", "spec-gate", "approval",
      "test-generate", "test-review", "test-repair", "test-gate",
    ];
    assert.deepEqual(FLOW_STEPS.slice(0, expectedPrefix.length), expectedPrefix);
    for (const removed of ["test", "scenario-validity", "repair-test-review"]) {
      assert.equal(FLOW_STEPS.includes(removed), false);
      assert.equal(getFlowNode(removed), null);
      assert.equal(FLOW_COMMANDS.run[removed], undefined);
    }
  });

  it("does not contain approach (removed in spec 178)", () => {
    assert.ok(!FLOW_STEPS.includes("approach"), "approach should be removed");
  });

  it("does not contain fill-spec (renamed to spec)", () => {
    assert.ok(!FLOW_STEPS.includes("fill-spec"), "fill-spec should be removed");
  });

  it("does not have spec before prepare-spec", () => {
    const prepIdx = FLOW_STEPS.indexOf("prepare-spec");
    const specIdx = FLOW_STEPS.indexOf("spec");
    assert.ok(prepIdx < specIdx, "prepare-spec should come before spec");
  });

  it("keeps draft question review one-shot in manual and auto modes", () => {
    const node = getFlowNode("draft-questions-review");

    assert.equal(node.resolveMaxAttempts({ autoApprove: true }), 1);
    assert.equal(node.resolveMaxAttempts({ autoApprove: false }), 1);
  });

  it("keeps draft coverage review one-shot in manual and auto modes", () => {
    const node = getFlowNode("draft-coverage-review");

    assert.equal(node.resolveMaxAttempts({ autoApprove: true }), 1);
    assert.equal(node.resolveMaxAttempts({ autoApprove: false }), 1);
  });

  it("sets spec review retry budget from recent convergence data", () => {
    const node = getFlowNode("spec-review");

    assert.equal(node.resolveMaxAttempts({ autoApprove: true }), 4);
    assert.equal(node.resolveMaxAttempts({ autoApprove: false }), 4);
  });

  it("keeps each Requirement review checkpoint single-attempt", () => {
    const node = getFlowNode("test-review");

    assert.equal(node.resolveMaxAttempts({ autoApprove: true }), 1);
    assert.equal(node.resolveMaxAttempts({ autoApprove: false }), 1);
  });

  it("sets implementation review retry budget from recent convergence data", () => {
    const node = getFlowNode("impl-review");

    assert.equal(node.resolveMaxAttempts({ autoApprove: true }), 4);
    assert.equal(node.resolveMaxAttempts({ autoApprove: false }), 4);
  });

  it("has gate before approval", () => {
    const gateIdx = FLOW_STEPS.indexOf("spec-gate");
    const approvalIdx = FLOW_STEPS.indexOf("approval");
    assert.ok(gateIdx < approvalIdx, "gate should come before approval");
  });

  it("runs final-regression after retro and before finalize", () => {
    assertStepsAppearInOrder("impl-gate", "retro", "final-regression", "report", "finalize-commit");
  });
});

function assertStepsAppearInOrder(...stepIds) {
  const indexes = stepIds.map((stepId) => {
    const index = FLOW_STEPS.indexOf(stepId);
    assert.notEqual(index, -1, `${stepId} must exist`);
    return index;
  });
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(
      indexes[i - 1] < indexes[i],
      `${stepIds[i - 1]} must appear before ${stepIds[i]}`,
    );
  }
}

describe("PHASE_MAP (plan rework)", () => {
  it("maps prepare-spec to plan phase", () => {
    assert.equal(PHASE_MAP["prepare-spec"], "plan");
  });

  it("maps spec to plan phase", () => {
    assert.equal(PHASE_MAP["spec"], "plan");
  });

  it("maps spec-repair to plan phase", () => {
    assert.equal(PHASE_MAP["spec-repair"], "plan");
  });

  it("maps spec-triage to plan phase", () => {
    assert.equal(PHASE_MAP["spec-triage"], "plan");
  });

  it("maps gate to plan phase", () => {
    assert.equal(PHASE_MAP["spec-gate"], "plan");
  });

  it("maps approval to plan phase", () => {
    assert.equal(PHASE_MAP["approval"], "plan");
  });

  it("maps final-regression to impl phase", () => {
    assert.equal(PHASE_MAP["final-regression"], "impl");
  });
});
