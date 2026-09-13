import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RequirementTestBudget,
  RequirementTestBundleLineage,
  RequirementTestBundleRevision,
  RequirementTestExpectation,
  RequirementTestPlan,
  RequirementTestSourceAttempt,
  RequirementTestWorkItem,
} from "../../src/flow/lib/requirement-test-lifecycle.js";
import { SpecRepairIdEntityTarget } from "../../src/flow/lib/spec-repair-operations.js";
import { validateSpecJsonObject } from "../../src/lib/spec-json.js";

function revision(revision = 4) {
  return {
    specId: "requirement-test-foundation",
    revision,
    digest: "a".repeat(64),
    byteLength: 321,
  };
}

function spec() {
  return {
    goal: "Create Requirement-scoped test work.",
    scope: { in: [], out: [] },
    constraints: [],
    design_principles: [],
    overview: { modules: [], data_flow: [], decisions: [] },
    background: "",
    requirements: [
      {
        id: "R6", desc: "First testable Requirement.", task_ids: ["T2", "T1"],
        preimplementation_test_expectation: "fail",
      },
      { id: "R7", desc: "No test work.", task_ids: ["T1"], testable: false },
      {
        id: "R8", desc: "Second testable Requirement.", task_ids: ["T1"], testable: true,
        preimplementation_test_expectation: "pass",
      },
    ],
    acceptance_criteria: [],
    clarifications: [],
    alternatives_considered: [],
    open_questions: [],
    tasks: [
      { id: "T1", title: "One", goal: "One", origin: "plan", added_round: 0, status: "pending" },
      { id: "T2", title: "Two", goal: "Two", origin: "plan", added_round: 0, status: "pending" },
    ],
  };
}

function bundle({ requirementId = "R6", specRevision = revision(), bundleRevision = 1 } = {}) {
  return new RequirementTestBundleRevision({
    requirementId,
    specRevision,
    revision: bundleRevision,
    paths: ["tests/r6.test.js"],
    lineage: new RequirementTestBundleLineage({
      requirementId,
      specRevision,
      bundleRevision,
      predecessorRevision: bundleRevision === 1 ? null : bundleRevision - 1,
      sourceAttempt: new RequirementTestSourceAttempt({ id: `test-attempt-${bundleRevision}`, sequence: bundleRevision }),
      sourceFindingFingerprints: bundleRevision === 1 ? [] : ["b".repeat(64)],
    }),
  });
}

describe("Requirement test lifecycle foundation", () => {
  it("derives ordered work only from testable Requirements, independently of Task ids", () => {
    const plan = RequirementTestPlan.fromApprovedSpec({ spec: spec(), specRevision: revision() });

    assert.deepEqual(plan.workItems.map((item) => item.requirementId), ["R6", "R8"]);
    assert.deepEqual(plan.workItems.map((item) => item.expectation.toJSON()), ["fail", "pass"]);
    assert.equal(plan.workItem("R7"), null);
    assert.deepEqual(plan.workItems.map((item) => item.budget.toJSON()), [
      { autoSemantic: 0, manualSemantic: 0, tooling: 0 },
      { autoSemantic: 0, manualSemantic: 0, tooling: 0 },
    ]);
  });

  it("enforces fail/pass expectations at both the value and canonical Spec boundaries", () => {
    assert.equal(new RequirementTestExpectation("fail").toJSON(), "fail");
    assert.equal(new RequirementTestExpectation("pass").toJSON(), "pass");
    assert.throws(() => new RequirementTestExpectation("expected_fail"), /must be fail or pass/);

    const missing = spec();
    delete missing.requirements[0].preimplementation_test_expectation;
    assert.throws(() => validateSpecJsonObject(missing), /requirements\[0\].preimplementation_test_expectation is required/);

    const invalid = spec();
    invalid.requirements[0].preimplementation_test_expectation = "expected_fail";
    assert.throws(() => validateSpecJsonObject(invalid), /must be one of enum \[fail, pass\]/);

    const forbidden = spec();
    forbidden.requirements[1].preimplementation_test_expectation = "pass";
    assert.throws(() => validateSpecJsonObject(forbidden), /requirements\[1\].preimplementation_test_expectation is forbidden/);
  });

  it("keeps lifecycle, revision, bundle lineage, and budgets across JSON round-trip", () => {
    const initial = RequirementTestWorkItem.pending({
      requirementId: "R6",
      specRevision: revision(),
      expectation: "fail",
    });
    const budget = initial.budget
      .increment("autoSemantic")
      .increment("manualSemantic")
      .increment("tooling");
    const promoted = initial.withState({ status: "in_progress", budget })
      .withState({ status: "candidate_saved", bundleRevision: bundle() })
      .withState({ status: "reviewed" })
      .withState({ status: "promoted" });
    const restored = RequirementTestWorkItem.fromJSON(JSON.parse(JSON.stringify(promoted)));

    assert.deepEqual(restored.toJSON(), promoted.toJSON());
    assert.equal(restored.requirementId, "R6");
    assert.equal(restored.status, "promoted");
    assert.equal(restored.bundleRevision.revision, 1);
    assert.deepEqual(restored.budget.toJSON(), {
      autoSemantic: 1,
      manualSemantic: 1,
      tooling: 1,
    });

    const plan = RequirementTestPlan.fromApprovedSpec({ spec: spec(), specRevision: revision() });
    assert.deepEqual(RequirementTestPlan.fromJSON(JSON.parse(JSON.stringify(plan))).toJSON(), plan.toJSON());
  });

  it("reconstructs Definition-selected repair facts without owning transition policy", () => {
    const reviewed = RequirementTestWorkItem.pending({
      requirementId: "R6", specRevision: revision(), expectation: "fail",
    }).withState({ status: "candidate_saved", bundleRevision: bundle() })
      .withState({ status: "reviewed" });
    const repaired = reviewed.withState({ status: "candidate_saved", bundleRevision: bundle({ bundleRevision: 2 }) });

    assert.equal(repaired.status, "candidate_saved");
    assert.equal(repaired.bundleRevision.revision, 2);
    assert.equal(repaired.bundleRevision.lineage.predecessorRevision, 1);
    assert.deepEqual(repaired.bundleRevision.lineage.sourceAttempt.toJSON(), { id: "test-attempt-2", sequence: 2 });
    assert.deepEqual(repaired.bundleRevision.lineage.sourceFindingFingerprints, ["b".repeat(64)]);
    assert.deepEqual(RequirementTestWorkItem.fromJSON(JSON.parse(JSON.stringify(repaired))).toJSON(), repaired.toJSON());

    const definitionSelectedRevision = reviewed.withState({
      status: "candidate_saved", bundleRevision: bundle({ bundleRevision: 3 }),
    });
    assert.equal(definitionSelectedRevision.bundleRevision.revision, 3);
  });

  it("replaces and selects work-item facts without deciding their transition", () => {
    const plan = RequirementTestPlan.fromApprovedSpec({ spec: spec(), specRevision: revision() });
    const active = plan.workItem("R6").withState({ status: "in_progress" });
    const updated = plan.withWorkItem(active);

    assert.equal(updated.activeWorkItem().requirementId, "R6");
    assert.equal(updated.nextPendingWorkItem().requirementId, "R8");
    assert.equal(updated.settled, false);
    const settled = updated
      .withWorkItem(active.withState({ status: "promoted", bundleRevision: bundle() }))
      .withWorkItem(updated.workItem("R8").withState({
        status: "deferred",
        bundleRevision: bundle({ requirementId: "R8" }),
      }));
    assert.equal(settled.activeWorkItem(), null);
    assert.equal(settled.nextPendingWorkItem(), null);
    assert.equal(settled.settled, true);
    assert.throws(() => plan.withWorkItem(RequirementTestWorkItem.pending({
      requirementId: "R9", specRevision: revision(), expectation: "fail",
    })), /does not contain R9/);
  });

  it("rejects structurally invalid state, identity mismatches, and invalid counters", () => {
    const pending = RequirementTestWorkItem.pending({ requirementId: "R6", specRevision: revision(), expectation: "fail" });
    assert.throws(() => pending.withState({ status: "reviewed" }), /candidate state requires a bundle revision/);
    assert.equal(pending.withState({ status: "deferred" }).bundleRevision, null);
    assert.throws(() => pending.withState({ status: "candidate_saved", bundleRevision: bundle({ requirementId: "R8" }) }), /identity do not match/);
    assert.throws(() => pending.withState({ status: "pending", bundleRevision: bundle() }), /pending work cannot carry a bundle revision/);
    assert.throws(() => new RequirementTestBundleRevision({
      ...bundle().toJSON(),
      lineage: new RequirementTestBundleLineage({
        requirementId: "R6", specRevision: revision(5), bundleRevision: 1,
        predecessorRevision: null,
        sourceAttempt: { id: "test-attempt-1", sequence: 1 },
        sourceFindingFingerprints: [],
      }),
    }), /revision and lineage identity do not match/);
    assert.throws(() => new RequirementTestBundleLineage({
      requirementId: "R6", specRevision: revision(), bundleRevision: 2,
      predecessorRevision: 1,
      sourceAttempt: { id: "test-attempt-2", sequence: 2 },
      sourceFindingFingerprints: [],
    }), /requires the preceding revision and source findings/);
    for (const invalidPath of ["tests\\r6.test.js", "./tests/r6.test.js", "tests//r6.test.js", "tests/../r6.test.js", " tests/r6.test.js"] ) {
      assert.throws(() => new RequirementTestBundleRevision({
        ...bundle().toJSON(), paths: [invalidPath],
      }), /canonical repository-relative path/);
    }
    assert.throws(() => new RequirementTestBudget({ autoSemantic: -1 }), /must be a non-negative integer/);
    const policyFreeCounters = [
      ...Array.from({ length: 6 }, () => "autoSemantic"),
      ...Array.from({ length: 6 }, () => "manualSemantic"),
      ...Array.from({ length: 4 }, () => "tooling"),
    ].reduce((budget, kind) => budget.increment(kind), pending.budget);
    assert.deepEqual(policyFreeCounters.toJSON(), { autoSemantic: 6, manualSemantic: 6, tooling: 4 });
  });

  it("allows Spec repair to target the canonical expectation field", () => {
    const target = new SpecRepairIdEntityTarget({
      entity: "requirement", id: "R6", field: "preimplementation_test_expectation",
    }, "target");
    assert.deepEqual(target.toJSON(), {
      entity: "requirement", id: "R6", field: "preimplementation_test_expectation",
    });
  });
});
