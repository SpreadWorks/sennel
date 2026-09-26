import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { settleSpecStepResult } from "../../../src/flow/definition.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { latestRepairBudget, SpecGateRepairProgressLedger } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { readProgressBoundSpecGateRepairInput,
  SPEC_GATE_REPAIR_REQUEST_LIMIT } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { nextSpecGateRepairEvidence } from "../../../src/flow/lib/spec-gate-repair-evidence.js";
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
  SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
    prompt: JSON.stringify(request.toPromptReference()) });
  sealWorkerArtifactHandoff({ requestPath: request.requestPath,
    invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z") });
  await SpecGateRepairService.prepare({ ctx: value.ctx, request,
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
  const service = await SpecGateRepairService.prepare({ ctx: value.ctx, request: restored,
    Connector: SpecEntryConnector, handoffCoordinator: coordinator });
  assert.deepEqual(durableSnapshot(value.ctx.flowManager, value.specId), beforeReplay);
  const result = await new StepFactory().provide(SpecGateRepairService, service)
    .create(SpecGateRepairStep).execute();
  return { service, result };
}

describe("Spec Gate repair restart boundaries", () => {
  it("reserves one correction call after known location batches at the exact budget edge", async () => {
    for (const findingCount of [15, 16]) {
      const value = await createSpecGateRepairScenario({ locator: "unresolved location 0",
        additionalObservations: Array.from({ length: findingCount - 1 }, (_, index) => ({
          kind: "violation", failureMode: "guardrail-violation", requirementRef: "R1",
          where: { file: "spec.json", locator: `unresolved location ${index + 1}` },
          observed: `The separate validation detail ${index + 1} needs a bounded correction.`,
          severity: "blocking", refs: ["R1"],
        })) });
      try {
        const progress = readProgressBoundSpecGateRepairInput({ flowManager: value.flowManager,
          state: value.flowManager.canonicalState(value.specId), executionRoot: value.root });
        assert.equal(progress.locationPlan.batches.length, findingCount);
        const request = nextRequest(value, `location-budget-${findingCount}`);
        const before = durableSnapshot(value.flowManager, value.specId);
        const prompt = JSON.stringify(request.toPromptReference());
        if (findingCount === 16) {
          assert.throws(() => SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request, prompt }),
            { code: "PROMPT_BATCH_COUNT_EXCEEDED" });
          assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
        } else {
          SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request, prompt });
          assert.equal(latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
            attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
            baseRevision: progress.source.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 1);
        }
      } finally { removeTmpDir(value.root); }
    }
  });

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
        const selectedIds = new Set(selected.selections[0].ranges.map((range) => range.id));
        const extra = source.context.tableOfContents().find((range) => !selectedIds.has(range.id));
        assert(extra, "each provider response must request new canonical context");
        return { request, selected, proposal: { version: 1, stage: "spec-gate-repair-context-request",
          baseRevision: selected.baseRevision, unitId: selected.selections[0].unit.id,
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
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request: final.request,
        prompt: JSON.stringify(final.request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: final.request.requestPath,
        invocationId: final.request.dispatchInvocationId });
      await SpecGateRepairService.prepare({ ctx: value.ctx, request: final.request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const budgetInput = { specId: value.specId,
        attemptId: value.ctx.flowManager.canonicalState(value.specId).attempt.id,
        baseRevision: final.selected.baseRevision, consumerNodeId: "spec-gate-repair" };
      assert.equal(latestRepairBudget({ ...budgetInput, flowManager: value.ctx.flowManager }).budget.providerCallCount, 16);
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      const restartedCtx = { ...value.ctx, flowManager: restarted };
      const replay = await SpecGateRepairService.resumePublished({ ctx: restartedCtx,
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
      assert.throws(() => SpecGateRepairService.reserveWorkerCall({ ctx: restartedCtx,
        request: following, prompt: JSON.stringify(following.toPromptReference()) }),
      { code: "PROMPT_CALL_LIMIT_EXCEEDED" });
      assert.deepEqual(durableSnapshot(restarted, value.specId), before);
      assert.equal(latestRepairBudget({ ...budgetInput, flowManager: restarted }).budget.providerCallCount, 16);
    } finally { removeTmpDir(value.root); }
  });

  it("treats an empty location response as completed coverage and awaits a decision", async () => {
    const value = await createSpecGateRepairScenario({ locator: "an unclear validation location" });
    try {
      const request = nextRequest(value, "empty-location");
      const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(selected.mode, "locate");
      assert.equal(selected.batchCount, 1);
      const { result } = await completeWorkerResponse(value, request, {
        version: 1, stage: "spec-gate-repair-locate", baseRevision: selected.baseRevision,
        locations: [{ identity: selected.finding.identity, rangeIds: [] }],
      });
      assert.equal(result.kind, "spec-gate-repair-awaiting-decision");
      const ledger = new SpecGateRepairProgressLedger({ flowManager: value.ctx.flowManager,
        specId: value.specId, attemptId: value.ctx.flowManager.canonicalState(value.specId).attempt.id,
        baseRevision: selected.baseRevision });
      assert.equal(ledger.completedLocations.length, 0);
      assert.deepEqual(ledger.entries[0].proposal.locations[0].rangeIds, []);
    } finally { removeTmpDir(value.root); }
  });

  it("resumes three historical completed ordinal locate generations with their spent budget", async () => {
    const root = historicalRepairSeed("ordinal");
    const specId = "901-historical-ordinal-locate";
    try {
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const state = flowManager.canonicalState(specId);
      const progress = readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot: root });
      assert.equal(progress.ledger.completedLocations.length, 3);
      assert.equal(progress.source.context.unresolvedFindings().length, 0);
      assert.equal(progress.locationPlan, null);
      const budgetInput = { flowManager, specId, attemptId: state.attempt.id,
        baseRevision: progress.source.baseRevision, consumerNodeId: "spec-gate-repair" };
      assert.equal(latestRepairBudget(budgetInput).budget.providerCallCount, 3);
      const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
      const coordinator = new WorkerArtifactHandoffCoordinator();
      const request = coordinator.createRequest({ ctx, state: flowManager.load(specId),
        invocation: { id: "historical-ordinal-continuation", target: { digest: "b".repeat(64) },
          action: { digest: "a".repeat(64), nextAction: { step: "spec-gate-repair" } } } });
      const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(selected.mode, "evidence");
      const work = nextSpecGateRepairEvidence({ context: progress.source.context,
        unitId: selected.unitId, limit: SPEC_GATE_REPAIR_REQUEST_LIMIT,
        publications: progress.ledger.entries, executionBudget: latestRepairBudget(budgetInput).budget });
      const value = { root, specId, flowManager, ctx, coordinator };
      const { result } = await completeWorkerResponse(value, request, {
        version: 1, stage: "spec-gate-repair-evidence", baseRevision: selected.baseRevision,
        unitId: selected.unitId,
        observations: work.batch.payloadElements.map((element) => ({
          requirementId: selected.unitId, sourceRef: element.id,
          support: ["The canonical requirement remains selected."], contradictions: [], unresolved: [],
        })),
      });
      assert.equal(result.kind, "spec-gate-repair-context-required");
      assert.equal(latestRepairBudget({ ...budgetInput, flowManager: value.ctx.flowManager }).budget.providerCallCount, 4);
    } finally { removeTmpDir(root); }
  });

  it("keeps mixed historical locate batches bound to their old plan", () => {
    const root = historicalRepairSeed("mixed");
    const specId = "902-historical-mixed-locate";
    try {
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const state = flowManager.canonicalState(specId);
      const progress = readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot: root });
      assert.equal(progress.ledger.completedLocations.length, 3);
      assert.equal(progress.source.context.unresolvedFindings().length, 11);
      assert.equal(progress.locationPlan.batches.length, 22);
      assert.equal(progress.ledger.completedLocationBatches(progress.locationPlan).length, 0);
      const before = durableSnapshot(flowManager, specId);
      const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
      const coordinator = new WorkerArtifactHandoffCoordinator();
      const request = coordinator.createRequest({ ctx, state: flowManager.load(specId),
        invocation: { id: "historical-mixed-continuation", target: { digest: "b".repeat(64) },
          action: { digest: "a".repeat(64), nextAction: { step: "spec-gate-repair" } } } });
      const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(selected.mode, "locate");
      assert.equal(selected.batchCount, 22);
      assert.equal(selected.batchIndex, 0);
      assert.notEqual(selected.batchDigest, progress.ledger.completedLocations[0].context.batchDigest);
      assert.throws(() => SpecGateRepairService.reserveWorkerCall({ ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) }), { code: "PROMPT_BATCH_COUNT_EXCEEDED" });
      assert.deepEqual(durableSnapshot(flowManager, specId), before);
      assert.equal(latestRepairBudget({ flowManager, specId, attemptId: state.attempt.id,
        baseRevision: progress.source.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 3);
    } finally { removeTmpDir(root); }
  });

  it("does not reuse equal-count historical locations when their batch digests differ", async () => {
    const root = historicalRepairSeed("equal-count");
    const specId = "903-historical-equal-count-locate";
    try {
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const state = flowManager.canonicalState(specId);
      const progress = readProgressBoundSpecGateRepairInput({ flowManager, state, executionRoot: root });
      assert.equal(progress.source.context.unresolvedFindings().length, 1);
      assert.equal(progress.ledger.completedLocations.length, 2);
      assert.equal(progress.locationPlan.batches.length, 2);
      assert.equal(progress.ledger.completedLocationBatches(progress.locationPlan).length, 0);
      const ctx = { root, mainRoot: root, executionRoot: root, specId, flowManager };
      const coordinator = new WorkerArtifactHandoffCoordinator();
      const request = coordinator.createRequest({ ctx, state: flowManager.load(specId),
        invocation: { id: "historical-equal-count-continuation", target: { digest: "b".repeat(64) },
          action: { digest: "a".repeat(64), nextAction: { step: "spec-gate-repair" } } } });
      const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(selected.mode, "locate");
      assert.equal(selected.batchIndex, 0);
      assert.equal(selected.batchCount, 2);
      assert.notEqual(selected.batchDigest, progress.ledger.completedLocations[0].context.batchDigest);
      const value = { root, specId, flowManager, ctx, coordinator };
      const { result } = await completeWorkerResponse(value, request, {
        version: 1, stage: "spec-gate-repair-locate", baseRevision: selected.baseRevision,
        locations: [{ identity: selected.finding.identity, rangeIds: [] }],
      });
      assert.equal(result.kind, "spec-gate-repair-context-required");
      const resumed = readProgressBoundSpecGateRepairInput({ flowManager: value.ctx.flowManager,
        state: value.ctx.flowManager.canonicalState(specId), executionRoot: root });
      assert.equal(resumed.ledger.completedLocationBatches(resumed.locationPlan).length, 1);
      assert.equal(resumed.source.context.unresolvedFindings().length, 1);
      assert.equal(latestRepairBudget({ flowManager: value.ctx.flowManager, specId,
        attemptId: value.ctx.flowManager.canonicalState(specId).attempt.id,
        baseRevision: selected.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 3);
    } finally { removeTmpDir(root); }
  });

  it("preserves an exact claimed locate handoff's stale error when its plan is current", async () => {
    const value = await createSpecGateRepairScenario({ locator: "unresolved free-text location" });
    try {
      const request = value.coordinator.createRequest({ ctx: value.ctx,
        state: value.flowManager.load(value.specId), invocation: value.invocation });
      const selected = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(selected.mode, "locate");
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      const stale = new WorkerArtifactHandoffError("stale", "FLOW_ARTIFACT_HANDOFF_STALE",
        "worker artifact handoff input digest or revision is stale", { recoveryPossible: false });
      const before = durableSnapshot(value.flowManager, value.specId);
      await assert.rejects(() => SpecGateRepairService.prepare({ ctx: value.ctx, request,
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

  it("rejects an impossible location plan before a provider claim with a typed budget failure", async () => {
    const specRecord = validWorkerHandoffSpec();
    specRecord.overview.decisions = Array.from({ length: 700 }, (_, index) => ({
      text: `Distinct canonical design decision ${index} for the bounded lookup index.`,
    }));
    const additionalObservations = Array.from({ length: 12 }, (_, index) => ({
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R1",
      where: { file: "spec.json", locator: `unresolved location ${index}` },
      observed: `The missing validation detail ${index} needs a bounded correction.`,
      severity: "blocking", refs: ["R1"],
    }));
    const value = await createSpecGateRepairScenario({ specRecord,
      locator: "unresolved location 12", additionalObservations });
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated repair budget repository");
      const progress = readProgressBoundSpecGateRepairInput({ flowManager: value.flowManager,
        state: value.flowManager.canonicalState(value.specId), executionRoot: value.root });
      assert(progress.locationPlan.batches.length > 16);
      const before = durableSnapshot(value.flowManager, value.specId);
      let providerCalls = 0;
      const agent = { async call() { providerCalls += 1; throw new Error("provider call is outside the plan budget"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
      const result = await dispatcher.execute({ ...value.ctx,
        flowState: value.flowManager.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: value.flowManager.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(result.errors?.[0]?.code, "PROMPT_BATCH_COUNT_EXCEEDED", JSON.stringify(result));
      assert.equal(typeof result.data?.dispatch?.binding, "string");
      assert.equal(result.data?.batchCount, progress.locationPlan.batches.length + 1);
      assert.equal(result.data?.maxBatchCount, 16);
      assert.equal(providerCalls, 0);
      assert.deepEqual(durableSnapshot(value.flowManager, value.specId), before);
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
        const agent = { async call(_prompt, options) {
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
            const selectedIds = new Set(selected.selections[0].ranges.map((range) => range.id));
            const extra = source.context.tableOfContents().find((range) => !selectedIds.has(range.id));
            assert(extra, "four distinct additional ranges are available");
            return { version: 1, stage: "spec-gate-repair-context-request",
              baseRevision: selected.baseRevision, unitId: selected.selections[0].unit.id,
              additionalRangeIds: [extra.id] };
          })() : { version: 1, stage: "spec-gate-repair-user-input",
            baseRevision: selected.baseRevision, question: "Which exact acceptance condition is intended?" };
          fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson(proposal));
          sealWorkerArtifactHandoff({ requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
          generations.push({ requestDigest: request.requestDigest, proposal });
          return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
        } };
        const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 7, maxStalledDispatches,
          repositoryFingerprint: () => "f".repeat(64) });
        dispatcher.container = dispatchContainer({ root: value.root, flowManager: value.flowManager, agent });
        const result = await dispatcher.execute({ ...value.ctx,
          flowState: value.flowManager.loadReadOnly(value.specId),
          expectBinding: FlowTargetBinding.capture({ flowState: value.flowManager.loadReadOnly(value.specId),
            mainRoot: value.root, authorityRoot: value.root }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch" });
        assert.equal(result.dispatch?.boundary, "await_user_decision", JSON.stringify(result));
        assert.equal(generations.length, 5, JSON.stringify(result));
        const ledger = new SpecGateRepairProgressLedger({ flowManager: value.flowManager,
          specId: value.specId, attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
          baseRevision });
        assert.equal(ledger.entries.length, 5);
        const activities = value.flowManager.activityLedger(value.specId);
        for (const entry of ledger.entries.slice(0, 4)) {
          const completion = value.flowManager.readArtifact({ specId: value.specId,
            logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
            parameters: { attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
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
          attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
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
      const firstAgent = { async call(_prompt, options) {
        firstWorkerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        firstRequestDirectory = path.dirname(requestPath);
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        context = requestInput(request, "spec-gate-repair-context.json").document;
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
          version: 1, stage: "spec-gate-repair-context-request",
          baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
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
      const agent = { async call(_prompt, options) {
        workerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        nextContext = requestInput(request, "spec-gate-repair-context.json").document;
        fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
          version: 1, stage: "spec-gate-repair-user-input",
          baseRevision: nextContext.baseRevision,
          question: "Which validation target should the repair name?",
        }));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: firstResult.data.dispatch.binding,
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(workerCalls, 1, JSON.stringify(result));
      assert.equal(nextContext.mode, "repair");
      assert.notEqual(nextContext.batchDigest, context.batchDigest);
      assert.equal(result.dispatch?.boundary, "await_user_decision");
      assert.equal(durableSnapshot(restarted, value.specId).spec, initialSpec);
      const { budget } = latestRepairBudget({ flowManager: restarted, specId: value.specId,
        attemptId: restarted.canonicalState(value.specId).attempt.id,
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
        baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
        additionalRangeIds: ["background"],
      }));
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      await SpecGateRepairService.prepare({ ctx: value.ctx, request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const published = value.flowManager.readCurrentStepSettlement({
        specId: value.specId, stepId: "spec-gate-repair" });
      assert.equal(published.result.kind, "spec-gate-repair-context-required");
      fs.rmSync(request.directory, { recursive: true });
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      const agent = { async call(_prompt, options) {
        workerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const next = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const nextContext = requestInput(next, "spec-gate-repair-context.json").document;
        assert.notEqual(nextContext.batchDigest, context.batchDigest);
        fs.writeFileSync(requestPayloadPath(next, "spec-gate-repair.json"), workerArtifactJson({
          version: 1, stage: "spec-gate-repair-user-input",
          baseRevision: nextContext.baseRevision,
          question: "Which validation target should the repair name?",
        }));
        sealWorkerArtifactHandoff({ requestPath,
          invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        return JSON.stringify({ sealed: true, requestDigest: next.requestDigest });
      } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 3 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(workerCalls, 1, JSON.stringify(result));
      assert.equal(result.dispatch?.boundary, "await_user_decision");
      assert.equal(durableSnapshot(restarted, value.specId).spec, original.spec);
      const ledger = new SpecGateRepairProgressLedger({ flowManager: restarted,
        specId: value.specId, attemptId: restarted.canonicalState(value.specId).attempt.id,
        baseRevision: context.baseRevision });
      assert.equal(ledger.entries.length, 2);
      assert.equal(ledger.entries[0].proposal.stage, "spec-gate-repair-context-request");
      assert.equal(ledger.entries[1].proposal.stage, "spec-gate-repair-user-input");
      assert.equal(latestRepairBudget({ flowManager: restarted, specId: value.specId,
        attemptId: restarted.canonicalState(value.specId).attempt.id,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.providerCallCount, 2);
    } finally { removeTmpDir(value.root); }
  });

  it("restores a sealed claimed response without another provider call", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated claimed response repository");
      const request = nextRequest(value, "sealed-claim");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair-user-input", baseRevision: context.baseRevision,
        question: "Which target should the repair use?",
      }));
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const before = latestRepairBudget({ flowManager: value.flowManager, specId: value.specId,
        attemptId: value.flowManager.canonicalState(value.specId).attempt.id,
        baseRevision: context.baseRevision, consumerNodeId: "spec-gate-repair" }).budget.snapshot();
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      const agent = { async call() { workerCalls += 1; throw new Error("sealed claim must not call provider again"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(result.dispatch?.boundary, "await_user_decision", JSON.stringify(result));
      assert.equal(workerCalls, 0);
      assert.equal(fs.existsSync(request.directory), false);
      assert.equal(latestRepairBudget({ flowManager: restarted, specId: value.specId,
        attemptId: restarted.canonicalState(value.specId).attempt.id,
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
        baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
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
      const request = nextRequest(value, "unsealed-claim");
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      const before = durableSnapshot(value.flowManager, value.specId);
      const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
        inWorktree: false, specId: value.specId });
      let workerCalls = 0;
      const agent = { async call() { workerCalls += 1; throw new Error("claimed response must not re-execute"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 1 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const result = await dispatcher.execute({ ...value.ctx, flowManager: restarted,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({ flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch" });
      assert.equal(result.errors?.[0]?.code, "FLOW_SPEC_GATE_REPAIR_RESPONSE_UNAVAILABLE");
      assert.equal(workerCalls, 0);
      assert.deepEqual(durableSnapshot(restarted, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("refuses a sealed response without its durable claim", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const request = nextRequest(value, "unclaimed-seal");
      const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair-user-input",
        baseRevision: context.baseRevision, question: "Which target is intended?",
      }));
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const before = durableSnapshot(value.flowManager, value.specId);
      await assert.rejects(SpecGateRepairService.prepare({ ctx: value.ctx, request,
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
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair-user-input",
        baseRevision: context.baseRevision, question: "Which target is intended?",
      }));
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const before = durableSnapshot(value.flowManager, value.specId);
      fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
        version: 1, stage: "spec-gate-repair-user-input",
        baseRevision: context.baseRevision, question: "A different target?",
      }));
      await assert.rejects(SpecGateRepairService.prepare({ ctx: value.ctx, request,
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
        baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
        additionalRangeIds: ["background"],
      }));
      SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
        prompt: JSON.stringify(request.toPromptReference()) });
      sealWorkerArtifactHandoff({ requestPath: request.requestPath,
        invocationId: request.dispatchInvocationId });
      const service = await SpecGateRepairService.prepare({ ctx: value.ctx, request,
        Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
      const before = durableSnapshot(value.flowManager, value.specId);
      const result = value.flowManager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).result;
      assert.throws(() => value.flowManager.settleDraftStepResult({
        binding: service.binding, stepResult: result,
        settlement: settleSpecStepResult("spec-gate-repair", result),
      }), /completion must publish one exact generation receipt/);
      const publication = value.flowManager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt;
      const generation = publication.executionLifecycle.binding.executionGeneration;
      const malformed = { version: 0, phase: "completed", runId: service.binding.runId,
        specId: value.specId, attemptId: service.binding.attempt.id,
        attemptSequence: service.binding.attempt.sequence, generation,
        publicationReceiptId: publication.id,
        requestDigest: publication.executionLifecycle.claim.requestDigest,
        resultKind: result.kind };
      assert.throws(() => value.flowManager.settleDraftStepResult({
        binding: service.binding, stepResult: result,
        settlement: settleSpecStepResult("spec-gate-repair", result),
        artifactWrites: [{ logicalKey: "spec.gate.repair.progress",
          parameters: { attemptId: service.binding.attempt.id, generation: String(generation),
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
      const completed = await completeWorkerResponse(value, request, {
        version: 1, stage: "spec-gate-repair-context-request",
        baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
        additionalRangeIds: ["background"],
      });
      const manager = value.ctx.flowManager;
      const generation = manager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt.executionLifecycle.binding.executionGeneration;
      const marker = manager.readArtifact({ specId: value.specId,
        logicalKey: "spec.gate.repair.progress", consumerNodeId: "spec-gate-repair",
        parameters: { attemptId: completed.service.binding.attempt.id,
          generation: String(generation), phase: "completed" } });
      const before = durableSnapshot(manager, value.specId);
      const repeated = manager.completeSpecGateRepairProgress({
        binding: completed.service.binding, stepResult: completed.result,
        settlement: settleSpecStepResult("spec-gate-repair", completed.result),
        publicationReceipt: completed.service.publicationReceipt,
      });
      assert.equal(repeated.newlyCompleted, false);
      assert.equal(repeated.receipt.id, manager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt.id);
      assert.deepEqual(durableSnapshot(manager, value.specId), before);
      const replay = manager.settleDraftStepResult({
        binding: completed.service.binding, stepResult: completed.result,
        settlement: settleSpecStepResult("spec-gate-repair", completed.result),
        artifactWrites: [{ logicalKey: "spec.gate.repair.progress",
          parameters: { attemptId: completed.service.binding.attempt.id,
            generation: String(generation), phase: "completed" },
          mediaType: "application/json", bytes: marker.bytes }],
      });
      assert.equal(replay.receipt.id, manager.readCurrentStepSettlement({ specId: value.specId,
        stepId: "spec-gate-repair" }).receipt.id);
      assert.deepEqual(durableSnapshot(manager, value.specId), before);
      assert.throws(() => manager.settleDraftStepResult({
        binding: completed.service.binding, stepResult: completed.result,
        settlement: settleSpecStepResult("spec-gate-repair", completed.result),
        specRecord: { changed: "This is not the completed publication" },
        artifactWrites: [{ logicalKey: "spec.gate.repair.progress",
          parameters: { attemptId: completed.service.binding.attempt.id,
            generation: String(generation), phase: "completed" },
          mediaType: "application/json", bytes: marker.bytes }],
      }), /completion must publish one exact generation receipt/);
      assert.deepEqual(durableSnapshot(manager, value.specId), before);
    } finally { removeTmpDir(value.root); }
  });

  it("continues multiple atomic repair units through a reloaded dispatcher", async () => {
    const value = await createSpecGateRepairScenario({ additionalObservations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R1",
      where: { file: "spec.json", locator: "background" },
      observed: "The background needs a bounded correction.",
      severity: "blocking", refs: ["R1"],
    }] });
    try {
      initGitRepo(value.root);
      fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
      commitAll(value.root, "Create isolated multiple-unit repair repository");
      const first = nextRequest(value, "multiple-units-first");
      const context = first.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(context.selections.length, 2);
      const firstUnit = context.selections.find((selection) => (
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
      const agent = { async call(_prompt, options) {
        workerCalls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const selected = requestInput(request, "spec-gate-repair-context.json").document;
        assert.equal(selected.mode, "repair");
        assert.equal(selected.selections.length, 2);
        const groups = selected.selections.map((selection) => {
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

  it("persists every oversized-unit evidence batch before one atomic repair after restart", async () => {
    const specRecord = oversizedSpec();
    const value = await createSpecGateRepairScenario({ specRecord });
    try {
      const original = durableSnapshot(value.flowManager, value.specId);
      validateSpecJsonObject(JSON.parse(original.spec));
      const repairAttemptId = value.flowManager.canonicalState(value.specId).attempt.id;
      const baseRevision = `sha256:${original.catalog.artifacts.find((entry) => entry.logicalKey === "spec.record").hash}`;
      let evidenceCalls = 0;
      let finalResult = null;
      for (let index = 0; index < 16; index += 1) {
        const request = nextRequest(value, `evidence-${index}`);
        const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
        assert.notEqual(context.mode, "locate");
        let proposal;
        if (context.mode === "evidence") {
          evidenceCalls += 1;
          const { source, ledger } = readProgressBoundSpecGateRepairInput({
            flowManager: value.ctx.flowManager,
            state: value.ctx.flowManager.canonicalState(value.specId),
            executionRoot: value.root,
          });
          const { budget } = latestRepairBudget({ flowManager: value.ctx.flowManager,
            specId: value.specId, attemptId: value.ctx.flowManager.canonicalState(value.specId).attempt.id,
            baseRevision: source.baseRevision, consumerNodeId: "spec-gate-repair" });
          const work = nextSpecGateRepairEvidence({ context: source.context,
            unitId: context.unitId, limit: SPEC_GATE_REPAIR_REQUEST_LIMIT,
            publications: ledger.entries, executionBudget: budget });
          assert.equal(work.mode, "evidence");
          assert.equal(work.batch.digest, context.batchDigest);
          proposal = { version: 1, stage: "spec-gate-repair-evidence",
            baseRevision: context.baseRevision, unitId: context.unitId,
            observations: work.batch.payloadElements.map((element) => ({
              requirementId: context.unitId, sourceRef: element.id,
              ...(element.coveredSourceRefs ? { coveredSourceRefs: element.coveredSourceRefs } : {}),
              support: ["The cited original range preserves the planned interface."],
              contradictions: [], unresolved: [],
            })) };
        } else {
          assert.equal(context.mode, "repair");
          assert.ok(evidenceCalls > 1);
          const selection = context.selections[0];
          const writable = selection.ranges.find((range) => range.writable);
          assert.equal(writable.id, "requirements[R1].desc");
          proposal = { version: 1, stage: "spec-gate-repair",
            baseRevision: context.baseRevision,
            groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity),
              operations: [{ kind: "edit-text-field", target: writable.target,
                expectedDigest: writable.digest,
                edits: [{ startByte: 0,
                  endByte: Buffer.byteLength("Publish a validated artifact.", "utf8"),
                  replacement: "Publish a precisely validated artifact." }],
                reason: "Correct the planned validation target using complete evidence.",
              }] }] };
        }
        const { result } = await completeWorkerResponse(value, request, proposal);
        if (context.mode === "repair") { finalResult = result; break; }
        assert.equal(result.kind, "spec-gate-repair-context-required");
        assert.equal(durableSnapshot(value.ctx.flowManager, value.specId).spec, original.spec);
        value.ctx.flowManager = new FlowManager({ root: value.root, mainRoot: value.root,
          inWorktree: false, specId: value.specId });
      }
      assert.equal(finalResult?.kind, "spec-gate-repair-review-required");
      const after = durableSnapshot(value.ctx.flowManager, value.specId);
      assert.equal(artifactCount(after, "spec.snapshot"), artifactCount(original, "spec.snapshot") + 1);
      assert.equal(artifactCount(after, "spec.gate.repair.audit"),
        artifactCount(original, "spec.gate.repair.audit") + 1);
      const ledger = new SpecGateRepairProgressLedger({ flowManager: value.ctx.flowManager,
        specId: value.specId, attemptId: repairAttemptId, baseRevision });
      const evidence = ledger.forMode("evidence");
      assert.equal(evidence.length, evidenceCalls);
      assert.equal(new Set(evidence.map((entry) => entry.context.batchDigest)).size, evidenceCalls);
      assert.equal(ledger.groups().length, 1);
      const { budget } = latestRepairBudget({ flowManager: value.ctx.flowManager,
        specId: value.specId, attemptId: repairAttemptId,
        baseRevision,
        consumerNodeId: "spec-gate-repair" });
      assert.equal(budget.providerCallCount, evidenceCalls + 1);
    } finally { removeTmpDir(value.root); }
  });

  it("publishes an additional read and a user decision without minting edit authority", async () => {
    const value = await createSpecGateRepairScenario();
    try {
      const before = durableSnapshot(value.flowManager, value.specId);
      const first = nextRequest(value, 0);
      const initial = first.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
      assert.equal(initial.mode, "repair");
      const unitId = initial.selections[0].unit.id;
      assert.equal(initial.selections[0].ranges.some((range) => range.id === "background"), false);
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
      const readOnly = expanded.selections[0].ranges.find((range) => range.id === "background");
      assert.equal(readOnly.value, "The worker cannot write canonical Flow artifacts.");
      assert.equal(readOnly.writable, false);
      const decision = await completeWorkerResponse(value, second, { version: 1,
        stage: "spec-gate-repair-user-input", baseRevision: expanded.baseRevision,
        question: "Which planned validation target should the requirement name?" });
      assert.equal(decision.result.kind, "spec-gate-repair-awaiting-decision");
      const ledger = new SpecGateRepairProgressLedger({ flowManager: value.ctx.flowManager,
        specId: value.specId, attemptId: restarted.canonicalState(value.specId).attempt.id,
        baseRevision: expanded.baseRevision });
      assert.deepEqual(ledger.entries.map((entry) => entry.proposal.stage),
        ["spec-gate-repair-context-request", "spec-gate-repair-user-input"]);
      assert.equal(ledger.groups().length, 0);
      const { budget } = latestRepairBudget({ flowManager: value.ctx.flowManager, specId: value.specId,
        attemptId: restarted.canonicalState(value.specId).attempt.id,
        baseRevision: expanded.baseRevision, consumerNodeId: "spec-gate-repair" });
      assert.equal(budget.providerCallCount, 2);
      const after = durableSnapshot(restarted, value.specId);
      assert.equal(after.spec, before.spec);
      assert.equal(artifactCount(after, "spec.snapshot"), artifactCount(before, "spec.snapshot"));
      const next = await new GetNextActionCommand().execute({ ...value.ctx,
        flowState: restarted.loadReadOnly(value.specId), flowResolutionError: null });
      assert.equal(next.directive.kind, "await_worker_input");
      assert.equal(next.directive.requiresUserAction, true);
      assert.equal(next.directive.terminal, false);
      assert.match(next.directive.question,
        /Which planned validation target should the requirement name/);
      let workerCalls = 0;
      const agent = { async call() { workerCalls += 1; throw new Error("await must not run a worker"); } };
      const dispatcher = new RunDispatchCommand({ agent, maxDispatches: 2 });
      dispatcher.container = dispatchContainer({ root: value.root, flowManager: restarted, agent });
      const boundary = await dispatcher.execute({ ...value.ctx,
        flowState: restarted.loadReadOnly(value.specId),
        expectBinding: FlowTargetBinding.capture({
          flowState: restarted.loadReadOnly(value.specId),
          mainRoot: value.root, authorityRoot: value.root,
        }).serialize(),
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(boundary.dispatch?.boundary, "await_user_decision");
      assert.equal(workerCalls, 0);
    } finally { removeTmpDir(value.root); }
  });

  for (const mode of ["locate", "evidence", "context", "user-input", "repair"]) {
    it(`dispatches a published ${mode} response after restart without another provider call`, async () => {
      const value = await createSpecGateRepairScenario({
        ...(mode === "evidence" ? { specRecord: oversizedSpec() } : {}),
        ...(mode === "locate" ? { locator: "unresolved validation target" } : {}),
      });
      try {
        initGitRepo(value.root);
        fs.writeFileSync(path.join(value.root, ".gitignore"), ".sennel/\n.tmp/\n");
        commitAll(value.root, "Create isolated repair replay repository");
        const request = nextRequest(value, `interrupted-${mode}`);
        const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
        let proposal;
        if (mode === "locate") {
          assert.equal(context.mode, "locate");
          proposal = { version: 1, stage: "spec-gate-repair-locate", baseRevision: context.baseRevision,
            locations: [{ identity: context.finding.identity, rangeIds: ["requirements[R1].desc"] }] };
        } else if (mode === "evidence") {
          assert.equal(context.mode, "evidence");
          const { source, ledger } = readProgressBoundSpecGateRepairInput({
            flowManager: value.flowManager, state: value.flowManager.canonicalState(value.specId),
            executionRoot: value.root });
          const work = nextSpecGateRepairEvidence({ context: source.context, unitId: context.unitId,
            limit: SPEC_GATE_REPAIR_REQUEST_LIMIT, publications: ledger.entries });
          proposal = { version: 1, stage: "spec-gate-repair-evidence", baseRevision: context.baseRevision,
            unitId: context.unitId, observations: work.batch.payloadElements.map((element) => ({
              requirementId: context.unitId, sourceRef: element.id,
              support: ["The original range preserves the validation contract."], contradictions: [], unresolved: [],
            })) };
        } else {
          assert.equal(context.mode, "repair");
          const selection = context.selections[0];
          const range = selection.ranges.find((entry) => entry.writable);
          proposal = mode === "context" ? { version: 1, stage: "spec-gate-repair-context-request",
            baseRevision: context.baseRevision, unitId: selection.unit.id, additionalRangeIds: ["background"] }
            : mode === "user-input" ? { version: 1, stage: "spec-gate-repair-user-input",
              baseRevision: context.baseRevision, question: "Which validation target is intended?" }
              : { version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
                groups: [{ findingIdentities: selection.unit.findings.map((finding) => finding.identity),
                  operations: [{ kind: "edit-text-field", target: range.target, expectedDigest: range.digest,
                    edits: [{ startByte: 0, endByte: Buffer.byteLength(range.value),
                      replacement: "Publish a precisely validated artifact." }], reason: "Clarify the exact finding." }] }] };
        }
        fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
        SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
          prompt: JSON.stringify(request.toPromptReference()) });
        sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
        await SpecGateRepairService.prepare({ ctx: value.ctx, request,
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
        const agent = { async call() { workerCalls += 1; throw new Error("published response must replay"); } };
        const dispatcher = new RunDispatchCommand({ agent, maxDispatches: mode === "user-input" ? 2 : 1 });
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
          artifactCount(before, "spec.gate.repair.progress") + (["locate", "evidence", "context"].includes(mode) ? 1 : 0));
        const ledger = new SpecGateRepairProgressLedger({ flowManager: restarted,
          specId: value.specId, attemptId, baseRevision: context.baseRevision });
        assert.equal(ledger.entries.length, 1);
        assert.deepEqual(ledger.entries[0].proposal, proposal);
        if (["locate", "evidence", "context"].includes(mode)) {
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
          const nextAgent = { async call(_prompt, options) {
            workerCalls += 1;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const following = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            nextContext = requestInput(following, "spec-gate-repair-context.json").document;
            let response;
            if (nextContext.mode === "evidence") {
              const { source, ledger: nextLedger } = readProgressBoundSpecGateRepairInput({
                flowManager: restarted, state: restarted.canonicalState(value.specId), executionRoot: value.root });
              const work = nextSpecGateRepairEvidence({ context: source.context,
                unitId: nextContext.unitId, limit: SPEC_GATE_REPAIR_REQUEST_LIMIT,
                publications: nextLedger.entries });
              response = { version: 1, stage: "spec-gate-repair-evidence",
                baseRevision: nextContext.baseRevision, unitId: nextContext.unitId,
                observations: work.batch.payloadElements.map((element) => ({
                  requirementId: nextContext.unitId, sourceRef: element.id,
                  support: ["The cited range retains the planned contract."],
                  contradictions: [], unresolved: [],
                })) };
            } else {
              response = { version: 1, stage: "spec-gate-repair-user-input",
                baseRevision: nextContext.baseRevision, question: "Which target should this repair use?" };
            }
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
          if (mode === "locate") assert.equal(nextContext.mode, "repair");
          if (mode === "context") assert.equal(nextContext.selections[0].ranges.find((range) => range.id === "background").writable, false);
          const afterNewClaim = durableSnapshot(restarted, value.specId);
          assert.throws(() => request.assertCurrent(restarted.loadReadOnly(value.specId)),
            { code: "FLOW_ARTIFACT_HANDOFF_STALE" });
          assert.deepEqual(durableSnapshot(restarted, value.specId), afterNewClaim);
          assert.equal(latestRepairBudget({ ...budgetInput, flowManager: restarted }).budget.providerCallCount, 2);
        } else if (mode === "user-input") {
          assert.equal(result.dispatch?.boundary, "await_user_decision");
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
        const resumed = await SpecGateRepairService.prepare({
          ctx: { ...value.ctx, flowManager: restarted }, request: restoredRequest,
          Connector: SpecEntryConnector, handoffCoordinator: value.coordinator,
        });
        const retried = await new StepFactory().provide(SpecGateRepairService, resumed)
          .create(SpecGateRepairStep).execute();
        assert.equal(retried.kind, "spec-gate-repair-review-required");
        const { budget: savedBudget } = latestRepairBudget({ flowManager: restarted,
          specId: value.specId, attemptId: state.attempt.id,
          baseRevision: service.preparation.facts.input.baseRevision,
          consumerNodeId: "spec-gate-repair" });
        assert.equal(savedBudget.providerCallCount, 1);
      }
      assertOneTerminalPublication(restarted, value.specId, before);
    } finally { removeTmpDir(value.root); }
  });
});
