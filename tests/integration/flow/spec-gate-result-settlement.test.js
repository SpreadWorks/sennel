import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture, FlowAtStepFixture } from "../../support/infrastructure/flow-setup.js";
import { SpecPhaseScenario } from "../../support/spec-phase-scenario.js";
import { SeedWorkRoot } from "../../support/builders/seed-work-root.js";
import { CanonicalPersistenceSnapshot } from "../../support/assertions/canonical-persistence.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { fixtureRepository, passingGateProviderResponse } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { produceGateResult } from "../../support/infrastructure/query-draft-review-scenario.js";
import { validWorkerHandoffSpec, validWorkerHandoffTaskSpec } from "../../support/infrastructure/worker-artifact.js";
import { SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { SpecGateService } from "../../../src/flow/services/spec-gate-service.js";
import { specStepRegistration } from "../../../src/flow/engine/composition/spec.js";
import { SpecGatePassedResult } from "../../../src/flow/engine/step-result.js";
import { SpecGateIssuePublication } from "../../../src/flow/lib/gate-issue-publication.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { SpecGateStep } from "../../../src/flow/steps/spec/spec-gate.js";
import { attachCanonicalCommandResultArtifact, CanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow } from "../../../src/flow/lib/nonblocking.js";
import { recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking-decision.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";

const roots = [];
afterEach(() => { while (roots.length > 0) removeTmpDir(roots.pop()); });

async function setup() {
  const root = fixtureRepository("spec-gate-result-");
  roots.push(root);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const fixture = new FlowAtStepFixture({
    flowManager: manager, specId: "601-spec-gate-result", runId: "run-spec-gate-result",
    request: "Persist the selected Gate outcome and its exact evidence through replay.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
    specRecord: validWorkerHandoffSpec(), taskDocuments: validWorkerHandoffTaskSpec().tasks,
    targetStep: "spec-gate",
  });
  await fixture.createWithProducers();
  const flow = fixture.flow.flow;
  return { root, manager, flow, binding: new SpecGateEvaluationBinding({
    flowManager: manager, specId: flow.specId,
  }) };
}

async function evaluate({ root, manager, flow, binding }, { phase = "spec", result, failureKind = null,
  observations = [], config = {}, taskSpecText = null } = {}) {
  const failed = result === "fail";
  const semantic = failed && failureKind === "ai_semantic_fail";
  const findings = semantic && observations.length === 0 ? [{
    failureMode: "guardrail-violation", requirementRef: "R-1",
    where: { file: phase === "task-spec" ? "task-spec.md" : "spec.json", locator: "goal" },
    observed: "The selected goal omits the bounded required outcome.",
  }] : observations;
  fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), JSON.stringify({ guardrails:
    [...new Set(findings.map(({ requirementRef }) => requirementRef).concat("R-1"))].map((id) => ({
      id, body: "Require a precise, bounded outcome.", meta: { phase: [phase], category: "requirements" },
    })),
  }));
  if (phase === "task-spec") fs.writeFileSync(path.join(root, "task-spec.md"), taskSpecText ??
    "# Task specification\n\n## Clarifications\nNone.\n\n## Open Questions\nNone.\n\n## User Confirmation\nConfirmed.\n\n## Acceptance Criteria\nThe required outcome is observable.\n");
  const ctx = { root, mainRoot: root, executionRoot: root, specId: flow.specId,
    phase, flowManager: manager, flowState: manager.loadReadOnly(flow.specId),
    config,
    ...(phase === "task-spec" ? { spec: "task-spec.md" } : {}),
  };
  const commandResult = await produceGateResult(ctx, semantic ? () => JSON.stringify({
    observations: findings.map(({ failureMode, requirementRef, where, observed }) => ({
      failureMode, requirementRef, where, observed,
      ...(phase !== "spec" ? {} : {
        targets: [{ entity: "spec", field: where.locator }],
        allowedTargets: [{ target: { entity: "spec", field: where.locator }, operationKinds: ["replace-field"] }],
      }),
    })),
  }) : passingGateProviderResponse);
  assert.equal(commandResult.result, result, JSON.stringify(commandResult));
  if (semantic) assert.equal(commandResult.artifacts.failureKind, "ai_semantic_fail");
  const issuePublication = result === "fail" ? new SpecGateIssuePublication({
    binding,
    entry: {
      step: "spec-gate", phase, observations: commandResult.artifacts.nextAction.diagnosis.observations,
      reason: "Gate evidence requires a decision.", trigger: "gate post hook (auto)",
      timestamp: binding.assertCurrent().attempt.startedAt,
    },
  }) : null;
  return { commandResult, issuePublication };
}

async function prepare(input, options) {
  const { commandResult, issuePublication } = await evaluate(input, options);
  const prepared = await specStepRegistration("spec-gate").create({
    flowManager: input.manager, binding: input.binding, commandResult, issuePublication,
  });
  return { commandResult, service: prepared.dependency(SpecGateService), step: prepared.step };
}

async function settle(input, options) {
  const { commandResult, service, step } = await prepare(input, options);
  const stepResult = await step.execute();
  const receipt = await stepResult.persist(service);
  return { commandResult, service, stepResult, receipt };
}

test("Spec Gate PASS persists one Result, Settlement, and publication with the next frontier", async () => {
  const input = await setup();
  const output = await settle(input, { result: "pass" });
  assert.equal(output.stepResult.kind, "spec-gate-passed");
  assert.equal(output.receipt.targetStepId, "approval");
  assert.equal(input.manager.canonicalState(input.flow.specId).nextAction().nodeId, "approval");
  assert.equal(input.manager.readArtifact({
    specId: input.flow.specId, consumerNodeId: "approval", logicalKey: "spec.gate",
  }).descriptor.activityId !== null, true);
  const count = input.manager.activityLedger(input.flow.specId).length;
  const replay = await output.stepResult.persist(output.service);
  assert.equal(replay.id, output.receipt.id);
  assert.equal(input.manager.activityLedger(input.flow.specId).length, count);
});

test("Task Spec Gate semantic repair and exact replay persist one Result, metric, issue, and publication", async () => {
  const input = await setup();
  const output = await settle(input, { phase: "task-spec", result: "fail", failureKind: "ai_semantic_fail" });
  assert.equal(output.stepResult.kind, "task-spec-gate-repair-required");
  const state = input.manager.canonicalState(input.flow.specId);
  assert.equal(output.receipt.settlementKind, "execution");
  assert.equal(state.current.at(-1), "spec-gate");
  assert.equal(state.findNode("spec").status, "done");
  assert.equal(input.manager.activityLedger(input.flow.specId).filter((activity) => (
    activity.nodeId === "spec" && activity.transition.operation === "plan_gate_repair"
  )).length, 0);
  assert.equal(state.attempt.failure, null);
  assert.equal(state.attempt.sequence, output.receipt.binding.attemptSequence + 1);
  const activities = input.manager.activityLedger(input.flow.specId);
  const settled = activities.find((activity) => activity.result?.draftSettlementReceipt?.id === output.receipt.id);
  assert.equal(settled.transition.operation, "settle_spec_gate_retry");
  assert.equal(settled.failure.category, "semantic");
  assert.equal(settled.metric.counter, "gateRetry");
  assert.equal(input.manager.readProducerArtifact({
    specId: input.flow.specId, nodeId: "spec-gate", logicalKey: "spec.gate",
  }).descriptor.activityId, settled.id);
  const issue = input.manager.readArtifact({
    specId: input.flow.specId, logicalKey: "issue.log", consumerNodeId: "spec-gate",
  });
  assert.equal(JSON.parse(issue.bytes.toString("utf8")).entries.length, 1);
  const beforeReplay = {
    state: state.toJSON(),
    activities: activities,
    catalog: input.manager.artifactCatalog(input.flow.specId).toJSON(),
    issue: issue.bytes.toString("utf8"),
  };
  assert.equal((await output.stepResult.persist(output.service)).id, output.receipt.id);
  const reloaded = new FlowManager({ root: input.root, mainRoot: input.root, inWorktree: false });
  assert.deepEqual(reloaded.canonicalState(input.flow.specId).toJSON(), beforeReplay.state);
  assert.deepEqual(reloaded.activityLedger(input.flow.specId), beforeReplay.activities);
  assert.deepEqual(reloaded.artifactCatalog(input.flow.specId).toJSON(), beforeReplay.catalog);
  assert.equal(reloaded.readArtifact({
    specId: input.flow.specId, logicalKey: "issue.log", consumerNodeId: "spec-gate",
  }).bytes.toString("utf8"), beforeReplay.issue);
  assert.equal(reloaded.activityLedger(input.flow.specId).filter((entry) => (
    entry.result?.draftSettlementReceipt?.id === output.receipt.id
  )).length, 1);
  assert.equal(reloaded.activityLedger(input.flow.specId).filter((entry) => (
    entry.metric?.counter === "gateRetry" && entry.nodeId === "spec-gate"
  )).length, 1);
});

test("Spec Gate rejects a stale selected Result after a legal policy version change", async () => {
  const input = await setup();
  const selected = await prepare(input, { result: "fail", failureKind: "ai_semantic_fail" });
  const stepResult = new SpecGateStep(selected.service).selectResult();
  assert.equal(stepResult.kind, "spec-gate-repair-required");
  const attemptId = input.manager.canonicalState(input.flow.specId).attempt.id;
  input.manager.setAutoApprove(true, { specId: input.flow.specId });
  assert.equal(input.manager.canonicalState(input.flow.specId).attempt.id, attemptId);
  const before = {
    state: input.manager.canonicalState(input.flow.specId).toJSON(),
    activities: input.manager.activityLedger(input.flow.specId),
    catalog: input.manager.artifactCatalog(input.flow.specId).toJSON(),
  };
  await assert.rejects(() => stepResult.persist(selected.service),
    { code: "STEP_RESULT_ERROR_PERSISTENCE_FAILED" });
  assert.deepEqual(input.manager.canonicalState(input.flow.specId).toJSON(), before.state);
  assert.deepEqual(input.manager.activityLedger(input.flow.specId), before.activities);
  assert.deepEqual(input.manager.artifactCatalog(input.flow.specId).toJSON(), before.catalog);
  assert.equal(input.manager.readCurrentStepSettlement({
    specId: input.flow.specId, stepId: "spec-gate",
  }), null);
  for (const logicalKey of ["spec.gate", "issue.log"]) {
    assert.equal(input.manager.readProducerArtifact({
      specId: input.flow.specId, nodeId: "spec-gate", logicalKey, optional: true,
    }), null);
  }
});

test("Spec Gate refuses a PASS Result for accepted failure evidence without publication", async () => {
  const input = await setup();
  const selected = await prepare(input, { result: "fail", failureKind: "ai_semantic_fail" });
  assert.equal(new SpecGateStep(selected.service).selectResult().kind, "spec-gate-repair-required");
  const before = {
    state: input.manager.canonicalState(input.flow.specId).toJSON(),
    activities: input.manager.activityLedger(input.flow.specId),
    catalog: input.manager.artifactCatalog(input.flow.specId).toJSON(),
  };
  await assert.rejects(() => new SpecGatePassedResult().persist(selected.service),
    /Spec Gate Result differs from its sealed Step selection/);
  assert.deepEqual(input.manager.canonicalState(input.flow.specId).toJSON(), before.state);
  assert.deepEqual(input.manager.activityLedger(input.flow.specId), before.activities);
  assert.deepEqual(input.manager.artifactCatalog(input.flow.specId).toJSON(), before.catalog);
  assert.equal(input.manager.readCurrentStepSettlement({
    specId: input.flow.specId, stepId: "spec-gate",
  }), null);
  assert.equal(input.manager.readProducerArtifact({
    specId: input.flow.specId, nodeId: "spec-gate", logicalKey: "spec.gate", optional: true,
  }), null);
  assert.equal(input.manager.readArtifact({
    specId: input.flow.specId, consumerNodeId: "spec-gate", logicalKey: "issue.log", optional: true,
  }), null);
});

test("stale Spec Gate payload refuses publication without canonical mutation", async () => {
  const input = await setup();
  const { commandResult: promoted } = await prepare(input, { result: "pass" });
  const before = {
    state: input.manager.canonicalState(input.flow.specId).toJSON(),
    activities: input.manager.activityLedger(input.flow.specId),
  };
  const bad = { result: "pass", artifacts: { ...promoted.artifacts, gateTransitionAttemptId: "wrong-attempt" } };
  attachCanonicalCommandResultArtifact(bad, new CanonicalCommandResultArtifact({
    logicalKey: "spec.gate", payload: bad,
  }));
  await assert.rejects(() => specStepRegistration("spec-gate").create({
    flowManager: input.manager, binding: input.binding, commandResult: bad,
  }), /stale phase, Attempt, or lineage/);
  assert.deepEqual(input.manager.canonicalState(input.flow.specId).toJSON(), before.state);
  assert.deepEqual(input.manager.activityLedger(input.flow.specId), before.activities);
  assert.equal(input.manager.readProducerArtifact({
    specId: input.flow.specId, nodeId: "spec-gate", logicalKey: "spec.gate", optional: true,
  }), null);
});

test("unaccepted Spec Gate prerequisite failure refuses semantic publication without mutation", async () => {
  const input = await setup();
  const observed = await evaluate(input, { result: "fail", failureKind: "prerequisite",
    config: { type: "missing-gate-fixture-preset" } });
  assert.equal(observed.commandResult.artifacts.failureKind, "prerequisite");
  assert.equal(observed.commandResult.artifacts.failureCode, "GATE_PRESET_NOT_FOUND");
  const before = new CanonicalPersistenceSnapshot(input.manager, input.flow.specId);
  await assert.rejects(() => specStepRegistration("spec-gate").create({
    flowManager: input.manager, binding: input.binding, ...observed,
  }), error => error.code === "GATE_OUTPUT_TOOLING_FAILURE");
  before.assertUnchanged(input.manager, input.flow.specId, "unaccepted Gate prerequisite failure");
  assert.equal(input.manager.readProducerArtifact({ specId: input.flow.specId,
    nodeId: "spec-gate", logicalKey: "spec.gate", optional: true }), null);
});

test("strict Spec Gate stop activates policy from the saved Result and receipt", async (t) => {
  const seed = await SpecPhaseScenario.seed(t);
  const clone = new SeedWorkRoot(seed.root, { prefix: "sennel-spec-gate-policy-" });
  t.after(() => clone.cleanup());
  const root = clone.root;
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: seed.specId });
  seed.assertClone(manager);
  const flow = CanonicalFlowFixture.fromExisting({ flowManager: manager, specId: seed.specId });
  const saved = manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "spec-gate" });
  assert.equal(saved.result.kind, "spec-gate-blocked");
  assert.equal(saved.result.error.data.reason, "cycle-limit");
  const strict = await new GetNextActionCommand().execute({ root, mainRoot: root, executionRoot: root,
    specId: flow.specId, flowManager: manager, flowState: manager.loadReadOnly(flow.specId) });
  assert.equal(strict.directive.kind, "blocked");
  assert.equal(strict.directive.requiresUserAction, false);
  assert.match(strict.directive.resumeInstruction, /sennel flow set policy nonblocking/);
  const policy = activateNonBlockingPolicy({ root, flowManager: manager,
    reason: "Retain the normally exhausted Spec Gate finding for Acceptance." });
  assert.equal(policy.activatedStep, "spec-gate");
  const context = decisionContextForActiveFlow(root, manager.loadReadOnly(flow.specId), manager);
  assert.equal(context.resultKind, "quality");
  assert.equal(context.sourceAttempt, saved.receipt.binding.attemptSequence);
  assert.deepEqual(context.allowedActions, ["continue"]);
  const decision = recordNonBlockingDecision({ root, flowManager: manager, choice: "continue",
    reason: "Carry this exact bounded source to Acceptance.",
    remainingRisk: "Acceptance must dispose of the retained Spec Gate finding.",
    expectEvidenceDigest: context.evidenceDigest });
  assert.equal(decision.action, "continue");
  assert.equal(manager.canonicalState(flow.specId).findNode("spec-gate").status, "done");
});

test("pre-enabled Spec Gate advisory observation is atomic with its Await Result", async () => {
  const input = await setup();
  const local = await settle(input, { phase: "task-spec", result: "fail", failureKind: "mechanical",
    taskSpecText: "# Incomplete public Task Spec input\n" });
  assert.equal(local.stepResult.kind, "task-spec-gate-blocked");
  assert.equal(local.stepResult.error.data.reason, "local");
  activateNonBlockingPolicy({ root: input.root, flowManager: input.manager,
    reason: "Use explicit advisory decisions after the actual local input stop." });
  const prior = decisionContextForActiveFlow(input.root, input.manager.loadReadOnly(input.flow.specId), input.manager);
  assert.equal(prior.resultKind, "unavailable");
  recordNonBlockingDecision({ root: input.root, flowManager: input.manager, choice: "retry",
    reason: "Retry with the valid canonical Spec and a fresh Gate Attempt.",
    expectEvidenceDigest: prior.evidenceDigest });
  const binding = new SpecGateEvaluationBinding({
    flowManager: input.manager, specId: input.flow.specId,
  });
  const output = await settle({ ...input, binding }, {
    result: "fail", failureKind: "ai_semantic_fail",
    observations: [{
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "spec.json", locator: "background" },
      observed: "The Spec omits the required behavior.", severity: "blocking", refs: ["R-1"],
    }],
  });
  assert.equal(output.stepResult.kind, "spec-gate-awaiting-decision");
  const activity = input.manager.activityLedger(input.flow.specId)
    .find((entry) => entry.result?.draftSettlementReceipt?.id === output.receipt.id);
  assert.equal(activity.transition.nonblocking.kind, "observation");
  const context = decisionContextForActiveFlow(input.root, input.manager.load(input.flow.specId), input.manager);
  assert.equal(context.resultKind, "quality");
  assert.equal(context.evidenceDigest, activity.transition.nonblocking.evidenceDigest);
  const decision = recordNonBlockingDecision({
    root: input.root, flowManager: input.manager, choice: "repair",
    reason: "Repair the accepted semantic evidence before continuing.",
    expectEvidenceDigest: context.evidenceDigest,
  });
  assert.equal(decision.action, "repair");
  const repaired = input.manager.canonicalState(input.flow.specId);
  assert.equal(repaired.current.at(-1), "spec-gate-repair");
  assert.equal(repaired.findNode("spec-gate").status, "failed");
  assert.equal(input.manager.activityLedger(input.flow.specId).filter((entry) => (
    entry.nodeId === "spec-gate-repair" && entry.transition.operation === "plan_gate_repair"
      && entry.transition.nonblocking?.action === "repair"
  )).length, 1);
});

test("accepted contradictory Gate classification blocks even a provider PASS", async () => {
  const input = await setup();
  const { commandResult: actual } = await prepare(input, { result: "pass" });
  const commandResult = new CanonicalGatePromotion({
    state: input.manager.canonicalState(input.flow.specId), phase: "spec", nodeId: "spec-gate",
  }).promote({
    result: "pass",
    artifacts: { ...actual.artifacts, gateTransitionFailureCategory: { category: "semantic", code: "GATE_REJECTED" } },
  });
  const prepared = await specStepRegistration("spec-gate").create({
    flowManager: input.manager, binding: input.binding, commandResult,
  });
  const service = prepared.dependency(SpecGateService);
  const result = await prepared.step.execute();
  assert.equal(result.kind, "spec-gate-blocked");
  const receipt = await result.persist(service);
  assert.equal(receipt.settlementKind, "failure");
  assert.equal(input.manager.canonicalState(input.flow.specId).attempt.failure.code,
    "contradictory_gate_failure_classification");
});
