import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactCatalog, FlowArtifactCatalogSnapshotLimits } from "../../../src/lib/flow-version.js";
import { CanonicalFlowVersionReader } from "../../../src/flow/query.js";
import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { createSpecGateRepairScenario, prepareSpecGateRepairHandoffInput } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const replacement = "Publish a bounded validated artifact.";

class CanonicalPublicationSnapshot {
  constructor(manager, specId) {
    const location = manager.specLocation(specId);
    this.state = manager.canonicalState(specId).toJSON();
    this.catalog = manager.artifactCatalog(specId).toJSON();
    this.files = [...FlowArtifactCatalog.managedFiles(location)].sort()
      .map((file) => [file, fs.readFileSync(location.resolve(file))]);
    this.catalogBytes = fs.readFileSync(location.catalogFile);
  }

  assertUnchanged(manager, specId) {
    assert.deepEqual(new CanonicalPublicationSnapshot(manager, specId), this,
      "refused publication must preserve all canonical files, catalog, and state");
  }
}

function reload(value) {
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root,
    inWorktree: false, specId: value.specId });
  return value.ctx.flowManager;
}

function observeSettlements(t, manager, selectedLimits) {
  const save = manager.settleSpecStepResult.bind(manager);
  const savedKinds = new Set();
  t.after(() => { manager.settleSpecStepResult = save; });
  manager.settleSpecStepResult = (input) => {
    assert.equal(input.publicationLimits, selectedLimits,
      "the registered producer and final writer must preserve the selected limits instance");
    const committed = save(input);
    savedKinds.add(input.stepResult.kind);
    return committed;
  };
  return savedKinds;
}

async function assertCompleted(value, result) {
  assert.equal(result.kind, "spec-gate-repair-review-required");
  const manager = reload(value);
  assert.equal(manager.canonicalState(value.specId).nextAction().nodeId, "spec-review");
  const spec = manager.readArtifact({ specId: value.specId, logicalKey: "spec.record",
    consumerNodeId: "spec-review" });
  assert.equal(JSON.parse(spec.bytes.toString("utf8")).requirements[0].desc, replacement);
  const completed = manager.activityLedger(value.specId).findLast((activity) => (
    activity.nodeId === "spec-gate-repair" && activity.result?.stepResult?.kind === result.kind
  ));
  assert.equal(completed?.result.stepResult.kind, result.kind);
  assert.equal(completed.result.draftSettlementReceipt.settlementKind, "target-connection");
  assert.equal(completed.result.draftSettlementReceipt.targetStepId, "spec-review");
  await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
}

test("registered repair preparation and final publication use the same caller-selected limits", async (t) => {
  const value = await createSpecGateRepairScenario();
  t.after(() => removeTmpDir(value.root));
  const handoff = prepareSpecGateRepairHandoffInput({ ...value, replacement });
  const limits = new FlowArtifactCatalogSnapshotLimits();
  const savedKinds = observeSettlements(t, value.ctx.flowManager, limits);
  const prepared = await specStepRegistration("spec-gate-repair").create({
    ...handoff.input, publicationLimits: limits,
  });
  const result = await prepared.step.execute();
  assert.deepEqual(savedKinds, new Set([
    "spec-gate-repair-context-required", "spec-gate-repair-review-required",
  ]));
  await assertCompleted(value, result);
});

test("published-response reload injects the selected limits into its final canonical writer", async (t) => {
  const value = await createSpecGateRepairScenario();
  t.after(() => removeTmpDir(value.root));
  const handoff = prepareSpecGateRepairHandoffInput({ ...value, replacement });
  const limits = new FlowArtifactCatalogSnapshotLimits();
  const initialKinds = observeSettlements(t, value.ctx.flowManager, limits);
  await specStepRegistration("spec-gate-repair").create({ ...handoff.input, publicationLimits: limits });
  assert.deepEqual(initialKinds, new Set(["spec-gate-repair-context-required"]));
  const manager = reload(value);
  assert.equal(manager.readCurrentStepSettlement({ specId: value.specId,
    stepId: "spec-gate-repair" }).receipt.executionLifecycle.phase, "publication");
  const resumedKinds = observeSettlements(t, manager, limits);
  const prepared = await specStepRegistration("spec-gate-repair").create({ ctx: value.ctx,
    state: manager.canonicalState(value.specId), handoffCoordinator: value.coordinator,
    publicationLimits: limits });
  const result = await prepared.step.execute();
  assert.deepEqual(resumedKinds, new Set(["spec-gate-repair-review-required"]));
  await assertCompleted(value, result);
});

test("canonical repair refuses aggregate overflow from generated descriptors and rolls back after reload", async (t) => {
  const value = await createSpecGateRepairScenario();
  t.after(() => removeTmpDir(value.root));
  const handoff = prepareSpecGateRepairHandoffInput({ ...value, replacement });
  await specStepRegistration("spec-gate-repair").create(handoff.input);
  const manager = reload(value);
  const before = new CanonicalPublicationSnapshot(manager, value.specId);
  const ledger = before.catalog.artifacts.find((artifact) => artifact.logicalKey === "flow.activities");
  const limits = new FlowArtifactCatalogSnapshotLimits({ maxTotalArtifactBytes: ledger.size - 1 });
  const prepared = await specStepRegistration("spec-gate-repair").create({ ctx: value.ctx,
    state: manager.canonicalState(value.specId), handoffCoordinator: value.coordinator,
    publicationLimits: limits });
  const save = manager.settleSpecStepResult.bind(manager);
  let refusedPayloadBytes = null;
  t.after(() => { manager.settleSpecStepResult = save; });
  manager.settleSpecStepResult = (input) => {
    assert.equal(input.publicationLimits, limits);
    refusedPayloadBytes = input.artifactWrites.reduce((total, write) => total + write.bytes.length, 0);
    assert(refusedPayloadBytes > 0 && refusedPayloadBytes < limits.maxTotalArtifactBytes,
      "the explicit repair artifacts fit; generated state and ledger must count toward the batch");
    return save(input);
  };
  await assert.rejects(() => prepared.step.execute(), (error) => (
    error instanceof StepPersistenceFailure && /aggregate artifact bytes exceed the limit/.test(error.message)
  ));
  assert.notEqual(refusedPayloadBytes, null, "the real canonical publication boundary must be reached");
  before.assertUnchanged(manager, value.specId);
  before.assertUnchanged(reload(value), value.specId);
  await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
});
