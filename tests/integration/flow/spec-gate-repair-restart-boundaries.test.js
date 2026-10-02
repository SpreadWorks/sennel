import { ResolvedAgentInvocationProjection } from "../../../src/lib/prompt-batching.js";
import { ServiceBoundaryCoverage } from "../../support/structure/service-boundary.js";
import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { reserveFixtureSpecGateRepairWorkerCall as reserveSpecGateRepairWorkerCall,
} from "../../support/infrastructure/spec-gate-repair-admission.js";
import { prepareSpecGateRepairService } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, it, mock } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairBundle } from "../../../src/flow/lib/spec-gate-repair-bundle.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { settleSpecStepResult } from "../../../src/flow/definition.js";
import { workerArtifactStableStringify } from "../../../src/flow/lib/worker-artifact-input-format.js";
import { SpecWorkerStepBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { latestRepairBudget, SpecGateRepairProgressLedger } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { readProgressBoundSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { validateSpecJsonObject } from "../../../src/lib/spec-json.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import { WorkerArtifactHandoffCoordinator, WorkerArtifactHandoffError,
  sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario, prepareSpecGateRepairHandoff } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { dispatchContainer, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";

function projectInvocation(prompt) {
  return new ResolvedAgentInvocationProjection({ providerKey: "fixture", profileKey: "fixture", command: "fixture",
    promptCharacterCount: prompt.length, systemPromptCharacterCount: 0, schemaCharacterCount: 0,
    finalArgs: [], inlineArgvByteCount: 0, schemaMode: "none", usesStdin: true });
}

function durableSnapshot(manager, specId) {
  return {
    state: manager.canonicalState(specId).toJSON(),
    activities: manager.activityLedger(specId),
    catalog: manager.artifactCatalog(specId).toJSON(),
    spec: manager.readArtifact({ specId, logicalKey: "spec.record",
      consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8"),
  };
}

function artifactCount(snapshot, key) {
  return snapshot.catalog.artifacts.filter((artifact) => artifact.logicalKey === key).length;
}

function assertOneTerminalPublication(manager, specId, before) {
  const after = durableSnapshot(manager, specId);
  assert.equal(artifactCount(after, "spec.snapshot"), artifactCount(before, "spec.snapshot") + 1);
  assert.equal(artifactCount(after, "spec.gate.repair.audit"), artifactCount(before, "spec.gate.repair.audit") + 1);
  assert.equal(after.activities.filter((activity) => activity.nodeId === "spec-gate-repair"
    && activity.result?.stepResult?.kind === "spec-gate-repair-review-required").length, 1);
  assert.equal(JSON.parse(after.spec).requirements[0].desc,
    "Publish a precisely validated artifact.");
}

function oversizedSpec() {
  const specRecord = validWorkerHandoffSpec();
  specRecord.overview.decisions = Array.from({ length: 60 }, (_, index) => ({
    text: `Decision ${index}: ${"Preserve interface. ".repeat(24)}`,
    evidence: "The planned contract remains explicit. ".repeat(25),
    consideredAlternatives: "A different boundary was considered. ".repeat(25),
  }));
  return specRecord;
}

function nextRequest(value, index) {
  return value.coordinator.createRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.load(value.specId),
    invocation: { ...value.invocation, id: `dispatch-spec-gate-repair-context-${index}` },
  });
}

function repairSelections(context) {
  return SpecGateRepairBundle.fromJSON(context.bundle).selections();
}

function draftReturnProposal(context, decision) {
  return { version: 1, stage: "spec-gate-repair-draft-return",
    baseRevision: context.baseRevision, unitId: repairSelections(context)[0].unit.id,
    decision, evidence: "The supplied Issue, Draft and Spec leave this choice unresolved.",
    unresolvedBecause: "No supplied source selects the required validation target." };
}

function historicalRepairSeed(name) {
  // Captured through the canonical HEAD 7e49c90d2 writer after completed
  // locate generations. Each portable archive contains its canonical specs tree.
  const root = createTmpDir(`historical-repair-${name}-`);
  try {
    const archive = fs.readFileSync(new URL(`../../fixtures/spec-gate-repair-historical-${name}.json.br`, import.meta.url));
    const files = JSON.parse(brotliDecompressSync(archive).toString("utf8"));
    for (const [relativePath, encoded] of files) {
      const destination = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(encoded, "base64"));
    }
    return root;
  } catch (error) {
    removeTmpDir(root);
    throw error;
  }
}

async function completeWorkerResponse(value, request, proposal) {
  fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
  reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
    prompt: JSON.stringify(request.toPromptReference()) });
  sealWorkerArtifactHandoff({ requestPath: request.requestPath,
    invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z") });
  await prepareSpecGateRepairService({ ctx: value.ctx, request,
    Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
  // Lose every in-memory preparation after response publication, before Step execution.
  value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root,
    inWorktree: false, specId: value.specId });
  const state = value.ctx.flowManager.canonicalState(value.specId);
  const lifecycle = value.ctx.flowManager.draftStepExecutionState({ binding: {
    runId: state.runId, specId: value.specId, stepId: "spec-gate-repair", attempt: state.attempt,
  } }).lifecycle;
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const restored = coordinator.restoreClaimedDraftRequest({ ctx: value.ctx,
    state: value.ctx.flowManager.load(value.specId), lifecycle });
  const beforeReplay = durableSnapshot(value.ctx.flowManager, value.specId);
  const registration = specStepRegistration("spec-gate-repair");
  const prepared = await registration.create({ ctx: value.ctx, request: restored,
    handoffCoordinator: coordinator });
  const coverage = new ServiceBoundaryCoverage([registration]);
  const service = coverage.inspectPrepared(registration, prepared);
  assert.equal(coverage.assertComplete(), 1);
  assert.deepEqual(durableSnapshot(value.ctx.flowManager, value.specId), beforeReplay);
  const publicationReceipt = value.ctx.flowManager.readCurrentStepSettlement({
    specId: value.specId, stepId: "spec-gate-repair",
  }).receipt;
  const result = await prepared.step.execute();
  return { service, result, publicationReceipt };
}

describe("Spec Gate repair restart boundaries", () => {
  it("completes a published response at the durable call limit before rejecting new work", async () => {
    const specRecord = validWorkerHandoffSpec();
    specRecord.requirements.push(...Array.from({ length: 10 }, (_, index) => ({
      id: `R${index + 2}`, desc: `Separate validation target ${index + 2}.`,
      testable: false, task_ids: [`T${index + 2}`],
    })));
    const value = await createSpecGateRepairScenario({ specRecord });
    try {
      const canonicalSpec = JSON.parse(value.ctx.flowManager.readArtifact({ specId: value.specId,
        logicalKey: "spec.record", consumerNodeId: "spec-gate-repair" }).bytes.toString("utf8"));
      const taskIds = new Set(canonicalSpec.tasks.map((task) => task.id));
      assert(canonicalSpec.requirements.every((requirement) => requirement.task_ids.every((id) => taskIds.has(id))));
      const nextContextRequest = (index) => {
        const request = nextRequest(value, `budget-recovery-${index}`);
        const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
        assert.equal(selected.mode, "repair");
        const { source } = readProgressBoundSpecGateRepairInput({
          flowManager: value.ctx.flowManager,
          state: value.ctx.flowManager.canonicalState(value.specId), executionRoot: value.root });
        const selectedIds = new Set(repairSelections(selected)[0].ranges.map((range) => range.id));
        const extra = source.context.tableOfContents().find((range) => !selectedIds.has(range.id));
        assert(extra, "each provider response must request new canonical context");
        return { request, selected, proposal: { version: 1, stage: "spec-gate-repair-context-request",
          baseRevision: selected.baseRevision, unitId: repairSelections(selected)[0].unit.id,
          additionalRangeIds: [extra.id] } };
      };
      for (let index = 0; index < 15; index += 1) {
        const planned = nextContextRequest(index);
        const { result, service } = await completeWorkerResponse(value, planned.request, planned.proposal);
        assert.equal(result.kind, "spec-gate-repair-context-required");
        assert(service.partialProgressReceipt);
      }
      const final = nextContextRequest(15);
      fs.writeFileSync(final.request.payloadPath("spec-gate-repair.json"), workerArtifactJson(final.proposal));
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request: final.request,
        prompt: JSON.stringify(final.request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: final.request.requestPath,
        invocationId: final.request.dispatchInvocationId });
      await prepareSpecGateRepairService({ ctx: value.ctx, request: final.request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const budgetInput = { specId: value.specId,
        attemptId: value.ctx.flowManager.canonicalState(value.specId).attempt.id,
        baseRevision: final.selected.baseRevision, consumerNodeId: "spec-gate-repair" };
      assert.equal(latestRepairBudget({ ...budgetInput, flowManager: value.ctx.flowManager }).budget.providerCallCount, 16);
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const restartedCtx = { ...value.ctx, flowManager: restarted };
      const replay = await prepareSpecGateRepairService({ ctx: restartedCtx,
        state: restarted.canonicalState(value.specId), handoffCoordinator: value.coordinator });
      const recovered = await new StepFactory().provide(SpecGateRepairService, replay)
        .create(SpecGateRepairStep).execute();
      assert.equal(recovered.kind, "spec-gate-repair-context-required");
      assert.equal(replay.workerOutcome.replayed, true);
      assert(replay.partialProgressReceipt);
      assert.equal(latestRepairBudget({ ...budgetInput, flowManager: restarted }).budget.providerCallCount, 16);
      const before = durableSnapshot(restarted, value.specId);
      const following = value.coordinator.createRequest({ ctx: restartedCtx,
        state: restarted.load(value.specId),
        invocation: { ...value.invocation, id: "budget-recovery-next-call" } });
      assert.throws(() => reserveSpecGateRepairWorkerCall({ ctx: restartedCtx,
        request: following, prompt: JSON.stringify(following.toPromptReference()) }),
      { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
      assert.deepEqual(durableSnapshot(restarted, value.specId), before);
      assert.equal(latestRepairBudget({ ...budgetInput, flowManager: restarted }).budget.providerCallCount, 16);
    } finally { removeTmpDir(value.root); }
  });

  for (const [archive, specId] of [
    ["ordinal", "901-historical-ordinal-locate"],
    ["mixed", "902-historical-mixed-locate"],
    ["equal-count", "903-historical-equal-count-locate"],
  ]) {
    it(`refuses archived ${archive} locator-only Gate evidence without changing canonical state`, () => {
      const root = historicalRepairSeed(archive);
      try {
        const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const before = durableSnapshot(flowManager, specId);
        assert.throws(() => readProgressBoundSpecGateRepairInput({ flowManager,
          state: flowManager.canonicalState(specId), executionRoot: root }),
        /Spec Gate repair target revision is stale or absent/);
        assert.deepEqual(durableSnapshot(flowManager, specId), before);
      } finally { removeTmpDir(root); }
    });
  }

  it("preserves an exact claimed repair handoff's stale error when its plan is current", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = value.coordinator.createRequest({ ctx: value.ctx,
        state: value.flowManager.load(value.specId), invocation: value.invocation });
      const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(selected.mode, "repair");
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      const stale = new WorkerArtifactHandoffError("stale", "FLOW_ARTIFACT_HANDOFF_STALE",
        "worker artifact handoff input digest or revision is stale", { recoveryPossible: false });
      const before = durableSnapshot(value.flowManager, value.specId);
      await assert.rejects(() => prepareSpecGateRepairService({ ctx: value.ctx, request,
        Connector: SpecEntryConnector,
        handoffCoordinator: { prepareSpecWorker() { throw stale; } },
      }), (error) => error === stale);
      assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
      assert.equal(latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
        attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
        baseRevision: selected.baseRevision, consumerNodeId: "spec-gate-repair" })
        .budget.providerCallCount, 1);
    } finally { removeTmpDir(value.root); }
  });

  for (const maxStalledDispatches of [1, 3]) {
    it(`continues four completed context responses in one dispatcher at stall limit ${maxStalledDispatches}`, async () => {
      const value = await createSpecGateRepairScenario();
      try {
        initGitRepo(value.root);
        fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
        commitAll(value.root, "Create isolated repair continuation repository");
        const initialSpec = durableSnapshot(value.flowManager, value.specId).spec;
        const generations = [];
        let baseRevision = null;
        const agent = { projectInvocation, async call(_prompt, options) {
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          const selected = requestInput(request, "spec-gate-repair-context.json").document;
          baseRevision ??= selected.baseRevision;
          const generation = generations.length;
          assert.equal(selected.mode, "repair");
          const proposal = generation < 4 ? (() => {
            const { source } = readProgressBoundSpecGateRepairInput({
              flowManager: value.flowManager, state: value.flowManager.canonicalState(value.specId),
              executionRoot: value.root });
            const selectedIds = new Set(repairSelections(selected)[0].ranges.map((range) => range.id));
            const extra = source.context.tableOfContents().find((range) => !selectedIds.has(range.id));
            assert(extra, "four distinct additional ranges are available");
            return { version: 1, stage: "spec-gate-repair-context-request",
              baseRevision: selected.baseRevision, unitId: repairSelections(selected)[0].unit.id,
              additionalRangeIds: [extra.id] };
          })() : draftReturnProposal(selected, "Which exact acceptance condition is intended?");
          fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
          sealWorkerArtifactHandoff({ requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
          generations.push({ requestDigest: request.requestDigest, proposal });
          return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
        } };
        const repairAttemptId = value.flowManager.canonicalState(value.specId).attempt.id;
        const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 5, maxStalledDispatches,
          repositoryFingerprint: () => "f".repeat(64) });
        dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
        const result = await dispatcher.execute({ ...value.ctx,
          flowState: value.flowManager.loadReadOnly(value.specId),
          expectBinding: FlowTargetBinding.capture({ flowState: value.flowManager.loadReadOnly(value.specId),
            mainRoot: value.root, authorityRoot: value.root }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch" });
        assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "draft", JSON.stringify(result));
        assert.equal(generations.length, 5, JSON.stringify(result));
        const ledger = new SpecGateRepairProgressLedger({ flowManager: value.flowManager,
          specId: value.specId, attemptId: repairAttemptId,
          baseRevision });
        assert.equal(ledger.entries.length, 5);
        const activities = value.flowManager.activityLedger(value.specId);
        for (const entry of ledger.entries.slice(0, 4)) {
          const completion = value.flowManager.readArtifact({ specId: value.specId,
            logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
            parameters: { attemptId: repairAttemptId,
              generation: String(entry.generation), phase: "completed" } });
          const saved = JSON.parse(completion.bytes.toString("utf8"));
          const receipt = activities.find((activity) => activity.id === completion.descriptor.activityId)
            ?.result?.draftSettlementReceipt;
          assert.equal(saved.generation, entry.generation);
          assert.equal(saved.requestDigest, entry.requestDigest);
          assert.equal(saved.resultKind, "spec-gate-repair-context-required");
          assert.equal(receipt?.resultKind, saved.resultKind);
          assert.equal(receipt?.executionLifecycle?.binding.executionGeneration, entry.generation);
          assert.notEqual(receipt?.id, saved.publicationReceiptId);
        }
        assert.equal(latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
          attemptId: repairAttemptId,
          baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 5);
        assert.equal(durableSnapshot(value.flowManager, value.specId).spec, initialSpec);
      } finally { removeTmpDir(value.root); }
    });
  }

  it("continues a completed intermediate response through the next dispatcher worker", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated repair continuation repository");
      const initialSpec = durableSnapshot(value.flowManager, value.specId).spec;
      let context = null;
      let firstRequestDirectory = null;
      let firstWorkerCalls = 0;
      const firstAgent = { projectInvocation, async call(_prompt, options) {
        firstWorkerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        firstRequestDirectory = path.dirname(requestPath);
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        context = requestInput(request, "spec-gate-repair-context.json").document;
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
          version: 1, stage: "spec-gate-repair-context-request",
          baseRevision: context.baseRevision, unitId: repairSelections(context)[0].unit.id,
          additionalRangeIds: ["background"],
        }));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      } };
      const firstDispatcher = new RunDispatchCommand({ agent: firstAgent, maxDispatches: 1 });
      firstDispatcher.container = dispatchContainer({ root: value.root,
        flowManager: value.flowManager, agent: firstAgent });
      const firstResult = await firstDispatcher.execute({ ...value.ctx,
        flowState: value.flowManager.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: value.flowManager.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(firstWorkerCalls, 1, JSON.stringify(firstResult));
      assert.equal(value.flowManager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).result.kind, "spec-gate-repair-context-required");
      assert.equal(fs.existsSync(firstRequestDirectory), false);
      assert.equal(typeof firstResult.data?.dispatch?.binding, "string");
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      let nextContext = null;
      const agent = { projectInvocation, async call(_prompt, options) {
        workerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        nextContext = requestInput(request, "spec-gate-repair-context.json").document;
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(
          draftReturnProposal(nextContext, "Which validation target should the repair name?")));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      } };
      const repairAttemptId = restarted.canonicalState(value.specId).attempt.id;
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: firstResult.data.dispatch.binding,
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(workerCalls, 1, JSON.stringify(result));
      assert.equal(nextContext.mode, "repair");
      assert.notEqual(nextContext.batchDigest, context.batchDigest);
      assert.equal(restarted.canonicalState(value.specId).current.at(-1), "draft");
      assert.equal(durableSnapshot(restarted, value.specId).spec, initialSpec);
      const { budget } = latestRepairBudget({ flowManager: restarted, specId: value.specId,
        attemptId: repairAttemptId,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" });
      assert.equal(budget.providerCallCount, 2);
    } finally { removeTmpDir(value.root); }
  });

  it("replays a published intermediate response when its transient handoff is lost", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated published response repository");
      const request = nextRequest(value, "lost-after-publication");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      const original = durableSnapshot(value.flowManager, value.specId);
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId: repairSelections(context)[0].unit.id,
        additionalRangeIds: ["background"],
      }));
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      await prepareSpecGateRepairService({ ctx: value.ctx, request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const published = value.flowManager.readCurrentStepSettlement({
        specId: value.specId, stepId: "spec-gate-repair" });
      assert.equal(published.result.kind, "spec-gate-repair-context-required");
      fs.rmSync(request.directory, { recursive: true });
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      const agent = { projectInvocation, async call(_prompt, options) {
        workerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const next = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const nextContext = requestInput(next, "spec-gate-repair-context.json").document;
        assert.notEqual(nextContext.batchDigest, context.batchDigest);
        fs.writeFileSync(requestPayloadPath(next, "spec-gate-repair.json"), workerArtifactJson(
          draftReturnProposal(nextContext, "Which validation target should the repair name?")));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: next.requestDigest });
      } };
      const repairAttemptId = restarted.canonicalState(value.specId).attempt.id;
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(workerCalls, 1, JSON.stringify(result));
      assert.equal(restarted.canonicalState(value.specId).current.at(-1), "draft");
      assert.equal(durableSnapshot(restarted, value.specId).spec, original.spec);
      const ledger = new SpecGateRepairProgressLedger({ flowManager: restarted,
        specId: value.specId, attemptId: repairAttemptId,
        baseRevision: context.baseRevision });
      assert.equal(ledger.entries.length, 2);
      assert.equal(ledger.entries[0].proposal.stage, "spec-gate-repair-context-request");
      assert.equal(ledger.entries[1].proposal.stage, "spec-gate-repair-draft-return");
      assert.equal(latestRepairBudget({ flowManager: restarted, specId: value.specId,
        attemptId: repairAttemptId,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 2);
    } finally { removeTmpDir(value.root); }
  });

  for (const [name, invalidate, expectedCode = "FLOW_SPEC_GATE_REPAIR_PROGRESS_MISMATCH"] of [
    ["missing locator", (saved) => { delete saved.executionLocator; }],
    ["missing plan", (saved) => { delete saved.plan; }],
    ["changed cost", (saved) => { saved.callCost.characters += 1; }],
    ["invalid nested cost", (saved) => {
      saved.plan.calls[0].callCost.instructionFootprint.total += 1;
      const { digest: _digest, ...unsigned } = saved.plan;
      saved.plan.digest = createHash("sha256").update(workerArtifactStableStringify(unsigned)).digest("hex");
    }],
    ["invalid locator action", (saved) => { saved.executionLocator.actionDigest = "invalid"; }],
    ["changed locator action", (saved) => {
      const current = saved.executionLocator.actionDigest;
      saved.executionLocator.actionDigest = (current[0] === "a" ? "b" : "a") + current.slice(1);
    }, "FLOW_DRAFT_EXECUTION_CLAIM_MISMATCH"],
    ["changed plan hash", (saved) => { saved.plan.digest = "0".repeat(64); }],
    ["invalid budget snapshot", (saved) => { saved.budget.aggregateCharacters = -1; }],
    ["missing action file digest", (saved) => { delete saved.actionFileDigest; }],
    ["missing action repository fingerprint", (saved) => { delete saved.actionRepositoryFingerprint; }],
    ["invalid action repository fingerprint", (saved) => { saved.actionRepositoryFingerprint = 42; }],
  ]) {
    it(`refuses a canonical checkpoint with ${name} after reload without charging or publishing`, async () => {
      const value = await createSpecGateRepairScenario();
      try {
        const request = nextRequest(value, `invalid-checkpoint-${name}`);
        const checkpoint = value.flowManager.checkpointDraftStepExecution.bind(value.flowManager);
        // Corrupt only serialized data at the producer's canonical write boundary.
        value.flowManager.checkpointDraftStepExecution = (input) => {
          const artifactWrites = input.artifactWrites.map((write) => {
            const saved = JSON.parse(write.bytes.toString("utf8"));
            invalidate(saved);
            return { ...write, bytes: Buffer.from(`${JSON.stringify(saved, null, 2)}\n`) };
          });
          checkpoint({ ...input, artifactWrites });
          throw new Error("interrupted after checkpoint publication");
        };
        assert.throws(() => reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
          prompt: JSON.stringify(request.toPromptReference()) }), /interrupted after checkpoint publication/);
        const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
          inWorktree: false, specId: value.specId });
        const before = durableSnapshot(restarted, value.specId);
        let providerCalls = 0;
        const dispatcher = new RunDispatchCommand({ agent: { projectInvocation,
          async call() { providerCalls += 1; throw new Error("invalid checkpoint cannot execute"); } } });
        await assert.rejects(() => dispatcher.runWorkerAttempt({ ...value.ctx,
          flowManager: restarted }, value.invocation), (error) => {
          assert.equal(error.code, expectedCode);
          assert.equal(error.data.failureKind, "step-admission");
          return true;
        });
        assert.equal(providerCalls, 0);
        assert.deepEqual(durableSnapshot(restarted, value.specId), before);
        assert.equal(artifactCount(before, "spec.gate.repair.progress"), 1);
      } finally { removeTmpDir(value.root); }
    });
  }

  for (const { title, method, phase, providerCallsBeforeRestart } of [
    { title: "resumes a committed checkpoint with its exact request and charges input once",
      method: "claimDraftStepExecution", phase: "checkpoint", providerCallsBeforeRestart: 0 },
    { title: "resumes a sealed claim after interrupted publication without another provider call",
      method: "settleSpecStepResult", phase: "claimed", providerCallsBeforeRestart: 1 },
  ]) {
    it(title, async () => {
      let interrupted = false;
      let interruptedRequestPath = null;
      const value = await createSpecGateRepairScenario();
      const originalOperation = FlowManager.prototype[method];
      const operationMock = mock.method(FlowManager.prototype, method, function (input) {
        if (input.binding.request?.executionRoot === value.root
          && input.binding.specId === value.specId && !interrupted
          && (phase === "checkpoint" || input.artifactWrites?.some((write) => write.parameters?.phase === "publication"))) {
          interrupted = true;
          interruptedRequestPath = input.binding.request.requestPath;
          throw new Error(`simulated interruption before ${method}`);
        }
        return originalOperation.call(this, input);
      });
      try {
        initGitRepo(value.root);
        fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
        commitAll(value.root, "Create isolated checkpoint resume repository");
        let workerCalls = 0;
        let workerRequest = null;
        const agent = { projectInvocation, async call(_prompt, options) {
          workerCalls += 1;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const stored = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          const context = requestInput(stored, "spec-gate-repair-context.json").document;
          fs.writeFileSync(requestPayloadPath(stored, "spec-gate-repair.json"), workerArtifactJson(
            draftReturnProposal(context, "Which exact target should the repair use?")));
          const sealed = sealWorkerArtifactHandoff({ requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
          const submission = JSON.parse(fs.readFileSync(sealed.handoffPath, "utf8"));
          workerRequest = { ...stored, requestDigest: submission.requestDigest };
          return JSON.stringify(sealed);
        } };
        const execute = async (manager) => {
          const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
          dispatcher.container = dispatchContainer({ root: value.root, flowManager: manager, agent });
          return dispatcher.execute({ ...value.ctx, flowManager: manager,
            flowState: manager.loadReadOnly(value.specId),
            expectBinding: FlowTargetBinding.capture({ flowState: manager.loadReadOnly(value.specId),
              mainRoot: value.root, authorityRoot: value.root }).serialize(),
            _envelopeType: "run", _envelopeKey: "dispatch" });
        };
        // Interrupt before transaction staging; journal faults are recoverable
        // transactions and can legitimately finish the saved claim themselves.
        if (phase === "checkpoint") {
          const interruptedResult = await execute(value.flowManager);
          assert.equal(interruptedResult.ok, false, JSON.stringify(interruptedResult));
          assert.ok(JSON.stringify(interruptedResult).includes(`simulated interruption before ${method}`));
        } else {
          await assert.rejects(() => execute(value.flowManager), (error) => {
            assert.ok(error instanceof StepPersistenceFailure);
            assert.equal(error.message, `simulated interruption before ${method}`);
            return true;
          });
        }
        assert.equal(interrupted, true);
        assert.equal(workerCalls, providerCallsBeforeRestart);
        assert.equal(fs.existsSync(interruptedRequestPath), true, interruptedRequestPath);
        const state = value.flowManager.canonicalState(value.specId);
        assert.equal(state.current.at(-1), "spec-gate-repair");
        assert.equal(state.attempt.failure, null);
        const lifecycle = value.flowManager.draftStepExecutionState({ binding: {
          runId: state.runId, specId: value.specId, stepId: "spec-gate-repair", attempt: state.attempt,
        } }).lifecycle;
        assert.equal(lifecycle.phase, phase);
        assert.equal(lifecycle.executionGeneration, 0);
        const saved = JSON.parse(value.flowManager.readArtifact({ specId: value.specId,
          logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
          parameters: { attemptId: state.attempt.id, generation: "0", phase },
        }).bytes.toString("utf8"));
        assert.equal(saved.budget.providerCallCount, providerCallsBeforeRestart);
        assert.equal(saved.budget.aggregateCharacters, saved.callCost.characters);
        assert.equal(saved.budget.aggregateItemCount, saved.callCost.items);
        const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
          inWorktree: false, specId: value.specId });
        const result = await execute(restarted);
        assert.equal(workerCalls, 1, JSON.stringify(result));
        for (const field of ["requestDigest", "inputDigest", "inputRevision"]) {
          assert.equal(workerRequest[field], saved[field]);
        }
        for (const field of ["dispatchInvocationId", "actionDigest", "generatedAt"]) {
          assert.equal(workerRequest[field], saved.executionLocator[field]);
        }
        assert.equal(restarted.canonicalState(value.specId).current.at(-1), "draft", JSON.stringify(result));
        const phases = restarted.activityLedger(value.specId).filter((entry) => (
          entry.result?.draftSettlementReceipt?.binding.stepId === "spec-gate-repair"
        ))
          .map((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle)
          .filter((entry) => entry != null);
        assert.deepEqual(phases.map((entry) => entry.phase), ["checkpoint", "claimed", "publication", "terminal"]);
        for (const entry of phases) {
          assert.equal(entry.binding.executionGeneration, 0);
          assert.equal(entry.binding.inputDigest, saved.inputDigest);
          assert.equal(entry.binding.inputRevision, saved.inputRevision);
          if (entry.phase !== "checkpoint") assert.deepEqual(entry.claim, saved.executionLocator);
        }
        const finalBudget = latestRepairBudget({ flowManager: restarted, specId: value.specId,
          attemptId: state.attempt.id, baseRevision: saved.context.baseRevision,
          consumerNodeId: "spec-gate-repair" }).budget.snapshot();
        const publication = JSON.parse(restarted.readArtifact({ specId: value.specId,
          logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
          parameters: { attemptId: state.attempt.id, generation: "0", phase: "publication" },
        }).bytes.toString("utf8"));
        assert.equal(finalBudget.providerCallCount, 1);
        assert.equal(finalBudget.synthesisCallCount, saved.budget.synthesisCallCount);
        assert.equal(finalBudget.aggregateCharacters, saved.callCost.characters + publication.responseCost.characters);
        assert.equal(finalBudget.aggregateItemCount, saved.callCost.items + publication.responseCost.items);
      } finally { operationMock.mock.restore(); removeTmpDir(value.root); }
    });
  }

  it("restores a sealed claimed response without another provider call", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const repairAttemptId = value.flowManager.canonicalState(value.specId).attempt.id;
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated claimed response repository");
      const request = nextRequest(value, "sealed-claim");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(
        draftReturnProposal(context, "Which target should the repair use?")));
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const before = latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
        attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      const agent = { projectInvocation, async call() { workerCalls += 1; throw new Error("sealed claim must not call provider again"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(restarted.canonicalState(value.specId).current.at(-1), "draft", JSON.stringify(result));
      assert.equal(workerCalls, 0);
      assert.equal(fs.existsSync(request.directory), false);
      assert.equal(latestRepairBudget({ flowManager: restarted, specId: value.specId,
        attemptId: repairAttemptId,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount,
      before.providerCallCount);
    } finally { removeTmpDir(value.root); }
  });

  it("finishes partial transient cleanup from a canonical completion receipt", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = nextRequest(value, "partial-cleanup");
      const requestBytes = fs.readFileSync(request.requestPath);
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      const completed = await completeWorkerResponse(value, request, {
        version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId: repairSelections(context)[0].unit.id,
        additionalRangeIds: ["background"],
      });
      assert.equal(completed.result.kind, "spec-gate-repair-context-required");
      assert.equal(fs.existsSync(request.directory), false);
      fs.mkdirSync(request.directory, { recursive: true });
      fs.writeFileSync(request.requestPath, requestBytes);
      const before = durableSnapshot(value.ctx.flowManager, value.specId);
      const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: value.ctx });
      assert.equal(recovered.cleanedHandoffs, 1);
      assert.equal(fs.existsSync(request.directory), false);
      assert.deepEqual(durableSnapshot(value.ctx.flowManager, value.specId), before);
      const next = nextRequest(value, "after-partial-cleanup");
      assert.notEqual(next.requestDigest, request.requestDigest);
    } finally { removeTmpDir(value.root); }
  });

  it("refuses an unsealed claimed response after restart without changing canonical progress", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated claimed response repository");
      const preview = await new GetNextActionCommand().execute({ ...value.ctx,
        flowState: value.flowManager.loadReadOnly(value.specId) });
      assert.equal(preview.directive.kind, "execute_step");
      const selectedBeforeClaim = specStepRegistration("spec-gate-repair").executionContract.select({
        ctx: value.ctx, stepId: "spec-gate-repair" });
      const request = nextRequest(value, "unsealed-claim");
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      const before = durableSnapshot(value.flowManager, value.specId);
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const projected = await new GetNextActionCommand().execute({ ...value.ctx,
        flowManager: restarted, flowState: restarted.loadReadOnly(value.specId) });
      assert.equal(projected.directive.kind, "blocked");
      assert.equal(projected.directive.code, "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE");
      assert.deepEqual(durableSnapshot(restarted, value.specId), before);
      let workerCalls = 0;
      const agent = { projectInvocation, async call() { workerCalls += 1; throw new Error("claimed response must not re-execute"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
      await assert.rejects(() => dispatcher.runWorkerAttempt({ ...value.ctx, flowManager: restarted },
        value.invocation), { code: "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE" });
      await assert.rejects(() => dispatcher.executeSelectedWorker(selectedBeforeClaim, {
        ctx: { ...value.ctx, flowManager: restarted }, invocation: value.invocation,
      }), { code: "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE" });
      assert.deepEqual(durableSnapshot(restarted, value.specId), before);
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(result.dispatch.boundary, "blocked");
      assert.equal(result.nextAction.directive.code, "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE");
      assert.equal(workerCalls, 0);
      assert.deepEqual(durableSnapshot(restarted, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("refuses a sealed response without its durable claim", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = nextRequest(value, "unclaimed-seal");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(
        draftReturnProposal(context, "Which target is intended?")));
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const before = durableSnapshot(value.flowManager, value.specId);
      await assert.rejects(prepareSpecGateRepairService({ ctx: value.ctx, request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator }),
      /exact durable worker claim/);
      assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("refuses a changed sealed response without publishing its proposal", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = nextRequest(value, "changed-seal");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(
        draftReturnProposal(context, "Which target is intended?")));
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const before = durableSnapshot(value.flowManager, value.specId);
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(
        draftReturnProposal(context, "A different target?")));
      await assert.rejects(prepareSpecGateRepairService({ ctx: value.ctx, request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator }),
      /handoff|payload|sealed/i);
      assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("rejects a direct same-generation settlement without a completion receipt", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = nextRequest(value, "direct-settlement-bypass");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId: repairSelections(context)[0].unit.id,
        additionalRangeIds: ["background"],
      }));
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const binding = await new SpecEntryConnector(request).connect();
      const service = await prepareSpecGateRepairService({ ctx: value.ctx, request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const before = durableSnapshot(value.flowManager, value.specId);
      const result = value.flowManager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).result;
      assert.throws(() => value.flowManager.settleDraftStepResult({
        binding: binding, stepResult: result,
        settlement: settleSpecStepResult("spec-gate-repair", result),
      }), /completion must publish one exact generation receipt/);
      const publication = value.flowManager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt;
      const generation = publication.executionLifecycle.binding.executionGeneration;
      const malformed = { version: 0, phase: "completed", runId: binding.runId,
        specId: value.specId, attemptId: binding.attempt.id,
        attemptSequence: binding.attempt.sequence, generation,
        publicationReceiptId: publication.id,
        requestDigest: publication.executionLifecycle.claim.requestDigest,
        resultKind: result.kind };
      assert.throws(() => value.flowManager.settleDraftStepResult({
        binding: binding, stepResult: result,
        settlement: settleSpecStepResult("spec-gate-repair", result),
        artifactWrites: [{ logicalKey: "spec.gate.repair.progress",
          parameters: { attemptId: binding.attempt.id, generation: String(generation),
            phase: "completed" }, mediaType: "application/json",
          bytes: Buffer.from(JSON.stringify(malformed)) }],
      }), /completion must publish one exact generation receipt/);
      assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("rejects a changed publication on exact completion replay", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = nextRequest(value, "changed-completion-replay");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      const binding = await new SpecEntryConnector(request).connect();
      const completed = await completeWorkerResponse(value, request, {
        version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId: repairSelections(context)[0].unit.id,
        additionalRangeIds: ["background"],
      });
      const manager = value.ctx.flowManager;
      const generation = manager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt.executionLifecycle.binding.executionGeneration;
      const marker = manager.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
        parameters: { attemptId: binding.attempt.id,
          generation: String(generation), phase: "completed" } });
      const before = durableSnapshot(manager, value.specId);
      const repeated = manager.completeSpecGateRepairProgress({
        binding: binding, stepResult: completed.result,
        settlement: settleSpecStepResult("spec-gate-repair", completed.result),
        publicationReceipt: completed.publicationReceipt,
      });
      assert.equal(repeated.newlyCompleted, false);
      assert.equal(repeated.receipt.id, manager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt.id);
      assert.deepEqual(durableSnapshot(manager, value.specId), before);
      const replay = manager.settleDraftStepResult({
        binding: binding, stepResult: completed.result,
        settlement: settleSpecStepResult("spec-gate-repair", completed.result),
        artifactWrites: [{ logicalKey: "spec.gate.repair.progress",
          parameters: { attemptId: binding.attempt.id,
            generation: String(generation), phase: "completed" },
          mediaType: "application/json", bytes: marker.bytes }],
      });
      assert.equal(replay.receipt.id, manager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt.id);
      assert.deepEqual(durableSnapshot(manager, value.specId), before);
      assert.throws(() => manager.settleDraftStepResult({
        binding: binding, stepResult: completed.result,
        settlement: settleSpecStepResult("spec-gate-repair", completed.result),
        specRecord: { changed: "This is not the completed publication" },
        artifactWrites: [{ logicalKey: "spec.gate.repair.progress",
          parameters: { attemptId: binding.attempt.id,
            generation: String(generation), phase: "completed" },
          mediaType: "application/json", bytes: marker.bytes }],
      }), /completion must publish one exact generation receipt/);
      assert.deepEqual(durableSnapshot(manager, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("continues multiple atomic repair units through a reloaded dispatcher", async () => {
    const value = await createSpecGateRepairScenario({ additionalObservations: [{
      failureMode: "guardrail-violation", requirementRef: "R1",
      where: { file: "spec.json", locator: "background" },
      observed: "The background needs a bounded correction.",
      targets: [{ entity: "spec", field: "background" }],
      allowedTargets: [{ target: { entity: "spec", field: "background" },
        operationKinds: ["edit-text-field"] }],
    }] });
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated multiple-unit repair repository");
      const first = nextRequest(value, "multiple-units-first");
      const context = first.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(repairSelections(context).length, 2);
      const firstUnit = repairSelections(context).find((selection) => (
        selection.ranges.some((range) => range.id === "requirements[R1].desc")
      ));
      const initial = durableSnapshot(value.flowManager, value.specId);
      const completed = await completeWorkerResponse(value, first, {
        version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId: firstUnit.unit.id,
        additionalRangeIds: ["background"],
      });
      assert.equal(completed.result.kind, "spec-gate-repair-context-required");
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      const agent = { projectInvocation, async call(_prompt, options) {
        workerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const selected = requestInput(request, "spec-gate-repair-context.json").document;
        assert.equal(selected.mode, "repair");
        assert.equal(repairSelections(selected).length, 2);
        const groups = repairSelections(selected).map((selection) => {
          const range = selection.ranges.find((entry) => entry.writable
            && ["requirements[R1].desc", "background"].includes(entry.id));
          assert.ok(range);
          const replacement = range.id === "background"
            ? "The canonical repair is bounded to the published findings."
            : "Publish a precisely validated artifact.";
          return { findingIdentities: selection.unit.findings.map((finding) => finding.identity),
            operations: [{ kind: "edit-text-field", target: range.target,
              expectedDigest: range.digest, edits: [{ startByte: 0,
                endByte: Buffer.byteLength(range.value, "utf8"), replacement }],
              reason: "Correct this exact Gate finding using its selected range." }] };
        });
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
          version: 1, stage: "spec-gate-repair", baseRevision: selected.baseRevision, groups,
        }));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(workerCalls, 1, JSON.stringify(result));
      assert.equal(result.data?.nextAction?.step, "spec-review", JSON.stringify(result));
      const audit = restarted.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.audit", consumerNodeId: "spec-review",
        parameters: { attemptId: restarted.activityLedger(value.specId).findLast((entry) => (
          entry.nodeId === "spec-gate-repair" && entry.result?.stepResult?.kind === "spec-gate-repair-review-required"
        )).attemptId } });
      assert.equal(JSON.parse(audit.bytes.toString("utf8")).acceptedGroups.length, 2);
      assert.equal(artifactCount(durableSnapshot(restarted, value.specId), "spec.snapshot"),
        artifactCount(initial, "spec.snapshot") + 1);
    } finally { removeTmpDir(value.root); }
  });

  it("preserves the complete oversized selected unit across sealed restart and one atomic repair", async () => {
    const specRecord = oversizedSpec();
    const value = await createSpecGateRepairScenario({ specRecord });
    try {
      const original = durableSnapshot(value.flowManager, value.specId);
      const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
      const request = nextRequest(value, "complete-file");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(context.mode, "repair");
      assert.equal(context.batchCount, 1);
      const selection = repairSelections(context)[0];
      const decisionRanges = selection.ranges.filter((range) => range.id.startsWith("overview.decisions["));
      assert.equal(decisionRanges.length, specRecord.overview.decisions.length);
      for (const range of decisionRanges) {
        assert.deepEqual(range.value, specRecord.overview.decisions[Number(range.id.match(/\[(\d+)\]/)[1])]);
      }
      const writable = selection.ranges.find((range) => range.writable);
      const proposal = { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
        groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity),
          operations: [{ kind: "edit-text-field", target: writable.target, expectedDigest: writable.digest,
            edits: [{ startByte: 0, endByte: Buffer.byteLength(writable.value),
              replacement: "Publish a precisely validated artifact." }], reason: "Clarify the full selected obligation." }] }] };
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
      reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request, prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
      assert.equal(durableSnapshot(value.flowManager, value.specId).spec, original.spec);
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root, inWorktree: false, specId: value.specId });
      value.ctx.flowManager = restarted;
      const restored = value.coordinator.restoreClaimedDraftRequest({ ctx: value.ctx,
        state: restarted.canonicalState(value.specId), lifecycle: restarted.draftStepExecutionState({ binding: {
          runId: request.runId, specId: value.specId, stepId: "spec-gate-repair",
          attempt: restarted.canonicalState(value.specId).attempt } }).lifecycle });
      const service = await prepareSpecGateRepairService({ ctx: value.ctx, request: restored,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const result = await new SpecGateRepairStep(service).execute();
      assert.equal(result.kind, "spec-gate-repair-review-required");
      assertOneTerminalPublication(restarted, value.specId, original);
      assert.equal(latestRepairBudget({ flowManager: restarted, specId: value.specId, attemptId,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 1);
    } finally { removeTmpDir(value.root); }
  });

  it("publishes an additional read and a user decision without minting edit authority", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const repairAttemptId = value.flowManager.canonicalState(value.specId).attempt.id;
      const before = durableSnapshot(value.flowManager, value.specId);
      const first = nextRequest(value, 0);
      const initial = first.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(initial.mode, "repair");
      const unitId = repairSelections(initial)[0].unit.id;
      assert.equal(repairSelections(initial)[0].ranges.some((range) => range.id === "background"), false);
      const extra = await completeWorkerResponse(value, first, { version: 1,
        stage: "spec-gate-repair-context-request", baseRevision: initial.baseRevision,
        unitId, additionalRangeIds: ["background"] });
      assert.equal(extra.result.kind, "spec-gate-repair-context-required");
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      value.ctx.flowManager = restarted;
      const second = nextRequest(value, 1);
      const expanded = second.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(expanded.mode, "repair");
      assert.notEqual(expanded.batchDigest, initial.batchDigest);
      const readOnly = repairSelections(expanded)[0].ranges.find((range) => range.id === "background");
      assert.equal(readOnly.value, "The worker cannot write canonical Flow artifacts.");
      assert.equal(readOnly.writable, false);
      const decision = await completeWorkerResponse(value, second,
        draftReturnProposal(expanded, "Which planned validation target should the requirement name?"));
      assert.equal(decision.result.kind, "spec-gate-repair-draft-return-required");
      const ledger = new SpecGateRepairProgressLedger({ flowManager: value.ctx.flowManager,
        specId: value.specId, attemptId: repairAttemptId,
        baseRevision: expanded.baseRevision });
      assert.deepEqual(ledger.entries.map((entry) => entry.proposal.stage),
        ["spec-gate-repair-context-request", "spec-gate-repair-draft-return"]);
      assert.equal(ledger.groups().length, 0);
      const { budget } = latestRepairBudget({ flowManager: value.ctx.flowManager, specId: value.specId,
        attemptId: repairAttemptId,
        baseRevision: expanded.baseRevision, consumerNodeId: "spec-gate-repair" });
      assert.equal(budget.providerCallCount, 2);
      const after = durableSnapshot(restarted, value.specId);
      assert.equal(after.spec, before.spec);
      assert.equal(artifactCount(after, "spec.snapshot"), artifactCount(before, "spec.snapshot"));
      const next = await new GetNextActionCommand().execute({ ...value.ctx,
        flowState: restarted.loadReadOnly(value.specId), flowResolutionError: null });
      assert.equal(next.directive.kind, "execute_step");
      assert.equal(restarted.canonicalState(value.specId).current.at(-1), "draft");
    } finally { removeTmpDir(value.root); }
  });

  for (const mode of ["context", "draft-return", "repair"]) {
    it(`dispatches a published ${mode} response after restart without another provider call`, async () => {
      const value = await createSpecGateRepairScenario();
      try {
        initGitRepo(value.root);
        fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
        commitAll(value.root, "Create isolated repair replay repository");
        const request = nextRequest(value, `interrupted-${mode}`);
        const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
        assert.equal(context.mode, "repair");
        const selection = repairSelections(context)[0];
        const range = selection.ranges.find((entry) => entry.writable);
        const proposal = mode === "context" ? { version: 1, stage: "spec-gate-repair-context-request",
          baseRevision: context.baseRevision, unitId: selection.unit.id, additionalRangeIds: ["background"] }
          : mode === "draft-return"
            ? draftReturnProposal(context, "Which validation target is intended?")
            : { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
              groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity),
                operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
                  edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value),
                    replacement: "Publish a precisely validated artifact." }], reason: "Clarify the exact finding." }] }] };
        fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
        reserveSpecGateRepairWorkerCall({ ctx: value.ctx, request,
          prompt: JSON.stringify(request.toPromptReference()) });
        sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
        await prepareSpecGateRepairService({ ctx: value.ctx, request,
          Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
        const before = durableSnapshot(value.flowManager, value.specId);
        const attemptId = value.flowManager.canonicalState(value.specId).attempt.id;
        const budgetInput = { specId: value.specId, attemptId,
          baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" };
        const savedBudget = latestRepairBudget({ ...budgetInput, flowManager: value.flowManager }).budget.snapshot();
        assert.equal(savedBudget.providerCallCount, 1);
        const publicationReceipt = value.flowManager.readCurrentStepSettlement({
          specId: value.specId, stepId: "spec-gate-repair" }).receipt.id;
        const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
          inWorktree: false, specId: value.specId });
        let workerCalls = 0;
        const agent = { projectInvocation, async call() { workerCalls += 1; throw new Error("published response must replay"); } };
        const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
        dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
        const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
          flowState: restarted.loadReadOnly(value.specId),
          expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
            mainRoot: value.root, authorityRoot: value.root }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch" });
        assert.equal(workerCalls, 0, JSON.stringify(result));
        assert.equal(fs.existsSync(request.directory), false, JSON.stringify(result));
        assert.deepEqual(latestRepairBudget({ ...budgetInput, flowManager: restarted }).budget.snapshot(), savedBudget);
        const after = durableSnapshot(restarted, value.specId);
        assert.equal(artifactCount(after, "spec.gate.repair.progress"),
          artifactCount(before, "spec.gate.repair.progress") + (mode === "context" ? 1 : 0));
        const ledger = new SpecGateRepairProgressLedger({ flowManager: restarted,
          specId: value.specId, attemptId, baseRevision: context.baseRevision });
        assert.equal(ledger.entries.length, 1);
        assert.deepEqual(ledger.entries[0].proposal, proposal);
        if (mode === "context") {
          const settled = restarted.readCurrentStepSettlement({ specId: value.specId,
            stepId: "spec-gate-repair" });
          const completion = restarted.readArtifact({ specId: value.specId,
            logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
            parameters: { attemptId, generation: "0", phase: "completed" } });
          assert.equal(JSON.parse(completion.bytes.toString("utf8")).publicationReceiptId, publicationReceipt);
          assert.equal(completion.descriptor.activityId, settled.activityId);
          assert.notEqual(settled.receipt.id, publicationReceipt);
          assert.equal(after.spec, before.spec);
          let nextContext = null;
          const nextAgent = { projectInvocation, async call(_prompt, options) {
            workerCalls += 1;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const following = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            nextContext = requestInput(following, "spec-gate-repair-context.json").document;
            const response = draftReturnProposal(nextContext, "Which target should this repair use?");
            fs.writeFileSync(requestPayloadPath(following, "spec-gate-repair.json"), workerArtifactJson(response));
            sealWorkerArtifactHandoff({ requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
            return JSON.stringify({ sealed: true, requestDigest: following.requestDigest });
          } };
          const nextDispatcher = new RunDispatchCommand({ agent: nextAgent, maxDispatches: 1 });
          nextDispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent: nextAgent });
          const nextResult = await nextDispatcher.execute({ ...value.ctx, flowManager: restarted,
            flowState: restarted.loadReadOnly(value.specId),
            expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
              mainRoot: value.root, authorityRoot: value.root }).serialize(),
            _envelopeType: "run", _envelopeKey: "dispatch" });
          assert.equal(workerCalls, 1, JSON.stringify(nextResult));
          assert.notEqual(nextContext.batchDigest, context.batchDigest);
          assert.equal(repairSelections(nextContext)[0].ranges.find((range) => range.id === "background").writable, false);
          const afterNewClaim = durableSnapshot(restarted, value.specId);
          assert.throws(() => request.assertCurrent(restarted.loadReadOnly(value.specId)),
            { code: "FLOW_ARTIFACT_HANDOFF_STALE" });
          assert.deepEqual(durableSnapshot(restarted, value.specId), afterNewClaim);
          assert.equal(latestRepairBudget({ ...budgetInput, flowManager: restarted }).budget.providerCallCount, 2);
        } else if (mode === "draft-return") {
          assert.equal(restarted.canonicalState(value.specId).current.at(-1), "draft");
          assert.equal(after.spec, before.spec);
        } else assertOneTerminalPublication(restarted, value.specId, before);
      } finally { removeTmpDir(value.root); }
    });
  }

  it("recovers an interrupted State write without a torn canonical Spec publication", async () => {
    let armed = false;
    let interrupted = false;
    const value = await createSpecGateRepairScenario({
      versionStoreFaultInjector({ phase, activity }) {
        if (armed && !interrupted && phase === "state-written"
          && activity?.nodeId === "spec-gate-repair"
          && activity.result?.stepResult?.kind === "spec-gate-repair-review-required") {
          interrupted = true;
          throw new Error("simulated interruption inside Spec publication");
        }
      },
    });
    try {
      const { service } = await prepareSpecGateRepairHandoff({ ctx: value.ctx,
        invocation: value.invocation, coordinator: value.coordinator,
        replacement: "Publish a precisely validated artifact." });
      const before = durableSnapshot(value.flowManager, value.specId);
      armed = true;
      let failure = null;
      try {
        await new StepFactory().provide(SpecGateRepairService, service)
          .create(SpecGateRepairStep).execute();
      } catch (error) { failure = error; }
      assert.equal(interrupted, true);
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      if (failure !== null) {
        assert.ok(failure instanceof StepPersistenceFailure);
        assert.deepEqual(durableSnapshot(restarted, value.specId), before);
        const state = restarted.canonicalState(value.specId);
        const lifecycle = restarted.draftStepExecutionState({ binding: {
          runId: state.runId, specId: value.specId,
          stepId: "spec-gate-repair", attempt: state.attempt,
        } }).lifecycle;
        assert.equal(lifecycle.phase, "publication");
        const restoredRequest = value.coordinator.restoreClaimedDraftRequest({
          ctx: { ...value.ctx, flowManager: restarted },
          state: restarted.load(value.specId), lifecycle,
        });
        assert.ok(restoredRequest);
        const resumed = await prepareSpecGateRepairService({
          ctx: { ...value.ctx, flowManager: restarted }, request: restoredRequest,
          Connector: SpecEntryConnector, handoffCoordinator: value.coordinator,
        });
        const retried = await new StepFactory().provide(SpecGateRepairService, resumed)
          .create(SpecGateRepairStep).execute();
        assert.equal(retried.kind, "spec-gate-repair-review-required");
        const { budget: savedBudget } = latestRepairBudget({ flowManager: restarted,
          specId: value.specId, attemptId: state.attempt.id,
          baseRevision: restoredRequest.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document.baseRevision,
          consumerNodeId: "spec-gate-repair" });
        assert.equal(savedBudget.providerCallCount, 1);
      }
      assertOneTerminalPublication(restarted, value.specId, before);
    } finally { removeTmpDir(value.root); }
  });
});
