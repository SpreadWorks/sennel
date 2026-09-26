import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { DraftService } from "../../../src/flow/services/draft-service.js";
import { StepPersistenceFailure, STEP_RESULT_ERROR_PERSISTENCE_FAILURE_CODE } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { AgentAuthenticationFailure } from "../../../src/lib/agent-failure.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalDraftReviewSource } from "../../../src/flow/lib/canonical-review-artifacts.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import {
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffError,
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import {
  CanonicalFlowFixture,
  canonicalDraftDocument,
} from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import {
  dispatchContainer,
  fixtureRepository,
  installGateProviderFake,
  requestInput,
  requestPayloadPath,
} from "../../support/infrastructure/flow-dispatch-scenario.js";

function startDraftFlow(root, suffix) {
  const specId = `801-draft-dispatch-${suffix}`;
  const runId = `run-draft-dispatch-${suffix}`;
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId,
    request: "Exercise Draft dispatcher authority lifecycle.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  return { flowManager, specId, runId, fixture };
}

function writeDraftGateRepair(request, replacement) {
  const recurrence = requestInput(request, "gate-observation-recurrence.json").document;
  fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson({
    version: 1,
    baseRevision: `sha256:${request.inputRevision}`,
    operations: [{
      kind: "replace-value",
      path: "analysis.validation",
      replacement,
      reason: "State the dispatcher authority regression scenario explicitly.",
    }],
    report: {
      version: 1,
      summary: "The repaired Draft states the dispatcher authority scenario.",
      results: recurrence.entries.map((entry) => ({
        fingerprint: entry.fingerprint,
        strategy: "Make the dispatcher authority scenario explicit.",
        summary: "The Draft now covers the required worker transition.",
        priorRepairInsufficiency: entry.recurrenceCount > 0
          ? "The previous Draft did not cover the worker transition."
          : null,
      })),
    },
  }));
}

function createAgent({ flowManager, specId, onRequest = () => {}, noProgress = false, afterGateRepair = () => {} }) {
  const initialDraft = canonicalDraftDocument({
    goal: "Release handoff authority between conditional Draft workers.",
  });
  const repairedValidation = "Verify a worker-free refinement followed by a worker-backed Gate repair.";
  return {
    repairedValidation,
    async call(_prompt, options) {
      const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
      const invocationId = options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
      const requestDocument = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const request = requestDocument;
      onRequest(request);
      if (request.stepId === "draft") {
        fs.writeFileSync(requestPayloadPath(request, "draft.json"), workerArtifactJson(initialDraft));
      } else if (request.stepId === "draft-gate-repair") {
        writeDraftGateRepair(request, noProgress ? requestInput(request, "draft.json").document.analysis.validation : repairedValidation);
        afterGateRepair(request);
      } else if (request.stepId === "spec") {
        const canonicalDraft = flowManager.readArtifact({
          specId,
          logicalKey: "draft",
          consumerNodeId: "spec",
        });
        const draftInput = requestInput(request, "draft.json");
        assert.equal(draftInput.digest, canonicalDraft.descriptor.hash);
        assert.deepEqual(draftInput.document, JSON.parse(canonicalDraft.bytes.toString("utf8")));
        fs.writeFileSync(requestPayloadPath(request, "spec.json"), workerArtifactJson(validWorkerHandoffTaskSpec()));
      } else {
        throw new Error(`unexpected Draft dispatcher worker: ${request.stepId}`);
      }
      sealWorkerArtifactHandoff({ requestPath, invocationId });
      return JSON.stringify({ sealed: true, requestDigest: requestDocument.requestDigest });
    },
  };
}

async function runReviewCommand(ctx, phase, onDraftSource = () => {}) {
  const command = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
      onDraftSource({ source, work });
      fs.writeFileSync(path.join(work.root, work.manifestDocument.output.basename), `${JSON.stringify({
        version: 2,
        phase,
        sourceDraft: "draft.json",
        sourceDraftRevision: source.revision,
        generatedAt: "2026-09-21T00:00:00.000Z",
        verdict: "PASS",
        summary: "The canonical Draft has no review findings.",
        blockingFindings: [],
        advisoryFindings: [],
        repairTargets: [],
      }, null, 2)}\n`);
      work.seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
  const commandCtx = { ...ctx, phase: "draft", config: {}, flowState: ctx.flowManager.loadReadOnly(ctx.specId) };
  const result = await command.execute(commandCtx);
  await FLOW_COMMANDS.run.review.post(commandCtx, result);
  return { ok: true, data: result, errors: [] };
}

async function runCanonicalGateCommand(ctx) {
  const commandCtx = { ...ctx, phase: "draft", config: {}, flowState: ctx.flowManager.loadReadOnly(ctx.specId) };
  const result = await new RunGateCommand().execute(commandCtx);
  await FLOW_COMMANDS.run.gate.post(commandCtx, result);
  return { ok: true, data: result, errors: [] };
}

async function runGateCommand(ctx, result) {
  const commandCtx = { ...ctx, phase: "draft", config: {}, flowState: ctx.flowManager.loadReadOnly(ctx.specId) };
  const promotion = new CanonicalGatePromotion({
    state: ctx.flowManager.canonicalState(ctx.specId),
    phase: "draft",
    nodeId: "draft-gate",
  }).promote(result === "pass"
    ? { result, artifacts: { phase: "draft", evaluations: [] } }
    : {
        result,
        artifacts: {
          phase: "draft",
          failureKind: "ai_semantic_fail",
          failureCode: "DRAFT_GATE_REJECTED",
          nextAction: {
            diagnosis: {
              observations: [{
                kind: "violation",
                failureMode: "guardrail-violation",
                requirementRef: "DRAFT",
                where: { file: "draft.json", locator: "analysis.validation" },
                observed: "The Draft must cover the handoff authority transition.",
                severity: "blocking",
                refs: ["DRAFT"],
              }],
            },
          },
        },
      });
  await FLOW_COMMANDS.run.gate.post(commandCtx, promotion);
  return { ok: true, data: promotion, errors: [] };
}

function createDispatcherScenario(root, suffix, {
  maxDispatches,
  coordinator = new WorkerArtifactHandoffCoordinator(),
  onRequest,
  afterGateRepair,
} = {}) {
  const { flowManager, specId, runId } = startDraftFlow(root, suffix);
  const requests = [];
  const executionEvents = [];
  let gateRuns = 0;
  const recordExecution = (kind, stepId) => {
    const attempt = flowManager.canonicalState(specId).attempt;
    executionEvents.push({
      kind,
      stepId,
      attemptId: attempt?.id ?? null,
      attemptSequence: attempt?.sequence ?? null,
    });
  };
  const agent = createAgent({
    flowManager,
    specId,
    afterGateRepair,
    onRequest(request) {
      requests.push(request);
      recordExecution("worker", request.stepId);
      onRequest?.(request);
    },
  });
  const dispatcher = new RunDispatchCommand({
    agent,
    handoffCoordinator: coordinator,
    repositoryFingerprint: () => `draft-dispatch-${suffix}`,
    maxDispatches,
    commandRunner: async ({ ctx, command }) => {
      const stepId = ctx.flowManager.canonicalState(specId).current.at(-1);
      recordExecution(command.commandName, stepId);
      if (command.commandName === "review") {
        const phase = stepId === "draft-questions-review" ? "draft-questions" : "draft-coverage";
        return runReviewCommand(ctx, phase);
      }
      if (command.commandName === "gate") {
        gateRuns += 1;
        return runGateCommand(ctx, gateRuns === 1 ? "fail" : "pass");
      }
      throw new Error(`unexpected dispatcher-owned command: ${command.commandName}`);
    },
  });
  dispatcher.container = dispatchContainer({ root, flowManager, agent });
  const binding = FlowTargetBinding.capture({
    flowState: flowManager.loadReadOnly(specId),
    mainRoot: root,
    authorityRoot: root,
  }).serialize();
  const context = {
    root,
    mainRoot: root,
    executionRoot: root,
    specId,
    flowManager,
    flowState: flowManager.loadReadOnly(specId),
    expectBinding: binding,
    _envelopeType: "run",
    _envelopeKey: "dispatch",
  };
  return {
    dispatcher, context, flowManager, specId, runId, requests, executionEvents, agent, binding,
  };
}

function errorCode(result) {
  return result.errors?.find((entry) => typeof entry?.code === "string")?.code ?? null;
}

async function observeAuthorityLeases(run) {
  const originalAcquire = FlowHandoffAuthorityLease.prototype.acquire;
  const originalRelease = FlowHandoffAuthorityLease.prototype.release;
  const leases = new Map();
  FlowHandoffAuthorityLease.prototype.acquire = function acquire() {
    const counts = leases.get(this) ?? { acquires: 0, releases: 0 };
    counts.acquires += 1;
    leases.set(this, counts);
    return originalAcquire.call(this);
  };
  FlowHandoffAuthorityLease.prototype.release = function release() {
    const counts = leases.get(this) ?? { acquires: 0, releases: 0 };
    counts.releases += 1;
    leases.set(this, counts);
    return originalRelease.call(this);
  };
  try {
    const value = await run();
    return { leases: [...leases.values()], value };
  } finally {
    FlowHandoffAuthorityLease.prototype.acquire = originalAcquire;
    FlowHandoffAuthorityLease.prototype.release = originalRelease;
  }
}

/** Prepare only the production Gate-repair boundary; this is not full-path evidence. */
function gateRepairBoundary(root, suffix, coordinator = new WorkerArtifactHandoffCoordinator(), noProgress = false) {
  const { flowManager, specId, runId, fixture } = startDraftFlow(root, suffix);
  flowManager.confirmCurrentAttempt({
    specId,
    artifactWrites: [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument({
        goal: "Exercise a fixture-prepared Gate repair boundary.",
      }), null, 2)}\n`),
    }],
  });
  fixture.activate("draft-gate");
  new DraftGateRepairScenario({ flowManager, root, specId }).select({
    issueLogId: `issue-${suffix}`,
    observations: [{
      kind: "violation",
      failureMode: "guardrail-violation",
      requirementRef: "DRAFT",
      where: { file: "draft.json", locator: "analysis.validation" },
      observed: "The conditional worker transition is absent.",
      severity: "blocking",
      refs: ["DRAFT"],
    }],
  });
  const requests = [];
  const agent = createAgent({ flowManager, specId, noProgress, onRequest: (request) => requests.push(request) });
  const dispatcher = new RunDispatchCommand({
    agent,
    handoffCoordinator: coordinator,
    repositoryFingerprint: () => `gate-repair-boundary-${suffix}`,
    maxDispatches: 1,
  });
  dispatcher.container = dispatchContainer({ root, flowManager, agent });
  const binding = FlowTargetBinding.capture({
    flowState: flowManager.loadReadOnly(specId),
    mainRoot: root,
    authorityRoot: root,
  }).serialize();
  return {
    dispatcher,
    flowManager,
    specId,
    requests,
    context: {
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      flowManager,
      flowState: flowManager.loadReadOnly(specId),
      expectBinding: binding,
      _envelopeType: "run",
      _envelopeKey: "dispatch",
    },
  };
}

describe("Draft dispatcher handoff authority lifecycle", { concurrency: false }, () => {

  it("checkpoints an unauthorized Gate repair handoff without consuming the Attempt budget", async () => {
    const root = fixtureRepository("draft-dispatch-unauthorized-gate-repair-");
    let claimedSnapshot = null;
    try {
      const scenario = createDispatcherScenario(root, "unauthorized-gate-repair", {
        maxDispatches: 16,
        onRequest(request) {
          if (request.stepId !== "draft-gate-repair") return;
          const state = scenario.flowManager.canonicalState(scenario.specId);
          const binding = {
            runId: state.runId,
            specId: state.specId,
            stepId: request.stepId,
            attempt: state.attempt,
          };
          const execution = scenario.flowManager.draftStepExecutionState({ binding });
          const identity = execution.executionIdentity();
          assert.equal(execution.lifecycle.phase, "claimed");
          claimedSnapshot = {
            lifecycle: execution.lifecycle.toJSON(),
            stepResult: identity.stepResult.toJSON(),
            settlement: identity.settlement.toJSON(),
            canonical: state.toJSON(),
            activities: scenario.flowManager.activityLedger(scenario.specId),
            catalog: scenario.flowManager.artifactCatalog(scenario.specId).toJSON().artifacts
              .map((entry) => structuredClone(entry.toJSON?.() ?? entry)),
            issueLog: scenario.flowManager.readArtifact({
              specId: scenario.specId,
              logicalKey: "issue.log",
              consumerNodeId: request.stepId,
              optional: true,
            }),
          };
        },
        afterGateRepair(request) {
          const payloadPath = requestPayloadPath(request, "draft-gate-repair.json");
          const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
          const draft = requestInput(request, "draft.json").document;
          // The payload is bounded and otherwise well-formed, but repair workers
          // have no authority to address the question ledger.
          payload.operations[0].path = "questionLedger";
          payload.operations[0].replacement = structuredClone(draft.questionLedger);
          fs.writeFileSync(payloadPath, workerArtifactJson(payload));
        },
      });

      const result = await scenario.dispatcher.execute(scenario.context);
      assert.ok(claimedSnapshot);
      assert.equal(result.ok, false);
      assert.equal(errorCode(result), "FLOW_DRAFT_GATE_REPAIR_INVALID");
      assert.equal(result.data.classification, "invalid");
      assert.equal(result.data.retryBudgetConsumed, false);
      assert.deepEqual(scenario.requests.map((request) => request.stepId), ["draft", "draft-gate-repair"]);

      const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: scenario.specId });
      const state = reloaded.canonicalState(scenario.specId);
      const binding = {
        runId: state.runId,
        specId: state.specId,
        stepId: "draft-gate-repair",
        attempt: state.attempt,
      };
      const execution = reloaded.draftStepExecutionState({ binding });
      const identity = execution.executionIdentity();
      assert.equal(execution.lifecycle.phase, "checkpoint");
      assert.equal(execution.lifecycle.executionGeneration, claimedSnapshot.lifecycle.binding.executionGeneration + 1);
      assert.deepEqual(execution.lifecycle.binding.toJSON(), {
        ...claimedSnapshot.lifecycle.binding,
        executionGeneration: claimedSnapshot.lifecycle.binding.executionGeneration + 1,
      });
      assert.deepEqual(identity.stepResult.toJSON(), claimedSnapshot.stepResult);
      assert.deepEqual(identity.settlement.toJSON(), claimedSnapshot.settlement);
      assert.equal(state.attempt.id, claimedSnapshot.canonical.attempt.id);
      assert.equal(state.attempt.sequence, claimedSnapshot.canonical.attempt.sequence);
      assert.deepEqual(state.attempt.consumption.toJSON(), claimedSnapshot.canonical.attempt.consumption);
      assert.equal(state.findNode("draft-gate-repair").result?.stepResult ?? null, null);
      assert.equal(state.findNode("draft-gate-repair").status, "in_progress");

      const activities = reloaded.activityLedger(scenario.specId);
      const activityDelta = activities.slice(claimedSnapshot.activities.length);
      assert.deepEqual(activityDelta.map((entry) => entry.transition.operation), [
        "record_metric", "record_draft_step_settlement", "publish_artifacts",
      ]);
      assert.equal(activityDelta[0].metric.phase, "draft-gate-repair");
      assert.equal(activityDelta[0].metric.kind, "agent");
      assert.equal(activityDelta[0].metric.callCount, 1);
      assert.equal(activities.length, claimedSnapshot.activities.length + 3);
      assert.deepEqual(activities.slice(0, claimedSnapshot.activities.length), claimedSnapshot.activities);
      const issueLog = reloaded.readArtifact({
        specId: scenario.specId,
        logicalKey: "issue.log",
        consumerNodeId: "draft-gate-repair",
      });
      const priorEntries = claimedSnapshot.issueLog === null
        ? [] : JSON.parse(claimedSnapshot.issueLog.bytes.toString("utf8")).entries;
      const entries = JSON.parse(issueLog.bytes.toString("utf8")).entries;
      assert.deepEqual(entries.slice(0, priorEntries.length), priorEntries);
      assert.equal(entries.length, priorEntries.length + 1);
      assert.equal(entries.at(-1).issueLogId, `worker-handoff-${result.data.actionDigest}-invalid`);
      assert.equal(entries.at(-1).step, "draft-gate-repair");
      const issuePublication = activityDelta.find((entry) => entry.id === issueLog.descriptor.activityId);
      assert.ok(issuePublication);
      assert.equal(issuePublication.transition.operation, "publish_artifacts");

      const catalogAfter = reloaded.artifactCatalog(scenario.specId).toJSON().artifacts
        .map((entry) => structuredClone(entry.toJSON?.() ?? entry));
      const changedKeys = catalogAfter.filter((after) => {
        const before = claimedSnapshot.catalog.find((entry) => entry.relativePath === after.relativePath);
        return before === undefined || JSON.stringify(before) !== JSON.stringify(after);
      }).map((entry) => entry.logicalKey).sort();
      assert.deepEqual(changedKeys, ["flow.activities", "flow.state", "issue.log"]);
      assert.deepEqual(catalogAfter.filter((entry) => !["flow.activities", "flow.state", "issue.log"].includes(entry.logicalKey)),
        claimedSnapshot.catalog.filter((entry) => !["flow.activities", "flow.state", "issue.log"].includes(entry.logicalKey)));
    } finally {
      removeTmpDir(root);
    }
  });

  it("retains an unpublished Draft Attempt and retry budget after provider refusal across restart", async () => {
    const root = fixtureRepository("draft-dispatch-provider-refusal-");
    try {
      const { flowManager, specId } = startDraftFlow(root, "provider-refusal");
      const calls = [];
      const agent = {
        async call(_prompt, options) {
          const request = JSON.parse(fs.readFileSync(options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST));
          calls.push(request);
          throw new AgentAuthenticationFailure({ message: "Draft provider credentials are unavailable." });
        },
      };
      const initial = flowManager.canonicalState(specId).toJSON();
      const catalogBefore = flowManager.artifactCatalog(specId).toJSON().artifacts;
      for (const restarted of [false, true]) {
        const manager = restarted ? new FlowManager({ root, mainRoot: root, inWorktree: false, specId }) : flowManager;
        const before = manager.canonicalState(specId).toJSON();
        const activityCount = manager.activityLedger(specId).length;
        const dispatcher = new RunDispatchCommand({ agent, repositoryFingerprint: () => "draft-provider-refusal", maxDispatches: 2 });
        dispatcher.container = dispatchContainer({ root, flowManager: manager, agent });
        const state = manager.loadReadOnly(specId);
        const result = await dispatcher.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: manager, flowState: state,
          expectBinding: FlowTargetBinding.capture({ flowState: state, mainRoot: root, authorityRoot: root }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
        if (manager !== flowManager) {
          assert.equal(result.dispatch.boundary, "blocked");
          assert.equal(result.dispatch.dispatchCount, 0);
          assert.equal(calls.length, 1);
          assert.deepEqual(manager.canonicalState(specId).toJSON(), before);
          assert.equal(manager.activityLedger(specId).length, activityCount);
          continue;
        }
        assert.equal(result.ok, false);
        assert.equal(errorCode(result), "FLOW_ARTIFACT_HANDOFF_MISSING");
        assert.equal(result.data.agentFailure.code, "AGENT_AUTHENTICATION_FAILED");
        assert.equal(result.data.retryBudgetConsumed, false);
        const after = manager.canonicalState(specId).toJSON();
        assert.equal(after.attempt.id, initial.attempt.id);
        assert.equal(after.attempt.sequence, initial.attempt.sequence);
        assert.deepEqual(after.attempt.consumption, initial.attempt.consumption);
        assert.equal(after.attempt.failure.category, "tooling");
        assert.equal(after.attempt.failure.code, "FLOW_ARTIFACT_HANDOFF_MISSING");
        assert.equal(after.attempt.failure.retryable, false);
        assert.equal(manager.canonicalState(specId).findNode("draft").result?.stepResult ?? null, null);
        assert.equal(manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate", optional: true }), null);
        assert.deepEqual(manager.artifactCatalog(specId).toJSON().artifacts.filter((entry) => !["issue.log", "flow.activities", "flow.state"].includes(entry.logicalKey)),
          catalogBefore.filter((entry) => !["issue.log", "flow.activities", "flow.state"].includes(entry.logicalKey)));
        const recorded = manager.activityLedger(specId).slice(activityCount);
        assert.deepEqual(recorded.map((entry) => entry.transition.operation), ["record_metric", "fail_attempt", "publish_artifacts"]);
        assert.equal(recorded[0].metric.callCount, 1);
        assert.equal(recorded[1].attemptId, before.attempt.id);
      }
      assert.deepEqual(calls.map((request) => request.stepId), ["draft"]);
    } finally {
      removeTmpDir(root);
    }
  });

  it("connects Draft entry through worker-free refine and Gate repair to the canonical Spec handoff", async () => {
    const root = fixtureRepository("draft-dispatch-full-");
    try {
      const scenario = createDispatcherScenario(root, "full", { maxDispatches: 16 });
      const result = await scenario.dispatcher.execute(scenario.context);

      assert.equal(errorCode(result), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
      assert.deepEqual(scenario.requests.map((request) => request.stepId), ["draft", "draft-gate-repair", "spec"]);
      assert.deepEqual(
        scenario.executionEvents
          .filter((event) => ["review", "gate"].includes(event.kind))
          .map(({ kind, stepId }) => [kind, stepId]),
        [
          ["review", "draft-questions-review"],
          ["review", "draft-coverage-review"],
          ["gate", "draft-gate"],
          ["review", "draft-coverage-review"],
          ["gate", "draft-gate"],
        ],
      );
      const coverageAttempts = scenario.executionEvents
        .filter((event) => event.kind === "review" && event.stepId === "draft-coverage-review");
      const gateAttempts = scenario.executionEvents
        .filter((event) => event.kind === "gate" && event.stepId === "draft-gate");
      assert.equal(coverageAttempts.length, 2);
      assert.equal(gateAttempts.length, 2);
      assert.notEqual(coverageAttempts[0].attemptId, coverageAttempts[1].attemptId);
      assert.ok(coverageAttempts[1].attemptSequence > coverageAttempts[0].attemptSequence);
      assert.notEqual(gateAttempts[0].attemptId, gateAttempts[1].attemptId);
      assert.ok(gateAttempts[1].attemptSequence > gateAttempts[0].attemptSequence);
      const canonicalDraft = scenario.flowManager.readArtifact({
        specId: scenario.specId,
        logicalKey: "draft",
        consumerNodeId: "spec",
      });
      assert.equal(JSON.parse(canonicalDraft.bytes.toString("utf8")).analysis.validation, scenario.agent.repairedValidation);
      assert.equal(scenario.flowManager.canonicalState(scenario.specId).nextAction().nodeId, "spec-review");
    } finally {
      removeTmpDir(root);
    }
  });

  it("releases handoff authority after worker-free draft-refine settlement", async () => {
    const root = fixtureRepository("draft-dispatch-refine-release-");
    try {
      const scenario = createDispatcherScenario(root, "refine-release", { maxDispatches: 5 });
      const result = await scenario.dispatcher.execute(scenario.context);
      assert.equal(errorCode(result), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
      assert.equal(scenario.flowManager.canonicalState(scenario.specId).nextAction().nodeId, "draft-coverage-review");

      const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: scenario.specId });
      const refineSettlement = reloaded.activityLedger(scenario.specId).findLast((activity) => activity.nodeId === "draft-refine")
        ?.result?.draftSettlementReceipt;
      assert.equal(refineSettlement?.resultKind, "draft-refine-completed");
      assert.equal(refineSettlement?.settlementKind, "target-connection");
      assert.equal(refineSettlement?.targetStepId, "draft-coverage-review");
      assert.equal(refineSettlement?.executionLifecycle, null);
      assert.equal(reloaded.canonicalState(scenario.specId).nextAction().nodeId, "draft-coverage-review");

      const lease = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
      lease.acquire();
      lease.release();
    } finally {
      removeTmpDir(root);
    }
  });

  it("releases handoff authority when conditional Draft preparation throws", async () => {
    const root = fixtureRepository("draft-dispatch-prepare-error-");
    class PreparationFailureCoordinator extends WorkerArtifactHandoffCoordinator {
      createRequest(input) {
        const request = super.createRequest(input);
        if (input.invocation.action.nextAction.step === "draft-refine") {
          throw new Error("conditional Draft preparation fixture failure");
        }
        return request;
      }
    }
    try {
      const scenario = createDispatcherScenario(root, "prepare-error", {
        maxDispatches: 5,
        coordinator: new PreparationFailureCoordinator(),
      });
      await assert.rejects(
        () => scenario.dispatcher.execute(scenario.context),
        /conditional Draft preparation fixture failure/,
      );
      assert.deepEqual(scenario.requests.map((request) => request.stepId), ["draft"]);
      assert.equal(scenario.flowManager.canonicalState(scenario.specId).nextAction().nodeId, "draft-refine");
      const lease = new FlowHandoffAuthorityLease({ mainRoot: root, executionRoot: root });
      lease.acquire();
      lease.release();
    } finally {
      removeTmpDir(root);
    }
  });

  for (const noProgress of [false, true]) {
    it(`restores the published Gate selection across restart without candidate or provider repetition (${noProgress ? "no-progress" : "applied"})`, async (t) => {
      const root = fixtureRepository("draft-gate-publication-restart-");
      const adoption = t.mock.method(DraftService.prototype, "adoptRepairCandidate");
      const coordinator = new class extends WorkerArtifactHandoffCoordinator {
        publishDraftWorker(input) {
          super.publishDraftWorker(input);
          throw new WorkerArtifactHandoffError("recovery-required", "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED", "interrupt after publication", { recoveryPossible: true });
        }
      }();
      try {
        const scenario = gateRepairBoundary(root, `restart-${noProgress}`, coordinator, noProgress);
        await assert.rejects(() => scenario.dispatcher.execute(scenario.context), /interrupt after publication/);
        assert.equal(adoption.mock.callCount(), 1);
        assert.equal(scenario.requests.length, 1);
        const publications = scenario.flowManager.activityLedger(scenario.specId).filter((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication");
        assert.equal(publications.length, 1);
        const published = publications[0].result.draftSettlementReceipt;
        assert.equal(published.draftGateRepairSelection.outcome.disposition, noProgress ? "rejected-no-progress" : "applied");
        const beforeDraft = scenario.flowManager.readArtifact({ specId: scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" });
        const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: scenario.specId });
        const agent = { async call() { assert.fail("publication recovery must not call the provider"); } };
        const cleanupInterrupted = new WorkerArtifactHandoffCoordinator({ faultInjector({ phase }) {
          if (phase === "before-worker-handoff-cleanup-rename") throw new Error("retain terminal Gate handoff");
        } });
        const resumed = new RunDispatchCommand({ agent, handoffCoordinator: cleanupInterrupted, repositoryFingerprint: () => `gate-repair-boundary-restart-${noProgress}`, maxDispatches: 1 });
        resumed.container = dispatchContainer({ root, flowManager: reloaded, agent });
        await assert.rejects(() => resumed.execute({ ...scenario.context, flowManager: reloaded, flowState: reloaded.loadReadOnly(scenario.specId) }), /retain terminal Gate handoff/);
        assert.equal(adoption.mock.callCount(), 1);
        assert.equal(reloaded.canonicalState(scenario.specId).findNode("draft-gate-repair").status, "done");
        const afterDraft = reloaded.readArtifact({ specId: scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" });
        assert.deepEqual(afterDraft.descriptor, beforeDraft.descriptor);
        assert.deepEqual(afterDraft.bytes, beforeDraft.bytes);
        assert.equal(reloaded.activityLedger(scenario.specId).filter((entry) => entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication").length, 1);
        const terminalLedger = reloaded.activityLedger(scenario.specId);
        const terminalCatalog = reloaded.artifactCatalog(scenario.specId).toJSON();
        const third = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: scenario.specId });
        const cleanup = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: {
          ...scenario.context, flowManager: third, flowState: third.loadReadOnly(scenario.specId),
        } });
        assert.equal(cleanup.replayed, true);
        assert.equal(adoption.mock.callCount(), 1);
        assert.equal(scenario.requests.length, 1);
        assert.deepEqual(third.activityLedger(scenario.specId), terminalLedger);
        assert.deepEqual(third.artifactCatalog(scenario.specId).toJSON(), terminalCatalog);

      } finally { removeTmpDir(root); }
    });
  }

  it("checks fixture-prepared boundary contracts: releases authority once at worker, publication, and terminal exits", async (t) => {
    const cases = [
      {
        name: "worker",
        coordinator() {
          return new class extends WorkerArtifactHandoffCoordinator {
            prepareDraftWorker(input) {
              super.prepareDraftWorker(input);
              throw new WorkerArtifactHandoffError(
                "invalid",
                "FLOW_DRAFT_WORKER_EXIT_FIXTURE",
                "fixture stops after the sealed worker output is inspected",
                { retryable: false },
              );
            }
          }();
        },
        assertResult(result) {
          assert.equal(errorCode(result), "FLOW_DRAFT_WORKER_EXIT_FIXTURE", JSON.stringify(result, null, 2));
        },
      },
      {
        name: "publication",
        coordinator() {
          return new class extends WorkerArtifactHandoffCoordinator {
            publishDraftWorker(input) {
              super.publishDraftWorker(input);
              const { flowManager } = input.ctx;
              const specId = input.request.specId;
              this.published = {
                state: flowManager.canonicalState(specId).toJSON(),
                activities: flowManager.activityLedger(specId),
                catalog: flowManager.artifactCatalog(specId).toJSON(),
              };
              throw new WorkerArtifactHandoffError(
                "recovery-required",
                "FLOW_DRAFT_PUBLICATION_EXIT_FIXTURE",
                "fixture stops after conditional Draft publication",
                { retryable: false, recoveryPossible: true },
              );
            }
          }();
        },
        assertError(error) {
          assert.ok(error instanceof StepPersistenceFailure);
          assert.equal(error.code, STEP_RESULT_ERROR_PERSISTENCE_FAILURE_CODE);
          assert.ok(error.cause instanceof WorkerArtifactHandoffError);
          assert.equal(error.cause.code, "FLOW_DRAFT_PUBLICATION_EXIT_FIXTURE");
          assert.equal(error.cause.recoveryPossible, true);
          return true;
        },
        assertResult(_result, scenario, coordinator) {
          const { flowManager, specId } = scenario;
          const state = flowManager.canonicalState(specId);
          // The dispatcher records the completed provider invocation even when persistence stops.
          const activities = flowManager.activityLedger(specId);
          assert.deepEqual(activities.slice(0, coordinator.published.activities.length), coordinator.published.activities);
          const afterPublication = activities.slice(coordinator.published.activities.length);
          assert.equal(afterPublication.length, 1);
          assert.equal(afterPublication[0].transition.operation, "record_metric");
          assert.equal(afterPublication[0].metric.kind, "agent");
          assert.equal(afterPublication[0].metric.callCount, 1);
          assert.deepEqual(state.toJSON(), {
            ...coordinator.published.state,
            confirmationOrder: coordinator.published.state.confirmationOrder + 1,
          });
          const catalog = flowManager.artifactCatalog(specId).toJSON();
          const metadataKeys = new Set(["flow.activities", "flow.state"]);
          assert.deepEqual(catalog.artifacts.filter((artifact) => !metadataKeys.has(artifact.logicalKey)),
            coordinator.published.catalog.artifacts.filter((artifact) => !metadataKeys.has(artifact.logicalKey)));
          for (const logicalKey of metadataKeys) {
            assert.equal(catalog.artifacts.find((artifact) => artifact.logicalKey === logicalKey).activityId, afterPublication[0].id);
          }
          assert.equal(state.current.at(-1), "draft-gate-repair");
          assert.equal(state.attempt.failure, null);
          assert.deepEqual(state.attempt.consumption.toJSON(), { semantic: 0, tooling: 0 });
          const receipts = coordinator.published.activities
            .filter((entry) => entry.nodeId === "draft-gate-repair")
            .map((entry) => entry.result?.draftSettlementReceipt).filter(Boolean);
          assert.equal(receipts.filter((receipt) => receipt.executionLifecycle?.phase === "publication").length, 1);
          assert.equal(receipts.some((receipt) => receipt.executionLifecycle?.phase === "terminal"), false);
          assert.equal(coordinator.published.catalog.artifacts.some((artifact) => artifact.logicalKey === "draft.gate.repair"), true);
          assert.equal(coordinator.published.catalog.artifacts.some((artifact) => artifact.logicalKey === "plan.gate.repair.outcome"), false);
          assert.equal(scenario.requests.length, 1);
        },
      },
      {
        name: "terminal",
        coordinator: () => new WorkerArtifactHandoffCoordinator(),
        assertResult(result, scenario) {
          assert.equal(errorCode(result), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(result, null, 2));
          assert.equal(scenario.flowManager.canonicalState(scenario.specId).nextAction().nodeId, "draft-coverage-review");
        },
      },
    ];

    for (const boundary of cases) {
      await t.test(boundary.name, async () => {
        const root = fixtureRepository(`draft-dispatch-${boundary.name}-exit-`);
        try {
          const coordinator = boundary.coordinator();
          const scenario = gateRepairBoundary(root, `${boundary.name}-exit`, coordinator);
          const observed = await observeAuthorityLeases(() => boundary.assertError
            ? assert.rejects(() => scenario.dispatcher.execute(scenario.context), boundary.assertError)
            : scenario.dispatcher.execute(scenario.context));
          assert.ok(observed.leases.length >= 1);
          assert.equal(observed.leases.every((counts) => counts.acquires === 1 && counts.releases === 1), true);
          boundary.assertResult(observed.value, scenario, coordinator);
        } finally {
          removeTmpDir(root);
        }
      });
    }
  });

  it("continues a fixture-prepared boundary from Store readback and hands the exact canonical Draft to Spec", async () => {
    const root = fixtureRepository("draft-dispatch-readback-spec-");
    let gateAgentLookup;
    try {
      const repair = gateRepairBoundary(root, "readback-spec");
      const repaired = await repair.dispatcher.execute(repair.context);
      assert.equal(errorCode(repaired), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(repaired, null, 2));
      assert.equal(repair.flowManager.canonicalState(repair.specId).nextAction().nodeId, "draft-coverage-review");

      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: repair.specId });
      assert.equal(flowManager.canonicalState(repair.specId).nextAction().nodeId, "draft-coverage-review");
      const repairedDraft = flowManager.readArtifact({
        specId: repair.specId,
        logicalKey: "draft",
        consumerNodeId: "draft-coverage-review",
      });
      const repairedDocument = JSON.parse(repairedDraft.bytes.toString("utf8"));
      const repairedRevision = new CanonicalDraftReviewSource({
        flowManager,
        state: flowManager.loadReadOnly(repair.specId),
        phase: "draft-coverage",
      }).revision();
      assert.equal(repairedDocument.analysis.validation,
        "Verify a worker-free refinement followed by a worker-backed Gate repair.");
      assert.equal(repairedRevision.digest, repairedDraft.descriptor.hash);
      assert.equal(repairedRevision.sourceStepId, "draft-gate-repair");
      fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
        guardrails: [{
          id: "DRAFT-REPAIRED", title: "Repaired Draft reaches Gate",
          body: "Check the repaired validation behavior in the canonical Draft.",
          meta: { phase: ["draft"], category: "requirements" },
        }],
      }));
      const gatePrompts = [];
      gateAgentLookup = installGateProviderFake((prompt) => {
        gatePrompts.push(prompt);
        return JSON.stringify({ observations: [] });
      });
      const requests = [];
      const reviewInputs = [];
      const agent = createAgent({
        flowManager,
        specId: repair.specId,
        onRequest: (request) => requests.push(request),
      });
      const dispatcher = new RunDispatchCommand({
        agent,
        repositoryFingerprint: () => "draft-dispatch-readback-spec",
        maxDispatches: 6,
        commandRunner: async ({ ctx, command }) => {
          if (command.commandName === "review") return runReviewCommand(ctx, "draft-coverage", ({ source, work }) => {
            reviewInputs.push({
              source,
              input: work.manifestDocument.inputs.find((entry) => entry.logicalKey === "draft"),
              bytes: fs.readFileSync(path.join(work.root, "draft.json")),
            });
          });
          if (command.commandName === "gate") return runCanonicalGateCommand(ctx);
          throw new Error(`unexpected readback command: ${command.commandName}`);
        },
      });
      dispatcher.container = dispatchContainer({ root, flowManager, agent });
      const binding = FlowTargetBinding.capture({
        flowState: flowManager.loadReadOnly(repair.specId),
        mainRoot: root,
        authorityRoot: root,
      }).serialize();
      const continued = await dispatcher.execute({
        root,
        mainRoot: root,
        executionRoot: root,
        specId: repair.specId,
        flowManager,
        flowState: flowManager.loadReadOnly(repair.specId),
        expectBinding: binding,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(reviewInputs.length, 1);
      assert.deepEqual(reviewInputs[0].bytes, repairedDraft.bytes);
      assert.equal(reviewInputs[0].input.digest, repairedDraft.descriptor.hash);
      assert.deepEqual(reviewInputs[0].source.revision, repairedRevision);
      assert.ok(gatePrompts.length > 0);
      const contentHeader = "## Content\n";
      for (const prompt of gatePrompts) {
        assert.ok(prompt.includes(contentHeader));
        const evaluatedDraft = JSON.parse(prompt.slice(prompt.lastIndexOf(contentHeader) + contentHeader.length));
        assert.deepEqual(evaluatedDraft, repairedDocument);
      }
      for (const request of requests) {
        const specDraft = requestInput(request, "draft.json");
        assert.equal(specDraft.digest, repairedDraft.descriptor.hash);
        assert.deepEqual(specDraft.document, repairedDocument);
      }
      assert.deepEqual(requests.map((request) => request.stepId), ["spec"]);
      assert.equal(errorCode(continued), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(continued, null, 2));
      const coverageReview = flowManager.readArtifact({
        specId: repair.specId,
        logicalKey: "draft.coverage.review",
        consumerNodeId: "draft-coverage-triage",
      });
      const reviewHistory = JSON.parse(coverageReview.bytes.toString("utf8"));
      assert.deepEqual(reviewHistory.attempts.at(-1).artifact.payload.sourceDraftRevision, repairedRevision);
      assert.equal(flowManager.canonicalState(repair.specId).nextAction().nodeId, "spec-review");
      const draftAfterSpec = flowManager.readArtifact({
        specId: repair.specId,
        logicalKey: "draft",
        consumerNodeId: "spec",
      });
      assert.equal(draftAfterSpec.descriptor.hash, repairedDraft.descriptor.hash);
      assert.deepEqual(draftAfterSpec.bytes, repairedDraft.bytes);
      assert.equal(repairedDocument.analysis.validation, agent.repairedValidation);
    } finally {
      gateAgentLookup?.mock.restore();
      removeTmpDir(root);
    }
  });
});
