import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Command } from "../../../src/lib/command.js";
import { AgentProcessStopEvidence } from "../../../src/lib/agent-failure.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { Envelope } from "../../../src/lib/flow-envelope.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import {
  buildCurrentFlowDefinition,
  DEFINITION_FAILURE_OWNERS,
  STEP_RESULT_ERROR_CATEGORY,
} from "../../../src/flow/definition.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { attachCanonicalCommandResultArtifact, CanonicalCommandAttemptArtifactHistory } from "../../../src/flow/lib/canonical-command-result.js";
import RunReviewCommand from "../../../src/flow/lib/run-review.js";
import {
  DraftQuestionsReviewExecutionRequiredResult,
  StepResult,
} from "../../../src/flow/engine/step-result.js";
import { GateService, ReviewService } from "../../../src/flow/services/review-service.js";
import { DraftReviewConnector } from "../../../src/flow/engine/connectors/draft/draft-review-connector.js";
import { CanonicalFlowFixture, FlowAtStepFixture, TaskLifecycleFixture, canonicalDraftDocument, produceCanonicalFixtureStep, setupFlowConfig } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { fixtureRepository, installGateProviderFake, passingGateProviderResponse } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { produceDraftReviewResult } from "../../support/infrastructure/query-draft-review-scenario.js";
import { validWorkerHandoffSpec, validWorkerHandoffTaskSpec } from "../../support/infrastructure/worker-artifact.js";
import { prepareTaskGateScenario, executeTaskGateScenario } from "../../support/infrastructure/task-gate-scenario.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";

async function canonicalFailureTarget({ root, specId, runId, nodeId }) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const spec = validWorkerHandoffSpec();
  await new FlowAtStepFixture({
    flowManager: manager, specId, runId, targetStep: nodeId,
    request: "Preserve the exact active Attempt when its registered command fails.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    specRecord: spec, taskDocuments: validWorkerHandoffTaskSpec().tasks,
  }).createWithProducers({
    implementationFiles: new Map(spec.requirements.map(({ id }) => [id, ["src/lifecycle.js"]])),
    sourceMutations: new Map([["implement", () => {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "lifecycle.js"), "export const lifecycle = true;\n");
    }]]),
  });
  return manager;
}

function commandContainer({ root, manager }) {
  const values = {
    paths: { root },
    flowManager: manager,
    mainRoot: root,
    config: null,
    inWorktree: false,
  };
  return {
    get(name) { return values[name] ?? null; },
    has(name) { return Object.hasOwn(values, name); },
  };
}

function hookContext({ root, manager, specId }) {
  return {
    root,
    mainRoot: root,
    executionRoot: root,
    flowManager: manager,
    flowState: manager.loadReadOnly(specId),
    specId,
    flowResolutionError: null,
  };
}

async function claimDraftQuestionsReviewExecution(manager, specId) {
  const root = manager.executionRoot();
  setupFlowConfig(root, "en");
  return produceDraftReviewResult({ ...hookContext({ root, manager, specId }), phase: "draft", config: {} }, "draft-questions");
}

async function produceDraftGateResult(manager, specId) {
  const root = manager.executionRoot();
  setupFlowConfig(root, "en");
  const provider = installGateProviderFake(passingGateProviderResponse);
  try {
    return await new RunGateCommand().execute({ ...hookContext({ root, manager, specId }), phase: "draft", config: {} });
  } finally { provider.mock.restore(); }
}

class ThrowingCommand extends Command {
  static outputMode = "envelope";
  static calls = 0;

  execute() {
    ThrowingCommand.calls += 1;
    const error = new Error("registry command fixture failed");
    error.code = "REGISTRY_COMMAND_FIXTURE_FAILED";
    throw error;
  }
}

async function dispatchRegistryCommand({ root, manager, specId, commandName, CommandClass = ThrowingCommand }) {
  const entry = flowCommands.run[commandName];
  const originalCommand = entry.command;
  const out = [];
  try {
    if (Object.hasOwn(CommandClass, "calls")) CommandClass.calls = 0;
    entry.command = async () => ({ default: CommandClass });
    await dispatch({
      container: commandContainer({ root, manager }),
      entry,
      argv: [],
      envelopeType: "run",
      envelopeKey: commandName,
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      setExitCode: () => {},
      buildHookCtx: () => hookContext({ root, manager, specId }),
    });
  } finally {
    entry.command = originalCommand;
  }
  return JSON.parse(out.join(""));
}

async function dispatchRegistryFailure(input) {
  return dispatchRegistryCommand(input);
}

async function taskGateFixture({ root, specId, evaluate = false }) {
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  await new TaskLifecycleFixture({
    flowManager: manager, specId, runId: `run-${specId}`,
    request: "Protect atomic Task Gate publication from a late dispatcher failure.",
    taskDocuments: [
      { id: "T-1", title: "First", goal: "Settle the first Task Gate", parent: null, origin: "plan", added_round: 0, status: "pending" },
      { id: "T-2", title: "Second", goal: "Receive the successor", parent: null, origin: "plan", added_round: 0, status: "pending" },
    ],
    taskId: "T-1", targetStep: "task-gate",
  }).createWithProducers({ sourceMutations: new Map([["T-1-impl", () => {
    fs.appendFileSync(path.join(root, "README.md"), "The first Task has material implementation evidence.\n");
  }]]) });
  const result = evaluate ? await produceCanonicalFixtureStep({
    ...hookContext({ root, manager, specId }), config: {},
  }, "T-1-gate", { settle: false }) : null;
  if (evaluate) assert.equal(result.result, "pass", JSON.stringify(result));
  return { manager, result };
}

function taskGateAttemptHistorySize(manager, specId) {
  const source = manager.readArtifact({
    specId, logicalKey: "task.gate", parameters: { taskId: "T-1" }, consumerNodeId: "T-1-impl",
  });
  return JSON.parse(source.bytes.toString("utf8")).attempts.length;
}

test("definition-owned registry command failures settle their exact active Attempt", async (t) => {
  for (const scenario of [
    { commandName: "test-execute", nodeId: "test-execute" },
    { commandName: "test-result-review", nodeId: "test-result-review" },
    { commandName: "retro", nodeId: "retro" },
    { commandName: "acceptance-review", nodeId: "acceptance-review" },
    { commandName: "final-regression", nodeId: "final-regression" },
  ]) {
    await t.test(`${scenario.commandName} command failure`, async () => {
      const root = fixtureRepository(`definition-lifecycle-${scenario.commandName}-`);
      try {
        const specId = `901-${scenario.commandName}`;
        const manager = await canonicalFailureTarget({ root, specId,
          runId: `run-${scenario.commandName}`, nodeId: scenario.nodeId });

        const envelope = await dispatchRegistryFailure({ root, manager, specId, commandName: scenario.commandName });
        const state = manager.canonicalState(specId);
        assert.equal(envelope.errors[0].code, "REGISTRY_COMMAND_FIXTURE_FAILED");
        assert.equal(ThrowingCommand.calls, 1, "the registry command executes exactly once");
        assert.equal(state.current.at(-1), scenario.nodeId);
        assert.equal(state.attempt.failure.code, "REGISTRY_COMMAND_FIXTURE_FAILED");
        assert.equal(state.attempt.failure.category, "tooling");
      } finally {
        removeTmpDir(root);
      }
    });
  }
});

test("failed envelope records tooling failure for a dispatcher-primary command", async () => {
  const root = createTmpDir("definition-lifecycle-envelope-");
  const entry = flowCommands.run["test-execute"];
  const originalCommand = entry.command;
  try {
    const specId = "902-test-execute-envelope";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-test-execute-envelope",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("test-execute");
    class FailedEnvelopeCommand extends Command {
      static outputMode = "envelope";
      execute() { return Envelope.fail("run", "test-execute", "TEST_EXECUTE_ENVELOPE_FAILED", "test execution envelope failed"); }
    }
    entry.command = async () => ({ default: FailedEnvelopeCommand });
    const out = [];
    await dispatch({
      container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: "test-execute",
      stdout: (chunk) => out.push(chunk), stderr: () => {}, setExitCode: () => {},
      buildHookCtx: () => hookContext({ root, manager, specId }),
    });
    assert.equal(JSON.parse(out.join("")).errors[0].code, "TEST_EXECUTE_ENVELOPE_FAILED");
    assert.equal(manager.canonicalState(specId).attempt.failure.retryKind, null);
  } finally {
    entry.command = originalCommand;
    removeTmpDir(root);
  }
});

test("command-primary fallback does not overwrite a command-recorded review or gate failure", async (t) => {
  for (const scenario of [
    { commandName: "review", nodeId: "draft-questions-review", category: "semantic", retryKind: "semantic" },
    { commandName: "gate", nodeId: "draft-gate", category: "tooling", retryKind: "tooling" },
  ]) {
    await t.test(scenario.commandName, async () => {
      const root = createTmpDir(`definition-lifecycle-self-recorded-${scenario.commandName}-`);
      const entry = flowCommands.run[scenario.commandName];
      const originalCommand = entry.command;
      try {
        const specId = `903-self-recorded-${scenario.commandName}`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-self-recorded-${scenario.commandName}`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate(scenario.nodeId);
        class SelfRecordingCommand extends Command {
          static outputMode = "envelope";
          execute() {
            manager.failCurrentAttempt({
              specId,
              failure: { category: scenario.category, code: "COMMAND_OWNED_FAILURE", message: "command recorded its failure", retryable: true, retryKind: scenario.retryKind },
              result: { outcome: "failed", summary: "command recorded its failure", confirmedAt: new Date().toISOString(), artifactRefs: [] },
            });
            throw Object.assign(new Error("after recording"), { code: "AFTER_COMMAND_RECORD" });
          }
        }
        entry.command = async () => ({ default: SelfRecordingCommand });
        await dispatch({
          container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: scenario.commandName,
          stdout: () => {}, stderr: () => {}, setExitCode: () => {},
          buildHookCtx: () => hookContext({ root, manager, specId }),
        });
        const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
        assert.equal(failures.length, 1);
        assert.equal(manager.canonicalState(specId).attempt.failure.code, "COMMAND_OWNED_FAILURE");
      } finally {
        entry.command = originalCommand;
        removeTmpDir(root);
      }
    });
  }
});

test("Draft Gate command errors persist tooling failure without creating a Step Error", async () => {
  const root = createTmpDir("definition-lifecycle-draft-gate-error-");
  const entry = flowCommands.run.gate;
  const originalCommand = entry.command;
  try {
    const specId = "904-draft-gate-step-error";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-gate-step-error",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-gate");
    class DraftGateCommandFailure extends Command {
      static outputMode = "envelope";
      execute() {
        throw Object.assign(new Error("Draft Gate provider failed."), {
          code: "DRAFT_GATE_PROVIDER_FAILED",
        });
      }
    }
    entry.command = async () => ({ default: DraftGateCommandFailure });
    const envelope = await dispatchRegistryCommand({ root, manager, specId, commandName: "gate", CommandClass: DraftGateCommandFailure });
    const state = manager.canonicalState(specId);
    const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
    assert.equal(envelope.ok, false);
    assert.equal(state.current.at(-1), "draft-gate");
    assert.equal(state.attempt.failure.category, "tooling");
    assert.equal(state.attempt.failure.code, "DRAFT_GATE_PROVIDER_FAILED");
    assert.equal(state.failureDisposition().operation, "resolve-step-definition");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].result.stepResult, undefined);
  } finally {
    entry.command = originalCommand;
    removeTmpDir(root);
  }
});

test("Draft Gate Error save failure stops without a dispatcher fallback", async () => {
  const root = createTmpDir("definition-lifecycle-draft-gate-error-save-");
  const entry = flowCommands.run.gate;
  const originalCommand = entry.command;
  try {
    const specId = "904-draft-gate-error-save-failure";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-gate-error-save-failure",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-gate");
    class FailedDraftGateCommand extends Command {
      static outputMode = "envelope";
      execute() { throw new Error("Draft Gate provider failed."); }
    }
    let failureWrites = 0;
    manager.failCurrentAttemptIfCurrent = () => {
      failureWrites += 1;
      throw new Error("Draft Gate Error could not be saved.");
    };
    entry.command = async () => ({ default: FailedDraftGateCommand });
    const envelope = await dispatchRegistryCommand({
      root, manager, specId, commandName: "gate", CommandClass: FailedDraftGateCommand,
    });
    const state = manager.canonicalState(specId);
    assert.equal(envelope.ok, false);
    assert.equal(failureWrites, 1, "dispatcher must not write a replacement failure");
    assert.equal(state.current.at(-1), "draft-gate");
    assert.equal(state.attempt.failure, null);
    assert.equal(manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed").length, 0);
  } finally {
    entry.command = originalCommand;
    removeTmpDir(root);
  }
});

test("Draft Gate Step Error is persisted without a dispatcher fallback", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-gate-step-result-");
  const originalInspect = GateService.prototype.inspectGateFacts;
  try {
    const specId = "904-draft-gate-step-result";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-gate-step-result",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
      }],
    });
    flow.activate("draft-gate");
    const result = await produceDraftGateResult(manager, specId);
    class PublishedDraftGateCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    GateService.prototype.inspectGateFacts = () => {
      throw new Error("Draft Gate Step rejected its result.");
    };
    const envelope = await dispatchRegistryCommand({
      root, manager, specId, commandName: "gate", CommandClass: PublishedDraftGateCommand,
    });
    const state = manager.canonicalState(specId);
    const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors.some((error) => error.code === "DRAFT_GATE_RESULT_ERROR"), true);
    assert.equal(state.current.at(-1), "draft-gate");
    assert.equal(state.attempt.failure.category, STEP_RESULT_ERROR_CATEGORY);
    assert.equal(state.nextAction().operation, "blocked");
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].result.stepResult, {
      kind: "draft-gate-error",
      type: "error",
      error: { kind: "generic", message: "Draft Gate Step rejected its result." },
    });
  } finally {
    GateService.prototype.inspectGateFacts = originalInspect;
    removeTmpDir(root);
  }
});

test("Draft Review command failure persists tooling failure without creating a Step Error", async () => {
  const root = createTmpDir("definition-lifecycle-draft-review-error-");
  try {
    const specId = "904-draft-review-step-error";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-review-step-error",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
      }],
    });
    flow.activate("draft-questions-review");
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand() {
        throw Object.assign(new Error("Draft Review provider failed."), {
          code: "AGENT_TIMEOUT",
          stopEvidence: AgentProcessStopEvidence.confirmed(),
        });
      },
    });
    const result = await review.execute({
      root,
      mainRoot: root,
      executionRoot: root,
      specId,
      phase: "draft",
      flowManager: manager,
      flowState: manager.loadReadOnly(specId),
      config: {},
    });
    const state = manager.canonicalState(specId);
    const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "REVIEW_TOOLING_ERROR");
    assert.equal(state.current.at(-1), "draft-questions-review");
    assert.equal(state.attempt.failure.category, "tooling");
    assert.equal(state.attempt.failure.code, "AGENT_TIMEOUT");
    assert.equal(state.attempt.failure.retryable, true);
    assert.equal(state.attempt.failure.retryKind, "tooling");
    assert.equal(state.attempt.failure.agentStopEvidence.confirmed, true);
    assert.equal(state.failureDisposition().operation, "retry");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].result.stepResult, undefined);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const reloadedFailure = reloaded.activityLedger(specId).find((activity) => activity.type === "attempt_failed");
    assert.deepEqual(reloadedFailure.result.stepResult, failures[0].result.stepResult);
  } finally {
    removeTmpDir(root);
  }
});

test("Draft Review admission refusal stops without a Step Error or dispatcher fallback", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-review-step-result-");
  try {
    const specId = "904-draft-review-step-result";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-review-step-result",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
      }],
    });
    flow.activate("draft-questions-review");
    const claimedResult = await claimDraftQuestionsReviewExecution(manager, specId);
    const attemptBefore = manager.canonicalState(specId).attempt.toJSON();
    const activitiesBefore = manager.activityLedger(specId).length;
    const draftBefore = manager.readArtifact({ specId, consumerNodeId: "draft-questions-review", logicalKey: "draft" });
    const result = attachCanonicalCommandResultArtifact({ ...claimedResult }, {
      logicalKey: "draft.questions.review",
      payload: {},
    });
    class PublishedDraftReviewCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    const envelope = await dispatchRegistryCommand({
      root, manager, specId, commandName: "review", CommandClass: PublishedDraftReviewCommand,
    });
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const state = reloaded.canonicalState(specId);
    const activities = reloaded.activityLedger(specId);
    const failures = activities.filter((activity) => activity.type === "attempt_failed");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors.some((error) => error.code === "DRAFT_REVIEW_ADMISSION_REFUSED"), true);
    assert.equal(state.current.at(-1), "draft-questions-review");
    assert.equal(state.attempt.id, attemptBefore.id);
    assert.equal(state.attempt.sequence, attemptBefore.sequence);
    assert.deepEqual(state.attempt.consumption.toJSON(), attemptBefore.consumption);
    assert.equal(state.attempt.failure, null);
    assert.equal(state.findNode("draft-questions-review").result, null);
    assert.equal(failures.length, 0);
    assert.equal(activities.length, activitiesBefore + 1, "only the publication checkpoint is added");
    assert.equal(activities.filter((activity) => (
      activity.nodeId === "draft-questions-review"
      && activity.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication"
    )).length, 1);
    const saved = reloaded.readCurrentStepSettlement({ specId, stepId: "draft-questions-review" });
    assert.equal(saved.result.kind, new DraftQuestionsReviewExecutionRequiredResult().kind);
    assert.equal(saved.receipt.executionLifecycle.phase, "publication");
    assert.equal(saved.receipt.binding.attemptId, attemptBefore.id);
    assert.equal(saved.receipt.binding.attemptSequence, attemptBefore.sequence);
    assert.deepEqual(saved.receipt, activities.at(-1).result.draftSettlementReceipt);
    const publication = reloaded.readProducerArtifact({
      specId, nodeId: "draft-questions-review", logicalKey: "draft.questions.review",
    });
    assert.equal(publication.descriptor.activityId, saved.activityId);
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "draft.questions.review", bytes: publication.bytes,
    });
    assert.deepEqual(history.current, { attempt: attemptBefore.sequence, payload: {} });
    const draftAfter = reloaded.readArtifact({ specId, consumerNodeId: "draft-questions-review", logicalKey: "draft" });
    assert.deepEqual(draftAfter.descriptor, draftBefore.descriptor);
    assert.deepEqual(draftAfter.bytes, draftBefore.bytes);
  } finally {
    removeTmpDir(root);
  }
});

test("Draft Review rejects a binding made stale during connection without another Attempt effect", async () => {
  for (const when of ["before", "after"]) {
    const root = fixtureRepository(`definition-lifecycle-draft-review-stale-${when}-`);
    const originalConnect = DraftReviewConnector.prototype.connect;
    try {
      const specId = `904-draft-review-stale-${when}`;
      const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const flow = new CanonicalFlowFixture({
        flowManager: manager,
        specId,
        runId: `run-draft-review-stale-${when}`,
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create().registerActive();
      flow.activate("draft");
      manager.confirmCurrentAttempt({
        specId,
        artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
        }],
      });
      flow.activate("draft-questions-review");
      await claimDraftQuestionsReviewExecution(manager, specId);
      const result = attachCanonicalCommandResultArtifact({
        result: "ok", artifacts: { phase: "draft-questions", verdict: "PASS" },
      }, { logicalKey: "draft.questions.review", payload: {} });
      class PublishedDraftReviewCommand extends Command {
        static outputMode = "envelope";
        execute() { return result; }
      }
      let concurrentState = null;
      let concurrentActivities = null;
      DraftReviewConnector.prototype.connect = async function () {
        const changeAttempt = () => {
          manager.failCurrentAttempt({
            specId,
            failure: {
              category: "tooling", code: "CONCURRENT_REVIEW_FAILURE",
              message: "another execution stopped the review", retryable: false, retryKind: null,
            },
            result: {
              outcome: "failed", summary: "another execution stopped the review",
              confirmedAt: new Date().toISOString(), artifactRefs: [],
            },
          });
          concurrentState = manager.canonicalState(specId).toJSON();
          concurrentActivities = manager.activityLedger(specId).length;
        };
        if (when === "before") changeAttempt();
        const binding = await originalConnect.call(this);
        if (when === "after") changeAttempt();
        return binding;
      };
      const envelope = await dispatchRegistryCommand({
        root, manager, specId, commandName: "review", CommandClass: PublishedDraftReviewCommand,
      });
      assert.equal(envelope.ok, false, when);
      assert.equal(envelope.errors.some((error) => error.code === "DRAFT_REVIEW_ADMISSION_REFUSED"), true, when);
      assert.deepEqual(manager.canonicalState(specId).toJSON(), concurrentState, when);
      assert.equal(manager.activityLedger(specId).length, concurrentActivities, when);
      assert.equal(manager.activityLedger(specId).filter((entry) => (
        entry.nodeId === "draft-questions-review"
        && entry.result?.draftSettlementReceipt?.executionLifecycle?.phase === "publication"
      )).length, 0, when);
    } finally {
      DraftReviewConnector.prototype.connect = originalConnect;
      removeTmpDir(root);
    }
  }
});

test("Draft Review execution admission refuses a changed work unit without dispatcher tooling fallback", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-review-claim-mismatch-");
  try {
    const specId = "904-draft-review-claim-mismatch";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-review-claim-mismatch",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId,
      artifactWrites: [{
        logicalKey: "draft", mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
      }],
    });
    flow.activate("draft-questions-review");
    await claimDraftQuestionsReviewExecution(manager, specId);
    const before = manager.canonicalState(specId).toJSON();
    const activities = manager.activityLedger(specId).length;
    let providerCalls = 0;
    class ReviewExecutionCommand extends RunReviewCommand {
      constructor() {
        super({
          resolveTreeSha: () => "e".repeat(40),
          resolveTargetStateDigest: () => "b".repeat(64),
          runCommand() { providerCalls += 1; },
        });
      }
      execute(ctx) { return super.execute({ ...ctx, phase: "draft" }); }
    }
    const envelope = await dispatchRegistryCommand({
      root, manager, specId, commandName: "review", CommandClass: ReviewExecutionCommand,
    });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors[0].code, "DRAFT_REVIEW_EXECUTION_BINDING_MISMATCH", JSON.stringify(envelope.errors));
    assert.equal(envelope.data.failureKind, "step-admission");
    assert.equal(providerCalls, 0);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before);
    assert.equal(manager.activityLedger(specId).length, activities);
  } finally {
    removeTmpDir(root);
  }
});

test("Draft Review result-publication failure leaves the confirmed Attempt unchanged", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-review-publication-");
  try {
    const specId = "904-draft-review-publication-failure";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-review-publication-failure",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
      }],
    });
    flow.activate("draft-questions-review");
    const result = await claimDraftQuestionsReviewExecution(manager, specId);
    class PublishedDraftReviewCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    manager.settleDraftStepResult = () => {
      throw Object.assign(new Error("Draft Review result publication failed."), {
        code: "DRAFT_REVIEW_PUBLICATION_FAILED",
      });
    };
    const envelope = await dispatchRegistryCommand({
      root, manager, specId, commandName: "review", CommandClass: PublishedDraftReviewCommand,
    });
    const state = manager.canonicalState(specId);
    const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors.some((error) => error.code === "DRAFT_REVIEW_STEP_RESULT_PERSISTENCE_FAILED"), true);
    assert.equal(state.current.at(-1), "draft-questions-review");
    assert.equal(state.attempt.failure, null);
    assert.equal(failures.length, 0);
  } finally {
    removeTmpDir(root);
  }
});

test("Draft Review adopts a result artifact when publication reports after durable write", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-review-publication-readback-");
  try {
    const specId = "904-draft-review-publication-readback";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const flow = new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-review-publication-readback",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive();
    flow.activate("draft");
    manager.confirmCurrentAttempt({
      specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
      }],
    });
    flow.activate("draft-questions-review");
    const result = await claimDraftQuestionsReviewExecution(manager, specId);
    class PublishedDraftReviewCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    const originalSettle = manager.settleDraftStepResult.bind(manager);
    manager.settleDraftStepResult = (input) => {
      originalSettle(input);
      throw new Error("Draft Review publication response was lost after durable write.");
    };
    const envelope = await dispatchRegistryCommand({
      root, manager, specId, commandName: "review", CommandClass: PublishedDraftReviewCommand,
    });
    const state = manager.canonicalState(specId);
    assert.equal(envelope.ok, true);
    assert.equal(state.current, null);
    assert.equal(manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed").length, 0);
  } finally {
    removeTmpDir(root);
  }
});

test("Draft Gate result-publication failure leaves the confirmed Attempt unchanged", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-gate-publication-");
  const entry = flowCommands.run.gate;
  const originalCommand = entry.command;
  try {
    const specId = "904-draft-gate-publication-failure";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-gate-publication-failure",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-gate");
    const result = await produceDraftGateResult(manager, specId);
    class PublishedDraftGateCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    const originalSettle = manager.settleDraftStepResult.bind(manager);
    const beforeCatalog = manager.artifactCatalog(specId).toJSON();
    const beforeActivities = manager.activityLedger(specId);
    manager.settleDraftStepResult = () => {
      throw Object.assign(new Error("Draft Gate result publication failed."), {
        code: "DRAFT_GATE_PUBLICATION_FAILED",
      });
    };
    entry.command = async () => ({ default: PublishedDraftGateCommand });
    const envelope = await dispatchRegistryCommand({ root, manager, specId, commandName: "gate", CommandClass: PublishedDraftGateCommand });
    const state = manager.canonicalState(specId);
    const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors.some((error) => error.code === "DRAFT_GATE_STEP_RESULT_PERSISTENCE_FAILED"), true);
    assert.equal(state.current.at(-1), "draft-gate");
    assert.equal(state.attempt.failure, null);
    assert.equal(failures.length, 0);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), beforeCatalog);
    assert.deepEqual(manager.activityLedger(specId), beforeActivities);
    assert.equal(manager.readProducerArtifact({
      specId, nodeId: "draft-gate", logicalKey: "draft.gate", optional: true,
    }), null);
    assert.equal(manager.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "draft-gate", optional: true,
    }), null);
    manager.settleDraftStepResult = originalSettle;
  } finally {
    entry.command = originalCommand;
    removeTmpDir(root);
  }
});

test("Draft Gate adopts a result artifact when publication reports after durable write", async () => {
  const root = fixtureRepository("definition-lifecycle-draft-gate-publication-readback-");
  const entry = flowCommands.run.gate;
  const originalCommand = entry.command;
  try {
    const specId = "904-draft-gate-publication-readback";
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    new CanonicalFlowFixture({
      flowManager: manager,
      specId,
      runId: "run-draft-gate-publication-readback",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft-gate");
    const result = await produceDraftGateResult(manager, specId);
    class PublishedDraftGateCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    const originalSettle = manager.settleDraftStepResult.bind(manager);
    manager.settleDraftStepResult = (input) => {
      originalSettle(input);
      throw new Error("Draft Gate publication response was lost after durable write.");
    };
    entry.command = async () => ({ default: PublishedDraftGateCommand });
    const envelope = await dispatchRegistryCommand({ root, manager, specId, commandName: "gate", CommandClass: PublishedDraftGateCommand });
    const state = manager.canonicalState(specId);
    assert.equal(envelope.ok, true);
    assert.equal(state.current, null);
    assert.equal(manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed").length, 0);
  } finally {
    entry.command = originalCommand;
    removeTmpDir(root);
  }
});

test("every definition-owned parent command declares exactly one typed failure owner", () => {
  const definition = buildCurrentFlowDefinition();
  const owners = [];
  const visit = (node) => {
    if (node.action?.executionCommand != null) {
      owners.push({ id: node.id, owner: node.action.failureOwnership, executionCommand: node.action.executionCommand });
    }
    node.steps.forEach(visit);
  };
  visit(definition.root);
  definition.taskTemplate.steps.forEach(visit);
  assert.ok(owners.length > 0);
  for (const entry of owners) {
    assert.ok(DEFINITION_FAILURE_OWNERS.some((owner) => owner.equals(entry.owner)), `${entry.id} owner`);
    const commandName = entry.executionCommand.split(/\s+/)[3];
    assert.ok(flowCommands.run[commandName]?.failureOwnership.equals(entry.owner), `${entry.id} registry owner`);
  }
  assert.deepEqual(
    owners.filter((entry) => entry.owner.toJSON() === "dispatcher-primary").map((entry) => entry.id),
    ["test-gate", "test-execute", "test-result-review", "retro"],
  );
});

test("command-primary fallback preserves a command-recorded semantic failure", async (t) => {
  for (const scenario of [
    { commandName: "acceptance-review", nodeId: "acceptance-review" },
    { commandName: "final-regression", nodeId: "final-regression" },
  ]) {
    await t.test(scenario.commandName, async () => {
      const root = fixtureRepository(`definition-lifecycle-fallback-${scenario.commandName}-`);
      const entry = flowCommands.run[scenario.commandName];
      const originalCommand = entry.command;
      try {
        const specId = `905-${scenario.commandName}`;
        const manager = await canonicalFailureTarget({ root, specId,
          runId: `run-${scenario.commandName}-fallback`, nodeId: scenario.nodeId });
        class SelfRecordingCommand extends Command {
          static outputMode = "envelope";
          execute() {
            manager.failCurrentAttempt({
              specId,
              failure: {
                category: "semantic",
                code: "COMMAND_PRIMARY_SEMANTIC_FAILURE",
                message: "command recorded its semantic failure",
                retryable: false,
                retryKind: null,
              },
              result: {
                outcome: "failed",
                summary: "command recorded its semantic failure",
                confirmedAt: new Date().toISOString(),
                artifactRefs: [],
              },
            });
            throw Object.assign(new Error("after command failure record"), { code: "FALLBACK_MUST_NOT_OVERWRITE" });
          }
        }
        entry.command = async () => ({ default: SelfRecordingCommand });
        await dispatch({
          container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: scenario.commandName,
          stdout: () => {}, stderr: () => {}, setExitCode: () => {},
          buildHookCtx: () => hookContext({ root, manager, specId }),
        });
        const failures = manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed");
        assert.equal(failures.length, 1);
        assert.equal(manager.canonicalState(specId).attempt.failure.code, "COMMAND_PRIMARY_SEMANTIC_FAILURE");
      } finally {
        entry.command = originalCommand;
        removeTmpDir(root);
      }
    });
  }
});

test("review and gate registry post failures settle the bound Attempt", async (t) => {
  for (const scenario of [
    { commandName: "review", nodeId: "draft-questions-review" },
    { commandName: "gate", nodeId: "draft-gate" },
  ]) {
    await t.test(scenario.commandName, async () => {
      const root = createTmpDir(`definition-lifecycle-${scenario.commandName}-post-`);
      const entry = flowCommands.run[scenario.commandName];
      const originalPost = entry.post;
      try {
        const specId = `906-${scenario.commandName}-post`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-${scenario.commandName}-post`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate(scenario.nodeId);
        class PassingCommand extends Command {
          static outputMode = "envelope";
          static calls = 0;
          execute() {
            PassingCommand.calls += 1;
            return { result: "pass" };
          }
        }
        entry.post = () => {
          throw Object.assign(new Error(`${scenario.commandName} registry post failed`), {
            code: `${scenario.commandName.toUpperCase()}_POST_FIXTURE_FAILED`,
          });
        };
        const envelope = await dispatchRegistryCommand({
          root,
          manager,
          specId,
          commandName: scenario.commandName,
          CommandClass: PassingCommand,
        });
        const failure = manager.canonicalState(specId).attempt.failure;
        assert.equal(PassingCommand.calls, 1, "the producer command returns before its registry post failure");
        assert.equal(envelope.ok, true, "the established post-hook envelope contract remains a warning");
        assert.equal(envelope.errors.some((error) => error.level === "warn" && error.code === "POST_HOOK_FAILED"), true);
        assert.equal(failure.category, "tooling");
        assert.equal(failure.code, `${scenario.commandName.toUpperCase()}_POST_FIXTURE_FAILED`);
        assert.equal(manager.activityLedger(specId).filter((activity) => activity.type === "attempt_failed").length, 1);
      } finally {
        entry.post = originalPost;
        removeTmpDir(root);
      }
    });
  }
});

test("atomic Task Gate post response failure preserves its receipt and exact settlement replay", async () => {
  const root = fixtureRepository("task-gate-atomic-post-response-");
  const entry = flowCommands.run.gate;
  const originalPost = entry.post;
  try {
    const specId = "907-task-gate-post-response";
    const { manager, result } = await taskGateFixture({ root, specId, evaluate: true });
    const preparation = prepareTaskGateScenario({ repository: root, manager, specId, commandResult: result });
    let beforeFailure;
    let receipt;
    entry.post = () => {
      preparation.prepared.step.execute();
      receipt = manager.readCurrentStepSettlement({ specId, stepId: "T-1-gate", completed: true }).receipt;
      beforeFailure = new CanonicalPersistenceSnapshot(manager, specId);
      throw Object.assign(new Error("Task Gate post failed after its atomic commit"), { code: "TASK_GATE_POST_AFTER_PUBLICATION" });
    };
    class PublishedGateCommand extends Command {
      static outputMode = "envelope";
      execute() { return result; }
    }
    const envelope = await dispatchRegistryCommand({ root, manager, specId,
      commandName: "gate", CommandClass: PublishedGateCommand });
    assert.ok(beforeFailure, "the actual atomic publication must precede the injected response failure");
    assert.ok(envelope.errors.some((error) => error.code === "POST_HOOK_FAILED"));
    const fresh = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    beforeFailure.assertUnchanged(fresh, specId, "dispatcher fallback after committed Task Gate");
    assert.equal(fresh.canonicalState(specId).findNode("T-1-gate").status, "done");
    assert.equal(taskGateAttemptHistorySize(fresh, specId), 1);
    assert.equal(fresh.readCurrentStepSettlement({ specId, stepId: "T-1-gate", completed: true }).receipt.id, receipt.id);
    preparation.prepared.step.execute();
    beforeFailure.assertUnchanged(fresh, specId, "exact atomic Task Gate settlement replay");
  } finally {
    entry.post = originalPost;
    removeTmpDir(root);
  }
});

test("Task Gate fallback admission rejects a result committed after its initial read", async () => {
  const root = fixtureRepository("task-gate-fallback-publication-race-");
  try {
    const specId = "907-task-gate-fallback-race";
    const { manager, result } = await taskGateFixture({ root, specId, evaluate: true });
    const failCurrentAttemptIfCurrent = manager.failCurrentAttemptIfCurrent.bind(manager);
    let afterPublication;
    let raced = false;
    manager.failCurrentAttemptIfCurrent = (input) => {
      raced = true;
      executeTaskGateScenario({ repository: root, manager, specId, commandResult: result });
      afterPublication = new CanonicalPersistenceSnapshot(manager, specId);
      return failCurrentAttemptIfCurrent(input);
    };
    const envelope = await dispatchRegistryFailure({
      root, manager, specId, commandName: "gate", CommandClass: ThrowingCommand,
    });
    assert.equal(raced, true);
    assert.equal(envelope.errors[0].code, "REGISTRY_COMMAND_FIXTURE_FAILED");
    afterPublication.assertUnchanged(manager, specId, "fallback after concurrent atomic Task Gate commit");
    assert.equal(manager.canonicalState(specId).findNode("T-1-gate").status, "done");
    assert.equal(taskGateAttemptHistorySize(manager, specId), 1);
    assert.equal(manager.activityLedger(specId).some((activity) => (
      activity.nodeId === "T-1-gate"
      && activity.transition.operation === "fail_attempt"
      && activity.failure?.category === "tooling"
    )), false);
  } finally {
    removeTmpDir(root);
  }
});

test("Task Gate fallback records tooling failure when no result was published", async () => {
  const root = fixtureRepository("task-gate-fallback-unpublished-");
  try {
    const specId = "907-task-gate-fallback-unpublished";
    const { manager } = await taskGateFixture({ root, specId });
    const before = manager.canonicalState(specId).attempt;
    const envelope = await dispatchRegistryFailure({
      root, manager, specId, commandName: "gate", CommandClass: ThrowingCommand,
    });
    const state = manager.canonicalState(specId);
    assert.equal(envelope.errors[0].code, "REGISTRY_COMMAND_FIXTURE_FAILED");
    assert.equal(state.attempt.id, before.id, "fallback must settle the original Task Gate Attempt");
    assert.equal(state.attempt.sequence, before.sequence);
    assert.equal(state.attempt.failure.category, "tooling");
    assert.equal(state.attempt.failure.code, "REGISTRY_COMMAND_FIXTURE_FAILED");
    assert.equal(state.attempt.consumption.semantic, 0, "tooling fallback must not consume semantic retry budget");
    assert.equal(manager.readProducerArtifact({
      specId, nodeId: "T-1-gate", logicalKey: "task.gate", parameters: { taskId: "T-1" }, optional: true,
    }), null, "unpublished fallback must not invent a Task Gate result");
    assert.equal(state.findNode("T-1").status, "in_progress");
    assert.equal(state.findNode("T-1-gate").status, "in_progress");
  } finally {
    removeTmpDir(root);
  }
});

test("pre, post, and onError hook failures preserve the original failure and settle the bound Attempt", async (t) => {
  for (const scenario of [
    {
      name: "pre",
      install(entry) {
        const original = entry.pre;
        entry.pre = () => { throw Object.assign(new Error("pre failed"), { code: "PRE_FIXTURE_FAILED" }); };
        return () => { entry.pre = original; };
      },
      expectedCode: "PRE_FIXTURE_FAILED",
      expectedCalls: 0,
    },
    {
      name: "post",
      install(entry) {
        const original = entry.post;
        entry.post = () => { throw Object.assign(new Error("post failed"), { code: "POST_FIXTURE_FAILED" }); };
        return () => { entry.post = original; };
      },
      expectedCode: "POST_FIXTURE_FAILED",
      expectedCalls: 1,
    },
    {
      name: "onError",
      install(entry) {
        const original = entry.onError;
        entry.onError = () => { throw Object.assign(new Error("onError failed"), { code: "ON_ERROR_FIXTURE_FAILED" }); };
        return () => { entry.onError = original; };
      },
      expectedCode: "COMMAND_FIXTURE_FAILED",
      expectedCalls: 1,
      commandFails: true,
    },
  ]) {
    await t.test(`${scenario.name} hook`, async () => {
      const root = createTmpDir(`definition-lifecycle-${scenario.name}-hook-`);
      const entry = flowCommands.run["test-execute"];
      const originalCommand = entry.command;
      let restoreHook = () => {};
      try {
        const specId = `904-${scenario.name}-hook`;
        const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        new CanonicalFlowFixture({
          flowManager: manager,
          specId,
          runId: `run-${scenario.name}-hook`,
          execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        }).create().registerActive().activate("test-execute");
        let calls = 0;
        class HookCommand extends Command {
          static outputMode = "envelope";
          execute() {
            calls += 1;
            if (scenario.commandFails) throw Object.assign(new Error("command failed"), { code: "COMMAND_FIXTURE_FAILED" });
            return { result: "fixture" };
          }
        }
        entry.command = async () => ({ default: HookCommand });
        restoreHook = scenario.install(entry);
        await dispatch({
          container: commandContainer({ root, manager }), entry, argv: [], envelopeType: "run", envelopeKey: "test-execute",
          stdout: () => {}, stderr: () => {}, setExitCode: () => {},
          buildHookCtx: () => hookContext({ root, manager, specId }),
        });
        assert.equal(calls, scenario.expectedCalls);
        assert.equal(manager.canonicalState(specId).attempt.failure.code, scenario.expectedCode);
      } finally {
        restoreHook();
        entry.command = originalCommand;
        removeTmpDir(root);
      }
    });
  }
});
