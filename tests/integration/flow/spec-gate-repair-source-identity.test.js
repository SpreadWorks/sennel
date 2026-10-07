import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { CanonicalFlowArtifactWrite } from "../../../src/flow/lib/current-flow-state.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { SpecGateRepairProgressReader } from "../../../src/flow/lib/spec-gate-repair-progress-reader.js";
import { readProgressBoundSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { readSpecGateRepairSourceSnapshots } from "../../../src/flow/lib/spec-gate-repair-source-storage.js";
import { WorkerArtifactHandoffError } from "../../../src/flow/lib/worker-artifact-handoff-error.js";
import { createSpecGateRepairScenario, enterSpecGateRepairScenario,
  completeSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { initGitRepo } from "../../support/infrastructure/git-repo.js";

const manifestKey = "spec.gate.repair.source.manifest";
const blobKey = "spec.gate.repair.source.blob";
const rules = "Preserve the exact bounded repair contract.\n";

function reload(value) {
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root,
    inWorktree: false, specId: value.specId });
  return value.ctx.flowManager;
}

function progress(value, attemptId, phase = "checkpoint") {
  return new SpecGateRepairProgressReader({ flowManager: value.ctx.flowManager,
    specId: value.specId, attemptId, consumerNodeId: "spec-gate-repair" }).read(0, phase);
}

function reserve(value, id) {
  const request = value.coordinator.createRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.loadReadOnly(value.specId), invocation: { ...value.invocation, id } });
  reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
    prompt: JSON.stringify(request.toPromptReference()) });
  return request;
}

function durable(value) {
  const manager = value.ctx.flowManager;
  const directory = manager.specLocation(value.specId).directory;
  const files = fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort()
    .map((relative) => [relative, fs.readFileSync(path.join(directory, relative)).toString("base64")]);
  return { state: manager.canonicalState(value.specId).toJSON(),
    activities: manager.activityLedger(value.specId), catalog: manager.artifactCatalog(value.specId).toJSON(), files };
}

async function createRecurringSourceAttempt(t, { request, beforeGate, changeSource } = {}) {
  const value = await createSpecGateRepairScenario({ request, beforeGate: (input) => {
    const { root } = input;
    fs.writeFileSync(path.join(root, "AGENTS.md"), rules);
    beforeGate?.(input);
  } });
  t.after(() => removeTmpDir(value.root));
  const firstAttempt = value.ctx.flowManager.canonicalState(value.specId).attempt.id;
  await completeSpecGateRepairHandoff({ ...value, replacement: "Publish a bounded validated artifact." });
  const first = progress(value, firstAttempt, "publication");
  const originalArtifacts = value.ctx.flowManager.artifactCatalog(value.specId).toJSON().artifacts
    .filter((entry) => [manifestKey, blobKey].includes(entry.logicalKey));
  changeSource?.(value);
  await enterSpecGateRepairScenario({ flowManager: value.ctx.flowManager,
    flow: value.flow, specId: value.specId });
  const secondAttempt = reload(value).canonicalState(value.specId).attempt.id;
  assert.notEqual(secondAttempt, firstAttempt);
  return { value, firstAttempt, first, secondAttempt, originalArtifacts };
}

async function recurringSources(t, changed, { request } = {}) {
  const result = await createRecurringSourceAttempt(t, { request, changeSource: changed ? (value) => {
    fs.writeFileSync(path.join(value.root, "AGENTS.md"), `${rules}Additional captured rule.\n`);
  } : null });
  const { value, secondAttempt } = result;
  reserve(value, changed ? "changed-source-identity" : "unchanged-source-identity");
  reload(value);
  return { ...result, second: progress(value, secondAttempt) };
}

function publishMalformedCheckpoint(value, request, change, interruption) {
  const manager = value.ctx.flowManager;
  const checkpoint = manager.checkpointDraftStepExecution.bind(manager);
  let corrupted = 0;
  manager.checkpointDraftStepExecution = (input) => {
    const artifactWrites = input.artifactWrites.map((write) => {
      if ((write.logicalKey ?? write.artifact?.logicalKey) !== "spec.gate.repair.progress") return write;
      const document = JSON.parse(write.bytes.toString("utf8"));
      change(document);
      corrupted++;
      return new CanonicalFlowArtifactWrite({ logicalKey: "spec.gate.repair.progress",
        parameters: { attemptId: document.attemptId, generation: String(document.generation), phase: document.phase },
        mediaType: "application/json", bytes: `${JSON.stringify(document, null, 2)}\n` });
    });
    checkpoint({ ...input, artifactWrites });
    throw new Error(interruption);
  };
  try {
    assert.throws(() => reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) }), (error) => {
      assert(error instanceof StepPersistenceFailure);
      assert.equal(error.message, interruption);
      return true;
    });
  } finally { manager.checkpointDraftStepExecution = checkpoint; }
  assert.equal(corrupted, 1);
}

test("unchanged recurring repair sources retain their manifest and first publication Activity after reload", async (t) => {
  const request = "\uFEFFPreserve 漢🧭 exact \ud800 source identity.";
  const normalized = Buffer.from(request, "utf8").toString("utf8");
  assert(normalized.includes("\uFFFD"));
  assert(normalized.startsWith("\uFEFF"));
  const { value, first, second, originalArtifacts } = await recurringSources(t, false, { request });
  assert.deepEqual(second.document.sourceSnapshotReference, first.document.sourceSnapshotReference);
  assert.deepEqual(second.sourceSnapshots.sources(), first.sourceSnapshots.sources());
  assert.equal(second.sourceSnapshots.sources().find((source) => source.origin === "flow.request").content, normalized);
  const manager = reload(value);
  const { source } = readProgressBoundSpecGateRepairInput({ flowManager: manager,
    state: manager.canonicalState(value.specId), executionRoot: value.root });
  assert.equal(source.context.evidenceDigest, second.document.context.evidenceDigest);
  assert.equal(source.context.sourceSnapshots().sources()
    .find((entry) => entry.origin === "flow.request").content, normalized);
  const after = value.ctx.flowManager.artifactCatalog(value.specId).toJSON().artifacts
    .filter((entry) => [manifestKey, blobKey].includes(entry.logicalKey));
  assert.equal(after.length, originalArtifacts.length);
  for (const original of originalArtifacts) {
    assert.equal(typeof original.activityId, "string");
    assert.deepEqual(after.find((entry) => entry.relativePath === original.relativePath), original,
      "equal immutable content must retain the original Activity and authority descriptor");
  }
});

test("a later canonical manifest cannot supply an earlier repair progress publication", async (t) => {
  const { value, firstAttempt, first, second } = await recurringSources(t, true);
  assert.notEqual(second.document.sourceSnapshotReference.digest, first.document.sourceSnapshotReference.digest);
  const manager = value.ctx.flowManager;
  const earlier = manager.readArtifact({ specId: value.specId, consumerNodeId: "spec-gate-repair",
    logicalKey: "spec.gate.repair.progress", parameters: { attemptId: firstAttempt,
      generation: "0", phase: "publication" } });
  const before = durable(value);
  manager.readCanonicalTransitionView({ specId: value.specId, read: (view) => {
    const reference = second.document.sourceSnapshotReference;
    const manifest = manager.readArtifact({ specId: value.specId, consumerNodeId: "spec-gate-repair",
      logicalKey: manifestKey, parameters: { digest: reference.digest }, view });
    assert.equal(manifest.descriptor.hash, reference.digest);
    assert.equal(manifest.descriptor.size, reference.byteLength);
    const activities = new Map(view.activities.map((activity) => {
      const entry = activity.toJSON();
      return [entry.id, entry];
    }));
    const ledger = [...activities.values()];
    assert(ledger.findIndex((entry) => entry.id === manifest.descriptor.activityId)
      > ledger.findIndex((entry) => entry.id === earlier.descriptor.activityId));
    assert.throws(() => readSpecGateRepairSourceSnapshots({ flowManager: manager,
      specId: value.specId, consumerNodeId: "spec-gate-repair", reference,
      progressActivityId: earlier.descriptor.activityId, view, activities }), {
      name: "Error", message: "Repair source reference differs from its canonical publication identity",
    });
  } });
  assert.deepEqual(durable(value), before);
  reload(value);
  assert.deepEqual(durable(value), before);
});

test("saved selection metadata cannot name a foreign unit while retaining valid canonical context bytes", async (t) => {
  const value = await createSpecGateRepairScenario();
  t.after(() => removeTmpDir(value.root));
  const request = value.coordinator.createRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.loadReadOnly(value.specId), invocation: value.invocation });
  publishMalformedCheckpoint(value, request, (document) => {
    assert.equal(document.inputDescriptors[0].descriptor.selectedIdentity.mode, "repair");
    document.inputDescriptors[0].descriptor.selectedIdentity.unitIds[0] = "foreign-unit";
  }, "interrupted after foreign selection checkpoint publication");
  const restarted = reload(value);
  const state = restarted.canonicalState(value.specId);
  const saved = JSON.parse(restarted.readArtifact({ specId: value.specId,
    consumerNodeId: "spec-gate-repair", logicalKey: "spec.gate.repair.progress",
    parameters: { attemptId: state.attempt.id, generation: "0", phase: "checkpoint" } }).bytes);
  assert.equal(saved.inputDescriptors[0].descriptor.selectedIdentity.unitIds[0], "foreign-unit");
  assert.equal(saved.budget.providerCallCount, 0);
  const before = durable(value);
  assert.throws(() => progress(value, state.attempt.id), (error) => {
    assert(error instanceof WorkerArtifactHandoffError);
    assert.equal(error.code, "FLOW_SPEC_GATE_REPAIR_INPUT_FORMAT_UNAVAILABLE");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(durable(value), before);
  reload(value);
  assert.deepEqual(durable(value), before);
});

test("an older manifest differing only in unselected source bytes cannot replace the selected checkpoint identity", async (t) => {
  const firstEntry = "export const mode = 'first';\n";
  const secondEntry = "export const mode = 'second';\n";
  const { value, first, secondAttempt } = await createRecurringSourceAttempt(t, {
    request: "Preserve src/entry.js.",
    beforeGate: ({ root }) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/entry.js"), firstEntry);
      initGitRepo(root);
      assert.equal(runGit(["add", "src"], { cwd: root }).ok, true);
    },
    changeSource: ({ root }) => fs.writeFileSync(path.join(root, "src/entry.js"), secondEntry),
  });
  const firstSource = first.sourceSnapshots.sources().find((source) => source.origin === "src/entry.js");
  assert.equal(firstSource.content, firstEntry);
  assert.equal(firstSource.required, false);
  assert.equal(first.document.context.bundle.sources.some((source) => source.snapshotId === firstSource.id), false);
  const request = value.coordinator.createRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.loadReadOnly(value.specId),
    invocation: { ...value.invocation, id: "foreign-unselected-source-manifest" } });
  const selected = request.inputs[0].document;
  assert.equal(selected.bundle.sources.some((source) => source.snapshotId === firstSource.id), false);
  assert.notEqual(selected.sourceSnapshotReference.digest, first.document.sourceSnapshotReference.digest);
  const originalInput = request.inputs[0].toJSON();
  publishMalformedCheckpoint(value, request, (document) => {
    assert.deepEqual(document.context, selected);
    assert.deepEqual(document.inputDescriptors[0], originalInput);
    document.sourceSnapshotReference = first.document.sourceSnapshotReference;
  }, "interrupted after foreign source manifest checkpoint publication");
  const manager = reload(value);
  const saved = JSON.parse(manager.readArtifact({ specId: value.specId,
    logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
    parameters: { attemptId: secondAttempt, generation: "0", phase: "checkpoint" } }).bytes);
  assert.deepEqual(saved.sourceSnapshotReference, first.document.sourceSnapshotReference);
  assert.deepEqual(saved.context, selected);
  assert.deepEqual(saved.inputDescriptors[0], originalInput);
  assert.equal(saved.budget.providerCallCount, 0);
  const currentManifest = JSON.parse(manager.readArtifact({ specId: value.specId,
    logicalKey: manifestKey, consumerNodeId: "spec-gate-repair",
    parameters: { digest: selected.sourceSnapshotReference.digest } }).bytes);
  assert.deepEqual(currentManifest.sources.filter((source) => source.id !== firstSource.id),
    first.sourceSnapshots.sources().filter((source) => source.id !== firstSource.id)
      .map((source) => source.descriptor()));
  const currentSource = currentManifest.sources.find((source) => source.id === firstSource.id);
  assert.notEqual(currentSource.digest, firstSource.digest);
  assert.deepEqual(manager.readArtifact({ specId: value.specId, logicalKey: blobKey,
    consumerNodeId: "spec-gate-repair", parameters: { digest: currentSource.digest } }).bytes,
  Buffer.from(secondEntry, "utf8"));
  const before = durable(value);
  assert.throws(() => progress(value, secondAttempt), (error) => {
    assert(error instanceof WorkerArtifactHandoffError);
    assert.equal(error.code, "FLOW_SPEC_GATE_REPAIR_PROGRESS_MISMATCH");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(durable(value), before);
  reload(value);
  assert.deepEqual(durable(value), before);
});
