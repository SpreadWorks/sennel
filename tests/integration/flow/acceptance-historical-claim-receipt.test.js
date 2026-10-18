import assert from "node:assert/strict";
import { test } from "node:test";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";

test("a returned invalid Acceptance response retains exact historical claim readback after Error without authorizing stale execution", async (t) => {
  const scenario = AcceptancePhaseScenario.create(t, {
    acceptanceResponse: (_ordinal, active) => {
      const response = acceptanceProviderResponse(active);
      response.requirementJudgments[0].diffRefs = "invalid external response";
      return response;
    },
  });
  await scenario.advanceTo("acceptance-review");
  const captures = [];
  const original = FlowManager.prototype.commitSpecStepResult;
  const capture = t.mock.method(FlowManager.prototype, "commitSpecStepResult", function (input) {
    const before = this.canonicalState(scenario.specId);
    const result = original.call(this, input);
    if (input.stepResult?.stepId === "acceptance-review" && input.executionLifecycle?.phase === "claimed") {
      const receipt = this.findStepSettlementReceipt(input);
      assert.notEqual(receipt, null, "the claimed save completed before the external provider starts");
      captures.push({ input, before, receipt });
    }
    return result;
  });
  const failed = await scenario.runRegistered("acceptance-review");
  capture.mock.restore();
  assert.equal(failed.ok, false);
  assert.equal(failed.errors[0].code, "ACCEPTANCE_RESPONSE_INVALID", JSON.stringify(failed));
  assert.equal(captures.length, 1, "the actual provider follows one typed claimed save");
  scenario.reload();
  const { input, before, receipt } = captures[0];
  const latest = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
  assert.equal(latest.result.type, "error");
  const claim = scenario.manager.findStepSettlementReceipt(input);
  assert.notEqual(claim, null, "later Error publication cannot erase exact immutable claim readback");
  assert.deepEqual(claim.toJSON(), receipt.toJSON(), "reload authenticates the exact completed claim save");
  assert.equal(claim.executionLifecycle.phase, "claimed");
  assert.notEqual(claim.id, latest.receipt.id);
  const owning = scenario.manager.activityLedger(scenario.specId)
    .find((entry) => entry.result?.draftSettlementReceipt?.id === claim.id);
  assert.equal(owning.confirmationOrder, before.confirmationOrder + 1);
  scenario.assertResults(["acceptance-review"], { terminal: false });
  const snapshot = scenario.snapshot();
  const providerCalls = scenario.acceptanceProviderCalls.length;
  assert.ok(providerCalls > 0, "the real managed transport returned the invalid response before Error publication");
  assert.throws(() => scenario.manager.settleAcceptanceStepResult(input), CurrentFlowStateConflictError);
  assert.throws(() => scenario.manager.commitSpecStepResult(input), StepAdmissionRefusal);
  assert.deepEqual(scenario.reload().snapshot(), snapshot, "readback grants no stale write or provider generation");
  assert.equal(scenario.acceptanceCalls.length, 1);
  assert.equal(scenario.acceptanceProviderCalls.length, providerCalls,
    "historical readback and stale-write refusals authorize no additional RPC");
});
