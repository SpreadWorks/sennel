import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { CurrentFlowState, CurrentFlowStateInvariantError } from "../../../src/flow/lib/current-flow-state.js";
import { DraftStepSettlementReceipt } from "../../../src/flow/definition.js";

function leaf(value, id) {
  if (value.id === id) return value;
  return value.steps?.map((child) => leaf(child, id)).find((entry) => entry !== undefined);
}

function reidentify(receipt) {
  receipt.id = createHash("sha256").update(JSON.stringify(DraftStepSettlementReceipt.identity(receipt))).digest("hex");
}

test("Retro's real stale rewind retains its source, protects untouched tail, and re-enters through a fresh selected claim", async (t) => {
  const scenario = AcceptancePhaseScenario.create(t);
  await scenario.advanceTo("retro");
  scenario.reload();
  const originalAttempt = scenario.state().attempt;
  fs.appendFileSync(path.join(scenario.root, "src/implementation.js"), "\n// changed source requires fresh independent test evidence\n");
  const outcome = await scenario.runRegistered("retro");
  assert.equal(outcome.result, "recovered");
  scenario.reload();
  const state = scenario.state();
  assert.equal(state.current.at(-1), "test-execute");
  const source = state.findNode("retro");
  assert.equal(source.status, "invalidated", "a stale observation must not claim completed Retro aggregation");
  assert.equal(source.result.stepResult.kind, "retro-evidence-refresh");
  const receipt = source.result.draftSettlementReceipt;
  assert.equal(receipt.binding.attemptId, originalAttempt.id);
  assert.equal(receipt.binding.attemptSequence, originalAttempt.sequence);
  assert.equal(receipt.targetStepId, "test-execute");
  assert.equal(receipt.effects.resetStepIds.includes("retro"), false);
  for (const id of ["test-result-review", "impl-review", "impl-gate"]) assert.equal(state.findNode(id).status, "invalidated");
  for (const id of ["acceptance-review", "acceptance-decision", "final-regression", "report"]) {
    const node = state.findNode(id);
    assert.deepEqual([node.status, node.attemptSequence, node.result], ["pending", 0, null]);
  }
  const saved = state.toJSON();
  const restore = (value) => new CurrentFlowState(value, { definition: state.definition });
  assert.deepEqual(restore(saved).toJSON(), saved, "the mixed frontier must survive its actual persisted readback");

  const mutations = [
    ["missing retained source", (value) => { const node = leaf(value, "retro"); node.status = "invalidated"; node.result = null; }],
    ["changed retained binding", (value) => { const current = leaf(value, "retro").result.draftSettlementReceipt; current.binding.attemptId += "-other"; reidentify(current); }],
    ["changed selected target", (value) => { const current = leaf(value, "retro").result.draftSettlementReceipt; current.targetStepId = "impl-gate"; reidentify(current); }],
    ["changed reset effects", (value) => { const current = leaf(value, "retro").result.draftSettlementReceipt; current.effects.resetStepIds = current.effects.resetStepIds.filter((id) => id !== "final-regression"); reidentify(current); }],
    ["pending node in executed prefix", (value) => { const node = leaf(value, "test-result-review"); node.status = "pending"; node.attemptSequence = 0; }],
    ["attempted pending tail", (value) => { leaf(value, "final-regression").attemptSequence = 1; }],
    ["unexecuted tail containing a result", (value) => { leaf(value, "final-regression").result = leaf(value, "retro").result; }],
  ];
  for (const [name, mutate] of mutations) {
    const altered = structuredClone(saved);
    mutate(altered);
    assert.throws(() => restore(altered), CurrentFlowStateInvariantError, name);
    assert.deepEqual(restore(saved).toJSON(), saved, `${name} refusal cannot alter the original state`);
  }

  await scenario.advanceTo("retro");
  scenario.reload();
  const repeated = scenario.state();
  assert.equal(repeated.findNode("retro").status, "in_progress");
  assert.equal(repeated.findNode("retro").result, null);
  assert.equal(repeated.attempt.sequence, originalAttempt.sequence + 1);
  assert.notEqual(repeated.attempt.id, originalAttempt.id);
  assert.deepEqual([repeated.attempt.consumption.semantic, repeated.attempt.consumption.tooling], [0, 0]);
  const archived = scenario.manager.activityLedger(scenario.specId).find((entry) => entry.result?.draftSettlementReceipt?.id === receipt.id);
  assert.equal(archived.result.stepResult.kind, "retro-evidence-refresh");
  await scenario.runRegistered("retro");
  scenario.reload();
  assert.equal(scenario.current(), "acceptance-review");
  assert.equal(scenario.state().findNode("retro").result.stepResult.kind, "retro-aggregated");
  assert.deepEqual([scenario.state().findNode("final-regression").status,
    scenario.state().findNode("final-regression").attemptSequence], ["pending", 0]);
});
