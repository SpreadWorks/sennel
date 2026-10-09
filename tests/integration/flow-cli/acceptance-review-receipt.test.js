import assert from "node:assert/strict";
import { test } from "node:test";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { AcceptanceReceiptReplay } from "../../../src/flow/lib/acceptance-receipt-replay.js";

test("Acceptance repair registry post authenticates its exact invalidated-source receipt across reload", async (t) => {
  let status = "notMet";
  const flow = AcceptancePhaseScenario.create(t, {
    acceptanceResponse: (_ordinal, scenario) => acceptanceProviderResponse(scenario, { status }),
  });
  await flow.advanceTo("acceptance-review");
  const result = await flow.runRegistered("acceptance-review");
  assert.equal(result.verdict, "repair_required", JSON.stringify(result));
  const execution = flow.registeredExecutions.at(-1);
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.stderr, "");
  const envelope = JSON.parse(execution.stdout);
  assert.equal(envelope.ok, true);
  assert.equal((envelope.errors ?? []).some((entry) => entry.code === "POST_HOOK_FAILED"), false);
  const receipt = JSON.parse(JSON.stringify(result.settlementReceipt));
  flow.reload();
  assert.equal(flow.current(), "impl-triage");
  assert.equal(flow.state().findNode("acceptance-review").status, "invalidated");
  assert.equal(flow.state().findNode("acceptance-review").result, null);
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "acceptance-review", completed: true }), null);
  const read = flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "acceptance-review", completed: true, exactReceipt: receipt });
  assert.equal(read.result.kind, "acceptance-review-repair-required");
  assert.equal(read.receipt.id, receipt.id);
  assert.equal(read.settlement.targetStepId, "impl-triage");
  const replay = new AcceptanceReceiptReplay({ flowManager: flow.manager,
    specId: flow.specId, stepId: "acceptance-review", receipt });
  const before = flow.snapshot();
  await FLOW_COMMANDS.run["acceptance-review"].post(flow.context(), result);
  for (const invalid of [
    { ...result, settlementReceipt: undefined },
    { ...result, settlementReceipt: { ...receipt, id: "f".repeat(64) } },
    { ...result, settlementReceipt: { ...receipt, binding: { ...receipt.binding, runId: "foreign-run" } } },
  ]) {
    await assert.rejects(() => FLOW_COMMANDS.run["acceptance-review"].post(flow.context(), invalid), /receipt|run|publication/i);
    assert.deepEqual(flow.reload().snapshot(), before);
  }
  replay.assertCurrent();
  assert.deepEqual(flow.snapshot(), before, "receipt authentication cannot recreate a completed source or mutate the repair frontier");

  status = "met";
  await flow.advanceTo("acceptance-review");
  const newAttempt = flow.snapshot();
  assert.throws(() => replay.assertCurrent(), /Attempt|receipt/i);
  assert.deepEqual(flow.snapshot(), newAttempt, "claiming a new Review Attempt already makes the old receipt stale");
  const next = await flow.runRegistered("acceptance-review");
  assert.equal(next.verdict, "pass", JSON.stringify(next));
  flow.reload();
  const replaced = flow.snapshot();
  assert.throws(() => replay.assertCurrent(), /publication|receipt/i);
  await assert.rejects(() => FLOW_COMMANDS.run["acceptance-review"].post(flow.context(), result), /publication|receipt/i);
  assert.deepEqual(flow.reload().snapshot(), replaced, "a replaced artifact cannot restore the old Review receipt's authority");
});
