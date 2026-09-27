import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachCanonicalCommandResultPublications } from "../../../src/flow/lib/canonical-command-result.js";
import { RunReopenDraftCommand } from "../../../src/flow/lib/run-reopen-draft.js";
import { DraftCreatedResult } from "../../../src/flow/engine/step-result.js";
import { DraftWorkerStepBinding } from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import { settleDraftStepResult } from "../../../src/flow/definition.js";
import { WorkerArtifactHandoffCoordinator, sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { readDraftTransitionFacts } from "../../../src/flow/lib/draft-transition-facts.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import {
  canonicalDraftDocument,
  FlowAtStepFixture,
  TaskLifecycleFixture,
  makeFlowManager,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import fs from "node:fs";

const SPEC_ID = "441-reopen-spec-correction";

function publishDraftWorker({ root, flowManager, draft, invocationId }) {
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const ctx = { root, executionRoot: root, mainRoot: root, specId: SPEC_ID, flowManager };
  const request = coordinator.createRequest({ ctx, state: flowManager.load(SPEC_ID),
    invocation: { id: invocationId, target: { digest: "b".repeat(64) },
      action: { digest: "c".repeat(64), nextAction: { step: "draft" } } } });
  fs.writeFileSync(request.payloadPath("draft.json"), JSON.stringify(draft));
  sealWorkerArtifactHandoff({ requestPath: request.requestPath,
    invocationId: request.dispatchInvocationId });
  const preparation = coordinator.prepareDraftWorker({ ctx, request });
  const result = new DraftCreatedResult();
  coordinator.commitDraftWorker({ ctx, request, preparation, stepResult: result,
    settlement: settleDraftStepResult(result.stepId, result),
    binding: new DraftWorkerStepBinding({ request }) });
}

describe("canonical reopen draft routes", () => {
  let root;
  afterEach(() => { if (root) removeTmpDir(root); root = null; });

  function commandContext(flowManager, state, input = {}) {
    return { root, flowManager, flowState: state, ...input };
  }

  function preimplementationFixture() {
    root = createTmpDir("reopen-draft-pre-");
    const flowManager = makeFlowManager(root);
    const fixture = new FlowAtStepFixture({
      flowManager, specId: SPEC_ID, runId: "run-reopen-pre", request: "reopen draft",
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
      specRecord: { goal: "fixture", requirements: [] }, targetStep: "spec-review",
    }).create();
    return { flowManager, fixture };
  }

  it("reopens a pre-implementation plan through the fixed draft replacement route", async () => {
    const { flowManager, fixture } = preimplementationFixture();
    const state = fixture.state();

    const result = await new RunReopenDraftCommand().execute(commandContext(flowManager, state));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.mode, "pre-implementation");
    assert.equal(result.data.destinationStep, "draft");
    const refreshed = flowManager.loadReadOnly(SPEC_ID);
    assert.equal(refreshed.currentNodeId, "draft");
    assert.equal(findStepById(refreshed.steps, "draft").status, "in_progress");
    assert.equal(findStepById(refreshed.steps, "spec-review").status, "invalidated");
    const reopening = flowManager.activityLedger(SPEC_ID).at(-1);
    assert.equal(reopening.transition.operation, "reopen_draft_preimplementation");
    const issueLog = JSON.parse(flowManager.readArtifact({ specId: SPEC_ID,
      logicalKey: "issue.log", consumerNodeId: "draft" }).bytes.toString("utf8"));
    const carried = issueLog.entries.at(-1).draftReopen;
    assert.equal(carried.draftAttemptId, reopening.transition.attempt.id);
    assert.equal(carried.source.stepId, "spec-review");
  });

  it("reopens draft-refine when the persisted draft cannot accept a question answer", async () => {
    root = createTmpDir("reopen-draft-refine-");
    const flowManager = makeFlowManager(root);
    const fixture = new FlowAtStepFixture({
      flowManager, specId: SPEC_ID, runId: "run-reopen-refine", request: "recover invalid draft questions",
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
      specRecord: { goal: "fixture", requirements: [] }, targetStep: "draft-refine",
    }).create();

    const result = await new RunReopenDraftCommand().execute(commandContext(flowManager, fixture.state(), {
      reason: "regenerate an invalid persisted draft question schema",
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.previousActiveStep, "draft-refine");
    assert.equal(result.data.destinationStep, "draft");
    const refreshed = flowManager.loadReadOnly(SPEC_ID);
    assert.equal(refreshed.currentNodeId, "draft");
    assert.equal(findStepById(refreshed.steps, "draft").status, "in_progress");
    assert.equal(findStepById(refreshed.steps, "draft-refine").status, "invalidated");
  });

  it("requires a completed Task before entering the task-addition route", async () => {
    root = createTmpDir("reopen-draft-task-");
    const flowManager = makeFlowManager(root);
    const fixture = new TaskLifecycleFixture({
      flowManager, specId: SPEC_ID, runId: "run-reopen-task", request: "add a Task",
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
      specRecord: { goal: "fixture", requirements: [{ id: "R-T-1", desc: "Complete the first Task.", task_ids: ["T-1"] }] },
      taskDocuments: [{ id: "T-1", title: "first", goal: "finish", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1", targetStep: "task-gate",
    }).create();
    fixture.flow.flow.settle("T-1-gate").activate("test-execute");
    const state = flowManager.loadReadOnly(SPEC_ID);

    const result = await new RunReopenDraftCommand().execute(commandContext(flowManager, state, { category: "task-addition", reason: "add another task" }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.mode, "implementation");
    assert.equal(result.data.doneTaskCount, 1);
    assert.equal(flowManager.loadReadOnly(SPEC_ID).currentNodeId, "draft");
    assert.equal(flowManager.activityLedger(SPEC_ID).at(-1).transition.operation, "reopen_draft_task_addition");
  });

  it("requires exact guards and catalog draft/spec authority for spec correction", async () => {
    root = createTmpDir("reopen-draft-correction-");
    const flowManager = makeFlowManager(root);
    const fixture = new FlowAtStepFixture({
      flowManager, specId: SPEC_ID, runId: "run-reopen-correction", request: "correct spec",
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` }, issue: 441,
      issueSnapshot: "# Issue 441\nbody\n", specRecord: { goal: "fixture", requirements: [] }, targetStep: "draft",
    }).create();
    flowManager.publishCurrentAttemptResult({
      specId: SPEC_ID,
      commandResult: attachCanonicalCommandResultPublications({ result: "ok" }, [{
        logicalKey: "draft", payload: canonicalDraftDocument({ goal: "fixture" }),
      }]),
    });
    fixture.flow.flow.activate("implement");
    const state = flowManager.loadReadOnly(SPEC_ID);

    const missingGuard = await new RunReopenDraftCommand().execute(commandContext(flowManager, state, {
      category: "spec-correction", reason: "contradictory requirement",
    }));
    assert.equal(missingGuard.ok, false);
    assert.equal(missingGuard.errors[0].code, "TARGET_GUARDS_REQUIRED");

    const result = await new RunReopenDraftCommand().execute(commandContext(flowManager, state, {
      category: "spec-correction", reason: "contradictory requirement",
      expectRunId: state.runId, expectSpec: state.specId, expectIssue: 441,
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.mode, "spec-correction");
    assert.ok(result.data.evidence.draftBytes > 0);
    assert.ok(result.data.evidence.specRecordBytes > 0);
    assert.equal(flowManager.loadReadOnly(SPEC_ID).currentNodeId, "draft");
    assert.equal(flowManager.activityLedger(SPEC_ID).at(-1).transition.operation, "reopen_draft_spec_correction");
    const saved = JSON.parse(flowManager.readArtifact({ specId: SPEC_ID,
      logicalKey: "issue.log", consumerNodeId: "draft" }).bytes.toString("utf8")).entries.at(-1);
    assert.deepEqual(saved.evidence, result.data.evidence);
    assert.equal(saved.trigger, "user invoked sennel flow reopen-draft");
    assert.equal(saved.draftReopen.source.stepId, "implement");
  });

  it("publishes a corrected prior answer after a guarded spec correction reopen", async () => {
    root = createTmpDir("reopen-draft-correct-answer-");
    const flowManager = makeFlowManager(root);
    const fixture = new FlowAtStepFixture({
      flowManager, specId: SPEC_ID, runId: "run-reopen-correct-answer",
      request: "correct a prior answer contradicted by source evidence",
      execution: { mode: "branch", baseBranch: "main", featureBranch: `feature/${SPEC_ID}` },
      issue: 441, issueSnapshot: "# Issue 441\nCorrect the public behavior.\n",
      specRecord: { goal: "fixture", requirements: [] }, targetStep: "draft",
    }).create();
    const originalQuestion = {
      state: "AnsweredQuestion", id: "q1", question: "Which behavior is required?",
      category: "user-visible-behavior", revision: 1,
      provenance: { producer: "prior-draft" }, evidenceDigest: "a".repeat(64),
      answer: "Use the old public behavior.", why: "The original request indicated it.",
      considered: "The changed behavior was not yet supported.",
    };
    flowManager.publishCurrentAttemptResult({ specId: SPEC_ID,
      commandResult: attachCanonicalCommandResultPublications({ result: "ok" }, [{
        logicalKey: "draft", payload: canonicalDraftDocument({
          goal: "Choose the public behavior.", questions: [originalQuestion],
        }),
      }]),
    });
    fixture.flow.flow.activate("implement");
    const state = flowManager.loadReadOnly(SPEC_ID);
    const reopened = await new RunReopenDraftCommand().execute(commandContext(flowManager, state, {
      category: "spec-correction", reason: "source evidence contradicts the old answer",
      expectRunId: state.runId, expectSpec: state.specId, expectIssue: 441,
    }));
    assert.equal(reopened.ok, true, JSON.stringify(reopened));

    const correctedQuestion = { ...originalQuestion, revision: 2,
      answer: "Use the corrected public behavior.",
      why: "Source evidence now establishes the revised contract.",
      considered: "The old behavior conflicts with that evidence." };
    const correctedDraft = canonicalDraftDocument({
      goal: "Use the corrected public behavior.", questions: [correctedQuestion],
    });
    publishDraftWorker({ root, flowManager, draft: correctedDraft,
      invocationId: "correct-answer-worker" });

    const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: SPEC_ID });
    const saved = JSON.parse(reloaded.readArtifact({ specId: SPEC_ID,
      logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes.toString("utf8"));
    assert.deepEqual(saved.questionLedger.questions, [correctedQuestion]);
    const transition = readDraftTransitionFacts({ flowManager: reloaded,
      flowState: reloaded.loadReadOnly(SPEC_ID) });
    assert.equal(transition.ledger.questions[0].answer, correctedQuestion.answer);
  });
});
