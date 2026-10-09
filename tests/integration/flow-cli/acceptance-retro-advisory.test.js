import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AcceptancePhaseScenario } from "../../support/acceptance-phase-scenario.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";

// Outcome -> consumer -> producer: Acceptance must retain failed-test/NotDone
// blockers after an explicit advisory continuation. Genuine test execution and
// its result Review produce the evidence; Retro's original receipt remains the
// authority for the accepted continuation and exact replay after reload.
test("Retro advisory preserves genuine NotDone, source receipt and downstream Acceptance blockers", async (t) => {
  const scenario = AcceptancePhaseScenario.create(t);
  await scenario.advanceTo("retro");
  fs.renameSync(path.join(scenario.root, "src/implementation.js"), path.join(scenario.root, "src/implementation.missing"));
  assert.equal((await scenario.runRegistered("retro")).result, "recovered");
  scenario.reload();
  await scenario.advanceTo("test-result-review");
  const failed = scenario.commandArtifact("test.execute", "test-result-review");
  assert.equal(failed.payload.process.exitCode, 1);
  assert.equal(failed.payload.summary[0].result, "fail");
  await scenario.advanceTo("retro");
  let original = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "retro" });
  for (let index = 0; original === null && index < 3; index += 1) {
    await scenario.executeCurrent();
    scenario.reload();
    original = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "retro" });
  }
  assert.equal(original.result.kind, "retro-incomplete");
  assert.equal(original.result.evidence.notDone, 1);
  assert.equal(original.receipt.settlementKind, "await");
  const retro = scenario.artifact("retro", undefined, "acceptance-review");
  assert.equal(JSON.parse(retro.bytes).summary.not_done, 1);
  const history = scenario.manager.activityLedger(scenario.specId);
  activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
    reason: "Retain the genuine failing observation as advisory." });
  scenario.reload();
  const context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(), scenario.manager);
  const decision = { root: scenario.root, flowManager: scenario.manager, choice: "continue",
    reason: "Acceptance must assess the original NotDone.", remainingRisk: "The genuine requirement test remains failed.",
    expectEvidenceDigest: context.evidenceDigest };
  recordNonBlockingDecision(decision);
  scenario.reload();
  assert.equal(scenario.current(), "acceptance-review");
  const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "retro", completed: true });
  assert.equal(saved.result.kind, "retro-incomplete");
  assert.equal(saved.result.evidence.notDone, original.result.evidence.notDone);
  assert.deepEqual(saved.result.evidence.publication.toJSON(), original.result.evidence.publication.toJSON());
  assert.equal(saved.result.evidence.acceptedDecision.sourceReceiptId, original.receipt.id);
  assert.equal(saved.receipt.binding.attemptSequence, original.receipt.binding.attemptSequence + 1);
  assert.equal(saved.receipt.targetStepId, "acceptance-review");
  assert.deepEqual(scenario.artifact("retro", undefined, "acceptance-review").bytes, retro.bytes);
  for (const activity of history) assert.ok(scenario.manager.activityLedger(scenario.specId).some((entry) => entry.id === activity.id));
  const beforeReplay = scenario.snapshot();
  recordNonBlockingDecision({ ...decision, flowManager: scenario.manager });
  scenario.reload();
  assert.deepEqual(scenario.snapshot(), beforeReplay);
  const consumed = await scenario.observeAcceptanceInput();
  assert.ok(consumed.mechanicalBlockers.some((entry) => entry.kind === "failed_tests"));
  assert.ok(consumed.mechanicalBlockers.some((entry) => entry.kind === "failed_retro"));
  await scenario.executeCurrent();
  scenario.reload();
  assert.equal(scenario.state().attempt.nodeId, "acceptance-review");
  await scenario.runRegistered("acceptance-review");
  scenario.reload();
  const blocked = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "acceptance-review" });
  assert.equal(blocked.result.kind, "acceptance-review-mechanically-blocked");
  assert.equal(blocked.receipt.settlementKind, "await");
  assert.equal(scenario.commandArtifact("test.execute", "acceptance-review").payload.summary[0].result, "fail");
  assert.equal(scenario.acceptanceCalls.length, 0);
});
