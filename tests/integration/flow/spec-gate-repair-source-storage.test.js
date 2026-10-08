import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactCatalogSnapshotLimits } from "../../../src/lib/flow-version.js";
import { CanonicalFlowVersionReader } from "../../../src/flow/query.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { SpecGateRepairProgressReader } from "../../../src/flow/lib/spec-gate-repair-progress-reader.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario, enterSpecGateRepairScenario, completeSpecGateRepairHandoff, prepareSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";

const blobKey = "spec.gate.repair.source.blob";
const manifestKey = "spec.gate.repair.source.manifest";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owner = "export const limit = 137;\n" + "// 漢🧭 owned contract.\n".repeat(100);
const entry = "import { limit } from './owner.js';\nexport const mode = 'first';\n";

function sourceRepository({ root }) {
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/entry.js"), entry);
  fs.writeFileSync(path.join(root, "src/owner.js"), owner);
  fs.writeFileSync(path.join(root, "AGENTS.md"), owner);
  assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
  assert.equal(runGit(["add", "src", "AGENTS.md"], { cwd: root }).ok, true);
}
function newRequest(value, id) {
  const request = new WorkerArtifactHandoffCoordinator().createRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.load(value.specId), invocation: { ...value.invocation, id } });
  return request;
}
function progress(value, attemptId, phase = "checkpoint") {
  return new SpecGateRepairProgressReader({ flowManager: value.ctx.flowManager,
    specId: value.specId, attemptId, consumerNodeId: "spec-gate-repair" }).read(0, phase);
}
function durable(value) {
  const manager = value.ctx.flowManager;
  const directory = manager.specLocation(value.specId).directory;
  const files = [];
  const visit = (relative = "") => {
    for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, item.name);
      if (child === ".runtime") continue;
      if (item.isDirectory()) visit(child);
      else files.push([child, digest(fs.readFileSync(path.join(directory, child)))]);
    }
  };
  visit();
  return { state: manager.canonicalState(value.specId).toJSON(), activities: manager.activityLedger(value.specId),
    catalog: manager.artifactCatalog(value.specId).toJSON(), files };
}

test("recurring repair Attempts share unchanged source bytes while changed evidence receives a new manifest", async (t) => {
  const value = await createSpecGateRepairScenario({ request: "Preserve src/entry.js.", beforeGate: sourceRepository });
  t.after(() => removeTmpDir(value.root));
  const firstAttempt = value.ctx.flowManager.canonicalState(value.specId).attempt.id;
  await completeSpecGateRepairHandoff({ ...value, replacement: "Publish a bounded validated artifact." });
  const first = progress(value, firstAttempt, "publication");
  assert.equal(first.document.version, 4);
  assert.equal(Object.hasOwn(first.document, "sourceSnapshots"), false);
  assert.equal(first.sourceSnapshots.sources().find((source) => source.origin === "AGENTS.md").content, owner);
  const catalog = value.ctx.flowManager.artifactCatalog(value.specId).toJSON();
  const originalBlobs = catalog.artifacts.filter((artifact) => artifact.logicalKey === blobKey);
  const originalOwner = originalBlobs.find((artifact) => artifact.hash === digest(owner));
  assert(originalOwner);
  const changedEntry = owner.replace("137", "138");
  fs.writeFileSync(path.join(value.root, "AGENTS.md"), changedEntry);
  await enterSpecGateRepairScenario({ flowManager: value.ctx.flowManager, flow: value.flow, specId: value.specId });
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const secondAttempt = value.ctx.flowManager.canonicalState(value.specId).attempt.id;
  assert.notEqual(secondAttempt, firstAttempt);
  const request = newRequest(value, "second-source-snapshot");
  reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
  const second = progress(value, secondAttempt);
  assert.notEqual(second.document.sourceSnapshotReference.digest, first.document.sourceSnapshotReference.digest);
  assert.equal(second.sourceSnapshots.sources().find((source) => source.origin === "AGENTS.md").content, changedEntry);
  assert.equal(second.sourceSnapshots.sources().some((source) => source.origin === "src/owner.js"), false);
  const after = value.ctx.flowManager.artifactCatalog(value.specId).toJSON();
  assert.deepEqual(after.artifacts.find((artifact) => artifact.relativePath === originalOwner.relativePath), originalOwner,
    "reuse preserves the original blob's publication identity");
  assert.equal(after.artifacts.filter((artifact) => artifact.logicalKey === blobKey).length, originalBlobs.length + 1);
  assert.equal(after.artifacts.filter((artifact) => artifact.logicalKey === manifestKey).length, 2);
  await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
});

test("source publication refuses an unreadable prospective catalog and rolls back every canonical write before claiming a provider", async (t) => {
  const value = await createSpecGateRepairScenario({ request: "Preserve src/entry.js.", beforeGate: sourceRepository });
  t.after(() => removeTmpDir(value.root));
  const request = newRequest(value, "catalog-budget-refusal");
  const before = durable(value);
  const totalBytes = before.catalog.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  const publicationLimits = new FlowArtifactCatalogSnapshotLimits({ maxTotalArtifactBytes: totalBytes + 1024 });
  assert.throws(() => reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
    prompt: JSON.stringify(request.toPromptReference()), publicationLimits }), /aggregate.*(?:limit|exceed)/i);
  assert.deepEqual(durable(value), before);
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  assert.deepEqual(durable(value), before);
  assert.equal(value.ctx.flowManager.artifactCatalog(value.specId).artifacts.some((artifact) => artifact.logicalKey === blobKey), false);
  assert.equal(value.ctx.flowManager.artifactCatalog(value.specId).artifacts.some((artifact) => artifact.logicalKey === manifestKey), false);
  await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
});

for (const changedDelivery of [false, true]) {
  test(`checkpoint publication refusal recovery: ${changedDelivery ? "refuses changed delivery" : "reissues an unstarted request without inventing progress"}`, async (t) => {
    const value = await createSpecGateRepairScenario({ request: "Preserve src/entry.js.", beforeGate: sourceRepository });
    t.after(() => removeTmpDir(value.root));
    const request = newRequest(value, "failed-initial-checkpoint");
    const before = durable(value);
    assert.throws(() => reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()),
      publicationLimits: new FlowArtifactCatalogSnapshotLimits({ maxTotalArtifactBytes: 1 }),
    }), /aggregate.*(?:limit|exceed)/i);
    assert.deepEqual(durable(value), before);
    assert.equal(fs.existsSync(request.requestPath), true);
    value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    if (changedDelivery) {
      fs.appendFileSync(request.inputs[0].descriptor.deliveryPath(value.root), "changed");
      assert.throws(() => value.coordinator.recoverPending({ ctx: value.ctx }),
        (error) => error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED");
      assert.equal(fs.existsSync(request.requestPath), true);
      assert.deepEqual(durable(value), before);
      return;
    }
    const recovered = value.coordinator.recoverPending({ ctx: value.ctx });
    assert.equal(recovered.cleanedHandoffs, 1);
    assert.equal(fs.existsSync(request.requestPath), false);
    assert.deepEqual(durable(value), before);
    assert.equal(value.coordinator.recoverPending({ ctx: value.ctx }), null);
    const retry = newRequest(value, "regenerated-initial-checkpoint");
    reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request: retry, prompt: JSON.stringify(retry.toPromptReference()) });
    const saved = progress(value, before.state.attempt.id);
    assert.equal(saved.document.attemptId, before.state.attempt.id);
    assert.equal(saved.document.generation, 0);
    assert.equal(saved.document.version, 4);
    assert.notEqual(retry.directory, request.directory);
    await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
  });
}

for (const mode of ["context", "repair", "draft-return", "input-unavailable"]) {
  test(`${mode} completion refuses catalog overflow without changing its publication and can resume from the saved result`, async (t) => {
    const value = await createSpecGateRepairScenario();
    t.after(() => removeTmpDir(value.root));
    let execute;
    if (mode === "repair") {
      const { service } = await prepareSpecGateRepairHandoff({ ...value, replacement: "Publish a precisely validated artifact." });
      execute = () => new StepFactory().provide(SpecGateRepairService, service).create(SpecGateRepairStep).execute();
    } else {
      const request = newRequest(value, `overflow-${mode}`);
      const context = request.inputs[0].document;
      const selected = SpecGateRepairBundle.fromJSON(context.bundle).selections()[0];
      let proposal;
      if (mode === "context") {
        proposal = { version: 1, stage: "spec-gate-repair-context-request", baseRevision: context.baseRevision,
          unitId: selected.unit.id, additionalRangeIds: ["goal"] };
      } else if (mode === "draft-return") {
        proposal = { version: 1, stage: "spec-gate-repair-draft-return", baseRevision: context.baseRevision,
          unitId: selected.unit.id, decision: "Which validation target should the requirement name?",
          evidence: "The Issue and Spec identify the requirement but leave its target open.",
          unresolvedBecause: "Neither source selects one validation target." };
      } else {
        const manifest = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
        const descriptor = manifest.inputs[0].descriptor;
        proposal = { version: 1, stage: "spec-gate-repair-input-unavailable",
          binding: { runId: manifest.runId, specId: manifest.specId, stepId: manifest.stepId,
            attemptId: descriptor.canonicalLocator.attemptId, attemptSequence: descriptor.canonicalLocator.attemptSequence,
            inputDigest: manifest.inputDigest, inputRevision: manifest.inputRevision,
            requestDigest: request.toPromptReference().toJSON().requestDigest },
          ...descriptor.selectedIdentity, reason: "context-limit",
          explanation: "The selected input cannot be consumed within this invocation." };
      }
      reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
      sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
      const prepared = await specStepRegistration("spec-gate-repair").create({ ctx: value.ctx, request,
        handoffCoordinator: value.coordinator });
      execute = () => prepared.step.execute();
    }
    const before = durable(value);
    const limits = new FlowArtifactCatalogSnapshotLimits({
      maxConfirmedLedgerBytes: before.catalog.artifacts.find((artifact) => artifact.logicalKey === "flow.activities").size,
    });
    const method = mode === "context" ? "completeSpecGateRepairProgress" : "settleSpecStepResult";
    const save = value.ctx.flowManager[method].bind(value.ctx.flowManager);
    let boundaries = 0;
    value.ctx.flowManager[method] = (input) => {
      assert(input.publicationLimits instanceof FlowArtifactCatalogSnapshotLimits,
        "the repair-owned writer must request bounded publication at its final Store boundary");
      boundaries++;
      return save({ ...input, publicationLimits: limits });
    };
    try {
      await assert.rejects(execute, (error) => error instanceof StepPersistenceFailure && /artifact bytes.*limit/i.test(error.message));
    } finally { value.ctx.flowManager[method] = save; }
    assert(boundaries > 0);
    assert.deepEqual(durable(value), before, "a refused final write must not record a second tooling failure");
    value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    assert.deepEqual(durable(value), before);
    await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
    const replay = await specStepRegistration("spec-gate-repair").create({ ctx: value.ctx,
      state: value.ctx.flowManager.canonicalState(value.specId), handoffCoordinator: value.coordinator });
    const result = await replay.step.execute();
    const expected = { context: "spec-gate-repair-context-required", repair: "spec-gate-repair-review-required",
      "draft-return": "spec-gate-repair-draft-return-required", "input-unavailable": "spec-gate-repair-error" };
    assert.equal(result.kind, expected[mode]);
    await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
    if (mode === "input-unavailable") {
      const failed = durable(value);
      assert.equal(failed.state.attempt.failure.code, "FLOW_SPEC_GATE_REPAIR_INPUT_UNAVAILABLE");
      assert.equal(value.ctx.flowManager.canonicalState(value.specId).nextAction().operation, "blocked");
      assert.equal(failed.activities.at(-1).transition.operation, "fail_attempt");
      assert.throws(() => value.ctx.flowManager.settleCurrentFailure({ specId: value.specId }),
        /no settle transition/);
      assert.deepEqual(durable(value), failed, "blocked repair cannot manufacture a failure-recording continuation");
      value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
      assert.deepEqual(durable(value), failed);
      await new CanonicalFlowVersionReader({ repositoryRoot: value.root }).open(value.specId, 1);
    }
  });
}
