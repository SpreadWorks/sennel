import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { ReviewFindingCycle } from "../../../src/flow/lib/finding-disposition-policy.js";
import RunReopenDraftCommand from "../../../src/flow/lib/run-reopen-draft.js";
import { findStepById, flattenSteps } from "../../../src/flow/lib/step-tree.js";
import {
  canonicalDraftDocument,
  FlowAtStepFixture,
  TaskLifecycleFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

const SPEC_ID = "498-draft-authority";
const EXECUTION = { mode: "branch", baseBranch: "main", featureBranch: "feature/498-draft-authority" };

describe("draft reopen canonical authority", () => {
  let root;

  afterEach(() => {
    if (root) removeTmpDir(root);
    root = null;
  });

  function createAt(targetStep, { issue = null, taskDocuments = [] } = {}) {
    root = createTmpDir("draft-reopen-authority-");
    const flowManager = makeFlowManager(root);
    const effectiveTasks = targetStep === "test-generate" && taskDocuments.length === 0
      ? [{
        id: "T1",
        title: "Exercise Requirement test generation",
        goal: "Reach the Requirement test frontier.",
        parent: null,
        origin: "plan",
        added_round: 0,
        status: "pending",
      }]
      : taskDocuments;
    const fixture = new FlowAtStepFixture({
      flowManager,
      specId: SPEC_ID,
      runId: `run-${targetStep}`,
      request: "exercise draft authority",
      execution: EXECUTION,
      issue,
      issueSnapshot: issue === null ? null : `# Issue #${issue}\nCanonical body\n`,
      specRecord: {
        goal: "canonical authority",
        requirements: effectiveTasks.map((task) => ({
          id: `R-${task.id}`,
          desc: `Complete canonical Task ${task.id}.`,
          task_ids: [task.id],
          testable: true,
          preimplementation_test_expectation: "fail",
        })),
      },
      taskDocuments: effectiveTasks,
      targetStep,
    }).create();
    return { flowManager, fixture };
  }

  function run(command, flowManager, input = {}) {
    const flowState = flowManager.loadReadOnly(SPEC_ID);
    return command.execute({ root, flowManager, flowState, ...input });
  }

  it("reopens every pre-implementation authority leaf through the definition-owned recovery Activity", async () => {
    for (const targetStep of ["draft-questions-review", "draft-coverage-review", "draft-gate", "spec-review", "test-generate"]) {
      if (root) removeTmpDir(root);
      const { flowManager } = createAt(targetStep);
      const result = await run(new RunReopenDraftCommand(), flowManager);

      assert.equal(result.ok, true, `${targetStep}: ${JSON.stringify(result)}`);
      assert.equal(result.data.previousActiveStep, targetStep);
      const state = flowManager.loadReadOnly(SPEC_ID);
      assert.equal(state.currentNodeId, "draft");
      assert.equal(findStepById(state.steps, targetStep).status, "invalidated");
      assert.equal(flowManager.activityLedger(SPEC_ID).at(-2).transition.operation, "reopen_draft_preimplementation");
    }
  });

  it("starts a new review-finding cycle from the typed draft-reopen Activity", async () => {
    const { flowManager } = createAt("spec-review");
    const before = flowManager.loadReadOnly(SPEC_ID);
    const priorCycle = ReviewFindingCycle.fromActivityLedger({
      runId: before.runId,
      activities: flowManager.activityLedger(SPEC_ID),
    });
    assert.equal(priorCycle.planRewindAt, null);

    const result = await run(new RunReopenDraftCommand(), flowManager);
    assert.equal(result.ok, true, JSON.stringify(result));
    const state = flowManager.loadReadOnly(SPEC_ID);
    const ledger = flowManager.activityLedger(SPEC_ID);
    const reopen = ledger.findLast((activity) => (
      activity.transition.operation === "reopen_draft_preimplementation"
    ));
    assert.ok(reopen);
    const cycle = ReviewFindingCycle.fromActivityLedger({ runId: state.runId, activities: ledger });
    assert.equal(cycle.planRewindAt, reopen.timing.finishedAt);

    const fingerprint = "d".repeat(64);
    const history = [
      { runId: state.runId, planRewindAt: priorCycle.planRewindAt, fingerprint },
      { runId: state.runId, planRewindAt: cycle.planRewindAt, fingerprint },
    ];
    const currentCycleFindings = history.filter((artifact) => cycle.matchesArtifact(artifact));
    assert.deepEqual(currentCycleFindings.map((artifact) => artifact.fingerprint), [fingerprint]);
    assert.equal(cycle.matchesArtifact({ ...history[1], runId: "run-other" }), false);
  });

  it("keeps draft/spec evidence catalog-owned and refuses an unauthorized consumer", () => {
    const { flowManager } = createAt("draft", { issue: 498 });
    flowManager.publishCurrentAttemptResult({
      specId: SPEC_ID,
      commandResult: attachCanonicalCommandResultPublications({ result: "ok" }, [{
        logicalKey: "draft",
        payload: canonicalDraftDocument({ goal: "catalog draft" }),
      }]),
    });

    const draft = flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "draft",
      consumerNodeId: "draft-questions-review",
    });
    assert.ok(draft.bytes.length > 0);
    assert.throws(() => flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "draft",
      consumerNodeId: "finalize-merge",
    }), /consumer is not authorized/);
  });

  it("requires exact guards before catalog evidence can authorize spec correction", async () => {
    const { flowManager, fixture } = createAt("draft", { issue: 498 });
    flowManager.publishCurrentAttemptResult({
      specId: SPEC_ID,
      commandResult: attachCanonicalCommandResultPublications({ result: "ok" }, [{
        logicalKey: "draft",
        payload: canonicalDraftDocument({ goal: "catalog draft" }),
      }]),
    });
    fixture.flow.flow.activate("implement");

    const rejected = await run(new RunReopenDraftCommand(), flowManager, {
      category: "spec-correction", reason: "correct an authoritative requirement",
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errors[0].code, "TARGET_GUARDS_REQUIRED");
    assert.equal(flowManager.loadReadOnly(SPEC_ID).currentNodeId, "implement");

    const result = await run(new RunReopenDraftCommand(), flowManager, {
      category: "spec-correction",
      reason: "correct an authoritative requirement",
      expectRunId: "run-draft",
      expectSpec: SPEC_ID,
      expectIssue: 498,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.evidence.draftBytes > 0, true);
    assert.equal(result.data.evidence.specRecordBytes > 0, true);
    assert.equal(flowManager.loadReadOnly(SPEC_ID).currentNodeId, "draft");
  });

  it("rejects spec correction outside its supported implementation authority", async () => {
    const { flowManager } = createAt("spec-review", { issue: 498 });
    const result = await run(new RunReopenDraftCommand(), flowManager, {
      category: "spec-correction",
      reason: "too early",
      expectRunId: "run-spec-review",
      expectSpec: SPEC_ID,
      expectIssue: 498,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "REOPEN_DRAFT_REJECTED");
    assert.match(result.errors[0].messages[0], /supported implementation stage/);
    assert.equal(flowManager.loadReadOnly(SPEC_ID).currentNodeId, "spec-review");
  });

  it("requires a completed Task for the explicit mid-implementation route", async () => {
    root = createTmpDir("draft-reopen-no-completed-task-");
    const flowManager = makeFlowManager(root);
    const fixture = new TaskLifecycleFixture({
      flowManager,
      specId: SPEC_ID,
      runId: "run-task-pending",
      request: "add a task",
      execution: EXECUTION,
      specRecord: { goal: "canonical authority", requirements: [{ id: "R-T-1", desc: "Complete the first Task.", task_ids: ["T-1"] }] },
      taskDocuments: [{ id: "T-1", title: "first", goal: "finish", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    const result = await run(new RunReopenDraftCommand(), flowManager, { category: "task-addition" });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "NO_DONE_TASK");
    assert.equal(flowManager.loadReadOnly(SPEC_ID).currentNodeId, fixture.state().currentNodeId);
  });

  it("invalidates every downstream leaf without recreating a mutable root Flow blob", async () => {
    const { flowManager } = createAt("test-generate");
    const result = await run(new RunReopenDraftCommand(), flowManager);
    assert.equal(result.ok, true, JSON.stringify(result));
    const state = flowManager.loadReadOnly(SPEC_ID);
    const invalidated = flattenSteps(state.steps).filter((step) => step.status === "invalidated").map((step) => step.id);
    assert.deepEqual(result.data.resetSteps, ["draft", ...invalidated]);
    assert.ok(invalidated.includes("test-generate"));
    assert.ok(invalidated.includes("final-regression"));
  });
});
