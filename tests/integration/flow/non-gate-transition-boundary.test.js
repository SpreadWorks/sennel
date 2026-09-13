import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalFlowCreateRequest } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import { CurrentFlowSpecRecord, CurrentFlowState } from "../../../src/flow/lib/current-flow-state.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

import {
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateRecoveryEvidence,
  NonGateRetryMetrics,
  NonGateRepairPublication,
  NonGateSourcePublication,
  NonGateStepAction,
  NonGateStepDefinition,
  NonGateStepFacts,
  NonGateTargetBinding,
  NonGateTransitionFacts,
  NonGateTransitionSelection,
  TestExecuteStepFacts,
  TestResultReviewStepFacts,
  resolveNonGateTransition,
  nonGateNonblockingEligibilityForDecision,
  testExecuteTransitionDefinition,
  testResultReviewTransitionDefinition,
} from "../../../src/flow/definition.js";
import {
  admitNonGateDirectCommand,
  executeAdmittedNonGateCommand,
  applyNonGateTransitionDecision,
  projectNonGateTransitionDecision,
  resolveNonGateNextAction,
} from "../../../src/flow/lib/non-gate-transition-application.js";
import { readCurrentNonGateTransitionFacts } from "../../../src/flow/lib/non-gate-transition-facts.js";
import { admitTestChainDirectExecution, readCurrentTestChainTransitionFacts } from "../../../src/flow/lib/test-chain-transition-facts.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import RunTestExecuteCommand from "../../../src/flow/lib/run-test-execute.js";
import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";

const fixtureRoots = [];

const testSourceHash = "a".repeat(64);
const finalizedTestSourceDigest = createHash("sha256")
  .update(`fixture.test.js\0${testSourceHash}\0${1}`)
  .digest("hex");

function finalizedTestSourceSnapshotEntries() {
  return {
    activity: {
      id: "test-source-confirmed", attemptId: "test-attempt-1", sequence: 1, nodeId: "test-gate",
      type: "result_confirmed",
      transition: {
        operation: "advance_requirement_test_lifecycle",
        nodeId: "test-gate",
        requirementTestLifecycle: { disposition: "promote" },
      },
      result: { outcome: "passed", confirmedAt: "2026-08-24T00:00:00.000Z" },
    },
    descriptor: {
      logicalKey: "tests.source", relativePath: "artifacts/tests/fixture.test.js", hash: testSourceHash,
      size: 1, activityId: "test-source-confirmed", slot: { publicationStep: "test-gate" },
    },
  };
}

afterEach(() => {
  for (const directory of fixtureRoots.splice(0)) removeTmpDir(directory);
});

class FixtureStepFacts extends NonGateStepFacts {
  constructor({ state } = {}) {
    super({ kind: "fixture-step", values: { state } });
  }

  get state() { return this.value("state"); }

  toJSON() { return { kind: this.kind, values: { state: this.state } }; }
}

class FixtureIssueLogAction extends NonGateStepAction {
  constructor({ summary } = {}) {
    super();
    this.summary = summary;
    Object.freeze(this);
  }

  apply(adapter, plan) { return adapter.appendIssueLog(this.summary, plan); }
  toJSON() { return { summary: this.summary }; }
}

const selections = Object.freeze({
  passed: "advance",
  pending: "keep-in-progress",
  question: "await-user-input",
  retryable: "retry",
  repairable: "repair",
  recorded: "record-and-proceed",
  external: "external-blocked",
  blocked: "blocked",
  parked: "park",
  recovered: "repair",
});

const definition = new NonGateStepDefinition({
  stepId: "fixture-step",
  factsType: FixtureStepFacts,
  select(stepFacts, facts) {
    const operation = facts.nonblocking && stepFacts.state === "external"
      ? "record-and-proceed"
      : selections[stepFacts.state];
    if (operation === undefined) throw new Error("unknown fixture state");
    if (stepFacts.state === "recovered" && facts.recoveryEvidence.kind !== "repair") {
      throw new Error("fixture recovery needs canonical recovery evidence");
    }
    return new NonGateTransitionSelection({
      operation,
      reason: stepFacts.state === "external" ? "provider_unavailable" : null,
      actions: stepFacts.state === "repairable"
        ? [new FixtureIssueLogAction({ summary: "repair selected" })]
        : [],
    });
  },
});

function facts(overrides = {}) {
  const attempt = overrides.currentAttempt ?? new NonGateAttemptIdentity({ id: "attempt-9", sequence: 9 });
  const fingerprint = "f".repeat(64);
  const stepId = overrides.stepId ?? "fixture-step";
  return new NonGateTransitionFacts({
    runId: "run-9",
    specId: "009-non-gate-transition",
    stepId,
    snapshotRevision: "state-revision-9",
    producer: new NonGateProducerOwnership({
      runId: "run-9", specId: "009-non-gate-transition", activityId: "activity-9", stepId, attempt,
    }),
    target: new NonGateTargetBinding({
      runId: "run-9", specId: "009-non-gate-transition", stepId, attempt,
    }),
    currentAttempt: attempt,
    catalogPublication: new NonGateCatalogPublication({
      runId: "run-9", specId: "009-non-gate-transition", stepId,
      attemptId: attempt.id,
      sequence: attempt.sequence,
      producerActivityId: "activity-9",
      artifactId: "fixture.result.9",
      fingerprint,
    }),
    sourcePublication: new NonGateSourcePublication({
      runId: "run-9", specId: "009-non-gate-transition", stepId,
      attemptId: attempt.id, sequence: attempt.sequence, producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint,
    }),
    lineage: new NonGateLineage({
      sourceAttempt: attempt,
      canonicalAttempt: attempt,
      sourceFingerprint: fingerprint,
      canonicalFingerprint: fingerprint,
    }),
    retry: new NonGateRetryMetrics({ used: 0, maximum: 2 }),
    completion: new NonGateCompletionFacts({ completed: overrides.completed ?? false }),
    recoveryEvidence: new NonGateRecoveryEvidence(overrides.recoveryEvidence),
    nonblocking: overrides.nonblocking ?? false,
    stepFacts: overrides.stepFacts ?? new FixtureStepFacts({ state: "pending" }),
    ...overrides,
  });
}

function reloaded(value) {
  return NonGateTransitionFacts.fromPersisted(value, {
    stepFacts: (stored) => new FixtureStepFacts({ state: stored.values.state }),
  });
}

function flowManagerFor(source) {
  return {
    readCanonicalTransitionSnapshot() {
      return Object.freeze({
        runId: source.runId, specId: source.specId, stepId: source.stepId, revision: source.snapshotRevision,
        state: Object.freeze({ runId: source.runId, specId: source.specId }),
        attempt: { id: source.currentAttempt.id, sequence: source.currentAttempt.sequence },
        activities: [{ id: "activity-9", attemptId: "attempt-9", sequence: 9, nodeId: "fixture-step" }],
        catalog: [{ relativePath: "fixture.result.9", hash: "f".repeat(64), activityId: "activity-9" }],
      });
    },
  };
}

describe("definition-owned non-Gate transition boundary", () => {
  it("keeps the test-result advisory route in the Definition-owned behavior table", () => {
    const cases = [
      [
        "test-result-review",
        testResultReviewTransitionDefinition,
        new TestResultReviewStepFacts({
          verdict: "pass",
          checkedItems: [{ result: "pass" }],
          toolingFailure: true,
        }),
      ],
    ];
    for (const [stepId, stepDefinition, stepFacts] of cases) {
      const decision = resolveNonGateTransition(facts({ stepId, stepFacts }), stepDefinition);
      const eligibility = nonGateNonblockingEligibilityForDecision(decision);
      assert.notEqual(eligibility, null);
      assert.equal(eligibility.sourceStep, stepId);
      assert.equal(eligibility.resultKind, "tooling");
      assert.deepEqual(eligibility.allowedActions, ["retry", "continue"]);
      assert.equal(eligibility.effectFor("retry").targetStepId, stepId);
    }
  });

  it("reloads typed state, revision, Activity prefix, and catalog from one persisted Version snapshot", () => {
    const repository = createTmpDir("non-gate-transition-snapshot-");
    fixtureRoots.push(repository);
    const specId = "009-non-gate-transition-snapshot";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    manager.createFresh(new CanonicalFlowCreateRequest({
      specId,
      runId: "run-non-gate-transition-snapshot",
      request: "Build a persisted transition snapshot fixture.",
      execution: { mode: "direct" },
      policy: { autoApprove: false, nonblocking: null },
      flowId: "flow-non-gate-transition-snapshot",
      flowVersionId: "flow-non-gate-transition-snapshot-v1",
      specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId }),
    }));
    const first = manager.canonicalState(specId).nextAction();
    manager.updateStepStatus({ stepId: first.nodeId, requestedStatus: "in_progress" }, { specId });

    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const snapshot = reloaded.readCanonicalTransitionSnapshot(specId);
    assert.ok(snapshot.state instanceof CurrentFlowState);
    assert.equal(snapshot.stepId, first.nodeId);
    assert.equal(snapshot.attempt.id, snapshot.state.attempt.id);
    assert.equal(snapshot.revision.length, 64);
    assert.ok(snapshot.activities.length >= 2);
    assert.ok(snapshot.catalog.some((entry) => entry.relativePath === "flow.json"));
    assert.deepEqual(snapshot.toJSON().state, snapshot.state.toJSON());
  });

  it("lets a Step-specific Definition select every supported disposition", () => {
    const expected = [
      ["passed", "advance", { completed: true }],
      ["pending", "keep-in-progress"],
      ["question", "await-user-input"],
      ["retryable", "retry"],
      ["repairable", "repair"],
      ["recorded", "record-and-proceed"],
      ["external", "external-blocked"],
      ["blocked", "blocked"],
      ["parked", "park"],
    ];
    for (const [state, operation, options = {}] of expected) {
      const decision = resolveNonGateTransition(facts({
        ...options,
        stepFacts: new FixtureStepFacts({ state }),
      }), definition);
      assert.equal(decision.disposition.operation, operation);
      assert.equal(decision.plan.action.identity.operation, operation);
    }
  });

  it("keeps the remaining test-chain route tables in Definition", () => {
    const scenarios = [
      ["test-execute", testExecuteTransitionDefinition, new TestExecuteStepFacts({ rawAvailable: true }), true, false, "advance"],
      ["test-execute", testExecuteTransitionDefinition, new TestExecuteStepFacts({ rawAvailable: true, process: { started: false, exitCode: null, signal: null, timedOut: false, spawnError: "fixture" } }), true, false, "external-blocked"],
      ["test-result-review", testResultReviewTransitionDefinition, new TestResultReviewStepFacts({ verdict: "pass", rawAvailable: true, checkedItems: [{ result: "pass" }] }), true, false, "advance"],
      ["test-result-review", testResultReviewTransitionDefinition, new TestResultReviewStepFacts({ verdict: "fail", rawAvailable: true, checkedItems: [{ result: "fail" }] }), true, false, "retry"],
      ["test-result-review", testResultReviewTransitionDefinition, new TestResultReviewStepFacts({ verdict: "fail", rawAvailable: true, checkedItems: [{ result: "fail" }] }), true, true, "retry"],
      ["test-result-review", testResultReviewTransitionDefinition, new TestResultReviewStepFacts({ verdict: "fail", rawAvailable: true, checkedItems: [{ result: "fail" }], toolingFailure: true }), true, false, "external-blocked"],
    ];
    for (const [stepId, stepDefinition, stepFacts, completed, nonblocking, operation] of scenarios) {
      const decision = resolveNonGateTransition(facts({
        stepId,
        producer: new NonGateProducerOwnership({
          runId: "run-9", specId: "009-non-gate-transition", activityId: "activity-9", stepId,
          attempt: new NonGateAttemptIdentity({ id: "attempt-9", sequence: 9 }),
        }),
        target: new NonGateTargetBinding({
          runId: "run-9", specId: "009-non-gate-transition", stepId,
          attempt: new NonGateAttemptIdentity({ id: "attempt-9", sequence: 9 }),
        }),
        catalogPublication: new NonGateCatalogPublication({
          runId: "run-9", specId: "009-non-gate-transition", stepId, attemptId: "attempt-9", sequence: 9,
          producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint: "f".repeat(64),
        }),
        sourcePublication: new NonGateSourcePublication({
          runId: "run-9", specId: "009-non-gate-transition", stepId, attemptId: "attempt-9", sequence: 9,
          producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint: "f".repeat(64),
        }),
        completion: new NonGateCompletionFacts({ completed }),
        nonblocking,
        stepFacts,
      }), stepDefinition);
      assert.equal(decision.disposition.operation, operation);
    }
  });

  it("rejects contradictory typed review observations in their constructors", () => {
    assert.throws(
      () => new TestResultReviewStepFacts({ verdict: "pass", checkedItems: [{ result: "fail" }] }),
      /verdict must match its checked observations/,
    );
    assert.throws(
      () => new TestResultReviewStepFacts({ verdict: "fail", checkedItems: [{ result: "pass" }] }),
      /verdict must match its checked observations/,
    );
  });

  it("externally blocks incomplete test-execute process observations", () => {
    const attempt = new NonGateAttemptIdentity({ id: "attempt-incomplete-process", sequence: 1 });
    for (const process of [
      { started: false, exitCode: null, signal: null, timedOut: false, spawnError: null },
      { started: true, exitCode: null, signal: null, timedOut: false, spawnError: null },
    ]) {
      const stepId = "test-execute";
      const observed = new NonGateTransitionFacts({
        runId: "run-9",
        specId: "009-non-gate-transition",
        stepId,
        snapshotRevision: "state-revision-incomplete-process",
        producer: new NonGateProducerOwnership({
          runId: "run-9", specId: "009-non-gate-transition", activityId: "activity-incomplete-process", stepId, attempt,
        }),
        target: new NonGateTargetBinding({
          runId: "run-9", specId: "009-non-gate-transition", stepId, attempt,
        }),
        currentAttempt: attempt,
        catalogPublication: new NonGateCatalogPublication({
          runId: "run-9", specId: "009-non-gate-transition", stepId, attemptId: attempt.id, sequence: attempt.sequence,
          producerActivityId: "activity-incomplete-process", artifactId: "fixture.incomplete-process", fingerprint: "f".repeat(64),
        }),
        sourcePublication: new NonGateSourcePublication({
          runId: "run-9", specId: "009-non-gate-transition", stepId, attemptId: attempt.id, sequence: attempt.sequence,
          producerActivityId: "activity-incomplete-process", artifactId: "fixture.incomplete-process", fingerprint: "f".repeat(64),
        }),
        lineage: new NonGateLineage({
          sourceAttempt: attempt, canonicalAttempt: attempt, sourceFingerprint: "f".repeat(64), canonicalFingerprint: "f".repeat(64),
        }),
        retry: new NonGateRetryMetrics({ used: 1, maximum: 2 }),
        completion: new NonGateCompletionFacts({ completed: true }),
        nonblocking: false,
        stepFacts: new TestExecuteStepFacts({ rawAvailable: true, process }),
      });
      assert.equal(
        resolveNonGateTransition(observed, testExecuteTransitionDefinition).disposition.operation,
        "external-blocked",
      );
    }
  });

  it("fails closed for stale Attempts, catalog publication, lineage, and partial completion", () => {
    const current = new NonGateAttemptIdentity({ id: "attempt-9", sequence: 9 });
    const stale = new NonGateAttemptIdentity({ id: "attempt-8", sequence: 8 });
    assert.equal(resolveNonGateTransition(facts({ currentAttempt: current, catalogPublication: new NonGateCatalogPublication({
      runId: "run-9", specId: "009-non-gate-transition", stepId: "fixture-step",
      attemptId: stale.id, sequence: stale.sequence, producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint: "f".repeat(64),
    }) }), definition).disposition.reason, "attempt_catalog_mismatch");
    assert.equal(resolveNonGateTransition(facts({ lineage: new NonGateLineage({
      sourceAttempt: stale, canonicalAttempt: current, sourceFingerprint: "f".repeat(64), canonicalFingerprint: "f".repeat(64),
    }) }), definition).disposition.reason, "source_attempt_lineage_mismatch");
    assert.equal(resolveNonGateTransition(facts({
      completion: new NonGateCompletionFacts({ partial: true }),
    }), definition).disposition.reason, "partial_completion");
    const pairedRevision = resolveNonGateTransition(facts({ lineage: new NonGateLineage({
      sourceAttempt: current,
      canonicalAttempt: current,
      sourceFingerprint: "a".repeat(64),
      canonicalFingerprint: "f".repeat(64),
      sourceRevisionFingerprint: "revision-9",
      canonicalRevisionFingerprint: "revision-9",
      repairAttempt: current,
      repairFingerprint: "b".repeat(64),
      repairRevisionFingerprint: "revision-9",
    }), sourcePublication: new NonGateSourcePublication({
      runId: "run-9", specId: "009-non-gate-transition", stepId: "fixture-step",
      attemptId: current.id, sequence: current.sequence, producerActivityId: "activity-9", artifactId: "fixture.source.9", fingerprint: "a".repeat(64),
    }), repairPublication: new NonGateRepairPublication({
      runId: "run-9", specId: "009-non-gate-transition", stepId: "fixture-step",
      attemptId: current.id, sequence: current.sequence, producerActivityId: "activity-9", artifactId: "fixture.repair.9", fingerprint: "b".repeat(64),
    }) }), definition);
    assert.equal(pairedRevision.disposition.operation, "keep-in-progress");
  });

  it("applies no effects for stale or partial evidence and keeps tooling outside semantic retry", () => {
    const stale = resolveNonGateTransition(facts({
      catalogPublication: new NonGateCatalogPublication({
        runId: "run-9", specId: "009-non-gate-transition", stepId: "fixture-step",
        attemptId: "old", sequence: 8, producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint: "f".repeat(64),
      }),
    }), definition);
    const partial = resolveNonGateTransition(facts({ completion: new NonGateCompletionFacts({ partial: true }) }), definition);
    for (const decision of [stale, partial]) {
      let effects = 0;
      applyNonGateTransitionDecision({
        setStepStatus() { effects += 1; }, incrementRetry() { effects += 1; }, failCurrentAttempt() { effects += 1; },
      }, decision);
      assert.equal(effects, 0);
    }
  });

  it("makes nonblocking and recovery facts available only to the Step Definition", () => {
    const nonblocking = resolveNonGateTransition(facts({
      nonblocking: true,
      stepFacts: new FixtureStepFacts({ state: "external" }),
    }), definition);
    assert.equal(nonblocking.disposition.operation, "record-and-proceed");
    const recovery = resolveNonGateTransition(facts({
      stepFacts: new FixtureStepFacts({ state: "recovered" }),
      recoveryEvidence: { kind: "repair", attempt: { id: "attempt-9", sequence: 9 }, fingerprint: "f".repeat(64) },
    }), definition);
    assert.equal(recovery.disposition.operation, "repair");
  });

  it("is deterministic after the same persisted fixture is reloaded, including Action identity", () => {
    const original = facts({
      completed: true,
      stepFacts: new FixtureStepFacts({ state: "passed" }),
    });
    const stored = JSON.parse(JSON.stringify(original.toJSON()));
    const first = resolveNonGateTransition(original, definition);
    const second = resolveNonGateTransition(reloaded(stored), definition);
    assert.deepEqual(second.toJSON(), first.toJSON());
    assert.deepEqual(projectNonGateTransitionDecision(second).toJSON(), projectNonGateTransitionDecision(first).toJSON());
  });

  it("binds Action identity to all persisted common and Step facts", () => {
    const base = resolveNonGateTransition(facts(), definition).plan.action.identity;
    const changed = [
      facts({ nonblocking: true }),
      facts({ retry: new NonGateRetryMetrics({ used: 1, maximum: 2 }) }),
      facts({ completion: new NonGateCompletionFacts({ completed: true }) }),
      facts({ stepFacts: new FixtureStepFacts({ state: "question" }) }),
    ];
    for (const changedFacts of changed) {
      const identity = resolveNonGateTransition(changedFacts, definition).plan.action.identity;
      assert.equal(base.matches(identity), false);
    }
  });

  it("binds Action identity to Definition reason and every typed Step action", () => {
    const definitionFor = ({ reason, summary }) => new NonGateStepDefinition({
      stepId: "fixture-step",
      factsType: FixtureStepFacts,
      select: () => new NonGateTransitionSelection({
        operation: "blocked",
        reason,
        actions: [new FixtureIssueLogAction({ summary })],
      }),
    });
    const input = facts({ stepFacts: new FixtureStepFacts({ state: "blocked" }) });
    const first = resolveNonGateTransition(input, definitionFor({ reason: "first", summary: "same" })).plan.action.identity;
    const changedReason = resolveNonGateTransition(input, definitionFor({ reason: "second", summary: "same" })).plan.action.identity;
    const changedAction = resolveNonGateTransition(input, definitionFor({ reason: "first", summary: "changed" })).plan.action.identity;
    assert.equal(first.matches(changedReason), false);
    assert.equal(first.matches(changedAction), false);
  });

  it("rejects a direct run/set command before any side effect when the current Action changed", () => {
    const selected = projectNonGateTransitionDecision(resolveNonGateTransition(facts({
      stepFacts: new FixtureStepFacts({ state: "pending" }),
    }), definition));
    let reads = 0;
    let workerStarts = 0;
    assert.throws(() => admitNonGateDirectCommand({
      selectedAction: selected,
      stepDefinition: definition,
      flowManager: flowManagerFor(facts()),
      specId: "009-non-gate-transition",
      readStepFacts() {
        reads += 1;
        return facts({ completed: true, stepFacts: new FixtureStepFacts({ state: "passed" }) });
      },
    }), /admission rejected/);
    assert.equal(reads, 1);
    assert.equal(workerStarts, 0);
    assert.throws(() => executeAdmittedNonGateCommand({
      selectedAction: selected, stepDefinition: definition, flowManager: flowManagerFor(facts()), specId: "009-non-gate-transition",
      readStepFacts: () => facts({ completed: true, stepFacts: new FixtureStepFacts({ state: "passed" }) }),
      execute() { workerStarts += 1; },
    }), /admission rejected/);
    assert.equal(workerStarts, 0);
    assert.throws(() => applyNonGateTransitionDecision({ applyStepUpdate() {} }, {}), /definition decision/);
  });

  it("admits only an unobserved current test-chain execute Action", () => {
    const stepId = "test-execute";
    const snapshot = {
      runId: "run-9", specId: "009-non-gate-transition", stepId, revision: "state-revision-9",
      attempt: { id: "attempt-9", sequence: 9 }, activities: [], catalog: [],
    };
    const manager = {
      readCanonicalTransitionSnapshot: () => snapshot,
      canonicalState: () => ({ nextAction: () => ({ nodeId: stepId, operation: "resume" }) }),
    };
    assert.equal(admitTestChainDirectExecution({ flowManager: manager, specId: snapshot.specId, stepId }).state, "execute");
    let workerStarts = 0;
    const published = {
      ...snapshot,
      activities: [{ id: "published", attemptId: "attempt-9", sequence: 9, nodeId: stepId }],
      catalog: [{ logicalKey: "test.execute", activityId: "published" }],
    };
    const blockedFacts = facts({
      stepId,
      producer: new NonGateProducerOwnership({ runId: "run-9", specId: snapshot.specId, activityId: "published", stepId, attempt: snapshot.attempt }),
      target: new NonGateTargetBinding({ runId: "run-9", specId: snapshot.specId, stepId, attempt: snapshot.attempt }),
      catalogPublication: new NonGateCatalogPublication({ runId: "run-9", specId: snapshot.specId, stepId, attemptId: "attempt-9", sequence: 9, producerActivityId: "published", artifactId: "result", fingerprint: "f".repeat(64) }),
      sourcePublication: new NonGateSourcePublication({ runId: "run-9", specId: snapshot.specId, stepId, attemptId: "attempt-9", sequence: 9, producerActivityId: "published", artifactId: "result", fingerprint: "f".repeat(64) }),
      completion: new NonGateCompletionFacts({ partial: true }),
      stepFacts: new TestExecuteStepFacts({ rawAvailable: false }),
    });
    assert.throws(() => admitTestChainDirectExecution({
      flowManager: { ...manager, readCanonicalTransitionSnapshot: () => published }, specId: snapshot.specId, stepId,
      readFacts: () => blockedFacts,
    }), /Definition-selected blocked/);
    assert.equal(workerStarts, 0);
  });

  it("rejects an unobserved failed Attempt before a worker starts when Definition selected blocked", () => {
    const stepId = "test-execute";
    const snapshot = {
      runId: "run-10", specId: "010-non-gate-blocked", stepId, revision: "state-revision-10",
      state: {
        schemaRevision: 3, runId: "run-10", specId: "010-non-gate-blocked", current: [stepId],
        attempt: {
          id: "attempt-10", sequence: 10,
          failure: { category: "semantic", code: "TEST_EXECUTE_REJECTED" },
        },
      },
      attempt: { id: "attempt-10", sequence: 10 }, activities: [], catalog: [],
    };
    const manager = {
      canonicalState: () => ({ nextAction: () => ({ nodeId: stepId, operation: "blocked" }) }),
      readCanonicalTransitionSnapshot: () => snapshot,
    };
    let workerStarts = 0;
    assert.throws(() => {
      admitTestChainDirectExecution({ flowManager: manager, specId: snapshot.specId, stepId });
      workerStarts += 1;
    }, /Definition-selected blocked/);
    assert.equal(workerStarts, 0);
  });

  it("keeps legacy route fields and route construction out of non-Gate producers and consumers", () => {
    const sources = [
      "../../../src/flow/lib/run-test-execute.js",
      "../../../src/flow/lib/run-test-result-review.js",
      "../../../src/flow/lib/run-review.js",
      "../../../src/flow/commands/review.js",
      "../../../src/flow/lib/canonical-review-artifacts.js",
      "../../../src/flow/lib/run-acceptance-review.js",
      "../../../src/flow/lib/run-final-regression.js",
      "../../../src/flow/lib/canonical-acceptance-artifacts.js",
      "../../../src/flow/registry.js",
    ].map((relative) => ({ relative, source: readFileSync(new URL(relative, import.meta.url), "utf8") }));
    for (const { relative, source } of sources) {
      assert.doesNotMatch(source, /\bnext\s*:/, "non-Gate producer/registry must not emit a legacy next route");
      assert.doesNotMatch(source, /\bnextAction\s*:/, "non-Gate producer/registry must not emit a legacy nextAction route");
      assert.doesNotMatch(source, /(?:artifact|result)\?*\.(?:next|nextAction)\b/, "non-Gate consumer must not read a legacy route field");
    }
    const nextAction = readFileSync(new URL("../../../src/flow/lib/get-next-action.js", import.meta.url), "utf8");
    assert.doesNotMatch(nextAction, /(?:artifact|result)\?*\.(?:next|nextAction)\b/, "get-next-action may render directives but cannot consume producer route fields");
    assert.match(nextAction, /resolveCanonicalFinalRegressionTransition/, "get-next-action must project final-regression from canonical Definition facts");
    assert.match(nextAction, /selectedNonGateUserAction/, "get-next-action must project Definition-selected user Actions rather than invent them");

    const registry = sources.find(({ relative }) => relative.endsWith("registry.js")).source;
    assert.match(registry, /resolveCanonicalFinalRegressionTransition/, "registry must re-read final-regression Definition facts before applying a plan");
    assert.match(registry, /applyFinalRegressionTransition/, "registry must apply the sealed final-regression plan");
    const finalRunner = sources.find(({ relative }) => relative.endsWith("run-final-regression.js")).source;
    assert.match(finalRunner, /selectedNonGateUserAction/, "direct final-regression admission must require the selected typed user Action");
  });

  it("rejects actual test-chain commands before their worker/process boundary", async () => {
    const attempts = [];
    for (const [stepId, Command, command] of [
      ["test-execute", RunTestExecuteCommand, new RunTestExecuteCommand()],
      ["test-result-review", RunTestResultReviewCommand, new RunTestResultReviewCommand()],
    ]) {
      const snapshot = {
        runId: "run-9", specId: "009-non-gate-transition", stepId, revision: "state-revision-9",
        attempt: { id: "attempt-9", sequence: 9 },
        activities: [{ id: "published", attemptId: "attempt-9", sequence: 9, nodeId: stepId }],
        catalog: [{ logicalKey: stepId === "test-execute" ? "test.execute" : "test.result.review", activityId: "published" }],
      };
      const flowManager = {
        readCanonicalTransitionSnapshot: () => snapshot,
        canonicalState: () => ({ nextAction: () => ({ nodeId: stepId, operation: "resume" }) }),
      };
      await assert.rejects(
        command.execute({ flowState: { schemaRevision: 3, specId: snapshot.specId }, flowManager, root: process.cwd() }),
        /test-chain direct admission rejected/,
      );
    }
    assert.deepEqual(attempts, []);
  });

  it("rejects malformed test-chain post artifacts before any publication or Activity settlement", async () => {
    let publications = 0;
    let settlements = 0;
    const ctx = {
      specId: "009-non-gate-transition",
      flowState: { specId: "009-non-gate-transition" },
      flowManager: {
        publishCurrentAttemptResult() { publications += 1; },
        applyTestChainTransitionDecision() { settlements += 1; },
      },
    };
    const fingerprint = "a".repeat(64);
    const malformed = [
      ["test-execute", attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, {
        logicalKey: "test.execute",
        payload: {
          version: "2", repairFingerprint: "x", testSourceRevision: fingerprint, rawEvidenceFingerprint: fingerprint,
          process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
          raw_output_path: "steps/test-execute/output.log", summary: [],
          regression: { required: false, result: "skipped", mode: "none", category: "docs-only", reason: "fixture", classified_paths: [], changed_files: [], trigger_relevant_changed_files: [] },
        },
      })],
      ["test-result-review", attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, {
        logicalKey: "test.result.review",
        payload: {
          verdict: "pass", checked_items: [{ check: "project_regression_verification", result: "pass", detail: "fixture" }],
          result_file_path: "steps/test-execute/result.json", raw_output_path: "steps/test-execute/output.log",
          repairFingerprint: "x", testSourceRevision: fingerprint, rawEvidenceFingerprint: fingerprint,
          testExecute: { historyAttempt: 1, producerActivityId: "execute-activity", attemptId: "execute-attempt", sequence: 1 },
        },
      })],
    ];
    for (const [stepId, result] of malformed) {
      await assert.rejects(
        async () => FLOW_COMMANDS.run[stepId].post(ctx, result),
        /schema validation failed/,
      );
    }
    assert.equal(publications, 0);
    assert.equal(settlements, 0);
  });

  it("rejects contradictory scenario and review observations before publication or settlement", async () => {
    let publications = 0;
    let settlements = 0;
    const ctx = {
      specId: "009-non-gate-transition",
      flowState: { specId: "009-non-gate-transition" },
      flowManager: {
        publishCurrentAttemptResult() { publications += 1; },
        applyTestChainTransitionDecision() { settlements += 1; },
      },
    };
    const fingerprint = "a".repeat(64);
    const review = ({ verdict, result }) => attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, {
      logicalKey: "test.result.review",
      payload: {
        verdict, checked_items: [{ check: "summary_evidence", result, detail: "fixture" }],
        result_file_path: "steps/test-execute/result.json", raw_output_path: "steps/test-execute/output.log",
        repairFingerprint: fingerprint, testSourceRevision: fingerprint, rawEvidenceFingerprint: fingerprint,
        testExecute: { historyAttempt: 1, producerActivityId: "execute-activity", attemptId: "execute-attempt", sequence: 1 },
      },
    });
    for (const [stepId, result] of [
      ["test-result-review", review({ verdict: "pass", result: "fail" })],
      ["test-result-review", review({ verdict: "fail", result: "pass" })],
    ]) {
      await assert.rejects(
        async () => FLOW_COMMANDS.run[stepId].post(ctx, result),
        /observed summary|checked observations/,
      );
    }
    assert.equal(publications, 0);
    assert.equal(settlements, 0);
  });

  it("derives an external test-execute block from a cataloged tooling observation", () => {
    const testSource = finalizedTestSourceSnapshotEntries();
    const payload = {
      repairFingerprint: "a".repeat(64), testSourceRevision: finalizedTestSourceDigest, summary: [],
      rawEvidenceFingerprint: createHash("sha256").update("tooling output").digest("hex"),
      process: { started: true, exitCode: 0, spawnError: null, signal: null, timedOut: false },
      regression: { process: { started: true, exitCode: null, spawnError: null, signal: "SIGTERM", timedOut: true } },
    };
    const snapshot = {
      runId: "run-9", specId: "009-non-gate-transition", stepId: "test-execute", revision: "revision-9",
      state: { schemaRevision: 3, runId: "run-9", specId: "009-non-gate-transition", policy: { nonblocking: null } },
      attempt: { id: "attempt-9", sequence: 9, consumption: { semantic: 0, tooling: 0 } },
      activities: [{ id: "published", attemptId: "attempt-9", sequence: 9, nodeId: "test-execute" }, testSource.activity],
      catalog: [{ logicalKey: "test.execute", relativePath: "steps/test-execute/result.json", hash: "f".repeat(64), activityId: "published" }, testSource.descriptor],
    };
    const manager = {
      readCanonicalTransitionSnapshot: () => snapshot,
      readActiveProducerArtifact: () => ({
        bytes: Buffer.from(JSON.stringify({ attempts: [{ attempt: 9, artifact: { logicalKey: "test.execute", payload } }] })),
      }),
      readRuntimeArtifact: () => ({ bytes: Buffer.from("tooling output") }),
    };
    const observed = readCurrentTestChainTransitionFacts({ flowManager: manager, specId: snapshot.specId });
    const decision = resolveNonGateTransition(observed, testExecuteTransitionDefinition);
    assert.equal(decision.disposition.operation, "external-blocked");
    const effects = [];
    applyNonGateTransitionDecision({
      setStepStatus() {}, incrementRetry() { effects.push("semantic-retry"); },
      failCurrentAttempt(action) { effects.push(action.category); },
    }, decision);
    assert.deepEqual(effects, ["tooling"]);
  });

  it("binds test-chain Decisions to immutable evidence and reloads them deterministically", () => {
    const input = facts({
      stepId: "test-execute",
      producer: new NonGateProducerOwnership({ runId: "run-9", specId: "009-non-gate-transition", activityId: "activity-9", stepId: "test-execute", attempt: { id: "attempt-9", sequence: 9 } }),
      target: new NonGateTargetBinding({ runId: "run-9", specId: "009-non-gate-transition", stepId: "test-execute", attempt: { id: "attempt-9", sequence: 9 } }),
      catalogPublication: new NonGateCatalogPublication({ runId: "run-9", specId: "009-non-gate-transition", stepId: "test-execute", attemptId: "attempt-9", sequence: 9, producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint: "f".repeat(64) }),
      sourcePublication: new NonGateSourcePublication({ runId: "run-9", specId: "009-non-gate-transition", stepId: "test-execute", attemptId: "attempt-9", sequence: 9, producerActivityId: "activity-9", artifactId: "fixture.result.9", fingerprint: "f".repeat(64) }),
      completion: new NonGateCompletionFacts({ completed: true }),
      stepFacts: new TestExecuteStepFacts({ repairFingerprint: "a".repeat(64), catalogDigest: "catalog-a" }),
    });
    const first = resolveNonGateTransition(input, testExecuteTransitionDefinition);
    const reloaded = NonGateTransitionFacts.fromPersisted(JSON.parse(JSON.stringify(input.toJSON())), {
      stepFacts: (stored) => new TestExecuteStepFacts(stored.values),
    });
    assert.deepEqual(resolveNonGateTransition(reloaded, testExecuteTransitionDefinition).toJSON(), first.toJSON());
    const changed = resolveNonGateTransition(facts({ ...input.toJSON(), stepFacts: new TestExecuteStepFacts({ repairFingerprint: "a".repeat(64), catalogDigest: "catalog-b" }) }), testExecuteTransitionDefinition);
    assert.equal(first.plan.action.identity.matches(changed.plan.action.identity), false);
  });

  it("counts the observed Attempt against retry budget and settles exhaustion without another semantic retry", () => {
    const input = facts({
      stepId: "test-result-review",
      producer: new NonGateProducerOwnership({ runId: "run-9", specId: "009-non-gate-transition", activityId: "activity-9", stepId: "test-result-review", attempt: { id: "attempt-3", sequence: 3 } }),
      target: new NonGateTargetBinding({ runId: "run-9", specId: "009-non-gate-transition", stepId: "test-result-review", attempt: { id: "attempt-3", sequence: 3 } }),
      currentAttempt: new NonGateAttemptIdentity({ id: "attempt-3", sequence: 3 }),
      catalogPublication: new NonGateCatalogPublication({ runId: "run-9", specId: "009-non-gate-transition", stepId: "test-result-review", attemptId: "attempt-3", sequence: 3, producerActivityId: "activity-9", artifactId: "fixture.result.3", fingerprint: "f".repeat(64) }),
      sourcePublication: new NonGateSourcePublication({ runId: "run-9", specId: "009-non-gate-transition", stepId: "test-result-review", attemptId: "attempt-3", sequence: 3, producerActivityId: "activity-9", artifactId: "fixture.result.3", fingerprint: "f".repeat(64) }),
      lineage: new NonGateLineage({ sourceAttempt: { id: "attempt-3", sequence: 3 }, canonicalAttempt: { id: "attempt-3", sequence: 3 }, sourceFingerprint: "f".repeat(64), canonicalFingerprint: "f".repeat(64) }),
      retry: new NonGateRetryMetrics({ used: 3, maximum: 3 }),
      completion: new NonGateCompletionFacts({ completed: true }),
      stepFacts: new TestResultReviewStepFacts({ verdict: "fail", rawAvailable: true, checkedItems: [{ result: "fail" }] }),
    });
    const decision = resolveNonGateTransition(input, testResultReviewTransitionDefinition);
    assert.equal(decision.disposition.operation, "blocked");
    assert.equal(decision.disposition.reason, "retry_exhausted");
    const failure = decision.plan.actions.find((action) => action.toJSON().action === "fail-current-attempt");
    assert.deepEqual(failure.toJSON(), {
      action: "fail-current-attempt", category: "semantic", code: "TEST_CHAIN_RETRY_EXHAUSTED",
      retryable: false, retryKind: null, message: "Test-chain semantic retry budget is exhausted.",
    });
    const effects = [];
    applyNonGateTransitionDecision({
      setStepStatus() { effects.push("status"); },
      incrementRetry() { effects.push("semantic-retry"); },
      failCurrentAttempt(action) { effects.push(action.retryable); },
    }, decision);
    assert.deepEqual(effects, ["status", false]);
  });

  it("treats missing raw output as partial facts with an empty blocked plan", () => {
    const testSource = finalizedTestSourceSnapshotEntries();
    const payload = { repairFingerprint: "a".repeat(64), testSourceRevision: finalizedTestSourceDigest,
      rawEvidenceFingerprint: createHash("sha256").update("").digest("hex"),
      process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null }, summary: [], regression: {} };
    const snapshot = {
      runId: "run-9", specId: "009-non-gate-transition", stepId: "test-execute", revision: "revision-9",
      state: { schemaRevision: 3, runId: "run-9", specId: "009-non-gate-transition", policy: { nonblocking: null } },
      attempt: { id: "attempt-1", sequence: 1, consumption: { semantic: 0, tooling: 0 } },
      activities: [{ id: "published", attemptId: "attempt-1", sequence: 1, nodeId: "test-execute" }, testSource.activity],
      catalog: [{ logicalKey: "test.execute", relativePath: "steps/test-execute/result.json", hash: "f".repeat(64), activityId: "published" }, testSource.descriptor],
    };
    const manager = {
      readCanonicalTransitionSnapshot: () => snapshot,
      readActiveProducerArtifact: () => ({ bytes: Buffer.from(JSON.stringify({ attempts: [{ attempt: 1, artifact: { logicalKey: "test.execute", payload } }] })) }),
      readRuntimeArtifact: () => null,
    };
    const observed = readCurrentTestChainTransitionFacts({ flowManager: manager, specId: snapshot.specId });
    assert.equal(observed.completion.partial, true);
    const decision = resolveNonGateTransition(observed, testExecuteTransitionDefinition);
    assert.equal(decision.disposition.reason, "partial_completion");
    assert.deepEqual(decision.plan.actions, []);
    let effects = 0;
    applyNonGateTransitionDecision({
      setStepStatus() { effects += 1; }, incrementRetry() { effects += 1; }, failCurrentAttempt() { effects += 1; },
    }, decision);
    assert.equal(effects, 0);
  });

  it("maps stale review lineage evidence to Definition blocked plans without side effects", () => {
    const testSource = finalizedTestSourceSnapshotEntries();
    const raw = Buffer.from("test execution raw evidence");
    const executionPayload = {
      repairFingerprint: "b".repeat(64), testSourceRevision: finalizedTestSourceDigest,
      rawEvidenceFingerprint: createHash("sha256").update(raw).digest("hex"),
      process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null }, summary: [], regression: {},
    };
    const reviewPayload = {
      verdict: "pass", checked_items: [{ check: "summary_evidence", result: "pass", detail: "fixture" }], repairFingerprint: "b".repeat(64), testSourceRevision: finalizedTestSourceDigest,
      testExecute: { historyAttempt: 1, producerActivityId: "execution", attemptId: "execute-attempt", sequence: 1 },
      rawEvidenceFingerprint: createHash("sha256").update(raw).digest("hex"),
    };
    const snapshot = {
      runId: "run-9", specId: "009-non-gate-transition", stepId: "test-result-review", revision: "revision-9",
      state: { schemaRevision: 3, runId: "run-9", specId: "009-non-gate-transition", policy: { nonblocking: null } },
      attempt: { id: "review-attempt", sequence: 1, consumption: { semantic: 0, tooling: 0 } },
      activities: [
        { id: "review", attemptId: "review-attempt", sequence: 1, nodeId: "test-result-review" },
        { id: "execution", attemptId: "execute-attempt", sequence: 1, nodeId: "test-execute" },
        testSource.activity,
      ],
      catalog: [
        { logicalKey: "test.result.review", relativePath: "steps/test-result-review/result.json", hash: "f".repeat(64), activityId: "review" },
        { logicalKey: "test.execute", relativePath: "steps/test-execute/result.json", hash: "e".repeat(64), activityId: "execution" },
        testSource.descriptor,
      ],
    };
    const history = (logicalKey, payload) => ({ bytes: Buffer.from(JSON.stringify({ attempts: [{ attempt: 1, artifact: { logicalKey, payload } }] })) });
    const manager = {
      readCanonicalTransitionSnapshot: () => snapshot,
      readActiveProducerArtifact: () => history("test.result.review", reviewPayload),
      readArtifact: () => ({ ...history("test.execute", executionPayload), descriptor: snapshot.catalog[1] }),
      readRuntimeArtifact: () => ({ bytes: raw }),
    };
    assert.equal(readCurrentTestChainTransitionFacts({ flowManager: manager, specId: snapshot.specId }).stepFacts.verdict, "pass");
    const contradictory = readCurrentTestChainTransitionFacts({
      flowManager: {
        ...manager,
        readActiveProducerArtifact: () => history("test.result.review", {
          ...reviewPayload,
          checked_items: [{ check: "summary_evidence", result: "fail", detail: "contradiction" }],
        }),
      },
      specId: snapshot.specId,
    });
    const contradictoryDecision = resolveNonGateTransition(contradictory, testResultReviewTransitionDefinition);
    assert.equal(contradictoryDecision.disposition.operation, "blocked");
    assert.equal(contradictoryDecision.disposition.reason, "test_result_review_observation_contradiction");
    assert.deepEqual(contradictoryDecision.plan.actions, []);
    const staleCases = [
      ["review_execute_attempt_mismatch", {
        ...manager,
        readActiveProducerArtifact: () => history("test.result.review", {
          ...reviewPayload,
          testExecute: { ...reviewPayload.testExecute, attemptId: "other" },
        }),
      }],
      ["review_execute_raw_fingerprint_mismatch", {
        ...manager,
        readActiveProducerArtifact: () => history("test.result.review", {
          ...reviewPayload,
          rawEvidenceFingerprint: "c".repeat(64),
        }),
      }],
      ["stale_execute_raw_fingerprint", {
        ...manager,
        readRuntimeArtifact: () => ({ bytes: Buffer.from("replacement raw evidence") }),
      }],
      ["stale_test_source_revision", {
        ...manager,
        readArtifact: () => ({
          ...history("test.execute", { ...executionPayload, testSourceRevision: "d".repeat(64) }),
          descriptor: snapshot.catalog[1],
        }),
      }],
    ];
    for (const [integrityFailure, staleManager] of staleCases) {
      const observed = readCurrentTestChainTransitionFacts({ flowManager: staleManager, specId: snapshot.specId });
      assert.equal(observed.integrityFailure, integrityFailure);
      const decision = resolveNonGateTransition(observed, testResultReviewTransitionDefinition);
      assert.equal(decision.disposition.operation, "blocked");
      assert.equal(decision.disposition.reason, integrityFailure);
      assert.deepEqual(decision.plan.actions, []);
      let effects = 0;
      applyNonGateTransitionDecision({
        setStepStatus() { effects += 1; }, incrementRetry() { effects += 1; }, failCurrentAttempt() { effects += 1; },
      }, decision);
      assert.equal(effects, 0);
    }
  });

  it("projects the same blocked Action after reload so next-action cannot reopen a partial producer", () => {
    const source = facts({ completion: new NonGateCompletionFacts({ partial: true }) });
    const first = resolveNonGateNextAction({
      flowManager: flowManagerFor(source), specId: source.specId, readStepFacts: () => source, stepDefinition: definition,
    });
    const restored = reloaded(JSON.parse(JSON.stringify(source.toJSON())));
    const second = resolveNonGateNextAction({
      flowManager: flowManagerFor(restored), specId: restored.specId, readStepFacts: () => restored, stepDefinition: definition,
    });
    assert.equal(first.action.operation, "blocked");
    assert.equal(first.action.reason, "partial_completion");
    assert.deepEqual(second.action.toJSON(), first.action.toJSON());
  });

  it("applies only the typed actions contained in the Definition plan", () => {
    const decision = resolveNonGateTransition(facts({
      stepFacts: new FixtureStepFacts({ state: "retryable" }),
    }), definition);
    const applied = [];
    applyNonGateTransitionDecision({
      setStepStatus(update, plan) { applied.push(["set-step-status", update.status, plan.action.identity.operation]); },
      incrementRetry(stepId, plan) { applied.push(["increment-retry", stepId, plan.action.identity.operation]); },
    }, decision);
    assert.deepEqual(applied, [
      ["set-step-status", "in_progress", "retry"],
      ["increment-retry", "fixture-step", "retry"],
    ]);
    assert.throws(() => applyNonGateTransitionDecision({ applyEffect() {} }, { plan: decision.plan }), /definition decision/);

    const repair = resolveNonGateTransition(facts({
      stepFacts: new FixtureStepFacts({ state: "repairable" }),
    }), definition);
    applyNonGateTransitionDecision({
      setStepStatus() {},
      appendIssueLog(summary) { applied.push(["append-issue-log", summary, repair.plan.action.identity.operation]); },
    }, repair);
    assert.deepEqual(applied.at(-1), ["append-issue-log", "repair selected", "repair"]);
  });

  it("validates source and repair publications against their own persisted Activity and catalog entries", () => {
    const current = new NonGateAttemptIdentity({ id: "attempt-9", sequence: 9 });
    const upstream = new NonGateAttemptIdentity({ id: "attempt-4", sequence: 4 });
    const repair = new NonGateAttemptIdentity({ id: "attempt-6", sequence: 6 });
    const source = facts({
      currentAttempt: current,
      sourcePublication: new NonGateSourcePublication({
        runId: "run-9", specId: "009-non-gate-transition", stepId: "test-execute",
        attemptId: upstream.id, sequence: upstream.sequence, producerActivityId: "activity-source",
        artifactId: "test.execute.json", fingerprint: "a".repeat(64),
      }),
      repairPublication: new NonGateRepairPublication({
        runId: "run-9", specId: "009-non-gate-transition", stepId: "test-repair",
        attemptId: repair.id, sequence: repair.sequence, producerActivityId: "activity-repair",
        artifactId: "test.repair.json", fingerprint: "b".repeat(64),
      }),
      lineage: new NonGateLineage({
        sourceAttempt: upstream,
        canonicalAttempt: current,
        sourceFingerprint: "a".repeat(64),
        canonicalFingerprint: "f".repeat(64),
        sourceRevisionFingerprint: "revision-9",
        canonicalRevisionFingerprint: "revision-9",
        repairAttempt: repair,
        repairFingerprint: "b".repeat(64),
        repairRevisionFingerprint: "revision-9",
      }),
    });
    const snapshot = {
      runId: source.runId, specId: source.specId, stepId: source.stepId, revision: source.snapshotRevision,
      state: Object.freeze({ runId: source.runId, specId: source.specId }),
      attempt: { id: current.id, sequence: current.sequence },
      activities: [
        { id: "activity-9", attemptId: current.id, sequence: current.sequence, nodeId: "fixture-step" },
        { id: "activity-source", attemptId: upstream.id, sequence: upstream.sequence, nodeId: "test-execute" },
        { id: "activity-repair", attemptId: repair.id, sequence: repair.sequence, nodeId: "test-repair" },
      ],
      catalog: [
        { relativePath: "fixture.result.9", hash: "f".repeat(64), activityId: "activity-9" },
        { relativePath: "test.execute.json", hash: "a".repeat(64), activityId: "activity-source" },
        { relativePath: "test.repair.json", hash: "b".repeat(64), activityId: "activity-repair" },
      ],
    };
    const manager = { readCanonicalTransitionSnapshot: () => Object.freeze(snapshot) };
    assert.equal(readCurrentNonGateTransitionFacts({
      flowManager: manager, specId: source.specId, readFacts: () => source,
    }), source);
    const withoutSource = {
      ...snapshot,
      catalog: snapshot.catalog.filter((entry) => entry.relativePath !== "test.execute.json"),
    };
    assert.throws(() => readCurrentNonGateTransitionFacts({
      flowManager: { readCanonicalTransitionSnapshot: () => Object.freeze(withoutSource) },
      specId: source.specId,
      readFacts: () => source,
    }), /source publication does not match/);
    const wrongRepairActivity = {
      ...snapshot,
      activities: snapshot.activities.map((entry) => entry.id === "activity-repair"
        ? { ...entry, attemptId: "wrong-attempt" }
        : entry),
    };
    assert.throws(() => readCurrentNonGateTransitionFacts({
      flowManager: { readCanonicalTransitionSnapshot: () => Object.freeze(wrongRepairActivity) },
      specId: source.specId,
      readFacts: () => source,
    }), /repair publication is not owned/);
  });

  it("uses a freshly reloaded canonical snapshot before Step facts reach Definition", () => {
    const source = facts();
    const flowManager = flowManagerFor(source);
    const read = readCurrentNonGateTransitionFacts({ flowManager, specId: source.specId, readFacts: () => source });
    const projected = resolveNonGateNextAction({
      flowManager, specId: source.specId, readStepFacts: () => read, stepDefinition: definition,
    });
    assert.equal(projected.action.operation, "keep-in-progress");
    assert.throws(() => readCurrentNonGateTransitionFacts({
      flowManager,
      specId: source.specId,
      readFacts: () => facts({ currentAttempt: new NonGateAttemptIdentity({ id: "old-attempt", sequence: 8 }) }),
    }), /stale Attempt/);
  });
});
