import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { dispatch } from "../../../src/lib/dispatcher.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunRecoverDraftExecutionCommand from "../../../src/flow/lib/run-recover-draft-execution.js";
import { CanonicalFlowRuntime } from "../../../src/flow/lib/canonical-flow-runtime.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake } from "../../support/infrastructure/flow-dispatch-scenario.js";

function context(root, specId, manager) {
  const flowState = manager.loadReadOnly(specId);
  return { root, mainRoot: root, executionRoot: root, specId, flowManager: manager, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: root, authorityRoot: root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" };
}

function snapshot(manager, specId) {
  return { state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
    catalog: manager.artifactCatalog(specId).toJSON() };
}

async function runDispatcher(root, specId, manager) {
  const agent = { async call() { assert.fail("this scenario dispatches only the registered Draft Gate command"); } };
  const command = new RunDispatchCommand({ agent, maxDispatches: 1 });
  command.container = dispatchContainer({ root, flowManager: manager, agent });
  return command.execute(context(root, specId, manager));
}

async function recoverThroughRegistry(root, specId, manager, argv) {
  const output = [];
  await dispatch({
    container: dispatchContainer({ root, flowManager: manager, agent: null }),
    entry: FLOW_COMMANDS.run["recover-draft-execution"], argv,
    envelopeType: "run", envelopeKey: "recover-draft-execution",
    stdout: (chunk) => output.push(chunk), stderr: () => {}, setExitCode: () => {},
    buildHookCtx: () => context(root, specId, manager),
  });
  return JSON.parse(output.join(""));
}

function createGateBoundary(root, specId) {
  fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
    guardrails: [{ id: "FULL-DRAFT", title: "Full Draft", body: "Evaluate the complete Draft.",
      meta: { phase: ["draft"], category: "requirements" } }],
  }));
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({ flowManager: manager, specId, runId: `run-${specId}`,
    request: "Resume the failed Draft Gate only after explicit correction authorization.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null } }).create().registerActive().activate("draft");
  manager.confirmCurrentAttempt({ specId, artifactWrites: [{ logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(workerArtifactJson(canonicalDraftDocument({ goal: `FULL_INPUT_HEAD ${"x".repeat(130000)} FULL_INPUT_TAIL` }))) }] });
  fixture.activate("draft-gate");
  return manager;
}

async function createFailedGate(root, specId) {
  const manager = createGateBoundary(root, specId);
  const provider = installGateProviderFake(() => JSON.stringify({ observations: null,
    evaluationUnavailable: { kind: "context-limit", reason: "The provider cannot evaluate the full input yet." } }));
  try {
    await runDispatcher(root, specId, manager);
    const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(restored.canonicalState(specId).attempt.failure.category, "step-result-error");
    return restored;
  } finally { provider.mock.restore(); }
}

it("explicitly recovers a provider-produced Draft Gate Step Error across reload and reruns that Gate", async () => {
  const root = fixtureRepository("draft-step-error-recovery-");
  const specId = "827-draft-step-error-recovery";
  let provider;
  try {
    let manager = createGateBoundary(root, specId);
    const beforeFailure = snapshot(manager, specId);
    const premature = new RunRecoverDraftExecutionCommand().execute({ ...context(root, specId, manager), reason: "No failure is saved yet." });
    assert.equal(premature.ok, false);
    assert.deepEqual(snapshot(manager, specId), beforeFailure);

    let corrected = false;
    const providerAttempts = [];
    provider = installGateProviderFake((prompt) => {
      const state = manager.canonicalState(specId);
      assert.equal(state.current.at(-1), "draft-gate");
      providerAttempts.push({ id: state.attempt.id, sequence: state.attempt.sequence });
      const file = /^Absolute file path: (.+)$/m.exec(prompt)?.[1];
      assert.ok(file);
      assert.match(fs.readFileSync(file, "utf8"), /FULL_INPUT_TAIL/);
      return JSON.stringify(corrected ? { observations: [], evaluationUnavailable: null }
        : { observations: null, evaluationUnavailable: { kind: "context-limit", reason: "The provider cannot evaluate the full input yet." } });
    });
    const failedRun = await runDispatcher(root, specId, manager);
    assert.equal(failedRun.ok, false);
    manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const failed = snapshot(manager, specId);
    assert.equal(failed.state.current, "draft-gate");
    assert.equal(failed.state.attempt.failure.category, "step-result-error");
    assert.equal(manager.canonicalState(specId).nextAction().operation, "blocked");
    const errorSettlement = manager.readCurrentStepSettlement({ specId, stepId: "draft-gate" });
    assert.equal(errorSettlement.result.kind, "draft-gate-error");
    const failedActivity = failed.activities.findLast((entry) => entry.transition.operation === "fail_attempt");
    assert.equal(failedActivity.result.draftSettlementReceipt.id, errorSettlement.receipt.id);
    const oldContext = context(root, specId, manager);
    const noReason = await recoverThroughRegistry(root, specId, manager, ["--expect-binding", oldContext.expectBinding]);
    assert.equal(noReason.ok, false);
    assert.equal(noReason.errors[0].code, "FLOW_DRAFT_EXECUTION_RECOVERY_INELIGIBLE");
    assert.deepEqual(snapshot(manager, specId), failed);
    const wrongTarget = await recoverThroughRegistry(root, specId, manager,
      ["--expect-run-id", "another-run", "--reason", "Restore the provider configuration."]);
    assert.equal(wrongTarget.ok, false);
    assert.deepEqual(snapshot(manager, specId), failed);
    const wrongAttempt = manager.canonicalState(specId).attempt.toJSON();
    wrongAttempt.id = "different-failed-attempt";
    assert.throws(() => manager.recoverDraftExecution({ specId, reason: "Restore the provider configuration.",
      expectedAttempt: wrongAttempt }), { code: "FLOW_DRAFT_EXECUTION_RECOVERY_INELIGIBLE" });
    assert.deepEqual(snapshot(manager, specId), failed);
    const stopped = await runDispatcher(root, specId, manager);
    assert.equal(stopped.dispatch.dispatchCount, 0);
    assert.equal(providerAttempts.length, 1);
    assert.deepEqual(snapshot(manager, specId), failed);

    corrected = true;
    const reason = "The provider configuration was corrected to evaluate the full Draft.";
    const recovered = await recoverThroughRegistry(root, specId, manager,
      ["--expect-binding", oldContext.expectBinding, "--reason", reason]);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const resumed = snapshot(manager, specId);
    assert.equal(resumed.state.current, "draft-gate");
    assert.notEqual(resumed.state.attempt.id, failed.state.attempt.id);
    assert.equal(resumed.state.attempt.sequence, failed.state.attempt.sequence + 1);
    assert.deepEqual(resumed.state.attempt.consumption, failed.state.attempt.consumption);
    assert.equal(resumed.state.attempt.failure, null);
    assert.deepEqual(resumed.activities.slice(0, failed.activities.length), failed.activities);
    const retainedPublications = (catalog) => catalog.artifacts.filter((entry) =>
      !["flow.state", "flow.activities"].includes(entry.logicalKey));
    assert.deepEqual(retainedPublications(resumed.catalog), retainedPublications(failed.catalog));
    const authorization = resumed.activities.at(-1);
    assert.equal(authorization.transition.operation, "recover_draft_step_error");
    assert.equal(authorization.transition.draftStepErrorRecoveryReceipt.failureReceiptId, errorSettlement.receipt.id);
    assert.equal(authorization.transition.draftStepErrorRecoveryReceipt.failedActivityId, failedActivity.id);
    assert.equal(authorization.transition.draftStepErrorRecoveryReceipt.reason, reason);
    assert.equal(manager.readCurrentStepSettlement({ specId, stepId: "draft-gate" }), null);
    const next = await new GetNextActionCommand().execute(context(root, specId, manager));
    assert.equal(next.step, "draft-gate");
    assert.equal(next.directive.kind, "execute_step");
    const replay = new RunRecoverDraftExecutionCommand().execute({ ...oldContext, flowManager: manager, reason });
    assert.equal(replay.ok, false);
    assert.deepEqual(snapshot(manager, specId), resumed);
    const repeated = await recoverThroughRegistry(root, specId, manager,
      ["--expect-binding", oldContext.expectBinding, "--reason", reason]);
    assert.equal(repeated.ok, false);
    assert.deepEqual(snapshot(manager, specId), resumed);

    await runDispatcher(root, specId, manager);
    const completed = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(completed.canonicalState(specId).nextAction().nodeId, "spec");
    assert.deepEqual(providerAttempts, [
      { id: failed.state.attempt.id, sequence: failed.state.attempt.sequence },
      { id: resumed.state.attempt.id, sequence: resumed.state.attempt.sequence },
    ]);
    const success = completed.activityLedger(specId).findLast((entry) => entry.nodeId === "draft-gate"
      && entry.result?.stepResult?.kind === "draft-gate-passed");
    assert.equal(success.attemptId, resumed.state.attempt.id);
    assert.equal(success.sequence, resumed.state.attempt.sequence);
    assert.deepEqual(completed.activityLedger(specId).slice(0, failed.activities.length), failed.activities);
  } finally { provider?.mock.restore(); removeTmpDir(root); }
});

it("refuses Draft Step Error recovery after a canonical change between selection and save", async (t) => {
  const root = fixtureRepository("draft-step-error-recovery-stale-");
  const specId = "828-draft-step-error-recovery-stale";
  try {
    const manager = await createFailedGate(root, specId);
    const original = CanonicalFlowRuntime.prototype.recoverDraftStepError;
    let concurrent;
    t.mock.method(CanonicalFlowRuntime.prototype, "recoverDraftStepError", function (input) {
      const other = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      other.addNote("The correction was updated while recovery authorization was being saved.", { specId });
      concurrent = snapshot(other, specId);
      return original.call(this, input);
    });
    assert.throws(() => manager.recoverDraftExecution({ specId,
      reason: "The provider configuration was corrected to evaluate the full Draft." }),
    /recovery authority changed before publication/);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.deepEqual(snapshot(reloaded, specId), concurrent);
    assert.equal(reloaded.canonicalState(specId).nextAction().operation, "blocked");
    assert.equal(reloaded.activityLedger(specId).some((entry) => entry.transition.operation === "recover_draft_step_error"), false);
  } finally { t.mock.restoreAll(); removeTmpDir(root); }
});

it("rolls back Draft recovery authorization and replacement Attempt when catalog publication is interrupted", async () => {
  const root = fixtureRepository("draft-step-error-recovery-atomicity-");
  const specId = "829-draft-step-error-recovery-atomicity";
  try {
    const manager = await createFailedGate(root, specId);
    const before = snapshot(manager, specId);
    const catalogFile = manager.specLocation(specId).catalogFile;
    const interrupted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId,
      versionStoreFaultInjector({ phase, filePath }) {
        if (phase === "before-json-rename" && filePath === catalogFile) {
          throw new Error("injected Draft recovery catalog interruption");
        }
      } });
    assert.throws(() => interrupted.recoverDraftExecution({ specId,
      reason: "The provider configuration was corrected to evaluate the full Draft." }),
    /injected Draft recovery catalog interruption/);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.deepEqual(snapshot(reloaded, specId), before);
    assert.equal(reloaded.canonicalState(specId).nextAction().operation, "blocked");
    assert.equal(reloaded.activityLedger(specId).some((entry) => entry.transition.operation === "recover_draft_step_error"), false);
  } finally { removeTmpDir(root); }
});
