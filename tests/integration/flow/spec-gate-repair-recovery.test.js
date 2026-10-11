import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it, mock } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { FlowDispatchTarget } from "../../../src/flow/lib/dispatch-invocation.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { latestRepairBudget, SpecGateRepairProgressLedger } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { dispatch as dispatchCommand } from "../../../src/lib/dispatcher.js";
import { buildFlowCommandHookContext } from "../../../src/flow/lib/flow-context.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { CanonicalWorkerSpecPublication } from "../../../src/flow/lib/current-flow-state.js";
import { SpecGateRepairSelection } from "../../../src/flow/lib/spec-gate-repair-worker-facts.js";
import { SpecGateRepairReadyForGateResult, SpecGateRepairContextRequiredResult } from "../../../src/flow/engine/step-result.js";
import { settleSpecStepResult } from "../../../src/flow/definition.js";
import { prepareSpecGateRepairService } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { readSpecJsonValidator } from "../../../src/lib/spec-json.js";
import { LegacySpecGateRepairErrorSeed } from "../../support/infrastructure/spec-gate-repair-legacy-error.js";
import { dispatchContainer } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

function reload(value, options = {}) {
  return new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false,
    specId: value.specId, ...options });
}

function context(value, manager) {
  const flowState = manager.loadReadOnly(value.specId);
  return { root: value.root, mainRoot: value.root, executionRoot: value.root, specId: value.specId,
    flowManager: manager, flowState,
    expectBinding: FlowTargetBinding.capture({ flowState, mainRoot: value.root, authorityRoot: value.root }).serialize(),
    _envelopeType: "run", _envelopeKey: "dispatch" };
}

function recoveryInput(value, manager) {
  return { specId: value.specId, executionRoot: value.root,
    targetDigest: FlowDispatchTarget.captureContext(context(value, manager)).digest };
}

function snapshot(manager, value) {
  const catalog = manager.artifactCatalog(value.specId).toJSON();
  const activities = manager.activityLedger(value.specId);
  const state = manager.canonicalState(value.specId).toJSON();
  const spec = manager.readArtifact({ specId: value.specId, logicalKey: "spec.record",
    consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8");
  const budget = latestRepairBudget({ flowManager: manager, specId: value.specId,
    attemptId: value.error.attemptId, baseRevision: value.baseRevision,
    consumerNodeId: "spec-gate-repair" }).budget.snapshot();
  const progress = new SpecGateRepairProgressLedger({ flowManager: manager, specId: value.specId,
    attemptId: value.error.attemptId, baseRevision: value.baseRevision }).entries;
  const journal = manager.readArtifact({ specId: value.specId, logicalKey: "flow.activities",
    consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8");
  return { state, activities, catalog, spec, budget, progress, journal };
}

function count(saved, logicalKey) {
  return saved.catalog.artifacts.filter((artifact) => artifact.logicalKey === logicalKey).length;
}

function assertRecoveryOnly(before, after, preview) {
  assert.deepEqual(after.state.attempt, { ...before.state.attempt, failure: null });
  assert.deepEqual(after.state.current, before.state.current);
  assert.equal(after.spec, before.spec);
  assert.deepEqual(after.budget, before.budget);
  assert.deepEqual(after.progress, before.progress);
  assert.deepEqual(after.activities.slice(0, before.activities.length), before.activities);
  assert.equal(after.activities.length, before.activities.length + 1);
  assert.equal(after.journal.slice(0, before.journal.length), before.journal);
  const recovery = after.activities.at(-1);
  assert.equal(recovery.transition.operation, "recover_spec_gate_repair");
  assert.equal(recovery.attemptId, before.state.attempt.id);
  const receipt = recovery.result.draftSettlementReceipt;
  assert.equal(receipt.specGateRepairRecovery.errorReceiptId, preview.errorReceiptId);
  assert.equal(receipt.specGateRepairRecovery.sourcePublicationReceiptId, preview.sourcePublicationReceiptId);
  assert.equal(receipt.executionLifecycle.phase, "publication");
  assert.equal(receipt.settlementKind, "execution");
  assert.equal(receipt.targetStepId, null);
  const source = before.activities.find((entry) => entry.result?.draftSettlementReceipt?.id === preview.sourcePublicationReceiptId);
  assert.deepEqual(receipt.executionLifecycle, source.result.draftSettlementReceipt.executionLifecycle);
  for (const key of ["spec.snapshot", "spec.gate.repair.audit", "spec.gate.repair.progress", "spec.gate", "spec.review"]) {
    assert.equal(count(after, key), count(before, key), key);
  }
}

async function dispatch(value, manager, agent, maxDispatches = 1) {
  const command = new RunDispatchCommand({ agent, maxDispatches });
  command.container = dispatchContainer({ root: value.root, flowManager: manager, agent });
  return command.execute(context(value, manager));
}

async function registeredRecovery(value, manager, argv) {
  const registration = FLOW_COMMANDS.run["recover-spec-gate-repair"];
  assert.notEqual(registration, undefined, "public recovery command must be available");
  const container = dispatchContainer({ root: value.root, flowManager: manager,
    agent: { async call() { throw new Error("recovery must not invoke a provider"); } } });
  let stdout = "";
  let exitCode;
  await dispatchCommand({ container, entry: registration, argv, envelopeType: "run", envelopeKey: "recover-spec-gate-repair",
    buildHookCtx: (current, input) => buildFlowCommandHookContext(current, registration, input),
    stdout: (text) => { stdout += text; }, stderr: () => {}, setExitCode: (code) => { exitCode = code; } });
  return { envelope: JSON.parse(stdout), exitCode };
}

function recoveryCli(value, argv) {
  const result = childProcess.spawnSync(process.execPath,
    [fileURLToPath(new URL("../../../src/sennel.js", import.meta.url)), "flow", "run", "recover-spec-gate-repair", ...argv],
    { cwd: value.root, encoding: "utf8", env: { ...process.env,
      SENNEL_WORK_ROOT: value.root, SENNEL_SOURCE_ROOT: value.root } });
  assert.equal(result.error, undefined, "public CLI process must start successfully");
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `public recovery command must succeed: ${result.stdout}\n${result.stderr}`);
  return { envelope: JSON.parse(result.stdout), exitCode: result.status };
}

function changeRules(value) {
  fs.writeFileSync(path.join(value.root, ".sennel", "guardrail.json"), workerArtifactJson({ guardrails: [{
    id: "R1", body: "The changed Spec rule requires a different behavior.",
    meta: { phase: ["spec"], category: "requirements" },
  }] }));
}

describe("Explicit recovery of a genuine legacy Spec Gate repair Error", { concurrency: false }, () => {
  let legacy;
  before(() => { legacy = new LegacySpecGateRepairErrorSeed(); });
  after(() => { legacy?.dispose(); });

  it("previews unchanged saved input, appends recovery, then dispatches the same candidate into actual Review", async (t) => {
    const value = await legacy.create();
    t.after(() => removeTmpDir(value.root));
    let manager = reload(value);
    const before = snapshot(manager, value);
    assert.equal(before.budget.providerCallCount, 1);
    assert.equal(count(before, "spec.gate.repair.audit"), 0);
    assert.deepEqual(before.progress.at(-1).proposal, value.proposal);
    const input = recoveryInput(value, manager);
    const preview = manager.previewSpecGateRepairRecovery(input);
    const previewJson = preview.toJSON();
    assert.equal(previewJson.resultKind, "spec-gate-repair-review-required");
    assert.equal(previewJson.targetStepId, "spec-review");
    assert.equal(previewJson.executionGeneration,
      value.error.result.draftSettlementReceipt.executionLifecycle.binding.executionGeneration);
    assert.equal(previewJson.errorReceiptId, value.error.result.draftSettlementReceipt.id);
    assert.deepEqual(snapshot(manager, value), before, "preview must be read-only");
    const recovered = manager.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
    assert.equal(recovered.replayed, false);
    assertRecoveryOnly(before, snapshot(manager, value), previewJson);
    manager = reload(value);
    const checkpoint = snapshot(manager, value);
    const replay = manager.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.id, recovered.receipt.id);
    assert.deepEqual(snapshot(manager, value), checkpoint, "double recovery must not append");
    let providerCalls = 0;
    const agent = { async call() { providerCalls += 1; throw new Error("saved repair must not rerun the provider"); } };
    const settle = manager.settleSpecStepResult.bind(manager);
    let normalInput;
    manager.settleSpecStepResult = (settlement) => {
      if (settlement.specGateRepairSelection) normalInput = settlement;
      return settle(settlement);
    };
    const result = await dispatch(value, manager, agent);
    manager.settleSpecStepResult = settle;
    assert.equal(providerCalls, 0, JSON.stringify(result));
    assert.equal(result.data?.nextAction?.step, "spec-review", JSON.stringify(result));
    assert.ok(normalInput?.specGateRepairSelection);
    assert.equal(normalInput.stepResult.kind, previewJson.resultKind);
    assert.equal(normalInput.specGateRepairSelection.candidate.resultRevision.digest, previewJson.candidateDigest);
    manager = reload(value);
    const completed = snapshot(manager, value);
    assert.equal(JSON.parse(completed.spec).requirements[0].desc, value.replacement);
    readSpecJsonValidator().validate(JSON.parse(completed.spec));
    assert.deepEqual(completed.budget, before.budget);
    assert.equal(count(completed, "spec.snapshot"), count(before, "spec.snapshot") + 1);
    assert.equal(count(completed, "spec.gate.repair.audit"), 1);
    assert.equal(completed.activities.filter((entry) => entry.result?.stepResult?.kind
      === "spec-gate-repair-review-required").length, 1);
    assert.deepEqual(completed.activities.find((entry) => entry.id === value.error.id), value.error);
    assert.equal(completed.journal.slice(0, before.journal.length), before.journal);
    const normalReplay = manager.settleSpecStepResult(normalInput);
    assert.equal(normalReplay.receipt.resultKind, previewJson.resultKind);
    assert.deepEqual(snapshot(manager, value), completed);
    const alternateResult = new SpecGateRepairReadyForGateResult();
    const alternateSelection = new SpecGateRepairSelection({ ...normalInput.specGateRepairSelection,
      result: alternateResult });
    const changedPublication = new CanonicalWorkerSpecPublication({ ...normalInput.specGateRepairSelection.candidate.spec,
      goal: "A different publication cannot replay the saved receipt." });
    for (const [difference, changed] of [
      ["binding", { binding: { ...normalInput.binding, runId: "another-run" } }],
      ["Result and Definition-selected target", { stepResult: alternateResult, specGateRepairSelection: alternateSelection,
        settlement: settleSpecStepResult("spec-gate-repair", alternateResult) }],
      ["Settlement", { settlement: settleSpecStepResult("spec-gate-repair", new SpecGateRepairContextRequiredResult()) }],
      ["publication", { specRecord: changedPublication }],
    ]) {
      assert.throws(() => manager.settleSpecStepResult({ ...normalInput, ...changed }),
        { name: "CurrentFlowStateConflictError" }, difference);
      assert.deepEqual(snapshot(reload(value), value), completed, difference);
    }

    let reviewCalls = 0;
    const originalSpawn = childProcess.spawnSync;
    const reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) {
        return originalSpawn(command, args, options);
      }
      reviewCalls += 1;
      const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
      const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
      const artifact = manager.readArtifact({ specId: value.specId, logicalKey: "spec.snapshot",
        consumerNodeId: "spec-review", parameters: { revision: review.identity.revision.toString() } });
      assert.equal(createHash("sha256").update(artifact.bytes).digest("hex"), review.identity.digest);
      assert.deepEqual(JSON.parse(artifact.bytes.toString("utf8")), normalInput.specGateRepairSelection.candidate.spec);
      assert.equal(JSON.parse(artifact.bytes.toString("utf8")).requirements[0].desc, value.replacement);
      const delta = new SpecReviewDelta({ version: 2, stage: "spec-review", identity: review.identity.toJSON(),
        baseReviewDigest: review.digest, findings: [], operations: [] });
      fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"), workerArtifactJson(delta.toJSON()));
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
    syncBuiltinESMExports();
    try {
      const reviewed = await dispatch(value, manager, agent, 2);
      assert.equal(reviewCalls, 1, JSON.stringify(reviewed));
      assert.equal(providerCalls, 0);
      assert.equal(reviewed.data?.nextAction?.step, "spec-triage", JSON.stringify(reviewed));
      const restored = reload(value);
      assert.equal(restored.canonicalState(value.specId).nextAction().nodeId, "spec-triage");
      assert.equal(JSON.parse(snapshot(restored, value).spec).requirements[0].desc, value.replacement);
    } finally { reviewProcess.mock.restore(); syncBuiltinESMExports(); }
  });

  for (const mode of ["unchanged", "invalid"]) {
    it(`refuses a genuinely published ${mode} candidate without changing the Error or budget`, async (t) => {
      const value = await legacy.create({ mode });
      t.after(() => removeTmpDir(value.root));
      const manager = reload(value);
      const before = snapshot(manager, value);
      const input = recoveryInput(value, manager);
      assert.throws(() => manager.previewSpecGateRepairRecovery(input),
        { code: "FLOW_SPEC_GATE_REPAIR_RECOVERY_INELIGIBLE" });
      assert.throws(() => manager.recoverSpecGateRepair({ ...input, previewDigest: "a".repeat(64) }),
        { code: "FLOW_SPEC_GATE_REPAIR_RECOVERY_INELIGIBLE" });
      assert.deepEqual(snapshot(reload(value), value), before);
    });
  }

  it("rejects a changed preview digest and wrong target without side effects", async (t) => {
    const value = await legacy.create();
    t.after(() => removeTmpDir(value.root));
    const manager = reload(value);
    const before = snapshot(manager, value);
    const input = recoveryInput(value, manager);
    const preview = manager.previewSpecGateRepairRecovery(input);
    assert.throws(() => manager.recoverSpecGateRepair({ ...input, previewDigest: "a".repeat(64) }),
      { name: "CurrentFlowStateConflictError" });
    assert.deepEqual(snapshot(manager, value), before);
    assert.throws(() => manager.recoverSpecGateRepair({ ...input, targetDigest: "f".repeat(64), previewDigest: preview.digest }));
    assert.deepEqual(snapshot(reload(value), value), before);
    const foreign = await legacy.create();
    t.after(() => removeTmpDir(foreign.root));
    for (const [guards, code] of [
      [["--expect-run-id", "another-run"], "FLOW_TARGET_NOT_FOUND"],
      [["--expect-spec", "another-spec"], "FLOW_TARGET_NOT_FOUND"],
      [["--expect-issue", "999"], "FLOW_TARGET_NOT_FOUND"],
      [["--expect-binding", foreign.binding], "FLOW_TARGET_NOT_FOUND"],
    ]) {
      const { envelope: result, exitCode } = await registeredRecovery(value, manager, [...guards, "--preview"]);
      assert.equal(exitCode, 1);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.errors[0].code, code, JSON.stringify(result));
      assert.deepEqual(snapshot(reload(value), value), before);
    }
  });

  it("routes registered recovery preview and explicit apply through CLI parsing without starting a worker", async (t) => {
    const value = await legacy.create();
    t.after(() => removeTmpDir(value.root));
    const manager = reload(value);
    const before = snapshot(manager, value);
    const guards = ["--expect-binding", context(value, manager).expectBinding];
    const preview = recoveryCli(value, [...guards, "--preview"]);
    assert.equal(preview.exitCode, 0, JSON.stringify(preview.envelope));
    assert.equal(preview.envelope.ok, true);
    assert.equal(preview.envelope.data.preview, true);
    assert.equal(preview.envelope.data.workerStarted, false);
    assert.equal(preview.envelope.data.resultKind, "spec-gate-repair-review-required");
    assert.deepEqual(snapshot(reload(value), value), before);
    const applied = recoveryCli(value, [...guards, "--preview-digest", preview.envelope.data.digest]);
    assert.equal(applied.exitCode, 0, JSON.stringify(applied.envelope));
    assert.equal(applied.envelope.ok, true);
    assert.equal(applied.envelope.data.recovered, true);
    assert.equal(applied.envelope.data.replayed, false);
    assert.equal(applied.envelope.data.workerStarted, false);
    assertRecoveryOnly(before, snapshot(reload(value), value), preview.envelope.data);
  });

  it("refuses changed canonical rules between preview and apply without superseding the Error", async (t) => {
    const value = await legacy.create();
    t.after(() => removeTmpDir(value.root));
    const manager = reload(value);
    const before = snapshot(manager, value);
    const input = recoveryInput(value, manager);
    const preview = manager.previewSpecGateRepairRecovery(input);
    changeRules(value);
    assert.throws(() => reload(value).recoverSpecGateRepair({ ...input, previewDigest: preview.digest }),
      { code: "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED" });
    assert.deepEqual(snapshot(reload(value), value), before);
  });

  it("refuses canonical rule drift after Step selection before normal publication", async (t) => {
    const value = await legacy.create();
    t.after(() => removeTmpDir(value.root));
    const manager = reload(value);
    const input = recoveryInput(value, manager);
    const preview = manager.previewSpecGateRepairRecovery(input);
    manager.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
    const before = snapshot(manager, value);
    let selected = false;
    const coordinator = new WorkerArtifactHandoffCoordinator({ faultInjector(event) {
      if (event.phase === "before-worker-handoff-publication" && event.stepId === "spec-gate-repair") {
        selected = true;
        changeRules(value);
      }
    } });
    const service = await prepareSpecGateRepairService({ ctx: context(value, manager), handoffCoordinator: coordinator });
    await assert.rejects(() => new SpecGateRepairStep(service).execute(),
      { code: "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED" });
    assert.equal(selected, true);
    assert.deepEqual(snapshot(reload(value), value), before);
  });

  for (const phase of ["activity-ready-to-append", "activity-appended", "state-written"]) {
    it(`rolls back recovery interrupted inside its transaction at ${phase}`, async (t) => {
      const value = await legacy.create();
      t.after(() => removeTmpDir(value.root));
      let interrupted = false;
      const fault = new Error(`recovery interrupted at ${phase}`);
      const manager = reload(value, { versionStoreFaultInjector(event) {
        if (event.phase === phase && event.activity.transition.operation === "recover_spec_gate_repair") {
          interrupted = true;
          throw fault;
        }
      } });
      const before = snapshot(manager, value);
      const input = recoveryInput(value, manager);
      const preview = manager.previewSpecGateRepairRecovery(input);
      assert.throws(() => manager.recoverSpecGateRepair({ ...input, previewDigest: preview.digest }), fault);
      assert.equal(interrupted, true);
      const restored = reload(value);
      const resumed = snapshot(restored, value);
      assert.deepEqual(resumed, before);
      const recovered = restored.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
      assert.equal(recovered.replayed, false);
      const after = snapshot(restored, value);
      assertRecoveryOnly(before, after, preview.toJSON());
      restored.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
      assert.deepEqual(snapshot(reload(value), value), after);
    });
  }

  it("reloads a committed recovery after lost acknowledgement and replays its single receipt", async (t) => {
    const value = await legacy.create();
    t.after(() => removeTmpDir(value.root));
    const manager = reload(value);
    const before = snapshot(manager, value);
    const input = recoveryInput(value, manager);
    const preview = manager.previewSpecGateRepairRecovery(input);
    const lostAcknowledgement = new Error("caller lost the committed recovery acknowledgement");
    assert.throws(() => {
      manager.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
      throw lostAcknowledgement;
    }, lostAcknowledgement);
    const restored = reload(value);
    const committed = snapshot(restored, value);
    assertRecoveryOnly(before, committed, preview.toJSON());
    const replay = restored.recoverSpecGateRepair({ ...input, previewDigest: preview.digest });
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.id, committed.activities.at(-1).result.draftSettlementReceipt.id);
    assert.deepEqual(snapshot(reload(value), value), committed);
  });
});
