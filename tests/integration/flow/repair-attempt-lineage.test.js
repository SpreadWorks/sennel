import { CURRENT_FLOW_SCHEMA_REVISION } from "../../../src/lib/flow-schema-revision.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalAttemptOwner,
  AttemptLineageError,
} from "../../../src/flow/lib/repair-attempt-lineage.js";
import { DraftCoverageTriageCompletedResult } from "../../../src/flow/engine/step-result.js";
import { DraftStepSettlementReceipt, DraftStepSettlementPublication, settleDraftStepResult } from "../../../src/flow/definition.js";

function attempt(id, sequence) {
  return { id, nodeId: "impl-repair", sequence };
}

function activity({ id, operation, transitionAttempt, attemptId = transitionAttempt.id, sequence = transitionAttempt.sequence } = {}) {
  return {
    id,
    nodeId: "impl-repair",
    attemptId,
    sequence,
    transition: { operation, nodeId: "impl-repair", attempt: transitionAttempt },
  };
}

function state(currentAttempt) {
  return { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, current: ["impl-repair"], attempt: currentAttempt };
}

describe("canonical repair Attempt lineage", () => {
  it("recognizes a typed target-connection confirmation as an entry without treating terminal confirmation as another entry", () => {
    const stepId = "draft-coverage-triage";
    const targetStepId = "draft-coverage-repair";
    const targetAttempt = { id: "coverage-repair-2", nodeId: targetStepId, sequence: 2 };
    const result = new DraftCoverageTriageCompletedResult();
    const receipt = new DraftStepSettlementReceipt({
      binding: { runId: "run-lineage", specId: "001-lineage", stepId,
        attempt: { id: "coverage-triage-1", sequence: 1 } },
      result, settlement: settleDraftStepResult(stepId, result), publication: new DraftStepSettlementPublication(),
    });
    const connection = { id: "coverage-triage-confirmation", nodeId: stepId,
      transition: { operation: "confirm_attempt", nodeId: stepId, attempt: targetAttempt },
      result: { draftSettlementReceipt: receipt.toJSON() } };
    const terminal = { id: "coverage-repair-terminal", nodeId: targetStepId,
      transition: { operation: "confirm_attempt", nodeId: targetStepId, attempt: null }, result: null };
    const current = { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, current: [targetStepId], attempt: targetAttempt };
    assert.equal(canonicalAttemptOwner({ state: current, activities: [terminal, connection], targetStepId }), connection);
    assert.throws(() => canonicalAttemptOwner({ state: current, activities: [terminal], targetStepId }), AttemptLineageError);
  });

  it("keeps plan-gate repair ownership for its direct replacement Attempt", () => {
    const repair = activity({
      id: "review-repair",
      operation: "plan_gate_repair",
      transitionAttempt: attempt("test-1", 1),
    });
    assert.equal(canonicalAttemptOwner({
      state: state(attempt("test-1", 1)), activities: [repair], targetStepId: "impl-repair",
    }), repair);
  });

  it("inherits plan-gate repair ownership through retry_attempt", () => {
    const repair = activity({ id: "review-repair", operation: "plan_gate_repair", transitionAttempt: attempt("test-1", 1) });
    const retry = activity({
      id: "retry",
      operation: "retry_attempt",
      transitionAttempt: attempt("test-2", 2),
      attemptId: "test-1",
      sequence: 1,
    });
    assert.equal(canonicalAttemptOwner({
      state: state(attempt("test-2", 2)), activities: [repair, retry], targetStepId: "impl-repair",
    }), repair);
  });

  it("inherits plan-gate repair ownership through retry_recovery_attempt", () => {
    const repair = activity({ id: "gate-repair", operation: "plan_gate_repair", transitionAttempt: attempt("test-1", 1) });
    const retry = activity({
      id: "retry",
      operation: "retry_attempt",
      transitionAttempt: attempt("test-2", 2),
      attemptId: "test-1",
      sequence: 1,
    });
    const recovery = activity({
      id: "retry-recovery",
      operation: "retry_recovery_attempt",
      transitionAttempt: attempt("test-3", 3),
      attemptId: "test-3",
      sequence: 3,
    });
    assert.equal(canonicalAttemptOwner({
      state: state(attempt("test-3", 3)), activities: [repair, retry, recovery], targetStepId: "impl-repair",
    }), repair);
  });

  it("does not leak historical repair ownership into a later normal start", () => {
    const historicalRepair = activity({ id: "review-repair", operation: "plan_gate_repair", transitionAttempt: attempt("test-1", 1) });
    const normalStart = activity({ id: "normal-start", operation: "start_attempt", transitionAttempt: attempt("test-2", 2) });
    assert.equal(canonicalAttemptOwner({
      state: state(attempt("test-2", 2)), activities: [historicalRepair, normalStart], targetStepId: "impl-repair",
    }), normalStart);
  });

  it("retains the original owner when missing-producer recovery restores that Attempt", () => {
    const repair = activity({ id: "review-repair", operation: "plan_gate_repair", transitionAttempt: attempt("test-1", 1) });
    const recovered = activity({ id: "missing-producer", operation: "recover_missing_producer_artifact", transitionAttempt: attempt("test-1", 1) });
    assert.equal(canonicalAttemptOwner({
      state: state(attempt("test-1", 1)), activities: [repair, recovered], targetStepId: "impl-repair",
    }), repair);
  });

  it("rejects an ambiguous or missing retry predecessor", () => {
    const retry = activity({ id: "retry", operation: "retry_attempt", transitionAttempt: attempt("test-2", 2), attemptId: "test-1", sequence: 1 });
    assert.throws(
      () => canonicalAttemptOwner({ state: state(attempt("test-2", 2)), activities: [retry], targetStepId: "impl-repair" }),
      AttemptLineageError,
    );
  });
});
