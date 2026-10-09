import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

function canonicalSnapshot(manager, specId) {
  return {
    state: manager.canonicalState(specId).toJSON(),
    catalog: manager.artifactCatalog(specId).toJSON(),
    activities: manager.activityLedger(specId),
  };
}

for (const phase of ["checkpoint", "claimed"]) {
  test(`refuses a new generation from an unfinished ${phase} without resetting costs or mutating state`, async (t) => {
    const value = await createSpecGateRepairScenario({ specId: `500-budget-policy-${phase}` });
    t.after(() => removeTmpDir(value.root));
    const state = value.flowManager.canonicalState(value.specId);
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
    const context = request.inputs.find((input) => input.name === "spec-gate-repair-context.json").document;
    const reserve = () => reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    if (phase === "checkpoint") {
      t.mock.method(value.flowManager, "claimDraftStepExecution", () => {
        throw new Error("interrupted before provider claim");
      });
      assert.throws(reserve, /interrupted before provider claim/);
    } else reserve();

    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const input = { flowManager: reloaded, specId: value.specId, attemptId: state.attempt.id,
      baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" };
    const saved = latestRepairBudget(input);
    const spent = saved.budget.snapshot();
    assert.equal(saved.document.phase, phase);
    assert.equal(spent.providerCallCount, phase === "checkpoint" ? 0 : 1);
    assert.equal(spent.aggregateCharacters, saved.document.callCost.characters);
    const before = canonicalSnapshot(reloaded, value.specId);
    assert.throws(() => latestRepairBudget({ ...input, forNewGeneration: true }), {
      code: "FLOW_SPEC_GATE_REPAIR_PROGRESS_MISMATCH",
    });
    assert.deepEqual(latestRepairBudget(input).budget.snapshot(), spent);
    assert.deepEqual(canonicalSnapshot(reloaded, value.specId), before);
  });
}
