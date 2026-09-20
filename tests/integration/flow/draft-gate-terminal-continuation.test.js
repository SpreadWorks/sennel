import assert from "node:assert/strict";
import fs from "node:fs";
import { it, mock } from "node:test";

import { DraftGateEvaluationBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { DraftGateStep } from "../../../src/flow/steps/draft/draft-gate.js";
import { StepFactory } from "../../../src/flow/engine/step-factory.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { GateService } from "../../../src/flow/services/review-service.js";
import { CanonicalGateObservationCycle } from "../../../src/flow/lib/canonical-gate-observation-cycle.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { AnsweredQuestion } from "../../../src/flow/lib/draft-question-ledger.js";
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
  const originalExecute = DraftGateStep.prototype.execute;
  const executed = mock.method(DraftGateStep.prototype, "execute", function () {
    return originalExecute.call(this);
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
    assert.equal(executed.mock.callCount(), 1);
    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const gateResult = reloaded.canonicalState(specId).findNode("draft-gate").result;
    assert.equal(gateResult.stepResult.kind, "draft-gate-passed");
    assert.equal(gateResult.draftSettlementReceipt.connector.name, "DraftSpecConnector");
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "spec");
    assert.equal(reloaded.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "spec", optional: true,
    }), null);
  } finally {
    executed.mock.restore();
    removeTmpDir(root);
  }
});

it("persists the Draft Gate repair loop from the normal post path", async () => {
  const root = createTmpDir("draft-gate-post-loop-output-");
  const specId = "525-draft-gate-post-loop-output";
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate repair loop\n");
    commitAll(root, "draft Gate repair loop");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-loop-output", issue: 525,
      request: "Repair a Draft Gate finding.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      autoApprove: false,
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftWithAnsweredQuestion("Review this behavior"), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
    }).promote({ result: "fail", artifacts: {
      phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
      nextAction: { diagnosis: { observations: semanticObservations } },
    } });
    const settle = manager.settleDraftStepResult.bind(manager);
    let settleCalls = 0;
    manager.settleDraftStepResult = (input) => {
      settleCalls += 1;
      const committed = settle(input);
      throw new Error("Draft Gate repair settlement response was lost after commit");
    };
    await FLOW_COMMANDS.run.gate.post({
      root, mainRoot: root, executionRoot: root, specId, phase: "draft",
      flowManager: manager, flowState: manager.loadReadOnly(specId),
    }, result);
    manager.settleDraftStepResult = settle;

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const repair = reloaded.activityLedger(specId).findLast((activity) => (
      activity.nodeId === "draft-gate" && activity.transition.operation === "plan_gate_repair"
    ));
    assert.equal(repair.result.stepResult.kind, "draft-gate-repair-required");
    assert.equal(repair.result.draftSettlementReceipt.targetStepId, "draft-gate-repair");
    assert.equal(reloaded.canonicalState(specId).current.at(-1), "draft-gate-repair");
    const issues = JSON.parse(reloaded.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "draft-gate-repair",
    }).bytes.toString("utf8")).entries;
    assert.equal(issues.length, 2);
    assert.equal(issues.filter((entry) => entry.kind === "plan-gate-repair").length, 1);
    const source = issues.find((entry) => entry.kind !== "plan-gate-repair");
    const repairIssue = issues.find((entry) => entry.kind === "plan-gate-repair");
    assert.equal(repairIssue.planGateRepair.sourceIssueLogId, source.issueLogId);
    assert.equal(settleCalls, 1);
  } finally {
    removeTmpDir(root);
  }
});

it("rolls back Gate evidence, issue source, Result, and repair route when settlement is interrupted", async () => {
  const root = createTmpDir("draft-gate-atomic-settlement-");
  const specId = "525-draft-gate-atomic-settlement";
  let interrupt = false;
  let catalogFile = null;
  try {
    initGitRepo(root);
    fs.writeFileSync(`${root}/README.md`, "draft Gate atomic settlement\n");
    commitAll(root, "draft Gate atomic settlement");
    const manager = new FlowManager({
      root, mainRoot: root, inWorktree: false, specId,
      versionStoreFaultInjector: ({ phase, filePath }) => {
        if (interrupt && phase === "before-json-rename" && filePath === catalogFile) {
          throw new Error("injected Draft Gate settlement interruption");
        }
      },
    });
    const fixture = new CanonicalFlowFixture({
      flowManager: manager, specId, runId: "run-draft-gate-atomic", issue: 525,
      request: "Publish Draft Gate evidence atomically.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    }).create().registerActive().activate("draft");
    manager.confirmCurrentAttempt({ specId, artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(draftWithAnsweredQuestion("Atomic behavior"), null, 2)}\n`),
    }] });
    fixture.activate("draft-gate");
    const location = fixture.location();
    catalogFile = location.catalogFile;
    const paths = [
      location.flowStateFile,
      location.activitiesFile,
      location.catalogFile,
      location.artifact("draft.gate"),
      location.artifact("draft.gate.source"),
      location.artifact("issue.log"),
    ];
    const snapshot = () => paths.map((file) => (
      fs.existsSync(file) ? fs.readFileSync(file) : null
    ));
    const before = snapshot();
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
    }).promote({ result: "fail", artifacts: {
      phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
      nextAction: { diagnosis: { observations: semanticObservations } },
    } });

    interrupt = true;
    await assert.rejects(() => FLOW_COMMANDS.run.gate.post({
      root, mainRoot: root, executionRoot: root, specId, phase: "draft",
      flowManager: manager, flowState: manager.loadReadOnly(specId),
    }, result), /injected Draft Gate settlement interruption/);

    assert.deepEqual(snapshot(), before);
    assert.equal(manager.canonicalState(specId).current.at(-1), "draft-gate");
    assert.equal(manager.canonicalState(specId).attempt.failure, null);
  } finally {
    removeTmpDir(root);
  }
});

it("uses the evaluated Gate result once when the Draft Gate Step settles it", async () => {
  const root = createTmpDir("draft-gate-step-result-");
  const specId = "524-draft-gate-step-result";
  const originalInspect = GateService.prototype.inspectGateFacts;
  const inspected = mock.method(GateService.prototype, "inspectGateFacts", function () {
    return originalInspect.call(this);
  });
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
    const step = new StepFactory()
      .provideArguments(GateService, {
        flowManager: manager, binding, commandResult: result,
      })
      .create(DraftGateStep);

    assert.deepEqual((await step.execute()).toJSON(), {
      kind: "draft-gate-passed",
      type: "completed",
    });
    const history = JSON.parse(manager.readArtifact({
      specId, logicalKey: "draft.gate", consumerNodeId: "spec",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((attempt) => attempt.attempt), [1]);
    assert.equal(manager.activityLedger(specId).filter((activity) => (
      activity.nodeId === "draft-gate" && activity.transition.operation === "confirm_attempt"
    )).length, 1);
    assert.equal(inspected.mock.callCount(), 1);
    assert.equal(manager.canonicalState(specId).nextAction().nodeId, "spec");
  } finally {
    inspected.mock.restore();
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

async function dispatchDraftGateSettlement({ root, manager, specId }) {
  const result = new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
  }).promote({ result: "fail", artifacts: {
    phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations: semanticObservations } },
  } });
  await FLOW_COMMANDS.run.gate.post({
    root, mainRoot: root, executionRoot: root, specId,
    flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft",
  }, result);
  const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  assert.equal(reloaded.loadReadOnly(specId).policy.nonblocking, null);
  return reloaded;
}

async function selectDraftGateRepair({ root, manager, specId, observations }) {
  const result = new CanonicalGatePromotion({
    state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
  }).promote({ result: "fail", artifacts: {
    phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
    nextAction: { diagnosis: { observations } },
  } });
  await FLOW_COMMANDS.run.gate.post({
    root, mainRoot: root, executionRoot: root, specId,
    flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft",
  }, result);
  assert.equal(manager.canonicalState(specId).current.at(-1), "draft-gate-repair");
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
    const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId });
    await selectDraftGateRepair({ root, manager, specId, observations: semanticObservations });
    assert.throws(() => evaluation.assertCurrent(), /stale for the canonical Step Attempt/);
    scenario.createRequest();
    const payload = scenario.replacement("goal", "Unresolved behavior");
    if (kind === "no-progress") payload.operations = [];
    else {
      payload.operations[0].path = "analysis.missing";
      payload.operations[0].expectedDigest = "f".repeat(64);
    }
    const before = manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).descriptor.hash;
    if (kind === "invalid-payload") {
      const beforeAttempt = manager.canonicalState(specId).attempt;
      const beforeActivities = manager.activityLedger(specId).length;
      assert.throws(() => scenario.apply(payload), /draft Gate repair batch is invalid/);
      assert.equal(
        manager.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair" }).descriptor.hash,
        before,
      );
      assert.deepEqual(manager.canonicalState(specId).attempt, beforeAttempt);
      assert.equal(manager.activityLedger(specId).length, beforeActivities);
      assert.equal(manager.canonicalState(specId).current.at(-1), "draft-gate-repair");
      return;
    }
    const repaired = scenario.apply(payload);
    assert.equal(repaired.result.stepResult.kind, "draft-gate-repair-carry-forward");
    assert.equal(repaired.bytes.length > 0, true);
    assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => (
      entry.logicalKey === "plan.gate.repair.outcome"
    )), kind === "no-progress");
    assert.equal(manager.artifactCatalog(specId).artifacts.some((entry) => (
      entry.logicalKey === "draft.gate.repair" || entry.logicalKey === "flow.findings"
    )), false);

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(reloaded.canonicalState(specId).findNode("draft-gate-repair").status, "done");
    assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "draft-coverage-review");
    const terminalConfirmation = reloaded.activityLedger(specId).findLast((activity) => (
      activity.nodeId === "draft-gate-repair" && activity.transition.operation === "confirm_attempt"
    ));
    assert.equal(terminalConfirmation.result.stepResult.kind, "draft-gate-repair-carry-forward");
    assert.equal(terminalConfirmation.result.draftSettlementReceipt.targetStepId, "draft-coverage-review");
    assert.equal(reloaded.readArtifact({ specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" }).descriptor.hash, before);

    fixture.flowManager = reloaded;
    fixture.settle("draft-coverage-review").settle("draft-coverage-triage").settle("draft-coverage-repair").activate("draft-gate");
    const activityCount = reloaded.activityLedger(specId).length;
    const settledManager = await dispatchDraftGateSettlement({
      root, manager: reloaded, specId,
    });

    const finalReload = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(finalReload.canonicalState(specId).nextAction().nodeId, "spec");
    assert.equal(finalReload.canonicalState(specId).findNode("draft-gate").result.stepResult.kind, "draft-gate-carry-forward");
    assert.equal(finalReload.activityLedger(specId).filter((entry) => (
      entry.transition.operation === "defer_failed_gate"
    )).length, 0);
    assert.equal(finalReload.activityLedger(specId).length > activityCount, true);
    const findings = finalReload.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    });
    const persistedFindings = JSON.parse(findings.bytes);
    assert.equal(persistedFindings.entries.length, semanticObservations.length);
    assert.equal(
      new Set(persistedFindings.entries.map((entry) => entry.fingerprint)).size,
      semanticObservations.length,
    );
    const issueEntries = JSON.parse(finalReload.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "system",
    }).bytes.toString("utf8")).entries;
    assert.equal(issueEntries.filter((entry) => entry.trigger === "gate post hook (auto)").length, 2);
    assert.equal(issueEntries.filter((entry) => entry.kind === "plan-gate-repair").length, 1);
    assert.equal(new Set(issueEntries.map((entry) => entry.issueLogId)).size, issueEntries.length);
    assert.equal(new CanonicalGateObservationCycle({
      flowManager: finalReload, state: finalReload.loadReadOnly(specId),
    }).status().entries[0].finalDisposition, "deferred");
    fixture.flowManager = finalReload;
    fixture.activate("spec");
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

it("rejects invalid repair payload without changing Draft state or artifacts", async () => {
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
      const scenario = new DraftGateRepairScenario({ flowManager: manager, root, specId });
      await selectDraftGateRepair({ root, manager, specId, observations });
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
    const finalResult = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "draft", nodeId: "draft-gate",
    }).promote({ result: "fail", artifacts: {
      phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
      nextAction: { diagnosis: { observations: finalObservation } },
    } });
    await FLOW_COMMANDS.run.gate.post({
      root, mainRoot: root, executionRoot: root, specId,
      flowManager: manager, flowState: manager.loadReadOnly(specId), phase: "draft",
    }, finalResult);
    const settled = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    assert.equal(settled.canonicalState(specId).nextAction().nodeId, "spec");
    assert.equal(settled.canonicalState(specId).findNode("draft-gate").result.stepResult.kind, "draft-gate-carry-forward");
    assert.equal(settled.activityLedger(specId).filter((entry) => (
      entry.transition.operation === "defer_failed_gate"
    )).length, 0);
    settled.beginNextAction(specId);
    const findings = settled.readArtifact({
      specId, logicalKey: "flow.findings", consumerNodeId: "system",
    });
    assert.equal(JSON.parse(findings.bytes).entries.length > 0, true);
    fixture.flowManager = settled;
    fixture.activate("spec");
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
