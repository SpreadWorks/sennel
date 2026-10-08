import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planGateRepairRouteForPhase } from "../../src/flow/lib/plan-gate-repair.js";

describe("PlanGateRepairRoute", () => {
  it("owns the accepted source status contract for Draft and Spec resets", () => {
    const draft = planGateRepairRouteForPhase("draft");
    assert.deepEqual(draft.acceptedSourceStatuses("draft-gate-repair"), ["done", "skipped"]);
    assert.deepEqual(draft.acceptedSourceStatuses("draft-coverage-review"), ["done"]);
    assert.deepEqual(draft.acceptedSourceStatuses("draft-coverage-triage"), ["done", "skipped"]);
    assert.deepEqual(draft.acceptedSourceStatuses("draft-coverage-repair"), ["done", "skipped"]);
    assert.deepEqual(draft.acceptedSourceStatuses("draft-gate"), ["in_progress"]);
    assert.equal(draft.requestedStatus("draft-gate-repair"), "in_progress");
    for (const stepId of draft.resetStepIds.slice(1)) {
      assert.equal(draft.requestedStatus(stepId), "pending");
    }

    const spec = planGateRepairRouteForPhase("spec");
    assert.deepEqual(spec.acceptedSourceStatuses("spec-gate-repair"), ["done", "skipped"]);
    assert.deepEqual(spec.acceptedSourceStatuses("spec-gate"), ["in_progress"]);
    assert.equal(spec.requestedStatus("spec-gate-repair"), "in_progress");
    assert.equal(spec.requestedStatus("spec-gate"), "pending");
    for (const stepId of ["spec", "spec-review", "spec-triage", "spec-repair"]) {
      assert.throws(() => spec.acceptedSourceStatuses(stepId), /outside plan gate repair route/);
    }
    assert.throws(
      () => draft.acceptedSourceStatuses("draft-questions-review"),
      /outside plan gate repair route/,
    );
  });
});
