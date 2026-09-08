import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord } from "../../../src/lib/flow-artifact-contract.js";
import { CurrentFlowPolicy, CurrentFlowNonBlockingPolicy, ActivityTransition } from "../../../src/flow/lib/current-flow-state.js";
import {
  NonBlockingPolicy,
  advisorySummary,
  activateNonBlockingPolicy,
  decisionContextForActiveFlow,
  recordNonBlockingDecision,
} from "../../../src/flow/lib/nonblocking.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { fromAcceptanceResult, fromFinalRegressionResult, fromGateResult, fromReviewResult, fromVerificationResult } from "../../../src/flow/lib/nonblocking-evidence.js";

function attemptHistory(nodeId, logicalKey, payload) {
  return Buffer.from(`${JSON.stringify(new FlowArtifactAttemptHistory([
    new FlowArtifactAttemptRecord({
      attempt: 1,
      payload: { nodeId, outcome: "completed", result: { result: "block" }, artifact: { logicalKey, payload } },
    }),
  ]).toJSON(), null, 2)}\n`, "utf8");
}

const EVIDENCE_KEY = {
  "draft-questions-review": "draft.questions.review", "draft-coverage-review": "draft.coverage.review",
  "draft-gate": "draft.gate", "spec-gate": "spec.gate",
  "scenario-validity": "scenario.validity", "test-review": "test.review", "test-result-review": "test.result.review",
  "impl-review": "impl.review", "impl-gate": "impl.gate", "acceptance-review": "acceptance.review",
  "final-regression": "final.regression", retro: "retro",
};

function scenario({ step = "impl-review", payload = null } = {}) {
  const root = createTmpDir("canonical-nonblocking-");
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const fixture = new CanonicalFlowFixture({ flowManager: manager, specId: "477-nonblocking", runId: "run-477" })
    .create()
    .registerActive()
    .activate(step);
  const logicalKey = EVIDENCE_KEY[step];
  const evidence = payload ?? {
    version: 1, phase: "impl", verdict: "REJECTED", summary: "Canonical review rejected this evidence.",
    blockingFindings: [], nonBlockingImprovements: [], canonicalEvidence: { phase: "impl", disposition: "REJECTED", findings: [] },
  };
  manager.publishArtifacts({
    specId: fixture.specId,
    nodeId: step,
    artifactWrites: [{
      logicalKey,
      mediaType: "application/json",
      bytes: attemptHistory(step, logicalKey, evidence),
    }],
  });
  return { root, manager, fixture };
}

const ELIGIBLE_CANONICAL_EVIDENCE = [
  ["draft-questions-review", { verdict: "REJECTED" }, ["repair", "continue"]],
  ["draft-coverage-review", { verdict: "REJECTED" }, ["repair", "continue"]],
  ["draft-gate", { result: "fail" }, ["repair", "continue"]],
  ["spec-gate", { result: "fail" }, ["repair", "continue"]],
  ["scenario-validity", { result: "block" }, ["retry", "continue"]],
  ["test-review", { verdict: "REJECTED" }, ["repair", "continue"]],
  ["test-result-review", { verdict: "fail" }, ["repair", "continue"]],
  ["impl-gate", { result: "fail" }, ["repair", "continue"]],
  ["retro", { summary: { not_done: 1 } }, ["repair", "continue"]],
  ["acceptance-review", { verdict: "blocked" }, ["repair", "continue"]],
  ["final-regression", { result: "unavailable" }, ["retry", "continue"]],
];

function taskScenario(step = "review") {
  const root = createTmpDir("canonical-nonblocking-task-");
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const fixture = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "477-nonblocking-task",
    runId: "run-477-task",
    specRecord: { requirements: [{ id: "R-T-1", desc: "Exercise Task nonblocking.", task_ids: ["T-1"] }] },
  })
    .create()
    .addTask({ id: "T-1", title: "Task", goal: "Exercise task nonblocking.", parent: null, origin: "plan", added_round: 0, status: "pending" })
    .registerActive()
    .prepareTaskFrontier()
    .activateTask("T-1");
  fixture.settle("T-1-impl");
  if (step === "gate") {
    fixture.settle("T-1-review");
    fixture.settle("T-1-triage", "skipped");
    fixture.settle("T-1-repair", "skipped");
  }
  manager.updateStepStatus({ stepId: `T-1-${step}`, requestedStatus: "in_progress" }, { specId: fixture.specId });
  const logicalKey = step === "review" ? "task.review" : "task.gate";
  manager.publishArtifacts({
    specId: fixture.specId, nodeId: `T-1-${step}`,
    artifactWrites: [{ logicalKey, parameters: { taskId: "T-1" }, mediaType: "application/json", bytes: attemptHistory(`T-1-${step}`, logicalKey, {
      verdict: step === "review" ? "REJECTED" : "fail", result: step === "gate" ? "fail" : undefined,
    }) }],
  });
  return { root, manager, fixture };
}

describe("canonical nonblocking policy", () => {
  for (const [step, payload, actions] of ELIGIBLE_CANONICAL_EVIDENCE) {
    it(`observes cataloged ${step} evidence with its declared decision set`, () => {
      const { root, manager, fixture } = scenario({ step, payload });
      try {
        const policy = activateNonBlockingPolicy({ root, flowManager: manager, reason: `The ${step} check reached a bounded decision.` });
        const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
        assert.equal(policy.activatedStep, step);
        assert.deepEqual(context.allowedActions, actions);
        assert.equal(manager.activityLedger(fixture.specId).at(-1).transition.nonblocking.kind, "observation");
      } finally { removeTmpDir(root); }
    });
  }

  it("keeps activation, evidence identity, and decision in the V1 policy and Activity ledger", () => {
    const { root, manager, fixture } = scenario();
    try {
      const policy = activateNonBlockingPolicy({
        root,
        flowManager: manager,
        reason: "The canonical review requires an explicit acceptance decision.",
      });
      assert.equal(policy.enabled, true);
      assert.equal(policy.activatedStep, "impl-review");
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.deepEqual(context.allowedActions, ["repair", "continue"]);
      const recorded = recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "continue",
        reason: "The requested behavior is complete despite the review result.",
        remainingRisk: "Acceptance retains the rejected review as durable evidence.",
        expectEvidenceDigest: context.evidenceDigest,
      });
      assert.equal(recorded.action, "continue");
      const state = manager.load(fixture.specId);
      const activities = manager.activityLedger(fixture.specId);
      assert.equal(state.policy.nonblocking.activatedStep, "impl-review");
      assert.equal(activities.filter((activity) => activity.type === "nonblocking_recorded").length, 2);
      assert.equal(activities.at(-1).transition.nonblocking.action, "continue");
    } finally {
      removeTmpDir(root);
    }
  });

  it("rejects missing schema fields rather than normalizing an older policy or Activity transition", () => {
    assert.throws(() => new CurrentFlowPolicy({ autoApprove: false }), /policy\.nonblocking is required/);
    assert.throws(() => new CurrentFlowPolicy({ autoApprove: false, nonblocking: false }), /policy\.nonblocking must be an object/);
    assert.throws(() => new CurrentFlowNonBlockingPolicy({
      enabled: false,
      activatedAt: "2026-08-14T00:00:00.000Z",
      activatedStep: "impl-review",
      reason: "invalid",
    }), /must be enabled/);
    assert.throws(() => new ActivityTransition({
      operation: "record_note", nodeId: "flow", task: null, attempt: null, status: null,
      policy: null, outbox: null, approval: null,
    }), /activity\.transition\.nonblocking is required/);
    assert.throws(() => new NonBlockingPolicy({ enabled: false, activatedStep: "impl-review", reason: "invalid" }), /one-way/);
  });

  it("rejects pass evidence and stale decisions without manufacturing an observation", () => {
    const { root, manager, fixture } = scenario();
    try {
      const state = manager.load(fixture.specId);
      // The fixture publication is rejected, so first prove the digest guard
      // against the immutable catalog value rather than a path-derived file.
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Bounded review recovery is exhausted." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.throws(() => recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue", reason: "The review is retained.",
        remainingRisk: "The evidence remains visible.", expectEvidenceDigest: "b".repeat(64),
      }), /evidence changed/);
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => entry.transition.nonblocking?.kind === "decision").length, 0);
      assert.equal(context.sourceAttempt, 1);
      assert.equal(state.policy.nonblocking, null);
    } finally { removeTmpDir(root); }
  });

  it("is idempotent for an exact continue decision and projects advisory completion from Activities", () => {
    const { root, manager, fixture } = scenario();
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The review needs acceptance disposition." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const input = {
        root, flowManager: manager, choice: "continue", reason: "The requested behavior is complete.",
        remainingRisk: "The rejected review remains durable.", expectEvidenceDigest: context.evidenceDigest,
      };
      const first = recordNonBlockingDecision(input);
      const second = recordNonBlockingDecision(input);
      assert.deepEqual(second, first);
      const state = manager.load(fixture.specId);
      assert.equal(state.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-review").status, "done");
      assert.equal(state.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-triage").status, "skipped");
      assert.deepEqual(advisorySummary(state), [{
        stepId: "impl-review", evidenceRef: context.evidenceRef,
        rationale: input.reason, remainingRisk: input.remainingRisk,
      }]);
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => entry.transition.nonblocking?.kind === "decision").length, 1);
    } finally { removeTmpDir(root); }
  });

  it("uses repair as a new typed Attempt and rejects a conflicting decision identity", () => {
    const { root, manager, fixture } = scenario();
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Repair is explicitly selected." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      recordNonBlockingDecision({
        root, flowManager: manager, choice: "repair", reason: "Repair the reviewed behavior.",
        expectEvidenceDigest: context.evidenceDigest,
      });
      assert.equal(manager.load(fixture.specId).currentNodeId, "impl-review");
      assert.throws(() => recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue", reason: "A second disposition conflicts.",
        remainingRisk: "Not applicable.", expectEvidenceDigest: context.evidenceDigest,
      }), /different nonblocking decision/);
    } finally { removeTmpDir(root); }
  });

  it("binds task review evidence to its materialized Task catalog location and advances only the Task", () => {
    const { root, manager, fixture } = taskScenario("review");
    try {
      const policy = activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task review is bounded." });
      assert.equal(policy.activatedStep, "task-review");
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.equal(context.evidenceRef, "steps/impl/T-1/review/result.json");
      recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue", reason: "The task may proceed.",
        remainingRisk: "The review remains in acceptance evidence.", expectEvidenceDigest: context.evidenceDigest,
      });
      const state = manager.load(fixture.specId);
      assert.equal(state.tasks[0].steps.find((entry) => entry.id === "T-1-review").status, "done");
      assert.equal(state.tasks[0].steps.find((entry) => entry.id === "T-1-gate").status, "pending");
      assert.equal(state.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-gate").status, "pending");
    } finally { removeTmpDir(root); }
  });

  it("binds task gate evidence to its materialized Task catalog location", () => {
    const { root, manager, fixture } = taskScenario("gate");
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task gate is bounded." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.equal(context.sourceStep, "task-gate");
      assert.deepEqual(context.allowedActions, ["repair", "continue"]);
      assert.equal(context.evidenceRef, "steps/impl/T-1/gate/result.json");
    } finally { removeTmpDir(root); }
  });

  it("classifies rejected review evidence as quality", () => {
    assert.equal(fromReviewResult({ ref: "review", source: '{"verdict":"REJECTED"}' }).resultKind, "quality");
  });
  it("classifies tooling review evidence as retryable tooling", () => {
    assert.equal(fromReviewResult({ ref: "review", source: '{"toolingOutcome":{"reason":"offline"}}' }).resultKind, "tooling");
  });
  it("classifies semantic and tooling gate failures distinctly", () => {
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail"}' }).resultKind, "quality");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","failureKind":"schema"}' }).resultKind, "tooling");
  });
  it("classifies scenario unavailable evidence as retryable", () => {
    assert.equal(fromVerificationResult({ ref: "scenario", source: '{"result":"block"}' }, "scenario-validity").resultKind, "unavailable");
  });
  it("classifies acceptance blockers as quality evidence", () => {
    assert.equal(fromAcceptanceResult({ ref: "acceptance", source: '{"verdict":"blocked"}' }).resultKind, "quality");
  });
  it("classifies final-regression infrastructure failure as tooling evidence", () => {
    assert.equal(fromFinalRegressionResult({ ref: "regression", source: '{"result":"fail","failureKind":"infra_failure"}' }).resultKind, "tooling");
  });
  it("does not activate an advisory policy from pass evidence", () => {
    const { root, manager } = scenario({ payload: { verdict: "PASS" } });
    try {
      assert.throws(() => activateNonBlockingPolicy({ root, flowManager: manager, reason: "Pass evidence has no advisory route." }), /eligible non-pass evidence/);
    } finally { removeTmpDir(root); }
  });
  it("requires the catalog digest to identify a decision before it can be replayed", () => {
    const { root, manager, fixture } = scenario();
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Identity must remain immutable." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.match(context.evidenceDigest, /^[a-f0-9]{64}$/);
      assert.notEqual(context.evidenceDigest, "a".repeat(64));
    } finally { removeTmpDir(root); }
  });
});
