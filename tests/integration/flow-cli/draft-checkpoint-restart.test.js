import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunRecoverDraftExecutionCommand from "../../../src/flow/lib/run-recover-draft-execution.js";
import {
  DraftWorkerExecutionBinding,
  DraftWorkerExecutionClaim,
  settleDraftStepResult,
} from "../../../src/flow/definition.js";
import { DraftWorkerExecutionStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftGateRepairWorkerRequiredResult } from "../../../src/flow/engine/step-result.js";
import {
  FlowDispatchInvocation,
  FlowDispatchSession,
  FlowDispatchTarget,
  UnapprovedFlowDispatchAuthorization,
} from "../../../src/flow/lib/dispatch-invocation.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import {
  DraftWorkerRecoveryInputPreview,
  WorkerArtifactHandoffCoordinator,
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { workerArtifactDigest, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { dispatchContainer, fixtureRepository, installGateProviderFake, requestInput, requestPayloadPath } from "../../support/infrastructure/flow-dispatch-scenario.js";

function activeDispatch(root, specId, manager, agent, options = {}) {
  const dispatcher = new RunDispatchCommand({
    agent, repositoryFingerprint: () => "draft-checkpoint-restart", maxDispatches: 1,
    ...options,
  });
  dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
  const flowState = manager.loadReadOnly(specId);
  return {
    dispatcher,
    context: {
      root, mainRoot: root, executionRoot: root, specId, flowManager: manager, flowState,
      expectBinding: FlowTargetBinding.capture({
        flowState, mainRoot: root, authorityRoot: root,
      }).serialize(),
      _envelopeType: "run", _envelopeKey: "dispatch",
    },
  };
}

function executionState(manager, specId) {
  const state = manager.canonicalState(specId);
  return manager.draftStepExecutionState({
    binding: { runId: state.runId, specId, stepId: "draft-gate-repair", attempt: state.attempt },
  });
}

function repairPayload(request) {
  const recurrence = requestInput(request, "gate-observation-recurrence.json").document;
  return {
    version: 1,
    baseRevision: `sha256:${request.inputRevision}`,
    operations: [{
      kind: "replace-value", path: "analysis.validation",
      replacement: "Verify the retained behavior after the restarted Gate repair.",
      reason: "Make the retained behavior explicit.",
    }],
    report: {
      version: 1, summary: "The Draft now covers the retained behavior.",
      results: recurrence.entries.map((entry) => ({
        fingerprint: entry.fingerprint,
        strategy: "Make the retained behavior explicit.",
        summary: "The Draft now covers the retained behavior.",
        priorRepairInsufficiency: entry.recurrenceCount > 0
          ? "The prior Draft did not cover the retained behavior." : null,
      })),
    },
  };
}

async function passReview(ctx) {
  const command = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
      fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), workerArtifactJson({
        version: 2, phase: "draft-coverage", sourceDraft: "draft.json",
        sourceDraftRevision: source.revision, generatedAt: "2026-09-21T00:00:00.000Z",
        verdict: "PASS", summary: "The repaired Draft passes review.",
        blockingFindings: [], advisoryFindings: [], repairTargets: [],
      }));
      work.seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
  const commandCtx = { ...ctx, phase: "draft", config: {}, flowState: ctx.flowManager.loadReadOnly(ctx.specId) };
  const result = await command.execute(commandCtx);
  await FLOW_COMMANDS.run.review.post(commandCtx, result);
  return { ok: true, data: result, errors: [] };
}

async function passGate(ctx) {
  const commandCtx = { ...ctx, phase: "draft", config: {}, flowState: ctx.flowManager.loadReadOnly(ctx.specId) };
  const result = await new RunGateCommand().execute(commandCtx);
  await FLOW_COMMANDS.run.gate.post(commandCtx, result);
  return { ok: true, data: result, errors: [] };
}

function startRepairBoundary(root, specId, runId) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({
    flowManager: manager, specId, runId,
    request: "Recover a retained Draft Gate repair after restart.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
    guardrails: [{
      id: "DRAFT-REPAIRED", title: "Repaired Draft reaches Gate",
      body: "Check the repaired validation behavior in the canonical Draft.",
      meta: { phase: ["draft"], category: "requirements" },
    }],
  }));
  manager.confirmCurrentAttempt({
    specId,
    artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(workerArtifactJson(canonicalDraftDocument({
        goal: "Recover the Draft Gate repair after restart.",
      }))),
    }],
  });
  fixture.activate("draft-gate");
  new DraftGateRepairScenario({ flowManager: manager, root, specId }).select({
    issueLogId: "issue-checkpoint-restart",
    observations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "DRAFT",
      where: { file: "draft.json", locator: "analysis.validation" },
      observed: "The retained behavior is absent from validation.",
      severity: "blocking", refs: ["DRAFT"],
    }],
  });
  return manager;
}

async function legacyFailedRepairBoundary(root, specId, { fail = true } = {}) {
  const manager = startRepairBoundary(root, specId, `run-${specId}`);
  const inactiveAgent = { async call() { assert.fail("legacy evidence setup must not start a worker"); } };
  const dispatch = activeDispatch(root, specId, manager, inactiveAgent);
  const target = FlowDispatchTarget.captureContext(dispatch.context);
  const session = new FlowDispatchSession({ target });
  const selectedAction = await dispatch.dispatcher.fetchNextAction(target);
  assert.equal(selectedAction.step, "draft-gate-repair");
  const action = dispatch.dispatcher.captureAction(dispatch.context, session, selectedAction, 0, "action-capture");
  const invocation = new FlowDispatchInvocation({
    session, action, authorization: new UnapprovedFlowDispatchAuthorization(action),
  });
  const request = new WorkerArtifactHandoffCoordinator().createRequest({
    ctx: dispatch.context, state: manager.loadReadOnly(specId), invocation,
    deferPreparation: true, deferConditionalAdmission: true,
  });
  assert.equal(fs.existsSync(request.requestPath), false);
  const binding = new DraftWorkerExecutionStepBinding({
    flowManager: manager, specId, stepId: "draft-gate-repair",
  });
  const stepResult = new DraftGateRepairWorkerRequiredResult();
  const settlement = settleDraftStepResult(stepResult.stepId, stepResult);
  const generation0 = new DraftWorkerExecutionBinding({
    executionGeneration: 0, inputDigest: request.inputDigest, inputRevision: request.inputRevision,
  });
  manager.checkpointDraftStepExecution({ binding, stepResult, settlement, executionBinding: generation0 });
  manager.claimDraftStepExecution({
    binding, stepResult, settlement, executionBinding: generation0,
    executionClaim: new DraftWorkerExecutionClaim({
      dispatchInvocationId: request.dispatchInvocationId,
      generatedAt: request.generatedAt,
      actionDigest: request.actionDigest,
      requestDigest: request.requestDigest,
    }),
  });
  manager.checkpointDraftStepExecution({
    binding, stepResult, settlement,
    executionBinding: new DraftWorkerExecutionBinding({
      executionGeneration: 1, inputDigest: request.inputDigest, inputRevision: request.inputRevision,
    }),
  });
  if (fail) {
    manager.failCurrentAttempt({
      specId,
      failure: {
        category: "tooling", code: "FLOW_DRAFT_EXECUTION_INPUT_STALE",
        message: "The old dispatcher compared a fresh invocation to its retained full input digest.",
        retryable: false, retryKind: null,
      },
    });
  }
  return { manager, request, target };
}

function validRepairAgent(onRequest = () => {}) {
  return {
    async call(_prompt, options) {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      assert.equal(request.stepId, "draft-gate-repair");
      onRequest(request);
      fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"),
        workerArtifactJson(repairPayload(request)));
      sealWorkerArtifactHandoff({
        requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
      });
      return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
    },
  };
}

async function interruptBeforeClaim(root, specId, manager) {
  const agent = { async call() { assert.fail("interrupted admission must not start the worker"); } };
  const coordinator = new class extends WorkerArtifactHandoffCoordinator {
    admitConditionalDraftRequest(input) {
      super.admitConditionalDraftRequest(input);
      throw new Error("interrupt after Draft checkpoint before claim");
    }
  }();
  const initial = activeDispatch(root, specId, manager, agent, { handoffCoordinator: coordinator });
  await assert.rejects(() => initial.dispatcher.execute(initial.context),
    /interrupt after Draft checkpoint before claim/);
  const checkpoint = executionState(manager, specId);
  assert.equal(checkpoint.lifecycle.phase, "checkpoint");
  assert.equal(checkpoint.lifecycle.executionGeneration, 0);
  assert.equal(checkpoint.lifecycle.claim, null);
}

it("reclaims a failed Gate repair checkpoint after restart and carries its Draft to Gate", async () => {
  const root = fixtureRepository("draft-checkpoint-restart-");
  let gateAgentLookup;
  try {
    const specId = "821-draft-checkpoint-restart";
    const first = startRepairBoundary(root, specId, "run-draft-checkpoint-restart");
    const selectedAttempt = first.canonicalState(specId).attempt;
    const selectedConsumption = selectedAttempt.consumption.toJSON();

    const requests = [];
    const invalidAgent = {
      async call(_prompt, options) {
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        requests.push(request);
        const payload = repairPayload(request);
        payload.report.results = "invalid worker report";
        fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(payload));
        sealWorkerArtifactHandoff({
          requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
        });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
    const initial = activeDispatch(root, specId, first, invalidAgent);
    const failed = await initial.dispatcher.execute(initial.context);
    assert.equal(failed.ok, false);
    assert.equal(failed.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(failed, null, 2));
    // A process boundary after the durable rejection must retain its correction authority.
    assert.equal(executionState(first, specId).lifecycle.rejection.code, "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID");
    assert.deepEqual(requests.map((request) => request.stepId), ["draft-gate-repair"]);

    let restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const checkpoint = executionState(restarted, specId);
    const before = restarted.canonicalState(specId);
    const activitiesBefore = restarted.activityLedger(specId).length;
    assert.equal(checkpoint.lifecycle.phase, "checkpoint");
    assert.equal(checkpoint.lifecycle.executionGeneration, 1);
    assert.equal(checkpoint.lifecycle.claim, null);
    assert.equal(before.current.at(-1), "draft-gate-repair");
    assert.equal(before.findNode("draft-gate-repair").status, "in_progress");
    assert.equal(before.attempt.id, selectedAttempt.id);
    assert.equal(before.attempt.sequence, selectedAttempt.sequence);
    assert.deepEqual(before.attempt.consumption.toJSON(), selectedConsumption);

    // Crash after claiming the correction but before materializing its request.
    // Reload must reconstruct the exact feedback-bearing request, not a new claim.
    const claim = restarted.claimDraftStepExecution.bind(restarted);
    let retainedRequestDigest;
    restarted.claimDraftStepExecution = (input) => {
      const result = claim(input);
      retainedRequestDigest = input.executionClaim.requestDigest;
      throw new Error("interrupt after correction claim");
    };
    const interrupted = activeDispatch(root, specId, restarted, { async call() { assert.fail("worker must not start before interruption"); } });
    await assert.rejects(() => interrupted.dispatcher.execute(interrupted.context), /interrupt after correction claim/);
    restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(executionState(restarted, specId).lifecycle.phase, "claimed");

    let resumedConsumption = null;
    const validAgent = {
      async call(_prompt, options) {
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        requests.push(request);
        assert.equal(workerArtifactDigest(request), retainedRequestDigest);
        assert.equal(request.workerInstructions.retryFeedback.code, "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID");
        assert.equal(request.stepId, "draft-gate-repair");
        const activeAttempt = restarted.canonicalState(specId).attempt;
        assert.equal(activeAttempt.id, selectedAttempt.id);
        assert.equal(activeAttempt.sequence, selectedAttempt.sequence);
        resumedConsumption = activeAttempt.consumption.toJSON();
        fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(repairPayload(request)));
        sealWorkerArtifactHandoff({
          requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
        });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
    const gatePrompts = [];
    gateAgentLookup = installGateProviderFake((prompt) => {
      gatePrompts.push(prompt);
      return JSON.stringify({ observations: [] });
    });
    const later = activeDispatch(root, specId, restarted, validAgent, {
      maxDispatches: 5,
      commandRunner: async ({ ctx, command }) => {
        if (command.commandName === "review") return passReview(ctx);
        if (command.commandName === "gate") return passGate(ctx);
        assert.fail(`unexpected command: ${command.commandName}`);
      },
    });
    const result = await later.dispatcher.execute(later.context);
    assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
    assert.deepEqual(requests.map((request) => request.stepId), ["draft-gate-repair", "draft-gate-repair"]);
    assert.notEqual(requests[0].dispatchInvocationId, requests[1].dispatchInvocationId);
    assert.deepEqual(resumedConsumption, selectedConsumption);
    const terminal = restarted.activityLedger(specId).findLast((entry) => {
      const receipt = entry.result?.draftSettlementReceipt;
      return receipt?.binding?.attemptId === selectedAttempt.id
        && receipt?.executionLifecycle?.phase === "terminal";
    })?.result?.draftSettlementReceipt;
    assert.ok(terminal);
    assert.equal(terminal.binding.attemptSequence, selectedAttempt.sequence);
    assert.equal(terminal.executionLifecycle.binding.executionGeneration, 1);
    assert.equal(terminal.executionLifecycle.claim.dispatchInvocationId, requests[1].dispatchInvocationId);
    assert.equal(restarted.canonicalState(specId).nextAction().nodeId, "spec");
    assert.ok(restarted.activityLedger(specId).length > activitiesBefore);
    assert.ok(gatePrompts.length > 0);
    const repaired = restarted.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "spec" });
    const repairedDocument = JSON.parse(repaired.bytes.toString("utf8"));
    assert.equal(repairedDocument.analysis.validation,
      "Verify the retained behavior after the restarted Gate repair.");
    for (const prompt of gatePrompts) {
      const contentHeader = "## Content\n";
      assert.ok(prompt.includes(contentHeader));
      assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf(contentHeader) + contentHeader.length)), repairedDocument);
    }
  } finally {
    gateAgentLookup?.mock.restore();
    removeTmpDir(root);
  }
});

it("resumes a Gate repair checkpoint interrupted before the worker claim", async () => {
  const root = fixtureRepository("draft-before-claim-restart-");
  try {
    const specId = "822-draft-before-claim-restart";
    const initial = startRepairBoundary(root, specId, "run-draft-before-claim-restart");
    const selected = initial.canonicalState(specId).attempt;
    await interruptBeforeClaim(root, specId, initial);

    const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const calls = [];
    const agent = {
      async call(_prompt, options) {
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        calls.push(request);
        fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(repairPayload(request)));
        sealWorkerArtifactHandoff({
          requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
        });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };
    const resumed = activeDispatch(root, specId, restarted, agent);
    const result = await resumed.dispatcher.execute(resumed.context);
    assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
    assert.deepEqual(calls.map((request) => request.stepId), ["draft-gate-repair"]);
    assert.equal(restarted.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
    const terminal = restarted.activityLedger(specId).findLast((entry) => {
      const receipt = entry.result?.draftSettlementReceipt;
      return receipt?.binding?.attemptId === selected.id
        && receipt?.executionLifecycle?.phase === "terminal";
    })?.result?.draftSettlementReceipt;
    assert.ok(terminal);
    assert.equal(terminal.executionLifecycle.binding.executionGeneration, 0);
    assert.equal(terminal.executionLifecycle.claim.dispatchInvocationId, calls[0].dispatchInvocationId);
  } finally {
    removeTmpDir(root);
  }
});

it("refuses a changed Gate repair context after an unclaimed checkpoint without touching Flow state", async () => {
  const root = fixtureRepository("draft-changed-context-restart-");
  try {
    const specId = "823-draft-changed-context-restart";
    const initial = startRepairBoundary(root, specId, "run-draft-changed-context-restart");
    await interruptBeforeClaim(root, specId, initial);
    fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
      guardrails: [{
        id: "DRAFT-REPAIRED", title: "Repaired Draft reaches Gate",
        body: "A changed guardrail changes the worker's selected context.",
        meta: { phase: ["draft"], category: "requirements" },
      }],
    }));

    const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const before = restarted.canonicalState(specId).toJSON();
    const activitiesBefore = restarted.activityLedger(specId);
    const catalogBefore = restarted.artifactCatalog(specId).toJSON();
    const issueBefore = restarted.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "draft-gate-repair",
    });
    const agent = { async call() { assert.fail("stale context must be refused before worker execution"); } };
    const resumed = activeDispatch(root, specId, restarted, agent);
    const result = await resumed.dispatcher.execute(resumed.context);
    assert.equal(result.errors?.[0]?.code, "FLOW_DRAFT_EXECUTION_INPUT_STALE", JSON.stringify(result, null, 2));
    assert.equal(result.data.retryBudgetConsumed, false);
    const activityDelta = restarted.activityLedger(specId).slice(activitiesBefore.length);
    assert.deepEqual(activityDelta, [], JSON.stringify(activityDelta.map((entry) => ({
      operation: entry.transition?.operation,
      nodeId: entry.nodeId,
    }))));
    assert.deepEqual(restarted.canonicalState(specId).toJSON(), before);
    assert.deepEqual(restarted.artifactCatalog(specId).toJSON(), catalogBefore);
    const issueAfter = restarted.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "draft-gate-repair",
    });
    assert.deepEqual(issueAfter.descriptor, issueBefore.descriptor);
    assert.deepEqual(issueAfter.bytes, issueBefore.bytes);
    assert.equal(executionState(restarted, specId).lifecycle.phase, "checkpoint");
  } finally {
    removeTmpDir(root);
  }
});

it("starts the next Draft refine generation after publication and dispatcher restart", async () => {
  const root = fixtureRepository("draft-next-generation-restart-");
  try {
    const specId = "824-draft-next-generation-restart";
    const first = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: first, specId, runId: "run-draft-next-generation-restart",
      request: "Resume a published Draft refinement in its next worker generation.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      autoApprove: true,
    }).create().registerActive().activate("draft");
    const source = canonicalDraftDocument({
      goal: "Retain a candidate question through successive worker generations.",
      questions: [{
        state: "CandidateQuestion", id: "q1",
        question: "Which public behavior should be selected?",
        category: "user-visible-behavior", revision: 0,
        provenance: { producer: "worker-handoff-fixture" },
        evidenceDigest: "a".repeat(64),
      }],
    });
    const published = structuredClone(source);
    published.analysis.validation = "The first refinement preserves the candidate and updates validation.";
    first.publishArtifacts({
      specId, nodeId: "draft",
      artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json",
        bytes: Buffer.from(workerArtifactJson(source)),
      }],
    });
    fixture.settle("draft").activate("draft-refine");
    const selected = first.canonicalState(specId).attempt;
    const calls = [];
    const agent = {
      async call(_prompt, options) {
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        calls.push(request);
        assert.equal(request.stepId, "draft-refine");
        assert.deepEqual(requestInput(request, "draft.json").document,
          calls.length === 1 ? source : published);
        fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(published));
        sealWorkerArtifactHandoff({
          requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
        });
        return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
      },
    };

    const initial = activeDispatch(root, specId, first, agent);
    const firstResult = await initial.dispatcher.execute(initial.context);
    assert.equal(firstResult.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(firstResult, null, 2));
    assert.equal(calls.length, 1);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const checkpoint = reloaded.draftStepExecutionState({
      binding: { runId: reloaded.canonicalState(specId).runId, specId, stepId: "draft-refine", attempt: selected },
    });
    assert.equal(checkpoint.lifecycle.phase, "checkpoint");
    assert.equal(checkpoint.lifecycle.executionGeneration, 1);
    assert.equal(checkpoint.lifecycle.claim, null);
    assert.equal(reloaded.canonicalState(specId).attempt.id, selected.id);
    assert.deepEqual(reloaded.canonicalState(specId).attempt.consumption.toJSON(), selected.consumption.toJSON());
    const firstPublishedDraft = reloaded.readArtifact({
      specId, logicalKey: "draft", consumerNodeId: "draft-refine",
    });
    assert.deepEqual(JSON.parse(firstPublishedDraft.bytes.toString("utf8")), published);

    const resumed = activeDispatch(root, specId, reloaded, agent);
    const secondResult = await resumed.dispatcher.execute(resumed.context);
    assert.equal(secondResult.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(secondResult, null, 2));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].dispatchInvocationId, calls[1].dispatchInvocationId);
    assert.equal(requestInput(calls[1], "draft.json").digest, firstPublishedDraft.descriptor.hash);
    const after = reloaded.draftStepExecutionState({
      binding: { runId: reloaded.canonicalState(specId).runId, specId, stepId: "draft-refine", attempt: selected },
    });
    assert.equal(after.lifecycle.phase, "checkpoint");
    assert.equal(after.lifecycle.executionGeneration, 2);
    assert.equal(after.lifecycle.claim, null);
    assert.deepEqual(reloaded.activityLedger(specId)
      .map((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle?.phase)
      .filter((phase) => phase !== undefined).slice(-6),
      ["claimed", "publication", "checkpoint", "claimed", "publication", "checkpoint"]);
    assert.equal(reloaded.canonicalState(specId).attempt.id, selected.id);
    assert.deepEqual(reloaded.canonicalState(specId).attempt.consumption.toJSON(), selected.consumption.toJSON());
  } finally {
    removeTmpDir(root);
  }
});

it("recovers a proven legacy Gate repair checkpoint once and starts a fresh worker after reload", async () => {
  const root = fixtureRepository("draft-legacy-checkpoint-recovery-");
  try {
    const specId = "825-draft-legacy-checkpoint-recovery";
    const { manager: first, request } = await legacyFailedRepairBoundary(root, specId);
    const failed = first.canonicalState(specId);
    const consumption = failed.attempt.consumption.toJSON();
    const priorActivities = first.activityLedger(specId);
    assert.equal(failed.attempt.failure.code, "FLOW_DRAFT_EXECUTION_INPUT_STALE");
    assert.equal(executionState(first, specId).lifecycle.binding.kind, "worker");
    assert.equal(fs.existsSync(request.requestPath), false);

    const restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const recoveryContext = activeDispatch(root, specId, restarted, {
      async call() { assert.fail("recovery command must not start a worker"); },
    }).context;
    const next = await new GetNextActionCommand().execute(recoveryContext);
    assert.equal(next.directive.kind, "execute_command");
    assert.equal(next.directive.actionId, "RECOVER_DRAFT_EXECUTION");
    assert.match(next.directive.nextAction, /sennel flow run recover-draft-execution/);
    const recovered = new RunRecoverDraftExecutionCommand().execute(recoveryContext);
    assert.equal(recovered.ok, true, JSON.stringify(recovered, null, 2));
    assert.equal(recovered.data.executionGeneration, 2);
    const recoveredExecution = executionState(restarted, specId).lifecycle;
    assert.equal(recoveredExecution.phase, "checkpoint");
    assert.equal(recoveredExecution.binding.kind, "conditional-worker");
    assert.equal(recoveredExecution.binding.executionGeneration, 2);
    assert.equal(recoveredExecution.claim, null);
    assert.equal(restarted.canonicalState(specId).attempt.failure, null);
    assert.equal(restarted.canonicalState(specId).attempt.id, failed.attempt.id);
    assert.equal(restarted.canonicalState(specId).attempt.sequence, failed.attempt.sequence);
    assert.deepEqual(restarted.canonicalState(specId).attempt.consumption.toJSON(), consumption);
    assert.equal(fs.existsSync(request.requestPath), false);
    const recoveryActivities = restarted.activityLedger(specId).slice(priorActivities.length);
    assert.deepEqual(recoveryActivities.map((entry) => entry.transition.operation), ["recover_draft_worker_execution"]);
    assert.deepEqual(restarted.activityLedger(specId).slice(0, priorActivities.length), priorActivities);

    const afterRecovery = restarted.canonicalState(specId).toJSON();
    const afterActivities = restarted.activityLedger(specId);
    const replay = new RunRecoverDraftExecutionCommand().execute({
      ...recoveryContext, flowState: restarted.loadReadOnly(specId),
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.errors?.[0]?.code, "FLOW_DRAFT_EXECUTION_RECOVERY_INELIGIBLE");
    assert.deepEqual(restarted.canonicalState(specId).toJSON(), afterRecovery);
    assert.deepEqual(restarted.activityLedger(specId), afterActivities);

    const resumed = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const calls = [];
    const agent = validRepairAgent((nextRequest) => {
        calls.push(nextRequest);
        const active = resumed.canonicalState(specId).attempt;
        assert.equal(active.id, failed.attempt.id);
        assert.equal(active.sequence, failed.attempt.sequence);
        assert.deepEqual(active.consumption.toJSON(), consumption);
        const claim = executionState(resumed, specId).lifecycle;
        assert.equal(claim.phase, "claimed");
        assert.equal(claim.binding.executionGeneration, 2);
        assert.equal(claim.claim.dispatchInvocationId, nextRequest.dispatchInvocationId);
    });
    const dispatch = activeDispatch(root, specId, resumed, agent);
    const result = await dispatch.dispatcher.execute(dispatch.context);
    assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].dispatchInvocationId, request.dispatchInvocationId);
    assert.equal(resumed.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
  } finally {
    removeTmpDir(root);
  }
});

it("refuses legacy recovery when its canonical worker context changed", async () => {
  const root = fixtureRepository("draft-legacy-recovery-stale-");
  try {
    const specId = "826-draft-legacy-recovery-stale";
    const { target } = await legacyFailedRepairBoundary(root, specId);
    fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
      guardrails: [{
        id: "DRAFT-REPAIRED", title: "Repaired Draft reaches Gate",
        body: "The recovery input changed after the old checkpoint.",
        meta: { phase: ["draft"], category: "requirements" },
      }],
    }));
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const before = reloaded.canonicalState(specId).toJSON();
    const activities = reloaded.activityLedger(specId);
    const catalog = reloaded.artifactCatalog(specId).toJSON();
    assert.throws(() => reloaded.recoverLegacyDraftWorkerExecution({
      specId, targetDigest: target.digest, executionRoot: root,
    }), /retained input digests/);
    assert.deepEqual(reloaded.canonicalState(specId).toJSON(), before);
    assert.deepEqual(reloaded.activityLedger(specId), activities);
    assert.deepEqual(reloaded.artifactCatalog(specId).toJSON(), catalog);
  } finally {
    removeTmpDir(root);
  }
});

it("refuses legacy recovery for an Attempt without the retained claim and failure", () => {
  const root = fixtureRepository("draft-legacy-recovery-foreign-attempt-");
  try {
    const specId = "827-draft-legacy-recovery-foreign-attempt";
    const manager = startRepairBoundary(root, specId, "run-draft-legacy-recovery-foreign-attempt");
    const before = manager.canonicalState(specId).toJSON();
    const activities = manager.activityLedger(specId);
    const target = FlowDispatchTarget.captureContext(activeDispatch(root, specId, manager, {
      async call() { assert.fail("recovery refusal must not start a worker"); },
    }).context);
    assert.throws(() => manager.recoverLegacyDraftWorkerExecution({
      specId, targetDigest: target.digest, executionRoot: root,
    }), (error) => error?.code === "FLOW_DRAFT_EXECUTION_RECOVERY_INELIGIBLE");
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before);
    assert.deepEqual(manager.activityLedger(specId), activities);
  } finally {
    removeTmpDir(root);
  }
});

it("recovers an unfailed legacy checkpoint before its first stale retry", async () => {
  const root = fixtureRepository("draft-legacy-unfailed-recovery-");
  try {
    const specId = "828-draft-legacy-unfailed-recovery";
    const { manager: first, request } = await legacyFailedRepairBoundary(root, specId, { fail: false });
    const selected = first.canonicalState(specId).attempt;
    const consumption = selected.consumption.toJSON();
    assert.equal(selected.failure, null);
    assert.equal(executionState(first, specId).lifecycle.binding.kind, "worker");
    assert.equal(fs.existsSync(request.requestPath), false);

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const ctx = activeDispatch(root, specId, reloaded, {
      async call() { assert.fail("recovery command must not start a worker"); },
    }).context;
    const next = await new GetNextActionCommand().execute(ctx);
    assert.equal(next.directive.actionId, "RECOVER_DRAFT_EXECUTION");
    assert.match(next.directive.nextAction, /sennel flow run recover-draft-execution/);
    const recovered = new RunRecoverDraftExecutionCommand().execute(ctx);
    assert.equal(recovered.ok, true, JSON.stringify(recovered, null, 2));
    assert.equal(recovered.data.executionGeneration, 2);
    assert.equal(reloaded.canonicalState(specId).attempt.id, selected.id);
    assert.equal(reloaded.canonicalState(specId).attempt.sequence, selected.sequence);
    assert.deepEqual(reloaded.canonicalState(specId).attempt.consumption.toJSON(), consumption);
    assert.equal(fs.existsSync(request.requestPath), false);

    const resumed = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const calls = [];
    const agent = validRepairAgent((nextRequest) => {
      calls.push(nextRequest);
      const active = resumed.canonicalState(specId).attempt;
      assert.equal(active.id, selected.id);
      assert.equal(active.sequence, selected.sequence);
      assert.deepEqual(active.consumption.toJSON(), consumption);
      const claim = executionState(resumed, specId).lifecycle;
      assert.equal(claim.phase, "claimed");
      assert.equal(claim.binding.executionGeneration, 2);
    });
    const dispatch = activeDispatch(root, specId, resumed, agent);
    const result = await dispatch.dispatcher.execute(dispatch.context);
    assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].dispatchInvocationId, request.dispatchInvocationId);
    assert.equal(resumed.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
  } finally {
    removeTmpDir(root);
  }
});

it("rejects legacy recovery when external context changes between preview and commit", async (t) => {
  const root = fixtureRepository("draft-legacy-recovery-race-");
  try {
    const specId = "829-draft-legacy-recovery-race";
    const { target } = await legacyFailedRepairBoundary(root, specId);
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const before = manager.canonicalState(specId).toJSON();
    const activities = manager.activityLedger(specId);
    const catalog = manager.artifactCatalog(specId).toJSON();
    const capture = DraftWorkerRecoveryInputPreview.capture;
    let captures = 0;
    t.mock.method(DraftWorkerRecoveryInputPreview, "capture", (input) => {
      captures += 1;
      if (captures === 2) {
        fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
          guardrails: [{
            id: "DRAFT-REPAIRED", title: "Repaired Draft reaches Gate",
            body: "Changed after the initial recovery preview.",
            meta: { phase: ["draft"], category: "requirements" },
          }],
        }));
      }
      return capture(input);
    });
    assert.throws(() => manager.recoverLegacyDraftWorkerExecution({
      specId, targetDigest: target.digest, executionRoot: root,
    }), /inputs changed before publication/);
    assert.equal(captures, 2);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before);
    assert.deepEqual(manager.activityLedger(specId), activities);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), catalog);
  } finally {
    removeTmpDir(root);
  }
});


it("validates replacement shapes before sealing and lets the same producer correct its payload", async () => {
  const root = fixtureRepository("draft-producer-preview-");
  try {
    const specId = "822-draft-producer-preview";
    const manager = startRepairBoundary(root, specId, "run-draft-producer-preview");
    const before = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).bytes;
    let calls = 0;
    const agent = { async call(_prompt, options) {
      calls++;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      assert.match(request.workerInstructions.schemaGuidance, /boundary, relevance, owner/);
      const payloadPath = requestPayloadPath(request, "draft-gate-repair.json");
      const payload = repairPayload(request);
      payload.operations = [{ kind: "replace-value", path: "decisionMap.deferredToSpec",
        replacement: [{ boundary: "Retain interfaces", relevance: "Verify parity", owner: "spec", migrationInventory: {} }],
        reason: "Record parity inventory" }];
      fs.writeFileSync(payloadPath, workerArtifactJson(payload));
      const input = { requestPath, invocationId: request.dispatchInvocationId };
      assert.throws(() => sealWorkerArtifactHandoff(input), (error) => {
        assert.equal(error.code, "FLOW_DRAFT_GATE_REPAIR_INVALID");
        assert.match(error.message, /unknown field.*migrationInventory/);
        return true;
      });
      assert.equal(fs.existsSync(path.join(path.dirname(requestPath), "handoff.json")), false);
      assert.deepEqual(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).bytes, before);
      payload.operations[0].replacement[0] = { boundary: "Retain interfaces and enumerate migration inventory", relevance: "Verify parity of retained behavior", owner: "spec" };
      fs.writeFileSync(payloadPath, workerArtifactJson(payload));
      assert.equal(sealWorkerArtifactHandoff(input).sealed, true);
      return "sealed";
    } };
    const run = activeDispatch(root, specId, manager, agent);
    await run.dispatcher.execute(run.context);
    assert.equal(calls, 1);
    const draft = JSON.parse(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).bytes);
    assert.equal(draft.decisionMap.deferredToSpec[0].boundary, "Retain interfaces and enumerate migration inventory");
  } finally { removeTmpDir(root); }
});

it("corrects revision and replacement-shape rejections with durable feedback in one dispatcher", async () => {
  const root = fixtureRepository("draft-producer-correction-");
  try {
    const specId = "823-draft-producer-correction";
    const manager = startRepairBoundary(root, specId, "run-draft-producer-correction");
    const original = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).bytes;
    const requests = [];
    const agent = { async call(_prompt, options) {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      requests.push(request);
      assert.deepEqual(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).bytes, original);
      const payload = repairPayload(request);
      if (requests.length === 1) payload.baseRevision = `sha256:${"0".repeat(64)}`;
      if (requests.length === 2) payload.operations = [{ kind: "replace-value", path: "decisionMap.deferredToSpec",
        replacement: [{ boundary: "Retain interfaces", relevance: "Verify parity", owner: "spec", migrationInventory: {} }], reason: "Record parity" }];
      fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(payload));
      if (requests.length < 3) {
        assert.throws(() => sealWorkerArtifactHandoff({ requestPath, invocationId: request.dispatchInvocationId }),
          { code: "FLOW_DRAFT_GATE_REPAIR_INVALID" });
        return "producer stopped after validation diagnostic";
      }
      assert.match(request.workerInstructions.retryFeedback.message, /migrationInventory/);
      sealWorkerArtifactHandoff({ requestPath, invocationId: request.dispatchInvocationId });
      return "sealed";
    } };
    const run = activeDispatch(root, specId, manager, agent, { maxDispatches: 3 });
    const result = await run.dispatcher.execute(run.context);
    assert.equal(result.errors[0].code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result));
    assert.equal(requests.length, 3);
    assert.equal(requests[0].workerInstructions.retryFeedback, null);
    assert.match(requests[1].workerInstructions.retryFeedback.message, /base revision mismatch/);
    assert.equal(requests[1].workerInstructions.retryFeedback.remainingCalls, 2);
    assert.equal(requests[2].workerInstructions.retryFeedback.remainingCalls, 1);
    assert.equal(new Set(requests.map((r) => r.dispatchInvocationId)).size, 3);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const rejections = reloaded.activityLedger(specId).map((e) => e.result?.draftSettlementReceipt?.executionLifecycle?.rejection).filter(Boolean);
    assert.equal(rejections.length, 2);
    assert.match(rejections[0].message, /base revision mismatch/);
    assert.match(rejections[1].message, /migrationInventory/);
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
    const draft = JSON.parse(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).bytes);
    assert.equal(draft.analysis.validation, "Verify the retained behavior after the restarted Gate repair.");
  } finally { removeTmpDir(root); }
});

it("retains the producer correction limit across restarts and refuses a fourth worker", async () => {
  const root = fixtureRepository("draft-producer-exhaustion-");
  try {
    const specId = "824-draft-producer-exhaustion";
    let manager = startRepairBoundary(root, specId, "run-draft-producer-exhaustion");
    const original = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).bytes;
    let calls = 0;
    const agent = { async call(_prompt, options) {
      calls++;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const payload = repairPayload(request);
      payload.baseRevision = `sha256:${"0".repeat(64)}`;
      fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(payload));
      assert.throws(() => sealWorkerArtifactHandoff({ requestPath, invocationId: request.dispatchInvocationId }),
        { code: "FLOW_DRAFT_GATE_REPAIR_INVALID" });
      return "invalid payload retained for parent diagnostic";
    } };
    for (let i = 0; i < 3; i++) {
      const run = activeDispatch(root, specId, manager, agent);
      await run.dispatcher.execute(run.context);
      manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    }
    assert.equal(calls, 3);
    const state = manager.canonicalState(specId);
    assert.deepEqual(state.attempt.consumption.toJSON(), { semantic: 0, tooling: 0 });
    assert.deepEqual(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).bytes, original);
    const run = activeDispatch(root, specId, manager, agent);
    const command = new GetNextActionCommand();
    const next = await command.execute(run.context);
    assert.equal(next.directive.kind, "blocked");
    assert.equal(next.directive.code, "FLOW_DRAFT_WORKER_CORRECTION_EXHAUSTED");
    const ledger = manager.activityLedger(specId);
    await run.dispatcher.execute(run.context);
    assert.equal(calls, 3);
    assert.deepEqual(manager.activityLedger(specId), ledger);
    const execution = executionState(manager, specId);
    const lastClaim = ledger.findLast((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "claimed")
      .result.draftSettlementReceipt.executionLifecycle.claim;
    assert.throws(() => manager.claimDraftStepExecution({
      binding: new DraftWorkerExecutionStepBinding({ flowManager: manager, specId, stepId: "draft-gate-repair" }),
      ...execution.executionIdentity(), executionBinding: execution.lifecycle.binding,
      executionClaim: new DraftWorkerExecutionClaim(lastClaim),
    }), /correction budget is exhausted/);
    assert.deepEqual(manager.activityLedger(specId), ledger);
  } finally { removeTmpDir(root); }
});

it("retains different rejected invocations in the issue log without retrying unauthorized operations", async () => {
  const root = fixtureRepository("draft-rejection-diagnostics-");
  try {
    const specId = "825-draft-rejection-diagnostics";
    let manager = startRepairBoundary(root, specId, "run-draft-rejection-diagnostics");
    let calls = 0;
    const invocations = [];
    const agent = { async call(_prompt, options) {
      calls++;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      invocations.push(request.dispatchInvocationId);
      const payload = repairPayload(request);
      const draft = requestInput(request, "draft.json").document;
      payload.operations = [{ kind: "replace-value", path: "questionLedger",
        replacement: draft.questionLedger, reason: `unauthorized proposal ${calls}` }];
      fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(payload));
      assert.throws(() => sealWorkerArtifactHandoff({ requestPath, invocationId: request.dispatchInvocationId }),
        { code: "FLOW_DRAFT_GATE_REPAIR_INVALID" });
      return "parent must reject unauthorized proposal";
    } };
    for (let index = 0; index < 2; index++) {
      const run = activeDispatch(root, specId, manager, agent, { maxDispatches: 10 });
      const result = await run.dispatcher.execute(run.context);
      assert.equal(result.errors[0].code, "FLOW_DRAFT_GATE_REPAIR_INVALID");
      assert.equal(calls, index + 1);
      manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    }
    const entries = JSON.parse(manager.readArtifact({ specId, logicalKey: "issue.log", consumerNodeId: "draft-gate-repair" }).bytes).entries
      .filter((entry) => entry.reason.startsWith("Worker artifact handoff invalid:"));
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].issueLogId, entries[1].issueLogId);
    for (let i = 0; i < 2; i++) assert.ok(entries[i].issueLogId.includes(invocations[i]));
    assert.deepEqual(manager.canonicalState(specId).attempt.consumption.toJSON(), { semantic: 0, tooling: 0 });
  } finally { removeTmpDir(root); }
});

it("reconstructs correction feedback after a transport retry claim is interrupted", async () => {
  const root = fixtureRepository("draft-correction-transport-restart-");
  try {
    const specId = "826-draft-correction-transport";
    let manager = startRepairBoundary(root, specId, "run-draft-correction-transport");
    let calls = 0;
    let correctionDigest;
    const claim = manager.claimDraftStepExecution.bind(manager);
    manager.claimDraftStepExecution = (input) => {
      const result = claim(input);
      if (input.executionBinding.executionGeneration === 2) {
        correctionDigest = input.executionClaim.requestDigest;
        throw new Error("interrupt transport retry after claim");
      }
      return result;
    };
    const agent = { async call(_prompt, options) {
      calls++;
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const payload = repairPayload(request);
      if (calls === 1) {
        payload.report.results = "invalid report";
        fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson(payload));
      } else {
        assert.equal(request.workerInstructions.retryFeedback.code, "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID");
        fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), "{broken");
      }
      return "unsealed producer failure";
    } };
    const interrupted = activeDispatch(root, specId, manager, agent, { maxDispatches: 5 });
    await assert.rejects(() => interrupted.dispatcher.execute(interrupted.context), /interrupt transport retry after claim/);
    assert.equal(calls, 2);
    manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(executionState(manager, specId).lifecycle.phase, "claimed");
    const restarted = activeDispatch(root, specId, manager, validRepairAgent((request) => {
      assert.equal(workerArtifactDigest(request), correctionDigest);
      assert.equal(request.workerInstructions.retryFeedback.code, "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID");
    }));
    const result = await restarted.dispatcher.execute(restarted.context);
    assert.equal(result.errors[0].code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result));
    assert.equal(manager.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
  } finally { removeTmpDir(root); }
});
