import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Container } from "../../../src/lib/container.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowHandoffAuthorityLease } from "../../../src/lib/flow-handoff-authority-lease.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
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
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";

function dispatchContainer({ root, flowManager, agent }) {
  const container = new Container();
  container.register("paths", { root, agentWorkDir: path.join(root, ".tmp") });
  container.register("mainRoot", root);
  container.register("config", {});
  container.register("inWorktree", false);
  container.register("flowManager", flowManager);
  container.register("agent", agent);
  return container;
}

function fixtureRepository(prefix) {
  const root = createTmpDir(prefix);
  try {
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    initGitRepo(root);
    fs.writeFileSync(path.join(root, "README.md"), "draft dispatcher fixture\n");
    commitAll(root, "draft dispatcher fixture");
    return root;
  } catch (error) {
    removeTmpDir(root);
    throw error;
  }
}

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

function requestInput(request, name) {
  const input = request.inputs.find((entry) => entry.name === name);
  assert.notEqual(input, undefined, `${request.stepId} request must contain ${name}`);
  return input;
}

function requestPayloadPath(request, logicalName) {
  const payload = request.payloads.find((entry) => entry.logicalName === logicalName);
  assert.notEqual(payload, undefined, `${request.stepId} request must contain ${logicalName}`);
  return payload.payloadPath;
}

function writeDraftGateRepair(request, replacement) {
  const draft = requestInput(request, "draft.json").document;
  const previous = draft.analysis.validation;
  const recurrence = requestInput(request, "gate-observation-recurrence.json").document;
  fs.writeFileSync(requestPayloadPath(request, "draft-gate-repair.json"), workerArtifactJson({
    version: 1,
    baseRevision: `sha256:${request.inputRevision}`,
    operations: [{
      kind: "replace-value",
      path: "analysis.validation",
      replacement,
      reason: "State the dispatcher authority regression scenario explicitly.",
      expectedDigest: crypto.createHash("sha256").update(JSON.stringify(previous)).digest("hex"),
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

function createAgent({ flowManager, specId, onRequest = () => {} }) {
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
        writeDraftGateRepair(request, repairedValidation);
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

async function runReviewCommand(ctx, phase) {
  const command = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const work = ReviewWorkUnit.fromEnvironment(options.env);
      const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
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

function createDispatcherScenario(root, suffix, { maxDispatches, coordinator = new WorkerArtifactHandoffCoordinator(), onRequest } = {}) {
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
function gateRepairBoundary(root, suffix, coordinator = new WorkerArtifactHandoffCoordinator()) {
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
  const agent = createAgent({ flowManager, specId, onRequest: (request) => requests.push(request) });
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
              throw new WorkerArtifactHandoffError(
                "recovery-required",
                "FLOW_DRAFT_PUBLICATION_EXIT_FIXTURE",
                "fixture stops after conditional Draft publication",
                { retryable: false, recoveryPossible: true },
              );
            }
          }();
        },
        assertResult(result) {
          assert.equal(errorCode(result), "FLOW_DRAFT_PUBLICATION_EXIT_FIXTURE", JSON.stringify(result, null, 2));
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
          const scenario = gateRepairBoundary(root, `${boundary.name}-exit`, boundary.coordinator());
          const observed = await observeAuthorityLeases(() => scenario.dispatcher.execute(scenario.context));
          assert.ok(observed.leases.length >= 1);
          assert.equal(observed.leases.every((counts) => counts.acquires === 1 && counts.releases === 1), true);
          boundary.assertResult(observed.value, scenario);
        } finally {
          removeTmpDir(root);
        }
      });
    }
  });

  it("continues a fixture-prepared boundary from Store readback and hands the exact canonical Draft to Spec", async () => {
    const root = fixtureRepository("draft-dispatch-readback-spec-");
    try {
      const repair = gateRepairBoundary(root, "readback-spec");
      const repaired = await repair.dispatcher.execute(repair.context);
      assert.equal(errorCode(repaired), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(repaired, null, 2));
      assert.equal(repair.flowManager.canonicalState(repair.specId).nextAction().nodeId, "draft-coverage-review");

      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: repair.specId });
      assert.equal(flowManager.canonicalState(repair.specId).nextAction().nodeId, "draft-coverage-review");
      const requests = [];
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
          if (command.commandName === "review") return runReviewCommand(ctx, "draft-coverage");
          if (command.commandName === "gate") return runGateCommand(ctx, "pass");
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

      assert.equal(errorCode(continued), "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(continued, null, 2));
      assert.deepEqual(requests.map((request) => request.stepId), ["spec"]);
      assert.equal(flowManager.canonicalState(repair.specId).nextAction().nodeId, "spec-review");
      const repairedDraft = flowManager.readArtifact({
        specId: repair.specId,
        logicalKey: "draft",
        consumerNodeId: "spec",
      });
      assert.equal(JSON.parse(repairedDraft.bytes.toString("utf8")).analysis.validation, agent.repairedValidation);
    } finally {
      removeTmpDir(root);
    }
  });
});
