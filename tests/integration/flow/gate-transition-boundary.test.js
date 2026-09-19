import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GateTransitionFacts,
  GateAttemptIdentity,
  GateCatalogPublication,
  GateLineage,
  GateRecoveryEvidence,
  GateReviewFindingReadiness,
  GateRetryMetrics,
  SpecGateCycleProgress,
  GateFailureCategory,
  GateObservationConvergenceFacts,
  GateProducerOwnership,
  GateTargetBinding,
  GateTransitionDecision,
  TaskGateSettlementProgress,
  GateStepUpdate,
  AppendIssueLog,
  IncrementMetric,
  SetStepStatus,
  buildCurrentFlowDefinition,
  projectGatePublicOutcome,
  gateNonblockingEligibilityForDecision,
  reviewNonblockingEligibilityForDisposition,
  acceptanceBoundaryNonblockingEligibility,
  resolveReviewTransition,
  resolveLifecycle,
  resolveLifecyclePlan,
  resolveGatePublicationRecovery,
  resolveGateEvaluationAdmission,
  resolveGateTransition,
} from "../../../src/flow/definition.js";
import { ReviewTransitionFacts } from "../../../src/flow/lib/review-transition-facts.js";
import { NONBLOCKING_ROUTES } from "../../../src/flow/lib/nonblocking-route.js";
import {
  GateTransitionActionProjection,
  admitGateTransition,
  applyGateTransitionDecision,
  projectGateTransitionDecision,
} from "../../../src/flow/lib/gate-transition-application.js";
import { TaskGateSettlementAdmission } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import { CurrentFlowStateConflictError } from "../../../src/flow/lib/current-flow-state.js";

const phases = ["draft", "spec", "task-spec", "task-impl", "integration"];

function facts(overrides = {}) {
  const phase = overrides.phase ?? "spec";
  const scope = overrides.scope ?? (phase === "task-impl" ? "task" : "flow");
  const taskId = scope === "task" ? "T-1" : null;
  const stepId = {
    draft: "draft-gate",
    spec: "spec-gate",
    "task-spec": "spec-gate",
    "task-impl": "T-1-gate",
    integration: "impl-gate",
  }[phase];
  const attempt = overrides.currentAttempt ?? new GateAttemptIdentity({ id: "attempt-7", sequence: 7 });
  const publication = overrides.catalogPublication ?? new GateCatalogPublication({
    attemptId: attempt.id,
    sequence: attempt.sequence,
    producerActivityId: "activity-spec-gate",
    artifactId: "gate.result.7",
    fingerprint: "revision-7",
  });
  return new GateTransitionFacts({
    phase,
    scope,
    ...(scope === "task" ? { snapshotRevision: "snapshot-7" } : {}),
    currentAttempt: attempt,
    producer: {
      runId: "run-7",
      specId: "007-gate-transition",
      activityId: "activity-spec-gate",
      phase,
      scope,
      taskId,
      stepId,
    },
    target: {
      runId: "run-7",
      specId: "007-gate-transition",
      taskId,
      stepId,
      attempt,
    },
    catalogPublication: publication,
    result: "pass",
    retry: new GateRetryMetrics({ used: 0, maximum: 2 }),
    lineage: new GateLineage({
      sourceAttempt: attempt,
      canonicalAttempt: attempt,
      sourceFingerprint: "revision-7",
      canonicalFingerprint: "revision-7",
    }),
    recoveryEvidence: new GateRecoveryEvidence(),
    reviewReadiness: phase === "integration"
      ? new GateReviewFindingReadiness({
        status: "ready", findingFingerprints: [], reviewFingerprints: ["impl-review-7"],
        decisionFingerprint: "review-decision-7",
      })
      : null,
    taskLifecycle: scope === "task"
      ? { taskId, nextTaskId: null, integrationStepId: "test-execute" }
      : null,
    taskBudget: scope === "task" ? { round: 1, maximumRounds: 2 } : null,
    specCycle: phase === "spec" ? new SpecGateCycleProgress({ completedRepairs: 0 }) : null,
    taskSettlementProgress: scope === "task"
      ? new TaskGateSettlementProgress({
        classificationRecorded: true,
        metricOperations: [(overrides.result ?? "pass") === "pass" ? "reset" : "increment"],
        issueLogRecorded: true,
        terminalLifecycleRecorded: false,
      })
      : null,
    ...overrides,
  });
}

function reload(value) {
  return GateTransitionFacts.fromPersisted(value);
}

describe("definition-owned Gate transition boundary", () => {
  it("requires a snapshot revision exactly for Task settlement facts", () => {
    assert.throws(
      () => facts({ phase: "task-impl", snapshotRevision: null }),
      /snapshot revision is required exactly for Task settlement scope/,
    );
    assert.throws(
      () => facts({ phase: "spec", snapshotRevision: "snapshot-7" }),
      /snapshot revision is required exactly for Task settlement scope/,
    );
  });

  it("rejects Task Gate settlement when the lock snapshot revision changed", () => {
    const decision = resolveGateTransition(facts({ phase: "task-impl" }));
    const admission = new TaskGateSettlementAdmission(decision, "metric");
    assert.throws(() => admission.assert({ revision: "snapshot-8" }), CurrentFlowStateConflictError);
  });

  it("represents every Gate phase with persisted typed facts", () => {
    for (const phase of phases) {
      const decision = resolveGateTransition(facts({ phase }));
      assert.equal(decision.facts.phase, phase);
      assert.equal(decision.disposition.operation, "pass");
      assert.equal(decision.advance.operation, "advance");
      assert.equal(decision.facts.producer instanceof GateProducerOwnership, true);
      assert.equal(decision.facts.target instanceof GateTargetBinding, true);
    }
  });

  it("is deterministic after persisted fact reload", () => {
    const original = facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "REJECTED" }),
      retry: new GateRetryMetrics({ used: 1, maximum: 2 }),
    });
    const stored = JSON.parse(JSON.stringify(original.toJSON()));
    assert.deepEqual(resolveGateTransition(reload(stored)).toJSON(), resolveGateTransition(original).toJSON());
  });

  it("bounds semantic Spec repair cycles before retry, repair, defer, or advisory selection", () => {
    const semanticFailure = {
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
    };
    const binding = {
      attempt: { id: "attempt-7", sequence: 7 },
      fingerprint: "revision-7",
    };
    const underLimit = resolveGateTransition(facts({
      ...semanticFailure,
      specCycle: new SpecGateCycleProgress({ completedRepairs: 2 }),
      recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }),
    }));
    assert.equal(underLimit.disposition.operation, "repair");

    const atLimitProgress = new SpecGateCycleProgress({ completedRepairs: 3 });
    assert.equal(resolveGateTransition(facts({ specCycle: atLimitProgress })).disposition.operation, "pass");
    const tooling = resolveGateTransition(facts({
      ...semanticFailure,
      failure: new GateFailureCategory({ category: "tooling", code: "SPEC_GATE_PROVIDER_FAILURE" }),
      specCycle: atLimitProgress,
    }));
    assert.equal(tooling.disposition.operation, "external-blocked");
    assert.equal(tooling.disposition.reason, "SPEC_GATE_PROVIDER_FAILURE");
    const local = resolveGateTransition(facts({
      ...semanticFailure,
      failure: new GateFailureCategory({ category: "local", code: "SPEC_GATE_INPUT_INVALID" }),
      specCycle: atLimitProgress,
    }));
    assert.equal(local.disposition.operation, "blocked");
    assert.equal(local.disposition.reason, "SPEC_GATE_INPUT_INVALID");

    for (const input of [
      { cycle: 4, retry: new GateRetryMetrics({ used: 0, maximum: 2 }) },
      { cycle: 5, retry: new GateRetryMetrics({ used: 2, maximum: 2 }) },
      {
        cycle: 4,
        nonblocking: true,
        recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }),
      },
    ]) {
      const decision = resolveGateTransition(facts({
        ...semanticFailure,
        ...input,
        specCycle: new SpecGateCycleProgress({ completedRepairs: input.cycle - 1 }),
      }));
      assert.equal(decision.disposition.operation, input.nonblocking ? "nonblocking" : "blocked");
      if (input.nonblocking) {
        assert.deepEqual(decision.plan.nonblockingHandoff.toJSON(), {
          sourceStepId: "spec-gate", targetStepId: "approval",
        });
      }
      if (!input.nonblocking) {
        assert.equal(decision.disposition.reason, `Spec Gate cycle ${input.cycle} reached maximum 4.`);
      }
    }
  });

  it("persists Spec cycle progress and includes it in stale action identity", () => {
    const original = facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      specCycle: new SpecGateCycleProgress({ completedRepairs: 3 }),
    });
    const reloaded = reload(JSON.parse(JSON.stringify(original.toJSON())));
    assert.deepEqual(reloaded.specCycle.toJSON(), { cycle: 4, completedRepairs: 3 });
    const stale = resolveGateTransition(facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      specCycle: new SpecGateCycleProgress({ completedRepairs: 2 }),
    }));
    const current = resolveGateTransition(reloaded);
    assert.equal(stale.plan.action.identity.matches(current.plan.action.identity), false);
    const overLimit = reload(JSON.parse(JSON.stringify(facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      specCycle: new SpecGateCycleProgress({ completedRepairs: 4 }),
    }).toJSON())));
    assert.deepEqual(overLimit.specCycle.toJSON(), { cycle: 5, completedRepairs: 4 });
    assert.equal(resolveGateTransition(overLimit).disposition.operation, "blocked");
    assert.equal(resolveGateTransition(overLimit).disposition.reason, "Spec Gate cycle 5 reached maximum 4.");
  });

  it("projects one stable reconciliation action for unclassified or unfinished Task Gate publication", () => {
    for (const phase of phases) {
      const original = facts({ phase, postPublication: { status: "unclassified" } });
      const recovery = resolveGatePublicationRecovery(original);
      const reloaded = resolveGatePublicationRecovery(reload(JSON.parse(JSON.stringify(original.toJSON()))));
      assert.equal(recovery.disposition.operation, "reconcile");
      assert.equal(recovery.plan.updates.length, 0);
      assert.equal(recovery.plan.action.identity.matches(reloaded.plan.action.identity), true);
      assert.equal(resolveGateTransition(original).disposition.operation, "pass");
      const classified = resolveGatePublicationRecovery(facts({ phase }));
      if (phase === "task-impl") assert.equal(classified.disposition.operation, "reconcile");
      else assert.equal(classified, null);
    }
  });

  it("separates semantic retry, local input defects, and external provider failures", () => {
    const passed = resolveGateTransition(facts());
    const semantic = resolveGateTransition(facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 1 }),
    }));
    const tooling = resolveGateTransition(facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "tooling", code: "GATE_REQUIRED_AGENT_SPAWN" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 1 }),
    }));
    const local = resolveGateTransition(facts({
      result: "fail",
      failure: GateFailureCategory.fromObservedGateResult({
        result: "fail",
        artifacts: { failureKind: "mechanical", failureCode: "DRAFT_JSON_INVALID" },
      }),
      retry: new GateRetryMetrics({ used: 0, maximum: 1 }),
    }));
    assert.equal(semantic.disposition.operation, "retry");
    assert.deepEqual(passed.plan.retryMetric.toJSON(), { operation: "reset", phase: "spec" });
    assert.equal(semantic.plan.retryMetric.operation, "increment");
    assert.equal(tooling.disposition.operation, "external-blocked");
    assert.equal(tooling.plan.retryMetric, null);
    assert.equal(local.disposition.operation, "blocked");
    assert.equal(local.disposition.reason, "DRAFT_JSON_INVALID");
    assert.equal(GateFailureCategory.fromObservedGateResult({
      result: "fail",
      artifacts: { failureKind: "mechanical" },
    }).category, "local");
    assert.equal(GateFailureCategory.fromObservedGateResult({
      result: "fail",
      artifacts: { failureKind: "agent-evaluation" },
    }).category, "tooling");
    assert.equal(GateFailureCategory.fromObservedGateResult({
      result: "fail",
      artifacts: { failureKind: "schema" },
    }).category, "tooling");
  });

  it("routes an ordinary Draft Gate semantic failure to repair while preserving defer guards", () => {
    const repair = resolveGateTransition(facts({
      phase: "draft",
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 4 }),
    }));
    assert.equal(repair.disposition.operation, "repair");
    assert.equal(repair.plan.repairConnector.sourceGateStepId, "draft-gate");
    assert.equal(repair.plan.repairConnector.targetStepId, "draft-gate-repair");

    const sameEvidence = resolveGateTransition(facts({
      phase: "draft",
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 4 }),
      observationConvergence: new GateObservationConvergenceFacts({
        evidenceKey: "draft-gate-evidence",
        observationFingerprints: ["evidence-1"],
        occurrenceCount: 2,
        repairCount: 1,
        recurrenceCount: 1,
        recurringObservationCount: 1,
        latestOutcomeDisposition: "rejected-no-progress",
        latestOutcomeChangedEvidence: false,
        finalRound: false,
      }),
    }));
    assert.equal(sameEvidence.disposition.operation, "defer");

    const exhausted = resolveGateTransition(facts({
      phase: "draft",
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 4, maximum: 4 }),
    }));
    assert.equal(exhausted.disposition.operation, "defer");
  });

  it("projects public Gate failures from the sealed Definition decision", () => {
    const draftTooling = resolveGateTransition(facts({
      phase: "draft", result: "fail",
      failure: new GateFailureCategory({ category: "tooling", code: "PROTOCOL" }),
    }));
    const integrationTooling = resolveGateTransition(facts({
      phase: "integration", result: "fail",
      failure: new GateFailureCategory({ category: "tooling", code: "PROTOCOL" }),
    }));
    const retry = resolveGateTransition(facts({
      result: "fail", failure: new GateFailureCategory({ category: "semantic" }),
    }));
    const local = resolveGateTransition(facts({
      phase: "draft", result: "fail",
      failure: new GateFailureCategory({ category: "local", code: "DRAFT_JSON_INVALID" }),
    }));

    assert.equal(projectGatePublicOutcome(draftTooling).failureCode, "STEP_EXTERNAL_BLOCKED");
    assert.equal(projectGatePublicOutcome(integrationTooling).failureCode, "PROTOCOL");
    assert.equal(projectGatePublicOutcome(local).failureCode, "GATE_LOCAL_INPUT_INVALID");
    assert.equal(projectGatePublicOutcome(retry).failed, false);
    const recovered = resolveGateTransition(facts({
      phase: "integration", result: "recovered",
      recoveryEvidence: new GateRecoveryEvidence({
        kind: "recovered", attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7",
      }),
    }));
    assert.equal(projectGatePublicOutcome(recovered).nextStepId, "test-execute");
  });

  it("makes every integration outcome and handoff a Definition plan", () => {
    const semantic = resolveGateTransition(facts({
      phase: "integration", result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 2 }),
    }));
    const tooling = resolveGateTransition(facts({
      phase: "integration", result: "fail",
      failure: new GateFailureCategory({ category: "tooling", code: "PROTOCOL" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 2 }),
    }));
    const exhausted = resolveGateTransition(facts({
      phase: "integration", result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 2, maximum: 2 }),
    }));
    const nonblocking = resolveGateTransition(facts({
      phase: "integration", result: "fail", nonblocking: true,
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 2, maximum: 2 }),
    }));
    const nonblockingRetry = resolveGateTransition(facts({
      phase: "integration", result: "fail", nonblocking: true,
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 2 }),
    }));
    const recovered = resolveGateTransition(facts({
      phase: "integration", result: "recovered",
      recoveryEvidence: new GateRecoveryEvidence({
        kind: "recovered", attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7",
      }),
    }));

    assert.equal(Object.hasOwn(
      resolveGateTransition(facts({ phase: "integration" })).plan.phaseDefinition,
      "nextStepId",
    ), false);
    assert.equal(semantic.disposition.operation, "retry");
    assert.equal(semantic.plan.retryMetric.operation, "increment");
    assert.equal(tooling.disposition.operation, "external-blocked");
    assert.equal(tooling.plan.retryMetric, null);
    assert.equal(exhausted.disposition.operation, "defer");
    assert.equal(nonblockingRetry.disposition.operation, "retry");
    assert.equal(nonblocking.disposition.operation, "nonblocking");
    assert.deepEqual(nonblocking.plan.nonblockingHandoff.toJSON(), {
      sourceStepId: "impl-gate", targetStepId: "retro",
    });
    assert.equal(recovered.disposition.operation, "recovery");
    assert.deepEqual(recovered.plan.recoveryEffect.toJSON(), {
      operation: "rewind-test-evidence", sourceStepId: "impl-gate", targetStepId: "test-execute",
    });
    for (const decision of [semantic, tooling, exhausted, nonblocking, recovered]) {
      const reloaded = resolveGateTransition(reload(JSON.parse(JSON.stringify(decision.facts.toJSON()))));
      assert.deepEqual(reloaded.plan.toJSON(), decision.plan.toJSON());
      assert.equal(reloaded.plan.action.identity.matches(decision.plan.action.identity), true);
    }
  });

  it("selects Task Gate advisory eligibility only after strict recovery is exhausted", () => {
    const recoverable = resolveGateTransition(facts({
      phase: "task-impl", result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 1, maximum: 2 }),
    }));
    assert.equal(gateNonblockingEligibilityForDecision(recoverable), null);

    const exhausted = resolveGateTransition(facts({
      phase: "task-impl", result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 2, maximum: 2 }),
      taskBudget: { round: 2, maximumRounds: 2 },
    }));
    const eligibility = gateNonblockingEligibilityForDecision(exhausted);
    assert.match(eligibility.definitionDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(eligibility.toJSON(), {
      strictDisposition: { operation: "defer", reason: null },
      sourceStep: "task-gate",
      resultKind: "quality",
      blocker: "Strict Gate recovery is exhausted.",
      allowedActions: ["repair", "continue"],
      continueTargetStepId: "test-execute",
      skippedStepIds: [],
      acceptancePublication: "semantic-findings",
      definitionDigest: eligibility.definitionDigest,
      handoff: { sourceStepId: "task-gate", targetStepId: "test-execute", taskId: "T-1" },
    });

    const enabled = resolveGateTransition(GateTransitionFacts.fromPersisted({
      ...exhausted.facts.toJSON(), nonblocking: true,
    }));
    assert.equal(enabled.disposition.operation, "nonblocking");
    assert.equal(enabled.plan.taskLifecycle.operation, "defer-and-advance");
    assert.equal(enabled.plan.nonblockingHandoff.targetStepId, "test-execute");
  });

  it("blocks a nominal integration PASS when typed review readiness retains a finding", () => {
    const blocked = resolveGateTransition(facts({
      phase: "integration",
      reviewReadiness: new GateReviewFindingReadiness({
        status: "blocking", findingFingerprints: ["finding-7"], reviewFingerprints: ["impl-review-7"],
        triageFingerprint: "triage-7", repairFingerprint: "repair-7", decisionFingerprint: "review-decision-7",
      }),
    }));
    assert.equal(blocked.disposition.operation, "blocked");
    assert.equal(blocked.disposition.reason, "unresolved_review_findings");
    const reloaded = resolveGateTransition(reload(JSON.parse(JSON.stringify(blocked.facts.toJSON()))));
    assert.deepEqual(reloaded.plan.toJSON(), blocked.plan.toJSON());
    assert.equal(reloaded.plan.action.identity.matches(blocked.plan.action.identity), true);
  });

  it("projects Gate issue-log and retry mutations from the typed decision", () => {
    const retryDecision = resolveGateTransition(facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 2 }),
    }));
    const retryActions = resolveLifecyclePlan({
      event: "gate:post",
      currentStepId: "spec-gate",
      phase: "spec",
      gateTransitionDecision: retryDecision,
      // Once admitted, lifecycle planning must not reinterpret compatibility
      // result fields to select a different transition.
      result: { result: "pass", artifacts: { phase: "spec" } },
    }).actions;
    assert.equal(retryActions.some((action) => action instanceof AppendIssueLog), true);
    assert.equal(retryActions.some((action) => action instanceof IncrementMetric), true);

    const exhaustedDecision = resolveGateTransition(facts({
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic", code: "GATE_REJECTED" }),
      retry: new GateRetryMetrics({ used: 2, maximum: 2 }),
    }));
    const exhaustedActions = resolveLifecyclePlan({
      event: "gate:post",
      currentStepId: "spec-gate",
      phase: "spec",
      gateTransitionDecision: exhaustedDecision,
    }).actions;
    assert.equal(exhaustedActions.some((action) => action instanceof AppendIssueLog), true);
    assert.equal(exhaustedActions.some((action) => action instanceof IncrementMetric), false);
  });

  it("prioritizes a current Task Gate repair receipt over a same-evidence retry", () => {
    const exhausted = {
      result: "fail", failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 4, maximum: 4 }), taskBudget: { round: 2, maximumRounds: 2 },
    };
    const binding = { attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" };
    const repairedExhausted = resolveGateTransition(facts({ phase: "task-impl", ...exhausted, recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }) }));
    assert.equal(repairedExhausted.disposition.operation, "defer");
    assert.equal(resolveGateTransition(facts({ phase: "task-impl", ...exhausted, recoveryEvidence: new GateRecoveryEvidence({ kind: "defer", ...binding }) })).disposition.operation, "defer");
    const deferred = resolveGateTransition(facts({ phase: "task-impl", ...exhausted }));
    assert.equal(deferred.disposition.operation, "defer");
    assert.equal(deferred.plan.retryMetric, null);
    assert.equal(deferred.plan.updates[0].status, "in_progress");
    const repairBeforeExhaustion = resolveGateTransition(facts({ phase: "task-impl",
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 3, maximum: 4 }),
      recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }),
    }));
    assert.equal(repairBeforeExhaustion.disposition.operation, "repair");
    assert.equal(repairBeforeExhaustion.plan.retryMetric, null);
  });

  it("carries exhausted or unchanged draft Gate findings to Spec before selecting another repair", () => {
    const binding = { attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" };
    const convergence = (latestOutcomeDisposition) => new GateObservationConvergenceFacts({
      evidenceKey: "draft.gate:attempt-7:7:activity-spec-gate:revision-7",
      observationFingerprints: ["a".repeat(64)],
      occurrenceCount: 2,
      repairCount: 1,
      recurrenceCount: 1,
      recurringObservationCount: 1,
      latestOutcomeDisposition,
      latestOutcomeChangedEvidence: false,
    });
    for (const observationConvergence of [
      convergence("rejected-no-progress"),
      convergence("rejected-invalid"),
    ]) {
      const decision = resolveGateTransition(facts({
        phase: "draft",
        result: "fail",
        failure: new GateFailureCategory({ category: "semantic" }),
        retry: new GateRetryMetrics({ used: 1, maximum: 4 }),
        recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }),
        observationConvergence,
      }));
      assert.equal(decision.disposition.operation, "defer");
      assert.equal(decision.plan.repairConnector, null);
      assert.equal(decision.plan.retryMetric, null);
      assert.equal(gateNonblockingEligibilityForDecision(decision), null);
      assert.equal(resolveGateTransition(GateTransitionFacts.fromPersisted({
        ...decision.facts.toJSON(), nonblocking: true,
      })).disposition.operation, "defer");
    }
    const exhausted = resolveGateTransition(facts({
      phase: "draft",
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 4, maximum: 4 }),
      recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }),
    }));
    assert.equal(exhausted.disposition.operation, "defer");
    assert.equal(exhausted.plan.repairConnector, null);
    assert.equal(gateNonblockingEligibilityForDecision(exhausted), null);

    const specNoProgress = resolveGateTransition(facts({
      phase: "spec",
      result: "fail",
      failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 1, maximum: 4 }),
      recoveryEvidence: new GateRecoveryEvidence({ kind: "repair", ...binding }),
      observationConvergence: convergence("rejected-no-progress"),
    }));
    assert.equal(specNoProgress.disposition.operation, "repair");

    const specExhausted = resolveGateTransition(facts({
      phase: "spec", result: "fail",
      failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 4, maximum: 4 }),
    }));
    assert.notEqual(gateNonblockingEligibilityForDecision(specExhausted), null);
  });

  it("admits only fresh Gate evidence and converges final-round recurrence without misclassifying a new observation", () => {
    const semanticFailure = new GateFailureCategory({ category: "semantic", code: "TASK_GATE_REJECTED" });
    const convergence = (overrides = {}) => new GateObservationConvergenceFacts({
      evidenceKey: "task.gate:attempt-7:7:activity-spec-gate:revision-7",
      observationFingerprints: ["a".repeat(64)],
      occurrenceCount: 2,
      repairCount: 1,
      recurrenceCount: 1,
      recurringObservationCount: 1,
      latestOutcomeDisposition: "applied",
      latestOutcomeChangedEvidence: true,
      finalRound: true,
      ...overrides,
    });
    const recurring = facts({
      phase: "task-impl",
      result: "fail",
      failure: semanticFailure,
      retry: new GateRetryMetrics({ used: 0, maximum: 4 }),
      taskBudget: { round: 2, maximumRounds: 2 },
      observationConvergence: convergence(),
    });
    const recurringAdmission = resolveGateEvaluationAdmission(recurring);
    assert.equal(recurringAdmission.admitted, false);
    assert.equal(recurringAdmission.selectedDecision.disposition.operation, "defer");
    assert.equal(recurringAdmission.selectedDecision.plan.retryMetric, null);

    const freshObservation = facts({
      phase: "task-impl",
      result: "fail",
      failure: semanticFailure,
      retry: new GateRetryMetrics({ used: 0, maximum: 4 }),
      taskBudget: { round: 2, maximumRounds: 2 },
      observationConvergence: convergence({
        occurrenceCount: 1,
        repairCount: 0,
        recurrenceCount: 0,
        recurringObservationCount: 0,
        latestOutcomeDisposition: null,
        latestOutcomeChangedEvidence: false,
      }),
    });
    assert.equal(resolveGateEvaluationAdmission(freshObservation).selectedDecision.disposition.operation, "retry");
    assert.equal(resolveGateEvaluationAdmission(null).admitted, true,
      "only a Gate with no published canonical result can invoke its evaluator");

    const noProgress = facts({
      result: "fail",
      failure: semanticFailure,
      observationConvergence: convergence({
        occurrenceCount: 1,
        repairCount: 1,
        recurrenceCount: 0,
        recurringObservationCount: 0,
        latestOutcomeDisposition: "rejected-no-progress",
        latestOutcomeChangedEvidence: false,
        finalRound: false,
      }),
    });
    assert.equal(resolveGateEvaluationAdmission(noProgress).selectedDecision.disposition.operation, "blocked");

    const mixed = facts({
      phase: "task-impl",
      result: "fail",
      failure: semanticFailure,
      retry: new GateRetryMetrics({ used: 0, maximum: 4 }),
      taskBudget: { round: 2, maximumRounds: 2 },
      observationConvergence: convergence({
        observationFingerprints: ["a".repeat(64), "b".repeat(64)],
        occurrenceCount: 3,
        recurrenceCount: 1,
        recurringObservationCount: 1,
      }),
    });
    assert.equal(resolveGateEvaluationAdmission(mixed).selectedDecision.disposition.operation, "retry",
      "one recurring observation must not classify its fresh sibling as recurring");
  });

  it("selects the Task Gate advisory matrix from typed failure, retry, and successor facts", () => {
    for (const category of ["semantic", "local", "tooling"]) {
      for (const exhausted of [false, true]) {
        for (const nextTaskId of [null, "T-2"]) {
          const retry = new GateRetryMetrics({ used: exhausted ? 2 : 0, maximum: 2 });
          const decision = resolveGateTransition(facts({
            phase: "task-impl",
            result: "fail",
            failure: new GateFailureCategory({
              category,
              code: category === "local" ? "GATE_LOCAL_INPUT_INVALID" : category === "tooling" ? "GATE_PROVIDER_UNAVAILABLE" : "TASK_GATE_REJECTED",
            }),
            retry,
            taskBudget: { round: exhausted ? 2 : 1, maximumRounds: 2 },
            taskLifecycle: { taskId: "T-1", nextTaskId, integrationStepId: "test-execute" },
          }));
          const eligibility = gateNonblockingEligibilityForDecision(decision);
          if (category === "semantic" && !exhausted) {
            assert.equal(decision.disposition.operation, "retry");
            assert.equal(eligibility, null);
            continue;
          }
          assert.notEqual(eligibility, null);
          assert.equal(eligibility.resultKind, category === "semantic" ? "quality" : category === "local" ? "unavailable" : "tooling");
          assert.deepEqual(eligibility.allowedActions, category === "semantic" ? ["repair", "continue"] : ["retry", "continue"]);
          assert.equal(eligibility.effectFor("continue").targetStepId, nextTaskId === null ? "test-execute" : `${nextTaskId}-impl`);
          assert.equal(eligibility.effectFor(category === "semantic" ? "repair" : "retry").targetStepId, "task-gate");
        }
      }
    }
  });

  it("keeps every review, Gate, and acceptance route in the Definition-owned behavior table", () => {
    assert.deepEqual(NONBLOCKING_ROUTES.map((route) => route.sourceStep).sort(), [
      "acceptance-review", "draft-coverage-review", "draft-gate", "draft-questions-review",
      "final-regression", "impl-gate", "impl-review", "retro",
      "spec-gate", "task-gate", "task-review", "test-result-review",
    ]);
    const selected = new Map();
    for (const [sourceStep, phase, scope] of [
      ["draft-questions-review", "draft-questions", "flow"],
      ["draft-coverage-review", "draft-coverage", "flow"],
      ["task-review", "impl", "task"],
      ["impl-review", "impl", "flow"],
    ]) {
      const disposition = resolveReviewTransition({
        stepId: sourceStep,
        flowState: { policy: { nonblocking: null }, metrics: [] },
        facts: new ReviewTransitionFacts({ scope, phase, toolingOutcome: { code: "PROVIDER_UNAVAILABLE" } }),
      });
      selected.set(sourceStep, reviewNonblockingEligibilityForDisposition({ stepId: sourceStep, disposition }));
    }
    for (const [sourceStep, phase] of [["draft-gate", "draft"], ["spec-gate", "spec"], ["impl-gate", "integration"]]) {
      selected.set(sourceStep, gateNonblockingEligibilityForDecision(resolveGateTransition(facts({
        phase,
        result: "fail",
        failure: new GateFailureCategory({ category: "local", code: "GATE_LOCAL_INPUT_INVALID" }),
      }))));
    }
    selected.set("task-gate", gateNonblockingEligibilityForDecision(resolveGateTransition(facts({
      phase: "task-impl",
      result: "fail",
      failure: new GateFailureCategory({ category: "tooling", code: "GATE_PROVIDER_UNAVAILABLE" }),
    }))));
    for (const sourceStep of ["retro", "acceptance-review"]) {
      selected.set(sourceStep, acceptanceBoundaryNonblockingEligibility({ sourceStep, resultKind: "quality" }));
    }
    for (const route of NONBLOCKING_ROUTES.filter((entry) => selected.has(entry.sourceStep))) {
      const eligibility = selected.get(route.sourceStep);
      assert.notEqual(eligibility, null, `${route.sourceStep} remains eligible`);
      assert.deepEqual(eligibility.allowedActions, eligibility.resultKind === "quality" ? ["repair", "continue"] : ["retry", "continue"]);
      assert.equal(eligibility.effectFor("continue").targetStepId,
        route.sourceStep === "task-gate" ? "test-execute" : route.targetStep);
      assert.deepEqual(eligibility.effectFor("continue").skippedStepIds, route.skippedSteps);
    }
    assert.deepEqual([...selected.keys()].sort(), [
      "acceptance-review", "draft-coverage-review", "draft-gate", "draft-questions-review",
      "impl-gate", "impl-review", "retro", "spec-gate", "task-gate", "task-review",
    ]);
  });

  it("uses persisted Attempt consumption: four retries permit a fifth failed evaluation, never a sixth", () => {
    const operations = [];
    for (let consumption = 0; consumption <= 4; consumption += 1) {
      const attempt = new GateAttemptIdentity({ id: `attempt-${consumption + 1}`, sequence: consumption + 1 });
      const decision = resolveGateTransition(facts({
        currentAttempt: attempt,
        catalogPublication: new GateCatalogPublication({
          attemptId: attempt.id, sequence: attempt.sequence, producerActivityId: "activity-spec-gate",
          artifactId: `gate.result.${attempt.sequence}`, fingerprint: `revision-${attempt.sequence}`,
        }),
        result: "fail", failure: new GateFailureCategory({ category: "semantic" }),
        retry: new GateRetryMetrics({ used: consumption, maximum: 4 }),
        lineage: new GateLineage({
          sourceAttempt: attempt, canonicalAttempt: attempt,
          sourceFingerprint: `revision-${attempt.sequence}`, canonicalFingerprint: `revision-${attempt.sequence}`,
        }),
      }));
      operations.push(decision.disposition.operation);
    }
    assert.deepEqual(operations, ["retry", "retry", "retry", "retry", "defer"]);
  });

  it("keeps report wording route-free and never grants approval to Draft", () => {
    const draft = resolveGateTransition(facts({ phase: "draft" }));
    const spec = resolveGateTransition(facts({ phase: "spec" }));
    assert.equal(Object.hasOwn(draft.plan.phaseDefinition, "nextStepId"), false);
    assert.equal(Object.hasOwn(spec.plan.phaseDefinition, "nextStepId"), false);
    assert.equal(draft.advance.operation, "advance");
    assert.equal(spec.advance.operation, "advance");
    for (const operation of ["retry", "repair", "defer", "external-blocked", "blocked"]) {
      const decision = resolveGateTransition(facts({
        phase: "draft", result: "fail", failure: new GateFailureCategory({ category: "semantic" }),
        retry: new GateRetryMetrics({ used: operation === "defer" ? 4 : 0, maximum: 4 }),
      }));
      if (decision.disposition.operation !== "pass") assert.notEqual(decision.advance?.operation, "advance");
    }
  });

  it("seals materialized Task lifecycle successors and repair resets into the Action plan", () => {
    const task = facts({
      phase: "task-impl",
      scope: "task",
      producer: {
        runId: "run-7", specId: "007-gate-transition", activityId: "activity-spec-gate",
        phase: "task-impl", scope: "task", taskId: "T-1", stepId: "T-1-gate",
      },
      target: { runId: "run-7", specId: "007-gate-transition", taskId: "T-1", stepId: "T-1-gate", attempt: { id: "attempt-7", sequence: 7 } },
      taskLifecycle: { taskId: "T-1", nextTaskId: "T-2", integrationStepId: "test-execute" },
    });
    const passed = resolveGateTransition(task);
    assert.equal(passed.plan.action.identity.taskId, "T-1");
    assert.deepEqual(passed.plan.taskLifecycle.toJSON(), {
      operation: "complete-and-advance", taskId: "T-1", successorStepId: "T-2-impl", resetStepIds: [],
    });
    const repair = resolveGateTransition(facts({
      ...task.toJSON(), result: "fail", failure: { category: "semantic", code: "GATE_REJECTED" },
      retry: { used: 4, maximum: 4 },
      recoveryEvidence: { kind: "repair", attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" },
    }));
    assert.deepEqual(repair.plan.taskLifecycle.toJSON(), {
      operation: "repair-task-impl", taskId: "T-1", successorStepId: "T-1-impl",
      resetStepIds: ["T-1-impl", "T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"],
    });
    const firstRoundExhausted = resolveGateTransition(facts({
      ...task.toJSON(), result: "fail", failure: { category: "semantic", code: "GATE_REJECTED" },
      retry: { used: 4, maximum: 4 },
      taskLifecycle: { taskId: "T-1", nextTaskId: null, integrationStepId: "test-execute" },
      recoveryEvidence: { kind: "repair", attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" },
    }));
    assert.deepEqual(firstRoundExhausted.plan.taskLifecycle.toJSON(), {
      operation: "repair-task-impl", taskId: "T-1", successorStepId: "T-1-impl",
      resetStepIds: ["T-1-impl", "T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"],
    });
    const finalTask = resolveGateTransition(facts({
      ...task.toJSON(), result: "fail", failure: { category: "semantic", code: "GATE_REJECTED" },
      retry: { used: 4, maximum: 4 },
      taskBudget: { round: 2, maximumRounds: 2 },
      taskLifecycle: { taskId: "T-1", nextTaskId: null, integrationStepId: "test-execute" },
      recoveryEvidence: { kind: "repair", attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" },
    }));
    assert.deepEqual(finalTask.plan.taskLifecycle.toJSON(), {
      operation: "defer-and-advance", taskId: "T-1", successorStepId: "test-execute", resetStepIds: [],
    });
  });

  it("keeps task-spec as a flow advance and out of materialized Task Steps", () => {
    const decision = resolveGateTransition(facts({ phase: "task-spec", result: "pass" }));
    assert.equal(decision.advance.operation, "advance");
    assert.equal(Object.hasOwn(decision.plan.phaseDefinition, "nextStepId"), false);
    const definition = buildCurrentFlowDefinition();
    assert.deepEqual(definition.taskTemplate.steps.map((step) => step.id), [
      "task-impl", "task-review", "task-triage", "task-repair", "task-gate",
    ]);
  });

  it("represents recovery separately from pass and advance", () => {
    const binding = { attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" };
    const decision = resolveGateTransition(facts({
      result: "recovered",
      recoveryEvidence: new GateRecoveryEvidence({ kind: "recovered", ...binding }),
    }));
    assert.equal(decision.disposition.operation, "recovery");
    assert.equal(decision.advance, null);
  });

  it("fails closed for stale attempt and lineage evidence", () => {
    const current = new GateAttemptIdentity({ id: "attempt-8", sequence: 8 });
    const stalePublication = new GateCatalogPublication({
      attemptId: "attempt-7",
      sequence: 7,
      producerActivityId: "activity-spec-gate",
      artifactId: "gate.result.7",
      fingerprint: "revision-7",
    });
    const catalogMismatch = resolveGateTransition(facts({ currentAttempt: current, catalogPublication: stalePublication }));
    assert.equal(catalogMismatch.disposition.operation, "blocked");
    assert.equal(catalogMismatch.disposition.reason, "attempt_catalog_mismatch");

    const staleLineage = resolveGateTransition(facts({
      lineage: new GateLineage({
        sourceAttempt: new GateAttemptIdentity({ id: "attempt-6", sequence: 6 }),
        canonicalAttempt: new GateAttemptIdentity({ id: "attempt-7", sequence: 7 }),
        sourceFingerprint: "revision-6", canonicalFingerprint: "revision-7",
      }),
    }));
    assert.equal(staleLineage.disposition.operation, "blocked");
    assert.equal(staleLineage.disposition.reason, "source_canonical_lineage_mismatch");

    const staleRevisionBinding = resolveGateTransition(facts({
      lineage: new GateLineage({
        sourceAttempt: new GateAttemptIdentity({ id: "attempt-7", sequence: 7 }),
        canonicalAttempt: new GateAttemptIdentity({ id: "attempt-7", sequence: 7 }),
        sourceFingerprint: "source-hash",
        canonicalFingerprint: "revision-7",
        sourceRevisionFingerprint: "revision-7",
        canonicalRevisionFingerprint: "revision-6",
      }),
    }));
    assert.equal(staleRevisionBinding.disposition.reason, "source_canonical_lineage_mismatch");

    const staleTarget = resolveGateTransition(facts({
      target: {
        runId: "old-run",
        specId: "007-gate-transition",
        stepId: "spec-gate",
        attempt: { id: "attempt-7", sequence: 7 },
      },
    }));
    assert.equal(staleTarget.disposition.reason, "target_binding_mismatch");

    const staleCatalogFingerprint = resolveGateTransition(facts({
      catalogPublication: {
        attemptId: "attempt-7",
        sequence: 7,
        producerActivityId: "activity-spec-gate",
        artifactId: "gate.result.7",
        fingerprint: "old-revision",
      },
    }));
    assert.equal(staleCatalogFingerprint.disposition.reason, "catalog_lineage_mismatch");

    const taskStepMismatch = resolveGateTransition(facts({
      phase: "task-impl",
      scope: "task",
      producer: {
        runId: "run-7", specId: "007-gate-transition", activityId: "activity-task-gate",
        phase: "task-impl", scope: "task", taskId: "T-1", stepId: "T-2-gate",
      },
      target: {
        runId: "run-7", specId: "007-gate-transition", taskId: "T-1", stepId: "T-2-gate",
        attempt: { id: "attempt-7", sequence: 7 },
      },
      taskLifecycle: { taskId: "T-1", nextTaskId: "T-2", integrationStepId: "test-execute" },
    }));
    assert.equal(taskStepMismatch.disposition.operation, "blocked");
    assert.equal(taskStepMismatch.disposition.reason, "task_step_identity_mismatch");
  });

  it("rejects incomplete retry, recovery, ownership, and target facts at the boundary", () => {
    assert.throws(() => new GateRetryMetrics({ used: 0 }), /positive integer/);
    assert.throws(() => facts({ result: "recovered" }), /matching recovery evidence/);
    assert.throws(() => facts({
      producer: {
        runId: "run-7",
        specId: "007-gate-transition",
        activityId: "activity-spec-gate",
        phase: "task-impl",
        scope: "task",
        stepId: "T-1-gate",
      },
      phase: "task-impl",
      scope: "task",
    }), /taskId binding/);
    assert.equal(resolveGateTransition(facts({ phase: "task-impl", scope: "flow" })).disposition.reason, "phase_scope_mismatch");
    assert.equal(resolveGateTransition(facts({ phase: "integration", scope: "task" })).disposition.reason, "phase_scope_mismatch");
  });

  it("applies only the decision plan and rejects a bypassed or stale decision", () => {
    const decision = resolveGateTransition(facts({
      result: "fail", failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 0, maximum: 1 }),
    }));
    const calls = [];
    applyGateTransitionDecision({
      applyStepUpdate(update, selected) { calls.push([update, selected]); },
      applyRetryMetric(effect, selected) { calls.push([effect, selected]); },
    }, decision);
    assert.equal(calls[0][0] instanceof GateStepUpdate, true);
    assert.equal(calls[0][0].status, "in_progress");
    assert.equal(calls[1][0].operation, "increment");
    assert.equal(calls[1][0].phase, "spec");
    const passCalls = [];
    applyGateTransitionDecision({
      applyStepUpdate() {},
      applyRetryMetric(effect, selected) { passCalls.push([effect, selected]); },
    }, resolveGateTransition(facts()));
    assert.equal(passCalls[0][0].operation, "reset");
    assert.equal(admitGateTransition({ facts: decision.facts, decision }).disposition.operation, "retry");
    const projection = projectGateTransitionDecision(decision);
    assert.equal(projection instanceof GateTransitionActionProjection, true);
    assert.deepEqual(projection.toJSON(), {
      phase: "spec",
      scope: "flow",
      stepId: "spec-gate",
      actionId: decision.plan.action.identity.toJSON(),
      operation: "retry",
      reason: null,
      failureCode: null,
      advance: false,
      nonblockingHandoff: null,
    });

    const changed = facts({
      result: "fail", failure: new GateFailureCategory({ category: "semantic" }),
      retry: new GateRetryMetrics({ used: 1, maximum: 1 }),
    });
    assert.throws(() => admitGateTransition({ facts: changed, decision }), /admission rejected/);
    assert.throws(() => applyGateTransitionDecision({}, decision), /applyStepUpdate/);
    assert.throws(() => new GateTransitionDecision({}), /created only by definition/);
  });

  it("requires a sealed Decision and limits Gate post lifecycle to decision-owned actions", () => {
    assert.throws(() => resolveLifecycle({
      event: "gate:post",
      currentStepId: "spec-gate",
      phase: "spec",
      result: { result: "pass", artifacts: { phase: "spec" } },
    }), /requires a Definition-selected GateTransitionDecision/);

    const decision = resolveGateTransition(facts());
    const actions = resolveLifecycle({
      event: "gate:post",
      currentStepId: "spec-gate",
      gateTransitionDecision: decision,
    });
    const doneIndex = actions.findIndex((action) => (
      action instanceof SetStepStatus
        && action.step === "spec-gate"
        && action.status === "done"
    ));
    assert.ok(doneIndex >= 0);
    assert.equal(actions.length, 2);
    assert.equal(actions[1] instanceof IncrementMetric, true);
  });

  it("leaves every Task Review route to the typed review-funnel connector", () => {
    const flowState = {
      tasks: [{ id: "T-1", steps: ["impl", "review", "triage", "repair", "gate"].map((role) => ({ id: `T-1-${role}` })) }],
    };
    const actions = resolveLifecycle({
      event: "review:post",
      currentStepId: "T-1-review",
      phase: "impl",
      flowState,
      result: {
        result: "ok",
        artifacts: {
          phase: "impl",
          taskId: "T-1",
          verdict: "PASS",
          noChange: true,
          noChangeReasons: ["The required behavior is already present."],
          sourceFingerprint: "a".repeat(64),
        },
      },
    });
    assert.deepEqual(actions, []);
    const rejected = resolveLifecycle({
      event: "review:post",
      currentStepId: "T-1-review",
      phase: "impl",
      flowState,
      result: { result: "ok", artifacts: { phase: "impl", taskId: "T-1", verdict: "REJECTED", noChange: true, noChangeReasons: ["present"], sourceFingerprint: "a".repeat(64) } },
    });
    assert.deepEqual(rejected, []);
  });

  it("keeps decision construction and policy branches out of consumers", () => {
    const definition = readFileSync(new URL("../../../src/flow/definition.js", import.meta.url), "utf8");
    const factsBoundary = readFileSync(new URL("../../../src/flow/lib/gate-transition.js", import.meta.url), "utf8");
    const application = readFileSync(new URL("../../../src/flow/lib/gate-transition-application.js", import.meta.url), "utf8");
    const legacyConsumers = [
      "../../../src/flow/lib/run-gate.js",
      "../../../src/flow/registry.js",
      "../../../src/flow/lib/get-next-action.js",
    ].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"));

    assert.match(definition, /export function resolveGateTransition\(facts\)/);
    assert.doesNotMatch(factsBoundary, /resolveGateTransition|GateTransitionDecision|GateStepUpdatePlan/);
    assert.doesNotMatch(application, /facts\.(?:result|failure|retry|recoveryEvidence)/);
    for (const source of legacyConsumers) {
      assert.doesNotMatch(source, /new Gate(?:TransitionDecision|StepUpdatePlan|TransitionDisposition)/);
    }
    const gateRunner = legacyConsumers[0];
    assert.doesNotMatch(gateRunner, /"task-spec": "task-impl"/);
    assert.doesNotMatch(gateRunner, /"task-impl": "complete-task"|"task-impl": "implement"/);
    assert.doesNotMatch(gateRunner, /(?:PASS|FAIL)_(?:NEXT|PRESCRIPTION)/);
    assert.doesNotMatch(gateRunner, /"integration": "(?:retro|implement)"/);
    assert.doesNotMatch(gateRunner, /recoverFromCurrentAuthority/);
    assert.doesNotMatch(gateRunner, /checkRetryBelowMax|checkNoProgressSinceLastFail|assertNoRepeatedFail|buildGateRetryExhaustedEnvelope|inspectDurableGateSemanticDeferral|gateExternalBlock|recordGateOutcome/);
    assert.doesNotMatch(gateRunner, /result\?\.next|result\.next/);
    assert.doesNotMatch(legacyConsumers[1], /isDefinitionOwnedPlanGate/);
    assert.doesNotMatch(legacyConsumers[2], /artifacts\?\.nextAction.*(?:retry|defer|repair)|artifacts\.nextAction.*(?:retry|defer|repair)/);
    assert.doesNotMatch(legacyConsumers[2], /selection\.decision/);
    assert.doesNotMatch(gateRunner, /InferredGateTransition|GateMutationOwner|createLifecycleStepTransition/);
  });

  it("keeps Action identity deterministic across reload and all dispositions", () => {
    const cases = [
      facts(),
      facts({ result: "fail", failure: new GateFailureCategory({ category: "semantic" }), retry: new GateRetryMetrics({ used: 3, maximum: 4 }) }),
      facts({ result: "fail", failure: new GateFailureCategory({ category: "semantic" }), retry: new GateRetryMetrics({ used: 4, maximum: 4 }) }),
      facts({ result: "fail", failure: new GateFailureCategory({ category: "tooling", code: "PROTOCOL" }), retry: new GateRetryMetrics({ used: 0, maximum: 4 }) }),
      facts({ result: "recovered", recoveryEvidence: new GateRecoveryEvidence({ kind: "recovered", attempt: { id: "attempt-7", sequence: 7 }, fingerprint: "revision-7" }) }),
    ];
    for (const input of cases) {
      const original = resolveGateTransition(input);
      const reloaded = resolveGateTransition(reload(JSON.parse(JSON.stringify(input.toJSON()))));
      assert.equal(original.plan.action.identity.matches(reloaded.plan.action.identity), true);
      assert.equal(original.plan.action.identity.operation, original.disposition.operation);
    }
  });
});
