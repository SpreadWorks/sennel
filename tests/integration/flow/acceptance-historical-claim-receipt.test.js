import assert from "node:assert/strict";
import { test } from "node:test";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { UnknownProviderFailure } from "../../../src/lib/agent-failure.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";

test("a real failed Acceptance provider retains exact historical claim readback without authorizing stale execution", async (t) => {
  const lost = new UnknownProviderFailure({ message: "actual Acceptance provider response lost" });
  const scenario = AcceptancePhaseScenario.create(t, { acceptanceProvider: () => { throw lost; } });
  await scenario.advanceTo("acceptance-review");
  const captures = [];
  const original = FlowManager.prototype.commitSpecStepResult;
  const capture = t.mock.method(FlowManager.prototype, "commitSpecStepResult", function (input) {
    if (input.stepResult?.stepId === "acceptance-review" && input.executionLifecycle?.phase === "claimed") {
      captures.push({ input, before: this.canonicalState(scenario.specId) });
    }
    return original.call(this, input);
  });
  const failed = await scenario.runRegistered("acceptance-review");
  capture.mock.restore();
  assert.equal(failed.ok, false);
  assert.equal(captures.length, 1, "the actual provider follows one typed claimed save");
  scenario.reload();
  const { input, before } = captures[0];
  const latest = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
  assert.equal(latest.result.type, "error");
  const claim = scenario.manager.findStepSettlementReceipt(input);
  assert.notEqual(claim, null, "later Error publication cannot erase exact immutable claim readback");
  assert.equal(claim.executionLifecycle.phase, "claimed");
  assert.notEqual(claim.id, latest.receipt.id);
  const owning = scenario.manager.activityLedger(scenario.specId)
    .find((entry) => entry.result?.draftSettlementReceipt?.id === claim.id);
  assert.equal(owning.confirmationOrder, before.confirmationOrder + 1);
  scenario.assertResults(["acceptance-review"], { terminal: false });
  const snapshot = scenario.snapshot();
  assert.throws(() => scenario.manager.settleAcceptanceStepResult(input), CurrentFlowStateConflictError);
  assert.throws(() => scenario.manager.commitSpecStepResult(input), StepAdmissionRefusal);
  assert.deepEqual(scenario.reload().snapshot(), snapshot, "readback grants no stale write or provider generation");
  assert.equal(scenario.acceptanceCalls.length, 1);
});
