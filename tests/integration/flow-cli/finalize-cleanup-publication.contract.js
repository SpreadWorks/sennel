import assert from "node:assert/strict";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { FinalizationPhaseScenario } from "../../support/finalization-phase-scenario.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { FinalizeCleanupCompletionPublication } from "../../../src/flow/lib/finalize-cleanup-publication.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";

function calls(flow) {
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: flow.root }).inventory;
  assert.equal(inventory.slot, null, "the owned command must physically close before readback");
  return inventory.executions.flatMap((execution) => execution.calls.map((call) => call.callId)).sort();
}

function checkpoint(flow) {
  const saved = flow.manager.readArtifact({ specId: flow.specId, logicalKey: "finalize.cleanup.publication",
    consumerNodeId: "finalize-cleanup" });
  return FinalizeCleanupCompletionPublication.fromStored(JSON.parse(saved.bytes));
}

function assertUnchanged(flow, before, callIds, attempt, journalPath) {
  // Compare the complete protected bytes, but format only a boolean on failure.
  assert.equal(isDeepStrictEqual(new CanonicalPersistenceSnapshot(flow.manager, flow.specId, [journalPath]), before), true,
    "refused completion replay must retain every canonical and journal byte");
  assert.deepEqual(calls(flow), callIds, "refused replay must register no new managed child");
  assert.equal(flow.state().lifecycle.state, "active");
  assert.equal(flow.current(), "finalize-cleanup");
  assert.deepEqual(flow.state().attempt.toJSON(), attempt);
  assert.equal(flow.outbox("finalize-cleanup").status, "pending");
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "finalize-cleanup", completed: true }), null);
}

async function interruptedCompletion(t, seed) {
  assert.equal(seed.frontier, "finalize-cleanup", "the shared seed must come from the normal cleanup-frontier producer");
  const flow = FinalizationPhaseScenario.fromSeed(t, seed);
  await flow.claimFrontier("finalize-cleanup");
  let injected = false;
  flow.reload({ versionStoreFaultInjector({ phase, activity }) {
    if (!injected && phase === "activity-ready-to-append" && activity?.transition.operation === "finalize_flow") {
      injected = true;
      throw new Error("Observed cleanup Completion publication interruption");
    }
  } });
  const result = await flow.runRegistered("finalize-cleanup");
  assert.equal(injected, true, "normal cleanup must reach the actual paired lifecycle publication");
  assert.equal(result.ok, false);
  flow.reload();
  const publication = checkpoint(flow);
  const state = flow.state();
  assert.equal(state.lifecycle.state, "active");
  assert.equal(state.current.at(-1), "finalize-cleanup");
  assert.equal(publication.receipt.settlementKind, "completion");
  assert.equal(publication.receipt.binding.attemptId, state.attempt.id);
  assert.equal(publication.receipt.binding.attemptSequence, state.attempt.sequence);
  assert.equal(flow.outbox("finalize-cleanup").status, "pending");
  assert.equal(flow.manager.readCurrentStepSettlement({ specId: flow.specId,
    stepId: "finalize-cleanup", completed: true }), null,
  "completed effects alone must not fabricate a committed Completion receipt");
  return flow;
}

/** A real canonical observation cannot be discarded as process bookkeeping. */
export async function assertCleanupPublicationRejectsCanonicalDrift(t, seed) {
  const flow = await interruptedCompletion(t, seed);
  flow.manager.addNote("Canonical input changed after completed cleanup effects.", { specId: flow.specId });
  flow.reload();
  const journalPath = flow.manager.specLocation(flow.specId).artifact("finalize.cleanup.journal");
  const before = new CanonicalPersistenceSnapshot(flow.manager, flow.specId, [journalPath]);
  const attempt = flow.state().attempt.toJSON();
  const callIds = calls(flow);
  await assert.rejects(FLOW_COMMANDS.run["finalize-cleanup"].pre(flow.context()),
    (error) => error instanceof StepAdmissionRefusal && error.cause instanceof CurrentFlowStateConflictError
      && error.message === "Cleanup completion publication source evidence changed");
  assertUnchanged(flow, before, callIds, attempt, journalPath);
}

/** Transient journal changes cannot borrow the immutable completed-effect claim. */
export async function assertCleanupPublicationRejectsJournalDrift(t, seed) {
  const flow = await interruptedCompletion(t, seed);
  const journalPath = flow.manager.specLocation(flow.specId).artifact("finalize.cleanup.journal");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const changedAt = "2001-01-01T00:00:00.000Z";
  assert.notEqual(journal.updatedAt, changedAt);
  fs.writeFileSync(journalPath, `${JSON.stringify({ ...journal, updatedAt: changedAt }, null, 2)}\n`);
  const before = new CanonicalPersistenceSnapshot(flow.manager, flow.specId, [journalPath]);
  const attempt = flow.state().attempt.toJSON();
  const callIds = calls(flow);
  await assert.rejects(FLOW_COMMANDS.run["finalize-cleanup"].pre(flow.context()),
    (error) => error instanceof StepAdmissionRefusal
      && error.message === "Cleanup completion publication lost its exact effect journal");
  assertUnchanged(flow, before, callIds, attempt, journalPath);
}

/** Catalog commit uncertainty must recover the originally selected receipt ID. */
export async function assertCleanupPublicationRecoversCommittedResponse(t, seed) {
  assert.equal(seed.frontier, "finalize-cleanup");
  const flow = FinalizationPhaseScenario.fromSeed(t, seed);
  await flow.claimFrontier("finalize-cleanup");
  const catalogFile = flow.manager.specLocation(flow.specId).catalogFile;
  let completionAppended = false;
  let injected = false;
  flow.reload({ versionStoreFaultInjector({ phase, activity, filePath }) {
    if (phase === "activity-appended" && activity?.transition.operation === "finalize_flow") completionAppended = true;
    if (!injected && completionAppended && phase === "before-json-readback" && filePath === catalogFile) {
      injected = true;
      throw new Error("Observed uncertain response after the cleanup catalog became visible");
    }
  } });
  const result = await flow.runRegistered("finalize-cleanup");
  assert.equal(completionAppended, true);
  assert.equal(injected, true, "fault must occur after the actual completion catalog rename");
  assert.notEqual(result.ok, false, "the exact committed receipt must recover an uncertain Store response");
  flow.reload();
  const publication = checkpoint(flow);
  const completed = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "finalize-cleanup", completed: true });
  assert.equal(completed.receipt.id, publication.receipt.id,
    "checkpoint publication and response recovery must preserve the selected receipt identity");
  assert.deepEqual(completed.result.toJSON(), publication.stepResult.toJSON());
  assert.equal(flow.state().lifecycle.state, "finalized");
  assert.equal(flow.state().current, null);
  assert.equal(flow.state().attempt, null);
  assert.equal(flow.outbox("finalize-cleanup").status, "done");
  assert.equal(flow.manager.activityLedger(flow.specId).filter((activity) => activity.type === "flow_finalized").length, 1);
  assert.equal(flow.manager.activityLedger(flow.specId).filter((activity) => activity.nodeId === "finalize-cleanup"
    && activity.result?.draftSettlementReceipt?.settlementKind === "completion").length, 1);
}
