import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildCurrentFlowDefinition } from "../../../src/flow/definition.js";
import {
  ActivityTransition,
  CurrentAttempt,
  CurrentFlowState,
  CurrentFlowStateInvariantError,
  CurrentFlowStateStore,
  FlowActivity,
} from "../../../src/flow/lib/current-flow-state.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const NOW = "2026-08-07T00:00:00.000Z";
const LATER = "2026-08-07T00:02:00.000Z";

function result(summary) {
  return { outcome: "passed", summary, confirmedAt: LATER, artifactRefs: [{ kind: "artifact", id: `${summary}-artifact` }] };
}

function skippedResult(summary) {
  return { outcome: "skipped", summary, confirmedAt: LATER, artifactRefs: [] };
}

function attemptFor(state, currentPath, id, sequence = null, tooling = 0) {
  const contract = state.definition.contractFor(currentPath.at(-1), state.root);
  const leaf = state.findNode(currentPath.at(-1));
  const nextSequence = sequence ?? leaf.attemptSequence + 1;
  const previous = state.current?.at(-1) === leaf.id ? state.attempt : null;
  return new CurrentAttempt({
    id,
    nodeId: currentPath.at(-1),
    sequence: nextSequence,
    startedAt: NOW,
    consumption: {
      semantic: previous === null ? 0 : previous.consumption.semantic + (tooling === previous.consumption.tooling ? 1 : 0),
      tooling,
    },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: [{ operation: "execute", resources: [...contract.resourceContract.required] }],
  });
}

function activity({
  id,
  state,
  currentPath,
  task = null,
  activityAttempt = null,
  order,
  operation,
  status = null,
  activityResult = null,
  failure = null,
  gateTaskLifecycle = null,
}) {
  const node = state.findNode(currentPath.at(-1));
  const effectiveAttempt = operation === "retry_attempt" ? state.attempt : activityAttempt ?? state.attempt;
  const type = {
    add_task: "task_added",
    start_attempt: "attempt_started",
    retry_attempt: "attempt_retried",
    update_attempt: "attempt_updated",
    fail_attempt: "attempt_failed",
    record_failure: "failure_recorded",
    confirm_attempt: "result_confirmed",
    rewind: "recovery",
    recover_attempt: "recovery",
  }[operation];
  return new FlowActivity({
    id,
    nodeId: node.id,
    nodeKey: node.key,
    attemptId: effectiveAttempt?.id ?? null,
    sequence: effectiveAttempt?.sequence ?? null,
    confirmationOrder: order,
    type,
    transition: new ActivityTransition({
      operation,
      nodeId: node.id,
      task,
      attempt: activityAttempt,
      status,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
      gateTaskLifecycle,
    }),
    result: activityResult,
    timing: null,
    failure,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    references: {
      evaluations: [],
      findings: [],
      repairs: [],
      artifacts: [{ id: `${id}-artifact`, label: null }],
    },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

describe("Current Flow state filesystem lifecycle", () => {
  let tmp = null;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("persists production skip policy, flow/task order, retry, recovery, and append-only Activity facts across reload", () => {
    tmp = createTmpDir("current-flow-cli-");
    const definition = buildCurrentFlowDefinition();
    const directory = path.join(tmp, "specs", "900-current-state");
    let state = CurrentFlowState.create({ definition, execution: { mode: "branch" } });
    const store = new CurrentFlowStateStore({ directory, definition });
    state = store.create(state);
    let order = 2;

    const apply = (entry) => {
      state = new CurrentFlowStateStore({ directory, definition }).apply({ activity: entry });
      state = new CurrentFlowStateStore({ directory, definition }).load();
      order += 1;
    };
    const completeDescriptor = (label, { status = "done", activityResult = null, gateTaskLifecycle = null } = {}) => {
      const descriptor = state.nextAction();
      assert.equal(descriptor.operation, "start", `expected normal start for ${descriptor.nodeId}`);
      const currentPath = descriptor.path;
      apply(activity({
        id: `${label}-start`,
        state,
        currentPath,
        activityAttempt: attemptFor(state, currentPath, `${label}-attempt`),
        order,
        operation: "start_attempt",
      }));
      apply(activity({
        id: `${label}-confirm`,
        state,
        currentPath,
        order,
        operation: "confirm_attempt",
        status,
        activityResult: activityResult ?? (status === "skipped" ? skippedResult(label) : result(label)),
        gateTaskLifecycle,
      }));
    };
    const recoverDescriptor = (label, { status = "skipped" } = {}) => {
      const descriptor = state.nextAction();
      assert.equal(descriptor.operation, "recover", `expected recovery for ${descriptor.nodeId}`);
      const currentPath = descriptor.path;
      apply(activity({
        id: `${label}-recover`,
        state,
        currentPath,
        activityAttempt: attemptFor(state, currentPath, `${label}-attempt`),
        order,
        operation: "recover_attempt",
      }));
      apply(activity({
        id: `${label}-confirm`,
        state,
        currentPath,
        order,
        operation: "confirm_attempt",
        status,
        activityResult: status === "skipped" ? skippedResult(label) : result(label),
      }));
    };
    const advanceUntil = (nodeId, label) => {
      let count = 0;
      while (state.nextAction()?.nodeId !== nodeId) {
        completeDescriptor(`${label}-${count}`);
        count += 1;
        if (count > 100) throw new Error("production Flow order did not converge");
      }
    };

    const implPath = ["flow", "impl"];
    apply(activity({
      id: "task-a-added",
      state,
      currentPath: implPath,
      task: { id: "task-a", key: "first" },
      order,
      operation: "add_task",
    }));
    apply(activity({
      id: "task-b-added",
      state,
      currentPath: implPath,
      task: { id: "task-b", key: "second" },
      order,
      operation: "add_task",
    }));
    assert.deepEqual(state.findNode("impl").steps.slice(0, 5).map((node) => node.id), [
      "implement", "task-a", "task-b", "test-execute", "test-result-review",
    ]);

    assert.equal(state.nextAction().nodeId, "branch");
    completeDescriptor("branch-skipped", {
      status: "skipped",
      activityResult: skippedResult("No branch is required."),
    });
    assert.equal(state.findNode("branch").status, "skipped");
    assert.equal(state.findNode("branch").result.outcome, "skipped");

    assert.equal(state.nextAction().nodeId, "prepare-spec");
    const prepareSpecPath = state.nextAction().path;
    apply(activity({
      id: "prepare-spec-start",
      state,
      currentPath: prepareSpecPath,
      activityAttempt: attemptFor(state, prepareSpecPath, "prepare-spec-attempt"),
      order,
      operation: "start_attempt",
    }));
    const orderBeforeForbiddenSkip = order;
    const journalLengthBeforeForbiddenSkip = store.journal.read().length;
    assert.throws(
      () => new CurrentFlowStateStore({ directory, definition }).apply({ activity: activity({
        id: "prepare-spec-forbidden-skip",
        state,
        currentPath: prepareSpecPath,
        order,
        operation: "confirm_attempt",
        status: "skipped",
        activityResult: skippedResult("A required specification cannot be skipped."),
      }) }),
      (error) => error instanceof CurrentFlowStateInvariantError
        && /definition forbids transition in_progress:skipped for prepare-spec/.test(error.message),
    );
    assert.equal(order, orderBeforeForbiddenSkip);
    assert.equal(store.journal.read().length, journalLengthBeforeForbiddenSkip);
    assert.equal(new CurrentFlowStateStore({ directory, definition }).load().current.at(-1), "prepare-spec");
    apply(activity({
      id: "prepare-spec-confirm",
      state,
      currentPath: prepareSpecPath,
      order,
      operation: "confirm_attempt",
      status: "done",
      activityResult: result("prepare-spec"),
    }));

    advanceUntil("task-a-impl", "prelude");
    const taskAImpl = state.nextAction().path;
    completeDescriptor("task-a-impl");
    assert.equal(taskAImpl.at(-1), "task-a-impl");
    assert.equal(state.nextAction().nodeId, "task-a-review");
    const reviewPath = state.nextAction().path;
    apply(activity({
      id: "task-a-review-start",
      state,
      currentPath: reviewPath,
      activityAttempt: attemptFor(state, reviewPath, "review-1"),
      order,
      operation: "start_attempt",
    }));
    apply(activity({
      id: "task-a-review-failed",
      state,
      currentPath: reviewPath,
      order,
      operation: "fail_attempt",
      activityResult: {
        outcome: "failed",
        summary: "Review needs retry.",
        confirmedAt: LATER,
        artifactRefs: [],
      },
      failure: {
        category: "review",
        code: "review_failed",
        message: "Review needs retry.",
        retryable: true,
        retryKind: "semantic",
      },
    }));
    assert.equal(state.nextAction().operation, "retry");
    assert.equal(state.nextAction().failureDisposition.retryKind, "semantic");
    apply(activity({
      id: "task-a-review-retry",
      state,
      currentPath: reviewPath,
      activityAttempt: attemptFor(state, reviewPath, "review-2", 2),
      order,
      operation: "retry_attempt",
    }));
    apply(activity({
      id: "task-a-review-confirm",
      state,
      currentPath: reviewPath,
      order,
      operation: "confirm_attempt",
      status: "done",
      activityResult: result("task-a-review"),
    }));
    assert.equal(state.nextAction().nodeId, "task-a-triage");
    completeDescriptor("task-a-triage", { status: "skipped" });
    completeDescriptor("task-a-repair", { status: "skipped" });
    assert.equal(state.nextAction().nodeId, "task-a-gate");
    const gatePath = state.nextAction().path;
    completeDescriptor("task-a-gate", { gateTaskLifecycle: {
      operation: "complete-and-advance",
      taskId: "task-a",
      successorStepId: "task-b-impl",
      resetStepIds: [],
    } });
    assert.equal(state.findNode("task-a").status, "done");
    assert.equal(state.nextAction().nodeId, "task-b-impl");

    apply(activity({
      id: "task-a-review-rewind",
      state,
      currentPath: reviewPath,
      activityAttempt: attemptFor(state, reviewPath, "review-rewind"),
      order,
      operation: "rewind",
    }));
    assert.equal(state.current.at(-1), "task-a-review");
    assert.equal(state.attempt.sequence, 3);
    assert.equal(state.findNode("task-a-review").attemptSequence, 3);
    assert.equal(state.findNode("task-a-gate").status, "invalidated");
    assert.equal(state.findNode("task-b").status, "invalidated");
    apply(activity({
      id: "task-a-review-reconfirm",
      state,
      currentPath: reviewPath,
      order,
      operation: "confirm_attempt",
      status: "done",
      activityResult: result("task-a-review-reconfirmed"),
    }));
    assert.equal(state.nextAction().operation, "recover");
    assert.equal(state.nextAction().nodeId, "task-a-triage");
    assert.throws(
      () => new CurrentFlowStateStore({ directory, definition }).apply({ activity: activity({
        id: "illegal-gate-start",
        state,
        currentPath: gatePath,
        activityAttempt: attemptFor(state, gatePath, "illegal-gate"),
        order,
        operation: "start_attempt",
      }) }),
      (error) => error instanceof CurrentFlowStateInvariantError && /next executable leaf/.test(error.message),
    );
    recoverDescriptor("task-a-triage-recovery");
    recoverDescriptor("task-a-repair-recovery");
    assert.equal(state.nextAction().nodeId, "task-a-gate");
    apply(activity({
      id: "task-a-gate-recover",
      state,
      currentPath: gatePath,
      activityAttempt: attemptFor(state, gatePath, "gate-recovery"),
      order,
      operation: "recover_attempt",
    }));
    assert.equal(state.attempt.sequence, 2);
    assert.equal(state.findNode("task-a-gate").attemptSequence, 2);
    apply(activity({
      id: "task-a-gate-recovered",
      state,
      currentPath: gatePath,
      order,
      operation: "confirm_attempt",
      status: "done",
      activityResult: result("task-a-gate-recovered"),
      gateTaskLifecycle: {
        operation: "complete-and-advance",
        taskId: "task-a",
        successorStepId: "task-b-impl",
        resetStepIds: [],
      },
    }));
    assert.equal(state.nextAction().operation, "recover");
    assert.equal(state.nextAction().nodeId, "task-b-impl");

    const taskBImplPath = state.nextAction().path;
    apply(activity({
      id: "task-b-impl-recover",
      state,
      currentPath: taskBImplPath,
      activityAttempt: attemptFor(state, taskBImplPath, "task-b-impl-recovery"),
      order,
      operation: "recover_attempt",
    }));
    apply(activity({
      id: "task-b-impl-confirm",
      state,
      currentPath: taskBImplPath,
      order,
      operation: "confirm_attempt",
      status: "done",
      activityResult: {
        outcome: "passed",
        summary: "task-b-impl",
        confirmedAt: LATER,
        artifactRefs: [
          { kind: "task_spec", id: "task-b-spec" },
          { kind: "requirements", id: "task-b-requirements" },
          { kind: "source", id: "task-b-source" },
        ],
      },
    }));
    const taskBReviewAuthority = state.artifactAuthority();
    assert.ok(taskBReviewAuthority.resolutions.every((resolution) => (
      resolution.source?.nodeId === "task-b-impl"
    )));
    assert.equal(taskBReviewAuthority.resolutions.some((resolution) => (
      resolution.source?.path.includes("task-a")
    )), false);
    const taskBReviewPath = state.nextAction().path;
    apply(activity({
      id: "task-b-review-recover",
      state,
      currentPath: taskBReviewPath,
      activityAttempt: attemptFor(state, taskBReviewPath, "task-b-review-recovery"),
      order,
      operation: "recover_attempt",
    }));
    const failTaskBReview = (suffix, summary) => apply(activity({
      id: `task-b-review-fail-${suffix}`,
      state,
      currentPath: taskBReviewPath,
      order,
      operation: "fail_attempt",
      activityResult: {
        outcome: "failed",
        summary,
        confirmedAt: LATER,
        artifactRefs: [],
      },
      failure: {
        category: "review",
        code: `review_failed_${suffix}`,
        message: summary,
        retryable: true,
        retryKind: "semantic",
      },
    }));
    const retryTaskBReview = (sequence) => apply(activity({
      id: `task-b-review-retry-${sequence}`,
      state,
      currentPath: taskBReviewPath,
      activityAttempt: attemptFor(state, taskBReviewPath, `task-b-review-${sequence}`, sequence),
      order,
      operation: "retry_attempt",
    }));
    failTaskBReview("one", "Task B review failed once.");
    retryTaskBReview(2);
    failTaskBReview("two", "Task B review failed twice.");
    retryTaskBReview(3);
    failTaskBReview("three", "Task B review failed three times.");
    retryTaskBReview(4);
    const exhaustedResult = {
      outcome: "failed",
      summary: "Task B review exhausted its semantic retry budget.",
      confirmedAt: LATER,
      artifactRefs: [{ kind: "guardrail", id: "failed-review-guardrail" }],
    };
    apply(activity({
      id: "task-b-review-fail-exhausted",
      state,
      currentPath: taskBReviewPath,
      order,
      operation: "fail_attempt",
      activityResult: exhaustedResult,
      failure: {
        category: "review",
        code: "review_retry_exhausted",
        message: exhaustedResult.summary,
        retryable: true,
        retryKind: "semantic",
      },
    }));
    assert.equal(state.nextAction().operation, "record");
    assert.equal(state.retryEligibility().semantic, false);
    apply(activity({
      id: "task-b-review-record-exhaustion",
      state,
      currentPath: taskBReviewPath,
      order,
      operation: "record_failure",
      activityResult: exhaustedResult,
    }));
    assert.equal(state.findNode("task-b-review").status, "failed");
    assert.equal(state.nextAction().nodeId, "task-b-triage");
    recoverDescriptor("task-b-triage");
    recoverDescriptor("task-b-repair");
    assert.equal(state.nextAction().nodeId, "task-b-gate");
    const taskBGateAuthority = state.artifactAuthority();
    assert.equal(
      taskBGateAuthority.resolutions.find((resolution) => resolution.resourceKind === "guardrail").missing,
      true,
    );
    assert.equal(taskBGateAuthority.resolutions.some((resolution) => (
      resolution.source?.nodeId === "task-b-review"
    )), false);
    const taskBGatePath = state.nextAction().path;
    apply(activity({
      id: "task-b-gate-recover",
      state,
      currentPath: taskBGatePath,
      activityAttempt: attemptFor(state, taskBGatePath, "task-b-gate-recovery"),
      order,
      operation: "recover_attempt",
    }));
    apply(activity({
      id: "task-b-gate-confirm",
      state,
      currentPath: taskBGatePath,
      order,
      operation: "confirm_attempt",
      status: "done",
      activityResult: result("task-b-gate"),
      gateTaskLifecycle: {
        operation: "complete-and-advance",
        taskId: "task-b",
        successorStepId: "test-execute",
        resetStepIds: [],
      },
    }));
    assert.equal(state.nextAction().nodeId, "test-execute");

    const journal = store.journal.read();
    assert.equal(journal.length, order - 1);
    assert.deepEqual(journal.map((entry) => entry.confirmationOrder), Array.from({ length: journal.length }, (_, index) => index + 1));
    assert.deepEqual(
      journal.filter((entry) => entry.attemptId === "review-1").map((entry) => [entry.sequence, entry.confirmationOrder]),
      [[1, journal.find((entry) => entry.id === "task-a-review-start").confirmationOrder], [1, journal.find((entry) => entry.id === "task-a-review-failed").confirmationOrder], [1, journal.find((entry) => entry.id === "task-a-review-retry").confirmationOrder]],
    );
    assert.equal(journal.find((entry) => entry.id === "task-a-review-failed").failure.code, "review_failed");
    assert.equal(journal.find((entry) => entry.id === "task-a-review-retry").transition.attempt.sequence, 2);
    assert.equal(journal.find((entry) => entry.id === "task-a-review-rewind").sequence, 3);
    assert.equal(journal.find((entry) => entry.id === "task-a-gate-recover").sequence, 2);
    assert.equal(journal.find((entry) => entry.id === "task-a-gate-recovered").result.summary, "task-a-gate-recovered");
    assert.equal(journal.find((entry) => entry.id === "branch-skipped-confirm").transition.status, "skipped");
    assert.equal(journal.find((entry) => entry.id === "branch-skipped-confirm").result.outcome, "skipped");
    assert.equal(journal.some((entry) => entry.id === "prepare-spec-forbidden-skip"), false);
    assert.equal(journal.find((entry) => entry.id === "task-b-review-fail-exhausted").failure.retryable, true);
    assert.equal(journal.find((entry) => entry.id === "task-b-review-record-exhaustion").type, "failure_recorded");
    assert.equal(journal.find((entry) => entry.id === "task-b-review-record-exhaustion").result.outcome, "failed");
    assert.equal(fs.existsSync(path.join(directory, "activities.md")), false);
  });

  it("reloads a terminal failed Attempt as an explicit blocked disposition without contradictory journal payloads", () => {
    tmp = createTmpDir("current-flow-terminal-failure-e2e-");
    const definition = buildCurrentFlowDefinition();
    const directory = path.join(tmp, "specs", "901-terminal-failure");
    const store = new CurrentFlowStateStore({ directory, definition });
    let initial = CurrentFlowState.create({ definition, execution: { mode: "worktree" } });
    initial = store.create(initial);
    const currentPath = initial.nextAction().path;
    const firstAttempt = attemptFor(initial, currentPath, "terminal-attempt-1");
    const started = store.apply({ activity: activity({
      id: "terminal-start",
      state: initial,
      currentPath,
      activityAttempt: firstAttempt,
      order: 2,
      operation: "start_attempt",
    }) });
    store.apply({ activity: activity({
      id: "terminal-failure",
      state: started,
      currentPath,
      order: 3,
      operation: "fail_attempt",
      activityResult: {
        outcome: "failed",
        summary: "The execution reached a non-retryable terminal failure.",
        confirmedAt: LATER,
        artifactRefs: [],
      },
      failure: {
        category: "policy",
        code: "terminal_failure",
        message: "The failure cannot be retried.",
        retryable: false,
        retryKind: null,
      },
    }) });

    const reloaded = new CurrentFlowStateStore({ directory, definition }).load();
    assert.equal(reloaded.nextAction().operation, "blocked");
    assert.equal(reloaded.nextAction().failureDisposition.outcome, "failed");
    assert.equal(reloaded.nextAction().failureDisposition.remaining, 0);
    const journal = store.journal.read();
    assert.equal(journal.length, 3);
    assert.equal(journal[2].attemptId, "terminal-attempt-1");
    assert.equal(journal[2].transition.attempt, null);
    assert.throws(
      () => store.apply({ activity: activity({
        id: "terminal-illegal-retry",
        state: reloaded,
        currentPath,
        activityAttempt: attemptFor(reloaded, currentPath, "terminal-attempt-2", 2),
        order: 4,
        operation: "retry_attempt",
      }) }),
      /requires a retryable failed active Attempt/,
    );
    assert.equal(store.journal.read().length, 3);
  });

  it("persists the production amend-spec policy as a definition-targeted rewind", () => {
    tmp = createTmpDir("current-flow-amend-spec-e2e-");
    const definition = buildCurrentFlowDefinition();
    const directory = path.join(tmp, "specs", "902-amend-spec");
    const store = new CurrentFlowStateStore({ directory, definition });
    let state = CurrentFlowState.create({ definition, execution: { mode: "worktree" } });
    state = store.create(state);
    let order = 2;
    const apply = (entry) => {
      state = new CurrentFlowStateStore({ directory, definition }).apply({ activity: entry });
      state = new CurrentFlowStateStore({ directory, definition }).load();
      order += 1;
    };
    let index = 0;
    while (state.nextAction().nodeId !== "acceptance-review") {
      const descriptor = state.nextAction();
      const currentPath = descriptor.path;
      apply(activity({
        id: `amend-prelude-${index}-start`,
        state,
        currentPath,
        activityAttempt: attemptFor(state, currentPath, `amend-prelude-${index}-attempt`),
        order,
        operation: "start_attempt",
      }));
      apply(activity({
        id: `amend-prelude-${index}-confirm`,
        state,
        currentPath,
        order,
        operation: "confirm_attempt",
        status: "done",
        activityResult: result(`amend-prelude-${index}`),
      }));
      index += 1;
      if (index > 100) throw new Error("acceptance-review traversal did not converge");
    }
    const acceptancePath = state.nextAction().path;
    apply(activity({
      id: "acceptance-amend-start",
      state,
      currentPath: acceptancePath,
      activityAttempt: attemptFor(state, acceptancePath, "acceptance-amend-attempt"),
      order,
      operation: "start_attempt",
    }));
    apply(activity({
      id: "acceptance-amend-failure",
      state,
      currentPath: acceptancePath,
      order,
      operation: "fail_attempt",
      activityResult: {
        outcome: "failed",
        summary: "Acceptance requires a specification amendment.",
        confirmedAt: LATER,
        artifactRefs: [],
      },
      failure: {
        category: "acceptance",
        code: "specification_incomplete",
        message: "Acceptance requires a specification amendment.",
        retryable: false,
        retryKind: null,
      },
    }));
    const amendment = state.nextAction();
    assert.equal(amendment.operation, "rewind");
    assert.equal(amendment.nodeId, "spec");
    assert.equal(amendment.failureDisposition.policy.value, "amend-spec");
    assert.equal(amendment.failureDisposition.policy.targetNodeId, "spec");
    apply(activity({
      id: "acceptance-amend-rewind",
      state,
      currentPath: amendment.path,
      activityAttempt: attemptFor(state, amendment.path, "spec-amendment-attempt"),
      order,
      operation: "rewind",
    }));
    assert.equal(state.current.at(-1), "spec");
    assert.equal(state.attempt.sequence, 2);
    assert.equal(state.findNode("acceptance-review").status, "invalidated");
    const journal = store.journal.read();
    assert.equal(journal.at(-1).transition.operation, "rewind");
    assert.equal(journal.at(-1).nodeId, "spec");
    assert.equal(journal.at(-1).sequence, 2);
  });

  it("replays both durable crash windows through filesystem reload without duplicate facts", () => {
    tmp = createTmpDir("current-flow-crash-e2e-");
    const definition = buildCurrentFlowDefinition();
    const directory = path.join(tmp, "specs", "903-crash-replay");
    const store = new CurrentFlowStateStore({ directory, definition });
    let initial = CurrentFlowState.create({ definition });
    initial = store.create(initial);
    const currentPath = initial.nextAction().path;
    const startedActivity = activity({
      id: "crash-start",
      state: initial,
      currentPath,
      activityAttempt: attemptFor(initial, currentPath, "crash-attempt"),
      order: 2,
      operation: "start_attempt",
    });
    const journalCrash = new CurrentFlowStateStore({
      directory,
      definition,
      faultInjector({ phase }) {
        if (phase === "activity-appended") throw new Error("journal durable");
      },
    });
    assert.throws(() => journalCrash.apply({ activity: startedActivity }), /journal durable/);
    assert.equal(new CurrentFlowStateStore({ directory, definition }).load().confirmationOrder, 1);
    const started = new CurrentFlowStateStore({ directory, definition }).apply({ activity: startedActivity });
    const confirmedActivity = activity({
      id: "crash-confirm",
      state: started,
      currentPath,
      order: 3,
      operation: "confirm_attempt",
      status: "done",
      activityResult: result("crash-confirmed"),
    });
    const stateCrash = new CurrentFlowStateStore({
      directory,
      definition,
      faultInjector({ phase }) {
        if (phase === "state-written") throw new Error("state durable");
      },
    });
    assert.throws(() => stateCrash.apply({ activity: confirmedActivity }), /state durable/);
    const reloaded = new CurrentFlowStateStore({ directory, definition });
    assert.equal(reloaded.load().confirmationOrder, 3);
    assert.equal(reloaded.apply({ activity: confirmedActivity }).confirmationOrder, 3);
    assert.deepEqual(reloaded.journal.read().map((entry) => entry.type), ["flow_created", "attempt_started", "result_confirmed"]);
  });
});
