import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { prepareSpecGateRepairService } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

function twoFindingScenario() {
  const specRecord = validWorkerHandoffSpec();
  specRecord.requirements = [
    { ...specRecord.requirements[0], id: "R1", task_ids: ["T1"] },
    { ...specRecord.requirements[0], id: "R2", task_ids: ["T2"] },
  ];
  const target = { entity: "requirement", id: "R2", field: "desc" };
  const additionalObservations = [{
    failureMode: "guardrail-violation",
    requirementRef: "R2",
    where: { file: "spec.json", locator: "requirements[R2].desc" },
    observed: "The second selected requirement needs a bounded correction.",
    targets: [target],
    allowedTargets: [{ target, operationKinds: ["edit-text-field"] }],
  }];
  return createSpecGateRepairScenario({ specRecord, additionalObservations });
}

function progress(manager, specId, attemptId, generation, phase) {
  return JSON.parse(manager.readArtifact({
    specId,
    logicalKey: "spec.gate.repair.progress",
    consumerNodeId: "spec-gate-repair",
    parameters: { attemptId, generation: String(generation), phase },
  }).bytes.toString("utf8"));
}

function budget(manager, specId, attemptId, baseRevision) {
  return latestRepairBudget({ flowManager: manager, specId, attemptId,
    baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
}

function artifactCount(manager, specId, logicalKey) {
  return manager.artifactCatalog(specId).toJSON().artifacts
    .filter((entry) => entry.logicalKey === logicalKey).length;
}

function specBytes(manager, specId) {
  return manager.readArtifact({ specId, logicalKey: "spec.record",
    consumerNodeId: "spec-gate-repair" }).bytes;
}

function requestFor(value, invocationId) {
  return value.coordinator.createRequest({ ctx: value.ctx,
    state: value.flowManager.load(value.specId),
    invocation: { ...value.invocation, id: invocationId },
  });
}

function handoffProposal(request, { legacy = false } = {}) {
  const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
  if (legacy) return {
    version: 1,
    stage: "spec-gate-repair-evidence",
    baseRevision: context.baseRevision,
    unitId: SpecGateRepairBundle.fromJSON(context.bundle).selections()[0].unit.id,
    evidence: "The supplied canonical context has been reviewed.",
  };

  const selections = SpecGateRepairBundle.fromJSON(context.bundle).selections();
  assert.equal(selections.length, 2);
  const first = selections.find((selection) => selection.ranges.some((range) => (
    range.writable && range.target.id === "R1"
  )));
  const second = selections.find((selection) => selection.ranges.some((range) => (
    range.writable && range.target.id === "R2"
  )));
  assert.ok(first);
  assert.ok(second);
  const firstRange = first.ranges.find((range) => range.writable);
  const secondRange = second.ranges.find((range) => range.writable);
  return {
    version: 1,
    stage: "spec-gate-repair",
    baseRevision: context.baseRevision,
    groups: selections.map((selection) => {
      const writable = selection.ranges.find((range) => range.writable);
      if (writable.target.id === "R1") return {
        findingIdentities: selection.unit.findings.map((finding) => finding.identity),
        operations: [{
          kind: "edit-text-field",
          target: writable.target,
          expectedDigest: writable.digest,
          edits: [{ startByte: 0, endByte: Buffer.byteLength(writable.value),
            replacement: "Publish an authorized correction for R1." }],
          reason: "Correct the first requirement under its own finding authority.",
        }],
      };
      assert.equal(writable.target.id, "R2");
      return {
        findingIdentities: selection.unit.findings.map((finding) => finding.identity),
        operations: [{
          kind: "edit-text-field",
          target: firstRange.target,
          expectedDigest: firstRange.digest,
          edits: [{ startByte: 0, endByte: Buffer.byteLength(firstRange.value),
            replacement: "Unauthorized edit from the second finding." }],
          reason: "Attempt to use the second finding to edit the first requirement.",
        }],
      };
    }),
  };
}

function submit(request, ctx, proposal) {
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
  reserveFixtureSpecGateRepairWorkerCall({ ctx, request,
    prompt: JSON.stringify(request.toPromptReference()) });
  sealWorkerArtifactHandoff({ requestPath: request.requestPath,
    invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z"),
  });
}

test("a sealed unauthorized response is charged once but cannot adopt or publish a Spec", async () => {
  const value = await twoFindingScenario();
  try {
    const initialSpec = specBytes(value.flowManager, value.specId);
    const initialDigest = createHash("sha256").update(initialSpec).digest("hex");
    const initialSnapshots = artifactCount(value.flowManager, value.specId, "spec.snapshot");
    const initialAudits = artifactCount(value.flowManager, value.specId, "spec.gate.repair.audit");
    const request = requestFor(value, "unauthorized-response-boundary");
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    assert.equal(budget(value.flowManager, value.specId, attemptId, context.baseRevision).providerCallCount, 0);

    submit(request, value.ctx, handoffProposal(request));
    const claimed = progress(value.flowManager, value.specId, attemptId, 0, "claimed");
    assert.equal(claimed.budget.providerCallCount, 1);
    assert.equal(claimed.budget.aggregateCharacters, claimed.callCost.characters);
    assert.equal(claimed.responseCost, undefined);
    assert.deepEqual(specBytes(value.flowManager, value.specId), initialSpec);
    assert.equal(artifactCount(value.flowManager, value.specId, "spec.snapshot"), initialSnapshots);
    assert.equal(artifactCount(value.flowManager, value.specId, "spec.gate.repair.audit"), initialAudits);

    await prepareSpecGateRepairService({ ctx: value.ctx, request, Connector: SpecEntryConnector,
      handoffCoordinator: value.coordinator });
    const published = progress(value.flowManager, value.specId, attemptId, 0, "publication");
    const publicationBudget = budget(value.flowManager, value.specId, attemptId, context.baseRevision);
    assert.equal(published.responseCost.characters > 0, true);
    assert.equal(publicationBudget.providerCallCount, 1);
    assert.equal(publicationBudget.aggregateCharacters,
      claimed.budget.aggregateCharacters + published.responseCost.characters);
    assert.equal(publicationBudget.aggregateItemCount,
      claimed.budget.aggregateItemCount + published.responseCost.items);
    assert.deepEqual(specBytes(value.flowManager, value.specId), initialSpec);
    assert.equal(artifactCount(value.flowManager, value.specId, "spec.snapshot"), initialSnapshots);
    assert.equal(artifactCount(value.flowManager, value.specId, "spec.gate.repair.audit"), initialAudits);

    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    value.ctx = { ...value.ctx, flowManager: reloaded };
    const state = reloaded.canonicalState(value.specId);
    const lifecycle = reloaded.draftStepExecutionState({ binding: {
      runId: state.runId, specId: state.specId, stepId: "spec-gate-repair", attempt: state.attempt,
    } }).lifecycle;
    const coordinator = new WorkerArtifactHandoffCoordinator();
    const restoredRequest = coordinator.restoreClaimedDraftRequest({ ctx: value.ctx,
      state: reloaded.load(value.specId), lifecycle });
    const registration = specStepRegistration("spec-gate-repair");
    const prepared = await registration.create({ ctx: value.ctx, request: restoredRequest,
      handoffCoordinator: coordinator });
    assert.deepEqual(progress(reloaded, value.specId, attemptId, 0, "publication"), published);
    assert.deepEqual(budget(reloaded, value.specId, attemptId, context.baseRevision), publicationBudget);
    assert.deepEqual(specBytes(reloaded, value.specId), initialSpec);
    assert.equal(artifactCount(reloaded, value.specId, "spec.snapshot"), initialSnapshots);
    assert.equal(artifactCount(reloaded, value.specId, "spec.gate.repair.audit"), initialAudits);

    const result = await prepared.step.execute();
    assert.equal(result.kind, "spec-gate-repair-error");
    assert.match(result.error.message, /blocking observation without an accepted change/);
    const finalState = reloaded.canonicalState(value.specId);
    assert.equal(finalState.attempt.failure.code, "STEP_RESULT_ERROR");
    assert.notEqual(finalState.nextAction()?.nodeId, "spec-review");
    assert.notEqual(finalState.nextAction()?.nodeId, "approval");
    assert.deepEqual(specBytes(reloaded, value.specId), initialSpec);
    assert.equal(createHash("sha256").update(specBytes(reloaded, value.specId)).digest("hex"), initialDigest);
    assert.equal(artifactCount(reloaded, value.specId, "spec.snapshot"), initialSnapshots);
    assert.equal(artifactCount(reloaded, value.specId, "spec.gate.repair.audit"), initialAudits);
    assert.deepEqual(budget(reloaded, value.specId, attemptId, context.baseRevision), publicationBudget);
    assert.equal(reloaded.artifactCatalog(value.specId).toJSON().artifacts.filter((entry) => (
      entry.logicalKey === "spec.gate.repair.progress"
      && entry.relativePath.endsWith("-publication.json")
    )).length, 1);
  } finally {
    removeTmpDir(value.root);
  }
});

test("a legacy evidence-stage response is refused for a current v2 repair request", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const initialSpec = specBytes(value.flowManager, value.specId);
    const initialSnapshots = artifactCount(value.flowManager, value.specId, "spec.snapshot");
    const initialAudits = artifactCount(value.flowManager, value.specId, "spec.gate.repair.audit");
    const request = requestFor(value, "legacy-evidence-stage-response");
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    assert.equal(context.mode, "repair");
    const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
    submit(request, value.ctx, handoffProposal(request, { legacy: true }));

    const beforePrepare = progress(value.flowManager, value.specId, attemptId, 0, "claimed");
    const claimedBudget = budget(value.flowManager, value.specId, attemptId, context.baseRevision);
    assert.equal(claimedBudget.providerCallCount, 1);
    assert.equal(beforePrepare.responseCost, undefined);
    assert.equal(beforePrepare.phase, "claimed");
    await assert.rejects(() => prepareSpecGateRepairService({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator }),
    /typed repair disposition/);

    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    assert.deepEqual(progress(reloaded, value.specId, attemptId, 0, "claimed"), beforePrepare);
    assert.deepEqual(budget(reloaded, value.specId, attemptId, context.baseRevision), claimedBudget);
    assert.equal(reloaded.artifactCatalog(value.specId).toJSON().artifacts.filter((entry) => (
      entry.logicalKey === "spec.gate.repair.progress"
      && entry.relativePath.endsWith("-publication.json")
    )).length, 0);
    assert.deepEqual(specBytes(reloaded, value.specId), initialSpec);
    assert.equal(artifactCount(reloaded, value.specId, "spec.snapshot"), initialSnapshots);
    assert.equal(artifactCount(reloaded, value.specId, "spec.gate.repair.audit"), initialAudits);
    const state = reloaded.canonicalState(value.specId);
    assert.equal(state.attempt.failure, null);
    assert.notEqual(state.nextAction()?.nodeId, "spec-review");
    assert.notEqual(state.nextAction()?.nodeId, "approval");
  } finally {
    removeTmpDir(value.root);
  }
});
