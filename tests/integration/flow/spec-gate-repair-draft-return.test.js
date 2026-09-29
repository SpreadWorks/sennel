import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { SpecGateRepairService } from "../../../src/flow/services/spec-gate-repair-service.js";
import { readProgressBoundSpecGateRepairInput } from "../../../src/flow/lib/spec-gate-repair-progress.js";
import { SpecGateRepairStep } from "../../../src/flow/steps/spec/spec-gate-repair.js";
import { settleSpecStepResult } from "../../../src/flow/definition.js";
import { CanonicalFlowArtifactBaseline } from "../../../src/flow/lib/current-flow-state.js";
import { DraftReopenContext } from "../../../src/flow/lib/draft-reopen-context.js";
import { SpecEntryConnector } from "../../../src/flow/engine/connectors/spec/spec-entry-connector.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { createSpecGateRepairScenario } from "../../support/infrastructure/spec-gate-repair-scenario.js";
import { workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";

test("a published Spec Gate decision gap reopens Draft with durable worker input", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    assert.equal(context.mode, "repair");
    const oldAttempt = value.flowManager.canonicalState(value.specId).attempt;
    const proposal = { version: 1, stage: "spec-gate-repair-draft-return",
      baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
      decision: "Which validation target should the requirement name?",
      evidence: "The current Issue and Spec identify the requirement but leave its target open.",
      unresolvedBecause: "Neither source selects one validation target." };
    fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
    SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: request.requestPath,
      invocationId: request.dispatchInvocationId });
    await SpecGateRepairService.prepare({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });

    const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const replayContext = { ...value.ctx, flowManager: restarted };
    const plan = SpecGateRepairService.planWorkerExecution({ ctx: replayContext,
      state: restarted.load(value.specId), invocation: value.invocation,
      handoffCoordinator: value.coordinator });
    assert.equal(plan.canonicalReplay, true);
    assert.equal(plan.request, null);
    const service = await SpecGateRepairService.resumePublished({ ctx: replayContext,
      state: restarted.canonicalState(value.specId), handoffCoordinator: value.coordinator });
    const binding = await new SpecEntryConnector(request).connect();
    const result = await new StepFactory().provide(SpecGateRepairService, service)
      .create(SpecGateRepairStep).execute();
    assert.equal(result.kind, "spec-gate-repair-draft-return-required");
    assert.equal(fs.existsSync(request.directory), false);
    const current = restarted.canonicalState(value.specId);
    assert.equal(current.current.at(-1), "draft");
    assert.notEqual(current.attempt.id, oldAttempt.id);
    const reopening = restarted.activityLedger(value.specId).at(-1);
    assert.equal(reopening.transition.operation, "reopen_draft_preimplementation");
    assert.equal(reopening.result.stepResult.kind, result.kind);
    assert.equal(reopening.result.draftSettlementReceipt.binding.attemptId, oldAttempt.id);
    const issue = restarted.readArtifact({ specId: value.specId,
      logicalKey: "issue.log", consumerNodeId: "draft" });
    const saved = JSON.parse(issue.bytes.toString("utf8")).entries.at(-1).draftReopen;
    assert.equal(saved.reason, proposal.decision);
    assert.equal(saved.draftAttemptId, current.attempt.id);
    assert.equal(saved.source.baseRevision, context.baseRevision);
    assert.equal(saved.source.evidence, proposal.evidence);
    assert.equal(saved.source.findingIdentities.length, 1);

    const loaded = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const draftRequest = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: { ...value.ctx, flowManager: loaded }, state: loaded.load(value.specId),
      invocation: { id: "dispatch-draft-after-reopen", target: { digest: "c".repeat(64) },
        action: { digest: "d".repeat(64), nextAction: { step: "draft" } } },
    });
    const carried = draftRequest.contextSnapshot.entries.find((entry) => entry.kind === "reopen");
    assert.equal(carried.document.reason, proposal.decision);
    assert.equal(carried.document.draftAttemptId, current.attempt.id);
    const settlement = settleSpecStepResult(binding.stepId, result);
    const spec = loaded.readArtifact({ specId: value.specId, logicalKey: "spec.record",
      consumerNodeId: "spec-gate-repair" });
    const replayInput = { binding, stepResult: result, settlement,
      artifactBaselines: [new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record",
        digest: spec.descriptor.hash, byteLength: spec.descriptor.size })],
      draftReturn: new DraftReopenContext({ ...saved, previousDraft: null, draftAttemptId: null }) };
    assert.equal(loaded.findStepSettlementReceipt(replayInput).id,
      reopening.result.draftSettlementReceipt.id);
    const beforeReplay = loaded.activityLedger(value.specId).length;
    assert.equal(loaded.settleSpecStepResult(replayInput).receipt.id,
      reopening.result.draftSettlementReceipt.id);
    assert.equal(loaded.activityLedger(value.specId).length, beforeReplay);
    assert.throws(() => loaded.settleSpecStepResult({ ...replayInput,
      draftReturn: new DraftReopenContext({ ...saved,
        reason: "A changed decision", previousDraft: null, draftAttemptId: null }) }),
    /replay differs/);
    assert.throws(() => loaded.settleSpecStepResult({ ...replayInput,
      artifactBaselines: [new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record",
        digest: spec.descriptor.hash, byteLength: spec.descriptor.size + 1 })] }),
    /replay differs/);
    assert.throws(() => request.assertCurrent(loaded.load(value.specId)), /stale|active|Attempt/i);
  } finally { removeTmpDir(value.root); }
});

test("a published Draft return refuses changed source evidence after restart", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    fs.writeFileSync(`${value.root}/AGENTS.md`, "The validation target is unresolved.\n");
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
      version: 1, stage: "spec-gate-repair-draft-return",
      baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
      decision: "Which target should the requirement validate?",
      evidence: "The project rules leave the target open.",
      unresolvedBecause: "No supplied source selects a target.",
    }));
    SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: request.requestPath,
      invocationId: request.dispatchInvocationId });
    await SpecGateRepairService.prepare({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const before = value.flowManager.activityLedger(value.specId).length;
    fs.writeFileSync(`${value.root}/AGENTS.md`, "The validation target is now specified.\n");
    const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    await assert.rejects(SpecGateRepairService.resumePublished({ ctx: { ...value.ctx,
      flowManager: restarted }, state: restarted.canonicalState(value.specId),
      handoffCoordinator: value.coordinator }), (error) =>
      error.code === "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED");
    assert.equal(restarted.activityLedger(value.specId).length, before);
    assert.equal(restarted.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
  } finally { removeTmpDir(value.root); }
});

test("a published Draft return refuses changed Spec guardrails after restart without a side effect", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const rulesPath = path.join(value.root, ".sennel/guardrail.json");
    const setRule = (body) => fs.writeFileSync(rulesPath, JSON.stringify({ guardrails: [{
      id: "R1", body, meta: { category: "requirements", phase: ["spec"] },
    }] }));
    setRule("The validation target remains a user choice.");
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    assert.equal(context.mode, "repair");
    assert(context.selections[0].guardrails.some((rule) =>
      rule.id === "R1" && rule.body === "The validation target remains a user choice."));
    fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
      version: 1, stage: "spec-gate-repair-draft-return",
      baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
      decision: "Which validation target should be used?",
      evidence: "The canonical sources leave the target open.",
      unresolvedBecause: "The project must choose one target.",
    }));
    SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: request.requestPath,
      invocationId: request.dispatchInvocationId });
    await SpecGateRepairService.prepare({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const beforeActivities = value.flowManager.activityLedger(value.specId);
    const beforeState = value.flowManager.canonicalState(value.specId);
    const beforeCatalog = value.flowManager.artifactCatalog(value.specId);
    setRule("The validation target must be the production endpoint.");
    const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    await assert.rejects(SpecGateRepairService.resumePublished({ ctx: { ...value.ctx,
      flowManager: restarted }, state: restarted.canonicalState(value.specId),
      handoffCoordinator: value.coordinator }), (error) =>
      error.code === "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED");
    assert.deepEqual(restarted.activityLedger(value.specId), beforeActivities);
    assert.deepEqual(restarted.canonicalState(value.specId), beforeState);
    assert.deepEqual(restarted.artifactCatalog(value.specId), beforeCatalog);
  } finally { removeTmpDir(value.root); }
});

test("completed context expansion cannot authorize another repair call after its Spec rules change", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const rulesPath = path.join(value.root, ".sennel/guardrail.json");
    const setRule = (body) => fs.writeFileSync(rulesPath, JSON.stringify({ guardrails: [{
      id: "R1", body, meta: { category: "requirements", phase: ["spec"] },
    }] }));
    setRule("Choose the planned validation target.");
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
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
    const result = await new StepFactory().provide(SpecGateRepairService, service)
      .create(SpecGateRepairStep).execute();
    assert.equal(result.kind, "spec-gate-repair-context-required");
    const restarted = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    const readProgress = () => readProgressBoundSpecGateRepairInput({ flowManager: restarted,
      state: restarted.canonicalState(value.specId), executionRoot: value.root });
    const continued = readProgress();
    assert.equal(continued.ledger.entries[0].context.evidenceDigest,
      continued.source.context.evidenceDigest);
    const beforeState = restarted.canonicalState(value.specId);
    const beforeActivities = restarted.activityLedger(value.specId);
    const beforeCatalog = restarted.artifactCatalog(value.specId);
    setRule("The planned target must be the production endpoint.");
    assert.throws(() => value.coordinator.createRequest({ ctx: { ...value.ctx,
      flowManager: restarted }, state: restarted.load(value.specId),
      invocation: { ...value.invocation, id: "dispatch-after-rule-change" } }),
    (error) => error.code === "FLOW_SPEC_GATE_REPAIR_EVIDENCE_CHANGED"
      && error.classification === "stale" && error.isAdmissionRejection === true);
    assert.deepEqual(restarted.canonicalState(value.specId), beforeState);
    assert.deepEqual(restarted.activityLedger(value.specId), beforeActivities);
    assert.deepEqual(restarted.artifactCatalog(value.specId), beforeCatalog);
  } finally { removeTmpDir(value.root); }
});

test("an interrupted Draft return keeps its reason and state in one transaction", async () => {
  let interrupt = true;
  const value = await createSpecGateRepairScenario({ versionStoreFaultInjector({ phase, activity }) {
    if (interrupt && phase === "activity-ready-to-append"
      && activity?.transition?.operation === "reopen_draft_preimplementation") {
      throw new Error("interrupt Draft reopen before append");
    }
  } });
  try {
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    const proposal = { version: 1, stage: "spec-gate-repair-draft-return",
      baseRevision: context.baseRevision, unitId: context.selections[0].unit.id,
      decision: "Which validation target is intended?",
      evidence: "The saved sources leave the validation target open.",
      unresolvedBecause: "The target requires a user choice." };
    fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson(proposal));
    SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: request.requestPath,
      invocationId: request.dispatchInvocationId });
    await SpecGateRepairService.prepare({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator });
    const before = value.flowManager.activityLedger(value.specId).length;
    const service = await SpecGateRepairService.resumePublished({ ctx: value.ctx,
      state: value.flowManager.canonicalState(value.specId),
      handoffCoordinator: value.coordinator });
    assert.throws(() => value.flowManager.reopenDraft({ specId: value.specId,
      route: "preimplementation", reason: proposal.decision,
      artifactBaselines: [new CanonicalFlowArtifactBaseline({ logicalKey: "spec.record",
        digest: "f".repeat(64), byteLength: 1 })] }), /baseline|stale|changed/i);
    assert.equal(value.flowManager.activityLedger(value.specId).length, before);
    const result = new StepFactory().provide(SpecGateRepairService, service)
      .create(SpecGateRepairStep);
    await assert.rejects(result.execute(), /interrupt Draft reopen before append/);
    const interrupted = new FlowManager({ root: value.root, mainRoot: value.root,
      inWorktree: false, specId: value.specId });
    assert.equal(interrupted.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
    assert.equal(interrupted.activityLedger(value.specId).length, before);
    const issue = interrupted.readArtifact({ specId: value.specId, logicalKey: "issue.log",
      consumerNodeId: "spec-gate-repair" });
    assert.equal(JSON.parse(issue.bytes.toString("utf8")).entries.some((entry) => entry.draftReopen), false);
    interrupt = false;
    const resumed = await SpecGateRepairService.resumePublished({ ctx: { ...value.ctx,
      flowManager: interrupted }, state: interrupted.canonicalState(value.specId),
      handoffCoordinator: value.coordinator });
    const settled = await new StepFactory().provide(SpecGateRepairService, resumed)
      .create(SpecGateRepairStep).execute();
    assert.equal(settled.kind, "spec-gate-repair-draft-return-required");
    const savedIssue = interrupted.readArtifact({ specId: value.specId, logicalKey: "issue.log",
      consumerNodeId: "draft" });
    assert.equal(JSON.parse(savedIssue.bytes.toString("utf8")).entries.at(-1).draftReopen.reason,
      proposal.decision);
    assert.equal(interrupted.canonicalState(value.specId).current.at(-1), "draft");
  } finally { removeTmpDir(value.root); }
});

test("the retired direct user input worker stage is rejected", async () => {
  const value = await createSpecGateRepairScenario();
  try {
    const request = value.coordinator.createRequest({ ctx: value.ctx,
      state: value.flowManager.load(value.specId), invocation: value.invocation });
    const context = request.inputs.find((entry) => entry.name === "spec-gate-repair-context.json").document;
    fs.writeFileSync(request.payloadPath("spec-gate-repair.json"), workerArtifactJson({
      version: 1, stage: "spec-gate-repair-user-input",
      baseRevision: context.baseRevision,
      question: "Which target is intended?",
    }));
    SpecGateRepairService.reserveWorkerCall({ ctx: value.ctx, request,
      prompt: JSON.stringify(request.toPromptReference()) });
    sealWorkerArtifactHandoff({ requestPath: request.requestPath,
      invocationId: request.dispatchInvocationId });
    await assert.rejects(SpecGateRepairService.prepare({ ctx: value.ctx, request,
      Connector: SpecEntryConnector, handoffCoordinator: value.coordinator }),
    /typed repair disposition/);
    assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "spec-gate-repair");
  } finally { removeTmpDir(value.root); }
});
