import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { FinalizationPhaseScenario } from "../../support/finalization-phase-scenario.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { artifactPublicationClaimForStep, finalizationCompletionPublicationClaim } from "../../../src/flow/lib/flow-artifact-authority.js";

function canonicalBytes(flow) {
  const location = flow.manager.specLocation(flow.specId);
  return Object.fromEntries(["flow.json", "activities.jsonl", "artifact-catalog.json"]
    .map((file) => [file, fs.readFileSync(location.resolve(file))]));
}

test("Finalization completion rolls back both source confirmation and lifecycle publication before retry", async (t) => {
  const regression = await FinalizationPhaseScenario.seed(t, { frontier: "final-regression" });
  const seed = await FinalizationPhaseScenario.seed(t, { frontier: "finalize-commit",
    seedRoot: regression.root, seedSpecId: regression.specId });
  for (const boundary of ["activity-ready-to-append", "activity-appended"]) {
    await t.test(boundary, async (t) => {
      const flow = FinalizationPhaseScenario.fromSeed(t, seed);
      await flow.advanceTo("finalize-cleanup");
      let before = null;
      let injected = false;
      flow.reload({ versionStoreFaultInjector({ phase, activity }) {
        if (phase === "activity-ready-to-append" && activity?.result?.draftSettlementReceipt?.settlementKind === "completion") {
          before = canonicalBytes(flow);
        }
        if (!injected && phase === boundary && activity?.transition.operation === "finalize_flow") {
          injected = true;
          throw new Error(`Completion lifecycle publication fault: ${boundary}`);
        }
      } });
      const failed = await flow.runRegistered("finalize-cleanup");
      assert.equal(injected, true, `cleanup must reach the actual lifecycle Activity within its settlement save: ${JSON.stringify(failed)}`);
      assert.equal(failed.ok, false);
      assert.ok(before, "the source confirmation precedes the paired lifecycle Activity");
      assert.deepEqual(canonicalBytes(flow), before, "neither Activity nor its state/catalog may survive the aborted publication");
      flow.reload();
      assert.equal(flow.state().lifecycle.state, "active");
      assert.equal(flow.state().current.at(-1), "finalize-cleanup");
      assert.equal(flow.outbox("finalize-cleanup").status, "pending");
      const retried = await flow.runRegistered("finalize-cleanup");
      assert.notEqual(retried.ok, false, JSON.stringify(retried));
      flow.reload();
      assert.equal(flow.state().lifecycle.state, "finalized");
      assert.equal(flow.state().current, null);
      assert.equal(flow.state().attempt, null);
      assert.equal(flow.outbox("finalize-cleanup").status, "done");
      const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup", completed: true });
      assert.equal(saved.receipt.settlementKind, "completion");
      const finalized = flow.manager.activityLedger(flow.specId).filter((entry) => entry.type === "flow_finalized");
      assert.equal(finalized.length, 1);
      const completed = flow.snapshot();
      flow.manager.applyActivity(finalized[0], { specId: flow.specId });
      assert.deepEqual(flow.reload().snapshot(), completed, "exact lifecycle replay is read-only");
    });
  }
});

test("Finalization completion authority delegates only lifecycle state and ledger system slots", () => {
  const completion = finalizationCompletionPublicationClaim();
  const ordinary = artifactPublicationClaimForStep("finalize-cleanup");
  for (const logicalKey of ["flow.state", "flow.activities"]) {
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey);
    const slot = artifact.authoritySlotFor("system");
    assert.equal(completion.assertSlot(slot, { logicalKey, contractBound: true }), slot);
    assert.throws(() => ordinary.assertSlot(slot, { logicalKey, contractBound: true }), /step mismatch/);
  }
  const issue = FLOW_ARTIFACT_CONTRACTS.resolve("issue.log");
  assert.throws(() => completion.assertSlot(issue.authoritySlotFor("system"), {
    logicalKey: "issue.log", contractBound: true,
  }), /step mismatch/);
  const cleanupSlot = issue.authoritySlotFor("finalize-cleanup");
  assert.equal(completion.assertSlot(cleanupSlot, { logicalKey: "issue.log", contractBound: true }), cleanupSlot);
});
