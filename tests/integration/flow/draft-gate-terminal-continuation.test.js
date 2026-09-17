import assert from "node:assert/strict";
import fs from "node:fs";
import { it, mock } from "node:test";

import { resolveGateTransition } from "../../../src/flow/definition.js";
import { DraftGateEvaluationBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftSpecConnector } from "../../../src/flow/engine/connectors/draft/draft-spec-connector.js";
import { DraftGateStep } from "../../../src/flow/steps/draft/draft-gate.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { DraftService } from "../../../src/flow/services/draft-service.js";
import { CanonicalGateObservationCycle } from "../../../src/flow/lib/canonical-gate-observation-cycle.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { AnsweredQuestion } from "../../../src/flow/lib/draft-question-ledger.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import RunSettleGateTransitionCommand from "../../../src/flow/lib/run-settle-gate-transition.js";
import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";

const semanticObservations = [{
  kind: "violation",
  failureMode: "guardrail-violation",
  requirementRef: "R-1",
  where: { file: "draft.json", locator: "goal" },
  observed: "The retained behavior remains unresolved.",
  severity: "blocking",
  refs: ["R-1"],
}];

it("connects a normal Draft Gate PASS to Spec before applying its lifecycle", async () => {
  const root = createTmpDir("draft-gate-post-spec-connector-");
  const specId = "523-draft-gate-post-spec-connector";
  const originalConnect = DraftSpecConnector.prototype.connect;
  const originalExecute = DraftGateStep.prototype.execute;
  const connected = [];
  const executed = mock.method(DraftGateStep.prototype, "execute", function () {
    return originalExecute.call(this);
  });
  const connect = mock.method(DraftSpecConnector.prototype, "connect", async function () {
    const binding = await originalConnect.call(this);
    connected.push(binding);
    return binding;
  });
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate connector\n");
    commitAll(root, "draft Gate connector");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-connector", issue: 523,
      request: "Connect a passing Draft Gate to Spec.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      autoApprove: false,
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftWithAnsweredQuestion("Resolved behavior"), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
    }).promote({ result: "pass", artifacts: { phase: "draft", evaluations: [] } });
    await FLOW_COMMANDS.run.gate.post({
      root, mainRoot: root, executionRoot: root, specId, phase: "draft",
      flowManager: manager, flowState: manager.loadReadOnly(specId),
    }, result);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(executed.mock.callCount(), 1);
    assert.equal(connected[0].stepId, "draft-gate");
    assert.equal(manager.canonicalState(specId).nextAction().nodeId, "spec");
  } finally {
    connect.mock.restore();
    executed.mock.restore();
    removeTmpDir(root);
  }
});

it("uses the existing Gate result when StepFactory executes the Draft Gate Step", async () => {
  const root = createTmpDir("draft-gate-step-result-");
  const specId = "524-draft-gate-step-result";
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate Step result\n");
    commitAll(root, "draft Gate Step result");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-step", issue: 524,
      request: "Use the evaluated Gate result once.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      autoApprove: false,
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftWithAnsweredQuestion("Resolved behavior"), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
    }).promote({ result: "pass", artifacts: { phase: "draft", evaluations: [] } });
    const binding = new DraftGateEvaluationBinding({ flowManager: manager, specId });
    const command = new RunGateCommand({ draftStepResult: result });
    command.executeCanonical = () => { throw new Error("Draft Gate must not evaluate twice"); };
    const step = new StepFactory()
      .provide(DraftService, new DraftService({ flowManager: manager, binding }))
      .provide(RunGateCommand, command)
      .create(DraftGateStep);

    assert.deepEqual((await step.execute()).toJSON(), { type: "completed" });
    const history = JSON.parse(manager.readProducerArtifact({
      specId, nodeId: "draft-gate", logicalKey: "draft.gate",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((attempt) => attempt.attempt), [1]);
  } finally {
    removeTmpDir(root);
  }
});

function draftWithAnsweredQuestion(goal) {
  const draft = canonicalDraftDocument({
    goal,
    questions: [new AnsweredQuestion({
      state: "AnsweredQuestion",
      id: "q1",
      category: "user-visible-behavior",
      question: "Which public behavior must remain stable?",
      revision: 1,
      provenance: { producer: "fixture" },
      evidenceDigest: "a".repeat(64),
      answer: "Keep the selected public behavior stable.",
      why: "The user explicitly selected it.",
      considered: "Changing the public contract was rejected.",
    }).toJSON()],
  });
  draft.decisionMap.requiresUserJudgment = [];
  return draft;
}

function commandContainer({ root, manager }) {
  const values = { paths: { root }, flowManager: manager, mainRoot: root, config: null, inWorktree: false };
  return {
    get(name) { return values[name] ?? null; },
    has(name) { return Object.hasOwn(values, name); },
  };
}

function completedAction() {
  return {
    taskId: null, step: null, action: "completed", instructions: null, context: null,
    output_schema: null, requires_approval: false,
    directive: { kind: "completed", terminal: true, requiresUserAction: false },
  };
}

async function dispatchDraftGateSettlement({ root, manager, specId, runId }) {
  const context = {
    root, mainRoot: root, executionRoot: root, specId,
    flowManager: manager, flowState: manager.loadReadOnly(specId),
    expectRunId: runId, expectSpec: specId,
    _envelopeType: "run", _envelopeKey: "dispatch",
  };
  const selected = await new GetNextActionCommand().execute(context);
  assert.equal(selected.directive.actionId, "SETTLE_GATE_DEFER", JSON.stringify(selected.directive));
  assert.equal(selected.directive.requiresUserAction, false);
  assert.equal(selected.nonblockingDecision, undefined);
  assert.equal(manager.loadReadOnly(specId).policy.nonblocking, null);

  let nextActionReads = 0;
  let specAction = null;
  let workerCalls = 0;
  const dispatcher = new RunDispatchCommand({
    nextAction: {
      async run(container, input) {
        nextActionReads += 1;
        const next = await new GetNextActionCommand().run(container, input);
        if (next.step === "draft-gate") return next;
        specAction = next;
        assert.equal(next.step, "spec");
        return completedAction();
      },
    },
    agent: { async call() { workerCalls += 1; } },
    repositoryFingerprint: () => "draft-gate-terminal-settlement",
    leaseFactory: () => ({ acquire() {}, release() {} }),
    handoffCoordinator: { recoverPending() {} },
  });
  dispatcher.container = commandContainer({ root, manager });
  const outcome = await dispatcher.execute(context);
  assert.equal(outcome.dispatch?.boundary, "completed", JSON.stringify(outcome));
  assert.equal(outcome.dispatch?.dispatchCount, 1);
  assert.equal(nextActionReads, 3);
  assert.equal(workerCalls, 0);
  assert.ok(specAction);

  const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  assert.equal(reloaded.loadReadOnly(specId).policy.nonblocking, null);
  const beforeDuplicateActivities = reloaded.activityLedger(specId);
  const duplicate = new RunSettleGateTransitionCommand().execute({
    ...context, flowManager: reloaded, flowState: reloaded.loadReadOnly(specId),
  });
  assert.equal(duplicate.ok, false, "settlement cannot repeat after reload");
  assert.deepEqual(reloaded.activityLedger(specId), beforeDuplicateActivities);
  reloaded.beginNextAction(specId);
  const startedSpec = reloaded.canonicalState(specId);
  assert.equal(startedSpec.current.at(-1), "spec");
  assert.equal(startedSpec.findNode("spec").status, "in_progress");
  assert.notEqual(startedSpec.attempt, null);
  return reloaded;
}

function recordDraftGateFailure(manager, specId, issueLogId, observations = semanticObservations) {
  const evaluation = new DraftGateEvaluationBinding({ flowManager: manager, specId });
  const artifacts = {
    phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations } },
  };
  const commandResult = new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
  }).promote({ result: "fail", artifacts });
  manager.failCurrentAttempt({
    specId,
    failure: {
      category: "semantic", code: "GATE_REJECTED", message: "The draft Gate retained one finding.",
      retryable: true, retryKind: "semantic",
    },
    commandResult,
  });
  assert.throws(() => evaluation.assertCurrent(), /stale for the canonical Step Attempt/);
  manager.appendIssueLog({
    specId,
    entry: {
      issueLogId, step: "draft-gate", phase: "draft", observations,
      reason: "The finding continues to Spec.", trigger: "gate post hook (auto)",
      timestamp: "2026-09-15T00:00:00.000Z",
    },
    idempotencyKey: issueLogId,
  });
}

async function exerciseTerminalContinuation(kind) {
  const root = createTmpDir(`draft-gate-${kind}-continuation-`);
  const specId = `521-draft-gate-${kind}`;
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate terminal continuation\n");
    commitAll(root, "draft Gate terminal continuation");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-terminal", issue: 521,
      request: "Carry an unresolved draft finding into Spec.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      autoApprove: kind === "invalid-payload",
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftWithAnsweredQuestion("Unresolved behavior"), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const evaluation = new DraftGateEvaluationBinding({ flowManager: manager, specId });
    assert.equal(evaluation.assertCurrent().attempt.id, evaluation.attempt.id);
    const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId })
      .select({ observations: semanticObservations, issueLogId: "initial-draft-gate-finding" });
    assert.throws(() => evaluation.assertCurrent(), /stale for the canonical Step Attempt/);
    scenario.createRequest();
    const payload = scenario.replacement("goal", "Unresolved behavior");
    if (kind === "no-progress") payload.operations = [];
    else {
      payload.operations[0].path = "analysis.missing";
      payload.operations[0].expectedDigest = "f".repeat(64);
    }
    const before = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).descriptor.hash;
    const repaired = scenario.apply(payload);
    assert.equal(repaired.result.rejected, true);
    assert.equal(repaired.bytes.length > 0, true);
    assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => (
      entry.logicalKey === "plan.gate.repair.outcome"
    )), kind === "no-progress");

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(reloaded.canonicalState(specId).findNode("draft-gate-repair").status, "done");
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
    const terminalConfirmation = reloaded.activityLedger(specId).findLast((activity) => (
      activity.nodeId === "draft-gate-repair" && activity.transition.operation === "confirm_attempt"
    ));
    assert.deepEqual(terminalConfirmation.result.stepOutput, { type: "completed" });
    assert.equal(terminalConfirmation.result.draftRouteTargetStepId, "draft-coverage-review");
    assert.equal(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).descriptor.hash, before);

    fixture.flowManager = reloaded;
    fixture.settle("draft-coverage-review").settle("draft-coverage-triage").settle("draft-coverage-repair").activate("draft-gate");
    recordDraftGateFailure(reloaded, specId, "recurring-draft-gate-finding");
    const facts = readCurrentGateTransitionFacts({
      flowManager: reloaded, flowState: reloaded.loadReadOnly(specId), phase: "draft",
    });
    const decision = resolveGateTransition(facts);
    assert.equal(decision.disposition.operation, "defer");
    const specBinding = await new DraftSpecConnector({ flowManager: reloaded, facts }).connect();
    assert.equal(specBinding.assertCurrent().attempt.id, facts.target.attempt.id);
    const activityCount = reloaded.activityLedger(specId).length;
    const settledManager = await dispatchDraftGateSettlement({
      root, manager: reloaded, specId, runId: "run-draft-gate-terminal",
    });

    const finalReload = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(finalReload.canonicalState(specId).nextAction().nodeId, "spec");
    assert.throws(() => specBinding.assertCurrent(), /stale for the canonical Step Attempt/);
    assert.equal(finalReload.activityLedger(specId).filter((entry) => (
      entry.transition.operation === "defer_failed_gate"
    )).length, 1);
    assert.equal(finalReload.activityLedger(specId).length > activityCount, true);
    const findings = finalReload.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    });
    assert.equal(JSON.parse(findings.bytes).entries.length > 0, true);
    assert.equal(new CanonicalGateObservationCycle({
      flowManager: finalReload, state: finalReload.loadReadOnly(specId),
    }).status().entries[0].finalDisposition, "deferred");
    const specRequest = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: { root, mainRoot: root, executionRoot: root, flowManager: settledManager, specId },
      state: settledManager.loadReadOnly(specId),
      invocation: {
        id: "spec-after-deferred-draft-gate", target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "spec" } },
      },
    });
    const findingsInput = specRequest.inputs.find((entry) => entry.name === "flow-findings.json");
    const draftInput = specRequest.inputs.find((entry) => entry.name === "draft.json");
    const persistedFindings = JSON.parse(findings.bytes);
    assert.deepEqual(
      findingsInput.document.entries.map(({ sourceObservation, ...entry }) => entry),
      persistedFindings.entries,
    );
    assert.deepEqual(findingsInput.document.entries[0].sourceObservation, semanticObservations[0]);
    assert.equal(draftInput.document.questionLedger.questions[0].state, "AnsweredQuestion");
    assert.equal(draftInput.document.questionLedger.questions[0].answer, "Keep the selected public behavior stable.");
    assert.equal(settledManager.canonicalState(specId).nextAction().nodeId, "spec");
  } finally {
    removeTmpDir(root);
  }
}

it("persists no-progress repair completion and defers the recurring draft Gate finding to Spec", async () => {
  await exerciseTerminalContinuation("no-progress");
});

it("persists invalid repair completion without partial artifacts and defers the draft Gate finding to Spec", async () => {
  await exerciseTerminalContinuation("invalid-payload");
});

it("settles the fifth draft Gate failure after four completed repair and coverage cycles", async () => {
  const root = createTmpDir("draft-gate-semantic-budget-");
  const specId = "522-draft-gate-semantic-budget";
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate semantic budget\n");
    commitAll(root, "draft Gate semantic budget");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-semantic-budget", issue: 522,
      request: "Bound repeated draft Gate repairs.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftWithAnsweredQuestion("Draft revision 0"), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");

    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const observations = [{
        ...semanticObservations[0],
        failureMode: `semantic-finding-${cycle}`,
        observed: `Unresolved semantic finding ${cycle}.`,
      }];
      const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId })
        .select({ observations, issueLogId: `draft-gate-cycle-${cycle}` });
      scenario.createRequest();
      const result = scenario.apply(scenario.replacement("goal", `Draft revision ${cycle}`));
      assert.notEqual(result.result.rejected, true);
      fixture
        .settle("draft-coverage-review")
        .settle("draft-coverage-triage")
        .settle("draft-coverage-repair")
        .activate("draft-gate");
    }

    const finalObservation = [{
      ...semanticObservations[0],
      failureMode: "semantic-finding-5",
      observed: "A fifth distinct semantic finding remains.",
    }];
    recordDraftGateFailure(manager, specId, "draft-gate-cycle-5", finalObservation);
    const facts = readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft",
    });
    assert.deepEqual(facts.retry.toJSON(), { used: 4, maximum: 4, remaining: 0 });
    assert.equal(resolveGateTransition(facts).disposition.operation, "defer");
    const beforeAttempt = manager.canonicalState(specId).attempt;
    const beforeActivities = manager.activityLedger(specId).length;
    const bypass = new RunRepairPlanGateCommand().execute({
      root, mainRoot: root, executionRoot: root, flowManager: manager, specId,
      flowState: manager.loadReadOnly(specId),
    });
    assert.equal(bypass.ok, false);
    assert.deepEqual(manager.canonicalState(specId).attempt, beforeAttempt);
    assert.equal(manager.activityLedger(specId).length, beforeActivities);
    const settled = await dispatchDraftGateSettlement({
      root, manager, specId, runId: "run-draft-gate-semantic-budget",
    });
    const findings = settled.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    });
    assert.equal(JSON.parse(findings.bytes).entries.length > 0, true);
    const specRequest = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: { root, mainRoot: root, executionRoot: root, flowManager: settled, specId },
      state: settled.loadReadOnly(specId),
      invocation: {
        id: "spec-after-fifth-draft-gate-failure", target: { digest: "d".repeat(64) },
        action: { digest: "c".repeat(64), nextAction: { step: "spec" } },
      },
    });
    const findingsInput = specRequest.inputs.find((entry) => entry.name === "flow-findings.json");
    assert.equal(findingsInput.document.entries.some((entry) => (
      entry.sourceObservation.observed === "A fifth distinct semantic finding remains."
    )), true);
    const draftInput = specRequest.inputs.find((entry) => entry.name === "draft.json");
    assert.equal(draftInput.document.questionLedger.questions[0].state, "AnsweredQuestion");
  } finally {
    removeTmpDir(root);
  }
});
