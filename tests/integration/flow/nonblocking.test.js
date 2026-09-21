import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord } from "../../../src/lib/flow-artifact-contract.js";
import { CurrentFlowPolicy, CurrentFlowNonBlockingPolicy, ActivityTransition, ActivityNonBlockingRecord } from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalFlowRuntime } from "../../../src/flow/lib/canonical-flow-runtime.js";
import { CanonicalFlowManagerStore } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import {
  NonBlockingPolicy,
  advisorySummary,
  activateNonBlockingPolicy,
  definitionNonblockingEligibilityForActiveFlow,
  decisionContextForActiveFlow,
  decisionEvidenceForActiveFlow,
  recordNonBlockingDecision,
} from "../../../src/flow/lib/nonblocking.js";
import { CanonicalFlowFixture } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { fromAcceptanceResult, fromFinalRegressionResult, fromGateResult, fromReviewResult, fromVerificationResult } from "../../../src/flow/lib/nonblocking-evidence.js";
import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { resolveGateTransition } from "../../../src/flow/definition.js";
import { appendIssueLogFromGateResult } from "../../../src/flow/lib/run-gate.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunDispatchCommand, { FlowDispatchAction } from "../../../src/flow/lib/run-dispatch.js";

function attemptHistory(nodeId, logicalKey, payload) {
  return Buffer.from(`${JSON.stringify(new FlowArtifactAttemptHistory([
    new FlowArtifactAttemptRecord({
      attempt: 1,
      payload: { nodeId, outcome: "completed", result: { result: "block" }, artifact: { logicalKey, payload } },
    }),
  ]).toJSON(), null, 2)}\n`, "utf8");
}

const EVIDENCE_KEY = {
  "spec-gate": "spec.gate",
  "test-result-review": "test.result.review",
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
  const finding = {
    fingerprint: "a".repeat(64),
    disposition: "deferred",
    rationale: "Acceptance must retain this canonical semantic finding.",
  };
  const evidence = payload ?? {
    version: 1, phase: "impl", verdict: "REJECTED", summary: "Canonical review rejected this evidence.",
    blockingFindings: [finding], nonBlockingImprovements: [],
    canonicalEvidence: {
      phase: "impl", disposition: "REJECTED",
      identity: { evidenceDigest: "b".repeat(64) },
      blockingFindings: [finding], advisoryFindings: [],
    },
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
  if (step === "impl-review") {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { taskId: null });
    }
  }
  return { root, manager, fixture };
}

function taskScenario(step = "review", {
  failureKind = "mechanical",
  settleIssueLog = true,
  nextTask = false,
  reviewTooling = false,
} = {}) {
  const root = createTmpDir("canonical-nonblocking-task-");
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const fixture = new CanonicalFlowFixture({
    flowManager: manager,
    specId: "477-nonblocking-task",
    runId: "run-477-task",
    specRecord: { requirements: [{ id: "R-T-1", desc: "Exercise Task nonblocking.", task_ids: nextTask ? ["T-1", "T-2"] : ["T-1"] }] },
  })
    .create()
    .addTask({ id: "T-1", title: "Task", goal: "Exercise task nonblocking.", parent: null, origin: "plan", added_round: 0, status: "pending" });
  if (nextTask) fixture.addTask({ id: "T-2", title: "Next Task", goal: "Continue after task nonblocking.", parent: null, origin: "plan", added_round: 0, status: "pending" });
  fixture.registerActive()
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
  if (step === "gate") {
    const failure = failureKind === "ai_semantic_fail"
      ? { category: "semantic", code: "TASK_GATE_REJECTED", message: "semantic Gate rejection", retryable: true, retryKind: "semantic" }
      : ["schema", "provider"].includes(failureKind)
        ? { category: "tooling", code: failureKind === "schema" ? "GATE_SCHEMA_INVALID" : "GATE_PROVIDER_UNAVAILABLE", message: "Gate tooling unavailable", retryable: false, retryKind: null }
        : { category: "local", code: "GATE_LOCAL_INPUT_INVALID", message: "local input invalid", retryable: false, retryKind: null };
    const commandResult = new CanonicalGatePromotion({
      state: manager.canonicalState(fixture.specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({
      result: "fail",
      artifacts: {
        failureKind,
        failureCode: failure.code,
        sourceFingerprint: captureCurrentTaskSource({
          root, flowManager: manager, state: manager.load(fixture.specId), taskId: "T-1",
        }).fingerprint,
      },
    });
    manager.failCurrentAttempt({
      specId: fixture.specId,
      failure,
      commandResult,
    });
    const gateTransitionDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(fixture.specId), phase: "task-impl",
    }));
    if (settleIssueLog) appendIssueLogFromGateResult({
      root, mainRoot: root, executionRoot: root, specId: fixture.specId,
      flowManager: manager, flowState: manager.load(fixture.specId), phase: "task-impl",
      gateTransitionDecision,
      gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
    }, commandResult);
  } else {
    manager.publishArtifacts({
    specId: fixture.specId, nodeId: `T-1-${step}`,
    artifactWrites: [{ logicalKey, parameters: { taskId: "T-1" }, mediaType: "application/json", bytes: attemptHistory(`T-1-${step}`, logicalKey, {
      ...(reviewTooling
        ? { toolingOutcome: { code: "PROVIDER_UNAVAILABLE", reason: "review provider unavailable" } }
        : { verdict: "REJECTED" }),
    }) }],
    });
  }
  return { root, manager, fixture };
}

describe("canonical nonblocking policy", () => {
  for (const [step, payload] of [
    ["retro", { summary: { not_done: 1 } }],
    ["acceptance-review", { verdict: "blocked" }],
  ]) {
    it(`uses Definition-owned acceptance boundary eligibility for ${step}`, () => {
      const { root, manager, fixture } = scenario({ step, payload });
      try {
        const policy = activateNonBlockingPolicy({
          root, flowManager: manager, reason: `${step} requires explicit acceptance disposition.`,
        });
        assert.equal(policy.activatedStep, step);
        assert.equal(decisionContextForActiveFlow(root, manager.load(fixture.specId), manager).resultKind, "quality");
      } finally { removeTmpDir(root); }
    });
  }

  it("keeps activation, evidence identity, and decision in the V1 policy and Activity ledger", async () => {
    const { root, manager, fixture } = scenario();
    try {
      const commandContext = () => ({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      });
      const strict = await new GetNextActionCommand().execute(commandContext());
      assert.deepEqual(
        strict.directive.actionPrompt.choices.map((choice) => choice.actionId),
        ["KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING"],
      );
      const policy = activateNonBlockingPolicy({
        root,
        flowManager: manager,
        reason: "The canonical review requires an explicit acceptance decision.",
      });
      assert.equal(policy.enabled, true);
      assert.equal(policy.activatedStep, "impl-review");
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const enabled = await new GetNextActionCommand().execute(commandContext());
      assert.deepEqual(enabled.nonblockingDecision, context.toJSON());
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
      const activation = activities.find((activity) => activity.transition.operation === "activate_nonblocking");
      assert.equal(activation.type, "policy_updated");
      assert.equal(activation.transition.nonblocking.kind, "observation");
      assert.equal(activities.filter((activity) => activity.type === "nonblocking_recorded").length, 1);
      assert.equal(activities.at(-1).transition.nonblocking.action, "continue");
    } finally {
      removeTmpDir(root);
    }
  });

  it("recovers atomic activation and repair after a journal-first restart", () => {
    const { root, manager, fixture } = scenario();
    try {
      let crash = true;
      const crashingManager = new FlowManager({
        root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase }) {
          if (crash && phase === "activity-appended") throw new Error("simulated journal-first crash");
        },
      });
      assert.throws(() => activateNonBlockingPolicy({
        root,
        flowManager: crashingManager,
        reason: "The review remains acceptance-backed.",
      }), /simulated journal-first crash/);
      crash = false;
      const restartedManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
      const policy = activateNonBlockingPolicy({
        root,
        flowManager: restartedManager,
        reason: "The review remains acceptance-backed.",
      });
      assert.equal(policy.enabled, true);
      assert.equal(restartedManager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.operation === "activate_nonblocking").length, 1);

      const context = decisionContextForActiveFlow(root, restartedManager.load(fixture.specId), restartedManager);
      crash = true;
      const crashingDecisionManager = new FlowManager({
        root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase }) {
          if (crash && phase === "activity-appended") throw new Error("simulated decision crash");
        },
      });
      const input = {
        root,
        choice: "repair",
        reason: "Repair the rejected implementation review.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      };
      assert.throws(() => recordNonBlockingDecision({ ...input, flowManager: crashingDecisionManager }),
        /simulated decision crash/);
      crash = false;
      const resumedManager = new FlowManager({ root, mainRoot: root, inWorktree: false });
      const replay = recordNonBlockingDecision({ ...input, flowManager: resumedManager });
      assert.equal(replay.action, "repair");
      const state = resumedManager.load(fixture.specId);
      assert.equal(state.currentNodeId, "impl-review");
      assert.equal(resumedManager.canonicalState(fixture.specId).attempt.sequence, 2);
      assert.equal(resumedManager.canonicalState(fixture.specId).attempt.failure, null);
      assert.equal(resumedManager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.nonblocking?.kind === "decision").length, 1);
      assert.equal(new FlowManager({ root, mainRoot: root, inWorktree: false })
        .canonicalState(fixture.specId).attempt.sequence, 2);
    } finally {
      removeTmpDir(root);
    }
  });

  it("rejects direct Store mutations whose full evidence identity is not current", () => {
    const { root, manager, fixture } = scenario();
    try {
      activateNonBlockingPolicy({
        root, flowManager: manager, reason: "The review remains acceptance-backed.",
      });
      const state = manager.load(fixture.specId);
      const context = decisionContextForActiveFlow(root, state, manager);
      const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, manager);
      const observation = manager.activityLedger(fixture.specId)
        .find((activity) => activity.transition.operation === "activate_nonblocking")
        .transition.nonblocking;
      const policy = state.policy.nonblocking;
      for (const mutation of [
        { sourceStep: "spec-gate" },
        { sourceAttempt: context.sourceAttempt + 1 },
        { evidenceRef: "steps/impl-review/other.json" },
        { evidenceDigest: "a".repeat(64) },
        { resultKind: "tooling" },
        { definitionDigest: "b".repeat(64) },
      ]) {
        const mismatchedObservation = new ActivityNonBlockingRecord({
          ...observation,
          ...mutation,
        });
        assert.throws(() => manager.activateNonblockingPolicy({
          specId: fixture.specId,
          policy,
          observation: mismatchedObservation,
          eligibility,
        }), /current Definition-selected evidence identity|Definition-selected observation/);
        const mismatchedDecision = new ActivityNonBlockingRecord({
          kind: "decision",
          sourceStep: context.sourceStep,
          sourceAttempt: context.sourceAttempt,
          evidenceRef: context.evidenceRef,
          evidenceDigest: context.evidenceDigest,
          definitionDigest: context.definitionDigest,
          resultKind: context.resultKind,
          action: "continue",
          rationale: "Direct boundary mismatch test.",
          remainingRisk: "The canonical evidence remains unresolved.",
          ...mutation,
        });
        assert.throws(() => manager.applyNonblockingDecision({
          specId: fixture.specId,
          nodeId: "impl-review",
          record: mismatchedDecision,
          eligibility,
        }), /current Definition-selected evidence identity|does not match its Definition plan/);
      }
    } finally { removeTmpDir(root); }
  });

  it("revalidates activation and every advisory effect inside the Version transaction", () => {
    const race = ({ manager, fixture, invoke, method }) => {
      const original = CanonicalFlowRuntime.prototype[method];
      let injected = false;
      CanonicalFlowRuntime.prototype[method] = function (...args) {
        if (!injected) {
          injected = true;
          new FlowManager({
            root: manager.executionRoot(), mainRoot: manager.executionRoot(), inWorktree: false,
          })
            .appendMetric({ phase: "impl", counter: "reviewRetries", delta: 1 }, { specId: fixture.specId });
        }
        return original.apply(this, args);
      };
      try {
        assert.throws(invoke, /Definition selection changed before commit/);
      } finally {
        CanonicalFlowRuntime.prototype[method] = original;
      }
      assert.equal(injected, true);
    };

    {
      const { root, manager, fixture } = scenario();
      try {
        race({
          manager,
          fixture,
          method: "activateNonblockingPolicy",
          invoke: () => activateNonBlockingPolicy({
            root, flowManager: manager, reason: "Activation must retain its exact selection.",
          }),
        });
        assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
        assert.equal(manager.activityLedger(fixture.specId)
          .some((activity) => activity.transition.operation === "activate_nonblocking"), false);
      } finally { removeTmpDir(root); }
    }

    for (const choice of ["repair", "continue"]) {
      const { root, manager, fixture } = scenario();
      try {
        activateNonBlockingPolicy({ root, flowManager: manager, reason: "Review evidence is bounded." });
        const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
        race({
          manager,
          fixture,
          method: "continueNonblocking",
          invoke: () => recordNonBlockingDecision({
            root, flowManager: manager, choice,
            reason: `${choice} must retain its exact selection.`,
            remainingRisk: choice === "continue" ? "The review evidence remains unresolved." : null,
            expectEvidenceDigest: context.evidenceDigest,
            expectIdentity: context.identity().toJSON(),
          }),
        });
        assert.equal(manager.activityLedger(fixture.specId)
          .some((activity) => activity.transition.nonblocking?.kind === "decision"), false);
      } finally { removeTmpDir(root); }
    }

    {
      const { root, manager, fixture } = taskScenario("review", { reviewTooling: true });
      try {
        activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task Review tooling is unavailable." });
        const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
        race({
          manager,
          fixture,
          method: "continueNonblocking",
          invoke: () => recordNonBlockingDecision({
            root, flowManager: manager, choice: "retry",
            reason: "Retry must retain its exact Task selection.",
            expectEvidenceDigest: context.evidenceDigest,
            expectIdentity: context.identity().toJSON(),
          }),
        });
        assert.equal(manager.activityLedger(fixture.specId)
          .some((activity) => activity.transition.nonblocking?.kind === "decision"), false);
      } finally { removeTmpDir(root); }
    }
  });

  it("derives activation policy and admission from one canonical transition snapshot", () => {
    const { root, manager, fixture } = scenario();
    const original = CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot;
    let injected = false;
    CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = function (specId) {
      if (!injected) {
        injected = true;
        new FlowManager({ root, mainRoot: root, inWorktree: false })
          .setAutoApprove(true, { specId: fixture.specId });
      }
      return original.call(this, specId);
    };
    try {
      activateNonBlockingPolicy({
        root, flowManager: manager, reason: "Activation must preserve the snapshot policy.",
      });
    } finally {
      CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = original;
    }
    try {
      assert.equal(injected, true);
      const state = manager.canonicalState(fixture.specId);
      assert.equal(state.policy.autoApprove, true);
      assert.equal(state.policy.nonblocking.enabled, true);
      const activation = manager.activityLedger(fixture.specId)
        .find((activity) => activity.transition.operation === "activate_nonblocking");
      assert.equal(activation.transition.policy.autoApprove, true);
    } finally { removeTmpDir(root); }
  });

  it("derives a decision effect and replacement Attempt from one canonical transition snapshot", () => {
    const { root, manager, fixture } = scenario();
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Review evidence is bounded." });
      const state = manager.load(fixture.specId);
      const context = decisionContextForActiveFlow(root, state, manager);
      const eligibility = definitionNonblockingEligibilityForActiveFlow(root, state, manager);
      const record = new ActivityNonBlockingRecord({
        kind: "decision",
        sourceStep: context.sourceStep,
        sourceAttempt: context.sourceAttempt,
        evidenceRef: context.evidenceRef,
        evidenceDigest: context.evidenceDigest,
        definitionDigest: context.definitionDigest,
        resultKind: context.resultKind,
        action: "repair",
        rationale: "Repair the exact rejected review Attempt.",
        remainingRisk: null,
      });
      const originalLoad = CanonicalFlowRuntime.prototype.load;
      const originalSnapshot = CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot;
      let snapshotStarted = false;
      let competingDecisionInjected = false;
      CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = function (specId) {
        snapshotStarted = true;
        return originalSnapshot.call(this, specId);
      };
      CanonicalFlowRuntime.prototype.load = function (specId) {
        const stale = originalLoad.call(this, specId);
        if (!snapshotStarted && !competingDecisionInjected) {
          competingDecisionInjected = true;
          new FlowManager({ root, mainRoot: root, inWorktree: false }).applyNonblockingDecision({
            specId: fixture.specId,
            nodeId: "impl-review",
            record,
            eligibility,
          });
        }
        return stale;
      };
      try {
        manager.applyNonblockingDecision({
          specId: fixture.specId,
          nodeId: "impl-review",
          record,
          eligibility,
        });
      } finally {
        CanonicalFlowRuntime.prototype.load = originalLoad;
        CanonicalFlowManagerStore.prototype.readCanonicalTransitionSnapshot = originalSnapshot;
      }
      assert.equal(competingDecisionInjected, false,
        "decision settlement must not read mutable state before its canonical transition snapshot");
      const settled = manager.canonicalState(fixture.specId);
      assert.equal(settled.current.at(-1), "impl-review");
      assert.equal(settled.attempt.sequence, 2);
      assert.equal(settled.attempt.failure, null);
      assert.equal(manager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.nonblocking?.kind === "decision").length, 1);
    } finally { removeTmpDir(root); }
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

  it("rejects digest-only replay when canonical decisions have different full identities", () => {
    const digest = "d".repeat(64);
    const decision = (sourceStep, sourceAttempt, evidenceRef) => new ActivityNonBlockingRecord({
      kind: "decision",
      sourceStep,
      sourceAttempt,
      evidenceRef,
      evidenceDigest: digest,
      definitionDigest: "e".repeat(64),
      resultKind: "quality",
      action: "repair",
      rationale: "Repair the exact source.",
      remainingRisk: null,
    });
    const state = {
      schemaRevision: 3,
      specId: "477-ambiguous-replay",
      policy: { nonblocking: { enabled: true } },
      currentNodeId: null,
      currentTaskId: null,
      confirmationOrder: 9,
    };
    const flowManager = {
      load() { return state; },
      activityLedger() {
        return [
          { transition: { nonblocking: decision("impl-review", 1, "steps/impl/review/result.json") } },
          { transition: { nonblocking: decision("test-result-review", 2, "steps/test/result-review/result.json") } },
        ];
      },
      readActiveProducerArtifact() {},
      recordNonblocking() {},
      applyNonblockingDecision() {},
    };
    assert.throws(() => recordNonBlockingDecision({
      root: "/canonical-fixture",
      flowManager,
      choice: "repair",
      reason: "Repair the exact source.",
      expectEvidenceDigest: digest,
    }), (error) => error.code === "NONBLOCKING_AMBIGUOUS_REPLAY");
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

  it("does not offer review continuation without valid acceptance-backed semantic findings", async () => {
    const malformedFinding = {
      fingerprint: "c".repeat(64), disposition: "deferred",
      rationale: "Mechanical evidence cannot be deferred as a semantic finding.",
      failureKind: "schema_error",
    };
    for (const payload of [
      {
        phase: "impl", verdict: "REJECTED", blockingFindings: [],
        canonicalEvidence: null,
      },
      {
        phase: "impl", verdict: "REJECTED", blockingFindings: [malformedFinding],
        canonicalEvidence: {
          disposition: "REJECTED", identity: { evidenceDigest: "d".repeat(64) },
          blockingFindings: [malformedFinding], advisoryFindings: [],
        },
      },
    ]) {
      const { root, manager, fixture } = scenario({ payload });
      try {
        const next = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId: fixture.specId,
          flowManager: manager, flowState: manager.load(fixture.specId),
        });
        assert.equal(next.directive.actionPrompt, undefined);
        assert.equal(next.nonblockingDecision, undefined);
        assert.throws(() => activateNonBlockingPolicy({
          root, flowManager: manager,
          reason: "Invalid review evidence cannot enter acceptance.",
        }), /not selected by the current Definition strict stop/);
      } finally { removeTmpDir(root); }
    }
  });

  it("rejects a projected decision when ordinary recovery facts change without changing evidence bytes", () => {
    const { root, manager, fixture } = scenario();
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Review recovery was exhausted." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { taskId: null });
      assert.throws(() => decisionEvidenceForActiveFlow(root, manager.load(fixture.specId), manager, context),
        (error) => error.code === "NONBLOCKING_STALE_DEFINITION");
      assert.throws(() => recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "repair",
        reason: "This stale decision must not run.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      }), (error) => error.code === "NONBLOCKING_STALE_DEFINITION");
    } finally { removeTmpDir(root); }
  });

  it("publishes only the semantic finding fingerprints selected by Definition", () => {
    const selected = { fingerprint: "d".repeat(64), disposition: "deferred", rationale: "Accepted residual risk." };
    const unselected = { fingerprint: "e".repeat(64), disposition: "must-fix", rationale: "Not accepted for deferral." };
    const { root, manager, fixture } = scenario({ payload: {
      version: 1, phase: "impl", verdict: "REJECTED", summary: "Mixed review findings.",
      blockingFindings: [selected, unselected], nonBlockingImprovements: [],
      canonicalEvidence: {
        phase: "impl", disposition: "REJECTED", identity: { evidenceDigest: "f".repeat(64) },
        blockingFindings: [selected], advisoryFindings: [],
      },
    } });
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Only accepted findings may be deferred." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      recordNonBlockingDecision({
        root, flowManager: manager, choice: "continue",
        reason: "Continue with only the selected deferred finding.",
        remainingRisk: "The selected finding remains explicit for acceptance.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      });
      const findings = JSON.parse(manager.readArtifact({
        specId: fixture.specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review",
      }).bytes.toString("utf8"));
      assert.deepEqual(findings.entries.map((entry) => entry.fingerprint), [selected.fingerprint]);
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

  it("does not bypass the Definition-owned Task Review recovery connector", () => {
    const { root, manager, fixture } = taskScenario("review");
    try {
      assert.throws(() => activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task review is bounded." }),
        /not selected by the current Definition strict stop/);
      assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
    } finally { removeTmpDir(root); }
  });

  it("materializes Definition-owned Task Review tooling retry and continuation targets", async () => {
    for (const choice of ["retry", "continue"]) {
      const { root, manager, fixture } = taskScenario("review", { reviewTooling: true });
      try {
        const strict = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId: fixture.specId,
          flowManager: manager, flowState: manager.load(fixture.specId),
        });
        assert.deepEqual(strict.directive.actionPrompt.choices.map((entry) => entry.actionId), [
          "KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING",
        ]);
        activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task Review tooling is unavailable." });
        const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false });
        const context = decisionContextForActiveFlow(root, reloaded.load(fixture.specId), reloaded);
        assert.equal(context.sourceStep, "task-review");
        assert.equal(context.continueTargetStepId, "task-gate");
        recordNonBlockingDecision({
          root, flowManager: reloaded, choice,
          reason: `${choice} the unavailable Task Review producer.`,
          remainingRisk: choice === "continue" ? "Acceptance retains the unavailable Task Review judgment." : null,
          expectEvidenceDigest: context.evidenceDigest,
          expectIdentity: context.identity().toJSON(),
        });
        const persisted = new FlowManager({ root, mainRoot: root, inWorktree: false });
        const canonical = persisted.canonicalState(fixture.specId);
        assert.equal(choice === "retry" ? canonical.current.at(-1) : canonical.nextAction().nodeId,
          choice === "retry" ? "T-1-review" : "T-1-gate");
        if (choice === "continue") {
          assert.equal(canonical.findNode("T-1-review").status, "done");
          assert.equal(canonical.findNode("T-1-triage").status, "skipped");
          assert.equal(canonical.findNode("T-1-repair").status, "skipped");
          assert.equal(canonical.findNode("T-1-gate").status, "pending");
        }
      } finally { removeTmpDir(root); }
    }
  });

  it("publishes unavailable Task Gate evidence and acceptance risk in one continuation Activity", async () => {
    const { root, manager, fixture } = taskScenario("gate");
    try {
      const originalGate = manager.readProducerArtifact({
        specId: fixture.specId, nodeId: "T-1-gate", logicalKey: "task.gate", parameters: { taskId: "T-1" },
      });
      const commandContext = () => ({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      });
      const strict = await new GetNextActionCommand().execute(commandContext());
      assert.equal(strict.directive.kind, "await_user_decision");
      assert.deepEqual(strict.directive.actionPrompt.choices.map((choice) => choice.actionId), [
        "KEEP_STRICT_FLOW", "ENABLE_NONBLOCKING",
      ]);
      assert.equal(strict.nonblockingDecision, undefined);
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Task gate is bounded." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.equal(context.sourceStep, "task-gate");
      assert.deepEqual(context.allowedActions, ["retry", "continue"]);
      assert.equal(context.evidenceRef, "steps/impl/T-1/gate/result.json");
      const enabled = await new GetNextActionCommand().execute(commandContext());
      assert.deepEqual(enabled.nonblockingDecision, context.toJSON());
      const decisionInput = {
        root, choice: "continue",
        reason: "The local Gate did not obtain semantic judgment.",
        remainingRisk: "Acceptance retains the unavailable Gate judgment.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      };
      const crashing = new FlowManager({
        root, mainRoot: root, inWorktree: false,
        versionStoreFaultInjector({ phase }) {
          if (phase === "activity-appended") throw new Error("simulated Task Gate continuation crash");
        },
      });
      assert.throws(() => recordNonBlockingDecision({ ...decisionInput, flowManager: crashing }),
        /simulated Task Gate continuation crash/);
      const resumed = new FlowManager({ root, mainRoot: root, inWorktree: false });
      for (const logicalKey of ["nonblocking.handoffs", "flow.findings"]) {
        assert.equal(resumed.readArtifact({
          specId: fixture.specId,
          logicalKey,
          consumerNodeId: "acceptance-review",
          optional: true,
        }), null);
      }
      const decision = recordNonBlockingDecision({ ...decisionInput, flowManager: resumed });
      assert.equal(decision.action, "continue");
      const state = resumed.load(fixture.specId);
      assert.equal(state.tasks[0].status, "done");
      assert.equal(state.currentNodeId, null);
      assert.equal(resumed.canonicalState(fixture.specId).nextAction().nodeId, "test-execute");
      assert.deepEqual(recordNonBlockingDecision({
        ...decisionInput, flowManager: resumed,
      }), decision);
      const handoffs = JSON.parse(resumed.readArtifact({
        specId: fixture.specId, logicalKey: "nonblocking.handoffs", consumerNodeId: "acceptance-review",
      }).bytes.toString("utf8"));
      assert.equal(handoffs.findings.length, 1);
      assert.equal(handoffs.findings.at(-1).sourceStep, "task-gate");
      assert.equal(handoffs.findings.at(-1).evidenceDigest, context.evidenceDigest);
      const findings = JSON.parse(resumed.readArtifact({
        specId: fixture.specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review",
      }).bytes.toString("utf8"));
      assert.equal(findings.entries.length, 1);
      const deferred = findings.entries.at(-1);
      assert.deepEqual({
        sourceStep: deferred.sourceStep,
        sourceArtifact: deferred.sourceArtifact,
        sourceFindingId: deferred.sourceFindingId,
        fingerprint: deferred.fingerprint,
        rationale: deferred.rationale,
        finalDisposition: deferred.finalDisposition,
      }, {
        sourceStep: "task-gate",
        sourceArtifact: "steps/nonblocking-handoffs.json",
        sourceFindingId: handoffs.findings.at(-1).findingId,
        fingerprint: handoffs.findings.at(-1).fingerprint,
        rationale: decisionInput.remainingRisk,
        finalDisposition: "still_open",
      });
      const decisionActivity = resumed.activityLedger(fixture.specId).find((activity) => (
        activity.transition.nonblocking?.kind === "decision"
      ));
      const catalog = resumed.artifactCatalog(fixture.specId);
      for (const logicalKey of ["nonblocking.handoffs", "flow.findings"]) {
        assert.equal(catalog.artifacts.find((artifact) => artifact.logicalKey === logicalKey).activityId,
          decisionActivity.id);
      }
      const acceptance = new CanonicalAcceptanceArtifactStore({
        flowManager: resumed,
        state: resumed.load(fixture.specId),
      }).deferredFindings([]);
      assert.deepEqual(acceptance.findings, [{
        findingId: deferred.findingId,
        sourceStep: "task-gate",
        sourceArtifact: "steps/nonblocking-handoffs.json",
        sourceFindingId: handoffs.findings.at(-1).findingId,
        finalDisposition: "still_open",
        evidenceRefs: [],
      }]);
      assert.deepEqual(acceptance.evidence, [{
        findingId: deferred.findingId,
        sourceRef: `steps/nonblocking-handoffs.json#${handoffs.findings.at(-1).findingId}`,
        sourceFinding: handoffs.findings.at(-1),
      }]);
      const settledGate = resumed.artifactCatalog(fixture.specId).artifacts
        .find((artifact) => artifact.relativePath === originalGate.relativePath);
      assert.equal(settledGate.hash, originalGate.descriptor.hash);
      const issueLog = JSON.parse(resumed.readArtifact({
        specId: fixture.specId, logicalKey: "issue.log", consumerNodeId: "T-1-gate",
      }).bytes.toString("utf8"));
      assert.equal(issueLog.entries.length > 0, true);
    } finally { removeTmpDir(root); }
  });

  it("retries a provider-unavailable Task Gate atomically without advancing the next Task", () => {
    const { root, manager, fixture } = taskScenario("gate", { failureKind: "provider", nextTask: true });
    try {
      const original = manager.readProducerArtifact({
        specId: fixture.specId,
        nodeId: "T-1-gate",
        logicalKey: "task.gate",
        parameters: { taskId: "T-1" },
      });
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The Gate provider is unavailable." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      assert.equal(context.resultKind, "tooling");
      assert.deepEqual(context.allowedActions, ["retry", "continue"]);
      const result = recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "retry",
        reason: "Retry the provider-backed Task Gate.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      });
      assert.equal(result.action, "retry");
      const state = manager.load(fixture.specId);
      assert.equal(state.currentTaskId, "T-1");
      assert.equal(state.currentNodeId, "T-1-gate");
      assert.equal(state.tasks.find((task) => task.id === "T-1").status, "in_progress");
      assert.equal(state.tasks.find((task) => task.id === "T-2").status, "pending");
      assert.equal(manager.canonicalState(fixture.specId).attempt.sequence, 2);
      assert.equal(manager.readProducerArtifact({
        specId: fixture.specId,
        nodeId: "T-1-gate",
        logicalKey: "task.gate",
        parameters: { taskId: "T-1" },
      }).descriptor.hash, original.descriptor.hash);
    } finally { removeTmpDir(root); }
  });

  it("retries unavailable Task Gate evidence in one decision Activity", () => {
    const { root, manager, fixture } = taskScenario("gate");
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "Retry the unavailable local Gate." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      const input = {
        root, flowManager: manager, choice: "retry",
        reason: "Retry the canonical Gate producer.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      };
      const first = recordNonBlockingDecision(input);
      assert.equal(first.action, "retry");
      const canonical = manager.canonicalState(fixture.specId);
      assert.equal(canonical.current.at(-1), "T-1-gate");
      assert.equal(canonical.attempt.sequence, 2);
      assert.equal(manager.load(fixture.specId).tasks[0].status, "in_progress");
      assert.deepEqual(recordNonBlockingDecision(input), first);
      assert.equal(manager.activityLedger(fixture.specId)
        .filter((activity) => activity.transition.nonblocking?.kind === "decision").length, 1);
    } finally { removeTmpDir(root); }
  });

  it("continues a local-invalid Task Gate through the Definition-selected next Task lifecycle", () => {
    const { root, manager, fixture } = taskScenario("gate", { failureKind: "mechanical", nextTask: true });
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The local Gate input is unavailable." });
      const context = decisionContextForActiveFlow(root, manager.load(fixture.specId), manager);
      recordNonBlockingDecision({
        root,
        flowManager: manager,
        choice: "continue",
        reason: "Continue to the next Task while retaining the failed Gate.",
        remainingRisk: "Acceptance must account for the missing Task Gate judgment.",
        expectEvidenceDigest: context.evidenceDigest,
        expectIdentity: context.identity().toJSON(),
      });
      const state = manager.load(fixture.specId);
      assert.equal(state.tasks.find((task) => task.id === "T-1").status, "done");
      assert.equal(state.tasks.find((task) => task.id === "T-2").status, "pending");
      assert.equal(state.currentTaskId, null);
      assert.equal(state.currentNodeId, null);
      assert.equal(manager.canonicalState(fixture.specId).nextAction().nodeId, "T-2-impl");
      assert.equal(manager.activityLedger(fixture.specId).at(-1).transition.gateTaskLifecycle.successorStepId, "T-2-impl");
    } finally { removeTmpDir(root); }
  });

  it("rejects direct activation while Definition still selects ordinary Task Gate recovery", async () => {
    const { root, manager, fixture } = taskScenario("gate", {
      failureKind: "ai_semantic_fail",
      settleIssueLog: false,
    });
    try {
      const next = await new GetNextActionCommand().execute({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      });
      assert.equal(next.directive.actionPrompt, undefined);
      assert.equal(next.nonblockingDecision, undefined);
      assert.throws(() => activateNonBlockingPolicy({
        root, flowManager: manager, reason: "A direct command cannot bypass Definition recovery.",
      }), /not selected by the current Definition strict stop/);
      assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
    } finally { removeTmpDir(root); }
  });

  it("does not mask incomplete local or tooling Task Gate settlement recovery", async () => {
    for (const failureKind of ["mechanical", "provider"]) {
      const { root, manager, fixture } = taskScenario("gate", {
        failureKind,
        settleIssueLog: false,
      });
      try {
        const next = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId: fixture.specId,
          flowManager: manager, flowState: manager.load(fixture.specId),
        });
        assert.equal(next.directive.actionId, "RECONCILE_GATE_PUBLICATION");
        assert.equal(next.directive.actionPrompt, undefined);
        assert.equal(next.nonblockingDecision, undefined);
        assert.throws(() => activateNonBlockingPolicy({
          root, flowManager: manager,
          reason: "Incomplete Task Gate settlement cannot be bypassed.",
        }), /not selected by the current Definition strict stop/);
        assert.equal(manager.load(fixture.specId).policy.nonblocking, null);
      } finally { removeTmpDir(root); }
    }
  });

  it("has the dispatcher record one dedicated decision and reload canonical next-action", async () => {
    const { root, manager, fixture } = taskScenario("gate");
    try {
      activateNonBlockingPolicy({ root, flowManager: manager, reason: "The local Gate is unavailable." });
      let nextActionReads = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            nextActionReads += 1;
            if (nextActionReads > 1) return {
              taskId: null, step: null, action: "completed", instructions: null, context: null,
              output_schema: null, requires_approval: false,
              directive: { kind: "completed", terminal: true, requiresUserAction: false },
            };
            return new GetNextActionCommand().execute({
              root, mainRoot: root, executionRoot: root, specId: fixture.specId,
              flowManager: manager, flowState: manager.load(fixture.specId),
            });
          },
        },
        agent: { async call() {
          return JSON.stringify({
            choice: "continue",
            reason: "Semantic judgment was unavailable.",
            remainingRisk: "Acceptance retains the unavailable Task Gate judgment.",
          });
        } },
        repositoryFingerprint: () => "nonblocking-dispatch-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
        handoffCoordinator: { recoverPending() {} },
      });
      dispatcher.container = {};
      const decisionContext = {
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
      };
      const projected = await new GetNextActionCommand().execute(decisionContext);
      const action = new FlowDispatchAction(projected);
      dispatcher.agent = { async call() { return '{"choice":"continue"}'; } };
      await assert.rejects(
        () => dispatcher.runNonblockingAgentDecision(decisionContext, action),
        /reason is required/,
      );
      dispatcher.agent = { async call() { throw new Error("provider unavailable"); } };
      await assert.rejects(
        () => dispatcher.runNonblockingAgentDecision(decisionContext, action),
        /provider unavailable/,
      );
      const stale = structuredClone(projected);
      stale.nonblockingDecision.evidenceDigest = "c".repeat(64);
      await assert.rejects(
        () => dispatcher.runNonblockingAgentDecision(decisionContext, new FlowDispatchAction(stale)),
        /evidence changed/,
      );
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => (
        entry.transition.nonblocking?.kind === "decision"
      )).length, 0);
      dispatcher.agent = { async call() {
        return JSON.stringify({
          choice: "continue",
          reason: "Semantic judgment was unavailable.",
          remainingRisk: "Acceptance retains the unavailable Task Gate judgment.",
        });
      } };
      const result = await dispatcher.execute({
        root, mainRoot: root, executionRoot: root, specId: fixture.specId,
        flowManager: manager, flowState: manager.load(fixture.specId),
        expectRunId: fixture.runId, expectSpec: fixture.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result));
      assert.equal(result.dispatch.dispatchCount, 1);
      assert.equal(nextActionReads, 2);
      assert.equal(manager.activityLedger(fixture.specId).filter((entry) => (
        entry.transition.nonblocking?.kind === "decision"
      )).length, 1);
      assert.equal(manager.canonicalState(fixture.specId).nextAction().nodeId, "test-execute");
    } finally { removeTmpDir(root); }
  });

  it("classifies rejected review evidence as quality", () => {
    assert.equal(fromReviewResult({ ref: "review", source: '{"verdict":"REJECTED"}' }).resultKind, "quality");
  });
  it("classifies tooling review evidence as retryable tooling", () => {
    assert.equal(fromReviewResult({ ref: "review", source: '{"toolingOutcome":{"reason":"offline"}}' }).resultKind, "tooling");
  });
  it("classifies semantic and tooling gate failures distinctly", () => {
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"ai_semantic_fail"}}' }).resultKind, "quality");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"schema"}}' }).resultKind, "tooling");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"provider"}}' }).resultKind, "tooling");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"mechanical"}}' }).resultKind, "unavailable");
    assert.equal(fromGateResult({ ref: "gate", source: '{"result":"fail","artifacts":{"failureKind":"mechanical_guardrail_fail"}}' }).resultKind, "unavailable");
    assert.throws(
      () => fromGateResult({ ref: "gate", source: '{"result":"fail","failureKind":"schema"}' }),
      /artifacts must be an object/,
    );
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
