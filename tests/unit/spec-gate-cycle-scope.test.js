import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowActivity, CurrentFlowMigrationCheckpoint } from "../../src/flow/lib/current-flow-state.js";
import { ReviewFindingCycle } from "../../src/flow/lib/finding-disposition-policy.js";
import { readSpecGateCycleProgress } from "../../src/flow/lib/gate-transition-facts.js";
import { CURRENT_FLOW_SCHEMA_REVISION } from "../../src/lib/flow-schema-revision.js";

const timestamp = "2026-08-04T00:00:00.000Z";
function activity(order, operation = "record_note") {
  const reopen = operation.startsWith("reopen_draft_");
  const nodeId = reopen ? "draft" : "flow";
  return new FlowActivity({ id: `activity-${order}`, nodeId, nodeKey: nodeId,
    attemptId: reopen ? `draft-${order}` : null, sequence: reopen ? order : null,
    confirmationOrder: order, type: reopen ? "recovery" : "note_recorded",
    transition: { operation, nodeId, task: null,
      attempt: reopen ? { id: `draft-${order}`, nodeId, sequence: order, startedAt: timestamp,
        consumption: { semantic: 0, tooling: 0 }, failure: null, blocker: null, incomplete: [], operationClaims: [] } : null,
      status: null, policy: null, outbox: null, approval: null, nonblocking: null },
    result: null, timing: { startedAt: timestamp, finishedAt: timestamp, durationMs: 0 },
    failure: null, provider: null, model: null, effort: null, usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null, note: reopen ? null : { text: "Retained canonical note." }, reviewPublication: null });
}
function migrationValue(boundaryOrder, legacyAppliedCount = 3) {
  return { version: 1, archiveDigests: { flow: "a".repeat(64), activities: "b".repeat(64), catalog: "c".repeat(64) },
    legacyAppliedCount, legacyCyclesDigest: "d".repeat(64), boundaryOrder, projectedActivitiesDigest: "e".repeat(64),
    baseline: { schemaRevision: CURRENT_FLOW_SCHEMA_REVISION, confirmationOrder: boundaryOrder, attempt: null, migration: null } };
}
function progress(activities, migration = null) {
  return readSpecGateCycleProgress({ state: { runId: "run-cycle", specId: "cycle", migration },
    activities: activities.map((entry) => entry.toJSON()), catalog: { artifacts: [] } });
}

test("planning membership uses the exact latest canonical reopen order while preserving Review wire identity", () => {
  const earlier = activity(1), first = activity(2, "reopen_draft_preimplementation");
  const between = activity(3), latest = activity(4, "reopen_draft_spec_correction"), current = activity(5);
  const cycle = ReviewFindingCycle.fromActivityLedger({ runId: "run-cycle", activities: [earlier, first, between, latest, current] });
  assert.equal(cycle.reopenConfirmationOrder, 4);
  for (const prior of [earlier, first, between, latest]) assert.equal(cycle.includesActivity(prior), false);
  assert.equal(cycle.includesActivity(current), true);
  assert.deepEqual(cycle.toJSON(), { runId: "run-cycle", planRewindAt: timestamp });
  assert.throws(() => cycle.includesActivity({ ...current.toJSON(), confirmationOrder: 6 }), /exact canonical ledger Activity/);
  assert.throws(() => cycle.includesActivity(activity(6)), /exact canonical ledger Activity/);
});

test("migrated cycles count until a later canonical reopen and cannot be reset by timestamps or unrelated Activities", () => {
  const migration = new CurrentFlowMigrationCheckpoint(migrationValue(3));
  assert.deepEqual(progress([activity(1), activity(2), activity(3)], migration).toJSON(), { cycle: 4, completedRepairs: 3 });
  assert.equal(progress([activity(1), activity(2, "reopen_draft_task_addition"), activity(3)], migration).cycle, 4);
  assert.equal(progress([activity(1), activity(2), activity(3), activity(4)], migration).cycle, 4);
  assert.deepEqual(progress([activity(1), activity(2), activity(3), activity(4, "reopen_draft_preimplementation")], migration).toJSON(),
    { cycle: 1, completedRepairs: 0 });
  assert.equal(progress([activity(1), activity(2, "reopen_draft_preimplementation")]).cycle, 1);
});

test("missing or invalid canonical reopen and migration boundaries are refused", () => {
  const reopen = activity(2, "reopen_draft_preimplementation").toJSON();
  const missingOrder = structuredClone(reopen); delete missingOrder.confirmationOrder;
  assert.throws(() => ReviewFindingCycle.fromActivityLedger({ activities: [missingOrder] }), /confirmationOrder|fields/);
  const invalidOrder = structuredClone(reopen); invalidOrder.confirmationOrder = 0;
  assert.throws(() => ReviewFindingCycle.fromActivityLedger({ activities: [invalidOrder] }), /confirmationOrder/);
  const missingTiming = structuredClone(reopen); missingTiming.timing = null;
  assert.throws(() => ReviewFindingCycle.fromActivityLedger({ activities: [missingTiming] }), /timing facts/);
  const missingBoundary = migrationValue(3); delete missingBoundary.boundaryOrder;
  assert.throws(() => new CurrentFlowMigrationCheckpoint(missingBoundary), /migration checkpoint/);
  assert.throws(() => new CurrentFlowMigrationCheckpoint(migrationValue(-1)), /migration checkpoint/);
  const inconsistent = migrationValue(3); inconsistent.baseline.confirmationOrder = 4;
  assert.throws(() => new CurrentFlowMigrationCheckpoint(inconsistent), /journal boundary/);
  assert.throws(() => progress([activity(1)], missingBoundary), /typed migration checkpoint/);
});

test("cycle membership refuses duplicate, gapped and reordered canonical ledgers", () => {
  for (const [activities, error] of [
    [[activity(1), activity(1)], /duplicate Activity id/],
    [[activity(1), activity(3)], /confirmationOrder must be contiguous/],
    [[activity(2), activity(1)], /confirmationOrder must be contiguous/],
  ]) {
    assert.throws(() => ReviewFindingCycle.fromActivityLedger({ activities }), error);
  }
});

test("cycle membership refuses changed payloads even with the same Activity identity and order", () => {
  const original = activity(1);
  const cycle = ReviewFindingCycle.fromActivityLedger({ activities: [original] });
  const changed = original.toJSON();
  changed.note.text = "A different canonical note.";
  assert.throws(() => cycle.includesActivity(new FlowActivity(changed)), /exact canonical ledger Activity/);
  assert.equal(cycle.includesActivity(original), true);
});
