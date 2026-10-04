import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { runGit } from "../../../src/lib/git-helpers.js";
import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { SpecGateRepairSourceSnapshots } from "../../../src/flow/lib/spec-gate-repair-values.js";
import { readSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-input.js";
import { canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { prepareSpecGateRepairService, createSpecGateRepairScenario, completeSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { reserveFixtureSpecGateRepairWorkerCall } from "../../support/infrastructure/spec-gate-repair-admission.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { latestRepairBudget, SpecGateRepairProgressLedger } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { readSpecGateRepairSources } from "../../../src/flow/lib/spec-gate-repair-sources.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

test("repair handoff reads the linked Issue, prior Draft and referenced working-tree source after reload", async () => {
  const value = await createSpecGateRepairScenario({ issue: 42,
    issueSnapshot: "# Requirement\nInclude regression checks for consumers of src/help.js.\n",
    request: "Preserve the shared help contract.",
    beforeGate: ({ root, specId, flowManager, flow }) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/help.js"), "export const render = () => 'help';\n");
      fs.writeFileSync(path.join(root, "AGENTS.md"), "Reuse the existing renderer.\n");
      fs.writeFileSync(path.join(root, "src/AGENTS.md"), "Preserve source exports.\n");
      assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
      assert.equal(runGit(["add", "src/help.js", "AGENTS.md", "src/AGENTS.md"], { cwd: root }).ok, true);
      flow.activate("draft");
      flowManager.publishCurrentAttemptResult({ specId,
        commandResult: attachCanonicalCommandResultPublications({ result: "draft prepared" }, [{
          logicalKey: "draft", payload: canonicalDraftDocument({ goal: "Preserve existing shared consumers." }),
        }]),
      });
    },
  });
  try {
    const reloaded = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
    value.ctx.flowManager = reloaded;
    const input = () => readSpecGateRepairInput({ flowManager: reloaded,
      state: reloaded.canonicalState(value.specId), executionRoot: value.root });
    const first = input();
    const selected = first.context.select(first.context.units()[0].id);
    const evidence = new Map(selected.ranges.filter((range) => range.id.startsWith("evidence:"))
      .map((range) => [range.id, range]));
    for (const id of ["evidence:issue.snapshot", "evidence:draft", "evidence:project-rules", "evidence:project-rules:src/AGENTS.md"]) {
      assert(evidence.has(id), `canonical repair input must include ${id}`);
    }
    assert.match(evidence.get("evidence:issue.snapshot").value.content, /Include regression checks/);
    assert.match(evidence.get("evidence:draft").value.content, /Preserve existing shared consumers/);
    assert.match(evidence.get("evidence:project-rules").value.content, /Reuse the existing renderer/);
    assert.deepEqual(evidence.get("evidence:project-rules:src/AGENTS.md").value.appliesTo, ["src"]);
    // Optional code bodies now require a registered digest-bound source range; initial input supplies descriptors.
    assert(!selected.ranges.some((range) => range.value?.snapshotId === "evidence:source:src/help.js"));
    const descriptor = first.context.tableOfContents().find((range) => range.source?.origin === "src/help.js");
    assert.equal(descriptor.bodyStatus, "available-not-selected");
    const expanded = first.context.select(selected.unit.id, { additionalRangeIds: [descriptor.id] });
    assert.match(expanded.ranges.find((range) => range.id === descriptor.id).value.content, /export const render/);
    for (const range of evidence.values()) {
      assert.equal(range.writable, false);
      assert.equal(range.target, null);
      assert.match(range.value.revision, /^[a-f0-9]{64}$/);
    }
    fs.writeFileSync(path.join(value.root, "src/help.js"), "export const render = () => 'updated help';\n");
    assert.notEqual(input().context.evidenceDigest, first.context.evidenceDigest);
    const outcome = await completeSpecGateRepairHandoff({ ...value,
      replacement: "Publish a precisely validated artifact." });
    const requestContext = outcome.request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    assert.match(JSON.stringify(requestContext), /Include regression checks/);
    assert(!JSON.stringify(requestContext).includes("updated help"));
    const locator = outcome.request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").descriptor.canonicalLocator;
    const saved = reloaded.readArtifact({ specId: value.specId, logicalKey: "spec.gate.repair.progress",
      consumerNodeId: "spec-gate-repair", parameters: { attemptId: locator.attemptId,
        generation: String(locator.generation), phase: "checkpoint" } });
    const snapshots = SpecGateRepairSourceSnapshots.fromJSON(JSON.parse(saved.bytes.toString("utf8")).sourceSnapshots);
    assert.match(snapshots.sources().find((source) => source.origin === "src/help.js").content, /updated help/);
    assert.deepEqual(outcome.request.inputs[0].document, JSON.parse(saved.bytes.toString("utf8")).context);
    assert(["spec-gate-repair-review-required", "spec-gate-repair-ready-for-gate"].includes(outcome.result.kind));
    assert(["spec-review", "spec-gate"].includes(outcome.service.workerOutcome.receipt.targetStepId));
  } finally { removeTmpDir(value.root); }
});

for (const { name, scenario, expectedError } of [
  {
    name: "a stale Spec revision",
    scenario: {
      mutateGateObservations: (observations) => observations.map((observation) => ({
        ...observation, specRevision: `sha256:${"b".repeat(64)}`,
      })),
    },
    expectedError: /revision is stale or absent/,
  },
  {
    name: "replacement authority for an absent task field",
    scenario: {
      target: { entity: "task", id: "T1", field: "acceptance" },
      operationKinds: ["add-entity-field"],
      mutateGateObservations: (observations) => observations.map((observation) => ({
        ...observation,
        allowedTargets: observation.allowedTargets.map((permission) => ({
          ...permission, operationKinds: ["replace-entity-field"],
        })),
      })),
    },
    expectedError: /impossible targets/,
  },
]) {
  test(`repair readback refuses persisted Gate target with ${name} without mutation`, async () => {
    const value = await createSpecGateRepairScenario(scenario);
    try {
      const reloaded = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const before = {
        state: reloaded.canonicalState(value.specId).toJSON(),
        catalog: reloaded.artifactCatalog(value.specId).toJSON(),
        activities: reloaded.activityLedger(value.specId),
      };
      assert.throws(() => readSpecGateRepairInput({ flowManager: reloaded,
        state: reloaded.canonicalState(value.specId), executionRoot: value.root }), expectedError);
      assert.deepEqual({
        state: reloaded.canonicalState(value.specId).toJSON(),
        catalog: reloaded.artifactCatalog(value.specId).toJSON(),
        activities: reloaded.activityLedger(value.specId),
      }, before);
    } finally { removeTmpDir(value.root); }
  });
}


test("captured source statuses and hierarchical rules survive exact UTF-8 snapshot readback", () => {
  const root = createTmpDir("repair-source-snapshots-");
  try {
    fs.mkdirSync(path.join(root, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Root rule\n");
    fs.writeFileSync(path.join(root, "src/AGENTS.md"), "Source rule\n");
    fs.writeFileSync(path.join(root, "src/nested/AGENTS.md"), "Nested exception clause\n");
    fs.writeFileSync(path.join(root, "src/nested/text.js"), "\ufeff漢🧭\r\nexport const value = 1;\n");
    fs.writeFileSync(path.join(root, "src/nested/missing.js"), "Tracked before removal");
    fs.writeFileSync(path.join(root, "src/nested/binary.js"), Buffer.from([0xff, 0xfe, 0x00]));
    assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
    assert.equal(runGit(["add", "."], { cwd: root }).ok, true);
    fs.unlinkSync(path.join(root, "src/nested/missing.js"));
    const sources = readSpecGateRepairSources({ flowManager: { readArtifact: () => null },
      state: { request: "Inspect src/nested/text.js, src/nested/missing.js and src/nested/binary.js", issue: null },
      executionRoot: root, spec: {} });
    const byOrigin = new Map(sources.map((source) => [source.origin, source]));
    assert.equal(byOrigin.get("src/nested/missing.js").availability, "missing");
    assert.equal(byOrigin.get("src/nested/binary.js").availability, "unavailable");
    assert.equal(byOrigin.get("src/nested/binary.js").content, "");
    const text = byOrigin.get("src/nested/text.js");
    assert.equal(text.availability, "available");
    assert.equal(text.content, "\ufeff漢🧭\r\nexport const value = 1;\n");
    assert.equal(text.revision, text.digest);
    assert.equal(text.byteLength, fs.statSync(path.join(root, text.origin)).size);
    assert.equal(byOrigin.get("AGENTS.md").required, true);
    assert.deepEqual(byOrigin.get("src/AGENTS.md").appliesTo, ["src"]);
    assert.deepEqual(byOrigin.get("src/nested/AGENTS.md").appliesTo, ["src/nested"]);
    const snapshots = new SpecGateRepairSourceSnapshots(sources);
    const savedPath = path.join(root, "snapshots.json");
    fs.writeFileSync(savedPath, JSON.stringify(snapshots.toJSON()));
    const restored = SpecGateRepairSourceSnapshots.fromJSON(JSON.parse(fs.readFileSync(savedPath, "utf8")));
    assert.deepEqual(restored.toJSON(), snapshots.toJSON());
    const changedBytes = restored.toJSON(); changedBytes.sources.find((source) => source.origin === text.origin).byteLength++;
    assert.throws(() => SpecGateRepairSourceSnapshots.fromJSON(changedBytes), /digest mismatch/);
  } finally { removeTmpDir(root); }
});


test("source and index requests survive publication replay and reach the next worker generation exactly", async () => {
  const specRecord = validWorkerHandoffSpec();
  specRecord.requirements.push(...Array.from({ length: 40 }, (_, index) => ({
    id: `R${index + 2}`, desc: `Unselected requirement ${index + 2}`, testable: false, task_ids: ["T1"],
  })));
  const sourceText = "export const renderer = '漢🧭';\r\n// Full immutable source evidence.\n";
  const value = await createSpecGateRepairScenario({ specRecord,
    request: "Preserve src/renderer.js and its existing exports.",
    beforeGate: ({ root }) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/renderer.js"), sourceText);
      fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep the canonical export contract.\n");
      fs.writeFileSync(path.join(root, "src/AGENTS.md"), "Scope source rules to src.\n");
      assert.equal(runGit(["init", "-q"], { cwd: root }).ok, true);
      assert.equal(runGit(["add", "src/renderer.js", "AGENTS.md", "src/AGENTS.md"], { cwd: root }).ok, true);
    },
  });
  const reload = () => {
    value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    value.coordinator = new WorkerArtifactHandoffCoordinator();
  };
  const selectedInput = (request) => request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json");
  const selectionFor = (request) => SpecGateRepairBundle.fromJSON(selectedInput(request).document.bundle).selections()[0];
  const readProgress = (attemptId, generation, phase) => JSON.parse(value.ctx.flowManager.readArtifact({
    specId: value.specId, logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
    parameters: { attemptId, generation: String(generation), phase },
  }).bytes.toString("utf8"));
  const durableState = () => ({
    state: value.ctx.flowManager.canonicalState(value.specId).toJSON(),
    activities: value.ctx.flowManager.activityLedger(value.specId),
    catalog: value.ctx.flowManager.artifactCatalog(value.specId).toJSON(),
  });
  try {
    reload();
    const first = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.ctx.flowManager.load(value.specId), invocation: value.invocation });
    const selected = selectionFor(first);
    const firstIndex = selected.ranges.find((range) => range.id === selected.indexManifest.firstPageId).value;
    const sourceDescriptor = firstIndex.descriptors.find((entry) => entry.source?.origin === "src/renderer.js");
    assert(sourceDescriptor, "the real Git source descriptor is discoverable in the supplied index page");
    assert(selected.indexManifest.pageCount > 1);
    assert(firstIndex.nextPageId, "the structural index has an actual registered next page");
    assert(!selected.ranges.some((range) => range.value?.snapshotId === sourceDescriptor.source.id));
    assert(!selected.ranges.some((range) => range.id === "requirements[R2].desc"));
    const attemptId = value.ctx.flowManager.canonicalState(value.specId).attempt.id;
    const budgetInput = { specId: value.specId, attemptId, baseRevision: selected.baseRevision,
      consumerNodeId: "spec-gate-repair" };
    const budget = () => latestRepairBudget({ ...budgetInput, flowManager: value.ctx.flowManager }).budget.snapshot();
    const proposal = { version: 1, stage: "spec-gate-repair-context-request",
      baseRevision: selected.baseRevision, unitId: selected.unit.id,
      additionalRangeIds: [sourceDescriptor.id, firstIndex.nextPageId, "requirements[R2].desc"] };
    fs.writeFileSync(first.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
    reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request: first,
      prompt: JSON.stringify(first.toPromptReference()) });
    const initialCheckpoint = readProgress(attemptId, 0, "checkpoint");
    const initialSnapshots = initialCheckpoint.sourceSnapshots;
    sealWorkerArtifactHandoff({ requestPath: first.requestPath, invocationId: first.dispatchInvocationId });
    await prepareSpecGateRepairService({ ctx: value.ctx, request: first,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const firstPublication = readProgress(attemptId, 0, "publication");
    assert.deepEqual(firstPublication.sourceSnapshots, initialSnapshots);
    assert.deepEqual(firstPublication.proposal.additionalRangeIds, proposal.additionalRangeIds);
    assert.equal(firstPublication.budget.providerCallCount, 1);
    assert.equal(firstPublication.budget.aggregateCharacters,
      firstPublication.plan.budgetFrontier.aggregateCharacters + firstPublication.callCost.characters + firstPublication.responseCost.characters);
    // Discard the provider preparation and recover the publication through canonical registered composition.
    reload();
    const state = value.ctx.flowManager.canonicalState(value.specId);
    const lifecycle = value.ctx.flowManager.draftStepExecutionState({ binding: {
      runId: state.runId, specId: value.specId, stepId: "spec-gate-repair", attempt: state.attempt,
    } }).lifecycle;
    assert.equal(lifecycle.phase, "publication");
    const restored = value.coordinator.restoreClaimedDraftRequest({ ctx: value.ctx,
      state: value.ctx.flowManager.load(value.specId), lifecycle });
    const registration = specStepRegistration("spec-gate-repair");
    const prepared = await registration.create({ ctx: value.ctx, request: restored,
      handoffCoordinator: value.coordinator });
    assert.deepEqual(prepared.dependency(SpecGateRepairService).inspectWorkerCompletion().proposal, proposal);
    const contextResult = await prepared.step.execute();
    assert.equal(contextResult.kind, "spec-gate-repair-context-required");
    assert.deepEqual(budget(), firstPublication.budget);
    const firstCompletion = readProgress(attemptId, 0, "completed");
    assert.equal(firstCompletion.generation, 0);
    assert(firstCompletion.publicationReceiptId);
    const beforeReplay = durableState();
    const beforeReplayBudget = budget();
    reload();
    // Completed context responses route to the next generation; re-preparing the old response is a safe refusal.
    await assert.rejects(() => prepareSpecGateRepairService({ ctx: value.ctx,
      state: value.ctx.flowManager.canonicalState(value.specId), handoffCoordinator: value.coordinator }),
      /Gate repair response is already completed or unavailable/);
    assert.deepEqual(durableState(), beforeReplay);
    assert.deepEqual(budget(), beforeReplayBudget);
    reload();
    const next = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.ctx.flowManager.load(value.specId),
      invocation: { ...value.invocation, id: "source-index-next-generation" } });
    const nextSelection = selectionFor(next);
    assert.deepEqual(nextSelection.unit.findings, selected.unit.findings);
    const selectedSource = nextSelection.ranges.find((range) => range.id === sourceDescriptor.id);
    assert.equal(selectedSource.value.content, sourceText);
    assert.equal(selectedSource.value.snapshotDigest, sourceDescriptor.source.digest);
    assert.equal(selectedSource.value.byteStart, 0);
    assert.equal(selectedSource.value.byteEnd, Buffer.byteLength(sourceText, "utf8"));
    assert.equal(selectedSource.writable, false);
    const nextIndex = nextSelection.ranges.find((range) => range.id === firstIndex.nextPageId);
    assert.equal(nextIndex.value.page, 1);
    assert.equal(nextIndex.value.revision, selected.indexManifest.revision);
    assert.equal(nextIndex.writable, false);
    assert.equal(nextSelection.ranges.find((range) => range.id === "requirements[R2].desc").value, "Unselected requirement 2");
    assert(!nextSelection.ranges.some((range) => range.id === "requirements[R2].testable"));
    assert(!nextSelection.ranges.some((range) => range.id === "tasks[T1].goal"));
    assert.deepEqual(nextSelection.ranges.filter((range) => range.writable), selected.ranges.filter((range) => range.writable));
    assert.notEqual(next.requestDigest, first.requestDigest);
    const range = nextSelection.ranges.find((entry) => entry.writable);
    fs.writeFileSync(next.payloadPath("spec-gate-repair.json"), workerArtifactJson({
      version: 1, stage: "spec-gate-repair", baseRevision: nextSelection.baseRevision,
      groups: [{ findingIdentities: nextSelection.unit.findings.map((finding) => finding.identity), operations: [{
        kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
        edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value, "utf8"), replacement: "Publish a precisely validated artifact." }],
        reason: "Use the canonical source and page evidence to correct the selected finding.",
      }] }],
    }));
    reserveFixtureSpecGateRepairWorkerCall({ ctx: value.ctx, request: next,
      prompt: JSON.stringify(next.toPromptReference()) });
    const nextCheckpoint = readProgress(attemptId, 1, "checkpoint");
    assert.equal(nextCheckpoint.generation, 1);
    assert.deepEqual(nextCheckpoint.sourceSnapshots, initialSnapshots);
    assert.deepEqual(nextCheckpoint.plan.budgetFrontier, firstPublication.budget);
    assert.equal(nextCheckpoint.budget.aggregateCharacters, firstPublication.budget.aggregateCharacters + nextCheckpoint.callCost.characters);
    assert(nextCheckpoint.callCost.characters > firstPublication.callCost.characters);
    sealWorkerArtifactHandoff({ requestPath: next.requestPath, invocationId: next.dispatchInvocationId });
    const nextService = await prepareSpecGateRepairService({ ctx: value.ctx, request: next,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const nextResult = await new StepFactory().provide(SpecGateRepairService, nextService).create(SpecGateRepairStep).execute();
    assert(["spec-gate-repair-review-required", "spec-gate-repair-ready-for-gate"].includes(nextResult.kind));
    const nextPublication = readProgress(attemptId, 1, "publication");
    assert.deepEqual(nextPublication.sourceSnapshots, initialSnapshots);
    assert.equal(nextPublication.budget.providerCallCount, 2);
    assert.equal(nextPublication.budget.aggregateCharacters,
      firstPublication.budget.aggregateCharacters + nextPublication.callCost.characters + nextPublication.responseCost.characters);
    const ledger = new SpecGateRepairProgressLedger({ flowManager: value.ctx.flowManager, ...budgetInput });
    assert.equal(ledger.entries.length, 2);
    assert.deepEqual(ledger.entries.map((entry) => entry.generation), [0, 1]);
    const accepted = value.ctx.flowManager.readArtifact({ specId: value.specId, logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" });
    assert.equal(JSON.parse(accepted.bytes.toString("utf8")).requirements[0].desc, "Publish a precisely validated artifact.");
  } finally { removeTmpDir(value.root); }
});
