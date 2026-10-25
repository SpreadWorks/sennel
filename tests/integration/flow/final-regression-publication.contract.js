import assert from "node:assert/strict";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { FinalRegressionExecutionRequiredResult } from "../../../src/flow/engine/step-result.js";
import { withFlowProcessRuntime } from "../../../src/flow/lib/process-runtime-admission.js";
import RunFinalRegressionCommand from "../../../src/flow/lib/run-final-regression.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state-conflict-error.js";
import { prepareFinalRegressionPublication } from "../../../src/flow/engine/composition/acceptance-finalization.js";
import { ImplStepBinding } from "../../../src/flow/engine/connectors/impl/impl-step-binding.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { validateFinalRegressionResult } from "../../../src/flow/lib/test-artifacts.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { writeFile } from "../../support/builders/tmp-dir.js";
import { commitAll } from "../../support/infrastructure/git-repo.js";
import { makeFlowManager } from "../../support/infrastructure/flow-setup.js";

/** The same project-level command input for both lawful fixture producers. */
export function configureAdmittedFinalRegressionProject(ctx, configuration) {
  const config = { ...configuration, test: { timeout: 5,
    command: { kind: "native", executable: process.execPath,
      args: ["-e", "process.stdout.write('TAP version 13\\n1..1\\nok 1 - admitted final pass\\n')"] } } };
  writeFile(ctx.root, ".sennel/config.json", JSON.stringify(config));
  ctx.config = config;
  // Preserve the original tracked true-to-false source-drift scenario on clones.
  writeFile(ctx.root, "regression-behavior.js", "export const regressionBehavior = true;\n");
  commitAll(ctx.root, "record admitted regression command");
  return ctx;
}

export function readFinalRegressionArtifact(ctx) {
  const history = JSON.parse(ctx.flowManager.readArtifact({
    specId: ctx.specId,
    logicalKey: "final.regression",
    consumerNodeId: "report",
  }).bytes.toString("utf8"));
  return validateFinalRegressionResult(history.attempts.at(-1).artifact.payload);
}

async function runAdmittedCommand(ctx, consume) {
  return withFlowProcessRuntime(ctx, async () => {
    const runtime = ProcessExecutionRuntime.current();
    const result = await new RunFinalRegressionCommand().execute(ctx);
    assert.equal(result.result, "pass");
    await consume(result);
    return runtime.executionId;
  }, { commandId: "final-regression" });
}

export async function assertAdmittedFinalRegressionPublication(t, ctx) {
  const executionId = await runAdmittedCommand(ctx,
    result => FLOW_COMMANDS.run["final-regression"].post(ctx, result));
  const restarted = makeFlowManager(ctx.root);
  const saved = restarted.readCurrentStepSettlement({ specId: ctx.specId, stepId: "final-regression", completed: true });
  assert.equal(saved.result.kind, "final-regression-passed");
  assert.equal(readFinalRegressionArtifact({ ...ctx, flowManager: restarted }).completed, true);
  assert.equal(restarted.canonicalState(ctx.specId).nextAction().nodeId, "report");
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: ctx.root }).inventory;
  assert.equal(inventory.slot, null);
  const execution = inventory.executions.find(entry => entry.executionId === executionId);
  assert.equal(execution.status, "closed");
  assert.ok(execution.calls.length > 1);
  assert.ok(execution.calls.every(call => call.receipt?.observation.code === 0));
  const canonical = restarted.activityLedger(ctx.specId)
    .filter(activity => activity.processEvent?.executionId === executionId).map(activity => activity.processEvent);
  assert.deepEqual(canonical, execution.events);
  assert.equal(canonical.filter(event => event.type === "result-finalized").length, execution.calls.length);
  assert.deepEqual(execution.eventAcknowledgements.map(entry => entry.eventId), canonical.map(event => event.eventId));
}

export async function assertChangedSourcePublicationRefusal(t, ctx) {
  await runAdmittedCommand(ctx, async (result) => {
    const before = ctx.flowManager.canonicalState(ctx.specId).attempt;
    const executionRequired = ctx.flowManager.readCurrentStepSettlement({ specId: ctx.specId, stepId: "final-regression" });
    assert.ok(executionRequired.result instanceof FinalRegressionExecutionRequiredResult);
    assert.equal(executionRequired.result.type, "loop-required");
    assert.equal(executionRequired.settlement.kind, "execution");
    const executionRequiredReceipt = executionRequired.receipt.toJSON();
    assert.equal(ctx.flowManager.readCurrentStepSettlement({ specId: ctx.specId, stepId: "final-regression", completed: true }), null);
    writeFile(ctx.root, "regression-behavior.js", "export const regressionBehavior = false;\n");
    await assert.rejects(FLOW_COMMANDS.run["final-regression"].post(ctx, result),
      error => error instanceof StepAdmissionRefusal && /source changed before publication/.test(error.message));
    assert.equal(ctx.flowManager.canonicalState(ctx.specId).attempt.id, before.id);
    const after = ctx.flowManager.readCurrentStepSettlement({ specId: ctx.specId, stepId: "final-regression" });
    assert.ok(after.result instanceof FinalRegressionExecutionRequiredResult);
    assert.deepEqual(after.result.toJSON(), executionRequired.result.toJSON());
    assert.deepEqual(after.receipt.toJSON(), executionRequiredReceipt);
    assert.equal(after.activityId, executionRequired.activityId);
    assert.equal(ctx.flowManager.readCurrentStepSettlement({ specId: ctx.specId, stepId: "final-regression", completed: true }), null);
    assert.equal(ctx.flowManager.readArtifact({ specId: ctx.specId, logicalKey: "final.regression",
      consumerNodeId: "final-regression", optional: true }), null);
  });
}

export async function assertChangedJournalPublicationRefusal(t, ctx) {
  const acquire = ctx.flowManager.prepareAcceptanceCommandPublication;
  let afterChange;
  t.mock.method(ctx.flowManager, "prepareAcceptanceCommandPublication", function (input) {
    const publication = acquire.call(this, input);
    this.appendIssueLog({ specId: ctx.specId, entry: { step: "final-regression",
      reason: "Canonical evidence changed after publication acquisition." }, idempotencyKey: "post-acquisition-note" });
    afterChange = new CanonicalPersistenceSnapshot(this, ctx.specId);
    return publication;
  });
  await runAdmittedCommand(ctx, async (result) => {
    await assert.rejects(FLOW_COMMANDS.run["final-regression"].post(ctx, result),
      error => error instanceof StepAdmissionRefusal
        && error.cause instanceof CurrentFlowStateConflictError
        && error.message === "implementation command publication changed before settlement"
        && error.cause.message === error.message);
    afterChange.assertUnchanged(ctx.flowManager, ctx.specId, "stale command publication");
    assert.equal(ctx.flowManager.readArtifact({ specId: ctx.specId, logicalKey: "final.regression",
      consumerNodeId: "final-regression", optional: true }), null);
  });
}

export async function assertStaleAttemptPublicationRefusal(t, ctx) {
  let commandResult;
  await runAdmittedCommand(ctx, result => { commandResult = result; });
  const binding = new ImplStepBinding({ flowManager: ctx.flowManager, specId: ctx.specId, stepId: "final-regression" });
  ctx.flowManager.failCurrentAttempt({ specId: ctx.specId, failure: { category: "semantic",
    code: "FINAL_REGRESSION_FAILED", message: "The original Attempt is no longer admitted.",
    retryable: false, retryKind: null } });
  const before = new CanonicalPersistenceSnapshot(ctx.flowManager, ctx.specId);
  const beforeCalls = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: ctx.root }).inventory.executions
    .flatMap(execution => execution.calls.map(call => call.callId));
  await assert.rejects(withFlowProcessRuntime(ctx, () => prepareFinalRegressionPublication({
    flowManager: ctx.flowManager, binding, commandResult }), { commandId: "final-regression" }),
  error => error instanceof CurrentFlowStateConflictError && /Step binding is stale/.test(error.message));
  before.assertUnchanged(ctx.flowManager, ctx.specId, "stale Attempt fingerprint admission");
  const inventory = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: ctx.root }).inventory;
  assert.equal(inventory.slot, null);
  assert.deepEqual(inventory.executions.flatMap(execution => execution.calls.map(call => call.callId)), beforeCalls);
}
