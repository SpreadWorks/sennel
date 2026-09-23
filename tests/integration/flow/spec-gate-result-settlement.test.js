import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { SpecGateEvaluationBinding } from "../../../src/flow/engine/connectors/spec/spec-step-binding.js";
import { SpecGateService } from "../../../src/flow/services/spec-gate-service.js";
import { SpecGatePassedResult } from "../../../src/flow/engine/step-result.js";
import { SpecGateIssuePublication } from "../../../src/flow/lib/gate-issue-publication.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { SpecGateStep } from "../../../src/flow/steps/spec/spec-gate.js";
import { attachCanonicalCommandResultArtifact, CanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";

const roots = [];
afterEach(() => { while (roots.length > 0) removeTmpDir(roots.pop()); });

function setup() {
  const root = createTmpDir("spec-gate-result-");
  roots.push(root);
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const flow = new CanonicalFlowFixture({
    flowManager: manager, specId: "601-spec-gate-result", runId: "run-spec-gate-result",
  }).create().registerActive();
  flow.activate("draft");
  manager.publishArtifacts({
    specId: flow.specId, nodeId: "draft",
    artifactWrites: [{
      logicalKey: "draft", mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(canonicalDraftDocument(), null, 2)}\n`, "utf8"),
    }],
  });
  flow.settle("draft");
  flow.activate("spec-gate");
  return { root, manager, flow, binding: new SpecGateEvaluationBinding({
    flowManager: manager, specId: flow.specId,
  }) };
}

function prepare({ manager, flow, binding }, { phase = "spec", result, failureKind = null,
  observations = [] } = {}) {
  const commandResult = new CanonicalGatePromotion({
    state: manager.canonicalState(flow.specId), phase, nodeId: "spec-gate",
  }).promote({
    result,
    artifacts: {
      phase,
      ...(failureKind === null ? {} : { failureKind, failureCode: "GATE_REJECTED" }),
      nextAction: { diagnosis: { observations } },
    },
  });
  const issuePublication = result === "fail" ? new SpecGateIssuePublication({
    binding,
    entry: {
      step: "spec-gate", phase, observations,
      reason: "Gate evidence requires a decision.", trigger: "gate post hook (auto)",
      timestamp: binding.assertCurrent().attempt.startedAt,
    },
  }) : null;
  const service = new SpecGateService({ flowManager: manager, binding, commandResult, issuePublication });
  return { commandResult, service };
}

async function settle(input, options) {
  const { commandResult, service } = prepare(input, options);
  const stepResult = await new SpecGateStep(service).execute();
  const receipt = await stepResult.persist(service);
  return { commandResult, service, stepResult, receipt };
}

test("Spec Gate PASS persists one Result, Settlement, and publication with the next frontier", async () => {
  const input = setup();
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

test("Spec Gate semantic retry and exact replay persist one Result, metric, issue, and publication", async () => {
  const input = setup();
  const output = await settle(input, { result: "fail", failureKind: "ai_semantic_fail" });
  assert.equal(output.stepResult.kind, "spec-gate-retry-required");
  const state = input.manager.canonicalState(input.flow.specId);
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
  const input = setup();
  const selected = prepare(input, { result: "fail", failureKind: "ai_semantic_fail" });
  const stepResult = new SpecGateStep(selected.service).selectResult();
  assert.equal(stepResult.kind, "spec-gate-retry-required");
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
  const input = setup();
  const selected = prepare(input, { result: "fail", failureKind: "ai_semantic_fail" });
  assert.equal(new SpecGateStep(selected.service).selectResult().kind, "spec-gate-retry-required");
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
  const input = setup();
  const before = {
    state: input.manager.canonicalState(input.flow.specId).toJSON(),
    activities: input.manager.activityLedger(input.flow.specId),
  };
  const promoted = new CanonicalGatePromotion({
    state: input.manager.canonicalState(input.flow.specId), phase: "spec", nodeId: "spec-gate",
  }).promote({ result: "pass", artifacts: { phase: "spec" } });
  const bad = { result: "pass", artifacts: { ...promoted.artifacts, gateTransitionAttemptId: "wrong-attempt" } };
  attachCanonicalCommandResultArtifact(bad, new CanonicalCommandResultArtifact({
    logicalKey: "spec.gate", payload: bad,
  }));
  assert.throws(() => new SpecGateService({
    flowManager: input.manager, binding: input.binding, commandResult: bad,
  }), /stale phase, Attempt, or lineage/);
  assert.deepEqual(input.manager.canonicalState(input.flow.specId).toJSON(), before.state);
  assert.deepEqual(input.manager.activityLedger(input.flow.specId), before.activities);
  assert.equal(input.manager.readProducerArtifact({
    specId: input.flow.specId, nodeId: "spec-gate", logicalKey: "spec.gate", optional: true,
  }), null);
});

test("strict Spec Gate stop activates policy from the saved Result and receipt", async () => {
  const input = setup();
  const output = await settle(input, { result: "fail", failureKind: "mechanical" });
  assert.equal(output.stepResult.kind, "spec-gate-blocked");
  const eligibility = input.manager.readCurrentStepSettlement({
    specId: input.flow.specId, stepId: "spec-gate",
  });
  assert.equal(eligibility.receipt.id, output.receipt.id);
  const strict = await new GetNextActionCommand().execute({
    root: input.root, mainRoot: input.root, executionRoot: input.root,
    specId: input.flow.specId, flowManager: input.manager,
    flowState: input.manager.load(input.flow.specId),
  });
  assert.equal(strict.directive.actionPrompt.choices[1].actionId, "ENABLE_NONBLOCKING");
  const policy = activateNonBlockingPolicy({
    root: input.root, flowManager: input.manager, reason: "Accept the local Gate defect explicitly.",
  });
  assert.equal(policy.activatedStep, "spec-gate");
  const context = decisionContextForActiveFlow(input.root, input.manager.load(input.flow.specId), input.manager);
  assert.equal(context.resultKind, "unavailable");
  assert.equal(context.sourceAttempt, eligibility.receipt.binding.attemptSequence);
  const decision = recordNonBlockingDecision({
    root: input.root, flowManager: input.manager, choice: "retry",
    reason: "Correct the local Spec input and run Gate again.",
    expectEvidenceDigest: context.evidenceDigest,
  });
  assert.equal(decision.action, "retry");
  assert.equal(input.manager.canonicalState(input.flow.specId).attempt.sequence, context.sourceAttempt + 1);
});

test("pre-enabled Spec Gate advisory observation is atomic with its Await Result", async () => {
  const input = setup();
  await settle(input, { result: "fail", failureKind: "mechanical" });
  activateNonBlockingPolicy({
    root: input.root, flowManager: input.manager, reason: "Use explicit advisory decisions.",
  });
  const prior = decisionContextForActiveFlow(input.root, input.manager.load(input.flow.specId), input.manager);
  recordNonBlockingDecision({
    root: input.root, flowManager: input.manager, choice: "retry",
    reason: "Refresh the Spec Gate input.", expectEvidenceDigest: prior.evidenceDigest,
  });
  const binding = new SpecGateEvaluationBinding({
    flowManager: input.manager, specId: input.flow.specId,
  });
  const output = await settle({ ...input, binding }, {
    result: "fail", failureKind: "ai_semantic_fail",
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
  assert.equal(input.manager.canonicalState(input.flow.specId).attempt.sequence, context.sourceAttempt + 1);
});

test("recovered evaluator Result replaces the Attempt without semantic retry consumption", async () => {
  const input = setup();
  const before = input.manager.canonicalState(input.flow.specId).attempt;
  const output = await settle(input, { result: "recovered" });
  assert.equal(output.stepResult.kind, "spec-gate-recovered");
  const after = input.manager.canonicalState(input.flow.specId).attempt;
  assert.equal(after.sequence, before.sequence + 1);
  assert.deepEqual(after.consumption.toJSON(), before.consumption.toJSON());
  const activity = input.manager.activityLedger(input.flow.specId)
    .find((entry) => entry.result?.draftSettlementReceipt?.id === output.receipt.id);
  assert.equal(activity.transition.operation, "settle_spec_gate_recovered");
  const reloaded = new FlowManager({ root: input.root, mainRoot: input.root, inWorktree: false });
  assert.equal(reloaded.canonicalState(input.flow.specId).attempt.sequence, after.sequence);
});

test("task-spec repair requests a new external input Attempt without resetting canonical spec", async () => {
  const input = setup();
  const observations = [{
    kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
    where: { file: "task-spec.json", locator: "goal" },
    observed: "The task specification needs a precise outcome.",
    severity: "blocking", refs: ["R-1"],
  }];
  const output = await settle(input, {
    phase: "task-spec", result: "fail", failureKind: "ai_semantic_fail", observations,
  });
  assert.equal(output.stepResult.kind, "task-spec-gate-repair-required");
  assert.equal(output.receipt.settlementKind, "execution");
  const state = input.manager.canonicalState(input.flow.specId);
  assert.equal(state.current.at(-1), "spec-gate");
  assert.equal(state.attempt.sequence, output.receipt.binding.attemptSequence + 1);
  assert.equal(input.manager.activityLedger(input.flow.specId)
    .filter((entry) => entry.nodeId === "spec" && entry.transition.operation === "plan_gate_repair").length, 0);
  const spec = state.findNode("spec");
  assert.equal(spec.status, "done");
});

test("accepted contradictory Gate classification blocks even a provider PASS", async () => {
  const input = setup();
  const commandResult = new CanonicalGatePromotion({
    state: input.manager.canonicalState(input.flow.specId), phase: "spec", nodeId: "spec-gate",
  }).promote({
    result: "pass",
    artifacts: { phase: "spec", gateTransitionFailureCategory: { category: "semantic", code: "GATE_REJECTED" } },
  });
  const service = new SpecGateService({
    flowManager: input.manager, binding: input.binding, commandResult,
  });
  const result = await new SpecGateStep(service).execute();
  assert.equal(result.kind, "spec-gate-blocked");
  const receipt = await result.persist(service);
  assert.equal(receipt.settlementKind, "failure");
  assert.equal(input.manager.canonicalState(input.flow.specId).attempt.failure.code,
    "contradictory_gate_failure_classification");
});

test("semantic retry exhaustion saves a defer Result and advances only once", async () => {
  const input = setup();
  let last;
  for (let index = 0; index < 5; index += 1) {
    const binding = new SpecGateEvaluationBinding({
      flowManager: input.manager, specId: input.flow.specId,
    });
    last = await settle({ ...input, binding }, {
      result: "fail", failureKind: "ai_semantic_fail",
    });
    assert.equal(last.stepResult.kind, index === 4 ? "spec-gate-deferred" : "spec-gate-retry-required");
  }
  assert.equal(input.manager.canonicalState(input.flow.specId).nextAction().nodeId, "approval");
  const count = input.manager.activityLedger(input.flow.specId).length;
  assert.equal((await last.stepResult.persist(last.service)).id, last.receipt.id);
  assert.equal(input.manager.activityLedger(input.flow.specId).length, count);
});
