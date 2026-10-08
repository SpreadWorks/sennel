import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowArtifactWrite } from "../../../src/flow/lib/current-flow-state.js";
import { DraftWorkerExecutionClaim, settleSpecStepResult } from "../../../src/flow/definition.js";
import { SpecGateRepairContextRequiredResult } from "../../../src/flow/engine/step-result.js";
import { SpecWorkerStepBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { reserveSpecGateRepairWorkerCall } from "../../../src/flow/engine/composition/spec-gate-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { SpecGateRepairCallPlan, specGateRepairCallFootprint } from "../../../src/flow/lib/spec-gate-repair-call-plan.js";
import { PromptLogicalFootprint } from "../../../src/lib/prompt-batching.js";
import { readSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-input.js";
import { readSpecGateRepairSources } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { SpecGateRepairSource, SpecGateRepairSourceSnapshots } from "../../../src/flow/lib/spec-gate-repair-values.js";
import { SpecGateRepairSourcePublication } from "../../../src/flow/lib/spec-gate-repair-source-storage.js";
import { SpecGateRepairProgressReader, SPEC_GATE_REPAIR_PROGRESS_VERSION } from "../../../src/flow/lib/spec-gate-repair-progress-reader.js";
import { readProgressBoundSpecGateRepairInput, latestRepairBudget } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { WorkerArtifactHandoffRequest, WorkerArtifactHandoffReference, WorkerArtifactHandoffCoordinator,
  sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { createSpecGateRepairScenario, prepareSpecGateRepairService } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const savedCode = "\ufeffexport const originalContract = '漢🧭';\r\n";
const scopedRule = "Preserve this scoped implementation contract.\n";

class SnapshotFixtureWork {
  constructor(request) { this.request = request; }
  static forAdmission(invocation, request) { return new this(request); }
  workerInvocation() { return null; }
  instructionPrompt() { return this.prompt(); }
  prompt() { return JSON.stringify(new WorkerArtifactHandoffReference(this.request)); }
}

/** Assemble an archived richer input through the normal typed producers and
 * Store checkpoint API. Every descriptor, execution binding, plan and budget
 * is generated from this same request; no consumer or receipt is mocked. */
async function archivedCheckpoint(t) {
  const value = await createSpecGateRepairScenario({ request: "Preserve src/entry.js and the canonical request.",
    beforeGate: ({ root }) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep the root project contract.\n");
      fs.writeFileSync(path.join(root, "src/AGENTS.md"), scopedRule);
      fs.writeFileSync(path.join(root, "src/entry.js"), savedCode);
    } });
  t.after(() => removeTmpDir(value.root));
  const manager = value.ctx.flowManager;
  const state = manager.canonicalState(value.specId);
  const ruleOrigins = new SpecGateRepairSourceSnapshots([new SpecGateRepairSource({
    id: "project-rules:src/AGENTS.md", origin: "src/AGENTS.md", content: scopedRule,
    revision: hash(scopedRule), required: false, appliesTo: ["src"] })]);
  const sources = readSpecGateRepairSources({ flowManager: manager, state, executionRoot: value.root, ruleSnapshots: ruleOrigins });
  const snapshots = new SpecGateRepairSourceSnapshots([...sources, new SpecGateRepairSource({
    id: "source:src/entry.js", origin: "src/entry.js", content: savedCode, revision: hash(savedCode), required: false })]);
  const input = readSpecGateRepairInput({ flowManager: manager, state, executionRoot: value.root, sourceSnapshots: snapshots });
  const context = input.context.referenceDocument(input.context.referencePlan().batches[0]);
  const capture = WorkerArtifactHandoffRequest.capture({ mainRoot: value.root, executionRoot: value.root,
    state, invocation: value.invocation, flowManager: manager, generatedAt: "2026-08-04T00:00:00.000Z",
    specGateRepairDocument: context });
  const request = capture.assemble().prepare();
  const { limit, budget } = latestRepairBudget({ flowManager: manager, specId: value.specId,
    attemptId: state.attempt.id, baseRevision: input.baseRevision, consumerNodeId: "spec-gate-repair" });
  const callPlan = new SpecGateRepairCallPlan({ requests: [request], invocation: value.invocation,
    dispatchWorkClass: SnapshotFixtureWork, limit, budget });
  const prompt = new SnapshotFixtureWork(request).prompt();
  const call = callPlan.assertCurrent({ request, budget, instructionPrompt: { userPrompt: prompt },
    physicalRequest: { userPrompt: prompt } });
  const binding = new SpecWorkerStepBinding({ request });
  const executionBinding = manager.draftStepExecutionState({ binding }).workerBinding({
    inputDigest: request.inputDigest, inputRevision: request.inputRevision });
  const stepResult = new SpecGateRepairContextRequiredResult();
  const publication = new SpecGateRepairSourcePublication({ snapshots });
  budget.consumeAggregate(call.callCost);
  const document = { version: SPEC_GATE_REPAIR_PROGRESS_VERSION, runId: request.runId, specId: value.specId,
    attemptId: state.attempt.id, attemptSequence: state.attempt.sequence, phase: "checkpoint", generation: executionBinding.executionGeneration,
    inputDigest: request.inputDigest, inputRevision: request.inputRevision, requestDigest: request.requestDigest,
    executionLocator: new DraftWorkerExecutionClaim({ dispatchInvocationId: request.dispatchInvocationId,
      generatedAt: request.generatedAt, actionDigest: request.actionDigest, requestDigest: request.requestDigest }).toJSON(),
    actionFileDigest: request.actionRequestDigest, actionRepositoryFingerprint: request.invocation.action.repositoryFingerprint ?? null,
    limit: { ...limit }, budget: budget.snapshot(), context, sourceSnapshotReference: publication.reference().toJSON(),
    inputDescriptors: request.inputs.map((entry) => entry.toJSON()), plan: callPlan.toJSON(),
    callCost: call.callCost.toJSON(), responseAllowance: call.responseAllowance.toJSON(),
    physicalPromptFootprint: call.physicalPromptFootprint.toJSON(), deliveryMode: call.deliveryMode };
  manager.checkpointDraftStepExecution({ binding, stepResult, settlement: settleSpecStepResult(binding.stepId, stepResult), executionBinding,
    artifactWrites: [...publication.artifactWrites(), new CanonicalFlowArtifactWrite({ logicalKey: "spec.gate.repair.progress",
      parameters: { attemptId: state.attempt.id, generation: String(document.generation), phase: "checkpoint" },
      mediaType: "application/json", bytes: `${JSON.stringify(document, null, 2)}\n` })] });
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const restored = reader(value).read(0, "checkpoint");
  assert.deepEqual(restored.document, document, "the archived checkpoint has a fully matching canonical receipt and descriptor");
  assert.deepEqual(restored.sourceSnapshots.sources(), snapshots.sources());
  return { ...value, snapshots, document, request, baseRevision: input.baseRevision, attemptId: state.attempt.id };
}

function reader(value) {
  const state = value.ctx.flowManager.canonicalState(value.specId);
  return new SpecGateRepairProgressReader({ flowManager: value.ctx.flowManager, specId: value.specId,
    attemptId: state.attempt.id, consumerNodeId: "spec-gate-repair" });
}
function read(value) {
  return readProgressBoundSpecGateRepairInput({ flowManager: value.ctx.flowManager,
    state: value.ctx.flowManager.canonicalState(value.specId), executionRoot: value.root });
}
function durable(value) {
  const manager = value.ctx.flowManager;
  return { state: manager.canonicalState(value.specId).toJSON(), catalog: manager.artifactCatalog(value.specId).toJSON(),
    activities: manager.activityLedger(value.specId), budget: latestRepairBudget({ flowManager: manager, specId: value.specId,
      attemptId: value.attemptId, baseRevision: value.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot() };
}

test("unchanged richer checkpoint restores exact snapshots and claims the next provider generation without recapturing research", async (t) => {
  const value = await archivedCheckpoint(t);
  fs.writeFileSync(path.join(value.root, "src/entry.js"), "export const liveResearch = 'changed';\n");
  fs.writeFileSync(path.join(value.root, "src/new.js"), "export const unobserved = true;\n");
  fs.mkdirSync(path.join(value.root, "src/new"));
  fs.writeFileSync(path.join(value.root, "src/new/AGENTS.md"), "Newly discovered rules must remain outside the saved identity.\n");
  const before = durable(value);
  const restored = read(value);
  assert.equal(restored.source.context.evidenceDigest, value.document.context.evidenceDigest);
  assert.deepEqual(restored.source.context.sourceSnapshots().sources(), value.snapshots.sources());
  assert.equal(restored.source.context.sourceSnapshots().sources().find((source) => source.origin === "src/entry.js").content, savedCode);
  assert.equal(restored.source.context.sourceSnapshots().sources().some((source) => source.origin === "src/new.js" || source.origin === "src/new/AGENTS.md"), false);
  assert.deepEqual(durable(value), before);
  const manager = value.ctx.flowManager;
  const state = manager.canonicalState(value.specId);
  const lifecycle = manager.draftStepExecutionState({ binding: { runId: state.runId, specId: value.specId,
    stepId: "spec-gate-repair", attempt: state.attempt } }).lifecycle;
  const request = new WorkerArtifactHandoffCoordinator().restoreClaimedDraftRequest({ ctx: value.ctx,
    state: manager.loadReadOnly(value.specId), lifecycle,
    executionLocator: reader(value).read(0, "checkpoint").executionLocator,
    actionFileDigest: value.document.actionFileDigest });
  assert.equal(request.requestDigest, value.request.requestDigest);
  assert.deepEqual(request.inputs[0].document, value.document.context);
  const resumedPrompt = new SnapshotFixtureWork(request).prompt();
  assert.deepEqual(PromptLogicalFootprint.measure(resumedPrompt).toJSON(), value.document.physicalPromptFootprint);
  assert.deepEqual(specGateRepairCallFootprint(request, resumedPrompt).toJSON(), value.document.callCost);
  reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request,
    prompt: resumedPrompt });
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const claimed = reader(value).read(0, "claimed");
  assert.deepEqual(claimed.sourceSnapshots.sources(), value.snapshots.sources());
  assert.equal(claimed.budget.snapshot().providerCallCount, 1);
  assert.equal(claimed.budget.snapshot().aggregateCharacters, before.budget.aggregateCharacters);
  assert.equal(read(value).source.context.evidenceDigest, value.document.context.evidenceDigest);

  const selection = SpecGateRepairBundle.fromJSON(request.inputs[0].document.bundle).selections()[0];
  const selectedIds = new Set(selection.ranges.map((range) => range.id));
  const extra = read(value).source.context.tableOfContents().find((range) => !selectedIds.has(range.id) && !range.id.startsWith("evidence:"));
  assert(extra, "the response must request a genuinely new canonical Spec range");
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({ version: 1,
    stage: "spec-gate-repair-context-request", baseRevision: request.inputs[0].document.baseRevision,
    unitId: selection.unit.id, additionalRangeIds: [extra.id] }));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const service = await prepareSpecGateRepairService({ ctx: value.ctx, request,
    Connector: SpecEntryConnector, handoffCoordinator: coordinator });
  const result = await new StepFactory().provide(SpecGateRepairService, service).create(SpecGateRepairStep).execute();
  assert.equal(result.kind, "spec-gate-repair-context-required");
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const publication = reader(value).read(0, "publication");
  const completion = JSON.parse(value.ctx.flowManager.readArtifact({ specId: value.specId,
    logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
    parameters: { attemptId: value.attemptId, generation: "0", phase: "completed" } }).bytes);
  assert.equal(completion.resultKind, "spec-gate-repair-context-required");
  assert.equal(completion.generation, 0);
  assert(completion.publicationReceiptId);
  const next = new WorkerArtifactHandoffCoordinator().planSpecGateRepairRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.loadReadOnly(value.specId),
    invocation: { ...value.invocation, id: "next-saved-snapshot-generation" }, dispatchWorkClass: SnapshotFixtureWork });
  const nextSelection = SpecGateRepairBundle.fromJSON(next.request.inputs[0].document.bundle).selections()[0];
  assert(nextSelection.ranges.some((range) => range.id === extra.id));
  assert.deepEqual(nextSelection.ranges.filter((range) => range.writable), selection.ranges.filter((range) => range.writable));
  assert.equal(next.request.inputs[0].descriptor.canonicalLocator.generation, 1);
  const nextPrompt = new SnapshotFixtureWork(next.request).prompt();
  reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request: next.request, prompt: nextPrompt,
    instructionPrompt: nextPrompt, callPlan: next.callPlan });
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
  const nextClaimed = reader(value).read(1, "claimed");
  assert.deepEqual(nextClaimed.sourceSnapshots.sources(), value.snapshots.sources());
  assert.deepEqual(nextClaimed.document.sourceSnapshotReference, value.document.sourceSnapshotReference);
  assert.deepEqual(nextClaimed.document.plan.budgetFrontier, publication.budget.snapshot());
  assert.equal(nextClaimed.budget.snapshot().providerCallCount, 2);
  assert.equal(nextClaimed.budget.snapshot().aggregateCharacters,
    publication.budget.snapshot().aggregateCharacters + nextClaimed.document.callCost.characters);
  assert.equal(read(value).source.context.evidenceDigest, value.document.context.evidenceDigest);
});

for (const [name, change] of [
  ["changed root canonical rules", (root) => fs.appendFileSync(path.join(root, "AGENTS.md"), "Changed root contract.\n")],
  ["changed saved scoped rules", (root) => fs.appendFileSync(path.join(root, "src/AGENTS.md"), "Changed scoped contract.\n")],
  ["missing saved scoped rules", (root) => fs.unlinkSync(path.join(root, "src/AGENTS.md"))],
  ["unavailable saved scoped rules", (root) => fs.writeFileSync(path.join(root, "src/AGENTS.md"), Buffer.from([0xff, 0xfe]))],
  ["changed merged guardrails", (root) => fs.writeFileSync(path.join(root, ".sennel/guardrail.json"), JSON.stringify({
    guardrails: [{ id: "R1", body: "A changed applicable guardrail.", meta: { phase: ["spec"], category: "requirements" } }],
  }))],
]) {
  test(`richer checkpoint refuses ${name} without changing canonical state or budget`, async (t) => {
    const value = await archivedCheckpoint(t);
    change(value.root);
    const before = durable(value);
    assert.throws(() => read(value), { code: "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED", retryable: false });
    assert.deepEqual(durable(value), before);
  });
}

for (const logicalKey of ["spec.gate.repair.source.manifest", "spec.gate.repair.source.blob"]) {
  test(`richer checkpoint refuses tampered ${logicalKey} before consulting live canonical rules`, async (t) => {
    const value = await archivedCheckpoint(t);
    const manager = value.ctx.flowManager;
    const state = manager.canonicalState(value.specId);
    const lifecycle = manager.draftStepExecutionState({ binding: { runId: state.runId, specId: value.specId,
      stepId: "spec-gate-repair", attempt: state.attempt } }).lifecycle;
    const catalog = manager.artifactCatalog(value.specId);
    const location = manager.specLocation(value.specId);
    const protectedPaths = [location.flowStateFile, location.activitiesFile, location.catalogFile,
      ...catalog.artifacts.filter((entry) => entry.logicalKey === "spec.gate.repair.progress")
        .map((entry) => path.join(location.directory, entry.relativePath))];
    const protectedBytes = () => protectedPaths.map((file) => [file, fs.readFileSync(file).toString("base64")]);
    const before = protectedBytes();
    const artifact = catalog.artifacts.find((entry) => entry.logicalKey === logicalKey
      && (logicalKey.endsWith("manifest") ? entry.hash === value.document.sourceSnapshotReference.digest : entry.hash === hash(savedCode)));
    const target = path.join(location.directory, artifact.relativePath);
    fs.appendFileSync(target, "tampered");
    fs.unlinkSync(path.join(value.root, "src/AGENTS.md"));
    const openedCurrentRules = [];
    const open = fs.openSync;
    t.mock.method(fs, "openSync", (file, ...options) => {
      if (file === path.join(value.root, "AGENTS.md") || file === path.join(value.root, "src/AGENTS.md")) openedCurrentRules.push(file);
      return open(file, ...options);
    });
    assert.throws(() => readProgressBoundSpecGateRepairInput({ flowManager: manager, state,
      executionRoot: value.root, executionLifecycle: lifecycle }), (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, `artifact content does not match the catalog: ${artifact.relativePath}`);
      return true;
    });
    assert.deepEqual(openedCurrentRules, [], "invalid immutable publication must stop before any current-rule capture");
    assert.deepEqual(protectedBytes(), before, "state, catalog, activities, lifecycle and saved budget bytes remain unchanged");
  });
}
